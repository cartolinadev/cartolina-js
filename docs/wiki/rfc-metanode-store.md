# RFC 7: the metanode store — precomputed metatiles without serve-time
warp

**Status:** Draft
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
  a re-bake plus a serializer change, not a redesign.
- Fold the height-range extraction into a redesigned `mapproxy-tiling`
  that computes existence, watertight, and range in one native-resolution
  pass plus a bottom-up reduction — retiring the per-tile per-LOD warp
  and the min/max VRTWO pyramids.

**Non-goals**

- The client-side ping-pong (§1.5). Separate, complementary, deferred.
- A metatile format break. The store emits **v6**, byte-compatible,
  during this milestone. Trimming dead v6 fields is deferred to the
  packaging RFC where it rides a change that is structural anyway (§5.2).
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
| flags + child flags | (in node encoding) | tiling pass |
| `minZ` | 2 (`half`) | tiling pass — elevation min |
| `maxZ` | 2 (`half`) | tiling pass — elevation max |

**4 bytes of payload per node.** Everything else a metanode carries is
derived at delivery (§3.2). The store carries its **own** copy of the
flags so a metatile serves from a single read; the duplication is
negligible (flags collapse to almost nothing in the quadtree) and it
leaves the existing flag index, and vtsd, untouched.

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
| content / child flags | from the store's flags |
| `minZ` / `maxZ` (SDS) | read from the store |
| `minHeight`/`maxHeight` (navtile, navSRS) | SDS→nav transform of the stored range (analytic) |
| `surrogate` | **midpoint** `(minZ+maxZ)/2` (see below) |
| `texelSize` | relief heuristic over the stored range (§5) |
| SDS horizontal extents (`llX..urX`) | **full-cell** analytic from tile ID + division node (§5.2) |

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
to a file offset and length. A page is a bricked subtree: a fixed-depth
chunk of the quadtree serialised depth-first, so the page's nodes are
contiguous on disk and serve as one mapped span (one `pread`, candidate
for `sendfile`).

**Page shape is a build parameter, not a format invariant.** This is the
crux of forward compatibility (§6). The two extremes both lose:

