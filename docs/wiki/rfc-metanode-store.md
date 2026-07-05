# RFC 7: the metanode store — precomputed metatiles without serve-time
warp

**Status:** Implemented (2026-06-12)
**Opened:** 2026-06-07
**Context:** subsumes two backlog items —
**PERF: pre-built metatile index eliminating serve-time DEM warps** and
**PERF/REDESIGN: coverage-mask `mapproxy-tiling`** in
[the tileserver backlog](https://github.com/cartolinadev/cartolina-tileserver/blob/main/docs/backlog.md).
Background in
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
  that computes existence, watertight, and range through
  one-pixel-per-tile GDAL filter passes plus a bottom-up reduction —
  retiring the per-tile per-LOD warp and the min/max VRTWO pyramids.

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
- **The stored range must end up in that same SDS frame.** The §4 filter
  passes reduce *raw source* elevations to a per-tile `{min, max}`; the
  resource's `heightFunction` and any source→SDS vertical-datum
  conversion apply *after* aggregation, to those two numbers (§4.2). Min
  and max commute with a monotone height map, so the post-aggregation
  result matches what the warp would have produced. If a source DEM is
  ellipsoidal, the same post-aggregation step converts it to the
  orthometric SDS datum, both for correctness and to regain the collapse;
  a spatially varying conversion is bounded against the `half` write bias
  or moved pre-warp (§4.2).
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

### 4.2 The one-pixel-per-tile filter pass

Per reference-frame division node, warp the source into leaf grids at
the analysis maximum LOD, with **one destination pixel per tile**. GDAL
does the leaf reduction: each destination pixel receives the min or max
over the source footprint that maps to that tile. The tool does not
materialize a sub-tile sample grid and does not hand-reduce native
samples.

Four leaf grids are produced per division node:

1. **Mask max** from the GDAL mask band (`GetMaskBand`, RFC 15):
   `max(cell) > 0` means the tile exists.
2. **Mask min** from the same mask band:
   `min(cell) == 255` means the tile is watertight for binary masks.
3. **Elevation min** from the DEM band: `minZ = min(cell)`.
4. **Elevation max** from the DEM band: `maxZ = max(cell)`.

One GDAL warp operation has one resampling algorithm
(`GDALWarpOptions::eResampleAlg`), so this is one warp per
`(band, filter)`: four passes, each re-reading the source. That is an
acceptable generation-time cost per §0. GDAL already chunks large warp
operations under a memory budget and can use `NUM_THREADS`; use that
instead of reimplementing chunked warp scheduling and custom
accumulators. The mask band must be exposed as a warpable band, either
with a VRT over `GetMaskBand()` or by translating it to a byte raster.

All four passes must read the source at **base resolution with overview
selection disabled** (`-ovr NONE`, or an API path that demonstrably
never engages overview selection). A one-pixel-per-tile destination is
an extreme downsample by construction, so GDAL's default automatic
overview selection (`-ovr AUTO`) would read average-filtered overviews,
biasing `minZ` up and `maxZ` down and blurring mask edges — defeating
the conservative range the store exists to provide. This holds for
whatever a pass reads: the source DEM, or any VRT over it that exposes
overview levels.

The intermediate output volume drops by `samplesPerTile²` relative to a
sub-tile sample grid (about four orders of magnitude for 129×129
samples). Source I/O and warp-kernel work remain `O(source pixels)` per
pass. For melown2015 at LOD 15, each leaf grid is 2¹⁴×2¹⁴ pixels; two
byte mask grids plus two 16-bit elevation grids are roughly 1.5 GiB,
large but inspectable flat rasters.

Then build coarser LODs bottom-up with no further source sampling. The
tool runs a 2×2 min/max mip loop over the leaf grids while emitting the
flag index and metanode store pages:

- existence: `parent = max(children)`; on 0/255 masks this is OR.
- watertight: `parent = min(children)`; on 0/255 masks this is AND.
- `minZ`: `parent = min(children)`.
- `maxZ`: `parent = max(children)`.

Do not delegate the bottom-up ascent to GDAL overviews. GDAL 3.4
`BuildOverviews` does not provide min/max resampling; min/max are warp
kernels here. The ascent is the same walk that writes the two artifacts,
so keeping it in the tiling tool is both simpler and testable.

**Value transform after aggregation.** The warp kernel and the mip loop
reduce *raw source* elevations. The resource's `heightFunction` and any
source→SDS vertical-datum conversion apply **after** aggregation, to the
two reduced numbers per tile, not to every source sample. Min and max
commute with a monotone height map, so applying `heightFunction`
post-aggregation gives the same range as applying it per sample; a
non-monotone function would instead need a pre-warp derived-band VRT. A
spatially varying vertical-datum conversion (geoid undulation across the
tile) commutes with min/max only approximately: either bound the
within-tile undulation variation against the `half` write bias —
expected sub-ulp at tile scales, verified in §9 — or apply the
conversion pre-warp via a derived band. The stored range is therefore in
the SDS frame §3.5 requires, produced without a per-sample SDS warp.

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

The rule is applied per warp pass. Mask min/max passes use no
`srcnodata`, and their destinations are initialized to 0 so cells
outside the source reduce to not-existing and not-watertight. Elevation
min/max passes set `srcnodata` so invalid elevation pixels cannot poison
the stored range.

### 4.4 What generation loses

- The per-tile per-LOD warp (replaced by four one-pixel-per-tile GDAL
  filter passes plus a bottom-up mip loop).
- The **min/max VRTWO pyramids**, at *both* build and serve time: the
  range is reduced by the GDAL filter passes, so the pre-built min/max
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
- Boundary / straddle semantics: whether a source pixel straddling a
  tile edge is counted by overlap or by center. This affects watertight
  exactly at tile edges; diff the leaf grids against a hand-reduced
  raster reference.
- Edge-shared samples: the pixel-per-tile warp partitions source pixels
  disjointly among tiles, while the serve-time warp samples
  corner-inclusive grids where adjacent tiles share edge samples. An
  extremum exactly on a tile edge can land in only one tile in the
  filter pass. The `half` write bias gives about one ulp of slack; the
  phase-5 parity gate must characterize the residual.
- Alpha-mask sources (`GMF_ALPHA`) need a threshold; DEMs are normally
  `GMF_NODATA` / `GMF_ALL_VALID`.
- Empty-region pruning: a full-extent leaf pass must recover the cheap
  ocean-skip the current descent gets for free (bound by source
  footprint and/or a coarse existence pre-pass).
- Overview selection disabled: confirm all four passes read the source
  at base resolution and never engage automatic overview selection, e.g.
  by diffing the leaf grids against a forced `-ovr NONE` run on the test
  dataset. At the extreme one-pixel-per-tile downsample ratio, automatic
  selection would silently read smoothed overviews instead of the base
  raster and erode the conservative range (§4.2).

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

   *Implemented (2026-06-12).* Harvested 848k nodes from warp-served
   v6 metatiles of viewfinder-dem1 (melown2015) and viewfinder-dem3
   (melown2015 + earth-qsc) — local viewfinder resources instead of
   the prescribed GLO-30 cuts, same mountainous/flat coverage. The
   analytic planar texel alone matches the warp value within ±0.5%
   (p5–p95) for lods >= 7 in both frames: the warp's own 8x8 sampling
   barely encodes relief, so the correction is nearly moot. Fitted
   `c` = 0.3–0.7 per frame with sub-percent effect; a single
   compiled-in `c = 0.5` is used. Zero monotonicity violations in
   848k descent pairs (true and derived): the delivery clamp is
   unnecessary; instead the serve path clamps relief/edge at 2 to
   contain source-data defects. Exit met.

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

   *Implemented (2026-06-12).* `mnstore` module
   (`mapproxy/src/mapproxy/support/mnstore.{hpp,cpp}`): paged,
   mmapped, directory-indexed; header carries format version,
   packaging, reference frame, source hash, pairing digest, geoidGrid
   and heightFunction; pages encode per-level local quadtrees with
   uniform-quadrant collapse (5-byte node payload, half height range
   biased outward). Surface-level `metaBinaryOrder`/`metaDepth` are
   parsed, persisted in tileset properties, advertised in mapConfig
   (vts-libs change) and validated — the v6 serve path refuses
   non-default packaging at resource load. `mapproxy-mnstore selftest`
   round-trips `(5, 1)` and `(2, 3)` packaging with payload equality
   across the shapes; rejection of mismatched pairing/packaging is
   enforced (and was exercised) by the serve-path open validation.
   Exit met. Format v2 (same day) switched the vertical datum to the
   geoid-shifted SDS; see the §8 phase-5 note and deviations.

3. **Unified tiling pass (§4).** Replace the per-tile per-LOD warp with
   four one-pixel-per-tile GDAL filter passes per reference-frame
   division node: mask min, mask max, elevation min, elevation max, with
   the §4.3 nodata rule applied per pass. Build coarser levels with the
   in-tool 2×2 min/max mip loop and emit both the flag index and the
   metanode store with one shared revision. Keep the old tiling tool
   available behind a flag for the parity diff. *Exit on the test
   dataset:* leaf grids diff cleanly against a hand-reduced raster
   reference; existence and watertight are **identical** to the old tool
   except for characterized edge-shared-sample residuals; height range
   matches the reference within tolerance; store pages are produced with
   the resource's effective packaging values; GDAL warp memory limits are
   respected; full-pair staging, validation, and atomic publish are
   exercised; §4.5 assumptions confirmed empirically.

   *Implemented (2026-06-12).* Unified pass
   (`mapproxy/src/tiling/unified.{hpp,cpp}`), the default
   `mapproxy-tiling` mode (`--legacy` keeps the old analysis). The
   four passes call GDAL's `GDALWarp()` utility API concurrently and
   report per-decile progress; libgeo's `warpInto` was abandoned
   after it degenerated at the one-pixel-per-tile ratio and proved
   able to silently substitute an averaging overview (deviation 3).
   On the 1.94 Gpx test sample: pass 56 s (legacy analysis: 14 min);
   tile-index parity against the legacy tool 0.38% (melown2015) /
   0.42% (earth-qsc), all residuals in two characterized,
   input-defensible classes (boundary tiles whose only data is an
   edge-shared sample — new pass stricter; watertight decided by the
   full footprint rather than 129x129 sampling — new pass more
   faithful); no navtile-only differences. Hand-reduction over source
   pixels confirms full-footprint min/max aggregation with
   outward-conservative edge inclusion. Exit met.

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

   *Implemented (2026-06-12).* Metanode-store mode is the DEM
   default (`--legacyTiling` keeps the three-pyramid path): normal
   `dem` VRTWO only, unified pass, paired atomic publish. End-to-end
   smoke test on a 1° cut: ~60 s from raw GeoTIFF to a resource
   auto-registered and serving metatiles from its store, mapConfig
   advertising `(5, 1)`, no `dem.min`/`dem.max` produced. Exit met.

5. **Serve from the store, with warp fallback (§7).** `SurfaceDem`
   reads the store and serialises v6; falls back to warp when absent.
   Run the parity gate: diff store-served vs. warp-served metatiles
   node-by-node on the test dataset. *Exit:* flags exact, range within
   `half` tolerance, extents difference characterised, revision mismatch
   forces fallback, monotonic texelSize clamp enabled, **no warp on the
   store path** (verify via timing and GDAL call counts).

   *Implemented (2026-06-12).* `metatileFromStore`
   (`generator/metatile-store.cpp`) + store open/validation in
   `SurfaceDem` (reference frame, packaging, geoidGrid,
   heightFunction, mask absence, pairing digest, and the
   delivery-index source digest of deviation 6); per-request fallback
   when the store cannot serve. Gate on the sample (92 metatiles, all
   lods, same delivery index): node sets and watertight flags
   identical, texelSize p50 0.06% / p95 ~1.1% relative difference,
   height ranges verified against hand-reduced source values (the
   warp's were outward-blurred by the min/max overview pyramids —
   deviation: the store range is the faithful one), surrogate and
   horizontal extents differ as designed. Pairing mismatch rejects
   the store at load with a clear log line and the resource serves by
   warp. Serve timing: store p50 25 ms / p90 37 ms vs warp p50
   695 ms / p90 1.18 s; no GDAL on the store path. With format v2
   the stored datum is the geoid-shifted (orthometric) SDS and the
   serializer adds the undulation at delivery from a per-block
   lattice sized by the geoid grid's own pixel pitch (block corners
   projected into the grid, footprint divided by the pitch; ranges
   widened by the within-cell undulation spread). Re-gated:
   identical results, p50 27 ms. Exit met.

