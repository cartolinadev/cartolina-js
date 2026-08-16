# Task backlog archive

Backlog entries from [backlog.md](backlog.md) that are resolved, implemented, or
closed for another reason (superseded, promoted to an RFC, subsumed by another
change). Entries keep the sequential number they were assigned in the active
backlog, in order of when they were opened; numbers are not reused.

## 29. REFACTOR: drop metatile format versions 1–3

**Opened:** 2026-05-27
**Status:** resolved 2026-08-16 — the parser now rejects anything outside
versions 4–6

### Goal

Remove all client-side code paths that exist only to handle metatile
format versions 1, 2, and 3.

### Rationale

The mapy.com production deployment serves version 4, confirmed by
inspecting live responses (2026-05). No known live data source produces
versions 1–3. The v1–v3 code paths carry meaningful complexity:

- Quantized physical extent decoding in
  `MapMetanode.prototype.parseMetanode()` —
  [src/map/metanode.js](../../src/map/metanode.js)
- Aliasing `minZ`/`maxZ` to the int16 navSRS `minHeight`/`maxHeight`
  instead of reading explicit float32 SDS values
- `MapSurfaceTree.prototype.updateNodeHeightExtents()` in
  [src/map/surface-tree.js](../../src/map/surface-tree.js)
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
  [src/map/metanode.js:211](../../src/map/metanode.js)
- `MapSurfaceTree.prototype.updateNodeHeightExtents()` and all its
  call sites in the legacy and typed traversals — this propagation
  exists only because the alias above produces unreliable height ranges
  for pre-v4 tiles and children need to inherit from the nearest
  navtile-flagged ancestor —
  [src/map/surface-tree.js:157](../../src/map/surface-tree.js)
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

**Resolution:** the parser now rejects any version outside 4–6. The
pre-v4 branches took their surrounding version guards with them, which
in turn collapsed the culling, texel-size, bbox-drawing, and
height-range propagation paths those guards selected, plus the four
config keys that only tuned pre-v4 behaviour. The precondition holds
for the public test map configs: every surface and glue in
[test/urls.json](../../test/urls.json) serves v6.

---

## 35. PERF: discard-free tile color shader for watertight tiles

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

**Update 2026-06-08:** the legacy-traversal removal (rfc03-draw-traversal
step 8) landed. `splitMask`, the `uClip` set, the `applyTileClip`
quadrant clip, and `tile-clip.inc.glsl` are gone; `TileRenderRig.draw()`
now selects on `!!maskTexture`, and the discarding program's only
`discard` is the `uMaskEnabled` coverage test.

## 34. PERF: draw-traversal — empty-quadrant fold

**Opened:** 2026-06-04
**Status:** resolved 2026-06-05 — implemented via the gap/empty coverage
split; on `simple.json` `recursive` now matches `legacy` exactly (mask
draws 50→0, framebuffer switches 100→0, drawn tiles 193→170, GPU
parity). See the §2.1 post-implementation note and the session log.
**Related:** [rfc03-draw-traversal.md](rfc03-draw-traversal.md)

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
[draw-traversal.ts](../../src/map/draw-traversal.ts). The residual
cost is fill and blit quads plus their clears.

### Root cause

A node propagates watertight coverage with no mask only when all four
child quadrants come back watertight
([draw-traversal.ts:203](../../src/map/draw-traversal.ts)). Because
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

## 33. BUG: superelevation — debug bbox heights baked at stale zoom

**Opened:** 2026-05-31
**Status:** fixed 2026-05-31 (per-node factor invalidation); verified in
browser — all drawn LOD-15 tiles match the reload bake after a zoom-in
**Related:** [rfc03-draw-traversal.md](rfc03-draw-traversal.md)

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
[src/renderer/renderer.ts:1657](../../src/renderer/renderer.ts).

The terrain surface applies exaggeration on the GPU every frame at the
live position, so it always matches the current zoom. The cull box and
debug box use `bbox2`, whose exaggerated `minZ`/`maxZ` are baked in
`MapSurfaceTile.isMetanodeReady` only when
`tile.seCounter != renderer.seCounter` —
[src/map/surface-tile.js:341](../../src/map/surface-tile.js).
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
[src/map/surface-tile.js:646](../../src/map/surface-tile.js),
`pointsVisible(node.bbox2, …)`. A stale-baked `bbox2` mis-sizes culling
against an exaggeration that no longer matches the live surface, so this
is not only a debug-overlay artifact.

