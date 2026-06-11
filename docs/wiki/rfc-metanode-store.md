# RFC 7: the metanode store — precomputed metatiles without serve-time
warp

**Status:** In review
**Opened:** 2026-06-07
**Context:** subsumes two backlog items —
**PERF: pre-built metatile index eliminating serve-time DEM warps** and
**PERF/REDESIGN: coverage-mask `mapproxy-tiling`** in
[backlog.md](backlog.md). Background in
[tileserver-metatile-production.md](tileserver-metatile-production.md),
[tile-index.md](tile-index.md), [surface-metatile.md](surface-metatile.md),
[reference-frames.md](reference-frames.md).

---

## 0. Orientation — which win matters

This RFC touches two phases of the tileserver: the offline *generation*
of a resource and the online *serving* of metatiles. It improves both.
They are not of equal value, and the design is steered by which one is
the prize.

**Serving is the prize.** Metatile delivery is on the runtime critical
path. It is the perceived performance of the library: every client, on
every session, descends the metatile tree before any geometry can load,
and pays the serve cost on every cold cache miss, forever. A faster
serve path is a permanent, compounding, user-visible win.

**Generation is a one-off, offline convenience.** The tiling and VRTWO
steps are slow — days, on a planet — and this RFC happens to make them
dramatically faster too. That is welcome, but it is a setup cost paid
once per dataset, off the user's clock. It is a nice-to-have.

So where the two pull against each other, serve-time latency wins. The
store format, the access model, and the field-derivation choices are all
made to keep the serve path as close to "read bytes, emit bytes" as
possible — even at the cost of more work, more storage, or more
heuristic latitude in generation. Read the rest of the document with
that priority in mind.

---

## 1. Problem

### 1.1 The serve-time DEM warp

When a client requests a surface-DEM metatile, the server does **not**
read precomputed values. It re-derives them by warping the source DEM,
live, inside the request. The path is `metatileFromDemImpl()` in
[mapproxy/src/mapproxy/generator/metatile.cpp](../../cartolina-tileserver/mapproxy/src/mapproxy/generator/metatile.cpp)
(lines 180–477):

1. Decompose the metatile into blocks (`metatileBlocks`).
2. For each block, **warp the VRTWO** into a sample grid covering the
   block extent (`arsenal.warper.warp(... Operation::valueMinMax ...)`,
   line 298). This samples the normal pyramid for elevation and the
   min/max pyramids for the height range.
3. Per node, reduce the grid to: height range, geom extents, surrogate
   (average of valid samples, line 466), texel size (from accumulated
   surface area, line 460), child flags.
4. Serialise to the v6 metatile binary and return it.

The GDAL warp in step 2 is the dominant cost: **100–500 ms per request**
on a warm server with the VRTWO resident in page cache, and
substantially worse on a cold cache (the case a CDN miss hits). Every
field it computes already exists, or is analytically derivable, by the
time the request arrives — the warp is redundant work on the runtime
critical path.

### 1.2 Why this is structurally wrong

By request time the resource setup has already produced the VRTWO (the
expensive overview pyramids) and the tile index. Between them they hold
everything a metanode needs:

| Metatile field | Already available from |
|---|---|
| Existence, child flags, watertight | Tile index (QTree) |
| Height range min/max | VRTWO min/max pyramids |
| Texel size | Analytic: LOD + reference-frame resolution (modulo relief) |
| SDS horizontal extents | Analytic: tile ID + division node |

The serve path re-computes a sub-problem of a computation already
finished offline. The result is that a fast, cacheable, content-addressed
HTTP response is produced by the single most expensive operation the
server performs.

### 1.3 The tile index cannot simply carry the heights

The obvious fix — "put the height range in the tile index" — does not
work as stated, and understanding why drives the whole design. There are
two tile-index flavors, and the proposal collides with both.

- **`vts::TileIndex`**
  ([externals/vts-libs/vts-libs/vts/tileindex.hpp](../../cartolina-tileserver/externals/vts-libs/vts-libs/vts/tileindex.hpp))
  — the authoritative one: a `std::vector<QTree>`, one quadtree per LOD,
  each `QTree` a fully-decompressed pointer tree of `Node`s
  (`value` + `unique_ptr<Children>`). Held resident; rebuilt from scratch
  on every resource load by `prepareTileIndex`. **vtsd** lives on this.
- **`mmapped::TileIndex`**
  ([mapproxy/src/mapproxy/support/mmapped/tileindex.hpp](../../cartolina-tileserver/mapproxy/src/mapproxy/support/mmapped/tileindex.hpp))
  — the serve-time flavor in mapproxy. Its header says it plainly:
  *"Simplified tileindex that employs memory mapped quadtrees. Used to
  save precious memory. Handles only 3 flags."* It is written once from
  the vts flavor and queried by offset-chasing through mapped pages.

Both are quadtrees, and the quadtree is a **region-merge** structure: it
is compact only because neighboring cells share a value. Flags share
massively (oceans of "empty", continents of "watertight"), which is why
a planet flag-index is only megabytes. **Float height ranges share
essentially never.** Widening the per-node value to carry them:

- degenerates the tree to full depth wherever data exists (~one leaf per
  tile, no collapse) — turning a megabyte index into a multi-gigabyte
  one, and the in-RAM `vts` flavor into a maximally-fragmented pointer
  tree;
- regresses the existing flag lookups, which now drag a float payload
  through cache even when they only want the `mesh` bit — and taxes
  vtsd, which never wants heights;
- is impossible in the current format anyway: only the low byte of each
  node is serialised and `0xff` is reserved as the quadtree's gray-node
  marker ([tile-index.md](tile-index.md) §"Serialisation constraint").

The conclusion is not "no quadtree". It is "the bulk payload does not
belong **fused into the flag index**." §3 keeps a quadtree for what
quadtrees are good at — skipping the empty 71% of the planet and
aggregating ranges up the pyramid — while keeping it a *separate*
structure from the flag index.

### 1.4 The min/max pyramids are dead weight downstream

`generatevrtwo` builds **three** overview pyramids for a DEM: normal,
min-filtered, and max-filtered
([tileserver-metatile-production.md](tileserver-metatile-production.md)).
The min/max pyramids exist for exactly one purpose: supplying the height
range to the serve-time warp. They triple the cost of the multi-hour
VRTWO step. Once height ranges are precomputed, this entire data
dependency disappears (§4.4).

### 1.5 The ping-pong, named but not solved here

The client descends the metatile tree one LOD at a time: fetch root,
read child flags, fetch children, recurse — up to ~15 sequential
round-trips before geometry loading starts. Serve latency *weaponises*
this waterfall, but it has structural problems even when every metatile
on the path is cached. This RFC does not solve the ping-pong. It is
explicitly designed **not to preclude** the eventual fix — serving
shallow subtrees instead of single-LOD blocks — which constrains the
on-disk layout (§3.3, §6). Treat that as a load-bearing requirement, not
a future aspiration.

### 1.6 Terminology — metatile packaging

This RFC uses **metatile packaging parameters** for the values that
decide how metanodes are grouped into served metatile resources. They do
not change the tile coordinate system, DEM samples, or tile existence;
they change the delivery unit and the store page shape.

- **`metaBinaryOrder`** is the horizontal packaging parameter. A metatile
  root level contains an `h × h` block where
  `h = 1 << metaBinaryOrder`. Today the server takes this value from the
  reference frame.
- **`metaDepth`** is the vertical packaging parameter introduced by this
  RFC. It is the number of LOD levels in a metatile subtree. The current
  client-compatible value is `1`, meaning a metatile contains one LOD
  level only.

The effective values for a DEM surface are defined in §6. In this RFC
implementation, the server/tooling/store path learns both parameters.
Current cartolina-js does not consume either configured value: terrain
metatile addressing uses a hardcoded aggregation order 5, and bound-layer
texture metatiles use hardcoded order 8. Datasets served to current
cartolina-js clients must therefore use effective `metaBinaryOrder = 5`
and `metaDepth = 1`.

---

## 2. Goals and non-goals

**Goals**

- Eliminate the GDAL warp from the surface-DEM metatile request path.
  Cold and warm misses answered in milliseconds, from a precomputed
  store.
- Preserve CDN compatibility exactly: metatile URLs stay keyed on tile
  ID and stable; only origin latency changes.
- Produce a store whose on-disk layout does not commit the project to
  single-LOD-block delivery, so the future shallow-subtree packaging is
  a rebrick plus client/server serializer change, not a redesign.
- Fold the height-range extraction into a redesigned `mapproxy-tiling`
  that computes existence, watertight, and range in one native-resolution
  pass plus a bottom-up reduction — retiring the per-tile per-LOD warp
  and the min/max VRTWO pyramids.

**Non-goals**

- The client-side ping-pong (§1.5). Separate, complementary, deferred.
- A metatile format break. The store emits **v6**, byte-compatible,
  during this milestone. Trimming dead v6 fields is deferred to the
  later client-facing shallow-subtree milestone, where it rides a change
  that is structural anyway (§5.3).
- Client support for surface-level metatile packaging overrides. This
  RFC defines the tileserver-side resource settings and requires
  tooling/store support for non-default values, but current cartolina-js
  clients still consume hardcoded terrain `metaBinaryOrder = 5` and
  `metaDepth = 1` metatiles only.
- vtsd. It serves stored tilesets verbatim and never warps; the store is
  a mapproxy-side artifact. vtsd is untouched.