6. **Retire the min/max pyramids (§4.4).** Drop the min and max overview
   generation from `generatevrtwo`; confirm no other consumer (§9).
   Confirm `mapproxy-setup-resource` does not request min/max overviews
   in metanode-store mode. *Exit:* a resource builds with the normal
   pyramid only and serves identical metatiles; VRTWO build time drops
   toward 1/3.

   *Implemented (2026-06-12).* The three-pyramid build was a usage
   pattern, not a `generatevrtwo` feature: `mapproxy-setup-resource`
   builds the normal pyramid only in metanode-store mode, and
   `SurfaceDem::prepare` requires `dem.min`/`dem.max` only when no
   valid store is attached (the §7.1 matrix; normal-only without a
   store fails resource preparation). Verified by the phase-4 smoke
   test (normal-only resource, store-served metatiles). Exit met.

7. **Planet-scale bring-up.** Build the store for a production-scale
   surface; measure store size against the §3.1 estimate, cold/warm
   serve latency against the warp baseline, and page-cache behaviour.
   *Exit:* serve latency in single-digit ms; store size and RSS within
   projection.

   *Implemented (2026-06-12).* Run on the global viewfinder-dem3
   (3 arcsec, ocean filled with orthometric 0 — the worst case for
   store size: every tile of every division-node square exists, 268M
   nodes in melown2015 incl. both polar caps, 33M in earth-qsc).
   Results, dev box (16 cores, 30 GB):

   - Generation: melown2015 52m47s (three division nodes; the legacy
     planetary tiling of the same dataset ran for days), earth-qsc
     62m56s (six faces serialized — the measured case for the
     deferred cross-node warp pooling, see backlog). One late lesson:
     a first run aborted at minute 44 on an unguarded polar
     conversion — atomic publish means a late crash costs the whole
     run; out-of-domain conversions are now contained, and streaming
     emission stays on the open list.
   - Store size: melown2015 752 MB / 262,148 pages (vs ~1.4 GB dense
     payload — the orthometric collapse carries the filled-ocean
     worst case; §3.1's land-only estimate assumed absent ocean),
     earth-qsc 66 MB / 32,773 pages (no cap-square overlap in QSC's
     clean partition). Flag tile indexes 29 KB / 42 KB.
   - Tile-index parity vs the legacy planetary tiling: melown2015
     residuals are (a) the barren node 1-1-1 quadrant — the legacy
     tool fake-watertighted it, the unified pass omits non-real
     division nodes entirely; serving-invisible since child flags are
     RF-validity-gated — and (b) ~1.1M navtile-band moves (0.3%)
     localized to the cap squares, the cap discs, and the
     antimeridian column. earth-qsc: 1.4%, almost entirely the
     navtile band, plus face-edge rows of the §4.5
     edge-shared-sample class.
   - Serve: warm p50 31 ms / p90 39 ms across lods 1-14 (94-metatile
     sweep), RSS 187 MB after the sweep against the 752 MB mmapped
     store. Global coarse metatiles (lods <= 5, one per planet each)
     initially served at 1.5-2 s — which turned out to be a silent
     per-request warp fallback, not store cost: per-node NodeInfo
     construction on constrained (polar) subtrees builds a fresh PROJ
     pipeline per node (~14 ms each, the constraint-sampler cache
     lives in the subtree instance), and the ancestor-derived
     replacement exposed a NodeInfo::child() throw on RF-invalid
     intermediate nodes that the block try/catch converted into warp
     fallback on every request. Fixed (deriveNodeInfo with invalidity
     short-circuit, shared by both serializers): global metatiles now
     ~230 ms under full tiling load (block-setup bound), deep
     metatiles unchanged. Single-digit-ms p50 is met for the deep
     lods that dominate traffic; the handful of global metatiles sit
     at ~0.2 s and are the first candidates for the (deferred)
     coarse-metatile output cache if that ever matters behind a CDN.
   - The dev server serves both frames of the planetary resource from
     the stores (the resource's dataset entry points at a local
     directory of symlinks into the shared 55 GB dataset; only the
     tiling/store artifacts are local). Exit met, with the
     single-digit-ms criterion met for deep lods and consciously
     relaxed for the ~7 global metatiles.

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

   *Implemented (2026-06-12).* The guide is
   [metanode-store-operations.md](metanode-store-operations.md),
   linked from [index.md](index.md) under integration guides:
   task-oriented (new dataset via `mapproxy-setup-resource` or the
   manual route; three-pyramid migration with the
   keep-min/max-until-verified rule; pairing and delivery-index
   re-prepare semantics; the §7.1 matrix; rollback as a pair-level
   operation; failure-mode log messages). Command names and artifact
   paths are the implemented ones, exercised in the phase-7
   planetary bring-up. Exit met — phases 1–8 are implemented; only
   the deferred client milestone (phase 9) remains.

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

   *Deferred as designed (2026-06-12).* The server-side prerequisites
   this item depends on are all in place (packaging advertised in
   mapConfig, store rebrickability proven, phase-7 planetary numbers
   measured). The milestone is recorded in [backlog.md](backlog.md)
   ("shallow-subtree metatile delivery") and awaits promotion to its
   own RFC; everything else here is out of scope by construction.

---

## 9. Verification and deferred work

- **GDAL resampling assumptions (§4.5).** The load-bearing claims;
  verify leaf grids on the test dataset in phase 3 before the serve path
  depends on them. Phase 5 parity characterizes the edge-shared-sample
  residual against the warp path.
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
  tiling pass applies `heightFunction` and any source→SDS datum
  conversion post-aggregation (§4.2), so the stored range lands in the
  SDS frame. Where a source→SDS conversion is spatially varying, bound
  the within-tile geoid-undulation variation against the `half` write
  bias to confirm the post-aggregation conversion stays sub-ulp at tile
  scales; otherwise move it pre-warp via a derived band. Confirm whether
  SDS and navSRS share the same vertical datum or require a geoid-grid
  shift at delivery. Spot-check that ocean/flat regions actually collapse
  in a built store. Confirm the "derive datum from the reference frame"
  rule carries to a non-Earth frame if one is ever configured.
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
| Per-tile per-LOD warp in `mapproxy-tiling` | GDAL filter passes + mip loop (§4) |
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

   *Implemented; later refined by round 4.* §4.2 now avoids a
   materialized native-resolution global grid by using one-pixel-per-tile
   GDAL filter passes at the analysis maximum LOD, under GDAL's warp
   memory budget, followed by an in-tool 2×2 min/max mip loop.

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

   *Implemented.* §4.2 now uses one-pixel-per-tile GDAL min/max filter
   passes instead of a custom native-resolution reducer. §4.3 states the
   per-pass nodata rules, §4.5 adds the edge-shared-sample parity risk,
   phase 3 validates leaf rasters and the in-tool 2×2 min/max mip loop,
   and the old round-1 response was marked as refined by this round. The
   `heightFunction` monotonicity rule is stated in round-5 note 2 below
   (§4.2 value-transform order, reconciled with §3.5). The full-footprint
   aggregation claim is the load-bearing §4.5 item, verified in phase 3.
   (Annotation moved below the full note per round-5 note 1; it
   previously split the constraint list.)

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

## Review round 5

The §4 rewrite is faithful where it was applied: the
one-pixel-per-tile filter passes, the per-pass nodata rules, the
edge-shared-sample item, the in-tool mip loop with the
`BuildOverviews` exclusion, and the phase-3 raster-reference exit all
match the round-4 note. The softened phase-3 flag-identity criterion
("identical except for characterized edge-shared-sample residuals")
is accepted: the disjoint pixel partition can legitimately differ
from the old tool's grid sampling exactly at edges, and the exit
still demands the residual be characterized rather than waved
through. Three notes; the first explains the second.

1. The round-4 response annotation was inserted into the middle of
   note 1, splitting its constraint list: the `*Implemented.*`
   paragraph sits between the edge-shared-samples bullet and the two
   bullets that follow it (`heightFunction`, full-footprint
   graduation). Move the annotation below the complete note text.
   The protocol point is not cosmetic — the two bullets below the
   insertion point were evidently never processed, which is note 2.

   *Implemented.* The round-4 note-1 annotation now sits below the full
   note, after the "Nothing outside §4 moves" paragraph; the
   `heightFunction` and full-footprint bullets are restored to the
   reviewer's contiguous constraint list above it. The annotation records
   that the previously-skipped `heightFunction` bullet is processed under
   note 2 here, and that the full-footprint bullet is the existing §4.5
   load-bearing item verified in phase 3.

2. The `heightFunction` constraint from round-4 note 1 is
   unaddressed, and the filter design makes it load-bearing. The
   warp kernel reduces **raw source values**; `heightFunction` and
   any vertical-datum conversion happen after aggregation, on two
   numbers per tile — but §3.5 still says "the tiling pass (§4) must
   reduce elevation in that same SDS frame", which described the old
   custom reducer and now contradicts §4.2. State the value-transform
   order explicitly:

   - The filter passes reduce raw source elevations.
   - `heightFunction` applies post-aggregation to the per-tile
     `{min, max}`. This is valid because min/max commute with
     monotone maps; state the monotonicity requirement, and note
     that a non-monotone function would force a pre-warp
     derived-band VRT.
   - A non-trivial source→SDS vertical-datum conversion is spatially
     varying and commutes with min/max only approximately. Either
     bound the within-tile undulation variation against the `half`
     write bias (expected sub-ulp at tile scales; verify in §9), or
     apply the conversion pre-warp via a derived band.
   - Reconcile the §3.5 sentence with this order.

   *Implemented.* §4.2 gains a "Value transform after aggregation"
   paragraph stating the order: the warp kernel and mip loop reduce raw
   source elevations, and `heightFunction` plus any source→SDS datum
   conversion apply post-aggregation to the per-tile `{min, max}`. It
   states the monotonicity requirement, names the pre-warp derived-band
   VRT as the non-monotone escape, and gives the spatially-varying datum
   conversion the same choice: bound the within-tile undulation against
   the `half` write bias, or move it pre-warp. §3.5's "must reduce
   elevation in that same SDS frame" sentence is rewritten to "the stored
   range must end up in that same SDS frame", matching the
   post-aggregation order. §9's vertical-datum item carries the
   undulation-bound verification.

3. New, surfaced by the filter design itself: **source overview
   selection must be disabled on the min/max passes.** GDAL's warp
   utilities select a source overview level automatically when the
   destination resolution is much coarser (`-ovr AUTO` is the
   gdalwarp default), and a one-pixel-per-tile destination is an
   extreme downsample by construction. Overviews are average-filtered
   (or otherwise smoothing): reading them biases `minZ` up and
   `maxZ` down, defeating the conservative range the store exists to
   provide, and blurs mask edges. §4.2 must state that all four
   passes read the base resolution with overview selection disabled
   (`-ovr NONE`, or an API path that demonstrably never engages
   overview selection), and §4.5 gains a verify item: confirm the
   implementation path hits base resolution, e.g. by diffing against
   a forced `-ovr NONE` run on the test dataset. This applies to
   whatever dataset the passes read — the source DEM or any
   VRT over it that exposes overview levels.

   *Implemented.* §4.2 now states that all four passes read the source at
   base resolution with overview selection disabled (`-ovr NONE`, or an
   API path that never engages overview selection), explaining that the
   extreme one-pixel-per-tile downsample would otherwise read
   average-filtered overviews and erode the conservative range. The
   statement covers the source DEM or any VRT over it that exposes
   overviews. §4.5 gains a verify item: confirm the implementation reads
   base resolution, e.g. by diffing the leaf grids against a forced
   `-ovr NONE` run on the test dataset.

## Review round 6 — sign-off

The design is accepted. All three round-5 dispositions are implemented
faithfully: the round-4 annotation sits below its complete note with
the constraint list restored; §4.2's "Value transform after
aggregation" paragraph states the raw-value reduction order, the
monotonicity requirement with its pre-warp derived-band escape, and
the bounded commutation of spatially varying datum conversions, with
§3.5 reconciled and §9 carrying the undulation-bound check; and the
overview-selection exclusion is stated in §4.2 with its §4.5
verification item. No notes remain open from any round; there are no
editorial leftovers.

What is being accepted: a paged, mmapped metanode store holding
`{mesh existence, watertight, minZ, maxZ}` per node in the reference
frame's orthometric public-SRS vertical; all other metanode fields
derived at delivery (midpoint surrogate, full-cell extents, a
calibrated and clamp-guarded texelSize heuristic measured first);
generation as four one-pixel-per-tile GDAL filter passes at base
resolution plus an in-tool 2×2 min/max mip loop that emits the flag
index and store pages as one atomically published, pairing-bound
artifact set, with `heightFunction` and datum conversion applied
post-aggregation; serve from the store with warp fallback, gated by
node-level v6 parity; min/max VRTWO pyramids retired and
`mapproxy-setup-resource` building normal-only in metanode-store
mode; metatile packaging parameterized as per-surface
`(metaBinaryOrder, metaDepth)` with effective `(5, 1)` mandatory for
current clients, rebrickability proven in validation, and client
consumption plus operator repackaging deferred to a later RFC.

The two for-the-record observations in round 4 (the stored
surface-area channel as the texelSize escape hatch; the client
milestone opening as its own RFC on phase-7 numbers) remain recorded
and non-blocking.

The status line moves to Accepted. Implementation starts with the
phase-1 texelSize calibration spike.

---

## Implementation notes (2026-06-12)

Implemented on `feature/metanode-store` (cartolina-tileserver; the
mapConfig/properties additions on the same-named vts-libs branch; the
wiki on the same-named cartolina-js branch). The accepted design text
is unchanged. **Per-phase results and exit status live as
`*Implemented.*` annotations inside the §8 plan**; this section keeps
what cuts across phases: the deviations the implementation forced
(with the evidence that forced them), findings about the data, and
open items.

### Deviations from the accepted text

1. **The v6 wire format is raw-SDS (ellipsoidal); delivery converts
   from the orthometric store.** §3.5 assumes the v6 metatile
   serializes orthometric SDS heights. Empirically false:
   `geomExtents.z` passes through `sdsg2sdsr` (geoid-shifted SDS →
   raw SDS), so serialized heights are ellipsoidal — verified on
   Adriatic sea-level tiles, which carry minZ ≈ +44 m, the EGM96
   undulation. The store keeps the orthometric values §3.5 designed
   (so flat water collapses) and the v6 serializer adds the geoid
   undulation at delivery; mechanics and history in the datum
   addendum below. (The implementation initially stored the raw-SDS
   values verbatim, trading collapse for a conversion-free delivery;
   review feedback on filled-ocean datasets overturned that the same
   day.)
2. **Generation does no datum conversion.** A consequence of the
   orthometric store: the unified pass stores `heightFunction(source)`
   values directly, and §4.2's source→SDS datum-conversion step has
   nothing to do at tiling time — the geoid shift happens once, at
   delivery (addendum below). The monotone-`heightFunction`
   requirement of §4.2 still applies and is enforced
   post-aggregation per leaf tile.
3. **The filter passes call GDAL's `GDALWarp()` utility API, not
   libgeo's `warpInto`.** Two empirical reasons. (a) libgeo's warp
   wrapper degenerates at the extreme one-pixel-per-tile downsample:
   a single mask pass burned 35+ minutes of CPU with zero source
   I/O, while the equivalent `gdalwarp` invocation finishes in
   seconds (the time disappears in per-chunk setup, not in
   reduction). (b) Correctness: libgeo's `safeChunks` logic may
   silently replace a forced-original source with an (averaging)
   overview to meet the memory budget — precisely the bias §4.2's
   `-ovr NONE` requirement exists to prevent. The GDALWarp-based
   passes force `-ovr NONE`, use the warp kernels for the entire
   reduction, and complete all four passes over the 1.94 Gpx test
   sample in ~2.5 min.
4. **No `-dstnodata` on the mask passes.** GDAL nudges valid computed
   values that collide with the destination nodata (a reduced mask 0
   became 1, turning the whole source rectangle "existing").
   Destinations are initialized via `INIT_DEST=0` instead; the
   elevation passes keep a `-1e6` sentinel that cannot collide with
   real heights. This sharpens §4.3's per-band nodata rule.
5. **Child flags come from the paired flag index, not store tree
   structure.** §3.2 derives child existence "from tree structure";
   the serve path keeps the existing `validSubtree` queries against
   the (paired) delivery index, exactly as the warp path does. This
   avoids extra page reads, but does not materialize the bottom-up-closed
   delivery hierarchy required by `skipPartial`; item 11 records that
   post-review gap.
6. **Pairing also covers the derived delivery index.** The §7
   pairing digest binds store ↔ tiling file, but mapproxy serves
   flags from `delivery.index`, a cached artifact derived from the
   tiling file at prepare time — and a resource whose tiling was
   regenerated without a definition change keeps serving the stale
   cache (pre-existing mapproxy behavior). That allowed a new store
   to pair with an old delivery index, exactly the §7 hazard, while
   both pairing checks passed. The prepare step now records the
   tiling digest in `delivery.index.src`, and the store is used only
   when that record equals the store pairing; otherwise the resource
   logs and falls back to warp until re-prepared.
7. **navtile flag replication.** The tiling file's navtile bit is the
   legacy tool's "no native-resolution warp on the ancestor path"
   rule. The unified pass reproduces it analytically: the bit is set
   while a `tileSampling`-per-tile warp at that lod still samples
   coarser than the source (truescale < 1, evaluated per tile center
   with the same source-pixel-step measure libgeo uses). The sample
   parity diff shows no navtile-only differences in either frame.
8. **Store header carries `geoidGrid` and `heightFunction`.** §7's
   source hash is opaque to the server (it cannot reconstruct the
   tiling tool's inputs), so the two value-affecting resource settings
   are stored explicitly and compared against the resource definition
   at load; mismatch rejects the store.
9. **Masked resources fall back.** A resource with a mask tree never
   uses the store (the store would have to bake the mask to stay
   consistent); the warp path is unchanged. Lift when needed by
   teaching the unified pass to apply the mask.
10. **Page encoding detail.** Pages encode each level grid as a
    DFS tag stream (empty / uniform-payload / internal quadrants)
    without jump tables: the serve path always decodes the whole page,
    so random in-page access is not needed. metaDepth > 1 pages store
    their levels as consecutive level grids (each a collapsed 2D
    quadtree) rather than interleaved subtree DFS; payload identity
    across packagings is covered by the selftest.
11. **Raw coverage vs delivery flags.** The store byte described in
    §3.1 as mesh/watertight flags is raw source coverage with three
    states: `none`, `partial`, and `full`. The paired tile index is the
    policy-applied delivery view: mesh, watertight, navtile, and reachable
    subtrees used to build client metanodes. This distinction became
    load-bearing with `skipPartial`: suppression clears the delivery-index
    entry while the store retains `partial`, allowing offline reflagging to
    restore the mesh without another source warp. Pruning removes the raw
    store node and therefore remains irreversible. The terminology changed
    from `NodeData::flags` to `NodeData::coverage`; byte values and store
    format are unchanged. Post-implementation review found that suppression
    still needs a bottom-up closure pass during tiling and reflagging: retain
    a geometry-less structural node only while it leads to deeper geometry,
    remove geometry-less leaves, and propagate their removal upward. Until
    that is implemented, `skipPartial` is not safe for client delivery.

    *Superseded (2026-07-03).* The closure concern was resolved without a
    materialized closure: metatile child flags are derived from the
    delivery index per request (`validSubtree`), which never advertises
    an all-zero subtree, so a suppressed branch with no geometry below is
    unreachable by construction. A subsequent architecture review then
    overturned the raw-vs-delivery framing itself — the coverage byte was
    scrubbed and the store reframed as a pure height sidecar. See the
    2026-07-03 addendum below.

### §9 verification checklist — disposition

- **GDAL resampling assumptions (§4.5)** — verified in phase 3:
  full-footprint min/max aggregation confirmed by hand-reduction over
  source pixels (edge pixels included by overlap, outward bias only);
  base-resolution reads enforced by `-ovr NONE` through the GDALWarp
  utility API; boundary/edge-shared-sample residuals characterized in
  the tile-index parity diffs (sample and planetary).
- **min/max pyramid consumers (§4.4)** — confirmed: meshes use
  `demOptimal` and navtiles `dem` on the normal pyramid; the only
  min/max consumer is the `valueMinMax` metatile warp (now the
  fallback). `mapproxy-setup-resource` builds normal-only in store
  mode; the phase-4 smoke test served a normal-only resource end to
  end.
- **texelSize drift (§5.2)** — measured in phase 1 (±0.5% p5–p95 at
  operative lods, both frames); zero monotonicity violations in 848k
  descent pairs, so no delivery clamp; a relief-ratio clamp guards
  against source-data defects instead.
- **Surrogate fidelity** — midpoint vs sampled mean characterized in
  the phase-5 value diff; no consumer regression expected (cartolina-js
  reads `minZ`).
- **Packaging parameters** — non-default packaging round-trip and
  payload equality proven by `mapproxy-mnstore selftest`; phase-7
  profiles (page counts, store sizes, latency, RSS) recorded for the
  client milestone's `metaDepth` choice.
- **Vertical datum (§3.5)** — the premise was empirically overturned
  (v6 serializes raw-SDS heights; verified on sea-level tiles) and
  the store went through verbatim-raw to orthometric v2 (deviations
  1–2 and the addendum). Ocean/flat collapse verified at planet scale
  (752 MB vs ~1.4 GB dense on a filled planet). SDS-vs-nav: the
  navtile range uses the geoid-shifted-SDS-to-navigation convertor,
  the warp path's own conversion. Deviation: the store datum is the
  resource `geoidGrid`, not the reference-frame public SRS vertical;
  a non-Earth frame remains unverified (no non-Earth metanode-store
  resource configured yet — note `mars-mola-dem` as a candidate).
- **Artifact consistency** — pairing-mismatch rejection verified live
  (store ignored with a logged reason, warp fallback served);
  temp-write/fsync/rename publication implemented in
  `publishUnified` and exercised by every tiling run; the
  delivery-index source digest closes the cached-derived-artifact
  gap (deviation 6).
- **Setup-tool integration** — phase-4 smoke test: same artifacts and
  metadata as the lower-level commands, resource served from its
  store; legacy path behind `--legacyTiling`.
- **Migration guide** — published after the tooling
  ([metanode-store-operations.md](metanode-store-operations.md)),
  using implemented names and paths.
- **`half` precision** — outward bias implemented in the writer and
  checked by the selftest; phase-5 diffs confirm stored ranges are
  conservative within tolerance.
- **Non-DEM surfaces** — untouched by code inspection (spheroid and
  geodata generators have no store path; the added packaging
  validation is the only change); their serve paths are unchanged.

### Findings and watch items

- **NodeInfo construction cost on constrained subtrees.** A
  from-scratch `vts::NodeInfo` on a subtree with extra constraints
  (melown2015 polar caps) builds a fresh PROJ pipeline for the
  constraint sampler — ~14 ms per construction. Anything that
  constructs node infos per tile (the `vts` CLI metatile dump, the
  old per-node serializer code) crawls on cap-covering metatiles.
  The serializers now derive node infos from the block ancestor
  (`deriveNodeInfo`), which shares the sampler; the vts-libs-level
  fix (caching the sampler per subtree *node* rather than per
  instance) is a candidate upstream improvement.

- **Source voids with the wrong sentinel.** A few adjacent sample
  tiles contain pixels valued -32767 — one above the declared nodata
  of -32768 — i.e. residual voids written with the wrong sentinel (a
  known Viewfinder Panoramas wart; GDAL's exact-match nodata masking
  passes them as valid heights). Both serve paths ingest them
  identically (the backlog's "nodata sentinel poisons coarse ranges"
  bug); the serve-time relief-ratio clamp keeps them from inflating
  texelSize. The real fix is dataset hygiene.
- **Mesh overshoot vs the exact range.** The store range equals the
  true per-tile source range (hand-verified); the legacy warp ranges
  were wider because they sampled the min/max overview pyramids,
  whose pixels aggregate beyond the tile. Cubicspline mesh
  interpolation may overshoot the exact source range by more than the
  half-ulp slack on sharp relief — monitor, and widen the write-time
  bias if it ever bites.

### Open items / follow-ups

- Streaming page emission: the unified pass currently collects all
  store pages in memory before publishing; fine at the measured
  scales, worth revisiting if memory ever binds on larger-than-planet
  jobs. (The four filter passes already run concurrently with
  per-decile progress.)
- Phase 7 (planet-scale bring-up) is being measured; phase 8 (the
  operator migration guide) is unwritten — command names and artifact
  paths are stable now.
- Masked resources (resource `mask` set) fall back to the warp path;
  teaching the unified pass to bake the mask would lift that.
- The legacy `viewfinder-dem1-sample` baseline tiling files are kept
  as `tiling-legacy.<rf>` beside the promoted unified artifacts.

### Addendum (2026-06-12, post-review): orthometric store (format v2)

Review feedback on these notes overturned the raw-SDS storage
decision (deviations 1-2 above): on a production planet the ocean is
not absent but *filled* with orthometric 0, so raw-SDS storage bakes
the smoothly varying undulation into every ocean tile and defeats
both the horizontal and the within-page collapse — a latent GiB-scale
inflation. The store (format v2) now keeps the **geoid-shifted
(orthometric) SDS vertical** declared by the header's `geoidGrid`, as
§3.5 originally designed:

- Generation does **no datum conversion at all** (deviation 2 is
  void): the unified pass stores `heightFunction(source)` values
  directly, which also removes two convertor calls per leaf tile.
- The v6 serializer shifts to the raw-SDS vertical at delivery by
  adding the geoid undulation, sampled on a per-block lattice whose
  density follows the geoid grid itself: the block corners are
  projected into the grid's CRS, the bounding-box span is divided by
  the grid's sample pitch (read once from the grid file's GDAL
  metadata; 0.25 deg fallback), and the lattice lands at or below
  grid-sample spacing — interpolating between lattice nodes is then
  as faithful as evaluating the (itself grid-interpolated) undulation
  per node. The density is capped at 65x65; only the few coarsest
  metatiles hit the cap, with meters of residual against
  kilometer-scale ranges. The delivered range is widened by the
  within-cell undulation spread (cell-corner bilinear plus interior
  lattice nodes) so it still covers the mesh, which samples the
  undulation per vertex. The navtile height range uses the
  geoid-shifted-SDS-to-navigation convertor at the cell center — the
  warp path's own conversion.
- Verified on the sample: ocean tiles store exactly `(0, 0)` (and
  collapse), serialized v6 values reproduce the warp's undulation
  range within ~0.15 m; the full serve gate is unchanged (node sets
  and watertight identical, texelSize p95 ~1%, p50 27 ms, no
  fallbacks). Store sizes shrank 6-7.6% even on the mostly-land
  sample (melown2015 2.20 -> 2.07 MB, earth-qsc 5.28 -> 4.88 MB);
  the structural win is on filled-ocean planets.
- v1 stores are rejected by the version check and fall back to the
  warp path; the pairing digests are unaffected (the flag tile index
  does not depend on the datum and the tiling output is
  deterministic).

For the deferred v7 milestone this also frames the wire question: a
v7 metatile could carry orthometric heights verbatim plus the four
corner undulations of the metatile (~16 bytes), letting the client do
the same bilinear shift for free instead of shipping a geoid grid;
keeping the wire ellipsoidal remains the zero-client-cost
alternative. Decide there.

### Addendum (2026-07-03): the store is a height sidecar

RFC 7 deliberately stored mesh and watertight beside heights while
retaining the existing flag index; review recognized the resulting
two-authority risk and added pairing. The implementation nevertheless
sourced delivered flags and child existence from the paired index from
the day it landed, so serving never read the store's partial/full
distinction. `--reflag` later became the distinction's only functional
reader, but the unified pass had made the re-tile it saves cheap
(~1 h planetary), and that marginal feature did not justify the
duplicate semantics. The following contract supersedes the original
§3.1 design and deviation 11:

> The flag tile index is the sole authority for tile existence and
> delivered flags; the metanode store carries, for every node the index
> serves, the source height range over its cell — including
> geometry-less structural nodes under `skipPartial`, whose range bounds
> every descendant mesh.

The semantic scrub is format-neutral (still v2):

- `NodeData::Coverage` is deleted from the code. The byte remains in
  the v2 payload as a reserved constant — nonzero, because pre-scrub
  readers test its truthiness as payload presence — and is ignored on
  read; node presence is defined by the page codec's quadrant tags.
  Dropping the byte (4-byte payload) is deferred until an actual
  store-format change, recorded in the tileserver backlog ("make the
  metanode store a pure height sidecar"). The shallow-subtree v7 wire
  format does not itself force a store-format change.
- The unified pass emits store payload for exactly the index-reachable
  set (one reachability bit propagated up the mip ascent): a suppressed
  tile with no geometry below is written to neither artifact, closing
  the store side of the deviation-11 concern; the delivery side needs
  no materialized closure because child flags are a serve-time
  derivation over the index.
- `--reflag` is deleted; changing `skipPartial` or prune policy means
  re-tiling. `mapproxy-mnstore check` now verifies the pair: pairing
  digest, payload ↔ index-reachability agreement in both directions,
  parent-range containment, and the prune sibling rule.

Verified on the RFC sample: a re-tiled pair has identical height
payload and pairing to the pre-scrub artifacts (tile-index diff clean,
node dump diff clean, same pairing digest), the tested pre-scrub
ordinary stores pass the new check unchanged, a new `skipPartial` pair
passes with the narrowed node set, and the serve gate is unchanged
(store-served metatiles, no warp fallbacks). Old and new servers can
serve both pre-scrub and post-scrub v2 stores; post-scrub stores do not
preserve the deleted old-tool `--reflag` semantics. No re-tiles are
required for serving. The new checker validates the post-scrub node-set
contract, so a pre-scrub `skipPartial` store can report now-inert surplus
payload.

### Addendum (2026-07-05): packaging is not a resource-definition option

Phase 2 added surface-level `metaBinaryOrder`/`metaDepth` settings to the
tileserver resource definition, per §6's "surface definitions are the
right ownership boundary". The *ownership* conclusion stands — packaging
is per-surface — but the resource *definition* is the wrong vehicle, for
the same reason the tiling `gsd` is a tool parameter and not a definition
field: packaging is fixed at tiling/repackaging time, and the resource
definition is consumed at serve time, after the store exists. A serve-time
knob cannot change a store that is already bricked; it can only agree with
it or be rejected.

The options were in fact inert. The serve/emit path addresses metatiles by
`referenceFrame().metaBinaryOrder` directly (index build, `metaId` masking,
`vts::MetaTile` construction); the store page codec reads packaging from its
own header; and `checkPackaging()` threw unless the effective values equalled
`(referenceFrame order, 1)`. The definition override reached nothing but the
mapConfig advertisement and the store-header value written during the same
generation run — and could only ever be `(5, 1)`.

Resolution: the surface-definition `metaBinaryOrder`/`metaDepth` options are
removed. Effective packaging is now the reference-frame order and depth 1;
mapConfig advertises those, and the store header records them. The store
header remains the authority (§7) and already carries the values. When the
client shallow-subtree milestone genuinely needs non-default packaging, it
is reintroduced as a **tiling-time parameter stamped into the store header**,
with serving and mapConfig advertisement sourced from that header — not from
a serve-time resource-definition field. Recorded in the tileserver backlog.
This supersedes the phase-2 resource-parser plumbing in §6.
