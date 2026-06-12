# Task backlog

## CLIENT/FOLLOW-UP: replace hardcoded metatile aggregation order

**Opened:** 2026-06-12
**Status:** open — depends on RFC 7 implementation and client
surface-packaging support
**Related:** [rfc-metanode-store.md](rfc-metanode-store.md),
[surface-metatile.md](surface-metatile.md)

Current cartolina-js does not consume configured metatile packaging
values. Terrain metatile fetches use a literal aggregation order 5 in
`src/core/map/surface-tile.js`; bound-layer texture metatiles use a
literal order 8 in `src/core/map/texture.js`. Parsed reference-frame
and surface `metaBinaryOrder` values are currently dead.

This item has no standalone meaning before RFC 7 is implemented: the
server must first advertise effective surface packaging values in
mapConfig, validate them against metanode-store artifacts, and keep
current datasets on effective `(metaBinaryOrder = 5, metaDepth = 1)`.
After that exists, the later client packaging milestone must replace the
literals with effective per-surface values from mapConfig, add
compatibility checks, and ship the operator rebrick tool used to migrate
existing metanode-store datasets to new `metaBinaryOrder`/`metaDepth`
values.

---

## CLIENT/REDESIGN: shallow-subtree metatile delivery (awaits RFC promotion)

**Opened:** 2026-06-12
**Status:** open — awaiting promotion to its own RFC, per RFC 7 §8
phase 9 and the round-2 review disposition.
**Related:** [rfc-metanode-store.md](rfc-metanode-store.md);
"replace hardcoded metatile aggregation order" above (one ingredient
of this milestone).

The deferred client milestone of RFC 7: replace single-LOD metatile
blocks with shallow-subtree delivery to cut the metatile descent
ping-pong (a LOD-15 descent: ~16 fetch phases to ~4 at
`metaDepth = 4`). Scope when taken up: teach cartolina-js to read the
mapConfig `metaBinaryOrder`/`metaDepth` (advertised by the server
since RFC 7), replace the hardcoded terrain and bound-layer orders,
define the multi-LOD metatile binary (a v7 break), trim the dead v6
fields, ship the operator packaging-rebrick tool, and choose the
default `metaDepth` from measurements. The decision inputs RFC 7
promised now exist: the phase-7 planetary numbers (store sizes, page
counts, serve latency, RSS) are in the RFC implementation notes, and
the store payload is proven rebrickable across packaging shapes by
the `mapproxy-mnstore` selftest. The v7 wire format should also
settle the vertical-datum question recorded in the RFC's orthometric
addendum: orthometric heights plus per-metatile corner undulations
(~16 bytes) would let the client do the bilinear shift for free,
versus keeping the wire ellipsoidal at zero client cost.

---

## FEATURE: recover from WebGL context loss

**Opened:** 2026-06-10
**Status:** promoted to
[RFC 8](rfc-context-loss-recovery.md) on 2026-06-11

After a context loss the map stays blank permanently;
`contextRestored()` only fires an event. Design and implementation
plan live in the RFC.

## BUG/DESIGN: coverage-aware point terrain queries

**Opened:** 2026-06-08
**Status:** open — front-to-back point queries need an ownership rule
**Related:** [rfc-draw-traversal.md](rfc-draw-traversal.md),
[nav-tiles.md](nav-tiles.md),
[surface-metatile.md](surface-metatile.md)

### Symptom

`MapMeasure.getSurfaceHeight()` and `getSurfaceHeightNodeOnly()` query
the recursive path's per-surface helper trees front-to-back and return
the first tree that yields a navtile or metanode. That is safe when the
front surface fully owns the coordinate, but partial front-surface tiles
can carry data while not covering every point in the tile. In that case
a point query can stop on a partial front surface where rendering would
use a lower-priority back surface for the visible terrain.

Affected callers include camera float-height navigation, `fix`/`float`
coordinate conversion, public terrain-height queries, hit-coordinate
conversion to `float`, and geodata draping through
`geodata.processHeights()`.

### Direction

Point terrain queries should use a coverage-aware ownership rule that
matches the recursive terrain traversal closely enough for navigation
and draping. A likely rule is to prefer the first front-to-back surface
with a watertight owner along the coordinate path, treating
non-watertight hits as provisional. This may choose a coarser back
surface at dataset fringes, but avoids treating a partial front tile as
complete terrain.

The rule cannot require a watertight flag unconditionally. Before
metatile v6 the watertight bitplane is absent, so all client-visible
watertight checks are generally false. A v6-only rule would make point
queries fail or always fall through on older configurations. The
implementation must define fallback semantics for pre-v6 data, for
single-surface maps, and for datasets that do not yet encode watertight
coverage.

### Open questions

- Whether an ancestor watertight claim is enough to stop lower-priority
  surfaces for the coordinate, mirroring traversal deactivation.
- Whether a non-watertight front hit should be returned when no
  watertight surface exists, or only for APIs that prefer availability
  over strict ownership.
- How to distinguish "watertight information unavailable" from "known
  non-watertight" in query code without regressing pre-v6 maps.
- Whether point-query diagnostics should report the selected surface id,
  tile id, and ownership reason during regression tests.

---

## DATA/TOOLS: viewfinder-dem1 poisoned coarse navtiles + navtile-less LOD band

**Opened:** 2026-06-07
**Status:** open — fix lives in vts-tools / vts-libs, not cartolina-js
**Related:** [nav-tiles.md](nav-tiles.md),
[tile-index.md](tile-index.md),
[tileserver-metatile-production.md](tileserver-metatile-production.md)

### Symptom

On `viewfinder-dem1`, resolving a `float` camera position to a fixed
terrain height returns a garbage altitude (~32696 m ASL) instead of the
real value (~1103 m near Mt Etna). The client reads the stored data
faithfully — this is a data defect in the bottom-up-rebuilt tileset, not
a cartolina-js bug. No client change is warranted.

### Reproduction

Single-surface dem1, with a `float` camera position near Mt Etna
(15.051301, 37.768294), resolves to `fix,32695.89,…` in BOTH `recursive`
and `legacy` traversal modes — confirming the defect is in the data, not
the recursive path.

Two-surface `viewfinder13.json` (dem3 back, dem1 front) made it look
like a recursive-vs-legacy regression: recursive returns dem1's garbage
(the front surface wins the front-to-back height query), legacy walks
one merged tree and lands on dem3's good node (~1103 m). It is not a
client regression — just dem1's frontmost data being read honestly.

### Root cause (two independent defects, both in the rebuild)

dem1's source tileset is lod 13–15 only (lodRange [13,15]); the
mapproxy-store version (lodRange [1,15]) had coarse LODs 1–12 generated
bottom-up.

1. **Coarse navtile height ranges are poisoned by the int16 nodata
   sentinel.** ~20 coarse/edge navtile nodes carry int16-saturated,
   often inverted ranges. The root `[1,0,0]` stores `minHeight=32725`,
   `maxHeight=32667` (inverted; raw bytes `D5 7F 9B 7F` at file offset
   0x3F of `1-0-0.meta` — stored, not a parse error; dem3 parses to sane
   ranges like -48/3356). When coarse navtiles are aggregated over
   mostly-empty area, the ~±32767/32768 nodata value is not masked out of
   the height-range computation. The navtile pixel itself is normal
   (~128/255), so the bad min/max maps it to ~32696 m. The range comes
   from `opencv::NavTile::heightRange()` over coverage-white pixels, with
   `InvalidHeight = -FLT_MAX` (heightmap.hpp) and an unclamped
   float→int16 cast.

2. **A navtile-less coarse LOD band prevents correction.** The metanode
   TREE has no holes: along the descent to real data (Etna 15.05E
   37.77N: `1-0-0, 2-1-0, 3-2-1, 4-4-3, 5-8-6, 6-17-12, 7-34-24…`) the
   intermediate nodes (2,1,0)..(6,17,12) exist as content-less ROUTING
   nodes (geometry bit clear, navtile bit clear, child bits intact,
   minH=1/maxH=0 = the no-navtile sentinel); the renderer descends
   through them fine. What is missing is navtile (and mesh) CONTENT at
   lod 2–6. `vts --complete-tileindex-up`
   (vts-libs `tools/vts.cpp:2990`, `VtsStorage::completeTileindexUp`)
   sets `mesh|navtile` only where coarsened coverage clears
   `meshThreshold = K/8`; a point-like data region is sub-1/8 of a coarse
   tile, so its mid-LOD ancestors stay routing-only.

   The height query asks for a coarse LOD (~5; camera ~52 km). From the
   root down to that LOD the ONLY navtile is the poisoned root (lod 1) —
   the correct navtiles start at lod 7, finer than `desiredLod`, so
   `MapSurfaceTree.traceHeightTileByMap`'s
   `id[0] > desiredLod && heightMap` guard stops before reaching them.
   dem3 navigates fine because its pyramid carries a navtile at every LOD
   (it resolves cleanly at lod 5).

### Where to fix (vts-tools / vts-libs)

Both are needed for dem1 to navigate correctly; they are independent
(fixing only one leaves the other symptom):

- **Bottom-up pass (`completeTileindexUp`)** — must produce a complete,
  walkable navtile pyramid: do not leave a navtile-less band above real
  data. Either do not gate `navtile` on the `K/8` coverage threshold
  (mark/generate a coarse navtile on every routing ancestor of real
  data), or otherwise guarantee a coarse height overview exists at each
  LOD down the chain.
- **Coarse navtile generation** — must honor nodata: mask the int16
  sentinel before computing the height range, so generated coarse
  navtiles are not saturated/inverted.

### Verification

- `vts --tileindex-info <ts>/tileset.index --tileId L-X-Y` (tileId
  format `L-X-Y`) shows `mesh,navtile` present at lod 1 and lod 7+ but
  absent at lod 2–6 along the Etna path.
- Decoding `.meta` files shows the poisoned ranges at coarse/edge nodes
  (root 32725/32667).
- After the fix, the single-surface dem1 reproduction URL must resolve
  `float` to ~1103 m, and `vts` must report a navtile at every LOD down
  the Etna path with sane ranges.
- `vts` subcommands used: `tileindex-info`, `tile-info`,
  `dump-navtile`, `query-navtile`.

---


## REFACTOR/PERF: split tile rendering execution out of `TileRenderRig`

**Opened:** 2026-06-06
**Status:** deferred
**Related:** [rendering-architecture.md](rendering-architecture.md)

### Motivation

`src/core/map/tile-render-rig.ts` is built around the style layer model.
That model should stay: it is the style-era terrain composition model,
and the rig already does useful tile-local work. It owns the tile and
submesh resource references, builds the prepared layer stack, tracks
essential vs optional readiness, supports fallback readiness, collapses
normal/bump layers when possible, and reports active layer IDs for
credits.

The problem is narrower: the rig also owns backend execution. Its
`draw()`, `drawDepth()`, `footprint()`, layer UBO encoding, texture-unit
binding, mask binding, and GLSL program selection make the tile resource
object the WebGL renderer for terrain. That couples the map/style data
model to the current WebGL execution strategy.

The current color path renders the prepared layer stack through one
large tile shader. That shader behaves like a small layer interpreter:
it loops over encoded layer records, branches on source/target/operation
types, reads sampler indices from the UBO, maintains shader-side stacks,
and applies shading, masks, atmosphere, and render flags in one pass.

This may be a performance problem. The working hypothesis is that the
"one pass is always better than many passes" assumption does not hold
for this terrain workload once the single pass becomes a large dynamic
shader. The old terrain path used simpler draw calls per layer and was
faster in comparable scenes, but that is not yet proof that pass count
is the cause: the old path also used simpler shaders, compile-time
variants, and different material logic. A dedicated A/B measurement is
needed.

This is not part of the legacy map draw-path replacement, which is
already underway as a separate cleanup track. It is a later renderer
architecture task for the terrain path after the current traversal and
draw-path work has settled.

The extensibility problem is clearer. Future terrain layer types will
not all fit naturally inside one tile fragment shader:

- vector layers may rasterize waterways or other features before a
  later specular or compositing pass reads the result;
- land-cover layers may classify texture values into styled RGB or masks;
- future analytical or generated layers may produce intermediate scalar,
  color, normal, or mask textures before they affect final terrain color.

Adding each layer type to the monolithic tile shader would grow the
shader into a renderer-specific layer VM. It would also make a later
WebGPU backend harder, because the style model and the WebGL execution
model would remain fused.

### Goals

- Keep `TileRenderRig` as the tile/submesh resource holder and readiness
  planner.
- Move backend execution out of the rig into renderer-owned terrain tile
  rendering code.
- Treat multipass rendering as the baseline execution model to test:
  a style layer or layer operation may emit one or more render passes.
- Preserve `TileRenderRig`'s existing layer/resource optimization role:
  skipping covered layers, collapsing normal/bump work, and deciding
  which prepared layers belong in the render plan remain rig work.
- Let the renderer execute that prepared plan with backend-specific draw
  code and specialized shaders.
- Make intermediate render products explicit: color, normal, scalar,
  mask, or tile-local textures can be produced and consumed by later
  passes.
- Separate the prepared map/style model from WebGL-specific details so a
  future backend can map the same render plan to a different execution
  API.

### Suggested API shape

Do not expose the rig's mutable internal layer array directly. Add a
narrow read API that returns a prepared render description for the
requested readiness level, e.g.:

```ts
rig.layersForRender(readiness): readonly TileRenderRig.PreparedLayer[]
```

The returned data should describe what is ready to draw, not how WebGL
binds it. It can include the prepared layer records, resource handles,
texture transforms, active render flags, watertight/opacity facts, and
the submesh resource needed by the backend. The shape should be narrow
enough that the renderer cannot mutate rig state by accident.

Renderer-owned code then consumes the rig:

```ts
renderer.terrainTiles.drawRig(rig, {
    cameraPos,
    target,
    maskTexture,
    pass: 'color' | 'depth' | 'footprint',
});
```

The exact class names are open. Possible layers of ownership:

- `TileRenderRig`: tile/submesh resources, prepared stack, readiness,
  rig-local preprocessing such as normal collapse.
- `TileRenderer`: turns a ready rig or render plan into terrain passes for 
  color, depth, mask, and footprint.
- WebGL backend helpers: own GLSL programs, framebuffer/render-target
  operations, blend state, texture units, UBO/uniform packing, and draw
  calls.

During migration, `TileRenderRig.draw()` can remain as a compatibility
shim that delegates to the renderer. The traversal can later call the
renderer directly once the new boundary is stable.

### Suggested execution direction

The candidate rendering model is multipass-first:

- `blend` operations use fixed-function blending where possible;
- `push` operations can render into an independent intermediate target;
- `pop` sources can bind a prior intermediate texture;
- layer-specific renderers can produce tile-local textures for later
  layers;
- depth and footprint passes remain specialized paths rather than
  variants of the full color shader;
- optimization may fuse adjacent compatible passes or substitute a
  specialized fast path for common simple stacks.

This is not yet an RFC-level design. Open questions include target
allocation, tile-local texture lifetime, pass sorting constraints,
interaction with traversal masks, interaction with atmosphere/shadows,
where normal collapse belongs after the executor split, and how much
state should be represented as an explicit pass graph.

### Measurement plan

Start with a flag-gated experimental path for a small current subset,
for example constants, diffuse texture layers, and simple shading.
Compare it with the current monolithic rig on the canonical terrain
URLs:

- `simple-terrain`
- `complex-terrain`
- `full-terrain`

Measure visual parity, draw calls, program switches, framebuffer
switches, texture binds, CPU frame cost, and GPU frame cost when
`mapProfileGpu=1` is enabled. The useful result is not only "faster" or
"slower": if the multipass path loses, the counters should show whether
the cost comes from framebuffer bandwidth, draw-call CPU overhead,
texture binds, or pass setup. If it wins, expand the experiment to
bump, specular, atmosphere, shadows, and traversal-mask cases.

**Update 2026-06-06:** a first A/B measurement is done — see
[tile-render-rig-profiling.md](tile-render-rig-profiling.md). On
`simple.json` at 2560×1353 the settled frame is fragment/fill bound
(~85 draws, but CPU ~3 ms and flat with resolution; GPU tracks pixel
count). Hand-specializing the layer loop into a straight-line shader for
that stack is pixel-equivalent and ~1.0–1.9 ms cheaper (clock-matched,
~15% of the no-discard frame), with the cost shape pointing at layer-VM
register pressure rather than shading math. That straight-line shader is
exactly the "specialized fast path for common simple stacks" this entry
proposes: the executor split, done for a simple stack, produces it. The
profiling doc also isolates a larger, separate win — removing the
shader's `discard` (see the PERF entry below) — which the executor split
should preserve by keeping depth and footprint as specialized,
discard-free passes.

---


## PERF: discard-free tile color shader for watertight tiles

**Opened:** 2026-06-06
**Status:** resolved 2026-06-06 — two color programs; the discard-free
one is selected for unmasked tiles, the discarding one (with the
coverage-mask and quadrant-clip `discard`) for tiles carrying a mask.
Clock-matched A/B on `simple.json` at 2560×1353, `dpr=1`: settled GPU
15.58 ms → 11.05 ms (~29%). Pixel parity on `simple`/`complex`/`full`;
the discarding program is selected and the seam composites on the
benatky multi-surface scene. See the session log.
**Related:** [tile-render-rig-profiling.md](tile-render-rig-profiling.md),
[gpu-subsystem.md](gpu-subsystem.md)

### Motivation

The tile color shader (`tile.frag.glsl`) contains `discard` in two
places: the coverage-mask test (`uMaskEnabled`) and the quadrant clip
(`applyTileClip`, `shaders/includes/tile-clip.inc.glsl`). Any reachable
`discard` makes
the driver defer the depth test and, on the Intel iGPU measured, also
defeats the MSAA fast-clear / compression path on the multisampled
canvas.

Measured on `simple.json` at 2560×1353 (see the profiling doc): removing
both `discard` sites drops the settled frame from ~15.6 ms to ~11.05 ms
at `dpr=1` — about 29% — and as a side effect makes MSAA nearly free
(its standalone cost is ~0.9 ms; the ~4.5 ms is a discard×MSAA
interaction term, not early-Z, since the near-nadir view has no
occlusion to reject). This is the single largest recoverable win found
and needs no shader rewrite.

### Proposed change

Split the tile color shader into two compiled programs by whether they
keep the `discard`:

- the **tile color shader** — discard-free, used for fully-covered
  tiles (watertight, unclipped, unmasked). This is the common case: it
  is exactly the traversal's watertight fast-path set.
- the **masked/clipped variant** — keeps the `discard` for the coverage
  mask and the quadrant clip, used only for tiles that actually need
  masking or clipping (LOD-boundary quadrant trims, non-watertight
  surfaces).

Select per draw on whether the tile needs the coverage mask or the
quadrant clip. Output is pixel-identical for fully-covered tiles
(verified), because the mask and clip remove nothing there;
`uMaskEnabled` disappears from the discard-free shader.

Maintain the second program only for passes that render into the
multisampled canvas and are fill-heavy — the color pass. The
depth/footprint passes render to single-sample targets (`RGBA8UI`
hitmap; see [render-targets.md](render-targets.md)), so the discard×MSAA
mechanism does not apply there and they need no second program for this
reason.

This is conceptually inside the `split tile rendering execution` entry
above (the executor would own program selection), but it is small and
high-value enough to land on its own first; the executor split should
then preserve it.

### Acceptance

- Discard-free shader selected for fully-covered (watertight, unclipped,
  unmasked) tiles; the masked/clipped variant retained for tiles that
  need masking or clipping.
- Pixel parity on `simple`, `complex`, `full`, and a non-watertight /
  masked case (where the masked/clipped variant must still discard).
- GPU frame cost on `simple.json` at 2560×1353 drops to ~11 ms range
  (`mapProfileGpu=1`). Note the iGPU clock-drift caveat in the profiling
  doc: compare clock-matched, not single readings.

### Resolution

`tile.frag.glsl` guards both `discard` sites (the `uMaskEnabled` test
and the `applyTileClip` include and call) behind `#ifdef TILE_DISCARD`,
so the default compile contains no `discard`. `GpuProgram` gained a
`defines: string[]` constructor parameter that injects `#define` lines
after the `#version` directive — the GLSL-ES-3.00-correct form of the
raw-string `#define` prepend the legacy GLSL 1.00 path uses in
`init.js`. `Renderer.programTile()` builds the discard-free program and
`Renderer.programTileDiscarding()` the `TILE_DISCARD` variant, sharing
`buildTileColorProgram`. `TileRenderRig.draw()` selects per draw:
`(maskTexture || tile.splitMask) ? programTileDiscarding() :
programTile()`, and sets `uClip`/`uMask` only on the discarding branch.
`splitMask` is the legacy `surface-tree.js` quadrant clip; that term
routes legacy clipped tiles to the discarding program and is removed
with the legacy traversal, leaving a plain `maskTexture` check.
`drawDepth()`/`footprint()` are unchanged (single-sample targets).

**Update 2026-06-08:** the legacy-traversal removal (rfc-draw-traversal
step 8) landed. `splitMask`, the `uClip` set, the `applyTileClip`
quadrant clip, and `tile-clip.inc.glsl` are gone; `TileRenderRig.draw()`
now selects on `!!maskTexture`, and the discarding program's only
`discard` is the `uMaskEnabled` coverage test.


## PERF: draw-traversal — empty-quadrant fold

**Opened:** 2026-06-04
**Status:** resolved 2026-06-05 — implemented via the gap/empty coverage
split; on `simple.json` `recursive` now matches `legacy` exactly (mask
draws 50→0, framebuffer switches 100→0, drawn tiles 193→170, GPU
parity). See the §2.1 post-implementation note and the session log.
**Related:** [rfc-draw-traversal.md](rfc-draw-traversal.md)

**Update 2026-06-04:** deferred-rectangle coverage has landed (see the
session log and the §5.1 post-implementation note). It carries the
rectangular (watertight/LOD-hierarchy) coverage as a CPU rectangle list
and rasterizes only on consumption, which moved the per-level fill/blit
of that part off the GPU. Measured residual on `simple.json` (cadence
3): framebuffer switches 128→100, mask draws 65→50 — a modest standalone
win. (It does not improve precision and does not remove LINEAR sampling,
which is for footprint coverage; an earlier note claimed otherwise and
is corrected.) The remaining churn is the `materialize` bind at each
node drawing masked fallback coverage over an all-watertight-or-culled
subtree — exactly the culling-induced consumers this fold removes, which
on this data subsumes the rectangle gain and also drops the cadence
overdraw. The fold is the next step; the rectangle representation's own
lasting value is the gap/loading case (framebuffer switches at
non-rendering propagation nodes, which the fold cannot remove) and as
the substrate for a later analytic in-shader test.

### Goal

Stop the recursive terrain traversal from materializing mask coverage
for frustum-culled quadrants, so a fully-loaded frame issues no
footprint, fill, blit, or node-mask clear, and the mask render-target
churn drops to the legacy level at rest.

### Measured cost

Profiled on `simple.json` (single surface, no textures or labels,
melown2015, prod v6 mapproxy backend, 1280x800, scene settled, one
forced redraw per frame). Per-frame medians, GL commands counted by
patching the WebGL2 context, GPU time from
`EXT_disjoint_timer_query_webgl2`:

| metric | recursive cad3 | recursive fitonly | legacy topdown | legacy fitonly |
|---|---|---|---|---|
| gpuMs | 12.1 | 12.5 | 9.0 | 8.7 |
| drawCalls | 259 | 250 | 171 | 171 |
| maskDraws | 65 | 79 | 0 | 0 |
| fbSwitch | 128 | 150 | 0 | 0 |
| clear | 52 | 55 | 1 | 1 |
| drawnTiles | 193 | 170 | 170 | 170 |

Recursive runs ~35-45% slower on the GPU than legacy at rest (+3.5 ms,
well above the ~0.7-1.5 ms run-to-run spread). Both pipelines produce a
pixel-equivalent image, so the gap is pure overhead. Legacy topdown and
fitonly converge to the same 170-tile frontier once loaded, so the
RFC's "mask turns topdown into fill-the-gaps" GPU saving does not exist
at rest — topdown does not overdraw ancestors there.

The mask operations were counted directly by wrapping the four
`DrawTraversalMaskPool` methods. In fitonly: `addFootprint` 0,
`fillNodeQuadrants` 28.6, `blitChildToParent` 58.3, `clearNode` 59.4
per frame. Footprint rasterization is already zero — every drawn tile is
watertight (metatile v6; the whole fit frontier L1-L14 reads watertight)
and returns before `addFootprint` in
[draw-traversal.ts](../../src/core/map/draw-traversal.ts). The residual
cost is fill and blit quads plus their clears.

### Root cause

A node propagates watertight coverage with no mask only when all four
child quadrants come back watertight
([draw-traversal.ts:203](../../src/core/map/draw-traversal.ts)). Because
every tile here is watertight and loaded, the only way a quadrant fails
to return watertight is frustum culling: a culled quadrant is dropped in
`collectChildActive` and never recursed, so its parent sees fewer than
four watertight children and must materialize the coverage —
`clearNode`, `fillNodeQuadrants` for the quadrants it does have — and
then returns `partial`. That `partial` poisons the whole ancestor chain
to the root: each parent of a partial node runs a `blitChildToParent`
and a clear. One culled quadrant near the frontier creates a fill plus
a blit at every level above it.

The regions a coarse fallback tile would fill at those partial nodes are
exactly the culled quadrants, which are off-screen. So in the
fully-loaded state both the mask bookkeeping and any fallback draw it
supports work on geometry that is not on screen.

### Design

Two parts. The data-model change is the **gap/empty split**; the
optimization it enables is the **empty-quadrant fold**.

The current `CoverageResult` kind `'none'` conflates two cases: a node
with an on-screen region nothing covered (waiting for data), and a node
whose descendants are all culled (no on-screen area at all). A node
passing its own bbox visibility does not imply its descendants are
visible, so a recursed subtree can legitimately have no on-screen area.
Split `'none'` into:

```ts
type CoverageResult =
    | { kind: 'watertight' }  // on-screen cell solid; analytic, no mask
    | { kind: 'partial' }     // on-screen cell covered via a mask to blit
    | { kind: 'gap' }         // on-screen area not covered — waiting for data
    | { kind: 'empty' };      // no on-screen area — nothing to cover
```

`'gap'` means "waiting for data": an unready child metatile, a child
whose metanode is loaded but whose rig is not ready, or a leaf that
could not draw. It is transient and absent from a fully-loaded frame.
`'empty'` means no on-screen area, produced both by a culled quadrant in
`collectChildActive` and by a recursed subtree whose quadrants are all
empty. `collectChildActive` reports the dropped-quadrant reason —
culled child metanode present but off-screen gives `'empty'`; child
present but unready, metatile unloaded, or `!hasChild` on-screen gives
`'gap'` (an unready child has no metanode to bbox-test, so it is treated
as `'gap'`, which keeps the win to the steady state where it belongs).

The fold is then a one-line widening of the early-out: a node returns
`'watertight'` when every quadrant is `'watertight'` or `'empty'` (none
`'partial'`, none `'gap'`). Track the empty quadrants in a
`notRequiredMask` next to the existing `watertightChildMask`:

```ts
if ((watertightChildMask | notRequiredMask) === AllQuadrantsMask)
    return CoverageWatertight;
```

A node whose only missing quadrants are culled passes watertight up
untouched — no clear, no fill, no blit. In a fully-loaded frame the
whole visible tree collapses to watertight and the mask machinery goes
silent. The cadence fallback draws also stop, because the early-out
fires before the render loop. The mask still activates wherever a finer
tile is genuinely loading, which is its purpose, so the progressive-load
behavior and the multi-surface seam compositing are unchanged.

`'partial'` deliberately covers both "fully covered, held in a mask" and
"covered with holes": the mask itself carries the hole pattern, a
consumer reads it and fills only the uncovered texels, and both are
blitted identically. The traversal never needs a per-subtree
"fully converged" signal, so the conflation costs nothing.

### Verification plan

The premise that every steady-state partial is culling-caused is forced
by the verified facts (frontier 100% watertight, scene settled), but the
payoff must be measured:

1. Re-run the mask-op counter on settled `simple-terrain`; expect
   `fillNodeQuadrants`, `blitChildToParent`, `clearNode` near zero and
   `addFootprint` still zero.
2. Re-run the GL/GPU profiler; expect `recursive-cadence3` GPU to fall
   from ~12 ms toward the ~9 ms legacy floor.
3. Screenshot mid-load to confirm the mask still fills genuine gaps (no
   transient holes at partially-loaded boundaries) and at rest to
   confirm pixel parity with today.
4. Re-check `complex-terrain` and `full-terrain`, which have real
   non-watertight boundary tiles, to confirm footprints still fire where
   they should.

The profiling harness and probes live under the gitignored `tmp/perf/`.

---

## REFACTOR: audit draw-readiness policy flags after traversal rollout

**Opened:** 2026-05-30
**Status:** open

### Goal

Audit the legacy negative readiness flags from their resource-layer
roots upward, then replace them with a clearer policy abstraction if the
inventory supports it.

### Rationale

Flags such as `preventRedener`, `preventLoad`, and `doNotCheckGpu` are
used by surface rendering, geodata free-layer rendering, legacy draw
traversal, recursive draw traversal, and resource classes such as mesh
and texture. Their names are negative and partly misleading.
`doNotCheckGpu`, for example, can mean "do not require or create GPU
residency" rather than "verify that GPU resources are ready". The
off-cadence fallback probe added during the draw-traversal rollout uses
these flags because that is the smallest compatible change, not because
the abstraction is good.

### Suggested direction

After the legacy traversal is removed:

1. Start at resource classes such as mesh, texture, subtexture, geodata,
   and geodata view. Record what each readiness flag controls: network
   fetch, retry scheduling, cache warming, CPU decode, GPU upload, and
   GPU-cache accounting.
2. Trace those meanings upward through `drawSurfaceTile`, geodata
   callers, legacy traversal, recursive traversal, and `TileRenderRig`.
3. Decide the replacement level only after the inventory. The fix may
   belong in resource readiness, draw orchestration, traversal callers,
   or a small policy object shared across those boundaries.
4. Prefer positive policy terms if the inventory supports them, such as
   `render`, `fetch`, `upload`, and `construct`.

---

## PERF/UX: screen-space terrain-error map

**Opened:** 2026-05-31
**Status:** deferred
**Related:** [rfc-draw-traversal.md](rfc-draw-traversal.md)

### Goal

Build a screen-space map of terrain error or uncertainty during terrain
rendering, then use it as shared frame state.

### Rationale

The current loading state is judged from resource readiness and coarse
distance-based priority. That answers whether data exists, but it does
not say how much the current frame would improve if a pending tile
loaded. A screen-space terrain-error map can measure where rendered
fallback geometry contributes most to visible map inaccuracy.

The same map can support three uses:

- loading polish: drive a small terrain-only blur around high-error
  regions, hiding coarse fallback artifacts and spilling over cracks
  between tiles of different coarseness;
- loaded-state reporting: aggregate the map to decide when the visible
  terrain is accurate enough for the splash screen or loading indicator
  to disappear;
- resource priority: prioritize pending resources by their contribution
  to visible frame error, replacing the current crude closest-first
  heuristic with a view-dependent accuracy signal.

### Suggested direction

Keep this separate from the traversal mask. The traversal mask remains
the coverage/occlusion mechanism; the terrain-error map is a
screen-space estimate of visual inaccuracy and loading quality.

---

## BUG: superelevation — debug bbox heights baked at stale zoom

**Opened:** 2026-05-31
**Status:** fixed 2026-05-31 (per-node factor invalidation); verified in
browser — all drawn LOD-15 tiles match the reload bake after a zoom-in
**Related:** [rfc-draw-traversal.md](rfc-draw-traversal.md)

### Symptom

With vertical exaggeration active, `Shift+B` debug boxes for high-LOD
tiles (e.g. LOD 15 on `simple.json` over the Himalayas) levitate above
the terrain: correct geographic position, height too high. Reproduced
on `mapTerrainTraversal=recursive` with `mapFallbackCadence=3`.
`mapFallbackCadence=1` and `mapTerrainTraversal=legacy` do not show it.
Reloading at the same camera position renders the same tiles' boxes
correctly.

### Reproduction

URL:
`http://localhost:8080/demos/map/?style=styles/simple.json&pos=obj,88.146972,27.703191,fix,8433.73,-205.24,2.81,0.00,13252.77,30.00&mapExposeFpsToWindow=1&mapTerrainTraversal=recursive&mapFallbackCadence=3`

Enable `Shift+B`, zoom all the way in, tilt to a high oblique angle.
LOD-15 boxes float. Ctrl-R at the same position, `Shift+B` again: boxes
are correct.

### Root cause

The vertical-exaggeration scale factor depends on the camera view
extent (zoom): `getVeScaleFactor` reads `position.pos[8]` and runs it
through `currentScaleDenominator` —
[src/core/renderer/renderer.ts:1657](../../src/core/renderer/renderer.ts).

The terrain surface applies exaggeration on the GPU every frame at the
live position, so it always matches the current zoom. The cull box and
debug box use `bbox2`, whose exaggerated `minZ`/`maxZ` are baked in
`MapSurfaceTile.isMetanodeReady` only when
`tile.seCounter != renderer.seCounter` —
[src/core/map/surface-tile.js:341](../../src/core/map/surface-tile.js).
`seCounter` advances only on exaggeration *configuration* changes
(enable/disable, ramp setup), never on zoom. So once a node syncs to the
current `seCounter` generation, its baked SE height is not refreshed as
the zoom-dependent factor changes.

Measured on `15/12202/6878` after a zoom-in vs. a fresh reload at the
same position: navigated bake `minZ/maxZ = 6400/8343 × 1.407`, reload
`× 1.30`. Both carry the height ramp (×1.3); the navigated one carries
an extra ×1.082 scale factor. In ECEF every corner is shifted ~686 m
radially (along the disk normal) — a uniform height exaggeration, not a
different box.

The specific traversal/cadence conditions under which it is observed are
in **Symptom**; the reason that axis matters was not established and is
not needed for the fix.

### Wider risk

`bbox2` is the v4+ frustum cull volume —
[src/core/map/surface-tile.js:646](../../src/core/map/surface-tile.js),
`pointsVisible(node.bbox2, …)`. A stale-baked `bbox2` mis-sizes culling
against an exaggeration that no longer matches the live surface, so this
is not only a debug-overlay artifact.

### Fix (implemented, verified)

Per-node factor invalidation in `MapSurfaceTile.isMetanodeReady`
([surface-tile.js:341](../../src/core/map/surface-tile.js)): each
metanode records the scale factor it was baked at (`veBakedFactor`); the
gate now also fires when `getVeScaleFactor(this.map.position)` differs
from it, rebaking `minZ`/`maxZ` and `bbox2` at the current factor. The
comparison uses the same position the bake uses, so there is no desync.
A still camera produces an identical factor (zero rebakes); during a
zoom each traversed node rebakes, which is the behaviour we want. With
no scale ramp the factor stays 1.0 and nothing fires.

An earlier attempt drove this from `MapDraw.initFrame`, bumping
`seCounter` when the per-frame factor changed. It was reverted in favour
of the per-node check, which is correct by construction: it samples the
factor at the bake site and re-checks on every traversal, with no
dependence on a global counter staying in step. The reason the
`initFrame` approach did not hold up was not pinned down and is not
needed now.

Verified in browser: after a zoom-in on `recursive` + `cadence=3`, all
86 drawn LOD-15 tiles match their reload bake (`veBakedFactor = 1`,
deviation 0), and the boxes sit on the terrain.

---

## REFACTOR: drop metatile format versions 1–3

**Opened:** 2026-05-27
**Status:** open

### Goal

Remove all client-side code paths that exist only to handle metatile
format versions 1, 2, and 3.

### Rationale

The mapy.com production deployment serves version 4, confirmed by
inspecting live responses (2026-05). No known live data source produces
versions 1–3. The v1–v3 code paths carry meaningful complexity:

- Quantized physical extent decoding in
  `MapMetanode.prototype.parseMetanode()` —
  [src/core/map/metanode.js](../../src/core/map/metanode.js)
- Aliasing `minZ`/`maxZ` to the int16 navSRS `minHeight`/`maxHeight`
  instead of reading explicit float32 SDS values
- `MapSurfaceTree.prototype.updateNodeHeightExtents()` in
  [src/core/map/surface-tree.js](../../src/core/map/surface-tree.js)
  — propagates the height range from navtile-flagged ancestors to
  children for culling box construction; guarded by
  `node.metatile.useVersion < 4` and never fires against v4+ data
- The `mapForceMetatileV3` config flag, which forces `useVersion = 3`
  as an escape hatch for debugging the v4/v5 culling path; no longer
  needed once v3 is gone
- Credit-block parsing differences between v1 and v2+ (separate
  `creditCount`/`creditSize` fields in v1)
- `nodeSize` header field in v1 (used to skip unknown node formats)

### What to delete

- The `if (version < 4)` alias in `parseMetanode()` that sets
  `this.minZ = this.minHeight` (v1–v3 had no explicit float32 SDS
  heights, so `minZ`/`maxZ` were aliased from the navSRS int16 range;
  v4+ stores them separately) —
  [src/core/map/metanode.js:211](../../src/core/map/metanode.js)
- `MapSurfaceTree.prototype.updateNodeHeightExtents()` and all its
  call sites in the legacy and typed traversals — this propagation
  exists only because the alias above produces unreliable height ranges
  for pre-v4 tiles and children need to inherit from the nearest
  navtile-flagged ancestor —
  [src/core/map/surface-tree.js:157](../../src/core/map/surface-tree.js)
- The `mapForceMetatileV3` config key, its setter/getter in `map.js`,
  and the `useVersion` override logic in `MapMetatile`
- The v1-specific credit-block parsing path (`creditCount`/`creditSize`
  pre-header fields)
- The v1 `nodeSize` header field handler

**Do not delete** the `if (version < 5)` quantized-extents branch in
`parseMetanode()`. Despite the name, that branch fires for v1 through
v4: v4 tiles still carry the packed `geomExtents` bytes in the stream;
v5 is the format version that removes them. The bbox decoded from those
bytes is still used for culling on v4 tiles. Deleting that branch would
misalign the stream reader and corrupt all subsequent field reads for
v4 metatiles.

### Precondition

Verify that no style or mapConfig consumed in the test suite or by
active deployments points at a tileserver that produces v1–v3 metatiles.
The metatile version is readable from the first two bytes after the
`MT` magic: `uint16 LE` at offset 2.

---

## BUG: draw-traversal — mask fails for internal-texture surfaces