- Non-DEM surfaces (spheroid, geodata). The warp this removes is
  DEM-specific.

---

## 3. The metanode store

### 3.1 What it stores

A new artifact, the **metanode store**, sits alongside the resource. It
is a quadtree — *parallel to* and *separate from* the flag tile index —
holding, per existing node:

| Field | Bytes | Source |
|---|---|---|
| mesh existence | (in node encoding) | tiling pass mask band |
| watertight | (in node encoding) | tiling pass mask band |
| `minZ` | 2 (`half`) | tiling pass — elevation min |
| `maxZ` | 2 (`half`) | tiling pass — elevation max |

**4 bytes of payload per node.** Everything else a metanode carries is
derived at delivery (§3.2). The store carries only data-derived DEM
surface flags: mesh existence and watertight. Child existence comes
from the tree structure during traversal. `navtilePresent` is derived
at delivery from the resource's navtile LOD range, so a config edit
does not make the store stale. Alien and glue/source-reference state
are not applicable to a mapproxy DEM surface. Duplicating mesh and
watertight leaves the existing flag index, and vtsd, untouched.

The name is deliberately generic: height range is the *first* channel,
not the last. The obvious second channel — sampled horizontal coverage
extents, which today's warp accumulates and cartolina-js currently
ignores — can be added without restructuring. Call it the metanode
store, not the height index.

**Size.** A global LOD-15 surface in melown2015 has ~2²⁸ tiles
(ignoring polar caps; the productive division node sits under 1-0-0).
At 4 bytes that is 2²⁸ × 4 = **1 GiB at LOD 15 alone**, ×4/3 for the
full pyramid if dense. Land is ~29% of the planet and the ocean tiles do
not exist in the tree, so the realised store is **~0.4 GiB** of payload
plus quadtree node overhead — comfortably mmappable. The 71% ocean is
the entire reason a quadtree is the right container here (§3.4): it
collapses to nothing, exactly where we want it to.

### 3.2 Fields derived at delivery, not stored

Verified against `metatileFromDemImpl` and the cartolina-js consumer.
Each non-stored field is either analytic, a config constant, or a
heuristic over `{minZ, maxZ}`:

| Metanode field | How it is produced at serve time |
|---|---|
| content flags | mesh/watertight from the store; navtile from config |
| child flags | from tree structure |
| `minZ` / `maxZ` (SDS) | read from the store |
| `minHeight`/`maxHeight` (navtile, navSRS) | SDS→nav vertical transform of the stored range |
| `surrogate` | **midpoint** `(minZ+maxZ)/2` (see below) |
| `texelSize` | relief heuristic over the stored range (§5) |
| SDS horizontal extents (`llX..urX`) | **full-cell** analytic from tile ID + division node (§5.3) |

The SDS→nav height conversion is cheap, not always analytic. When SDS
and navSRS share the same orthometric vertical datum it is an identity
on height. If they differ, delivery evaluates the existing SRS
conversion for the node range, including any geoid-grid lookup needed
by that transform. The vertical-datum checklist in §9 verifies which
case applies for the target reference frames.

**Surrogate = midpoint.** The current warp computes the surrogate as the
*average* of valid samples (metatile.cpp:466) — not a min/max, so a
min/max store cannot reproduce it exactly. It does not need to.
cartolina-js computes `diskPos` from `minZ`, not the surrogate
(`metanode.js:369`, `var h = this.minZ`). vts-browser-cpp uses the
surrogate only as a coarse "ground height here" proxy for camera
altitude and navigation (`camera/altitude.cpp:296`,
`altitudes[i] = *surrogateNav`) and a debug render — never geometry,
never culling tightness — where the midpoint is entirely adequate. We do
not maintain vts-browser-cpp regardless. **Decision: surrogate =
midpoint, derived at delivery.**

**texelSize is load-bearing and derived, not stored.** surface-dem
passes `displaySize = boost::none`
([surface-dem.cpp:316](../../cartolina-tileserver/mapproxy/src/mapproxy/generator/metatile.cpp)),
so DEM metanodes always take the `applyTexelSize` path; the client reads
`node.pixelSize` for LOD selection. The stored value today encodes
terrain *surface area* (rugged tiles get a smaller texel and descend
deeper). Reproducing that faithfully would require the full-resolution
warp this RFC exists to remove — so we **derive** it from the height
range with a calibrated heuristic instead (§5). This is the one soft
spot in the design and §5 treats it as such.

### 3.3 On-disk layout — pages, not a monolith

The store is mmapped and **paged**, with a directory mapping a page key
to a file offset and length. A page is one metatile delivery unit in the
resource's effective packaging (§6), encoded as a local quadtree. The
page key is the metatile root block `(rootLod, rootX, rootY)`, using the
same phase and horizontal masking rule as the delivery unit.

For today's client-compatible shape, `metaBinaryOrder = 5` and
`metaDepth = 1`, a page is a single-LOD 32×32 block. That block is not a
vertical subtree; it is a two-dimensional local quadtree over 1024
same-LOD cells. Uniform empty, ocean, or flat-water quadrants collapse
inside the page, so the compression claims in §3.4/§3.5 still apply
within a page, not only between pages.

For `metaDepth > 1`, a page is the `h × h` forest of subtrees at that
depth, serialized depth-first within each subtree and contiguous as a
whole. Page shape equals delivery shape. The current per-LOD shape is
acceptable because it matches the only client-compatible delivery unit,
and because phases 2–3 prove that the same raw node payload can be
rebricked to a future subtree shape without rerunning the DEM tiling
pass. The page shape is therefore not a permanent commitment.

**Store raw payload, not pre-serialised metatiles.** Serialising
`{flags, minZ, maxZ}` into a v6 metatile at request time costs
microseconds; pre-serialising would repackage the world on every format
or packaging change. Raw payload future-proofs against exactly the
v6→v7 / flat-block→subtree change §6 anticipates. The metatile *format*
and *packaging* become serializer concerns over an unchanged store.

### 3.4 Access model — why GB-scale mmap survives, and the ocean

The serve-time access model is already lazy and paged: `mmapped::TileIndex`
descends by offset-chasing through mapped pages, touching only the
root-to-leaf path a lookup needs; the OS page cache holds the working
set. **A larger file is not, by itself, a problem.** The store inherits
this. What would break the model is *defeating the quadtree's
compression* — which is precisely why heights go in their own tree and
not the flag value (§1.3):

- **Sparsity (the ocean).** 71% of the theoretical planet has no surface
  tiles; those nodes are absent from the tree, collapsed for free. The
  store pays for land only. This is the property the irregular,
  fractal land/ocean boundary makes a quadtree *good* at — region-merge
  on the empty side, regardless of how the values behave on the full
  side.
- **Vertical structure.** A parent node's range is exactly the min/max
  of its children's ranges. Height-range-over-the-pyramid *is* a min/max
  mip pyramid; storing it as a tree is the natural shape, and coarse
  metatiles read their range straight from the aggregated internal
  nodes.
- **Locality for the access pattern.** Metatiles are emitted by
  whole-block traversal (`forEachNode` over a subtree), not random
  single-tile `get()`. Depth-first page serialisation makes that
  traversal a sequential scan of a contiguous span. The "scattered
  full-depth chase" that would hurt random lookups does not arise on the
  serve path.

The non-sharing of height *values* (the reason fusing into the flag
index fails) is harmless here: in the populated 29% the tree is
full-depth because the *data* is there, and that is the data we must
store; in the empty 71% the tree collapses. The structure earns its keep
on exactly the axis the ocean problem raises — and, with the right
vertical datum (§3.5), flat water and flat terrain collapse *too*, a
bonus beyond the ocean sparsity.

### 3.5 Vertical datum — orthometric, load-bearing for compression

The stored `minZ/maxZ` **must** be in an orthometric (gravity-based)
vertical datum, not a geodetic (ellipsoidal) one. This is not a
precision nicety; it is what makes flat surfaces compress.

**Which orthometric datum: the reference frame's, not Earth's.** The
canonical vertical datum is the **vertical component of the reference
frame's public SRS** (`referenceFrame.model.publicSrs`,
[referenceframe.hpp:191](../../cartolina-tileserver/externals/vts-libs/vts-libs/registry/referenceframe.hpp)),
which is orthometric for every reference frame in use. It must **not** be
a hardcoded geoid such as EGM96 (EPSG:5773) or EGM2008: cartolina models
bodies other than Earth, and an Earth geoid is meaningless on the Moon or
Mars. Each body's reference frame carries its own gravity-based vertical
(geoid / selenoid / areoid) in its public SRS, so deriving the datum from
the reference frame is both generic and automatically body-correct. The
Earth examples below (EGM2008, ocean = 0) are instances of this rule, not
the rule itself.

A geodetic height references the ellipsoid, so the sea surface — which is
near-constant in orthometric height (≈ 0, mean sea level) — has a
*non-zero, smoothly varying* ellipsoidal height equal to the geoid
undulation (roughly −106 m … +85 m globally). Stored ellipsoidally,
every ocean, lake, and flat-plain tile would carry a slightly different
`(minZ, maxZ)` than its neighbour, so **no two siblings share a value and
the quadtree cannot collapse them** — the same value-sharing failure that
sinks fusing heights into the flag index (§1.3), now self-inflicted.
Stored orthometrically, a region of still water is `(0, 0)` everywhere:
uniform quadrants merge horizontally and aggregate to `(0, 0)` up the
pyramid. Where DEMs encode ocean as valid 0 (Copernicus GLO-30 does,
referenced to EGM2008), those tiles *exist* in the store (mesh +
watertight) and collapse to almost nothing — only with the orthometric
datum.