- *Per-LOD trees* (mirroring today's index): a single-LOD block is
  contiguous, but a future depth-*k* shallow subtree needs *k* separate
  reads.
- *One global depth-first tree*: any subtree is contiguous, but today's
  single-LOD block is scattered, and its contiguous superset (the whole
  depth-`metaBinaryOrder` subtree) is far too large to read per request.

Bricking with a tunable page depth is the compromise that serves both.
And because the store is a *derived* artifact, cheaply re-bakeable, the
page shape is never a permanent commitment: when delivery moves from
single-LOD blocks to shallow subtrees, re-bake with a page depth equal
to the subtree depth and the future delivery unit becomes *one page, one
`sendfile`*.

**Store raw payload, not pre-serialised metatiles.** Serialising
`{flags, minZ, maxZ}` into a v6 metatile at request time costs
microseconds; pre-serialising would re-bake the world on every format or
packaging change. Raw payload future-proofs against exactly the
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

Per reference-frame division node, warp the source **once** at the
resolution floor (the native-resolution LOD calipers already computes),
and reduce per output cell. Two bands, reduced to four statistics:

1. **Mask band** (`GetMaskBand`, GDAL RFC 15) → existence and watertight.
   `max(cell) > 0` ⇒ exists; `min(cell) == 255` ⇒ watertight.
2. **Elevation band** → `minZ = min(cell)`, `maxZ = max(cell)`.

Then build coarser LODs bottom-up with no further sampling:

- existence: `parent = OR(children)`
- watertight: `parent = AND(children)`
- `minZ`: `parent = min(children)`
- `maxZ`: `parent = max(children)`

Leaves are sampled once; every coarser node is pure reduction. This is
the `O(levels × area)` → `O(area)` collapse the coverage-mask item
describes, now carrying the height payload in the same reduction.

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
real format break for ~16 bytes/node. Defer it to the shallow-subtree
packaging RFC, where reserving fields rides a change that is structural
anyway. Filling full-cell extents keeps the output diffable against the
live warp path during rollout (§7), which the parity gate needs.

---

## 6. Forward compatibility — shallow-subtree delivery

The likely fix for the ping-pong (§1.5) is to stop serving single-LOD
flat blocks and start serving **shallow subtrees** — a metatile spanning
several LODs of descent — or neighbouring sets of them, on the bet that
a client fetching a metanode will follow with its children. The design
must not preclude this.

It does not, because of two choices already made:

1. **Raw payload, not pre-serialised metatiles** (§3.3). The delivery
   *packaging* — flat block vs. subtree vs. neighbour-set — is a
   serializer over the store. Changing it does not touch stored bytes.
2. **Page shape is a build parameter** (§3.3). Re-bake the store with a
   page depth equal to the target subtree depth, and the new delivery
   unit *is* one page: serve = `sendfile`. No storage-model change.

So the shallow-subtree milestone, when it comes, is a serializer plus a
re-bake — and that is also the natural moment to trim the dead v6 fields
(§5.3) and bump the metatile format, all in one structural change rather
than spent piecemeal now.

The single-LOD-block reality of today is confirmed by `metaId`
(`tileop.hpp:401`, masks `x,y &= ~((1<<metaBinaryOrder)-1)`): a metatile
is a single-LOD square block. The store's page abstraction sits one level
below that, so today's serializer reads a page's leaf slice and emits a
block; tomorrow's reads a page and emits a subtree.

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

The store carries a **format version, reference-frame id, and source
hash** so the server detects a stale or absent store and falls back
cleanly during a rolling upgrade. The fallback is the safety net that
makes the parity gate (§8, phase 4) non-blocking for production.

**Parity gate.** Because the store emits byte-compatible v6 and the warp
path remains available, the two can be diffed node-by-node on the same
resource (height range within `half` tolerance; flags exact; extents
expected to differ — full-cell vs. sampled — and that difference is
characterised, not failed). This is the gate that validates §4's GDAL
assumptions before the store becomes the default.

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
   and per reference frame. *Exit:* either a single `c` per reference
   frame with acceptable drift across scales, or a fitted small table.
   This de-risks the only non-analytic delivery field first, on
   representative geometry rather than one tile.

2. **Store format + writer, height channel only.** Define the paged,
   directory-indexed, mmappable on-disk layout (§3.3) with `{flags,
   minZ, maxZ}` and the version/refframe/hash header. Implement the
   reader (`mmapped`-style offset access) and a writer. *Exit:* round-trip
   a hand-built tree; mmap and random-read it.

3. **Unified tiling pass (§4).** Replace the per-tile per-LOD warp with
   the single native-resolution pass (mask band + elevation band, §4.3
   nodata rule) plus bottom-up reduction, emitting both the flag index
   and the metanode store. Keep the old tiling tool available behind a
   flag for the parity diff. *Exit on the test dataset:* existence and
   watertight **identical** to the old tool; height range matches a
   hand-reduced reference within tolerance; §4.5 assumptions confirmed
   empirically.

4. **Serve from the store, with warp fallback (§7).** `SurfaceDem`
   reads the store and serialises v6; falls back to warp when absent.
   Run the parity gate: diff store-served vs. warp-served metatiles
   node-by-node on the test dataset. *Exit:* flags exact, range within
   `half` tolerance, extents difference characterised, **no warp on the
   store path** (verify via timing and GDAL call counts).

5. **Retire the min/max pyramids (§4.4).** Drop the min and max overview
   generation from `generatevrtwo`; confirm no other consumer (§9).
   *Exit:* a resource builds with the normal pyramid only and serves
   identical metatiles; VRTWO build time drops toward 1/3.

6. **Planet-scale bring-up.** Build the store for a production-scale
   surface; measure store size against the §3.1 estimate, cold/warm
   serve latency against the warp baseline, and page-cache behaviour.
   *Exit:* serve latency in single-digit ms; store size and RSS within
   projection.

7. **Deferred — shallow-subtree packaging.** Out of scope here (§6).
   When taken up: re-bake with subtree-depth pages, add the subtree
   serializer, trim the dead v6 fields, bump the metatile format. Listed
   so the boundary is explicit.

---

## 9. Verification and deferred work

- **GDAL resampling assumptions (§4.5).** The load-bearing claims;
  verified on the test dataset in phase 3 before the serve path depends
  on them.
- **min/max pyramid consumers (§4.4).** Confirm navtile generation and
  any tool/debug path read only the normal pyramid before phase 5
  removes the min/max ones.
- **texelSize drift (§5.2).** The regressed `c` is an assumption; phase 1
  measures it. Revisit if rugged-terrain LOD selection regresses.
- **Surrogate fidelity.** Midpoint vs. true-mean is assumed invisible for
  cartolina-js (uses `minZ`) and acceptable for vts-browser-cpp
  (navigation only). Spot-check if a surrogate consumer is ever added.
- **Page depth.** A tunable; profile cold-serve span size and directory
  size after phase 6. The "right" depth for single-LOD blocks may differ
  from the future subtree depth — that is expected, it is a re-bake
  parameter.
- **Vertical datum (§3.5).** Confirm the public-SRS vertical is
  orthometric for melown2015 and earth-qsc, that SDS `minZ/maxZ` are in
  that datum (so storing verbatim needs no conversion), and that the
  tiling reduction applies the same `heightFunction`/datum. Spot-check
  that ocean/flat regions actually collapse in a built store. Confirm the
  "derive datum from the reference frame" rule carries to a non-Earth
  frame if one is ever configured.
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