**Opened:** 2026-05-27
**Status:** resolved 2026-05-28 — `rt.externalUVs` and `rt.internalUVs`
made data-based in `TileRenderRig`; benatky regression confirmed clean
**Related:** [rfc-draw-traversal.md](rfc-draw-traversal.md);
[BUG: draw-traversal — black flashes when zooming into city surface](#bug-draw-traversal--black-flashes-when-zooming-into-city-surface)
and
[BUG: draw-traversal — aborted descents at very high LODs](#bug-draw-traversal--aborted-descents-at-very-high-lods)
are confirmed manifestations of the same root cause

### User report (verbatim)

> The 2 bugs (which are possibly a manifestation of a single bug) have
> nothing to do with the combined traversal of multiple surfaces. They
> are well manifested even for a single surface scene, and they were
> introduced by the very first — single surface — recursive traversal
> implementation, 60e825aa (the previous commit, using the legacy path,
> does not demonstrate either problem).
>
> [URL] clearly shows issues with coarser loads seeping into the finer
> lods, which should cause all of their pixels to be discarded (Shift+B
> L I will show you lods and indices of the tiles where this problem
> happens). This is what the bug report described as "aborted descent",
> the problem is different — the coarser load pixels are clearly not
> prevented from rendering.
>
> The black flash problem is real but more difficult to reproduce, it
> requires moving the map around and you will not likely capture it
> empirically.
>
> The problem was not caught during regression testing of the commit
> because it does not manifest itself on the tileserver-based surfaces.
> The legacy benatky surface, served by vts-vtsd, is well formed and
> needs to be supported, however. The problem has its root in some of
> its specifics: the surface carries internal textures, does not carry
> normal maps. My first guess was that it did not carry external
> textures, which would effectively prevent the recursive traversal
> mask algorithm from functioning. But that should not be the case, to
> my knowledge: the surface does have external textures in its meshes.

### Reproduction

URL:
```
http://localhost:8080/demos/map/?mapConfig=https://cdn.tspl.re/store/stage.melown2015/tilesets/benatky-nad-jizerou2015/mapConfig.json&pos=obj,14.822899,50.291139,fix,284.04,-264.65,-90.00,0.00,29.63,30.00
```

Enable `Shift+B L I` (bbox / LOD / id overlay) to see the LODs and
tile indices where coarser tiles seep into finer-LOD areas.

---

## BUG: draw-traversal — black flashes when zooming into city surface

**Opened:** 2026-05-27
**Status:** resolved 2026-05-28 — confirmed manifestation of mask bug;
resolved by same fix
**Related:** [rfc-draw-traversal.md](rfc-draw-traversal.md)

### User report (verbatim)

> Black flashes when zooming quickly into the city (benatky) surface.
> This should not be happening, because there is always a fallback tile
> ready — if nothing else, then the back large back surface tile which
> should show when backtracking.

### Reproduction

URL:
`http://localhost:8080/demos/map/?mapConfig=https://cdn.tspl.re/store/tests/benatky/mapConfig.json&pos=obj,14.825888,50.288190,fix,0.00,-275.37,-90.00,0.00,395.06,30.00&mapExposeFpsToWindow=1&mapTerrainTraversal=recursive`

Steps: load the URL, then zoom in/out quickly over the city center.
Brief black frames appear where the city tileset overlaps the global
DEM (`topoearth-copernicus-dem-glo30` + `benatky-nad-jizerou2015`).

---

## BUG: draw-traversal — aborted descents at very high LODs

**Opened:** 2026-05-27
**Status:** resolved 2026-05-28 — confirmed manifestation of mask bug;
resolved by same fix
**Related:** [rfc-draw-traversal.md](rfc-draw-traversal.md)

### User report (verbatim)

> Aborted descents, SSE evaluation failures, or other reasons why
> coarser tiles display, this happens on very high LODs. Here is an
> URL and a partial screenshot (with Shift+B L I)

Screenshot in the original report shows tile boundaries at LOD 19–21
with patches of coarser tiles where finer tiles should be present.

### Reproduction

URL:
`http://localhost:8080/demos/map/?mapConfig=https://cdn.tspl.re/store/tests/benatky/mapConfig.json&pos=obj,14.825888,50.288190,fix,0.00,-275.37,-90.00,0.00,395.06,30.00&mapExposeFpsToWindow=1&mapTerrainTraversal=recursive`

Enable diagnostics with `Shift+B L I` (bbox / LOD / id overlay) and
inspect high-LOD tiles over the city.

---

## BUG: draw-traversal phase 2 — front surface overlaps back surface on +x/+y edges

**Opened:** 2026-05-27
**Status:** resolved 2026-05-28 — mask filter switched to LINEAR
**Related:** [rfc-draw-traversal.md](rfc-draw-traversal.md) phase 2

### User report (verbatim)

> There seems to be some off-by-one or some other mask registration
> error - the city surface visibly overlaps over the back surface on
> the east (positive x) and south (positive y) sides of the rectangle
> it covers. Perhaps masks are shifted or not treated fully.

> There is not mesh overlap inherent to VTS file format, that is total
> BS, please do not optimize around this faulty assumption. Additionally,
> issue 4 is clearly asymmetric.

### Diagnosis

Not an off-by-one error in mask registration. The cause is a producer
/ consumer LOD distance combined with `NEAREST` mask sampling. On
`legacy-benatky` the city tileset reaches LOD 22 while the back
surface reaches its natural leaf at LOD 15. The mask is written by
the city tile at its native 256-wide resolution and read by the back
surface after seven half-quadrant blit-downscales, leaving roughly
two texels of original information — a boundary uncertainty of up to
half a tile. With `NEAREST` sampling the binary boundary snaps to
texel centres of the consumer-scale mask, producing the observed
overlaps on +x/+y and matching gaps on -x/-y. The +x/+y bias is the
sampling direction of the corresponding texel-centre rounding under
the blit; -x/-y land the other way.

### Fix

Mask textures now use `LINEAR` filtering
(`DrawTraversalMaskPool.createMask`); the per-type filter override in
`GpuTexture.Type.Mask` was removed so the caller's `'linear'`
argument is honoured. The tile shader compares the sampled coverage
against configurable `mapTraversalMaskThreshold`, default `0.65`, to
keep a narrow fallback overlap band at mask edges. See phase 2
post-implementation notes in [rfc-draw-traversal.md](rfc-draw-traversal.md)
for the full explanation and the discard-threshold tuning knob.

---

## BUG: TileRenderRig soft view switching has early-exit gaps

**Opened:** 2026-06-10
**Status:** open — `lastRenderRig` covers the normal same-surface view
switch, but `drawSurfaceTile` can return before reaching the fallback
rig path
**Related:** [rendering-architecture.md](rendering-architecture.md)

### Confirmed behavior

`MapSurfaceTile.viewSwitched()` keeps the current `tileRenderRig` alive
and sets `tile.updateBounds = true`. On the next terrain draw,
`drawSurfaceTile` moves the old current rig to `lastRenderRig[i]`,
constructs a new `TileRenderRig`, and draws `lastRenderRig[i]` when the
new rig is not ready. This is the modern terrain equivalent of the old
`lastRenderState` soft view-switch replay.

The old command replay and the new rig fallback do not have identical
failure surfaces. `lastRenderState` could replay commands while new tile
state was being rebuilt. The `lastRenderRig` fallback only runs after
`drawSurfaceTile` reaches the per-submesh rig loop.

### Caveats

- If the new view points at a different surface and the new mesh has not
  parsed submesh metadata yet, `drawSurfaceTile` returns before the
  per-submesh loop, so the old rig is not drawn for that tile.
- If CPU mesh data has been evicted (`surfaceMesh.submeshesKilled`) at
  the moment a rig rebuild is needed, the rebuild is deferred until CPU
  data reloads. Existing GPU-resident rigs can keep drawing when no
  rebuild is needed, but a required rebuild does not currently fall back
  to the old rig inside the same branch.

### Follow-up

If visible holes appear during surface or style switches, instrument
`drawSurfaceTile` around the early returns and the CPU-residence guard.
The desired property is that a GPU-resident previous rig can draw
whenever the tile position is still valid and the replacement rig cannot
yet be constructed or made ready. Any fix must avoid constructing a new
rig from killed CPU submesh fields; that guard prevents the drab-tile
race documented below.

---

## BUG: TileRenderRig — internal texture missing from layer stack

**Opened:** 2026-05-28
**Status:** resolved 2026-05-28 — `draw-tiles.js` now refuses to build a
new rig while `surfaceMesh.submeshesKilled` or `loadState !== 2`
**Related:** [rendering-architecture.md](rendering-architecture.md)

### Diagnosis

`MapMesh.killSubmeshes` (CPU resource-cache eviction) nulls every
submesh's per-vertex data (`internalUVs`, `externalUVs`, `vertices`,
…) via `MapSubmesh.kill`, but leaves the `submeshes` array length
intact (the `this.submeshes = []` line is commented out). If the
resource cache evicted the mesh before any `TileRenderRig` had been
built for the tile, the next draw pass found `submeshes.length > 0`
and constructed a rig whose constructor read
`!!this.submesh.internalUVs` as `false`. The internal-texture
overlay in `buildLayerStack` was then skipped, and the rig — which
is cached on `tile.tileRenderRig[i]` for the lifetime of the tile —
permanently rendered only the drab constant background layer.

This matched every reported symptom: non-determinism (depends on
whether eviction landed between mesh load and first draw),
clustering (cache evictions are bulk and proximity-correlated), no
internal-texture request in the network panel, persistence until
the rig was rebuilt, and presence in both `legacy` and `recursive`
traversal modes (the bug was in rig construction, not traversal).

### Fix

In `draw-tiles.js`, hoist a `cpuReady` local (`meshReady &&
!submeshesKilled`) and gate rig CONSTRUCTION on it. The existing
husk pattern in `killSubmeshes` (array length preserved, per-submesh
fields nulled) is intentional — it lets existing rigs keep drawing
from `gpuSubmeshes` during a CPU-only eviction window. Rig
DRAWING continues to use whatever residency the rig's `isReady`
verifies; only rig construction, which needs CPU fields, waits for
the reload. While there, made the function's early-exit and return
value explicit (`return false;` when the mesh has never parsed;
`let ret = false;` instead of `var ret;`).

### User report (verbatim)

> There is an interesting bug on the legacy benatky dataset (that
> dataset has a single tileset with an internal texture).
>
> The bug is non-deterministic: it does not appear on the same tile
> upon reload of the map, but it can happen on others. When it happens
> on a tile, the tile always displays this way until a new rig is
> created for it.
>
> The drab color is the tell-tale sign — it is the base constant color
> layer at the bottom of the layer stack, telling us that the texture
> was never applied to the tile. Moreover, when this happens, the
> inspector tells us that the internal texture was never requested:
> there are only two requests for the mesh itself. It seems that under
> some race condition the rig simply fails to create the internal
> texture entry in the stack, but that is just my assumption.
>
> The erroneous tiles seem to appear in clusters (proximity), but that
> is more a hint than a reliable observation.
>
> The problem manifests in both recursive and legacy modes and may
> have existed for a long time, possibly since the `TileRenderRig`
> implementation.

### Reproduction

URL (legacy benatky, single tileset with internal texture):
```
http://localhost:8080/demos/map/?mapConfig=https://cdn.tspl.re/store/stage.melown2015/tilesets/benatky-nad-jizerou2015/mapConfig.json&pos=obj,14.822484,50.290321,fix,278.36,-327.77,-90.00,0.00,145.78,30.00&mapTerrainTraversal=legacy
```

Move around the map until a drab-colored tile appears. Enable
`Shift+B L I` (bbox / LOD / id overlay) to identify the affected
tile. Inspect the network panel filtered by the tile id: only the
mesh `.bin` requests are present, no internal texture request.

Affected tiles keep rendering in the drab base color until their
rig is recreated.

---

## BUG: depth hitmap dead zone near geometric horizon

**Opened:** 2026-05-20
**Status:** open — cause not yet identified

The starting view of `demos/depth-test/` has a strip near the terrain
horizon where `getScreenDepth` returns no reading. In that view it is
about 8 px wide at the viewport centre and about 4 px wide at the edges.
The dead zone is largely undetectable in many other views, and its
existence seems independent of hitmap resolution.

The bug persists after the depth hitmap changed from RGBA8 base-255
packing to RGBA8UI float bit-pattern storage. This rules out the old
RGBA8 carry-error path as the cause of the horizon dead strip.

---

## FEATURE: freeze mode for viewport diagnostics

**Opened:** 2026-05-18
**Status:** implemented

### Goal

A single freeze toggle that locks the rendering pipeline to the current
viewport, allowing the developer to navigate away and inspect what the
map draws at a given position.

### Behaviour

**Frozen:**

- The camera state used for tile selection, culling, and depth sampling is
  locked to the position at freeze time. The live camera still drives
  navigation and final rendering, so the developer can move away from the
  frozen position and inspect what was selected there.
- The frustum is drawn as a finite translucent pyramid in world space when
  enabled. Its depth comes from the farthest finite depth hitmap sample,
  with a reference-frame fallback only when the hitmap has no finite depth.

**Controls:**

- `Shift+D`, `Shift+Z` enters freeze controls. This command mode does not
  itself freeze or unfreeze the map.
- `F` freezes at the current navigation position when unfrozen, or
  unfreezes when already frozen.
- `C` toggles the frustum overlay while frozen.
- `R` resets the live camera to the frozen position.
- Freeze controls show a three-button strip: freeze/unfreeze, frustum
  toggle, and reset view. If the map is frozen, the strip remains visible
  after leaving freeze controls.

### Why this replaces the replay inspector

The replay inspector required a snapshot step followed by a separate display step, with five
different S buttons capturing different slices of data. The freeze
approach is simpler: the tile descent runs normally against a fixed
viewpoint, so Drawn Tiles and Traced Nodes fall out naturally without any
tileBuffer capture machinery. Enabling bounding-box debug drawing on top
of a frozen scene gives you Traced Nodes for free.

### What is not covered

- Load sequence timeline: the bar-graph timeline of individual asset
  downloads by kind and duration. This is a separate diagnostic concern
  and can be addressed independently if needed.

### Implementation note

`src/core/map/freeze-camera-state.ts` owns the captured camera state.
The typed `Map` (`map.ts`) owns the `FreezeCameraState` instance
(`map.freeze`) and the `withSelectionCamera` / `withNavigationCamera`
methods. Legacy draw code reaches them via `legacyMap.outerMap.freeze`
and `legacyMap.outerMap.withXxxCamera(...)`. Final terrain and geodata
rendering use the navigation context for camera matrices while passing
the selection position to `Renderer.updateBuffers()` or `drawGpuJobs()`
so scale-dependent vertical exaggeration follows the selected tile set.
`src/core/inspector/freeze.ts` owns mode state, DOM controls, and
frustum capture. `Renderer` draws the frustum with the modern
`useProgram2` shader path.

---

## REFACTOR: pass explicit draw contexts

**Opened:** 2026-05-24
**Status:** open

### Goal

Replace the freeze-mode `withSelectionCamera` and
`withNavigationCamera` bridge with explicit draw context parameters once
legacy camera and position reads are removed from the draw code.

### Target shape

Draw code should receive the context it needs instead of installing it
by mutating `map.position`, `MapCamera`, `Renderer.camera`, and renderer
camera mirrors. A frame should make the two roles explicit:

- `view`: the camera and position used to render the final image.
- `selection`: the camera and position used for tile selection, culling,
  depth sampling, and scale-dependent vertical exaggeration.

Freeze mode then becomes a context choice:

```ts
const view = map.navigationContext();
const selection = freeze.active ? freeze.selectionContext() : view;

drawFrame({ view, selection });
```

Final terrain and geodata rendering must preserve the existing hybrid
semantics: draw from `view`, but derive vertical exaggeration from
`selection`.

---

## REFACTOR: remove OGC 3D Tiles streaming mechanism

**Opened:** 2026-05-21
**Status:** implemented by [rfc-remove-3dtiles.md](rfc-remove-3dtiles.md)

### Goal

Delete the client-side OGC 3D Tiles loader and all code that exists
solely to serve it.

### Rationale

A 3D Tiles streaming engine has no place in a cartographic library. The
feature was wired in around April–September 2020 as a `config.tiles3d`
option on the browser widget, bypassing the VTS map-config pipeline
entirely. It was never completed (the mesh parser has typos in extension
names and falls through silently; the v1 import path in
`geodata-builder.js` is already commented out) and has been untouched
since September 2020.

### What to delete

- `src/core/map/geodata-import/3dtiles.js` — v1 importer (unused;
  import already commented out in `geodata-builder.js`)
- `src/core/map/geodata-import/3dtiles2.js` — v2 importer (active)
- `src/core/map/geodata-processor/worker-main.js` — the
  `nodes[].meshes[]` dispatch block (lines ~445–452)
- `src/core/renderer/gpu/group.js` — `GpuGroup.prototype.drawMesh`
  (lines 1287–1305), the `binFiles`/`binPath` streaming machinery
  (lines ~1600–1850), and the `direct-3dtiles` loader calls
- `src/core/map/loader/loader.js` — the `'direct-3dtiles'` case
  (line 189)
- `src/browser/browser.js` — the `config.tiles3d` branch (lines ~148–151)
- `geodata-builder.js` — the commented-out `load3DTiles` / `import3DTiles`
  methods and the `binPath` field (lines ~1474–1491, 1942–1943)
- `geodata-view.js` — the `directBinParse` path and the
  `geodata['binPath']` check (lines ~252–256, 273–274)

Once those callers are gone, `MATERIAL_INTERNAL` in `mesh.js` and
`progTile[v]` in `init.js` / `renderer.ts` also lose their last
terrain-code consumer and can be removed in the same pass. Replay and
the public custom-mesh demos no longer keep `Renderer.drawMesh()` alive.

---

## REFACTOR: delete legacy tile shader family

**Opened:** 2026-05-21
**Status:** implemented by [rfc-remove-3dtiles.md](rfc-remove-3dtiles.md)
(§3.3)

### Goal

Delete the old VTS tile shader family and the JavaScript variant builder
that still serve non-terrain mesh callers.

### Preconditions

Do this only after the OGC 3D Tiles / geodata mesh path is deleted. That
removes:

- `config.tiles3d` and `direct-3dtiles`
- `nodes[].meshes[]`, `binPath`, `WORKER_TYPE_MESH`, and `JOB_MESH`
- `GpuGroup.drawMesh()`
- the last non-terrain calls into `MapMesh.drawSubmesh()`

Replay and the public custom-mesh demos have already been deleted. They
no longer keep `Renderer.drawMesh()` or the shaded custom-mesh programs
alive.

### What should become removable

- `MapMesh.generateTileShader()`
- `MapMesh.drawSubmesh()`
- `progTile`, `progTile2`, `progTile3`, `progDepthTile`,
  `progFogTile`, `progFlatShadeTile`, `progCFlatShadeTile`,
  `progWireFrameBasic`, and their variant arrays
- `GpuShaders.tileVertexShader`
- `GpuShaders.tileFragmentShader`
- material constants that exist only for `MapMesh.drawSubmesh()`

Before deleting, run `rg` for `drawSubmesh`, `drawMesh(`, `progTile`,
`progDepthTile`, `tileVertexShader`, and `tileFragmentShader`. The
remaining terrain renderer must be `TileRenderRig`.

---

## REFACTOR: delete legacy mesh tile rendering pipeline

**Opened:** 2026-05-20
**Status:** done — 2026-05-21

### Goal

Remove all code that existed to serve the old `drawMeshTile` call,
which is already commented out.

### Result

Deleted the old terrain draw-command renderer and its command-generation
path. `TileRenderRig` remains the terrain tile renderer for color and
depth passes. `DRAWCOMMAND_GEODATA` remains because geodata tiles still
use `MapDraw.processDrawCommands()`.

Kept `MapMesh.drawSubmesh()` and the legacy tile shaders it uses because
geodata mesh jobs in `src/core/renderer/gpu/group.js` still call it, and
the public custom mesh renderer still uses the old shaded/depth mesh
programs. Deleting those requires a separate migration for geodata mesh
jobs and custom mesh rendering.

Deleted:

**`draw-tiles.js`** (~895 lines, 62% of file):

- `drawMeshTile` (line 247–724)
- `updateTileHmap` (line 801–852)
- `updateTileBounds` (line 853–898)
- `updateTileSurfaceBounds` (line 917–1235)
- `lastRenderState` replay block in `drawSurfaceTile`
  (lines 236–241) and the commented-out `drawMeshTile` call
  (line 213)

**`draw.js`** (~190 lines):

- `processDrawCommands` branches for `DRAWCOMMAND_STATE`,
  `DRAWCOMMAND_APPLY_BUMPS`, and `DRAWCOMMAND_SUBMESH`
  (lines 749–900; `DRAWCOMMAND_GEODATA` survives)
- `areDrawCommandsReady` `DRAWCOMMAND_SUBMESH` branch
  (~35 lines; `DRAWCOMMAND_GEODATA` survives)
- `getDrawCommandsGpuSize`, which only served old tile command memory
  estimates

**`shaders.js`**:

- `heightmapVertexShader` / `heightmapFragmentShader` /
  `heightmapDepthVertexShader` / `heightmapDepthFragmentShader`
  (lines 793–881)
- `skydomeFragmentShader`

**`renderer.ts` / `init.js`**:

- `progHeightmap`, `progDepthHeightmap`, and `progSkydome`
  construction and declarations

**`surface-tree.js`** (~8 lines):

- `getDrawCommandsGpuSize` call sites that reference
  `tile.drawCommands` / `tile.lastRenderState.drawCommands`
  (those fields are never populated once `drawMeshTile` is gone).

### Why before the draw refactor

The draw refactor (steps 2–4 of the entry below) touches the same
files and traversal logic. Removing dead code first keeps the diffs
readable and avoids carrying old branches through a restructuring
only to delete them on the other side.

---

## REFACTOR: replace legacy map draw path with `TileRenderRig`

**Opened:** 2026-05-16
**Status:** step 1 done; step 2 promoted to
[rfc-map-frame.md](rfc-map-frame.md); steps 3–4 pending

### Goal

Make `TileRenderRig` the tile renderer for both color and depth passes,
then replace the old map and surface-tree draw entry points with smaller
functions that operate on surface sequences. Surface sequences are
produced by both style-based maps and legacy map configs; this change
has nothing to do with the style system specifically.

The draw refactor should happen before the EventBus and ConfigStore
implementation work. EventBus and ConfigStore remove legacy ownership
from `Core`, but the draw refactor changes the rendering structure that
the cleaned-up ownership model should serve. Avoid preserving old tile
rendering branches through a config migration if the same branches are
scheduled for deletion.

### Plan

1. ~~Add a depth program for `TileRenderRig`.~~  **Done** (2026-05-20)

   `TileRenderRig` is wired into the depth pass with dedicated shaders
   and a typed clear/readback API.

2. ~~Move the map draw function and the frame loop onto typed `Map`.~~
   **Done** (2026-05-26) — see [rfc-map-frame.md](rfc-map-frame.md).

   `MapDraw.drawMap` moved into `Map.draw`;
   `LegacyMap.update` moved into `Map.tick`, with a residual
   `LegacyMap.tick` for the loader / worker / deferred-event work
   not yet promoted. Audited and relocated post-`55a34f27`
   additions on `LegacyMap` (`drawChannel`, overlay registry,
   `initFrame`, position accessors). `MapInterface` deletion completed
   as an independent track — see the dedicated entry below.

3. Implement the new unified traversal per [rfc-draw-traversal.md](rfc-draw-traversal.md).

4. Delete obsolete rendering code.

   After color, depth, and surface-tree traversal work through
   `TileRenderRig`, remove the old tile rendering path, old draw variants,
   obsolete shaders, and inspector-only branches that no longer have a
   caller.

### Follow-up order

After this refactor reaches the deletion pass, continue with:

1. [rfc-event-bus.md](rfc-event-bus.md)
2. [rfc-config-store.md](rfc-config-store.md)
3. Removing the `Map.core` escape hatch from `Viewer`
4. Designing a style-era runtime overlay API

---

## REFACTOR: replace `gpu.setState` with per-method GL state push/pop

**Opened:** 2026-05-18
**Status:** deferred

This is a possible renderer redesign, not the current coding rule.
The current rule is documented in
[gpu-subsystem.md](gpu-subsystem.md): draw sites may leave GL state active,
while pass setup and clear helpers establish the state they require.

Each draw method would save the GL flags it needs on entry, apply them
with direct `gl.*` calls, and restore on exit. No shared state objects,
no caller/callee coordination, no implicit assumptions about prior
state. The current `setState`/`currentState` delta tracking is an
optimisation for the coordination problem that disappears once each
method owns its state window.

---

## REFACTOR: replace glues and virtual surfaces with client-side
surface composition

**Opened:** 2026-05-13
**Status:** deferred

### Goal

Replace the legacy glue / virtual-surface stack with a client-side
compositor. The tileserver continues to serve each surface independently;
seam stitching becomes a renderer-side operation.

A key architectural distinction from the old model: the old system
always resolved a single "winning surface" per tile. A client-side
compositor cannot make that assumption — a tile at a seam boundary may
genuinely need geometry from more than one surface, so the rendering
pipeline must be prepared to handle multiple geometry sources per
metanode.

Background on the legacy stack:
[glue-alien-flag.md](glue-alien-flag.md),
[vts-storage-and-virtual-surfaces.md](vts-storage-and-virtual-surfaces.md).

---

## REFACTOR: delete `MapInterface`

**Opened:** 2026-05-25
**Status:** done — 2026-05-26, no design overlap with
[rfc-map-frame.md](rfc-map-frame.md)

### Goal

Delete `src/core/map/interface.js`. It was a thin layer that delegated
69 methods to `LegacyMap` after the render-slot removal in commit
`ff70938e`. `Viewer` reached it via the `legacyMapInterface_` getter.

### Result

`Core.mapInterface` and `Core.getMapInterface()` were removed.
`Browser.getMap()` now returns `Core.map` (`LegacyMap`) directly.
Wrapper-only conveniences still used by browser UI, autopilot,
measure controls, and inspector radar moved onto `LegacyMap`.
`Viewer.createGeodata()`, `Viewer.addFreeLayer()`, and
`Viewer.removeFreeLayer()` now route through typed `Map` methods.
Coordinate conversion and hit-testing methods on typed `Map` call the
loaded `LegacyMap` directly.

Post-commit review found two methods not ported from
`interface.js`: `getReferenceFrame()` and `getSrsInfo()`, both called
at runtime by the browser UI. Added in a follow-up commit.

### Why a separate item

The deletion was mechanical but not small. It targeted `interface.js`
exclusively and did not interact with the frame-loop relocation covered
by [rfc-map-frame.md](rfc-map-frame.md). Keeping it as an independent
track avoided inflating the RFC's scope.

---

## REFACTOR: continue absorbing legacy objects into `Map`

**Opened:** 2026-05-04
**Status:** in progress — `Map` shell done; absorption continues

### Done

`Map` (`src/core/map.ts`) exists and replaces `CoreInterface`. `Viewer`
holds `_core: Map`; `Browser` constructs `Map` directly. `CoreInterface`
and its `.d.ts` are deleted.

### Remaining

`Viewer` still accesses `LegacyMap` and `Renderer` via the `Map.core`
escape hatch (`this._core.core.map`, `this._core.core.renderer`, etc.).
Each method promotion must route through a proper `Map` public method
instead, allowing the `core` shim to be deleted.

| Object | Status |
|---|---|
| `CoreInterface` | **Deleted** — replaced by `Map` |
| `Core` | Private in `Map.core_`; pending absorption |
| `MapInterface` | **Deleted** — wrapper methods moved to `Map` / `LegacyMap` |
| `RendererInterface` | Pending — second set |
| `LegacyMap` (JS half of `Map`) | Pending — long-term absorption |
| `Renderer` | Pending — private implementation of `Map` |

### Next steps

- Once all `Viewer` callers go through `Map`, delete the `core` getter.

---

## REFACTOR: remove legacy nullable construction paths

**Opened:** 2026-05-14
**Status:** in progress

### Goal

Construction of `Viewer`, `Browser`, `Map`, `Core`, and `Renderer`
should either complete or throw. An instance with no engine object is not
a valid object.

### Done

`Browser` now throws when WebGL2 support is absent. `map()` and
`browser()` return `Viewer`, not `Viewer | null`. Non-legacy demos no
longer check the factory result for falsiness.

`GpuDevice` now throws when canvas or WebGL2 context creation fails.
`Map` keeps its `Core` reference non-null; after disposal, public
methods throw instead of returning `null`.

`GpuDevice.checkSupport()` is the canonical pre-flight probe; it is
called by `Browser` before DOM insertion. The legacy `checkSupport`
function in `core.js` and its re-export from the public namespace are
removed.

`Browser.setConfigParam()` no longer reads `Browser.core` before `Core`
construction. Constructor-time config stores browser-owned values first;
engine forwarding happens only after the `Map` boundary object exists.

### Remaining

The first audit found no remaining path where a public constructor can
return an object without its construction-owned engine object. Remaining
nullable returns mostly describe runtime states:

- `Core.map` is `null` before async style or mapConfig load finishes,
  and after `destroyMap()` / `unloadMap()`.
- `Map` and `Viewer` coordinate conversion and hit/depth methods return
  `null` when the loaded map cannot answer the query.
- Atmosphere access returns `null` when the loaded style has no
  atmosphere object.
- `Viewer.assertAlive_()` handles calls after viewer disposal. This is
  lifecycle behavior, not construction failure.

Keep this item open until one more focused audit confirms that nullable
checks in `Viewer`, `Map`, `Browser`, `Core`, `Renderer`, and
`GpuDevice` fall into the runtime-state categories above. Remove a check
only if it exists solely to tolerate a failed constructor after an object
has already been returned.

### Next audit targets

- `src/core/map.ts`: document which `core_.map?.` calls mean
  unloaded-map state.
- `src/core/renderer/renderer.ts`: keep `core.map?.markDirty()` checks
  that allow renderer settings before a map has loaded.

---

## REFACTOR: migrate `TEXTURETYPE_*` constants to a `GpuTexture.Type` enum

**Opened:** 2026-05-19
**Status:** partially implemented

### Motivation

`TEXTURETYPE_*` are legacy numeric constants in `src/core/constants.ts`.
They are imported into `texture.ts` to tag texture formats, which is
workable but relies on an untyped numeric namespace. Moving them to a
`GpuTexture.Type` const enum (or a plain enum on the `GpuTexture`
namespace) would give call sites exhaustiveness checking and remove the
dependency on the legacy constants file from typed GPU code.

### Scope

- Done: define `GpuTexture.Type` enum in
  `src/core/renderer/gpu/texture.ts`.
- Done: replace all `vts.TEXTURETYPE_*` references in `texture.ts` with
  the new enum members.
- Done: update TypeScript call sites that create `GpuTexture` directly.
- Remaining: update legacy JavaScript map/resource call sites that pass
  `TEXTURETYPE_*` values through older texture APIs.

---

## REFACTOR: promote ui/autopilot/presenter to flat Viewer methods

**Opened:** 2026-05-14
**Status:** deferred

### Motivation

`Viewer.ui`, `Viewer.autopilot`, and `Viewer.presenter` hand the caller
entire `Browser` sub-objects whose method surfaces are untyped legacy JS.
A caller using `viewer.autopilot.flyTo(...)` works directly in the legacy
object graph, bypassing the typed `Viewer` surface. This is inconsistent
with the goal of a flat, typed public API and the AGENTS.md rule against
restoring browser-level sub-object access on `Viewer`.

### Plan

For each getter, identify every call site (demos and any consumer code).
Promote the needed operations as typed, flat methods on `Viewer`
(e.g. `flyTo()`, `stopFlight()`, `setAutorotate()` for autopilot).
Remove the getter once all call sites use the flat method.

Priority order: `autopilot` (one call site in waypoint demo), then `ui`
and `presenter` (no current typed call sites outside legacy demos).

---

## REFACTOR: replace the event bus with a typed `EventBus` class

**Opened:** 2026-05-13
**Status:** elevated to RFC — see [rfc-event-bus.md](rfc-event-bus.md)

### Motivation

`Map.on()` / `Map.once()` delegate to a plain listener array on `Core`.
The array has several bugs (broken `once()` return, `Browser.kill()`
leak, `wait` workaround) and untyped payloads.

Migrating to `EventTarget` was evaluated and rejected: `addEventListener`
does not match the MapLibre reference API, `CustomEvent` allocation on
every high-frequency emit adds GC pressure, and the adapter wrapper
layer gives no net benefit. The RFC proposes a typed `EventBus<EventMap>`
class that keeps the `on()`/`once()` surface and fixes the known bugs.

---

## BUG: runtime free layers do not render on style-based maps

**Opened:** 2026-05-14
**Status:** deferred

### Symptom

`demos/core/index.html` calls `viewer.createGeodata()` and
`viewer.addFreeLayer('route', geo.makeFreeLayer(style))` from its
`map-loaded` listener. The function fires and the geodata builder is
created, but the route is not visible.

### Root Cause

Style-based maps do not use the legacy `view.freeLayers` activation path.
`MapStyle.refreshSequences()` builds `map.freeLayerSequence` from
`style.layers`. A runtime call to `LegacyMap.addFreeLayer()` only adds
the free layer object to `map.freeLayers`; it does not add a style layer
entry, so the renderer never sees it in `map.freeLayerSequence`.

Legacy demos add a free layer in two steps:

```js
map.addFreeLayer('geodatatest', freeLayer);
const view = map.getView();
view.freeLayers.geodatatest = {};
map.setView(view);
```

That is not the right model for style-based maps, where the style is the
composition contract.

### Suggested Fix

Design a style-era runtime overlay API. It should register the geodata source
and the style layer or stylesheet needed to render it, then refresh the
style-driven sequences. Do not revive legacy `view.freeLayers` as a hidden
side effect of `Viewer.addFreeLayer()`.

### Relevant Files

| File | Note |
|---|---|
| `demos/core/index.html` | Demonstrates the missing runtime overlay path |
| `src/browser/viewer.ts` | `createGeodata` / `addFreeLayer` public methods |
| `src/core/map/style.ts` | Builds `freeLayerSequence` from `style.layers` |
| `src/core/map/map.js` | Legacy `addFreeLayer` registers only the object |

---

## BUG: `setAtmosphere` silently no-ops on styles without an `atmosphere` section

**Opened:** 2026-04-24
**Status:** deferred

### Symptom

Calling `map.setAtmosphere(spec)` on a map whose style has no `atmosphere`
section has no effect. `map.getAtmosphere()` continues to return `null` — the
setter provides no error, warning, or other indication that the call was
discarded.

### Root cause

`src/browser/viewer.ts` — `setAtmosphere`:

```ts
this._map?.atmosphere?.setRuntimeParameters(spec);
```

When the style has no atmosphere section, `this._map.atmosphere` is `null` and
the optional chain silently short-circuits. The get/set pair therefore lacks
basic symmetry: a successful `setAtmosphere` call should be reflected by a
subsequent `getAtmosphere`.

The same code path also means enabling `mapFlagAtmosphere` via
`setRenderingOptions` has no visible effect on styles that were created without
an atmosphere section — there are no parameters for the renderer to use.

### Workaround

None viable in the demo without a cartolina-js fix. Injecting a default
`atmosphere` section into the style before `cartolina.map()` does initialise
the subsystem and makes `setAtmosphere` work, but it also activates the
background sky shader unconditionally — `mapFlagAtmosphere: false` does not
suppress it. The injection was tried and reverted.

### Suggested fix

`setAtmosphere` should create the atmosphere subsystem if it does not yet
exist, rather than relying on optional chaining. `getAtmosphere` should return
the live runtime parameters set via `setAtmosphere`, not just what the original
style declared.

### Relevant files

| File | Note |
|---|---|
| `src/browser/viewer.ts:205` | `setAtmosphere` — the silent no-op |
| `src/browser/viewer.ts:212` | `getAtmosphere` — always returns null when no style section |

---

## BUG: `mapFlagAtmosphere: false` does not suppress the background sky shader

**Opened:** 2026-04-24
**Status:** deferred

### Symptom

Setting `mapFlagAtmosphere: false` in the style config suppresses terrain haze
but leaves the background sky shader active. The sky is always visible whenever
the style has an `atmosphere` section, regardless of the flag.

### Root cause (suspected)

The flag likely gates only the terrain haze pass. The background sky is a
separate render pass that checks only whether an atmosphere subsystem exists,
not the `mapFlagAtmosphere` flag.

### Expected behaviour

`mapFlagAtmosphere: false` should mean no atmosphere at all — no terrain haze
and no background sky. The flag should control both components together.

### Observed during

Relief-lab demo investigation: injecting a default `atmosphere` section into a
style that had `mapFlagAtmosphere: false` caused the background sky to appear
unconditionally. Toggling `mapFlagAtmosphere` via `setRenderingOptions` had no
effect on the background.

---

## BUG: control-mode listens for `mousewheel` instead of `wheel`

**Opened:** 2026-04-19
**Status:** deferred

### Symptom

In an embed where reveal.js sits above the cartolina container in the DOM, scroll-wheel zoom does not work when events are forwarded synthetically via `dispatchEvent`. Synthetic `WheelEvent('wheel', …)` dispatched to the map container has no effect.

### Root cause

`src/browser/control-mode/control-mode.js` line 26 registers:
```js
this.mapElement.on('mousewheel', this.onWheel.bind(this));
```

`mousewheel` is a deprecated, non-standard event. Modern browsers fire `wheel` (W3C standard) and additionally still fire `mousewheel` for legacy code when a real user scrolls — but a synthetically constructed `new WheelEvent('wheel', …)` does NOT also fire `mousewheel`. So the forwarding never reaches `onWheel`.

### Fix

Replace `mousewheel` with `wheel` in `control-mode.js`. The `wheel` event provides `deltaX`, `deltaY`, `deltaMode` (all that `onWheel` uses). If `wheelDelta` (deprecated) is referenced anywhere downstream, replace with `-deltaY * 120 / 3` (the conventional scaling).

### Relevant files

| File | Note |
|---|---|
| `src/browser/control-mode/control-mode.js:26` | the `mousewheel` listener to replace |

---

Bugs and deferred work that are not yet scheduled.

---

## FEATURE: MapLibre-style `type: 'custom'` style layer

**Opened:** 2026-05-25
**Status:** deferred — depends on style-era runtime overlay API

### Motivation

`Viewer.addOverlay(name, spec)` (added 2026-05-25, replacing the
deleted render-slot machinery) runs once per frame as the explicit
last step of the canvas-target frame. The single placement is
deliberate: pass sequencing inside the engine is in flux, and naming
internal placements on the public surface would lock the engine out
of reordering.

A MapLibre-style `type: 'custom'` style layer is the next step up.
The host registers a custom layer through `addLayer` with a render
callback; the layer takes its position in the style's layer array
and the engine guarantees order relative to other visible layers.
This expresses "draw between the bridges and the labels" through the
same vocabulary already used for declarative layers.

### Preconditions

- Pass sequencing has settled enough to make layer-relative
  placement honest. Currently terrain, label, and geodata-job
  phases are still being moved around (see the draw refactor and
  the geodata RFC).
- The style-era runtime overlay API question is resolved (see
  "BUG: runtime free layers do not render on style-based maps" in
  this file). That entry tracks the closely related question of
  how style layers are added at runtime; a custom-layer mechanism
  should land alongside it, not separately.

### Sketch

```ts
viewer.addLayer({
    id: 'my-overlay',
    type: 'custom',
    renderingMode: '2d' | '3d',
    onAdd?:  (ctx) => void,
    render:  (ctx) => void,
    onRemove?: (ctx) => void,
}, beforeId?);
```

`addOverlay` does not go away — it remains the right tool for
content that genuinely belongs on top of the whole map (debug HUDs,
host-owned post-effects) where layer-relative placement would
require inventing a sentinel layer to anchor against. The two APIs
coexist; the custom-layer API is for content that is logically part
of the map.

---

## FEATURE: explicit offscreen render-pass API

**Opened:** 2026-05-03
**Status:** deferred

### Motivation

The `GpuDevice.RenderTarget` abstraction is the right low-level direction
for multipass rendering: it separates framebuffer binding and viewport
state from the canvas element. The next layer above it must make camera
and logical-size intent explicit.

Upcoming renderer work will need offscreen rendering for:

- shadow maps
- selective blur and postprocessing ping-pong buffers
- zenith rendering for direct processing of OpenMapTiles data instead of
  server-side translations
- masks, object IDs, and G-buffer-like data for the current view
- generated lookup, normal, atmosphere, or compositing textures

The render-target regression showed why this distinction matters:
`updateLogicalSize()` silently mixed framebuffer size, camera aspect, and
screen-space matrix updates. Routing a square hitmap through it changed
the screen camera aspect to `1`, so auxiliary depth data diverged from
screen-coordinate label placement and hit testing.

### Suggested direction

Keep `GpuDevice.setRenderTarget()` as the low-level GPU operation. It
should bind the framebuffer, store the active target, and call
`gl.viewport()`. Higher-level render-pass setup should name the intended
projection policy.

Two useful categories:

- **Auxiliary target:** stores extra data for the current onscreen map
  view. It may have its own framebuffer size, but it uses the same
  camera/projection as the canvas pass. Examples: depth hitmaps, geodata
  hitmaps, object IDs, masks, and G-buffer data for the current view.
- **Independent target:** renders something whose projection is defined
  by the offscreen target itself, not by the current screen view. It may
  use a special camera, a target-aspect projection, or no scene camera at
  all. Examples: shadow maps, environment maps, postprocessing buffers,
  blur passes, lookup textures, generated normal maps, atmosphere
  textures, and compositing buffers.

The API could express this as an explicit pass target:

```ts
type RenderPassTarget = {
    texture: GpuTexture;
    viewportSize: Size2;
    logicalSize: Size2;
    projectionPolicy: 'auxiliary' | 'independent' | 'none';
};
```

Alternatively, split setup into named paths:

```ts
setAuxiliaryTarget(target);
setIndependentTarget(target);
```

The policy names mean:

- `auxiliary`: preserve the current canvas camera/projection even when
  the framebuffer has a different aspect or resolution.
- `independent`: update or choose a projection that belongs to the
  offscreen target, such as a light-space projection for a shadow map.
- `none`: the pass has no scene camera, such as a blur, lookup-table
  generation, or compositing pass.

The important rule is that multipass code must not infer projection
behavior from framebuffer dimensions. Target binding, camera aspect, and
screen-space matrices are separate decisions.

### Related notes

See [render-targets.md](render-targets.md) for the current
auxiliary-buffer policy and
[rendering-sizes.md](rendering-sizes.md) for the size vocabulary
used by render targets.

---

## DOCS: split wiki into a more hierarchical reference manual

**Opened:** 2026-04-15
**Status:** deferred

### Motivation

`docs/wiki/architecture.md` currently acts as both the main overview
page and a catch-all home for many detailed notes. As the wiki grows,
it becomes harder to navigate than a more explicit reference-manual
layout.

### Suggested direction

Restructure the wiki into a clearer hierarchy, for example:

- overview / getting-oriented pages
- architecture / cross-cutting system design pages
- subsystem notes
- feature-specific notes
- session log

Keep [architecture.md](architecture.md) as a high-level entry point,
then move narrow topics into dedicated pages linked from that
overview.

## FEATURE: pitch / horizon-based line dissipation

**Opened:** 2026-04-15
**Status:** deferred

### Motivation

Lines such as boundaries that follow ridge lines become noisy and
unnatural-looking when rendered at high oblique viewing angles or close
to the horizon.

The desired behavior is a dissipation mechanism that increases line
transparency as the camera approaches that state, either as a built-in
renderer behavior or as a style-configurable feature.

### Current limitation

The current style system does not expose camera pitch as a normal style
expression input for line color, and geodata line color is currently
resolved in worker-generated render jobs rather than evaluated per
frame.

### Suggested direction

Possible implementation directions:

- add a built-in line dissipation behavior tied to camera pitch,
  horizon angle, or a related renderer-space measure
- expose a camera-dependent style input so line opacity or color can be
  driven from style
- prefer transparency / dissipation over a hard visibility cutoff so
  ridgeline boundaries fade out naturally instead of popping

### Notes

There is already tilt-aware runtime behavior in geodata reduction, so
the renderer does have camera-angle information available. The missing
piece is a render-time color / opacity path for geodata lines.

## PERF: pre-built metatile index eliminating serve-time DEM warps

**Opened:** 2026-05-16
**Status:** implemented (2026-06-12) — RFC 7
([rfc-metanode-store.md](rfc-metanode-store.md)) landed on
`feature/metanode-store`; see its implementation notes for results
(store-served metatiles ~25 ms vs ~700 ms warp on the test sample) and
deviations. The notes here are retained as the originating discussion.

### Goal

Eliminate the GDAL DEM warp from the metatile request path by
pre-computing all metatile data at resource setup time and serving
it from a flat lookup.

### Background

See [tileserver-metatile-production.md](tileserver-metatile-production.md)
for a full description of the current pipeline.

The short version: each metatile request triggers a GDAL warp of
the VRTWO (the virtual dataset with min/max-filtered overviews).
This costs 100–500 ms per request on a warm server. The VRTWO and
the tile index together already contain all the information a
metatile carries — tile existence, watertight flags, and height
ranges. The per-request warp re-derives that information instead
of reading it from a pre-built store.

The serve-time warp is separate from the client-side ping-pong
problem (sequential metatile round-trips before geometry loading
starts). Eliminating the warp reduces per-request latency; a
manifest endpoint (a possible later stage) would reduce round-trip
count. Both improvements are independent.

### Proposal

Extend the tile index format to carry per-node height range data,
and extend `mapproxy-tiling` to populate it during the same walk
it already does. The VRTWO min/max pyramids are already the input
to the tiling step; sampling height range min/max per node adds
one read from an already-open dataset. No separate pass is needed.

At serve time, the metatile handler reads the extended tile index
and serialises the result directly. No GDAL warp occurs.

**CDN compatibility is preserved.** Metatile URLs remain keyed on
tile ID and are stable. The only change is that the origin server
answers cold misses in milliseconds instead of hundreds of
milliseconds.

### Extended tile index format

The extended index must carry, per tile node:

| Field | Source at generation time |
|---|---|
| Existence, child flags, watertight | Already in tile index (QTree) |
| Height range min/max | VRTWO min/max pyramids, read during tiling |
| Texel size | Analytical: LOD + reference frame resolution |
| SDS horizontal extents | Analytical: tile ID + division node |

The existing QTree binary format has no per-node payload beyond
flags. The new format must support per-node numeric fields. This
is a format version bump; backward compatibility requires the
server to detect which format is present and fall back to the
current on-the-fly warp path when only the old index exists.

### Relation to mapproxy-tiling redesign

`mapproxy-tiling` already takes days on large datasets due to
per-tile GDAL warps against the VRTWO. Extending it to also record
height ranges adds negligible cost to each node visit, since the
VRTWO is already open and the min/max values come from the same
sample grid the tool computes for coverage analysis.

A deeper redesign of `mapproxy-tiling` — addressing its overall
per-tile warp cost and serial bottlenecks — is a separate work
item, but it shares the same data dependency and the same output
format. A redesigned tool would produce the extended index
naturally.

### Staged rollout

1. **Pre-built metatile index** (this item). No client changes.
   Serve-time warp eliminated. CDN behaviour unchanged.

2. **Manifest endpoint** (deferred). A position-parameterised
   endpoint returning the full visible metatile tree in one
   response. This busts CDN (each position is a unique key) and
   is only viable if metatile generation is already fast — i.e.,
   after stage 1 is complete. Requires client changes to issue
   the manifest request at startup and fall back to per-tile
   fetches for incremental camera movement.

### Open questions

- **Extended index format.** Exact binary layout, versioning
  strategy, and whether the numeric payload section is
  mmap-friendly. The format should carry a version field so the
  server can detect old-format indexes and fall back to the
  current warp path during a rolling upgrade.
- **mapproxy-tiling redesign scope.** Extending the existing tool
  to write height ranges is low-risk. Whether a broader redesign
  of the tiling tool (addressing its overall per-tile warp cost)
  is done first, in parallel, or after is an open sequencing
  decision.

---

## PERF/REDESIGN: coverage-mask `mapproxy-tiling`

**Opened:** 2026-05-29
**Status:** implemented (2026-06-12) as part of RFC 7
([rfc-metanode-store.md](rfc-metanode-store.md) §4); the unified pass
is the default `mapproxy-tiling` mode (legacy analysis behind
`--legacy`). §4.5 assumptions verified on the test sample; residuals
characterized in the RFC implementation notes. The notes here are
retained as the originating discussion.

### Goal

Replace the per-tile, per-LOD GDAL warp in `mapproxy-tiling` with a
single native-resolution coverage pass plus a bottom-up reduction.
The tile index produced must be identical in meaning to today's
output (existence, watertight, navtile flags).

### Background

See [tile-index.md](tile-index.md) for what the tile index carries and
how `mapproxy-tiling` produces it today, and
[tileserver-metatile-production.md](tileserver-metatile-production.md)
for the pipeline cost.

The current tool (`mapproxy/src/tiling/tiling.cpp`) warps a 129 × 129
sample grid per tile and descends the whole tree, classifying each tile
as whole / some / none. Its watertight seal engages only once the warp
reaches native resolution, so a fully-covered but downsampled region is
warped at every LOD down to the resolution floor. On a planet-scale
dataset this runs for days to weeks. The only output is a per-tile
flag bitmask; the warped raster is discarded.

This redesign also retires the watertight-under-broadening limitation
documented in [tile-index.md](tile-index.md): because truth is computed
at native resolution and reduced upward, there is no coarse watertight
value to over-trust.

### Basis: the GDAL mask band (RFC 15)

The mechanism rests on GDAL's per-band/per-dataset mask band, defined in
GDAL RFC 15 — "RFC 15: Band masks"
(<https://gdal.org/en/stable/development/rfc/rfc15_nodatabitmask.html>).
`GetMaskBand()` always returns a `UInt8` band where **0 means nodata and
255 means valid**, and GDAL **synthesizes** it when no explicit `.msk`
file exists:

- `GMF_NODATA` — generated on the fly from the source's nodata value;
- `GMF_ALPHA` — the alpha band, which may hold values other than 0/255;
- `GMF_ALL_VALID` — an all-255 fallback when the source declares no
  nodata.

So the data-availability layer is not something this tool derives — it
is the mask band GDAL already produces. This is the entire basis of the
existence / watertight test: warp the **mask band** (not the elevation),
reduce min/max per output cell, and

- `max > 0` ⇒ at least one valid source pixel ⇒ the tile **exists**;
- `min > 0` ⇒ every source pixel valid ⇒ the tile is **watertight**.

For a binary mask (`GMF_NODATA` or `GMF_ALL_VALID`) the values are
strictly 0 or 255, so `min > 0` is identical to `min == 255` — exactly
"fully covered." A gap-free source yields `GMF_ALL_VALID`, i.e. 255
everywhere, so existence and watertight fall out with no scan of data
values at all.

**Design rule — warp the mask band with no nodata.** Do not pass
`-srcnodata` and do not set a nodata value on the mask band being
warped. A mask band has no *invalid* pixels — 0 and 255 are both valid
mask *values* — so by default the warper excludes nothing and min/max
see every pixel, including the 0s that signal holes. GDAL only excludes
source pixels when told to, via `-srcnodata`, a band nodata value, or
the band's own mask (which for a mask band is all-valid). Declaring 0 as
nodata would make the warper drop exactly the hole pixels and report
false watertight. The rule is simply not to do that.

### Proposed algorithm

1. Take the source **mask band** (`GetMaskBand`, RFC 15). No manual
   0/1 derivation, no nodata bookkeeping — the mask band is the dense
   availability raster by construction.
2. Per reference-frame division node, warp that band into the node grid
   at the resolution floor (the native-resolution LOD, which calipers
   already computes from source GSD).
3. Reduce two statistics per output cell during the warp, using GDAL's
   min/max resampling (`GRA_Min` / `GRA_Max`):
   - `max` over the cell → existence (any source pixel present);
   - `min` over the cell → watertight (all source pixels present).
   This can be one warp at sub-tile sampling reduced in code, or two
   warps (one extra source read, still far cheaper than the current
   tool). The destination is initialised to 0 so cells outside the
   source extent reduce to not-existing / not-watertight.
4. Build coarser LODs bottom-up with pure bit operations, no further
   sampling:
   - existence: `parent = OR(children)`;
   - watertight: `parent = AND(children)`.
   up to the root.
5. AND in reference-frame node validity separately (the deliberate
   fake-watertight in invalid areas). Positional flags — `navtile` at
   the analysis minimum, `atlas` rules — are set by position, not by
   sampling.

### Why it is faster

Every source pixel is read and resampled **once**, instead of being
re-resampled at each pyramid level plus overview construction. That is
the `O(levels × area)` → `O(area)` collapse where the current runtime
goes. The coarser-LOD reduction touches no source data at all.

### Parallelism

Use CPU parallelism wherever available; the work is well suited to it.

- **GDAL multi-threaded warping.** The native-resolution warp is the
  dominant cost and GDAL can multi-thread a single warp across blocks
  (`gdalwarp -multi`, warp option `NUM_THREADS=ALL_CPUS`, or the
  equivalent `GDALWarpOptions`). Enable it.
- **Across reference-frame nodes.** The per-node warps are independent
  and can run concurrently.
- **Block reduction.** The streamed blocks of the native-resolution
  mask, and the bottom-up OR/AND reduction over quadrants, are
  embarrassingly parallel; a parallel block pipeline overlaps warp I/O
  with reduction.

The current tool already parallelises its per-tile descent with OpenMP
(`mapproxy/src/tiling/tiling.cpp` lines 178-183); the redesign should
keep at least that level of CPU utilisation while removing the redundant
work. If GDAL's own threading covers the warp, additional task
parallelism need only cover the reduction and the per-node fan-out —
confirm the two layers do not oversubscribe cores.

### Assumptions to test before committing

These are the load-bearing claims; the RFC should verify each
empirically (e.g. `gdalwarp -r min` / `-r max` on a small DEM tile,
diffed against the current tool's flags for the same extent):

- **GDAL min/max resampling aggregates over the full destination
  footprint** for a downsampling warp, not a subsample. Needs
  confirmation at extreme downsample ratios.
- **Boundary / straddle semantics**: whether a source pixel straddling
  a tile edge is counted by overlap or by centre. This affects
  watertight exactly at tile edges. Verify against a hand-reduced
  reference.
- **Alpha masks**: for `GMF_ALPHA` sources the mask may hold values
  between 0 and 255, so `min > 0` no longer equals "fully valid." Such
  sources need a threshold (e.g. `min == 255`) or explicit handling.
  DEMs are typically `GMF_NODATA` / `GMF_ALL_VALID`, where this does not
  arise.
- **Read-once floor**: 1 px/tile output does not reduce source reads
  (the warper still scans every source pixel); the saving over a
  high-resolution mask is intermediate size and memory, not source I/O.
  The saving over the current tool — reading the source once instead of
  per level — is the real win and is unaffected.
- **Empty-region pruning**: the current descent skips empty areas
  (ocean) cheaply. A full-extent native pass must recover this, e.g.
  bound by the source footprint and/or a coarse existence pre-pass, or
  it will process empty area it does not need to.

### Relation to other items

This shares the data dependency and output format of **PERF: pre-built
metatile index** (this file). The bottom-up reduction can carry per-node
height-range min/max in the same pass — the VRTWO min/max pyramids are
the input either way — producing the extended index that item needs.
Sequencing of the two is open.

### Open questions

- Whether GDAL's stock min/max resampling is trustworthy enough or a
  custom warp kernel (emitting both stats in one pass) is warranted.
- Streaming strategy: the native-resolution coverage band for a planet
  cannot be materialised whole; it must be processed in blocks reduced
  into the pyramid, as overview construction already does.
- Output format: whether to keep the current QTree format or move to
  the extended per-node format from the pre-built metatile index item.

---

## BUG: `Viewer.checkVisibility()` depth comparison is broken

**Opened:** 2026-04-14
**Status:** deferred — method kept on the API surface but marked
experimental; the waypoint demo was reverted to not use it.

### Symptom

For a point sitting on the terrain surface the comparison always fails:
`pointDepth` is consistently 700–10 000 m larger than `screenDepth`,
so the method returns `false` (occluded) even when the point is plainly
visible.

### Root cause (confirmed by instrumentation, 2026-05-04)

`screenDepth` and `pointDepth` measure different things when vertical
exaggeration (super-elevation) is active.

* **`screenDepth`** — decoded from the hitmap texture. The GPU shader
  writes the Euclidean distance from the camera to each rendered terrain
  fragment. Because VE is applied on the GPU, this distance is to the
  **visually rendered (VE-exaggerated) surface**.

* **`pointDepth`** — computed as
  `Math.hypot(...convertCoordsFromPhysToCameraSpace(physPos))`.
  `convertCoordsFromPhysToCameraSpace` subtracts `map.camera.position`
  from the physical (ECEF) world-space point. `getHitCoords` adds the
  same quantity when reconstructing position from the hitmap, so the
  two operations cancel and the coordinate arithmetic is correct.
  However, `getHitCoords` applies `getUnsuperElevatedHeight` before
  returning nav coords, stripping the VE height offset. When those
  SE-adjusted nav coords are converted back to phys and then to
  camera-space, the result is the distance to the **true geographic
  surface**, not the rendered one.

Verified by disabling VE at runtime: with VE off and `dilate=0`,
`pointDepth` and `screenDepth` are identical. With VE on the gap is
proportional to VE scale; at the test position (~33 km view distance)
it was ~503 m.

The camera-origin mismatch described in the earlier analysis was
incorrect: `map.camera.position` is the correct reference, and
`convertCoordsFromPhysToCameraSpace` produces the right result. The
`// mmm` comment in `convert.js:280` refers to a different code path.

### Suggested fix direction

`checkVisibility` must compare in the same domain. Two options:

1. **Compare in the rendered domain.** Get the screen pixel the point
   projects to, sample `getScreenDepth` there, then compare against the
   distance from the camera to the VE-adjusted position of the point.
   Requires applying VE to the point's position before computing
   `pointDepth`.

2. **Compare in the geographic domain.** Use `getHitCoords` at the
   projected screen pixel to get the true surface position, convert to
   phys, compute camera-space distance, and compare against the same for
   the input point. Both values are then geographic distances with VE
   stripped out.

### Relevant files

| File | Note |
|---|---|
| `src/browser/viewer.ts` | `checkVisibility()` — the broken method |
| `src/core/map/map.js` | `convertCoordsFromPhysToCameraSpace` |
| `src/core/map/convert.js:258` | `getPositionCameraSpaceCoords` (flagged comment) |
| `src/core/map/camera.js` | `MapCamera.update()` — shows GL eye is at `[0,0,0]` |
| `src/core/renderer/gpu/shaders.js:850` | shader writes `camDist = length(camSpacePos.xyz)` |
| `src/core/renderer/renderer.ts:1828` | `getDepth()` — decodes hitmap pixels |
| `demos/waypoint/waypoint.js` | the demo that was reverted |

---

## REFACTOR: replace per-frame token expiry polling with a
`transformRequest`-style auth hook

**Opened:** 2026-05-16
**Status:** deferred

### Background

`src/core/core.js` contains a bespoke tile-auth mechanism inherited from
the VTS/mapy.com era. On startup it fetches an authorization endpoint
(`config.authorization`, a URL or callback) which returns
`{ token, header, expires, cookieInjector }`. The token and header are
injected into every subsequent XHR via `this.xhrParams`. A separate
`cookieInjector` path handles image-tile fetches that cannot carry custom
headers.

`src/core/map/map.js` — `Map.prototype.update` — polls `tokenExpiration`
on every animation frame. Once the token is within 60 seconds of expiry
the callback fires, clears `tokenExpiration`, sets `tokenExpirationLoop`,
and re-fetches the auth endpoint. Until the new token arrives the poller
fires every frame (~60 calls/second), relying on `tokenExpiration` being
`null` to suppress re-entry.

### Why it should be replaced

The two-channel scheme (XHR params + cookie injector) and the frame-loop
poller are workarounds for the absence of a first-class request intercept
hook. MapLibre GL JS solves this cleanly with `transformRequest`: a
callback invoked for every outgoing resource request that can add headers
or rewrite URLs. Token refresh is then a plain `setTimeout` registered
when the token is first received — no render-loop involvement needed.

### Suggested direction

1. Add a `transformRequest` hook (signature mirrors MapLibre) that the
   host app supplies instead of `config.authorization`.
2. The hook receives `(url, resourceType)` and returns
   `{ url, headers }`. It is responsible for token lifecycle, including
   refresh scheduling via `setTimeout`.
3. Remove `tokenExpiration`, `tokenExpirationCallback`,
   `tokenExpirationLoop`, the `xhrParams` token fields, the cookie
   injector path, and the per-frame check in `map.update`.
4. Provide a helper (not required by the API) that wraps a token endpoint
   URL and implements the 60-second pre-refresh logic via `setTimeout`,
   returning a `transformRequest`-compatible function.

### Relevant files

| File | Note |
|---|---|
| `src/core/core.js:229–231` | `tokenExpiration`, `tokenExpirationCallback`, `tokenExpirationLoop` fields |
| `src/core/core.js:275–308` | `onAutorizationLoaded` — sets up token and callback |
| `src/core/core.js:351–357` | initial auth fetch |
| `src/core/map/map.js:1451–1455` | per-frame expiry check in `update()` |


## BUG (tileserver): surface generator emits a zero-submesh mesh

**Opened:** 2026-06-06
**Status:** deferred
**Repository:** cartolina-tileserver (mapproxy `surface` generator)
**Related:** client workaround landed in
[draw-tiles.js](../../src/core/map/draw-tiles.js) (the
`surfaceMesh.loadState == 2` early return in `drawSurfaceTile`)

### Symptom

A `surface-dem` resource can serve a tile whose metatile metanode has the
`geometry` flag set while the matching `.bin` mesh contains zero
submeshes. The mesh is structurally valid (the VTS header reports
`numSubmeshes = 0`), so it is not malformed in the format sense, but it
is inconsistent with the metatile that advertises geometry.

Observed on the global `topoearth/viewfinder-dem1` surface (a sparse DEM
whose tile index was extended upward with `vts complete-tileindex-up`).
The melown2015 root splits at lod 1 into three division-node subtrees
(pseudomerc, north UPS, south UPS). The north-UPS root tile `1-0-1` is
flagged with geometry and real height extents in the metatile, but its
mesh decodes to 14 bytes — a valid header with zero submeshes.

### Root cause

The metatile geometry flag comes from the tile index and the metatile's
own 8×8 per-tile sampling
(`metatileSamplesPerTile = 1<<3`), which finds valid heights for the
node. The mesh is built separately at 128×128 via
`Operation::demOptimal`, and the delivery path adds a submesh only when
the sampled local mesh has vertices:

`mapproxy/src/mapproxy/generator/surface.cpp` (`SurfaceBase::generateMesh`)

```cpp
vts::Mesh mesh(false);
if (!lm.mesh.vertices.empty()) {
    auto &sm(addSubMesh(mesh, lm.mesh, nodeInfo, lm.geoidGrid, textureMode));
    ...
}
```

When that warp yields no vertices the output mesh keeps zero submeshes.
The two products (metatile, mesh) sample the dataset differently and can
disagree about coverage for a coarse node, producing the mismatch.

(A raw 128×128 warp of `1-0-1` actually returns ~22.8% valid pixels, so
the node is not even genuinely empty — the empty mesh is itself
questionable, separate from the consistency issue.)

### Impact

A geometry-flagged tile backed by a zero-submesh mesh can never become
render-ready on the client, because the mesh has nothing to draw. The
legacy topdown traversal descends the root only when every division-node
sibling is ready, so one such sibling stalls the whole surface (blank
globe). Worked around client-side for the legacy path; the recursive
path tolerates it.

### Suggested direction

A surface generator should always emit exactly one submesh. The cleanest
fix is in `SurfaceBase::generateMesh`: add the submesh unconditionally
(an empty submesh with zero faces is acceptable), or otherwise reconcile
the metatile `geometry` flag with the actual mesh content so the two are
never inconsistent. Empty submeshes need a sane bounding box — an empty
`extents()` returns inverted/sentinel values — and the coverage-mask,
normal-map, and watertight/multimesh paths must tolerate the empty case.

### Relevant files

| File | Note |
|---|---|
| `mapproxy/src/mapproxy/generator/surface.cpp` | `SurfaceBase::generateMesh` — submesh added only if `!lm.mesh.vertices.empty()` |
| `mapproxy/src/mapproxy/generator/surface-dem.cpp` | `generateMeshImpl` — 128×128 `demOptimal` warp |
| `mapproxy/src/mapproxy/generator/metatile.cpp` | metatile geometry flag from index + 8×8 sampling |
| `mapproxy/src/mapproxy/support/mesh.cpp` | `addSubMesh`, `meshFromNode` |

## PERF (tileserver): pool unified-pass warps across division nodes

**Opened:** 2026-06-12
**Status:** deferred until a multi-node planetary run shows the need.

The RFC 7 unified tiling pass runs its four filter passes (mask
min/max, elevation min/max) concurrently *within* one reference-frame
division node, but division nodes are processed sequentially. Treating
all `(division node, pass)` warps as one task pool with a small
concurrency cap (~6; the work is source-read/decompress bound, so more
would queue on IO) would overlap the node tails — a bounded ~15-20%
win on melown2015 (the pseudomerc node dominates, polar caps are
small), but potentially much more on **earth-qsc**, whose six
similar-sized QSC faces currently serialize. The refactor is
contained: split `processNode` (`mapproxy/src/tiling/unified.cpp`)
into a warp stage and a reduce/emit stage and gate the pool with a
semaphore; per-node grids would coexist, so mind peak memory on
planet-scale leaf grids (~0.7 GB per melown2015-sized node).

Decide after measuring the earth-qsc planetary tiling wall time; if
it is acceptably short, this stays deferred (premature-optimization
rule).

## BUG/INVESTIGATE (tileserver): mesh content contradicts metatile flags at RF-validity boundaries

**Opened:** 2026-06-12
**Status:** deferred — diagnosis only, surfaced by the RFC 7 polar
parity check ([rfc-metanode-store.md](rfc-metanode-store.md)
implementation notes).
**Related:** "surface generator emits a zero-submesh mesh" above —
likely the same mechanism observed at its extreme.

### Symptom / mechanism

The tile index (and therefore the served metatile flags) and the mesh
generator answer "what is in this tile" by different rules. The tile
index marks reference-frame-invalid areas of productive division
subtrees watertight (the legacy tiling's explicit "fake watertight
subtree in invalid part of a tree" lie; the unified pass reaches the
same flags on filled sources because the warped mask genuinely covers
the whole node square). The mesh generator, however, clips geometry by
RF-node validity (`generateCoverage` over the NodeInfo coverage mask).
Consequences, verified on the melown2015 polar caps of the planetary
viewfinder-dem3 tiling:

- tiles straddling the division-node constraint boundary (~±85.05 deg)
  serve **clipped meshes under a watertight metanode** — the client
  trusts the flag, skips fallback handling, and the clipped edge can
  produce the known boundary artifacts at the rf-node seam;
- tiles wholly outside the valid area but inside the watertight-lied
  subtree can serve **empty (zero-submesh) meshes under geometry +
  watertight flags** — presumably the zero-submesh bug above.

### Open questions

- What should the contract be? Either flags follow the clipped reality
  (partial/absent at the boundary — but partial tiles trigger fallback
  rendering whose resolution spills over the seam, the original
  artifact), or meshes stop clipping at the boundary (watertight seam,
  at the cost of duplicate geometry and possible z-fighting on rf-node
  overlaps). Neither is obviously right; needs a worked decision.
- Whether the metanode-store pipeline should bake RF validity into the
  mask passes once the contract is decided (the unified pass currently
  reproduces the legacy flags).

Out of scope for RFC 7; flags-vs-mesh consistency is a pipeline-wide
contract question.

## PERF (tileserver): spatially varying bottom lod — prune subtrees beyond source resolution

**Opened:** 2026-06-12
**Status:** deferred; needs a per-resource opt-in design.

Pseudomercator's sec(lat) inflation means same-lod tiles cover ~11x
less ground at 85 deg than at the equator, so a global lodRange keeps
high-latitude subtrees descending several lods past the source's
native resolution. Both client and server then traverse, request, and
generate tiles that add no terrain information (interpolated meshes,
upsampled normals) — wasted bandwidth and cycles on both ends.

Idea: prune the tile tree spatially during tiling — stop emitting
children once per-tile sampling reaches the source resolution. The
RFC 7 unified pass already computes the signal per tile (the
`truescale` measure driving the navtile bit); the prune is a cutoff in
the emission loop, and the metatile tree, tile index and store stay
consistent by construction. Clients handle spatially varying leaf
depth the same way they handle today's lodRange bottom.

Design refinement: the bound-layer headroom is *relative*, not
absolute. Draped imagery is textured per surface tile id, so an
orthophoto finer than the DEM needs surface tiles past terrain-native
resolution — but the imagery's tiles live on the same pseudomerc grid
and stretch by the same sec(lat) factor, so the needed margin is a
latitude-invariant number of extra lods. One per-resource parameter
covers it: prune children where `truescale >= 2^k`, with `k` the
configured resolution-margin lods (k = 0 prunes at terrain-native;
today's behavior is k = infinity). The surface still cannot know what
will be draped on it, so `k` is an operator setting in the resource
definition.

Remaining caveat: **leaf triangle budget** — mesh simplification
budgets faces per tile, so a native-resolution leaf stretched over a
close-up view renders coarser geometry than today's re-meshed
interpolated children. May need a larger face budget on pruned
leaves.