**This is already the pipeline's convention.** `sds2srs`
([mesh.cpp:311](../../cartolina-tileserver/mapproxy/src/mapproxy/support/mesh.cpp))
attaches the configured geoid to the **SDS** SRS (`geo::setGeoid`) and
resolves the undulation only when converting SDS→physical. So SDS
heights — the frame `minZ/maxZ` live in — are orthometric for any
geoid-configured DEM resource (the norm); the ellipsoidal undulation is
bridged at the SDS↔physical boundary, not stored. The navtile range
(`minHeight/maxHeight`, navSRS) is orthometric on the same basis.

**Consequences for the store:**

- **Store the SDS values verbatim** — exactly what the metatile
  serialises. Delivery needs *no* vertical conversion, which is the
  fastest path and the one §0 prioritises. The "cheaply convertible at
  delivery" fallback is held in reserve only if we ever pick a canonical
  internal datum different from the resource's SDS.
- **The tiling pass (§4) must reduce elevation in that same SDS frame** —
  apply the resource's `heightFunction` and treat the source datum
  consistently — so the stored range matches what the warp would have
  produced. If a source DEM is ellipsoidal, convert to the orthometric
  SDS datum at build, both for correctness and to regain the collapse.
- **The datum is pinned by the reference-frame id already in the header**
  (§7): since it is the public SRS vertical, the reference-frame
  identity *is* the datum identity. Validate the store's reference-frame
  id against the resource on load rather than trusting a free-standing
  datum tag, so a frame (and therefore datum) mismatch is detectable
  rather than silent.

The exact public-SRS vertical is reference-frame-defined in the registry;
§9 carries verifying it — that it is orthometric for melown2015 and
earth-qsc, and that the "derive from the reference frame" rule holds for
any non-Earth frame — as a checklist item.

---

## 4. Generation — the unified tiling pass

This section subsumes **PERF/REDESIGN: coverage-mask `mapproxy-tiling`**.
Existence/watertight and height range share one input, one method, and
one output, so they are one tool.

### 4.1 Today's cost

`mapproxy-tiling` warps a 129×129 sample grid **per tile, per LOD**,
descending the whole tree
([tile-index.md](tile-index.md) §"Production"). On a planet this runs for
days. The serve path then warps *again* at request time. The same DEM is
read at every pyramid level, twice over.

### 4.2 The native-resolution pass

Per reference-frame division node, visit the source at the resolution
floor (the native-resolution LOD calipers already computes) and reduce
per output cell. This is a **windowed** pass, not a materialized global
grid: each worker warps a bounded output-cell block, reduces its mask
and elevation samples, writes the leaf results, and releases the block.
Peak memory is bounded by `workers × windowCells × bands`, plus the
streaming reduction buffers for the coarser levels being flushed. "Once"
means one visit per source/output sample at the native floor, not one
GDAL warp call and not one planet-sized array. Two bands are reduced to
four statistics:

1. **Mask band** (`GetMaskBand`, GDAL RFC 15) → existence and watertight.
   `max(cell) > 0` ⇒ exists; `min(cell) == 255` ⇒ watertight.
2. **Elevation band** → `minZ = min(cell)`, `maxZ = max(cell)`.

Then build coarser LODs bottom-up with no further sampling:

- existence: `parent = OR(children)`
- watertight: `parent = AND(children)`
- `minZ`: `parent = min(children)`
- `maxZ`: `parent = max(children)`

Leaves are sampled once; every coarser node is pure reduction. Coarser
levels are reduced bottom-up as windows complete, with partial parent
accumulators kept only for open regions. This is the `O(levels × area)`
→ `O(area)` collapse the coverage-mask item describes, now carrying the
height payload in the same reduction.

### 4.3 The nodata rule — opposite per band

A correctness rule the implementation must state loudly, because the two
bands need **opposite** nodata handling and getting the elevation band
wrong reproduces a known bug:

- **Mask band: warp with no nodata.** 0 and 255 are both valid mask
  *values*; you must count the 0s (holes) or watertight is always true.
  (The coverage-mask item's "warp the mask band with no nodata" rule.)
- **Elevation band: warp with `srcnodata` set.** Nodata pixels must be
  excluded from min/max or the int16 nodata sentinel poisons the range —
  exactly the existing backlog bug *"coarse navtile height ranges are
  poisoned by the int16 nodata sentinel"*.

Same pass, per-band nodata config inverted.

### 4.4 What generation loses

- The per-tile per-LOD warp (replaced by one native pass + reduction).
- The **min/max VRTWO pyramids**, at *both* build and serve time: the
  range is reduced from native resolution, so the pre-built min/max
  overviews are never read. `generatevrtwo` drops from three pyramids to
  one (normal only, still needed for mesh/navtile). A ~3× → ~1× cut on
  the multi-hour VRTWO step.
- `mapproxy-setup-resource` currently bakes the three-pyramid model into
  the easy setup path. In the tileserver source file
  `mapproxy/src/setup-resource/main.cpp`, `createVrtWO(cm, ...)` calls
  `createVrtWO` three times for DEM resources: `dem` with cubicspline
  resampling, `dem.min` with minimum resampling, and `dem.max` with
  maximum resampling, then `run()` calls `tiling::generate` on the
  resulting DEM dataset. The RFC changes this tool too:
  metanode-store mode must build the normal DEM VRTWO only and then run
  the new paired flag-index/store tiling path.

Per §0 this is the lesser win, but it is large and free, falling out of
the same redesign.

**Verification owed (§9):** confirm nothing else consumes the min/max
pyramids (navtile generation uses the normal pyramid; expected clean).

### 4.5 Assumptions to test (carried from the coverage-mask item)

These guard both bands now and must be verified empirically before the
serve path depends on the output (§7 parity gate):

- GDAL min/max resampling aggregates over the full destination footprint
  at extreme downsample ratios, not a subsample.
- Edge-straddle semantics at tile boundaries (affects watertight exactly
  at edges) — diff against a hand-reduced reference.
- Alpha-mask sources (`GMF_ALPHA`) need a threshold; DEMs are normally
  `GMF_NODATA` / `GMF_ALL_VALID`.
- Empty-region pruning: a full-extent native pass must recover the cheap
  ocean-skip the current descent gets for free (bound by source
  footprint and/or a coarse existence pre-pass).

---

## 5. texelSize derivation and calibration

`texelSize` is the only metanode field that is neither stored nor purely
analytic, and it gates LOD descent on every DEM surface, so it gets its
own treatment.

### 5.1 The heuristic

Physically, `texelSize = sqrt(area / textureArea)` where `area` is the
tile's 3-D surface area. For a flat tile `area` is the planar SDS area;
for rugged terrain it exceeds it by a ruggedness factor that correlates
with relief. So:

```
texelSize ≈ (tileEdge / samplesPerTile) · sqrt(1 + c · (relief / tileEdge)²)
```

where `relief = maxZ − minZ` (both in the store), `tileEdge` is analytic
from the LOD and division node, and `c` is a single fit constant. The
planar term is exact; the radical is the relief correction. No
full-resolution warp, at build or serve time.

### 5.2 Calibration spike (an implementation step)

`c` is regressed from data we already have: every existing v6 metatile
carries the true `texelSize` **and** `minZ/maxZ` together. Harvest
`(texelSize, maxZ−minZ, lod)` from served metatiles and fit `c`. The
harvest must be **representative**, not a single convenient tile, because
the relief correction interacts with both LOD and reference-frame
geometry:

- **Two source samples** from Copernicus GLO-30 (§8): one high-relief
  (mountainous) and one near-flat (plain/basin), so the fit spans the
  range of `relief/tileEdge` rather than one regime.
- **Multiple scales.** Harvest across a span of LODs, not one — the
  planar term scales with `tileEdge` and the realised surface area per
  tile changes with LOD, so a `c` fitted at one scale need not hold at
  another. The fit and the residual must be reported per LOD.
- **Both reference frames.** Run the whole harvest in **melown2015** and
  **earth-qsc**. The two differ in tile-cell geometry and SDS, so
  `tileEdge`, the per-tile footprint, and therefore the realised
  `texelSize/planar` ratio differ between them. A `c` representative of
  one is not assumed representative of the other; if they diverge,
  carry a per-reference-frame constant (or table).

The RFC assumes a single regressed `c` per reference frame yields
acceptable LOD selection; if the drift in rugged terrain or at the LOD
extremes proves too large, the fallback is a small per-LOD or
per-relief-bucket table fitted from the same harvest — still a delivery
heuristic over the stored range, no warp. This is the first concrete
implementation step in §8, deliberately ahead of the store work so the
one soft assumption is measured before it is built upon.

The spike also reports monotonicity along descent paths. The client
compares `node.pixelSize` independently per node, so a derived child
value must not exceed its parent or descent can stop early on rugged
terrain. The planar term halves per LOD, but `relief / tileEdge` can
grow with depth. If the raw heuristic violates monotonicity against the
true warped values, delivery clamps the emitted child value to no more
than the emitted parent value. With `metaDepth > 1`, the parent is
already on the store page read path. With the current `metaDepth = 1`
single-LOD packaging, the parent lives in the parent-LOD page, so a
clamped serve path may touch two mapped pages. Phase 5 measures the
store path with the clamp enabled so this cost is included in the
no-warp timing check.

### 5.3 The unused v6 fields

The store emits **v6** unchanged, so fields cartolina-js does not consume
must still be filled with something valid:

- **Horizontal extents** → fill with the analytic **full-cell** SDS
  bounds (tile ID + division node). cartolina-js ignores them
  (`metanode.js:187`) and uses full-cell bounds anyway; any other v6
  consumer gets a *looser* bound than the sampled coverage extent, which
  is conservative-safe (it may draw a tile it could have culled, never
  culls one it should draw). Zero coordination, stays byte-compatible.
- **surrogate** → midpoint (§3.2).

The alternative — patching the v6 spec to reserve these fields — is a
real format break for ~16 bytes/node. Defer it to the later
client-facing shallow-subtree milestone, where reserving fields rides a
change that is structural anyway. Filling full-cell extents keeps the
output diffable against the live warp path during rollout (§7), which
the parity gate needs.

---

## 6. Forward compatibility — shallow-subtree delivery

The likely fix for the ping-pong (§1.5) is to stop serving single-LOD
flat blocks and start serving **shallow subtrees**: a metatile spanning
several LODs of descent. The design must not preclude this, so the
future delivery unit is defined here even though it is deferred.

Metatile addressing is parameterized by two **metatile packaging
parameters**:

- **Horizontal integration.** `metaBinaryOrder` defines
  `h = 1 << metaBinaryOrder`. A metatile root level contains an `h × h`
  block of subtree roots.
- **Vertical integration.** `metaDepth = v` defines how many LOD levels
  each subtree spans. Subtree roots exist at `lod ≡ 0 (mod v)`. A
  requested tile at LOD `L` belongs to root LOD `L - (L mod v)`.

The reference frame provides the default `metaBinaryOrder`. The DEM
surface/resource definition may override horizontal packaging and may
define vertical packaging:

```
effectiveMetaBinaryOrder =
    surface.metaBinaryOrder ?? referenceFrame.metaBinaryOrder

effectiveMetaDepth =
    surface.metaDepth ?? 1
```

The effective values are authoritative for server-side generation,
store layout, metatile serving, and future client traversal. Surface
definitions are the right ownership boundary because DEM surfaces are
generated, rebricked, migrated, rolled back, and cache-busted one at a
time. The reference-frame values remain defaults for resources that do
not opt into per-surface packaging.

The tileserver resource parser, generation tooling, store header,
validation rules, and produced mapConfig surface definition must all
carry both effective values. The values are store metadata, not part of
the value-affecting source hash (§7). The mapConfig fields are how a
future client learns that a surface uses custom packaging. Current
clients ignore both configured sources and use hardcoded values for
terrain metatiles (`surface-tile.js:74`, order 5) and bound-layer texture
metatiles (`texture.js:184`, order 8). Resources intended for current
cartolina-js terrain clients must therefore keep effective
`metaBinaryOrder = 5` and `metaDepth = 1`. Advertising equivalent
surface packaging fields in mapConfig is behavior-neutral today because
the parsed fields are not read. Changing cartolina-js to consume
per-surface packaging is deferred. The tileserver-side knobs, store
layout, and validation support for non-default values are part of this
RFC.

A multi-LOD metatile rooted at `rootLod` contains levels
`h × h`, `2h × 2h`, ..., `h·2^(v-1) × h·2^(v-1)`, for
`h² · (4^v - 1) / 3` nodes total. With today's
`metaBinaryOrder = 5` and `metaDepth = 1`, that is the existing
32×32 single-LOD block of 1024 nodes. A future `metaBinaryOrder = 2`,
`metaDepth = 4` unit would contain 16 + 64 + 256 + 1024 = 1360 nodes,
and would cut a LOD-15 metatile descent from roughly 16 fetch phases to
4 fetch phases.

The root block's X/Y are computed by taking the tile's ancestor at
`rootLod`, then masking by `~(h - 1)`, preserving the current
shift-and-mask `metaId` shape. There is no per-division-node vertical
anchor: a division node rooted off-phase starts as an interior level of
the enclosing metatile, and a `lodRange` that starts mid-phase yields a
partial metatile, just as today's blocks can straddle a tile range.

At `metaDepth > 1`, one metatile has `4^v` child metatiles. The leaf
level's child flags remain the fetch signal at the block boundary, and
the client fetches only children covering the view. Larger `v` reduces
round trips and increases speculative nodes per fetch. Smaller
`metaBinaryOrder` reduces horizontal speculative nodes and may increase
neighbouring metatile requests. Both are per-surface trade-offs once the
client supports them.

The design preserves the shallow-subtree option through two choices
already made:

1. **Raw payload, not pre-serialised metatiles** (§3.3). The delivery
   *packaging* — flat block vs. subtree vs. neighbour-set — is a
   serializer over the store. Changing it does not touch stored bytes.
2. **Page shape is resource packaging** (§3.3). The store format keeps
   node payload independent of packaging. Phases 2–3 prove it can be
   rebricked to a non-default page shape. No storage-model change and no
   DEM retiling are required when the later client milestone chooses a
   subtree delivery unit.

So the client-facing shallow-subtree milestone, when it comes, is a
client/parser change and, if needed, a format bump over server-side
surface settings that already exist. That is also the natural moment to
trim the dead v6 fields (§5.3), all in one structural change rather than
spent piecemeal now.

The single-LOD-block reality of today is confirmed by `metaId`
(`tileop.hpp:401`, masks `x,y &= ~((1<<metaBinaryOrder)-1)`): a metatile
is a single-LOD square block. `metaDepth = 1` preserves that behavior.
The store's page abstraction sits one level below the serializer, so
today's serializer reads a page and emits a v6 block; tomorrow's reads a
page and emits a multi-LOD metatile.

---

## 7. Serve path changes

`SurfaceDem::generateMetatileImpl`
([surface-dem.cpp:311](../../cartolina-tileserver/mapproxy/src/mapproxy/generator/metatile.cpp))
currently calls `metatileFromDem(... warp ...)`. The new path:

1. If a metanode store is present for the resource, read the block's
   page, and for each node serialise `{flags, minZ, maxZ}` plus the
   derived fields (§3.2, §5) directly into the v6 metatile. **No warp.**
2. If no store is present (old resource, mid-rollout), fall back to the
   existing warp path unchanged.

The store carries a **format version, reference-frame id, source hash,
effective metatile packaging values, and pairing revision** so the server
detects a stale or absent store and falls back cleanly during a rolling
upgrade. The source hash covers every input that changes stored values:
source DEM identity, `heightFunction`, geoid/datum configuration, the
mask tree, and value-affecting tiling parameters. Packaging values
(`metaBinaryOrder`, `metaDepth`, page shape) live beside the source hash
because they change page layout and metatile addressing, not the
source-derived node payload.

The flag tile index and metanode store are bound by the same pairing
revision. A full tiling run writes both artifacts. The serve path uses
the store only when the store pairing revision and packaging values match
the loaded flag index and resource definition; otherwise it ignores the
store and uses the warp fallback. This prevents a new store from being
paired with an old index, which would let metatile child flags claim
tiles whose geometry lookups use a different existence tree. Rebuilds
write staged artifacts to temporary names, fsync them, then rename them
into place so a serving daemon sees either the old pair or the new pair.
A future packaging rebrick can reuse the same flag index and rewrite
only store pages, but it must publish a new paired artifact set with
fresh pairing metadata under the same atomic rule.

**Parity gate.** Because the store emits byte-compatible v6 and the warp
path remains available, the two can be diffed node-by-node on the same
resource (height range within `half` tolerance; flags exact; extents
expected to differ — full-cell vs. sampled — and that difference is
characterised, not failed). This is the gate that validates §4's GDAL
assumptions before the store becomes the default.

### 7.1 Deployment and dataset migration

The server rollout and dataset migration are separate.

An upgraded tileserver remains compatible with old DEM resources:

| Resource artifacts | Server action |
|---|---|
| old flag index, no store, three-pyramid VRTWO | serve by warp fallback |
| matched flag index + metanode store | serve from the store |
| mismatched flag index + store | ignore the store; use fallback |
| normal-only VRTWO with no valid store | resource load failure |

The last row is the boundary created by retiring the min/max VRTWO
pyramids. A normal-only DEM resource cannot rely on the old
`valueMinMax` warp path, because the min/max inputs it sampled are not
present. Once phase 6 lands, "fallback" means warp only for old
three-pyramid resources. For normal-only resources, a missing or
mismatched store is a resource health error.

Backfill uses the clean path only: re-run the new tiling pipeline and
produce a fresh flag tile index and metanode store together. Do not
generate a store beside an arbitrary existing tile index. The tiling run
writes a pairing id or digest into both artifacts. Operators do not
increase that pairing value by hand; the tooling computes it from the
inputs and output artifacts.

Changing metatile packaging for an existing dataset is deferred to the
client shallow-subtree milestone. This RFC proves that rebricking is
possible by round-tripping one non-default packaging in phases 2–3, but
does not ship an operator-grade order/depth migration command. Resources
intended for today's cartolina-js client must keep effective
`metaBinaryOrder = 5` and `metaDepth = 1`.

Publication is atomic at the resource-artifact level:

1. Write the new flag index and metanode store to a staging location.
2. Validate the pair: format, shared pairing id, store/index revision
   match, effective packaging values `(5, 1)` for current clients, and
   parity against the warp path where the old VRTWO supports it.
3. Fsync the staged artifacts and containing directory.
4. Rename the staged pair into the resource so a serving daemon sees
   either the old pair or the new pair, never a partial pair.

Rollback keeps the same unit of ownership. For old three-pyramid
resources, rolling back to the previous flag index and no store restores
the warp path. For normal-only resources, rollback must restore the
previous matched flag-index/store pair.

The implementation must ship an operator-facing migration guide when the
tooling exists. That guide belongs with the implemented command names,
artifact paths, validation commands, and daemon reload procedure; it
should not be published as authoritative documentation while this RFC is
still a design.

---

## 8. Implementation plan

The plan mirrors the staged, independently-verifiable shape of
[rfc-draw-traversal.md](rfc-draw-traversal.md): each phase lands a
testable artifact, and the risky assumptions are measured before they
are built upon. **Validation uses small, controllable datasets** —
few-degree cuts from Copernicus GLO-30, one mountainous and one
near-flat — so existence, watertight, range, and texelSize can be checked
against a hand-reducible reference and against the live warp path, before
anything runs on a planet. Calibration and parity checks are run in
**both melown2015 and earth-qsc** (§5.2), since tile-cell geometry
differs between them and results from one frame are not assumed to carry
to the other.

1. **texelSize calibration spike (§5.2).** No store work. Harvest
   `(texelSize, maxZ−minZ, lod)` from existing v6 metatiles over **two**
   Copernicus GLO-30 cuts — one mountainous, one near-flat — across a
   **span of LODs**, in **both melown2015 and earth-qsc**. Regress `c`
   and report the residual drift vs. the true (warped) texelSize per LOD
   and per reference frame. Report monotonicity violations along descent
   paths and decide whether the delivery clamp is required. *Exit:* either
   a single `c` per reference frame with acceptable drift across scales,
   or a fitted small table, plus a monotonicity rule. This de-risks the
   only non-analytic delivery field first, on representative geometry
   rather than one tile.

2. **Resource packaging plumbing + store format.** Add surface-level
   `metaBinaryOrder` and `metaDepth` settings, defaulting to the
   reference-frame `metaBinaryOrder` and `1`, to the tileserver resource
   parser, generated mapConfig surface definition, store header, source
   hash, validation rules, and tiling command-line or resource-file
   knobs. Define the paged, directory-indexed, mmappable on-disk layout
   (§3.3) with `{flags, minZ, maxZ}` and a header carrying version,
   refframe, hash, revision, effective `metaBinaryOrder`, and effective
   `metaDepth`. Implement the reader (`mmapped`-style offset access) and
   a writer. *Exit:* round-trip a hand-built tree at the current
   client-compatible packaging and at one non-default packaging; mmap and
   random-read it; verify node payload equality across the two packaging
   shapes; reject mismatched revisions and mismatched packaging values
   against a flag index/resource fixture.

3. **Unified tiling pass (§4).** Replace the per-tile per-LOD warp with
   the windowed native-resolution pass (mask band + elevation band,
   §4.3 nodata rule) plus streaming bottom-up reduction, emitting both
   the flag index and the metanode store with one shared revision. Keep
   the old tiling tool available behind a flag for the parity diff. *Exit
   on the test dataset:* existence and watertight **identical** to the old
   tool; height range matches a hand-reduced reference within tolerance;
   store pages are produced with the resource's effective packaging
   values; peak memory stays within the window bound; full-pair staging,
   validation, and atomic publish are exercised; §4.5 assumptions
   confirmed empirically.

4. **`mapproxy-setup-resource` integration.** Update
   `mapproxy/src/setup-resource/main.cpp` so the DEM setup path no
   longer always creates `dem.min` and `dem.max`. Today
   `createVrtWO(cm, ...)` creates `dem`, `dem.min`, and `dem.max`, and
   `SetupResource::run()` then calls `tiling::generate` on the `dem`
   link. In metanode-store mode the tool must create only the normal
   `dem` VRTWO, pass the effective `metaBinaryOrder`/`metaDepth` into
   the new tiling/store generation command, require a valid matched flag
   index and metanode store, and fail setup if that pair is absent or
   invalid. The existing three-pyramid path may remain as an explicit
   legacy fallback mode for resources that intentionally use the warp
   path. *Exit:* a small-resource setup through `mapproxy-setup-resource`
   produces the same artifacts and metadata as invoking the lower-level
   commands directly.

5. **Serve from the store, with warp fallback (§7).** `SurfaceDem`
   reads the store and serialises v6; falls back to warp when absent.
   Run the parity gate: diff store-served vs. warp-served metatiles
   node-by-node on the test dataset. *Exit:* flags exact, range within
   `half` tolerance, extents difference characterised, revision mismatch
   forces fallback, monotonic texelSize clamp enabled, **no warp on the
   store path** (verify via timing and GDAL call counts).

6. **Retire the min/max pyramids (§4.4).** Drop the min and max overview
   generation from `generatevrtwo`; confirm no other consumer (§9).
   Confirm `mapproxy-setup-resource` does not request min/max overviews
   in metanode-store mode. *Exit:* a resource builds with the normal
   pyramid only and serves identical metatiles; VRTWO build time drops
   toward 1/3.

7. **Planet-scale bring-up.** Build the store for a production-scale
   surface; measure store size against the §3.1 estimate, cold/warm
   serve latency against the warp baseline, and page-cache behaviour.
   *Exit:* serve latency in single-digit ms; store size and RSS within
   projection.

8. **Operator migration guide.** Write the dataset migration guide after
   the generation, validation, and publish commands exist. It
   must be a HOWTO organized by operator task, not an abstract design
   note:

   - **Process a new DEM dataset.** Choose effective
     `metaBinaryOrder`/`metaDepth`; for current cartolina-js clients,
     keep `metaBinaryOrder = 5` and `metaDepth = 1`. Run the new tiling
     pipeline, either directly or through `mapproxy-setup-resource`,
     validate the flag-index/store pair, publish atomically, and apply
     the deployment's public/cache revision policy.
   - **Migrate an existing three-pyramid DEM dataset to metanode store.**
     Run the new tiling pipeline to create a fresh matched flag index and
     metanode store. Keep the old min/max VRTWO pyramids until store
     parity, fallback behaviour, and rollback are verified. Drop min/max
     pyramids only after the resource has a valid matched store and an
     operator-tested rollback path.
   The guide must also cover normal-only resource failure, daemon reload
   semantics, rollback, and the rule that changing `metaBinaryOrder` or
   `metaDepth` is deferred until the later client packaging milestone
   provides both client support and a rebrick tool. *Exit:* the guide
   uses implemented command names and artifact paths and is linked from
   [index.md](index.md).

9. **Deferred — client shallow-subtree consumption.** Out of scope here
   (§6). When taken up: teach cartolina-js to read the mapConfig
   `metaBinaryOrder`/`metaDepth`, replace the hardcoded terrain
   aggregation order in `surface-tile.js` and the bound-layer metatile
   order in `texture.js`, request multi-LOD metatiles, trim the dead v6
   fields, add the operator packaging-rebrick tool, and bump the metatile
   format if needed. Listed so the boundary is explicit: server-side
   packaging parsing, advertisement, store support, and validation are in
   scope for this RFC; client consumption and operator packaging
   migration are not.

---

## 9. Verification and deferred work

- **GDAL resampling assumptions (§4.5).** The load-bearing claims;
  verified on the test dataset in phase 3 before the serve path depends
  on them.
- **min/max pyramid consumers (§4.4).** Confirm navtile generation and
  any tool/debug path read only the normal pyramid before phase 6
  removes the min/max ones. Confirm `mapproxy-setup-resource` does not
  request min/max overviews in metanode-store mode.
- **texelSize drift (§5.2).** The regressed `c` is an assumption; phase 1
  measures it. Also measure monotonicity along descent paths and enable
  the delivery clamp if the heuristic can emit child values larger than
  their parent.
- **Surrogate fidelity.** Midpoint vs. true-mean is assumed invisible for
  cartolina-js (uses `minZ`) and acceptable for vts-browser-cpp
  (navigation only). Spot-check if a surrogate consumer is ever added.
- **Packaging parameters.** Per-resource tunables; today's
  client-compatible values are `metaBinaryOrder = 5` and `metaDepth = 1`.
  Phase 2 proves non-default packaging can encode the same node payload.
  Phase 7 profiles cold-serve span size, directory size, page-cache
  behaviour, and store size so the later client milestone can choose a
  measured default `metaDepth`.
- **Vertical datum (§3.5).** Confirm the public-SRS vertical is
  orthometric for melown2015 and earth-qsc, that SDS `minZ/maxZ` are in
  that datum (so storing verbatim needs no conversion), and that the
  tiling reduction applies the same `heightFunction`/datum. Confirm
  whether SDS and navSRS share the same vertical datum or require a
  geoid-grid shift at delivery. Spot-check that ocean/flat regions
  actually collapse in a built store. Confirm the "derive datum from the
  reference frame" rule carries to a non-Earth frame if one is ever
  configured.
- **Artifact consistency.** Verify a mismatched store/index revision is
  ignored, and that the tiling writer publishes both artifacts with a
  temp-write, fsync, rename sequence.
- **Setup-tool integration.** Verify `mapproxy-setup-resource` produces
  the same normal-only VRTWO, flag index, metanode store, packaging
  metadata, and validation outcome as the lower-level commands for a
  small DEM resource. Verify the old three-pyramid setup path is used
  only for resources intentionally using the warp fallback.
- **Migration guide.** Do not publish the operator migration guide before
  the implementation exists. When phase 8 lands, keep it aligned with the
  implemented tool names, artifact paths, validation commands, and
  rollback procedure.
- **`half` precision.** ~8 m ulp near 9 km altitude; bias `minZ` down and
  `maxZ` up to the next representable value at write time so the stored
  range is conservative for culling. Verify the bias is applied in the
  writer.
- **Non-DEM surfaces.** Spheroid and geodata are out of scope; confirm
  the warp-fallback path stays intact for them.

---

## 10. What disappears

| Removed / retired | Replaced by |
|---|---|
| Serve-time `valueMinMax` warp in `metatileFromDemImpl` (DEM) | store read + derive (§7) |
| min/max VRTWO pyramids (build and serve) | bottom-up reduction in tiling (§4.4) |
| Per-tile per-LOD warp in `mapproxy-tiling` | single native pass + reduction (§4) |
| Stored `surrogate` (sampled mean) | midpoint of stored range (§3.2) |
| Stored `texelSize` (sampled area) | relief heuristic over stored range (§5) |
| Sampled horizontal extents on the serve path | full-cell analytic (§5.3) |

Unchanged: the v6 metatile format and the client; vtsd; the flag tile
index (both flavors); non-DEM generators.

---

## Review round 1

The source claims were verified against the code before review: the
`valueMinMax` warp and the surrogate/texelSize derivations in
`metatileFromDemImpl`, the `metaId` bit masking in `tileop.hpp`, the
client's use of `minZ` for `diskPos` and its skipping of the v5
extents in `metanode.js`, `publicSrs` in `referenceframe.hpp`, and
`metaBinaryOrder = 5` in every reference frame in the registry
(`vts-registry/registry/registry/referenceframes.json`). All hold as
stated. The priority order in §0 and the separation of the store from
the flag index (§1.3) are sound. The notes below are the gaps that
must close before the design is build-ready.

1. §6 names shallow-subtree delivery as a load-bearing constraint but
   never defines the delivery unit. The store's page shape, the
   directory keying, and the future "re-bake plus serializer" claim
   all depend on what that unit is, so it must be pinned down now —
   otherwise "page depth equal to the subtree depth" is a parameter
   with no defined target. Proposed parameterization:

   Generalize metatile addressing from one reference-frame parameter
   to two. **Horizontal integration `h`**: the metatile's root level
   is an `h × h` block of subtree roots. **Vertical integration `v`**:
   each subtree spans `v` LODs. A metatile rooted at LOD `L` then
   contains node levels of `h×h`, `2h×2h`, …, `h·2^(v−1) × h·2^(v−1)`,
   for `h²·(4^v − 1)/3` nodes total. Worked example: `h = 3, v = 4`
   gives 9 subtrees of depth 4 — 3×3, 6×6, 12×12, 24×24 — 765 nodes.
   Today's metatile (`metaBinaryOrder` 5 in every registry frame) is a
   32×32 single-LOD block of 1024 nodes, so the pyramid metatile is
   *smaller* than today's unit while cutting metatile round trips on a
   descent path by a factor of `v` (a LOD-15 descent: 16 fetches → 4).
   This is the shape Cesium's 3D Tiles implicit tiling uses
   (`subtreeLevels` plus availability streams), which is evidence the
   delivery geometry works at planet scale.

   Refinements the spec should adopt:

   - **Constrain `h` to powers of two** and keep expressing it as the
     existing `metaBinaryOrder`. `metaId` (`tileop.hpp:401`) stays a
     shift-and-mask: take the tile's ancestor at the root LOD, then
     mask `x, y` by `~(h−1)`. The worked example becomes e.g.
     `h = 4, v = 4` → 16 + 64 + 256 + 1024 = 1360 nodes, still
     comparable to today's 1024.
   - **Define the vertical phase globally**: subtree roots exist at
     `lod ≡ 0 (mod v)`, so any tile's metatile root LOD is
     `lod − (lod mod v)`. No per-division-node anchor; a division node
     rooted off-phase (melown2015's productive node at LOD 1) starts
     as an interior level of the enclosing metatile, and a `lodRange`
     starting mid-phase yields a partial metatile, exactly as today's
     blocks straddle `tileRange`.
   - **Make the change additive**: keep `metaBinaryOrder`, add one new
     parameter (suggested name `metaDepth`) defaulting to 1. Today's
     format is the `(metaBinaryOrder, metaDepth = 1)` special case, so
     the registry change is deferred to the packaging milestone and no
     existing reference frame is touched until then. Old-client
     compatibility rides the metatile format bump that milestone
     already carries.
   - **Child fan-out**: one metatile has `4^v` child metatiles (256 at
     `v = 4`). The leaf level's child flags are the fetch signal, as
     at today's block edge; the client fetches only the children
     covering the view. Larger `v` buys fewer round trips at the cost
     of more speculative nodes per fetch — `v` and `h` are registry
     tunables to be measured at the packaging milestone, not fixed
     here.

   Consequences to record in §3.3/§6: store page depth = `v`, pages
   keyed by subtree root `(lod, x, y)` with the same phase rule. The
   delivery re-encoding step then has a concrete shape — read one
   page, serialize one multi-LOD metatile — and §3.3's "one page, one
   `sendfile`" claim becomes exact rather than aspirational.

   *Implemented.* §6 now defines the future delivery unit as
   `(metaBinaryOrder, metaDepth)`, with power-of-two horizontal masking,
   global vertical phase, default `metaDepth = 1`, child fan-out, and a
   worked `metaBinaryOrder = 2`, `metaDepth = 4` example. The design was
   later refined so both packaging values are effective per-surface
   settings, with reference-frame values serving as defaults. §3.3
   defines store pages by the same phased root block. The round-2
   response later narrowed the milestone: this RFC proves rebrickability
   in validation, while operator-grade packaging migration belongs to
   the later client packaging milestone.

2. §3.1 stores "flags + child flags" without enumerating which flags.
   Some metatile flags are config-derived, not data-derived:
   `navtilePresent` depends on the resource's navtile LOD range, and
   storing it would bake configuration into the store — a config edit
   would then silently invalidate stored bytes. Enumerate the stored
   set explicitly: existence (mesh) and watertight from the tiling
   pass; child existence from the tree structure itself; navtile
   presence derived at delivery from LOD against the resource config;
   everything else (alien, glue) not applicable to a mapproxy DEM
   surface.

   *Implemented.* §3.1 now lists only mesh existence, watertight, `minZ`,
   and `maxZ` as stored payload. §3.2 derives child existence from tree
   structure and navtile presence from resource config, with alien and
   glue/source-reference state excluded for mapproxy DEM surfaces.

3. §7's "source hash" is undefined, and the store/flag-index pair has
   no stated consistency rule. The hash must cover every input that
   changes stored values: source DEM identity, `heightFunction`,
   geoid/datum configuration, the mask tree, and the tiling
   parameters (including page depth). Separately, the store and the
   flag tile index become two artifacts claiming authority over
   existence and watertight; §4 generates both in one pass, but §7's
   fallback makes mixed states reachable mid-rollout. State the rule:
   both artifacts are written by the same tiling run and bound by a
   shared revision, so the serve path never pairs a new store with an
   old index (clients would see child flags disagreeing with 404s).
   Since stores will be rebuilt under a serving daemon, also state the
   atomic-swap rule (write to temp, fsync, rename).

   *Implemented.* §7 defines the source hash inputs, separates packaging
   metadata from value-affecting source inputs, adds a shared pairing
   revision for the flag index and store, requires revision and packaging
   match before the store path is used, and states temp-write, fsync,
   rename publication. §8 and §9 add mismatch verification.

4. §4.2 says "warp the source once at the resolution floor". At
   GLO-30's native resolution a global grid is on the order of 10¹²
   cells (~2 TB at int16) — it cannot be materialized, and the section
   does not say how the pass is bounded. State the implementation
   shape: a windowed pass (block-wise warps aligned to output cells)
   with streaming bottom-up reduction as windows complete, and a
   stated peak-memory bound. The `O(area)` cost claim survives; the
   point is that "once" means one visit per source pixel, not one
   warp call.

   *Implemented.* §4.2 now describes a bounded windowed pass, streaming
   bottom-up reduction, and peak memory as workers times window cells
   plus open parent accumulators. §8 makes the memory bound a phase-3
   exit condition.

5. §5's heuristic has an unstated ordering requirement. The client
   evaluates `node.pixelSize` per node independently, so LOD descent
   assumes texel size decreases along every descent path. The planar
   term halves per LOD exactly, but `relief/tileEdge` can grow with
   depth (a cliff's relief does not halve when the tile does), so the
   derived child value is not guaranteed to fall below the parent's
   where the true values do — and where it fails, descent stops early
   and terrain stays coarse. Add to the phase-1 spike: report
   monotonicity violations of the heuristic along descent paths
   against the true texelSize, and if violations occur, specify the
   delivery-time clamp (the parent's stored range is on the path read,
   so clamping child ≤ parent is cheap).

   *Implemented.* §5.2 adds monotonicity reporting to the calibration
   spike and specifies a delivery clamp that caps a child value to its
   emitted parent value when needed. §8 and §9 carry that check forward.

6. §3.2 labels the navtile range derivation "SDS→nav transform of the
   stored range (analytic)". It is not analytic in general: when the
   navigation SRS vertical is the same orthometric datum as the SDS
   vertical, the transform is identity on heights; otherwise it is a
   per-node vertical shift evaluated from geoid grids — a grid lookup,
   cheap but not a formula. Name the actual mechanism and its cost,
   and fold the SDS-vs-nav datum check into the §9 vertical-datum
   checklist item.

   *Implemented.* §3.2 now names the SDS→nav range conversion as cheap
   but not always analytic, distinguishing identity-height transforms
   from geoid-grid shifts. §9 adds the SDS-vs-nav datum check.

## Additional topics for review round 2

The deployment and dataset-migration changes below were added after the
round-1 response. They are added review scope for round 2 in addition to
any unresolved round-1 follow-up.

- §7.1 now separates server rollout from dataset migration. The upgraded
  server keeps the old three-pyramid resource path working through warp
  fallback, serves matched flag-index/store pairs from the store, ignores
  mismatched stores, and treats normal-only VRTWO resources without a
  valid store as load failures.
- Backfill is now specified as a full new tiling run that writes a fresh
  flag tile index and metanode store together. The document rejects the
  alternative of generating a store beside an arbitrary existing tile
  index.
- §7.1 states that the tiling tool computes the pairing id or digest;
  operators do not edit it by hand. Public resource or CDN revision bumps
  are publication policy, not the correctness mechanism.
- §7.1 and §8 require staging, validation, fsync, and atomic publication
  of the new flag-index/store pair before the old tile index is rotated
  out.
- §8 and §9 now require an operator migration guide as an implementation
  deliverable, but do not publish it before the tooling exists. The guide
  must use implemented command names and artifact paths. §8 now
  prescribes the guide as a task-oriented HOWTO with sections for
  processing a new DEM dataset and migrating an existing three-pyramid
  DEM dataset to the metanode store.
- §6 now defines `metaBinaryOrder` and `metaDepth` as surface-level
  metatile packaging settings, with reference-frame values used as
  defaults for the server. §8 requires tileserver parser, tooling, store
  header metadata, validation, and generated mapConfig surface
  definitions to carry the effective values.
- §7.1 now defers operator-grade changes to `metaBinaryOrder` and/or
  `metaDepth` on an existing dataset until the later client packaging
  milestone. This RFC proves the stored payload can be rebricked by
  validating one non-default packaging shape, but does not ship a
  production rebrick command.

## Review round 2

All six round-1 dispositions were checked against the revised body and
are faithfully implemented. The new §7.1 is sound as a design: the
pairing revision, the tooling-computed pairing id, the staged
write/validate/fsync/rename publication, the rollback rule per resource
flavor, and the explicit "normal-only VRTWO without a valid store is a
load failure" boundary are the right mechanics, stated checkably. The
notes below target the added scope and two inconsistencies the rewrite
introduced.

1. The client compatibility story in §1.6 and §6 does not match the
   client. Verified in the source: the current cartolina-js metatile
   addressing is hardcoded — `surface-tile.js:74` calls
   `findAgregatedNode(id, 5, true)` with a literal 5 (and
   `texture.js:184` a literal 8 for bound-layer metatiles). The
   reference-frame value is parsed (`refframe.js:33`), copied to
   `MapSurfaceTree.metaBinaryOrder` (`surface-tree.js:16`), and never
   read; the surface-level value is parsed (`surface.js:85`,
   `this.metaBinaryOrder = json['metaBinaryOrder'] || 1`) and never
   read. Three consequences:

   - §1.6's "Today this value comes from the reference frame" is true
     of the server only. State both halves: the server takes
     `metaBinaryOrder` from the reference frame; the current client
     ignores both config sources and uses a hardcoded 5, which works
     because every registry frame is 5.
   - §6's compatibility constraint must be stated numerically:
     resources for current clients need effective
     `metaBinaryOrder = 5` and `metaDepth = 1`. "Keep the
     reference-frame value" is the wrong rule — a hypothetical frame
     with a different order would already break today's client.
   - The §6 caveat "even if the mapConfig already advertises
     equivalent surface fields" is verified safe, and the RFC can say
     so plainly: advertising surface packaging fields cannot change
     current-client behavior because the parsed fields are dead.
     Record the hardcoded sites (`surface-tile.js:74`,
     `texture.js:184`) in §8 phase 9 as the things the deferred client
     milestone must replace with the effective per-surface values.

   *Implemented.* §1.6, §2, §6, §7.1, §8, and §9 now state the numeric
   current-client rule: terrain resources served to current cartolina-js
   clients must use effective `metaBinaryOrder = 5` and `metaDepth = 1`.
   The body distinguishes the server's current reference-frame default
   from the client's hardcoded terrain and bound-layer orders, and §8's
   deferred client milestone names the two hardcoded call sites to
   replace. A backlog entry records that client debt outside this RFC.

2. §3.3 now contradicts itself. The "two extremes both lose" argument
   rejects per-LOD pages, yet the chosen client-compatible page shape
   (`metaDepth = 1`) *is* the per-LOD extreme. Round 1's design
   escaped via a page depth decoupled from delivery; the revision
   couples page shape to the effective packaging — a good
   simplification (one less free parameter), but the supporting text
   was not updated to match. Rewrite the extremes paragraph to the
   actual rule: page shape equals the delivery unit, the per-LOD shape
   is acceptable as the v1 shape *because* rebricking is first-class,
   and a future subtree unit is a rebrick away. Two follow-ons:

   - §9's "profile cold-serve span size and directory size after
     phase 6" item is vestigial: with page shape locked to packaging
     and packaging locked to `(5, 1)` by client compatibility, there
     is no tunable left until the client milestone. Either delete the
     item or state which decision the profiling feeds (e.g. choosing
     the future default `metaDepth`).
   - At `metaDepth = 1` a page is a single-LOD 32×32 slice, which is
     not a subtree, while §3.3 describes only depth-first subtree
     serialisation. State how a level slice is serialised inside a
     page (dense 1024-slot grid, or leaf level of a depth-5 local tree
     with uniform quadrants collapsed) — it decides whether the ocean
     and flat-water collapse claimed in §3.4/§3.5 happens inside
     pages or only between them.

   *Implemented.* §3.3 now defines a page as the resource's delivery
   unit and explicitly describes the current `(5, 1)` page as a
   single-LOD 32×32 slice encoded as a two-dimensional local quadtree.
   The text now says why the per-LOD v1 shape is acceptable: it is the
   only client-compatible shape, and phases 2–3 prove the raw payload can
   be rebricked to a future subtree shape. §9 now states that phase-6
   profiling feeds the later choice of default `metaDepth`.

3. Phase 7 ships a migration tool with no legal production use in
   this milestone: changing packaging away from `(5, 1)` is forbidden
   until a client consumes it, and page-shape tuning is excluded by
   the same constraint. The project rule is no machinery for
   hypothetical future use, and §0 says serve latency is the prize —
   the rebrick tool serves neither. The forward-compatibility proof
   the RFC actually needs is already delivered by phase 2's exit
   (round-trip at one non-default packaging) plus a payload-equality
   check; the operator-grade tool and its §8 guide section have their
   user only in the client milestone.

   **Recommendation: demote phase 7 to a validation exercise inside
   phases 2–3 and move the tool, with its §8 guide section, to the
   client milestone's scope.**

   The alternative — giving the tool a user by pulling client
   consumption of surface-advertised packaging into this RFC — is
   rejected for these reasons, recorded so the boundary holds:

   - It is a second design, not an addition. Reading the mapConfig
     field is the trivial part; the content is a multi-LOD metatile
     binary format (a v7 break — a node pyramid cannot be serialised
     as byte-compatible v6), a rewrite of the metatile fetch-descend
     logic in the legacy JS tree code, the dead-field trim, and the
     choice of `metaDepth` itself.
   - It would dismantle the parity gate. This RFC's rollout safety
     rests on store-served v6 being diffable node-by-node against
     warp-served v6 (§7). A multi-LOD metatile has no warp-path twin
     to diff against; keeping the client out keeps the validation
     story intact.
   - The decision data does not exist yet. The right `metaDepth` is a
     measured trade between round trips and speculative bytes, per
     reference frame, and depends on the cold/warm serve latency,
     page-cache behaviour, and store size that phase 6 produces.
     Choosing `v` before phase 6 is guessing; after it, measuring.
   - The deferral costs are asymmetric. Deferring the tool costs
     nothing: rebrickability is proven by the phase 2 exit, the node
     payload is packaging-independent by construction, and raw
     payload plus rebrick is exactly the option §3.3 already bought.
     Shipping the tool early buys an operator-grade artifact that
     must then be maintained through the very format decisions it
     predates.
   - The store with warp fallback delivers the §0 prize — cold misses
     in milliseconds — to every existing client the day it deploys,
     with zero client coordination. Coupling that win to a client
     format break holds it hostage to the longest pole in the
     project.

   *Implemented.* The production packaging rebrick tool was removed from
   this RFC's implementation plan. Rebrickability is now a validation
   obligation in phase 2's non-default packaging round-trip and payload
   equality check. §7.1 and §8 defer the operator-grade order/depth
   migration command, and the operator guide no longer promises
   rebrick-command instructions in this milestone. The client consumption
   work remains a separate deferred milestone.

   Client consumption should open as its own RFC once phase 6 numbers
   are in hand. Separately, file a backlog entry (not RFC scope) for
   the client's hardcoded aggregation order from note 1: replacing the
   literal 5 with the advertised value is behavior-neutral today but
   is a silent landmine if any frame ever ships a different order.

4. §5.2's clamp claims the parent "is available in the current
   single-LOD serializer by looking up the parent node". Be precise
   about the cost: at `metaDepth = 1` the parent of every node in a
   page lives in the parent-LOD page, so a clamped serve touches two
   pages, not one. Still cheap, but §0's "read bytes, emit bytes"
   accounting should say it, and phase 4's no-warp timing check
   should run with the clamp enabled so the two-page path is what
   gets measured.

   *Implemented.* §5.2 now distinguishes the `metaDepth > 1` case, where
   the parent is already on the page read path, from today's
   `metaDepth = 1` case, where clamping may touch the parent-LOD page.
   Phase 5 now requires the no-warp timing check with the monotonic
   clamp enabled.

5. Editorial breakage from the rewrite, all in §6:

   - The paragraph "It does not, because of two choices already
     made:" lost its referent when the surrounding text was rewritten;
     the sentence it answered ("The design must not preclude this…")
     no longer ends with the claim "it does not". Reconnect or
     rephrase.
   - "The reference frame provides defaults and a compatibility hint"
     — "compatibility hint" names no mechanism. The hint is nothing
     more than the default value itself; drop the phrase or define it.
   - The round-1 response under note 1 says both packaging values
     take reference-frame defaults, but the §6 formula defaults
     `metaDepth` to the constant 1 and never reads it from the
     reference frame. The body is right (the registry stays
     untouched, which is the point); align the wording where the
     asymmetry is described.

   *Implemented.* §6 now has a clear referent for the shallow-subtree
   preservation paragraph, drops the undefined "compatibility hint"
   phrase, and describes the asymmetric defaults directly:
   `metaBinaryOrder` comes from the reference frame unless a surface
   overrides it, while `metaDepth` defaults to `1`.

## Author follow-up during review round 2

While processing round 2, the RFC also tied off the setup-tool path.
`mapproxy-setup-resource` is part of the DEM setup workflow, not an
external convenience script. Its source currently creates three DEM
VRTWO datasets (`dem`, `dem.min`, `dem.max`) before running
`tiling::generate`. The RFC now requires metanode-store mode to produce
only the normal DEM VRTWO, write the matched flag-index/store pair,
carry effective `metaBinaryOrder`/`metaDepth`, and validate the pair
before publication. The old three-pyramid path may remain only as an
explicit legacy fallback resource mode.

## Review round 3

All five round-2 dispositions were checked against the revised body
and are faithfully implemented: the numeric `(5, 1)` compatibility
rule with the hardcoded client sites named, the §3.3 reframe around
page-equals-delivery-unit with the level-slice local quadtree and
within-page collapse, the rebrick tool demoted to the phase-2
validation obligation, the two-page clamp cost, and the §6 editorial
repairs. The backlog entry for the client's hardcoded aggregation
order is in place and correctly scoped.

The setup-tool follow-up was verified against the source:
`setup-resource/main.cpp` creates `dem` (cubicspline), `dem.min`
(minimum), and `dem.max` (maximum) at lines 650–668 and runs
`tiling::generate` at line 917, as the RFC states. The new phase 4 is
correctly scoped (normal-only VRTWO, paired artifacts required, the
three-pyramid path surviving only as an explicit legacy mode) and its
exit criterion is testable.

The design is converged. One mechanical defect remains, introduced by
the phase renumbering:

1. Three phase cross-references still point at the old numbering.
   After inserting setup-resource integration as phase 4, serve from
   the store is phase 5 and planet-scale bring-up is phase 7, but:

   - §5.2 says "Phase 4 measures the store path with the clamp
     enabled" — the no-warp timing check with the clamp is phase 5.
   - §9 "Packaging parameters" says "Phase 6 profiles cold-serve span
     size, directory size, page-cache behaviour, and store size" —
     that profiling is phase 7, planet-scale bring-up.
   - The author response under round-2 note 4 says "Phase 4 now
     requires the no-warp timing check" — phase 5. The annotation is
     the author's text and should be corrected by the author.

   The remaining phase references were checked and are consistent
   with the new numbering. With these three corrected, the next round
   is expected to be a sign-off.

   *Implemented.* Corrected the three stale phase references: §5.2 and
   the round-2 note-4 author response now point the clamp timing check to
   phase 5, and §9 now points the packaging profiling item to phase 7.

## Review round 4

The round-3 note is implemented exactly: the three stale phase
references now match the renumbered plan, and a re-check of every
phase reference in the document found no others.

Before signing off, a final cross-check of §4 against the backlog
item it subsumes surfaced one design regression. One note; round 5 is
expected to be the sign-off once it is resolved.

1. §4.2 should return to the subsumed backlog item's reduction
   design: warp to **one pixel per tile** with GDAL min/max
   resampling, instead of warping at the resolution floor and
   reducing in custom code.

   The original coverage-mask item (opened 2026-05-29) specified the
   leaf reduction as GDAL's job: "Reduce two statistics per output
   cell during the warp, using GDAL's min/max resampling
   (`GRA_Min` / `GRA_Max`)". §4.2 rewrote this into a
   native-resolution windowed pass with hand-rolled streaming
   reduction — while §4.5 kept the assumption list of the filter
   design ("GDAL min/max resampling aggregates over the full
   destination footprint"), which has nothing to test when the
   reduction is custom code. The document drifted from the design
   that generated its own checklist.

   The filter design is better on this project's axes, and §4.2,
   §4.3, §4.5, and phase 3 should be rewritten around it:

   - The windowed pass calls GDAL warp per window anyway, so it is
     GDAL's `ChunkAndWarpImage` chunking re-implemented one level up,
     plus accumulator machinery GDAL makes unnecessary. Warping each
     reference-frame division node into a destination grid of one
     pixel per tile at the analysis maximum LOD moves the entire leaf
     reduction into the warp kernel. GDAL is built to warp
     arbitrarily large datasets block-wise under a memory budget
     (warp memory limit, `NUM_THREADS`); delegate to it.
   - Outputs per division node: four grids — mask-min, mask-max,
     elev-min, elev-max. For melown2015 at LOD 15 that is
     2¹⁴ × 2¹⁴ per grid, ~1.5 GiB total: inspectable flat rasters,
     so phase 3's hand-reduced reference check becomes a raster
     diff.
   - The bottom-up reduction degenerates to 2× min/max downsampling
     of those grids: on 0/255 masks, max *is* OR and min *is* AND, so
     the whole flag-and-range pyramid is a trivial mip loop. Write
     that loop in the tool, interleaved with flag-index and
     store-page emission — the ascent that computes parent min/max
     is the same walk that builds both artifacts. Do not delegate it
     to GDAL overviews: `BuildOverviews` has no min/max resampling
     (GDAL 3.4 offers nearest/average/rms/gauss/cubic/…/mode only;
     min/max exist in the warp kernels alone). The "partial parent
     accumulators for open regions" machinery disappears.
   - Per §0, generation is the lesser win: the extra source-read
     passes this costs (below) buy a large code deletion. That is
     the right trade.

   Constraints the rewrite must state:

   - One warp operation has one resampling algorithm
     (`GDALWarpOptions::eResampleAlg` is per-operation, not
     per-band), so this is one warp per (band, filter): four passes,
     each re-reading the source. Sequential reads at build time,
     acceptable per §0. The mask band must be exposed as a warpable
     band (a VRT wrapping `GetMaskBand`, or a translate to a byte
     raster).
   - State the data-volume claim precisely: output volume drops by
     `samplesPerTile²` (about four orders of magnitude); source I/O
     and kernel work remain `O(source pixels)` per pass.
   - §4.3's nodata inversion survives unchanged, expressed as
     per-pass warp options: mask passes with no `srcnodata`,
     elevation passes with `srcnodata` set, mask destination
     initialised to 0 so cells outside the source reduce to
     not-existing.
   - New §4.5 item — edge-shared samples. The pixel-per-tile warp
     partitions source pixels disjointly among tiles, while the
     serve-time warp it must match samples corner-inclusive grids in
     which adjacent tiles share edge samples; an extremum exactly on
     a tile edge lands in one tile only. The `half` write bias gives
     ~1 ulp of slack; the phase-5 parity gate must characterise the
     residual.
   - `heightFunction` commutes with min/max only when monotonic.
     State the rule: apply it post-aggregation in the monotone
     (normal) case; a non-monotone function would need a pre-warp
     derived-band VRT.
   - §4.5's full-footprint aggregation assumption graduates from
     checklist item to the load-bearing claim of the leaf pass,
     verified in phase 3 exactly as already planned, including the
     warp kernel's window heuristics (`XSCALE`/`YSCALE`) at extreme
     downsample ratios.

   Nothing outside §4 moves: the store, the datum, the
   pairing/publication machinery, the serve path, and the phase
   gates stand. The change makes the document consistent with its
   own §4.5 and its parent backlog item.

For the record, two non-blocking observations requiring no document
changes now:

- If the phase-1 spike shows relief is the wrong texelSize signal in
  kind (rough-but-low-relief terrain), the in-design escape is a
  third stored channel — true surface area reduced by summation in
  the same tiling pass — not further calibration. Recorded so the
  option is not rediscovered under pressure.
- The client shallow-subtree milestone should open as its own RFC
  once phase-7 numbers exist, taking with it the operator rebrick
  tool, the v6 field trim, and the backlog entry on the client's
  hardcoded aggregation orders.