### Fix (implemented, verified)

Per-node factor invalidation in `MapSurfaceTile.isMetanodeReady`
([surface-tile.js:341](../../src/map/surface-tile.js)): each
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

## 28. BUG: draw-traversal — mask fails for internal-texture surfaces

**Opened:** 2026-05-27
**Status:** resolved 2026-05-28 — `rt.externalUVs` and `rt.internalUVs`
made data-based in `TileRenderRig`; benatky regression confirmed clean
**Related:** [rfc03-draw-traversal.md](rfc03-draw-traversal.md);
[27. BUG: draw-traversal — black flashes when zooming into city surface](#27-bug-draw-traversal--black-flashes-when-zooming-into-city-surface)
and
[26. BUG: draw-traversal — aborted descents at very high LODs](#26-bug-draw-traversal--aborted-descents-at-very-high-lods)
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

## 27. BUG: draw-traversal — black flashes when zooming into city surface

**Opened:** 2026-05-27
**Status:** resolved 2026-05-28 — confirmed manifestation of mask bug;
resolved by same fix
**Related:** [rfc03-draw-traversal.md](rfc03-draw-traversal.md)

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

## 26. BUG: draw-traversal — aborted descents at very high LODs

**Opened:** 2026-05-27
**Status:** resolved 2026-05-28 — confirmed manifestation of mask bug;
resolved by same fix
**Related:** [rfc03-draw-traversal.md](rfc03-draw-traversal.md)

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

## 25. BUG: draw-traversal phase 2 — front surface overlaps back surface on +x/+y edges

**Opened:** 2026-05-27
**Status:** resolved 2026-05-28 — mask filter switched to LINEAR
**Related:** [rfc03-draw-traversal.md](rfc03-draw-traversal.md) phase 2

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
post-implementation notes in [rfc03-draw-traversal.md](rfc03-draw-traversal.md)
for the full explanation and the discard-threshold tuning knob.

---

## 30. BUG: TileRenderRig — internal texture missing from layer stack

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

## 17. FEATURE: freeze mode for viewport diagnostics

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

`src/map/freeze-camera-state.ts` owns the captured camera state.
The typed `Map` (`map.ts`) owns the `FreezeCameraState` instance
(`map.freeze`) and the `withSelectionCamera` / `withNavigationCamera`
methods. Legacy draw code reaches them via `legacyMap.outerMap.freeze`
and `legacyMap.outerMap.withXxxCamera(...)`. Final terrain and geodata
rendering use the navigation context for camera matrices while passing
the selection position to `Renderer.updateBuffers()` or `drawGpuJobs()`
so scale-dependent vertical exaggeration follows the selected tile set.
`src/inspector/freeze.ts` owns mode state, DOM controls, and
frustum capture. `Renderer` draws the frustum with the modern
`useProgram2` shader path.

---

## 21. REFACTOR: remove OGC 3D Tiles streaming mechanism

**Opened:** 2026-05-21
**Status:** implemented by [rfc05-remove-3dtiles.md](rfc05-remove-3dtiles.md)

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

- `src/map/geodata-import/3dtiles.js` — v1 importer (unused;
  import already commented out in `geodata-builder.js`)
- `src/map/geodata-import/3dtiles2.js` — v2 importer (active)
- `src/map/geodata-processor/worker-main.js` — the
  `nodes[].meshes[]` dispatch block (lines ~445–452)
- `src/renderer/gpu/group.js` — `GpuGroup.prototype.drawMesh`
  (lines 1287–1305), the `binFiles`/`binPath` streaming machinery
  (lines ~1600–1850), and the `direct-3dtiles` loader calls
- `src/map/loader/loader.js` — the `'direct-3dtiles'` case
  (line 189)
- `src/viewer/browser.js` — the `config.tiles3d` branch (lines ~148–151)
- `geodata-builder.js` — the commented-out `load3DTiles` / `import3DTiles`
  methods and the `binPath` field (lines ~1474–1491, 1942–1943)
- `geodata-view.js` — the `directBinParse` path and the
  `geodata['binPath']` check (lines ~252–256, 273–274)

Once those callers are gone, `MATERIAL_INTERNAL` in `mesh.js` and
`progTile[v]` in `init.js` / `renderer.ts` also lose their last
terrain-code consumer and can be removed in the same pass. Replay and
the public custom-mesh demos no longer keep `Renderer.drawMesh()` alive.

---

## 20. REFACTOR: delete legacy tile shader family

**Opened:** 2026-05-21
**Status:** implemented by [rfc05-remove-3dtiles.md](rfc05-remove-3dtiles.md)
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

## 18. REFACTOR: delete legacy mesh tile rendering pipeline

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
geodata mesh jobs in `src/renderer/gpu/group.js` still call it, and
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

The draw refactor (steps 2–4 of
[15. REFACTOR: replace legacy map draw path with `TileRenderRig`](#15-refactor-replace-legacy-map-draw-path-with-tilerenderrig))
touches the same files and traversal logic. Removing dead code first
keeps the diffs readable and avoids carrying old branches through a
restructuring only to delete them on the other side.

---

## 24. REFACTOR: delete `MapInterface`

**Opened:** 2026-05-25
**Status:** done — 2026-05-26, no design overlap with
[rfc06-map-frame.md](rfc06-map-frame.md)

### Goal

Delete `src/map/interface.js`. It was a thin layer that delegated
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
by [rfc06-map-frame.md](rfc06-map-frame.md). Keeping it as an independent
track avoided inflating the RFC's scope.

---

## 9. REFACTOR: replace the event bus with a typed `EventBus` class

**Opened:** 2026-05-13
**Status:** elevated to RFC — see [rfc02-event-bus.md](rfc02-event-bus.md)

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

## 6. BUG: `setAtmosphere` silently no-ops on styles without an `atmosphere` section

**Opened:** 2026-04-24
**Status:** fixed 2026-07-28 — the `Atmosphere` subsystem is now created
at style load whenever the reference-frame body carries atmosphere
parameters and the `atmdensity` service is available, independent of the
style's `atmosphere` section ([style.ts](../../src/map/style.ts)). The
section now only supplies parameters; visibility is governed by
`mapFlagAtmosphere`, which defaults to off when the style declares no
`atmosphere` section. `setAtmosphere` / `getAtmosphere` are therefore
symmetric on any atmosphere-capable body, and `Map.setAtmosphere` warns
instead of silently discarding the call when the body cannot render an
atmosphere at all.

### Symptom

Calling `map.setAtmosphere(spec)` on a map whose style has no `atmosphere`
section has no effect. `map.getAtmosphere()` continues to return `null` — the
setter provides no error, warning, or other indication that the call was
discarded.

### Root cause

The atmosphere subsystem was only constructed at style load when the style
declared an `atmosphere` section. `setAtmosphere` / `getAtmosphere`
optional-chained into the missing subsystem, so the set was silently
discarded and the get/set pair lacked basic symmetry. Enabling
`mapFlagAtmosphere` via `setRenderingOptions` likewise had no visible
effect — there was no subsystem for the renderer to use.

---

## 5. BUG: `mapFlagAtmosphere: false` does not suppress the background sky shader

**Opened:** 2026-04-24
**Status:** fixed 2026-07-07 — the background draw call in
[map.ts](../../src/map/map.ts) now checks the same runtime override /
config flag as the tile-shader haze layer before calling
`renderer.drawBackground()`

### Symptom

Setting `mapFlagAtmosphere: false` in the style config suppresses terrain haze
but leaves the background sky shader active. The sky is always visible whenever
the style has an `atmosphere` section, regardless of the flag. The same gap
also meant the `Shift+F A` diagnostic toggle silenced only the terrain haze,
not the background sky.

### Root cause

The flag only gated the terrain haze pass, via the per-frame `renderFlags`
check in the tile shader. The background sky was drawn from a separate call
site (`Map.draw` in map.ts) guarded only by `Map.isAtmospheric()`, a legacy
helper that checked subsystem existence and the iOS gray-PNG decode bug but
never consulted `mapFlagAtmosphere` or its runtime override.

### Fix

`Map.isAtmospheric()` was removed — it conflated three unrelated checks
(iOS decode support, subsystem existence, and implicitly the flag it never
checked). Both call sites now inline what they actually need:
`Map.draw` in map.ts checks the runtime/config atmosphere flag, iOS decode
support, and subsystem existence before drawing the background; the haze
layer inclusion in `TileRenderRig`'s `buildLayerStack`
([tile-render-rig.ts](../../src/map/tile-render-rig.ts)) checks iOS
decode support and subsystem existence only, since the flag is already
applied per-frame via `renderFlags`.

### Observed during

Relief-lab demo investigation: injecting a default `atmosphere` section into a
style that had `mapFlagAtmosphere: false` caused the background sky to appear
unconditionally. Toggling `mapFlagAtmosphere` via `setRenderingOptions` had no
effect on the background.

---

## 14. DONE: public `transformRequest` hook

**Opened:** 2026-05-16
**Status:** implemented 2026-06-19

### Resolution

`transformRequest(url, resourceType)` is now accepted by `map()` and
`browser()`. It returns `{ url, headers?, credentials? }` and is applied
to engine JSON, binary, HEAD, image, glyph, and worker-routed loader
requests. Worker requests are transformed on the main thread before
posting to the loader worker.

Token lifecycle is host-application responsibility. Keep current tokens
in application state and read them inside the request transform callback.

---

## 3. DOCS: split wiki into a more hierarchical reference manual

**Opened:** 2026-04-15
**Status:** resolved 2026-08-09 — `index.md` is now organized into
thematic sections (Overview, Data model, Rendering, RFC archive, and
more) rather than a flat list, and `architecture.md` is a lean entry
point that links out to topic pages instead of holding their content
itself. The one remaining gap — `index.md`'s own "Writing guidelines"
noting that subsystem (level 2) and topic (level 3) pages are not yet
cleanly separated — is a smaller, narrower point than what this entry
tracked and is not carried forward as its own entry.

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

---

## 10. REFACTOR: replace glues and virtual surfaces with client-side surface composition

**Opened:** 2026-05-13
**Status:** resolved by
[rfc03-draw-traversal.md](rfc03-draw-traversal.md) (Implemented) —
"Replace server-side seam stitching with client-side mask
compositing, eliminating the need to generate or serve glue
tilesets." The client no longer performs glue-based compositing;
remaining `glue`/`virtualSurfaces` references in
`src/compat/mapconfig-to-style.ts` and `src/map/map.ts` are explicit
skip/exclude cases, not stitching logic. The concept is retained as a
server-side/historical record in
[glue-alien-flag.md](glue-alien-flag.md) and
[vts-storage-and-virtual-surfaces.md](vts-storage-and-virtual-surfaces.md).

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

## 15. REFACTOR: replace legacy map draw path with `TileRenderRig`

**Opened:** 2026-05-16
**Status:** resolved — all four plan steps done. Step 2 was promoted
to [rfc06-map-frame.md](rfc06-map-frame.md) (Implemented); step 3 was
implemented by [rfc03-draw-traversal.md](rfc03-draw-traversal.md)
(Implemented), whose own **Context** line names this entry; step 4
(deleting the old draw path) landed as part of that RFC's rollout
(step 8) — the `mapTerrainTraversal` legacy/recursive switch is gone
from the source and no dual traversal path remains.

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
   **Done** (2026-05-26) — see [rfc06-map-frame.md](rfc06-map-frame.md).

   `MapDraw.drawMap` moved into `Map.draw`;
   `LegacyMap.update` moved into `Map.tick`, with a residual
   `LegacyMap.tick` for the loader / worker / deferred-event work
   not yet promoted. Audited and relocated post-`55a34f27`
   additions on `LegacyMap` (`drawChannel`, overlay registry,
   `initFrame`, position accessors). `MapInterface` deletion completed
   as an independent track — see
   [24. REFACTOR: delete `MapInterface`](#24-refactor-delete-mapinterface).

3. ~~Implement the new unified traversal per
   [rfc03-draw-traversal.md](rfc03-draw-traversal.md).~~ **Done** —
   RFC 3 is Implemented.

4. ~~Delete obsolete rendering code.~~ **Done** as part of RFC 3's
   rollout (step 8): the old tile rendering path, old draw variants,
   obsolete shaders, and inspector-only branches with no remaining
   caller were removed.

### Follow-up order

After this refactor reaches the deletion pass, continue with:

1. [rfc02-event-bus.md](rfc02-event-bus.md)
2. [rfc01-config-store.md](rfc01-config-store.md)
3. Removing the `Map.core` escape hatch from `Viewer`
4. Designing a style-era runtime overlay API
