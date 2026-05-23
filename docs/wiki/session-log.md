# Session log

## 2026-05-23 — Dead legacy renderer shaders removed

Removed legacy shader strings whose only references were unused program
initializers or commented-out initializer lines:
`skydomeVertexShader`, `stardomeFragmentShader`,
`pointsVertexShader`, `pointsFragmentShader`, `text2VertexShader`,
`etlineVertexShader`, and `etplineVertexShader`.

The cleanup also removed `progStardome`, `progPCloud`,
`RendererInit.initSkydome`, `RendererDraw.drawSkydome`,
`RendererDraw.drawTBall`, the skydome mesh field, and the now-unused
skydome sphere geometry helpers. `drawSkydome` had no runtime effect:
`paintGL` called it without a texture, and the method returned before
issuing any GL work. `progPCloud` had no draw-time references after the
3D Tiles / point-cloud path was deleted.

Verification passed: no source references remain for the deleted names;
`npx tsc --noEmit`; and sequential screenshots for `simple-terrain`,
`complex-terrain`, and `full-terrain`. The `complex-terrain` and
`full-terrain` screenshot checks each passed on rerun after transient
CDN tile-fetch errors.

## 2026-05-23 — OGC 3D Tiles and tile shader removal implemented

Implemented [rfc-remove-3dtiles.md](rfc-remove-3dtiles.md). Deleted the
client-side OGC 3D Tiles / VTS octree import path, including the
`config.tiles3d` browser entry point, `direct-3dtiles` loader worker
branch, node-shaped geodata dispatch, `GpuGroup` octree traversal,
point-cloud resource path, and the three importer files under
`src/core/map/geodata-import/`.

The deletion removed the last caller of `MapMesh.drawSubmesh`, so the
removable legacy tile shader family also went away: `drawSubmesh`,
`generateTileShader`, `progTile*`, `progDepthTile`,
`progFlatShadeTile`, `progWireFrameBasic`, `MATERIAL_INTERNAL`, and the
debug polygon wire branch that depended on `progWireFrameBasic`.
`progCFlatShadeTile` and `tileVertexShader` / `tileFragmentShader`
remain because geodata polygon flat shading still uses them.

Verification passed: RFC grep gates for 3D Tiles, node worker types,
octree config/debug flags, and removable shader names; `npx tsc
--noEmit`; and sequential screenshots for `simple-terrain`,
`complex-terrain`, and `full-terrain`.

## 2026-05-23 — OGC 3D Tiles RFC accepted

`docs/wiki/rfc-remove-3dtiles.md` status set to `Accepted` by reviewer
after round 3. Implementation (`§3.1`–`§3.2` deletion pass, then
`§3.3` shader-family pass) is next.

## 2026-05-23 — OGC 3D Tiles RFC: review round 3

Review round 3 found two blockers and one non-blocking note.

Blocker 1: `progWireFrameBasic[SE]` were listed in the round-2
"not removable" note but are already broken in `draw.js`. `init.js`
initializes `progWireFrameBasic` as a variant array; `draw.js` passes
it to `gpu.useProgram` as a direct `GpuProgram`. `progWireFrameBasicSE`
is never initialized. The branch is guarded by `drawPolyWires`, which
defaults to false. The only working caller of the array form is
`mesh.js:drawSubmesh` (the octree path). §3.3 now deletes both
programs, `GpuShaders.tileWireFrameBasicShader`, and the `draw.js`
`drawPolyWires` debug branch together. `progCFlatShadeTile[SE]` and
the tile shader strings still survive.

Blocker 2: §4 verification commands used `grep -r src/ test/ demos/`
(pattern and path swapped). Fixed to `rg -n PATTERN src test demos`
with alternation groups.

Non-blocking 3: Status line was `In review (round 2 responded)`,
which no longer matched the defined lifecycle values. Restored to
`In review`.

## 2026-05-23 — OGC 3D Tiles RFC: review round 2

Review round 2 found two blockers and two non-blocking notes.

Blocker 1: `progCFlatShadeTile[SE]` and `progWireFrameBasic[SE]` are
still used in `draw.js` for geodata polygon flat-shading and debug wire
drawing. Both compile against `GpuShaders.tileVertexShader` and
`tileFragmentShader`. §3.3 narrowed to exclude those programs and the
shared shader strings; they survive until a geodata polygon migration.

Blocker 2: §4 verification greps were not scoped. Fixed to target
`src/`, `test/`, and `demos/` only.

Non-blocking 3: GpuGroup deletion list expanded to include
`onBinFileLoaded`, the `MapResourceNode` import (all four call sites
in `group.js` are in the octree path), `loadMode`/`binFiles`
constructor fields, and `rootPath`/`rootPoints`/`rootCenter`/
`rootRadius`/`rootTexelSize` instance fields.

Non-blocking 4: Added deletion entries for octree-only config and
debug names: `mapTraverseToMeshNode` (`map.js`, `url-config.ts`,
`group.js`), `mapSplitLods` (`core.js`, `inspector/input.js`,
`group.js`), `drawNBBoxes` and `drawOctants` (`draw.js`,
`inspector/input.js`, `group.js`, `renderer.ts`).

## 2026-05-23 — OGC 3D Tiles investigation and RFC

Investigated the legacy `config.tiles3d` integration before scheduling
removal. The pipeline was dead at runtime since commit `6e578488`
(Sep 2025, utils.js → utils.ts migration), which commented out the
`MapGeodataImport3DTiles` import in `geodata-builder.js`. Restoring
the import and fixing two additional bugs (CORS not set on the sample
server; null renderer dereference in `MapView.getInfo` before the
first render tick) brought the pipeline to the point where
`tileset.json` loads without error. No geometry rendered: OGC sample
tilesets use `b3dm` leaf content, which the importer silently ignores.
The importer only handles `region` bounding volumes and VTS `.mesh`
leaf URIs.

**History:** The pipeline was built between April 2020 and March 2021
during the Melown/Leica era to stream proprietary dense photogrammetry
datasets organised as a 3D octree. The `tileset.json` structure was
borrowed as a convenient octree index format; standard OGC payload
formats (`b3dm`, `i3dm`, `pnts`) were never implemented. Three
generations: `3dtiles.js` prototype → `3dtiles2.js` with compact
binary `bintree`+`pathTable` → `vts-tree.js` with binary wire format.

**Backend survey:** `vts-vtsd` contains a live `tdt2vts` delivery
driver serving conformant `b3dm` tiles for Cesium viewers.
`vts-tools` has batch converters `vts23dtiles` and `3dtiles2vts`.
Neither is aligned with the client-side VTS-mesh prototype.
`cartolina-tileserver` produces quantized-mesh terrain tiles and
embeds a Cesium introspection UI; it has no `tileset.json` generation
and no `b3dm` output.

**Fixes kept:** the `renderer &&` null guard in `MapView.getInfo`
(`view.js`) is a legitimate defensive fix independent of the 3D Tiles
removal.

**RFC filed:** `docs/wiki/rfc-remove-3dtiles.md` — covers deletion of
`3dtiles.js`, `3dtiles2.js`, `vts-tree.js`, `pointcloud.js`, and the
node-shaped geodata path through `geodata-view.js`, `group.js`,
`geodata-builder.js`, `loader.js`, and `constants.ts`. Follow-on §3.3
covers the legacy tile shader family (`progTile*`, `drawSubmesh`,
`MATERIAL_INTERNAL`). Status: in review.

## 2026-05-23 — Migrate legacy kill() to [Symbol.dispose]()

`GpuTexture`, `GpuDevice`, `GpuMesh`, `Atmosphere`, and `Renderer` now
implement `[Symbol.dispose]()` as the canonical teardown hook. Each uses
a `disposed_` guard flag for idempotency.

`GpuTexture`, `GpuMesh`, and `Renderer` retain a `kill()` shim because
a legacy JS file calls them directly (`subtexture.js`, `mesh.js`,
`map.js`/`core.js` respectively). `GpuDevice` and `Atmosphere` have no
JS callers and expose `[Symbol.dispose]()` only.

`Renderer.killed` was renamed `Renderer.disposed_`.

`Atmosphere.kill()` was dead code (never called). Replacing it with
`[Symbol.dispose]()` also closed a pre-existing teardown gap:
`Map.prototype.kill` in `map.js` now calls
`atmosphere[Symbol.dispose]()` before clearing the reference, so
`atmDensityTexture` is properly released on map teardown.

All typed TS call sites of the old `kill()` methods were updated to
`[Symbol.dispose]()`. `tile-render-rig.ts:evictCollapsed` now calls
`normalGpu[Symbol.dispose]()`.

**Regression tests:** `simple-terrain`, `complex-terrain`, `full-terrain`
all pass.

## 2026-05-23 — Remove stale fog functionality

Removed the legacy fog system that had been superseded by `Atmosphere`
and its shader. The fog tile pipeline (`progFogTile`, `MATERIAL_FOG`,
`updateFogDensity`, `fogDensity`, `drawFog`, `mapFog`) was dead code:
`TileRenderRig` replaced the old tile pipeline and never called the fog
path.

**Files changed:** `constants.ts`, `renderer.ts`, `url-config.ts`,
`core.js`, `map.js`, `draw.js`, `mesh.js`, `surface-tile.js`,
`camera.js`, `init.js`, `inspector/input.js`, `gpu/shaders.js`.

**What was removed:**
- `MATERIAL_FOG`, `MATERIAL_INTERNAL_NOFOG`, `MATERIAL_EXTERNAL_NOFOG`
  constants and their switch-case handlers in `mesh.js`
- `updateFogDensity()` method and all callers
- `fogDensity` / `drawFog` fields on `MapDraw` and `Renderer`
- `mapFog` config key from `core.js`, `map.js`, `url-config.ts`
- `progFogTile` shader program creation in `init.js`
- Shift+X fog toggle in `inspector/input.js`
- `uFogColor` setters in `surface-tile.js` (grid/hmap tiles)
- `#ifdef onlyFog` dead-code branches in `tileVertexShader` and
  `tileFragmentShader` in `gpu/shaders.js`

**Follow-up:** the tile shader fog-factor calculation and
`draw.atmoColor` were removed after review showed that `MapMesh`
still fed the old fog colour into `uParams2`. The tile shader now
passes texture coordinates as `vec2` and samples tile textures without
fog blending. The plane and hmap shaders no longer compute or apply
their fog blend; the plane shader keeps a renamed `vDepth` varying for
depth render passes. The `fogAndColor` define name still exists for the
coloured flat-shade program, but that branch now only applies `uColor`.
The legacy atmosphere shell programs (`progAtmo`, `progAtmo2`), their
shader strings, their shell mesh, and the dead `RendererDraw.drawBall*`
helpers were removed after source search showed no callers outside their
own initialization path.

**Docs:** `rfc-config-store.md` updated to remove `mapFog` from the
example `ViewerConfig` interface; status set to `In review` per
AGENTS.md since the accepted document body was changed.

**Regression tests:** `simple-terrain`, `complex-terrain`,
`full-terrain` all pass, no console errors.

## 2026-05-23 — Session log chronology repair

Moved the detached historical May entries from the bottom of
`session-log.md` back into reverse chronological order. Reattached the
`2026-05-14 — Style-based runtime free-layer gap` body, which had been
separated from its heading by a later `2026-05-19` entry. Updated
`architecture.md` to state explicitly that `LegacyMap` is destined to
dissolve into `Map`.

## 2026-05-23 — Architecture wiki cleanup

Rewrote `architecture.md` as a high-level first-read page covering the
system shape, VTS divergence, entry point, runtime object ownership,
terrain data flow, public API direction, and design references.

Moved detailed API and runtime notes into `api-and-lifecycle.md`:
construction errors, wrapper migration state, style versus mapConfig
rules, config routing, async initialization, the render loop, the event
bus, teardown, and CSS imports. Moved renderer-boundary and terrain
draw notes into `rendering-architecture.md`. Moved transient upstream
tile-source failures during screenshot tests into `testing-notes.md`.
Updated `index.md` so the new pages are reachable from the wiki table of
contents.

## 2026-05-23 — LOD selection documentation rewrite

Rewrote `lod-selection.md` around the active legacy screen-space error
calculation. The page now separates the producer-side physical sample
length from the client-side projection to viewport pixels, documents the
`surface-dem` metatile formula, and records that loader `priority` is an
inverse priority.

Checked `cartolina-tileserver`: `surface-dem` computes metanode
`texelSize` as `sqrt(physical surface area / nominal sample count)` from
an 8 by 8 DEM sample grid. The server variable is named `textureArea`,
but `surface-dem` uses it as a 256 by 256 tile-density denominator, not
as an actual source texture. The prepared `delivery.index` stores tile
availability; `texelSize` is computed during on-the-fly metatile
generation. `vts::MetaNode::save()` stores the result as a clamped
half-float in the metanode suffix after `internalTextureCount`; the JS
client decodes it to `node.pixelSize`. Updated `surface-metatile.md` to
remove the stale `getTexelSize()` name and old `4.4` threshold note.

## 2026-05-23 — Current-geometry capture removal

Deleted the undocumented `getCurrentGeometry()` entry point from
`MapInterface` and the legacy map object. Removed the `storeTilesOnly`
argument from surface traversal and deleted `storeDrawBufferGeometry()`.
The mapy.com API check in `compat-mapy-integration.md` records that
their integration does not call `getCurrentGeometry()`. `storeGeometry()`
stays because `getSurfaceAreaGeometry()` still uses it for measurement
geometry.

## 2026-05-23 — Replay inspector and custom mesh demo removal

Deleted the VTS-era replay inspector after freeze mode replaced its tile
selection diagnostic role. Removed `src/core/inspector/replay.js`,
`map.draw.replay`, replay capture and display branches in `draw.js`,
node/tile capture hooks in `surface-tree.js`, load-sequence capture in
`loader.js`, and the `mapStoreLoadStats` config and URL parameter.

Removed the legacy custom-mesh demos that depended on
`Renderer.createMesh()` and `Renderer.drawMesh()`. Deleted those two
public helper methods plus the shaded custom-mesh programs and shader
strings. `createTexture`, `drawImage`, and `drawLineString` remain
because inspector radar, measurement UI, ROI code, and other legacy demos
still call them. The OGC 3D Tiles/geodata mesh path remains separate and
still uses `GpuGroup.drawMesh()`.

## 2026-05-23 — Freeze frustum follow-up

Moved freeze-frustum drawing before the final geodata label flush so
geodata label depth checks cannot disturb the overlay after their
1.5-second hitmap refresh. `FreezeMode` no longer stores `Core`, `Map`,
`Renderer`, or a map callback; `Inspector` passes the current legacy map
and renderer at the call sites. Removed the local `FreezeMap` type and
declared the touched legacy members in `map.d.ts`.

Updated frustum depth selection to scan the depth hitmap with stride 3.
The pyramid extends to the farthest finite hitmap depth plus margin. The
reference-frame extent is used only when the hitmap has no finite depth.

Changed freeze from a diagnostic sub-mode into persistent diagnostic state.
`Shift+Z` now enters freeze controls only. `F` freezes at the current
navigation position or unfreezes an existing freeze, `C` toggles the
frustum, and `R` resets the live camera to the frozen position. A compact
control strip appears while freeze controls are active. If the map is
frozen, the strip remains visible after leaving freeze controls.

## 2026-05-23 — Diagnostic freeze mode and camera context bridge

Implemented diagnostic freeze mode behind `Shift+D`, `Shift+Z`. The mode
freezes the camera state used for culling, texel-size tile selection, and
depth sampling while navigation and final rendering continue to use the
live camera. `C` toggles a finite camera-frustum pyramid rendered through a
dedicated GLSL 300 shader path on `Renderer`; reset view restores the
navigation position captured when the map was frozen.

Kept the legacy draw hooks narrow. `FreezeCameraState` in
`src/core/map/freeze-camera-state.ts` owns the camera snapshot/restore
policy while `draw.js` and `surface-tree.js` call phase hooks. Geodata
rendering must run with the live camera; otherwise selected terrain and
geodata disagree during freeze navigation. Restoring renderer buffers after
the final live-camera restore removed intermittent full-viewport flashes on
dirty geodata maps.

Promoted `getScreenDepth(..., coordinateSpace)` through `Map` and
`Viewer`, documented that it returns Euclidean viewer-to-terrain distance,
and renamed the alternate geometric-intersection boolean away from
`useFallback`. Updated `architecture.md` to record that `Map` and
supporting TypeScript modules own map data and selection decisions, while
`Renderer` remains the WebGL/WebGPU boundary.

## 2026-05-23 — Track package-lock.json

Removed `/package-lock.json` from `.gitignore` and committed the
lockfile. Cartolina is an application, not a published library, so
locking transitive dependency versions is correct. The change also
allows Dependabot to confirm resolved versions and auto-close
vulnerability alerts.

## 2026-05-21 — Preserve render-rig context and reduce hot-path churn

Reduced allocation churn in `MapDrawTiles.drawSurfaceTile()` by reusing
readiness option objects and by calling `TileRenderRig.activeLayerIds()`
once per drawn submesh. Restored the original tile-render-rig
integration comments around the edited block after review showed that
they mark useful context inside the legacy draw traversal.

Updated `AGENTS.md` to state that comments and context markers follow
the same preservation rule as documentation: remove them only when they
are obsolete, inaccurate, or attached to deleted code.

## 2026-05-21 — Delete legacy terrain draw-command renderer

Removed the old terrain `drawMeshTile` path from `draw-tiles.js`,
including its bound-layer sequence builder, heightmap updater, last-state
replay block, and dead command generation. `TileRenderRig` is now the
only terrain tile renderer for color and depth passes.

Simplified `MapDraw.processDrawCommands()` and
`areDrawCommandsReady()` so they handle only `DRAWCOMMAND_GEODATA`.
Removed the old command memory estimates from `surface-tree.js` and
deleted the unused draw-command constants. Removed the unused heightmap
and skydome programs and shader strings.

Kept `MapMesh.drawSubmesh()` and the old tile shader family because
geodata mesh jobs still call that method, and public custom mesh drawing
still uses the old shaded/depth mesh programs. Those need a separate
migration before `mesh.js` and the remaining legacy tile shaders can be
cut.

## 2026-05-21 — Normal encoding doc, RFC closed, backlog cleanup

Wrote [normal-encoding.md](normal-encoding.md) covering octahedral RG
encoding: why the full-sphere fold is kept (overhangs on procedural
geometry), the nonlinearity problem when blending encoded values, and how
`TextureBlend` oct-normal mode fixes it. Added oct-normal mode to
`TextureBlend` alongside the existing trivial mode (selected via
`init(mode)`), restoring the fold step for z < 0. Updated
`collapseNormalStack` to call `nmb.init('oct-normal')`. Moved
`rfc-bump-bake.md` to the Implemented section of the wiki index.
Removed the completed bump-bake backlog entry; updated the legacy
pipeline deletion entry to reflect that `nmblender` is already on
`Renderer` (not being moved as part of that refactor).

## 2026-05-21 — Confirm bump collapse and remove debug log

Added a targeted log inside `collapseNormalStack` and loaded
complex-terrain in Playwright. Console showed `bump collapse —
eoxit-s2c-normalmap` per tile, confirming the one bump-map layer is
being baked. Debug log removed. All six regression screenshot tests pass.

## 2026-05-21 — Replace local Config stub with CoreConfig

The `Config` type in `tile-render-rig.ts` was a pre-`CoreConfig` stub
modelling the same `map.config` object. Replaced it with `CoreConfig`
throughout; `mapNoNormalMaps` migrated into `CoreConfig` alongside
`mapCollapseBumps`.

## 2026-05-21 — Implement bump-layer collapse RFC

Implemented [rfc-bump-bake.md](rfc-bump-bake.md) across three files.
`nmblender` moved from `MapDraw` (`draw.js`) to `Renderer`
(`renderer.ts`); `MapDraw` now accesses it as
`this.renderer.nmblender`. `TileRenderRig` gains a private `collapsed`
field holding a rig-local baked `GpuTexture` registered with
`map.gpuCache`. `optimizeStack()` calls `collapseNormalStack()` when
`mapCollapseBumps` is not false; the method incrementally blends ready
bump layers via `nmblender` and copies the result into
`collapsed.normalGpu`. `encodeLayer()` substitutes `collapsed.normalGpu`
for the base normal-map push layer when `collapsed` is non-null.
`evictCollapsed()` handles cache eviction: kills the GPU texture,
restores `optimizedOut` flags on all collapsed layers, deletes the UBO
so readiness re-runs on the next frame. `dispose()` removes the cache
entry. `mapCollapseBumps` added to `CoreConfig` and URL config booleans.
Log at `updateBuffer:427` temporarily enabled to confirm collapse by
showing encoded layer count vs total stack length. All six regression
screenshot tests pass.

## 2026-05-21 — Bump collapse flag split

Reopened [rfc-bump-bake.md](rfc-bump-bake.md) after acceptance to
remove `useNormalMaps` and `useBumpMaps` from the collapse decision.
The RFC now treats collapse as rig-local texture preprocessing governed
by the layer stack, texture residency, and `mapCollapseBumps`. Render
flags remain shader execution policy: `FlagNormalMaps` controls the
normal-map push layer, and `FlagBumpMaps` controls uncollapsed bump
blend layers. Review round 25 accepted the simplified design.

Updated `GpuTexture` so TypeScript callers can pass `null` for manually
populated textures without `as any` or non-null assertions. Renderer
call sites that create hitmap or caller-provided textures now use
`new GpuTexture(..., null, ...)` directly.

## 2026-05-21 — RFC: bump-layer collapse inside TileRenderRig

Wrote [rfc-bump-bake.md](rfc-bump-bake.md) covering the design for
collapsing bump-map layers into the normal map inside `TileRenderRig`.
Key decisions: collapse happens in `optimizeStack()` before UBO
encoding; the result is rig-local (shared `MapTexture` untouched);
two rigs alive simultaneously (current + last) each collapse
independently. Seventeen rounds; accepted.

## 2026-05-20 — Depth hitmap: RGBA8UI with float bit-pattern encoding

Replaced the RGBA8 base-255 digit encoding of the depth hitmap with a
direct IEEE 754 bit-pattern transfer through an RGBA8UI integer
framebuffer.

**`tile-depth.frag.glsl`**: output changed from `out vec4` (RGBA8
normalized) to `out uvec4` (RGBA8UI integer). `floatBitsToUint(vDepth)`
extracts the raw 32-bit pattern; four shift-and-mask operations write it
as four little-endian bytes (LSB in R). The half-byte bias and the
base-255 fract encoding are gone.

**`src/core/renderer/gpu/texture.ts`**: added
`GpuTexture.Type.DepthUint` for the new RGBA8UI texture kind. The enum
values match the legacy `TEXTURETYPE_*` constants while JavaScript
callers are still being migrated. `createFromData` uses
`gl.RGBA8UI` / `gl.RGBA_INTEGER` for this texture kind.

**`src/core/renderer/renderer.ts`**: `initHitmapTexture` passes
`GpuTexture.Type.DepthUint` to `createFromData`. `decodeHitmapDepth`
replaced with a `DataView.getFloat32(..., true)` read; the four-byte
equality sentinel check replaced by `isFinite`.

**`src/core/renderer/gpu/device.ts`**: `clearColorAndDepth` dispatches
on the active render target's texture type — integer targets use
`gl.clearBufferuiv` + `gl.clearBufferfv`; normalized targets use the
existing path. `readFramebufferPixels` similarly dispatches between
`gl.RGBA_INTEGER` and `gl.RGBA`.

**`docs/wiki/render-targets.md`**: depth hitmap format section rewritten
to describe RGBA8UI, the no-hit NaN sentinel, the dispatch approach, and
the carry-error history of the old RGBA8 encoding.

## 2026-05-20 — hitmap horizon dead zone investigation

Recorded a backlog item for a `getScreenDepth` dead zone near the
terrain horizon in the starting view of `demos/depth-test/`. In that
view it is about 8 px wide at the viewport centre and about 4 px wide at
the edges. The issue is largely undetectable in many other views, and
its existence seems independent of hitmap resolution.

## 2026-05-20 — depth-test demo: live overlay and crosshair

**`demos/depth-test/`**: overlay now refreshes continuously and the
browser cursor is replaced by a custom crosshair.

Overlay refresh: `cursorX`/`cursorY` track the pointer; `mapReady`
gates all updates until `loading-screen-hidden` fires. `mouseover` on
the map element captures the pointer position when the splash fades
out, giving a first reading without mouse movement. `map-update`
refreshes on every dirty render pass (tile streaming); `map-position-
changed` refreshes when the camera moves independently.

Crosshair: two full-span 1 px white lines meet at the sampling point,
framed by `box-shadow:0 0 0 1px #000` (zero-blur 1 px spread — a hard
black border on all sides, readable against any background). A
coordinate label sits to the top-right. `cursor:none` is applied in JS
only after `mapReady`, so the system pointer is visible during the
splash.

## 2026-05-20 — Hitmap depth decode cleanup; depth-hitmap-compare script

**`renderer.ts`**: `isHitmapSurfacePixel` is removed. `decodeHitmapDepth`
now returns `Number.POSITIVE_INFINITY` for the no-hit sentinel instead
of a separate boolean. All callers (`hitTest`, `getDepth`, and the
cached-path dilation loop) test `depth < Infinity` or
`depth == Infinity` directly.

**`scripts/depth-hitmap-compare.js`**: new Playwright diagnostic script.
`capture` mode opens the map demo, samples a grid of screen positions
via `getScreenDepth`, and writes a JSON file of depth readings.
`compare` mode diffs two such files and reports per-pixel depth error
statistics (mean, RMSE, max, quantiles, hit-mismatch count).

**`AGENTS.md`**: blank-line rule around multi-line blocks extended to
nested loops, nested `if` statements, callbacks, and helper methods.

## 2026-05-20 — Backlog: depth pass done; pipeline cleanup entry added

Marked step 1 of the draw-refactor backlog item complete: `TileRenderRig`
is now wired into the depth pass with dedicated shaders and a typed
clear/readback API.

Added backlog entry **Delete legacy mesh tile rendering pipeline** —
removes ~1 700 lines across `draw-tiles.js` (62%), `mesh.js` (60%),
`draw.js`, `shaders.js`, `renderer.ts`, `init.js`, and
`surface-tree.js`. Scheduled before draw-refactor steps 2–4.

## 2026-05-19 — Restore portable RGBA8 depth hitmap

Restored the depth hitmap to the WebGL2-baseline RGBA8 colour
attachment. The R32F version required `EXT_color_buffer_float`, and the
benefit did not justify making renderer startup depend on that
extension.

`tile-depth.frag.glsl` again packs `vDepth` into four RGBA8 channels.
The half-byte negative bias is now documented: it compensates WebGL's
float-to-UNORM8 rounding so each channel behaves like a base-255 floor
digit rather than rounding up and carrying into the next digit.

`renderer.ts` again stores cached hitmap data in `Uint8Array`, decodes
depths from RGBA8 bytes, and treats `[255,255,255,255]` as the no-hit
sentinel. The dedicated `initHitmapTexture()` method remains because it
keeps depth-hitmap setup near the renderer fields that consume it.

`GpuDevice` keeps `clearDepth()`, `clearColor()`, and
`clearColorAndDepth()`. The R32F texture creation/readback helpers and
the `TEXTURETYPE_DEPTH_R32F` constant were removed.

`render-targets.md` now records why RGBA8 remains the baseline and
references commit `8928b855`, which implemented the reverted R32F path.
`AGENTS.md` now requires diagnostic output under gitignored `tmp/`
paths and preserved diagnostic scripts under `scripts/`.

## 2026-05-19 — R32F depth hitmap

Switched the depth hitmap colour attachment from RGBA8 (depth
packed into four bytes) to R32F (one 32-bit float per pixel), and
updated every part of the pipeline that reads, writes, or clears that
texture.

**`src/core/renderer/shaders/tile-depth.frag.glsl`**: output type
changed from `vec4 fragColor` with RGBA-packed encoding to
`float fragColor = vDepth`, writing the camera-space depth directly.

**`src/core/constants.ts`**: added `TEXTURETYPE_DEPTH_R32F = 6` to
distinguish R32F framebuffer textures from RGBA8 ones in type-checked
paths.

**`src/core/renderer/gpu/texture.ts`**: added `createFromFloatData()`
(creates an R32F texture from `Float32Array` pixel data) and
`readFramebufferFloatPixels()` (reads pixels back as `Float32Array`
using `gl.RED / gl.FLOAT`).

**`src/core/renderer/gpu/device.ts`**: `init()` now requires
`EXT_color_buffer_float` and throws if absent — WebGL2 can render to
R32F only when the extension is present. Added focused clear methods
`clearDepth()`, `clearColor()`, and `clearColorAndDepth()` to replace
the old boolean-parameter `clear()`, which is deprecated but retained.
Added `readFramebufferFloatPixels()` to read R32F framebuffers.
`readFramebufferPixels()` now throws when called on an R32F texture.

**`src/core/renderer/renderer.ts`**: `hitmapData` type changed from
`Uint8Array` to `Float32Array`. A new private `initHitmapTexture()`
creates the hitmap via `createFromFloatData()` (filled with `-1`,
the no-hit sentinel); the old initialization was removed from
`RendererInit.initHitmap()`. `switchToFramebuffer('depth')` clears the
colour attachment with `gl.clearBufferfv(gl.COLOR, 0, [-1,0,0,0])`
instead of `clearColor = 1.0`. `hitTest()`, `copyHitmap()`, and
`getDepth()` now read one `float` per pixel via
`readFramebufferFloatPixels()`; the RGB-to-depth decoding formula is
gone. Positive depth means a surface hit; `-1` (the clear value) or
`<= 0` means sky.

**`src/core/map/draw.js`**, **`surface-tree.js`**,
**`src/core/renderer/draw.js`**: remaining `gpu.clear(true, false)` and
`gpu.clear(true, true, color)` call sites updated to the new focused
`clearDepth()` / `clearColorAndDepth()` methods.

TypeScript passes. `demos/depth-test/` was exercised in the browser;
sky pixels reported no hit and terrain pixels reported finite depth.

## 2026-05-19 — TileRenderRig depth pass; tile-clip include; mesh.ts cleanup

Extended `TileRenderRig` to cover draw channel 1 (the auxiliary depth /
hitmap pass). Added `isDepthReady()` (checks mesh readiness only — no
layers needed for depth) and `drawDepth()` (draws via the new
`programTileDepth`). The draw-channel gate in `drawSurfaceTile` that
previously forced channel 1 through the old `drawMeshTile` path is now
commented out; both channels go through the rig.

Added standalone depth shaders `tile-depth.vert.glsl` and
`tile-depth.frag.glsl`. The vertex shader applies vertical exaggeration
via the frame UBO, so the depth hitmap correctly reflects the exaggerated
surface. The fragment shader preserves the existing RGBA8 float-pack
encoding. An R32F follow-up was tried later and reverted because it
required `EXT_color_buffer_float`. `programTileDepth()` initializes the
program lazily in `renderer.ts`.

Extracted the tile quadrant clip logic from `tile.frag.glsl` into
`tile-clip.inc.glsl` so both the color and depth fragment shaders share
the same implementation.

Cleaned up `gpu/mesh.ts`: privatized internal fields, keyed the VAO
cache by `GpuProgram` instead of `WebGLProgram`, fixed VAO cleanup in
`kill()`, corrected the vertex attribute pointer data type, fixed GPU
size accounting to use `byteLength`, and documented `AttrNames`.

## 2026-05-19 — Guard shader includes and document design references

Added preprocessor guards to shader includes under
`src/core/renderer/shaders/includes/`. Split shared render flag constants
and `decodeRenderFlags` into `render-flags.inc.glsl`, so `frame.inc.glsl`
and `layers.inc.glsl` both declare the dependency directly. This avoids
order-dependent use of `decodeRenderFlags` when `layers.inc.glsl` is
included after `frame.inc.glsl`.

Updated `architecture.md` to record reference-library roles: MapLibre GL JS
is the strongest reference for public map API shape, TypeScript
organization, sources, vector data, and vector rasterization choices;
Three.js and CesiumJS are projects to check for modern web graphics and
geospatial rendering questions respectively.

## 2026-05-19 — Virtual surface guard; hitmap background fix; docs

Documented the `tile.resourceSurface.virtual` early-return guard in
`drawMeshTile` and the tile-render-rig path in `drawSurfaceTile`: it
fires when `getSurface(sourceReference)` fails to resolve a slot in the
virtual surface mapping, leaving `resourceSurface` pointing at the
`MapVirtualSurface` itself (which has no mesh URL). Added a
`console.warn` at the failure point in `isMetanodeReady`. Updated
`virtual-surfaces.md` with the fallback and guard description.

Fixed a hitmap corruption bug: `drawBackground()` was called
unconditionally, writing atmospheric colour into the hitmap colour
attachment on draw channel 1. The clear colour `(1,1,1,1)` is the
"no hit" sentinel; the atmosphere overwrote sky pixels with values
that decode as large-but-finite depths rather than the sentinel.
Added a `drawChannel === 0` guard in `drawMap`. Documented the
`getScreenDepth` return semantics (`hit === false` means sentinel
depth, must not be used) on both the public API and the internal
declaration.

Added a render-loop performance rule to AGENTS.md. Added a backlog
entry for bump-map baking inside `TileRenderRig`.

## 2026-05-19 — Tile rig owns tile program binding

`TileRenderRig.draw()` no longer accepts a `GpuProgram` from
`draw-tiles.js`. The rig already owns the tile shader uniforms, layer
UBO, sampler array, texture binding, and mesh attribute names, so the
caller no longer selects the program. `draw()` now fetches
`Renderer.programTile()` and binds it through `GpuDevice.useProgram2()`.
The device-side program cache makes repeated tile draws pay only the
object comparison when the tile program is already current.

`Renderer.programTile()` and `Renderer.programBackground()` now declare
`GpuProgram` return types. Shared frame-space shader helpers for
vertical exaggeration and ellipsoid zenith moved from `tile.vert.glsl`
to `frame.inc.glsl`, so future shader programs can reuse the same
calculations.

`TextureBlend.restoreInitialState()` now carries a warning that it
restores only part of the raw WebGL state it changes. Blend state,
array-buffer binding, and vertex attribute enables can still drift from
renderer-side state caches after the helper runs.

## 2026-05-18 — Replay inspector diagnosis and partial fix

Diagnosed the VTS-era replay inspector (`src/core/inspector/replay.js`
and its hooks in `draw.js`, `surface-tree.js`, `loader.js`). The tool
was built in 2016–2017 to debug the tile descent algorithm and last
touched substantively in June 2017. The `processDrawBuffer` refactor of
January 2019 silently broke the Drawn Tiles feature: the refactor
introduced a `noGrid=true` path that stores bare tile objects in
`tileBuffer`, while the replay read code always indexed `tiles[i][0]`
expecting `[tile, isGrid]` tuples. Every main-surface tile yielded
`undefined` and was skipped. The screen went black.

Fixed the read loop with `Array.isArray(tiles[i]) ? tiles[i][0] : tiles[i]`
(one line, both the Drawn Tiles and Drawn Tiles Free Layers paths).
Separately fixed a Globe crash: `drawTBall` was called before the
base64 globe texture finished async loading; added a `.loaded` guard
in `inspector.js`. The replay inspector and `drawTBall` were removed in
later cleanup. Removed leftover `here1`–`here6` debug logs from
`draw.js`.

Confirmed Traced Nodes always worked (CPU-side metanode data, no GPU
dependency). Load Sequence recording works but requires starting during
active tile loading. Drawn Tiles Free Layers captures nothing on scenes
whose free layers are geodata-type (they go through `drawMonoliticGeodata`,
not `processDrawBuffer`).

The tool will not be carried into the rewritten draw pipeline (see
backlog). Full archaeology notes in
[archaeology-replay-inspector.md](archaeology-replay-inspector.md).
Freeze mode added to backlog as the intended replacement.

## 2026-05-18 — Mark dead stardome/atmo draw path; fix background GL state

Removed the stardome draw call (commented out, never used a real texture)
and the surrounding `gpu.setState(drawStardomeState)` noise. Marked
`drawStardomeState`, `drawAuraState`, `drawAtmoState/2`, `progSkydome`,
`progAtmo/2`, and the old skydome/atmo shaders as removal candidates;
the atmosphere shell code was later deleted after source search showed
no callers outside its own initialization path. The remaining background
path is `renderer.drawBackground()`.

Fixed a GL state regression from the removal: `drawBackground()` now
installs `backgroundState` (`ztest:false, zwrite:false`) itself rather
than relying on the caller. Added `backgroundState` to `renderer.ts` and
`init.js` alongside the other renderer state objects.

Also: declared `visibleCredits` on `map.d.ts`; reordered
`gl.clearColor/clear/enable` in `switchToFramebuffer` depth and geo passes
to make intent clearer; added a setState push/pop refactor entry to the
backlog.

## 2026-05-17 — Reveal.js CSS-transform blur note

Reveal.js scaled an `1824x972` slide to about `2538.96x1353` and
centred it at a fractional x offset. Cartolina sized the canvas from
`getBoundingClientRect()`, so the blur was likely compositor sampling at
a near half-pixel canvas origin. Updated `docs/wiki/rendering-sizes.md`.

## 2026-05-17 — Rename RenderTarget.dpr → devicePixelRatio; fix dpiRatio source

`RenderTarget.dpr` renamed to `devicePixelRatio` in `device.ts` for
clarity. Updated in `stats.js` (inspector display) and `draw.js`
(`texelSizeFit` computation). `texelSizeFit` now reads
`currentRenderTarget.devicePixelRatio ?? 1` instead of
`window.devicePixelRatio`, so off-screen render targets without a
known DPR default to 1 rather than inheriting the browser display DPR.

## 2026-05-17 — LOD selection: fixes and documentation

**`checkVisibility` coordinate space fix**: `convertCoordsFromNavToCanvas`
outputs coordinates in `apparentSize` space (NDC scaled by
`getBoundingClientRect()` dimensions). `getScreenDepth` was being called
without a coordinate space argument, defaulting to `'layout'`
(`offsetWidth`/`offsetHeight`). Fixed to pass `'apparent'` explicitly.
`renderer.curSize` (deprecated alias for `apparentSize`) replaced with
`renderer.apparentSize` in the same function.

**`ndcToScreenPixel` fix**: `draw.js` was setting `ndcToScreenPixel`
from `canvas.width` (always the main canvas physical size) instead of
the current render target's `viewportSize`. During the hitmap pass the
render target is a square auxiliary texture; using `canvas.width` caused
the tree to descend far deeper than the hitmap resolution requires.
Fixed to use `currentRenderTarget.viewportSize[0]`.

**Dead save/restore removed**: `getScreenDepth` saved and restored
`draw.ndcToScreenPixel` around the `drawHitmap` call. Nothing reads the
value between the restore and the next `drawMap` call, which overwrites
it unconditionally. The save/restore was removed.

**`MapSurfaceTree.ndcToScreenPixel` removed**: the field was set from
`draw.ndcToScreenPixel` at the start of each traversal but never read
anywhere. Both the initialiser and the assignment were removed.

**Documentation**: new page `docs/wiki/lod-selection.md` documents the
full screen-space error algorithm: `ndcToScreenPixel`, `texelSizeFit`,
metanode field families, all branches of `updateTexelSize`, both
distance functions (`getPixelSize` vs `getPixelSize3`), the
`texelSizeFit > 1.1` fast-path, degrade-horizon, tree traversal, and
free-layer vs surface-layer differences. `rendering-sizes.md` updated
with a note on CSS-transform / apparent-size behaviour and label
stability.

## 2026-05-17 — Renderer: canvas render target naming and logic cleanup

Identified and fixed two related problems in the canvas render target
management path.

**Naming**: `updateSizeIfNeeded` and `updateCanvasRenderTargetIfNeeded`
both sounded like passive checks but carried hard GL side effects
(binding a framebuffer, setting the GL viewport, resizing the canvas
element). Renamed and split:

- `GpuDevice.updateCanvasRenderTargetIfNeeded` → split into
  `canvasRenderTargetNeedsUpdate()` (pure boolean read) and
  `updateCanvasRenderTarget()` (resize + bind).
- `GpuDevice.setCanvasRenderTarget()` added as a cheap bind-only path
  (no DOM read, no canvas element resize) for switching back from
  auxiliary passes.
- `Renderer.updateSizeIfNeeded` → `ensureCanvasRenderTarget()`.

**Logic**: `canvasRenderTargetNeedsUpdate()` previously compared the
current render target (whatever was bound) against the DOM-measured
canvas size. Introduced `canvasTarget_` field on `GpuDevice` to track
the last configured canvas target independently of `renderTarget_`.
The check now compares `canvasTarget_` to the DOM, which is correct
regardless of which target is currently bound.

`ensureCanvasRenderTarget()` now always binds the canvas at the top of
the render loop; resize and projection update only happen when the DOM
size actually changed. The dead `wasCanvasTarget` guard and its TODO
comment were removed.

**Dead code**: marked `drawFog` / `debug.drawFog` references dead in
`draw.js`, `map.js`, `renderer.ts`, `inspector/input.js`, and
`init.js` (progFogTile), pointing to the existing `updateFogDensity`
dead-code comment in `draw.js`.

## 2026-05-16 — wiki: tileserver metatile production analysis

Analyzed the cartolina-tileserver metatile generation pipeline
(calipers → VRTWO → tile index → serve-time GDAL warp). Key
finding: the VRTWO and tile index together already contain all
metatile data; the per-request warp re-derives it redundantly.
Proposal: extend the tile index format with height range data,
populated during the existing tiling walk. Eliminates the warp
from the request path without breaking CDN compatibility.
Documented in tileserver-metatile-production.md and backlog.md.

Also noted that a position-parameterised manifest endpoint (to
eliminate client-side ping-pong) would bust CDN and is only viable
after the warp elimination is in place — deferred as stage 2.

---

## 2026-05-16 — AGENTS.md: correct protocol for editing accepted RFCs

Any edit to an accepted RFC body invalidates the sign-off. The correct
protocol: edit the body, revert status to In review, add a new review
round section describing the change. Do not leave the status as
Accepted after editing.

---

## 2026-05-16 — RFC: draw traversal — accepted; §9 updated for round 5

RFC accepted. Extended the per-surface mask pool §9 entry with the
resource-readiness case identified in round 5: a back surface child
that loads before a front surface child can temporarily block the
front surface's fallback during progressive loading, even inside the
front surface's interior. Both cases (dataset-edge geometry and
readiness race) share the same root cause and the same deferred fix.
Validation checklist updated: progressive-loading multi-surface case
and seam case required before the legacy draw path is removed.

---

## 2026-05-16 — RFC: draw traversal — author response to review round 4

Acknowledged the priority-inversion limitation as a known edge case
rather than fixing it now. The bug fires only when a back surface has
finer LOD tiles than the front surface at the same position — unusual
in well-configured stacks, occurs only at dataset boundary seam tiles,
and the visual outcome is acceptable for elevation surfaces. Full
analysis in the round 4 inline response. Added per-surface mask pool
to §9 as a deferred open question with a description of the correct
fix and the condition under which it should be implemented.

---

## 2026-05-16 — RFC: draw traversal — author response to review round 3

Fixed step ordering bug in §5.1: screen draw now precedes footprint
pass and OR, so each surface samples only prior coverage and not its
own footprint. Watertight branch corrected similarly. Added node mask
lifecycle rule: clear at node entry, accumulate, blit on backtrack.
Updated §5.6 OR/blit shader with the full min-filter erosion loop,
boundary handling (out-of-range UV = 0), and k = 0 documented.
Specified `SurfaceSequence.hasVirtualSurfaces` as the actionable
gate for the virtual-surface fallback in §7. Updated §5.2 ordering
guarantee to match corrected step sequence.

---

## 2026-05-16 — RFC: draw traversal — erosion implementation documented

Added erosion mechanism detail to §4.2, §5.1, and §9. Erosion is a
morphological min-filter (radius k texels) applied in the OR/blit
shader on the source texture before writing into the destination mask.
The same program and uniform handle both the OR-into-node-mask step
(eroding a surface's footprint before back surfaces sample it) and the
child-to-parent blit (eroding the child mask before the parent renders
into the border zone). The geometric growth property is documented:
each blit step erodes by k texels in the parent's UV space, which
represents increasingly larger geographic area at coarser LODs.

---

## 2026-05-16 — RFC: draw traversal — author response to review round 2

Reverted mask decision to geographic (accepted) / screen-space
(deferred). Round 2 identified two structural problems in screen-space
that do not have clean solutions: frame-global mask correctness under
arbitrary traversal order (comment 2), and depth buffer lifecycle for
offscreen rendering (comment 3). Geographic masks avoid both by
construction. Added inline responses for all six round 2 comments.
Updated §4.1, §4.2, §4.3, §5.1–§5.6, §6.1, §6.2, §8, §9, and the
round 1 inline response for comment 3. §2 required no changes — it
already described the geographic algorithm.

---

## 2026-05-16 — RFC: draw traversal — §2.1 wording: forward reference to §2.2

Removed "This is the complete algorithm" — §2.2 is an important part
of it. Replaced with a forward reference to §2.2 for the surface
rendering detail.

---

## 2026-05-16 — RFC: draw traversal — clarify backtrack vs "after descent"

Replaced "after descent" with "on backtrack" throughout §2.1 — the
two phrases are synonymous but "backtrack" is the precise term.

---

## 2026-05-16 — RFC: draw traversal — fix mixed-LOD surface leaf rule

§2.1 corrected: natural-leaf rendering is now unconditional (step 4,
after descent), not gated on fallback cadence. A surface renders at
its natural leaf regardless of cadence — there is no finer data for it
anywhere. Fallback cadence (step 5) gates only inner-node early-coverage
rendering. This fixes the case where a coarse back surface's LOD range
ends at a node the finer front surface's children have already populated.

---

## 2026-05-16 — RFC: draw traversal — mask decision revised to screen-space

Reverted §4.3 to screen-space as accepted design; geographic documented
as deferred alternative. Reasoning: cracks have no robust analytical
solution and have already caused visible artifacts (hence mapSplitMeshes
defaulting to false); screen-space oblique-angle artifact is bounded by
cadence and unobserved in practice. Completed §4.1 with full
infrastructure description (global accumulated_mask, scratch_mask MRT,
OR pass with gl.blendEquation MAX). Updated §5.1, §5.5, §5.6, §6.1,
§6.2 for screen-space. Updated review note 3 inline response.

---

## 2026-05-16 — RFC: draw traversal — surface ordering terminology

Defined front/back surface convention in §2.2: index 0 = front surface,
renders first, takes precedence. Replaced all uses of "higher priority"
/ "lower priority" / "topmost" with front/back throughout the RFC.

---

## 2026-05-16 — RFC: draw traversal — author response, inline notes

Added *Implemented.* responses inline under each of the five review
notes.

---

## 2026-05-16 — RFC: draw traversal — author response to review round 1

Addressed five reviewer notes:

1. Mixed-LOD surfaces: added per-surface leaf rule — each surface is
   evaluated independently at each node; surfaces at their natural leaf
   (SSE passes or no children) render in priority order before descent
   for surfaces with finer data.
2. Mask data flow: made the per-surface ping-pong sequence explicit —
   two textures (accumulated + scratch), three draw calls per surface
   (screen draw sampling accumulated, footprint into scratch, OR scratch
   into accumulated). Moved to new §5.1.
3. Implementation path: chose geographic mask as the accepted design.
   Screen-space documented as deferred alternative in §4.3.
4. Virtual surface rollout: gate new traversal on vsurfaceCount == 0;
   maps with mapConfig.virtualSurfaces use legacy path until migrated.
5. Watertight data-skipping: clarified that "no data requests" means
   mesh/texture resources, not metatiles. Subtree skipping deferred.

---

## 2026-05-16 — RFC: draw traversal — glue generation user report

Added user report to §1: generating a glue between two planet-wide
Viewfinder Panoramas DEMs (3 arc-second + 1 arc-second) took multiple
days on a stock desktop machine using vts-tools.

---

## 2026-05-16 — RFC: draw traversal — problem statement with verified glue analysis

Expanded §1 with a grounded account of why eliminating glues matters.
Verified against source: glue generation pipeline is ~5 000 lines of
computational geometry (scan conversion, non-convex triangle clipping,
mesh refinement, UV atlas repacking) running per tile across the full
seam region at every LOD. Storage overhead is proportional to seam
area. Client-side complexity (createVirtualMetanode, alien flags,
sourceReference) exists solely for the abstraction and the alien flag
mechanism has never functioned. Glues are VTS-specific with no
equivalent in other formats. Wall-clock time not quantified (no
benchmarks in repository) but per-tile cost confirmed non-trivial.

---

## 2026-05-16 — RFC: draw traversal — vts-browser-cpp prior art

Examined vts-browser-cpp traversal as potential inspiration. Findings:
`travModeBalanced` + `renderNodeCoarser` uses analytical UV clip
rectangles to render a ready ancestor in place of an unready descendant.
The clip is computed by composing `updateRangeToHalf` per LOD level —
equivalent to the cartolina-js `uClip`/`splitMask` mechanism but
generalised to arbitrary depth. Concluded that UV clip does not
eliminate cracks (same geometric problem as geographic mask; managed in
vts-browser-cpp by dense meshes and glues). Multi-surface seam stitching
in vts-browser-cpp relies on server-side glues, which we are removing.
Combining UV clip (LOD) with mask texture (multi-surface) would produce
two interacting systems; the unified mask handles both dimensions.
Recorded as §3 Prior art in the RFC.

---

## 2026-05-16 — RFC: unified recursive draw traversal

Drafted `rfc-draw-traversal.md`. Key design decisions recorded:

- Replaces four iterative traversal variants (`topdown`, `downtop`,
  `fit`, `fitonly`) with one recursive depth-first function; mode
  selection collapses to a single `mapFallbackLodCadence` integer.
- Glues and virtual surfaces ignored entirely in v1; `createVirtualMetanode`
  and alien-flag machinery deleted. Multi-surface coordination uses
  direct per-surface metatile lookups, not a merge mechanism.
- Client-side mask compositing enforces two rules: coarser tiles never
  obscure finer tiles; within a node, higher-priority surfaces claim
  pixels before lower-priority ones.
- Two mask approaches analysed: screen-space (crack-free, camera-dependent
  blocking risk at large LOD gaps) and geographic UV-space (provably
  correct, crack risk mitigated by mask erosion). Screen-space
  recommended for first prototype; geographic is the stronger design.
- Watertight tile optimization: for the geographic approach, watertight
  tiles need no footprint pass and block all lower surfaces in the stack.
  For screen-space, non-watertight tiles do not contribute their mask
  to block subsequent surfaces, falling back to depth testing.
- Metatile v6 design: watertight flag added as header bitplane 1
  (following alien bitplane 0 precedent); `ti2metaFlags()` in the
  tileserver generator gains the mapping. vts-vtsd patched identically
  to read v6. Client treats version < 6 as non-watertight throughout.
- Recursion depth verified empirically: V8 limit ~6 500 frames for a
  traversal-weight function; 30 frames use 0.46 % of the default stack
  (safety margin ~220×); per-frame call overhead ~0.005 µs.

---

## 2026-05-15 — autopilot: fix flyTo silent failure

`autopilot.flyTo` (and `flyToDAH`, `generateTrajectory`,
`generatePIHTrajectory`) accessed `this.browser.core.map` to get the
legacy map object. After `Browser.core` was changed to hold the
TypeScript `Map` class rather than the `Core` instance, `.map` was
undefined on it, causing `flyTo` to silently return without computing
a trajectory. Fixed by switching all four methods to
`this.browser.getMap()`, which returns `MapInterface` and was already
used correctly by `tick()`.

---

## 2026-05-15 — demos: remove obsolete patterns

Audited all non-legacy demos for patterns that no longer fit the
current API surface.

- `simple-terrain`: fixed typo `stylet.json` → `style.json`; removed
  commented-out dead options.
- `core`: removed `cartolina.checkSupport()` call, which is not
  exported from the public API and would throw at runtime.
- `depth-test`: rewrote `demo.js` to use `cartolina.map()` with a
  local `style.json` (satellite imagery + specular, no labels) instead
  of the legacy `cartolina.browser()` + mapConfig URL; replaced
  internal `UIElement` event wiring with DOM `addEventListener` and
  standard `e.clientX`/`e.clientY`; fixed title branding.
- `map/styles/satellite.json`: replaced hardcoded production URLs with
  `__backend__` placeholders to match all other map-demo styles;
  normalised font URLs from protocol-relative to `https://`.
- `demos/index.html`: reordered entries; expanded Map description with
  style names, backend values, and `pos=`; link includes explicit
  defaults.

---

## 2026-05-14 — RFC: config store, sign-off; status Accepted

Reviewer signed off. Status updated to Accepted — ready to implement.

---

## 2026-05-14 — AGENTS.md: document RFC sign-off and convergence

Sign-off protocol added to the review process: reviewer appends a
sign-off section and sets status to Accepted; rejected notes that
remain unresolved are re-raised in the next round; author and
reviewer are expected to converge.

---

## 2026-05-14 — RFC: config store, address round 2 reviewer notes

Shim in §4.4 corrected to include Core forwarding for non-Browser
keys alongside the store write and dual-write. Step 3 updated.

---

## 2026-05-14 — Add .claude/settings.json; gitignore settings.local.json

`.claude/settings.json` added to version control with team-wide Claude
Code permissions (allowed MCP tools and fetch domains). `.gitignore`
updated to exclude `settings.local.json`, which contains personal data
(absolute paths, per-machine allow rules).

---

## 2026-05-14 — RFC: config store, address round 1 reviewer notes

All five round 1 reviewer notes addressed in-place. Design sections
updated: dual-write bridge in step 3, normalization boundary in §4.2
and §4.4, flush scope clarified in §4.1, renderer switch location
corrected in step 4, section numbering fixed throughout §4.

---

## 2026-05-14 — RFC: event bus, sign-off and editorial cleanup

Reviewer signed off on architecture and implementation direction. Two
editorial fixes: step 2 wording aligned with section 6.2 on `unknown`
payloads; `ViewerEventMap` open question closed (step 2 already commits
to the rename). Status updated to "Accepted — ready to implement."

---

## 2026-05-14 — RFC: event bus, round 2 reviewer responses

Three notes addressed. Exception behavior contradiction in 4C resolved:
abort-on-throw, matching current behavior. `wait` removal in step 6 is
now global after re-tracing `measure.js`: `traceVolumeLine` runs once per
tick with `wait=1` (not every other tick as previously stated) — `wait=1`
is the mid-dispatch workaround at that site too. Open question for
`measure.js` closed. Section 6.2 text corrected to say `unknown` remains
where the source is still untyped ES5.

---

## 2026-05-14 — RFC: event bus, round 1 reviewer responses

Round 1 reviewer notes addressed. Complete event inventory added (six
autopilot/loading events previously missing). `wait` mechanism coverage
extended to both call sites. Event policy settled: all events are public.
Dispatch semantics specified. TypeScript type bound corrected. Open
questions section added covering `measure.js` rate, `ViewerEventMap`
rename, and exception isolation. Round 1 author responses appended to
section 9.

---

## 2026-05-14 — RFC: event bus extraction

### Goal

Write an RFC for the event bus migration, elevated from the backlog.

### What changed

`docs/wiki/rfc-event-bus.md` created. Covers motivation (bus must move
as part of `core.js` suppression), full event inventory, the `wait`
mechanism, three alternatives (native `EventTarget`, `EventTarget`-backed
wrapper, typed `EventBus<EventMap>` class) with a performance comparison
table, and the recommended design. Key decision: bus owned by `Map`; the
`EventBus` instance is passed directly to `LegacyMap` and `GpuDevice` at
construction so no new forwarding methods are added to `Core`. `EventTarget`
evaluated and rejected — API shape mismatch, per-emit `CustomEvent`
allocation, and divergence from the MapLibre reference API. Reviewer notes
appended; author responses in progress.

`docs/wiki/backlog.md` updated: backlog entry points at the RFC.
`docs/wiki/index.md` updated: RFC listed in the RFCs section.

## 2026-05-14 — Post-commit review: remove destroy(), document legacy shims

### Goal

Act on architectural review findings from the previous commit.

### What changed

**`src/browser/viewer.ts`**: removed `destroy()`. It had no external API
history to protect; the only internal caller (waypoint demo) was already
updated to `[Symbol.dispose]()` in the prior commit. The `[Symbol.dispose]()`
JSDoc now mentions the `using` declaration as the block-scoped form.
The `ui`, `autopilot`, and `presenter` getters are marked `@deprecated`
and their section comment explains they are temporary shims pending
promotion to flat typed `Viewer` methods.

**`docs/wiki/backlog.md`**: new item tracks promotion of `ui`,
`autopilot`, and `presenter` to flat `Viewer` methods, with a priority
order (autopilot first — one call site in the waypoint demo).

**`.husky/pre-commit`**: wired the session log check that existed in
`.git/hooks/pre-commit` (dead, bypassed by husky) into the active husky
hook. The check blocks commits where `docs/wiki/session-log.md` is not
staged. Set `SKIP_SESSION_LOG=1` to bypass for commits where no log
entry is warranted.

### Finding

The session log check was written into `.git/hooks/pre-commit` but the
repo uses `hooksPath = .husky`, so it never ran. The husky hook only
performed the version bump.

## 2026-05-14 — Viewer disposal and Browser config construction

### Goal

Finish the `Viewer` lifecycle cleanup and fix the constructor-time config
path uncovered while testing it.

### What changed

**`src/browser/viewer.ts`**: added `[Symbol.dispose]()` as the canonical
teardown hook. `destroy()` remains as a deprecated alias. Public methods
now call `assertAlive_()` and throw after disposal instead of returning
fallback values such as `null`, `0`, `1`, `this`, or `undefined`.

**`src/core/map.ts`**: `on()` now returns an unsubscribe function or
throws if the legacy event registration path fails. `Viewer.on()` no
longer needs a nullable return for disposed-state handling.

**`demos/waypoint/waypoint.js`**: teardown now calls
`viewer[Symbol.dispose]()` instead of `viewer.destroy()`.

**`src/browser/browser.js`**: `setConfigParam()` now separates
constructor-time config storage from runtime engine forwarding. The
method records browser-owned values before any engine object exists.
Forwarding to map, renderer, or debug config happens only after
`Browser.core` has been assigned. This does not drop constructor config:
the same config object is passed into `new Map(...)`, and `Core` applies
map and renderer options during its own construction and map load.

### Finding

The disposal diagnostic first tried to construct a second viewer on an
already loaded demo page. That exposed a real constructor bug:
`Browser.setConfigParam()` called `getMap()` before `this.core` existed,
so any config key could throw before reaching the switch that stores it.
The fix avoids reading engine objects until a branch needs runtime
forwarding and the engine exists.

## 2026-05-14 — Kill vts-core.js; add interactive:false; non-interactive demo

### Goal

Remove the separate `vts-core.js` build. Replace it with an `interactive:
false` option on the browser build's `MapOptions` that suppresses all
built-in event handling. Add a non-interactive demo that shows custom
navigation, hit-testing, and geodata overlays.

### What changed

**Build system** (`webpack.config.js`): removed the `vts-core` entry
point and its LICENSE copy rule. Only `cartolina` is now built.

**`src/core/index.ts`**: deleted. This was the core build entry point.
Nothing inside `src/` imported it.

**`src/browser/index.ts`**: added `interactive?: boolean` to `MapOptions`
at the top level, matching the MapLibre GL JS convention. The `map()`
factory passes it through to `Browser` config. `map()` and `browser()`
now return `Viewer`, not `Viewer | null`; construction failures throw
instead of producing half-initialized objects.

**`src/browser/browser.js`**:
- `initConfig`: added `interactive: true` as a config default.
- `setConfigParam`: added `case 'interactive'` so the flag routes to
  `this.config` instead of forwarding to `Core`.
- constructor: WebGL2 preflight moved to `GpuDevice.checkSupport()`,
  called before any DOM nodes are inserted. A failed probe throws before
  `UI` is constructed, leaving the caller's container clean.
- `getMap()` / `getRenderer()` / `callListener()`: these three methods
  had stale access paths (`this.core.map`, `this.core.renderer`,
  `this.core.callListener`) that broke when `Browser.core` changed from
  the old `CoreInterface` object to the new `Map` boundary class. Fixed
  to use the `Map.core` migration shim.

**`src/browser/control-mode/control-mode.js`**: all ten event registrations
in the `ControlMode` constructor wrapped in `if (browser.config.interactive
!== false)`. No other changes to sub-modes.

**`src/browser/viewer.ts`**:
- Added `legacyMapInterface_` private getter — accesses `MapInterface`
  via `this.map_.core.mapInterface`. This is the correct path for
  geodata methods, which live on `MapInterface`, not `LegacyMap`.
- Added `createGeodata()`, `addFreeLayer()`, `removeFreeLayer()` —
  delegate through `legacyMapInterface_`. Return type of `createGeodata`
  is `unknown` pending a TypeScript declaration for the geodata builder.
- Renamed `includeSE` → `applyVerticalExaggeration` on
  `convertCoordsFromNavToPhys` parameter (doc-only correction).
- Note: `getHitCoords` was already promoted to `Viewer` before this
  session.

**`src/core/map.ts`**: `.core` getter return type widened from
`{ map: LegacyMap | null; renderer: Renderer | null }` to
`InstanceType<typeof Core>`. This exposes `mapInterface` and
`callListener` through the shim without an unsafe cast. `Map` keeps its
`Core` reference non-null; after disposal, public methods throw instead
of returning `null`.

**`src/core/renderer/gpu/device.ts`**: added `GpuDevice.checkSupport()`,
a static probe that tests canvas and WebGL2 availability without inserting
DOM nodes. Dead guards for `canvas == null` and `canvas.getContext == null`
removed — both were unreachable on any supported browser.

**`src/browser/browser.js`**: `GpuDevice.checkSupport()` called before
`new UI()`, so a failed probe throws before any DOM nodes are inserted.

**`src/core/map/map.d.ts`**: added `createGeodata()` and
`removeFreeLayer()` to the `LegacyMap` type declaration.

**`src/core/renderer/renderer.ts`**: added three methods that replace
removed `RendererInterface` methods now needed directly on `Renderer`:
`getMarginFlags()`, `setMarginFlags()`, `getCanvasSize()`.

**`demos/legacy/core/`**: deleted (both `index.html` and `demo.js`).

**`demos/core/index.html`**: new non-interactive demo. Loads
`cartolina.js` with `interactive: false`. Demonstrates pan/orbit/zoom
wired by hand, click-to-coordinates via `getHitCoords`, and a geodata
free layer (closed triangle route over central Europe) drawn via
`createGeodata` / `addFreeLayer`.

**`demos/core/style.json`**: style using viewfinder-dem3 with
illumination and vertical exaggeration defaults.

**`demos/depth-test/demo.js`**: removed the obsolete `if (!browser)`
factory guard. The browser factory now throws instead of returning
`null`.

**`docs/wiki/architecture.md`**: two-build section replaced with
single-build description. Two-surface section replaced with
single-surface description. `MapInterface` correctly identified as
still alive (not deleted). Object model diagram updated to show
`Core.mapInterface`. Status table corrected. Added construction error
policy: factories return usable objects or throw; legacy nullable
construction patterns are migration debt.

**`docs/wiki/non-interactive.md`**: rewritten as a non-interactive usage
guide. Includes historical note on why `vts-core.js` was removed (9%
size difference, `interactive: false` covers the same use case).

**`docs/wiki/backlog.md`**: added a refactor item for removing legacy
nullable construction paths from classes that cannot be valid without
their engine objects.

**`CLAUDE.md`**: added pre-test protocol requiring a dev server restart
after `webpack.config.js` changes, and warning that compilation errors
in test output mean the server is serving stale code.

### Known issues introduced and fixed during the session

Three bugs in `browser.js` were not caught by screenshot tests because
the dev server was serving a stale (pre-change) build at the time tests
ran. The stale build resulted from the dev server failing to recompile
(due to the deleted `src/core/index.ts` still being referenced in its
cached webpack config) and falling back to the last successful output.
The test output showed webpack compilation errors that were dismissed
as noise; they were in fact signals that test results were invalid.

The bugs:
1. `Browser.getMap()` returned the wrong object — `this.core.map` was
   the old CoreInterface path; correct is `this.core.core.mapInterface`.
2. `Browser.getRenderer()` same issue — fixed to
   `this.core.core.renderer`.
3. `Browser.callListener()` — fixed to
   `this.core.core.callListener`.

Additionally, `viewer.ts` initially delegated `createGeodata` through
`legacyMap_` (the `LegacyMap` terrain engine object). `createGeodata` is
on `MapInterface`, not `LegacyMap`. Fixed to use `legacyMapInterface_`.

### Follow-up: code review cleanup (2026-05-14)

Two follow-up commits addressed issues found during code review of the
session above.

**`src/core/renderer/gpu/device.ts`**: `GpuDevice.checkSupport()` is now
a static method on `GpuDevice`, where the capability actually lives. The
`canvas == null` and `canvas.getContext == null` guards in `init()` were
dead code — both checks are unreachable on any supported browser —
and were removed.

**`src/browser/browser.js`**: `GpuDevice.checkSupport()` is called before
`new UI()`, so a failed probe throws before any DOM nodes are inserted
into the caller's container. `setConfigParams(config, true)` is moved
back to before `new Map()` so `this.config` is fully populated before
construction. The debug-forwarding branch is guarded with `this.core`
so the call is safe at any point in the constructor. `getProj4` removed.

**`src/core/core.js`**: `checkSupport` function and its export removed.
The `Proj4` import, `this.proj4` property, and `getProj4` method removed.

**`src/browser/index.ts`**: `checkSupport` removed from the public
namespace. It was a pre-flight helper that predates throw-on-failure
construction; callers who need capability detection can try/catch.

**`src/core/map/map.js`**, **`refframe.js`**: dead `this.proj4`
assignments removed. `getProj4()` was a pass-through that returned the
imported `proj4` module; callers now import it directly.

**`src/core/map/srs.js`**, **`src/core/map/geodata-builder.js`**,
**`src/browser/ui/control/search.js`**: `import proj4 from 'proj4'`
added; `this.proj4(...)` and `this.map.proj4(...)` call sites replaced
with the direct import.

**`src/core/map.ts`**: stale `core()` factory reference removed from the
class doc (the vts-core.js build that exported that factory is gone).
`assertAlive_()` got a missing doc comment.

### Current state

TypeScript passes. All three screenshot tests pass against a freshly
restarted dev server. The `vts-core.js` output is no longer produced.
The current follow-up also passes `simple-terrain`, `complex-terrain`,
and `full-terrain` screenshot checks after moving WebGL2 construction
failure handling into `GpuDevice`.

## 2026-05-14 — RFC: ConfigStore

Architectural discussion of the path to suppressing `core.js`. The
config routing system was identified as the main structural blocker:
three independent `this.config` stores (Browser, Core, LegacyMap),
a stringly-typed `setConfigParam(key, value)` chain, and a
string-prefix routing convention (`map*`, `renderer*`, `debug*`)
spread across four files.

Surveyed how MapLibre GL JS, CesiumJS, Babylon.js, and Pixi.js v8
handle configuration. None use a general reactive store. Babylon.js
is the closest: per-property observables on `Scene` that fire when
a setter is called. Pixi.js plugin self-selection (each plugin reads
its own slice from a shared options bag) is also relevant.

Evaluated `nanostores` and `@preact/signals-core` as off-the-shelf
implementations. Both lack the flush-at-frame-boundary contract
required by a renderer; recommendation is to write the store (~50
lines) rather than take a dependency.

Proposed design: a single `ConfigStore<ViewerConfig>` with `set()`,
`get()`, `watch(keys, fn)`, and `flush()`. The store holds no
domain knowledge. Subsystems receive the store reference at
construction and call `watch()` for the keys they own. The existing
`setConfigParam()` chain becomes a two-line compatibility shim
(`this.configStore.set({ [key]: value })`), removing all routing
logic in one step while allowing legacy JS call sites to continue
working indefinitely.

RFC written at `docs/wiki/rfc-config-store.md`. RFC lifecycle rules
and agent responsibilities added to `AGENTS.md`.

---

## 2026-05-14 — Style-based runtime free-layer gap

### Goal

Diagnose why the non-interactive demo's runtime geodata route is not
visible after the browser/core refactor work.

### Work done

`demos/core/style.json` was missing `version: 2`; Typia reported
`$input.version: expected 2, got undefined`. The style now validates.

`demos/core/index.html` registers `addRouteLayer()` on `map-loaded`.
Playwright instrumentation confirmed the listener fires and
`viewer.createGeodata()` returns a builder.

The route still does not render because style-based maps build
`map.freeLayerSequence` from `style.layers` in `MapStyle.refreshSequences`.
The legacy `MapInterface.addFreeLayer()` call only registers the object in
`map.freeLayers`. The old mapConfig demos also add an entry to
`view.freeLayers` and call `setView(view)`, but style-based maps bypass that
view activation path.

### Current state

`docs/wiki/backlog.md` records the runtime free-layer gap as deferred work.
No style-era runtime overlay API exists yet.

### Open questions

Design the new API for runtime style-based overlays. It should register the
geodata/free-layer source and the style layer or stylesheet used to render it,
then refresh the style-driven sequences. Do not hide legacy `view.freeLayers`
mutation inside `Viewer.addFreeLayer()`.

## 2026-05-14 — Wiki rename: core-build → non-interactive

`docs/wiki/core-build.md` was renamed to `docs/wiki/non-interactive.md`.
The filename `core-build` referred to the removed `vts-core.js` build
target; the file's content had already been rewritten to document
`interactive: false` usage. Three cross-references updated:
`docs/wiki/index.md`, `docs/wiki/architecture.md`, and an earlier entry
in this log.

`AGENTS.md`: added a paragraph on simplicity as a design criterion
(fewer moving parts preferred over more precise modelling).

## 2026-05-13 — TypeScript `Map` public class (CoreInterface replacement)

### Goal

Replace the legacy `CoreInterface` ES5 wrapper with a proper TypeScript
`Map` class as the public boundary for the core build. This is the first
step of the north-star refactor described in `architecture.md`: build the
`Map` TypeScript class before continuing method promotions, so that every
subsequent promotion goes through a typed public surface rather than
reaching into legacy internals.

The `Map.draw()` stub added here is the future home of the surface-tree
traversal replacement (the `feature/draw-surfaces` work).

### Work done

**`src/core/map.ts` created** — new TypeScript `Map` class replacing the
`CoreInterface` ES5 wrapper. Owns `Core` as a private field (`core_`).
Public surface: `[Symbol.dispose]()`, `destroy()` (deprecated),
`ready`, `on()`, `once()`, `loadMap()`, `unloadMap()`, VE / illumination /
atmosphere / rendering-options methods. The `core` getter is a typed
migration shim that fires `warnOnce` on every access.

**`Symbol.dispose` support** — `src/types/globals.d.ts` augmented with
`SymbolConstructor.dispose` so ts-loader picks it up without a lib target
change.

**`CoreInterface` deleted** — `src/core/interface.js` and
`src/core/interface.d.ts` removed.

**`LegacyMap` alias applied** — `viewer.ts`, `renderer.ts`, and `style.ts`
now import the old terrain engine as `LegacyMap` per the new AGENTS.md rule.
`src/core/index.js` updated to import `Map` from `./map`.

**`browser.js` updated** — constructs `Map` directly.

**`viewer.ts` updated** — `_core: Map`; `destroy()` calls
`_core[Symbol.dispose]()`; `destroyMap()` calls `_core.unloadMap()`.

**`src/core/map.ts`** also carries a private `draw()` stub — the future
home of the surface-tree traversal replacement.

**Wiki and backlog updated** — `architecture.md` object model, "current
state" table, event bus section; `backlog.md` Map class item marked
in-progress, new event bus migration item added.

**All three screenshot tests pass** — simple-terrain, complex-terrain,
full-terrain. No visual regressions, no console errors.

### Remaining

- Remove `Map.core` escape hatch once `Viewer` callers are promoted to
  proper `Map` public methods.
- Absorb `Core`, `LegacyMap`, `Renderer` into `Map` incrementally as
  feature work touches them.
- Event bus migration to `EventTarget` (separate backlog item).

---

## 2026-05-13 — index.ts, MapInterface promotion, map.ts cleanup

`src/core/index.js` migrated to TypeScript (`index.ts`). The ES5 alias
pattern ("get rid of compiler mess") replaced with clean imports and a
properly typed `core()` factory function. `index.js` deleted.

Six coordinate-conversion and hit-testing methods promoted from
`MapInterface` onto `Map` (`src/core/map.ts`):
`convertCoordsFromPublicToNav`, `convertCoordsFromNavToCanvas`,
`convertCoordsFromNavToPublic`, `convertCoordsFromNavToPhys`,
`convertCoordsFromPhysToCameraSpace`, `getHitCoords`.
Each delegates to `this.core_.mapInterface` internally; the JS wrapper
becomes a private implementation detail with no TypeScript exposure.

`src/core/map/interface.d.ts` deleted — no TypeScript module references
`MapInterface` by type. `interface.js` retained (Core still constructs
it internally).

`src/browser/viewer.ts` updated: `MapInterface` import and `_mapInterface`
getter removed; six call sites now delegate directly to `this.map_`.
Class JSDoc updated to reflect current bypass-point state.

`src/core/map.ts` method order cleaned up: lifecycle → rendering controls
→ coordinate conversion → event subscriptions → deprecated → shim → stub.

All three screenshot tests pass; `tsc --noEmit` clean.

---

## 2026-05-13 — Eliminate RendererInterface

`RendererInterface` (`src/core/renderer/interface.js`) deleted. It was
the last `*Interface` ES5 wrapper in the codebase.

Six inspector/replay GPU methods promoted onto `Renderer` as public
TypeScript methods: `createTexture`, `createMesh`, `createState`,
`setState`, `drawMesh`, `drawImage`, `drawLineString`. All carry JSDoc
naming the specific caller. Dead code (16 unused methods) discarded.

`getCanvasCoords` call sites in `draw-tiles.js` and `group.js` replaced
with direct `renderer.project2()` calls — already an exact equivalent.

`core.js` import and `getRendererInterface()` method removed.
`map.ts` updated to call `this.core_.renderer` directly.

Architecture doc updated: `*Interface` pattern section rewritten as
archaeology; `RendererInterface` row removed from dissolution table;
`Renderer` row updated to note it is no longer wrapped.
| `seProgression` / `SeProgression` | `veScaleRamp` / `VeScaleRamp` |

---

## 2026-05-05 — Contributor documentation refresh

### Goal

Replace inherited `vts-browser-js` contributor text with current
cartolina-js guidance.

### Work done

- Rewrote `CONTRIBUTING.md` around the current project scope, setup,
  testing expectations, pull-request contents, and wiki-update policy.
- Added contributor terms covering inbound project-license grants,
  provenance, third-party disclosure, and indemnity for breaches of those
  terms.
- Replaced the stale Melown-era code of conduct contact and wording with
  a project-scoped conduct document.

### Current state

Documentation-only change. No code tests were run.

## 2026-05-04 — CoreInterface declaration tightening

### Goal

Expose recent TypeScript-facing `CoreInterface` methods in the
declaration surface.

### Work done

- Added declarations and JSDoc for vertical exaggeration, illumination,
  atmosphere, and rendering-option methods on `CoreInterface`.
- Added JSDoc to nearby event and lifecycle declarations.

### Current state

TypeScript passes. No visual regression testing was needed because this
is a declaration-only change.

## 2026-05-04 — Architecture milestone note

### Goal

Record the first major modernization milestone for tile rendering and
map composition.

### Work done

- Added a concise architecture note: style specs become the only authored
  composition model, `TileRenderRig` becomes the only terrain tile render
  path, and legacy `mapConfig`/view support becomes an adapter before it
  is removed.

### Current state

Documentation-only change. No tests were run.

## 2026-05-04 — Depth-test demo regression and depth pipeline investigation

### Goal

Fix the depth-test demo (broken since af696bc6) and understand why
depth(vec) and depth(api) diverge by 600–3000 m.

### Work done

- Fixed `browser()` factory: checked `_coreInterface` (non-existent on
  `Viewer`) instead of `_core`, so it always returned `null`.
- Updated demo to use the flat `Viewer` API; promoted `getScreenDepth`
  onto `Viewer`.
- Investigated the depth discrepancy with runtime instrumentation:
  - Confirmed `convertCoordsFromPhysToCameraSpace` is arithmetically
    correct (uses the same `map.camera.position` that `getHitCoords`
    adds back, so the round-trip cancels).
  - Confirmed the phys→nav→phys round-trip through `convertCoords` is
    lossless (< 2 nm error).
  - Identified the actual cause: `getHitCoords` applies
    `getUnsuperElevatedHeight` before returning nav coords. The demo
    then converts those SE-adjusted coords back to phys, yielding the
    distance to the **geographic surface**. `getScreenDepth` reads the
    hitmap which stores distance to the **rendered (VE-exaggerated)
    surface**. The two are measuring different things when VE is active.
  - Verified by disabling VE at runtime: with VE off and `dilate=0`,
    both values are identical.
  - The `dilate` parameter in `getScreenDepth` samples a neighbourhood
    and finds closer terrain — appropriate for label occlusion checks,
    not for point depth testing. Removed from the demo.
- Renamed demo labels to reflect actual semantics: "Ground dist" (true
  geographic distance) and "Rendered depth" (VE surface depth).
- Added VE toggle button to the demo.
- Updated backlog entry for `checkVisibility` with confirmed root cause
  and corrected fix direction.
- Updated architecture doc to clarify the two future public API surfaces
  (`Map` and `Viewer`), the delegation strategy, and the `Map` class
  backlog item.

## 2026-05-04 — Remove renderer logicalSize alias

### Goal

Remove the deprecated `Renderer.logicalSize` alias.

### Work done

- Replaced live `renderer.logicalSize` references in `gmap.js` with
  `renderer.apparentSize`.
- Removed a commented-out dead `Renderer.project()` block that still
  referenced the old size getter.
- Removed the `Renderer.logicalSize` getter. `curSize` remains as a
  deprecated alias for now.
- Updated the rendering-size wiki page.

### Current state

TypeScript passes.

## 2026-05-04 — Move canvas size-change detection to GpuDevice

### Goal

Keep canvas size calculation and comparison in `GpuDevice`.

### Work done

- Added `GpuDevice.updateCanvasRenderTargetIfNeeded()`, which rebuilds
  the canvas target fields from DOM state, compares them with the
  current target, and installs a new canvas target only when a size
  field changed.
- Simplified `Renderer.updateSizeIfNeeded()` so it only handles the
  killed flag and the projection update that follows a canvas-target
  resize.
- Updated render-target and rendering-size wiki notes.

### Current state

TypeScript passes. Browser verification was not run for this ownership
cleanup.

## 2026-05-04 — Merge canvas resize into render-target setup

### Goal

Remove the separate canvas resize step from renderer call sites.

### Work done

- Removed public `GpuDevice.resizeCanvas()`.
- Changed `GpuDevice.setCanvasRenderTarget()` to derive canvas sizes,
  apply the DOM canvas CSS and backing-store sizes, install the canvas
  render target, and return it.
- Updated renderer call sites to call `setCanvasRenderTarget()` once
  before `setProjection()`.
- Updated render-target and rendering-size wiki notes to describe the
  new one-step canvas target contract.

### Current state

TypeScript passes. Browser screenshot verification was not run for this
small API consolidation.

## 2026-05-04 — NACIS label regression diagnostics

### Goal

Diagnose the NACIS presentation label regression on slide 30 by comparing
the production-good build with the development branch using equivalent
runtime diagnostics.

### Work done

- Added temporary pipeline diagnostics on both branches to list labels at
  each stage from job submission through `gmap`, `rmap`, hysteresis, and
  final output.
- Confirmed that `Figerhorn` reaches `gmap` on both branches. On the
  regression branch it was rejected in `RendererRMap.addRectangle()` by
  the depth test before reaching output.
- Confirmed the depth rejection came from a coordinate-space mismatch:
  `project2()` produced apparent-size screen coordinates, while
  `Renderer.getDepth()` converted those coordinates using
  `cssLayoutSize`. The sampled hitmap pixel moved from `[95, 299]` to
  `[134, 420]`, producing a nearer depth sample and rejecting the label.
- Tested a minimal fix where `getDepth()` samples by `apparentSize`.
  With that change, `Figerhorn` passes `rmapDepth`, is stored, and
  reaches output.
- Tested CSS-layout projection as a diagnostic only. It reproduced the
  historical label positions but shifted rendered labels off their
  apparent-screen positions, so it is not a valid fix for the current
  render-target model.
- Added `Renderer.CoordinateSpace` and threaded it through
  `getScreenRay`, `hitTest`, `hitTestGeoLayers`, `getDepth`, and
  `Map.getScreenDepth`. Public mouse-facing calls default to `layout`;
  label-depth testing passes `apparent`.
- Traced the right/bottom label band with `Brennkogel` as the target.
  The first divergence was in `processNoOverlap`: on the regression
  branch the label exited with `label-free-margin` because its apparent
  anchor `[2107.6, 1109.5]` was checked against `rmap` layout bounds
  `[1, 1, 1824, 971]`.
- Changed `RendererRMap.clear()` back to apparent-space bounds and block
  dimensions. With that diagnostic change, `Brennkogel` enters `gmap`,
  passes `rmapDepth`, is stored, and reaches output.
- Generalized the Playwright capture runner as
  `test/diagnostics/label-pipeline.js`. The default viewport is
  `1200x800`, and the script prints the URL and viewport used for each
  run.
- Added `label-regression-diagnostics.md` with the label-pipeline stages,
  divergence guide, coordinate-space checks, and temporary
  instrumentation rules.
- Updated `AGENTS.md` with the regression diagnostics trigger protocol
  and no-cargo-cult rule for speculative fixes.

### Current state

The coordinate-space API fix, `rmap` apparent-bounds fix, and reusable
diagnostic workflow are present on the feature branch. TypeScript
passes.

## 2026-05-04 — Refactor rendering sizes

### Goal

Redesign how rendering sizes are owned, stored, and propagated so that
the two canonical sizes — viewport size and apparent logical size — live
on the render target, with no special-casing per target class. Move size
calculation from `Renderer` to `GpuDevice`. See design input in
[rendering-sizes-redesign.md](rendering-sizes-redesign.md).

### Work done

- Renamed `RenderTarget.logicalSize` → `apparentSize`. Value meaning
  shifts from pre-transform `cssSize` to apparent logical size
  (`cssSize * cssScale`). `logicalSize` and `curSize` kept as deprecated
  aliases.
- Added three optional fields to `RenderTargetBase`: `cssLayoutSize`,
  `cssScale`, `dpr`.
- Added `GpuDevice.setCanvasRenderTarget()` — computes all five size
  fields from DOM; replaces `Renderer.calculateSizes()`.
- Added `GpuDevice.setAuxiliaryRenderTarget(texture, viewportSize)` —
  installs a framebuffer target that inherits size state from the canvas.
- Removed from `Renderer`: `calculateSizes()`, `applyCanvasState()`,
  `visibleScale_`, `mainViewportCssH`, `visibleScale()`,
  `createCanvasRenderTarget()`, `createFramebufferRenderTarget()`,
  `Renderer.CanvasState` type.
- Simplified `draw.js`: `screenPixelSize` formula no longer multiplies
  by `visibleScale`; `noOverlap()` returns raw worker values without
  division.
- `rmap.js`: `clear()` originally used `cssLayoutSize` for the
  collision-grid bounds. A later regression fix restored apparent-space
  bounds because projected labels are apparent-space coordinates.
- `map.js`: removed redundant `imageProjectionMatrix` recomputation
  in `getScreenDepth` — was already set by `switchToFramebuffer('base')`
  inside `drawHitmap()`.
- Updated `rendering-sizes.md` and `render-targets.md` to reflect the
  new API.

### Current state

TypeScript compiles with no new errors. Browser verification pending.

## 2026-05-03 — Add rendering sizes to stats panel

### Goal

Show render-target size information in the inspector statistics panel.

### Work done

Removed the top-level `PixelRatio` row from the second stats column.
Added a `Rendering sizes` subgroup under `Tiles`, after the LOD rows,
showing logical size, viewport size, visible scale, and DPR.

### Current state

TypeScript passes. Browser verification was not run because local
Chromium launch outside the sandbox was declined.

## 2026-05-03 — Remove cached GPU viewport field

### Goal

Remove duplicated viewport state from `GpuDevice`.

### Work done

Deleted the public `viewport` field. `GpuDevice.applyViewport()` now
uses `renderTarget_.viewportSize` directly, so the active render target
is the only stored source of GL viewport size.

### Current state

TypeScript passes. Canonical screenshot checks pass.

## 2026-05-03 — Remove renderer syncCanvas proxy

### Goal

Delete a private `Renderer.syncCanvas()` wrapper that only forwarded to
`GpuDevice.resizeCanvas()`.

### Work done

Inlined the three call sites and changed `GpuDevice.resizeCanvas()` to
accept readonly size pairs directly. This removed the proxy and the
tuple clones at each call site.

### Current state

TypeScript and canonical screenshot checks pass.

## 2026-05-03 — Document visible-scale transform assumption

### Goal

Clarify the CSS transform assumption behind `visibleScale()`.

### Work done

Replaced the `Renderer.calculateSizes()` TODO with a note that the code
treats CSS transforms as axis-aligned scale factors. This matches the
current reveal-style `scale()` use case. Rotation, skew, and composed
transforms would need a full DOM transform matrix instead of
`getBoundingClientRect()` ratios.

Updated `rendering-sizes.md` with the same limitation.

Added an `AGENTS.md` coding-style rule: multi-line comments use block
comment syntax (`/* ... */`), while single-line comments may use `//`.

### Current state

Documentation/comment only; no runtime behavior changed.

## 2026-05-03 — Clarify label visual-scale notes

### Goal

Record how label anchors, glyph offsets, collision boxes, and label
density relate to `visibleScale()`.

### Work done

Updated `rendering-sizes.md`: anchors are target-local logical
coordinates, while glyph/icon offsets and collision extents compensate
for `visibleScale()`. Noted that feature-count reduction currently uses
logical size without `visibleScale()`, which may be a policy question.

### Current state

Documentation only; no runtime code changed.

## 2026-05-03 — Encapsulate current GPU render target

### Goal

Prevent callers from assigning `GpuDevice.currentRenderTarget` directly.

### Work done

Moved storage to a private `renderTarget_` field and exposed
`currentRenderTarget` as a read-only getter. `Renderer` reads the active
target for size and kind checks, but target changes still go through
`setRenderTarget()`.

Added a coding-style rule: new or touched private TypeScript backing
members should use a trailing underscore when paired with same-name
read-only getters.

### Current state

No code outside `GpuDevice` can assign the current render-target field.
TypeScript and canonical screenshot checks pass.

## 2026-05-03 — Remove render-slot target rebind

### Goal

Remove the remaining defensive render-target self-rebind from
`MapRenderSlots.processRenderSlots()`.

### Work done

Deleted the `gpu.setRenderTarget(gpu.currentRenderTarget)` call before
render-slot callbacks. The base and auxiliary pass setup already binds
the intended render target before slot processing.

### Current state

Canonical screenshot checks pass for `simple-terrain`,
`complex-terrain`, and `full-terrain`.

## 2026-05-03 — Move screenshot output outside watched sandbox

### Goal

Stop screenshot regression checks from triggering webpack rebuilds while
they are capturing the dev server.

### Work done

Changed `test/screenshot.js` to write captures to `tmp/screenshots/`
instead of `sandbox/tmp/screenshots/`. Added `tmp/` to `.gitignore` and
updated `AGENTS.md`.

### Current state

Screenshot artifacts stay inside the working copy but outside the
watched `sandbox/` static directory.

## 2026-05-03 — Clarify renderer-local 3D terminology

### Goal

Resolve ambiguous renderer coordinate-space terms in
`docs/wiki/renderer-coordinate-spaces.md`.

### Work done

Verified the current renderer path in code:

- `src/core/map/camera.js` stores the physical camera position in
  `map.camera.position`, then sets the renderer camera position to
  `[0, 0, 0]` for normal rendering.
- `src/core/map/convert.js`, `src/core/renderer/draw.js`, and
  `src/core/renderer/renderer.ts` subtract `map.camera.position` or
  `renderer.cameraPosition` before projection.

Updated `renderer-coordinate-spaces.md` to use
**renderer-local 3D position** as the preferred term for
`physicalPosition - physicalCameraPosition`.

The screen-space draw helper note now says new renderer work should use
`RenderTarget.logicalSize` for target-local 2D coordinates. Calling these
helpers while an auxiliary target is active indicates a scheduling
problem.

The viewport-pixel relationship now identifies the final diagram as the
CPU-projected 2D helper path and separates it from the shader path for
normal GPU geometry.

### Current state

No runtime code changed. This was a documentation clarification only.

## 2026-05-03 — Resurrect feature/render-targets

### Goal

Resurrect the orphan branch `feature/render-targets` (RenderTarget
abstraction refactor). The branch was abandoned due to a visual
regression in the label hierarchy.

### Branches

- `fix/render-targets` — cherry-pick of `ce20f7a` onto main, with the
  render-target fix and diagnostics during investigation.
- `diag/main-labels` — main HEAD with identical diagnostic
  instrumentation (used as the correct-behavior reference).

### Diagnostic setup

Viewport: **1280×800** (Playwright headless). User's viewport is
1920×1080; at 1280×800 Brennkogel appears on both branches (not a
useful regression indicator). Use **Figerhorn** and **Kreuzwandspitze**
as the regression indicators at 1280×800.

Test script: `test/diag-labels.js` — loads the `complex-terrain` URL
on the dev server, waits 12 s, prints console output.

### What has been established empirically

**Feature IDs:**
- Figerhorn = OSM id **1712141446**, prominence 50.7
- Kreuzwandspitze = OSM id **2667064383**, prominence 51.2

**Sort order** (`radixSortFeatures` output, `featureCacheSize=209`):
Both branches produce **identical** top-25. Figerhorn ranks #10,
Kreuzwandspitze ranks #12. The bug is NOT in the sort.

**Placement loop** (`gmap6-place` log, logged inside `processGMap6`
for every feature when `featureCacheSize=209`):
- `diag/main-labels`: Figerhorn **OK** at cnt=15, Kreuzwandspitze
  **OK** at cnt=17. `pp=[195,468]`, `rect=[161,478,230,524]`.
- `fix/render-targets` before the fix: Figerhorn **SKIP** at
  cnt=14, Kreuzwandspitze **SKIP** at cnt=15. Same `pp` and `rect`.
- `fix/render-targets` after preserving the screen camera aspect for
  offscreen passes: Figerhorn **OK** at cnt=15, Kreuzwandspitze
  **OK** at cnt=17 through late settled frames.

**rmap.clear() reads `renderer.curSize`** (lines 36-37, 46, 52-53
in `rmap.js`). On `fix/render-targets`, `curSize` is a getter
returning `currentRenderTarget.logicalSize`. The leading hypothesis was
that `rmap.clear()` was seeing the 1024×1024 hitmap target. Logging
ruled this out: failing frames cleared the rmap at `1280×800`.

The actual regression was in `Renderer.switchToFramebuffer()`.
The render-target refactor routed all offscreen targets through
`updateLogicalSize()`, which calls `camera.setAspect(width / height)`.
For square hitmap targets this changed the camera aspect to `1`.
Legacy rendering changed `curSize` to the hitmap size and updated the
camera, but left the screen camera aspect intact. That is why the
depth map no longer matched screen-coordinate label depth checks.

Fix: bind the framebuffer target and viewport for `depth`, `geo`, and
`geo2` passes, but do not call `updateLogicalSize()` for those offscreen
passes. The base canvas pass remains responsible for syncing the screen
logical size and camera aspect.

Diagnostics were removed after the fix.

### Follow-up documentation

Added `render-targets.md` to document the render-target ownership rule:
auxiliary hitmap buffers are storage for the current screen view, so they
bind their framebuffer and viewport without changing camera aspect.

### Legacy render-to-image removal

Removed the unused legacy `Map.renderToImage()` path. It rendered the
current map view into a temporary power-of-two framebuffer texture and
read pixels back from it, but no demos, tests, or browser UI called it.
The real screenshot shortcut uses `Renderer.saveScreenshot()` and
`rendererAllowScreenshots`.

Removed with it:
- `MapInterface.renderToImage()`
- `MapDraw.drawToTexture()`
- the `texture` mode in `Renderer.switchToFramebuffer()`
- unused power-of-two helpers in `utils.ts`

### Screenshot test note

Parallel `test/screenshot.js` runs repeatedly triggered intermittent CDN
tile/resource fetch failures. Added an `AGENTS.md` note to run canonical
screenshot captures sequentially until that behavior is diagnosed.

### Rendering size documentation

Added `rendering-sizes.md` to document the renderer's size vocabulary:
canvas layout size, physical backing size, CSS visual scale, render-target
viewport size, render-target logical size, and `renderer.curSize`.
The page records the intentional reveal-style behavior where label
placement stays in pre-transform canvas coordinates while pixel-sized
visual features compensate with `visibleScale()` so labels keep stable
visible sizes under CSS transforms.

### Offscreen render-pass backlog

Added a backlog entry for the future offscreen render-pass API. It keeps
`GpuDevice.setRenderTarget()` as a low-level binding operation and calls
for higher-level pass setup to distinguish screen auxiliary targets from
independent targets, so shadow maps, selective blur, zenith rendering,
and future multipass work do not reintroduce hidden camera mutations.

### `curSize` clarification

Clarified that `renderer.curSize` is a backward-compatibility getter for
legacy code, not a recommended size source for new renderer work. Do not
use `curSize` in new code; choose explicit canvas, render-target logical,
viewport, or visual-scale sizes according to intent.

Also clarified `RenderTarget.logicalSize`: it is the width and height of
the target-local 2D coordinate system used when mapping projected NDC
coordinates into draw positions and when building `imageProjectionMatrix`,
not another name for physical framebuffer pixels.

Added `renderer-coordinate-spaces.md` to define renderer projection,
target-local 2D coordinates, screen-space draw helpers, and their
relationship to GL viewport pixels. This removes implicit terminology
from the render-target size docs.

### `renderer.logicalSize` and gmap.js fix

Introduced `Renderer.logicalSize` as a proper named getter proxying
`gpu.currentRenderTarget.logicalSize`. It is the right size source for
rendering code that must work for any render target: it returns
`canvasCssSize` during the canvas pass and the target's own logical
size during independent offscreen passes.

`curSize` is kept as a deprecated alias pointing to `logicalSize`.

The branch had cargo-culted the `canvasCssSize` change from the
camera-aspect fix into `gmap.js`, replacing the original `curSize`
calls there. Since `gmap.js` is only called from the canvas pass
anyway, the values were identical in practice — but the intent was
wrong. Reverted those calls to `renderer.logicalSize` so that gmap
correctly expresses "use the active target's logical size" rather than
hardcoding the screen view.

Updated `rendering-sizes.md` and `render-targets.md` to document
`logicalSize` and correct the practical rule and code examples.

### Framebuffer readback cleanup

Removed the legacy hitmap readback `fastMode` behavior for
`mapDMapMode == 2`; mode 2 now follows the normal direct readback path.
Moved framebuffer readback binding into `GpuDevice.readFramebufferPixels()`
and removed public raw framebuffer binding from `GpuTexture`, so render
target switching remains the only public draw-target operation.

Added the missing JSDoc for the new readback methods and exported GPU
types. Updated `AGENTS.md` to require a pre-commit check that new public
TypeScript methods and exported types have JSDoc in the same commit.

Clarified `AGENTS.md` module-placement guidance: new TypeScript modules
belong where the architecture says they belong, not automatically under
`src/core/`.

Removed `GpuDevice.canvasRenderTarget` as shared mutable side storage.
`Renderer` now creates the canvas render-target object from the current
`pixelSize` and `canvasCssSize` whenever it binds the base canvas pass.

Added field-level JSDoc for `GpuDevice` render-target types so
`viewportSize` and `logicalSize` are defined in code as well as in the
wiki.

Made `GpuDevice` viewport application private. Legacy callers that
previously called `setViewport()` now rebind `currentRenderTarget`, so
framebuffer and viewport restoration still go through the render-target
path.

Moved `test/screenshot.js` output from an external temporary directory
to ignored repo-local `sandbox/tmp/screenshots/`, restoring concrete
AGENTS documentation without referencing paths outside this working copy.

Restructured `src/core/renderer/gpu/device.ts` so preferred render
target, state, texture, and program-binding members/methods are
documented first. The legacy `useProgram()` attribute/sampler binding
path and its attribute-cache fields are now pushed lower and explicitly
marked deprecated. Clarified the legacy attribute-cache comment so it
does not imply VAOs are the active direction for the newer `useProgram2`
path. The comment now names `GpuMesh.draw2()` directly: newer mesh
rendering calls `useProgram2()`, then binds attributes through a VAO
built from caller-provided attribute names.

---

## 2026-05-03 — Render-target size cleanup

### Projection policy renaming

Renamed the two projection policy categories in the backlog from
`screen-view` / `target-native` to `auxiliary` / `independent` to
avoid terminology drift.

### `renderer.logicalSize` and gmap.js fix

Introduced `Renderer.logicalSize` as the canonical getter for
`gpu.currentRenderTarget.logicalSize`. Deprecated `curSize` as an
alias. Migrated all internal `curSize` reads in `renderer.ts` to
`logicalSize`.

Reverted the cargo-cult change in `gmap.js` that had switched
`renderer.curSize` to `renderer.canvasCssSize` as a side-effect of
the camera-aspect fix. The correct replacement is `renderer.logicalSize`.

### Removal of stored canvas-state fields

`Renderer.canvasCssSize` and `Renderer.pixelSize` were stored fields
that served only as a bridge between `applyCanvasState` and the two
consumers that immediately follow it at every call site. Both were
removed. The values are now threaded explicitly from fresh
`calculateSizes()` results. Change-detection in `updateSizeIfNeeded`
uses `this.logicalSize` and `gpu.currentRenderTarget.viewportSize`
for the old-value comparisons.

`visibleScale_` and `mainViewportCssH` were not removed: both are
read at render time outside the size-sync context.

### Comment style fixes

Converted `///` triple-slash comments on `logicalSize`, `curSize`, and
`mainViewportCssH` to JSDoc `/** */` style as required by AGENTS.md.
The `@deprecated` tag in a `/** */` block is what activates TypeScript
deprecation hints at call sites.

Removed the unused `GpuDevice.activeTexture` member. It was only stale
side storage; actual texture-unit binding is done directly through
`bindTexture()` and the few remaining raw WebGL call sites.

Made the opening `GpuDevice` class documentation wording more explicit
that the class is not truly a GPU-device abstraction despite its name.

Updated `AGENTS.md` regression diagnostics guidance: empirical
divergence tracing now sits under a regression bug diagnostics and
fixing heading, with the first step defined as creating a diagnostics
branch from the known-good state or production build commit.

Removed redundant wording from the `AGENTS.md` TypeScript module
placement guidance while keeping the architectural-owner rule.

Clarified the offscreen render-pass backlog terminology. Replaced the
ambiguous `cameraMode: 'screen' | 'target'` sketch with
`projectionPolicy: 'screen-view' | 'target-native' | 'none'`, and
defined screen-view auxiliary targets versus target-native offscreen
targets.

## 2026-04-19 — Trajectory: nadir departure + extent-proximity duration patches

### Goal

Fix two independent cases where ballistic flight duration was too long
relative to what was visually meaningful:

1. Departing from nadir (straight-down) view: yaw rotation during the
   departure phase is invisible, wasting `headingDuration` ms.
2. Translating a short distance within a tight viewport: the linear travel
   phase is barely perceptible, yet still consumed the full computed time.

### Work done

**`src/core/map/trajectory.js`** — two additions at the end of
`detectDuration()`:

**Patch 1 — near-nadir departure** (pre-existing; documented here):
- `headingDurationStart` is now independent of `headingDuration`.
- When `startPitch < −60°`, `headingDurationStart` is scaled toward 0 via
  `nadirFactor = (pitch + 90) / 30` (1 at −60°, 0 at −90°).
- `duration` is trimmed by the saved departure phase, floored at
  `minDuration`.

**Patch 2 — extent-proximity short flight** (new this session):
- After the nadir patch, checks whether `distance < min(e1, e2)`.
- If so, scales only the linear travel portion of `duration` by
  `max(distRatio, 0.2)`, where `distRatio = distance / min(e1, e2)`.
- Arrival phase (`headingDuration`) is left unchanged.

**`docs/wiki/trajectory-behavior.md`** — new reference page covering
phase structure, base duration rules, and both patches with worked
examples.

**`docs/wiki/index.md`** — added entry for `trajectory-behavior.md`.

### Non-obvious findings

- Using `meanExtent` instead of `min(e1, e2)` as the reference incorrectly
  triggers the short-flight patch on large-scale-change transitions (e.g.
  krkonose regional → central Europe continental). The mean of a small and
  a large extent is mid-range, so a 105 km flight falsely appears "short"
  and gets compressed to ~950 ms of travel with a 2,700 ms zoom-out
  at the destination — exactly the disorienting "pan then zoom" artifact.
  `min(e1, e2)` is the conservative bound: if the distance fits inside the
  *smaller* viewport, the travel is genuinely imperceptible from that view.

- The arrival `headingDuration` phase holds position at the destination
  while orientation settles. Extent and FOV continue interpolating via the
  raw double-smoothstep factor during this time. Compressing the linear
  phase while keeping `headingDuration` unchanged therefore makes the
  zoom-out/zoom-in portion appear to happen *after* the pan rather than
  during it when the two extents differ greatly — another reason to keep
  the patch scoped to same-scale transitions.

## 2026-04-15 — Added pitch-related styling limitations to reference

### Goal

Capture the non-obvious findings from checking whether line color can
depend on camera pitch.

### Work done

**`docs/wiki/label-styling-engine.md`**
- Added that camera pitch is not currently exposed as a normal style
  expression input.
- Documented the nearby precedent that tilt-aware behavior already
  exists for `dynamic-reduce` through `tilt`, `tilt-cos`, and
  `tilt-cos2`.
- Added the architectural note that geodata line color is resolved in
  worker-generated render jobs rather than at draw time, so exposing a
  `#pitch` variable alone would not be enough for live pitch-driven
  line color changes.

## 2026-04-15 — Backlog note for line dissipation by view angle

### Goal

Record the need for a future line-dissipation feature so the visual
motivation and likely implementation shape are not lost.

### Work done

**`docs/wiki/backlog.md`**
- Added a deferred feature item for pitch / horizon-based line
  dissipation.
- Captured the visual motivation: ridgeline-following boundaries become
  noisy and unnatural at high oblique angles and near the horizon.
- Noted the likely desired behavior: increased transparency as the view
  approaches that state, preferably as a built-in or style-configurable
  mechanism.
- Recorded the current limitation that line color is not currently
  driven by camera pitch through normal style expressions and is baked
  into worker-generated geodata jobs.

## 2026-04-15 — Clarified legacy documentation-source wording

### Goal

Remove a ghost note in the wiki index that incorrectly implied a
separate Web Archive documentation source.

### Work done

**`docs/wiki/index.md`**
- Removed the stray Web Archive note.
- Kept `melowntech/workshop` as the legacy conceptual reference already
  being pointed to.
- Kept `cartolina-tileserver/docs/resources.md` identified as the
  authoritative source for current resource definitions.

## 2026-04-15 — Wiki index as documentation hub

### Goal

Make the wiki landing page the actual documentation starting point by
moving the broader documentation-source guidance there.

### Work done

**`docs/wiki/index.md`**
- Added an `Other documentation sources` section.
- Moved the useful orientation pointers for `README.md`,
  `vts-browser-js` wiki, `melowntech/workshop`,
  `cartolina-tileserver`, and the backend `docs/resources.md` into the
  wiki landing page.
- Kept the backend resource docs marked as authoritative.

**`AGENTS.md`**
- Replaced the duplicated documentation-source prose with a shorter
  pointer to `docs/wiki/index.md` as the canonical documentation
  starting point.

## 2026-04-15 — Styling reference and wiki drift rule

### Goal

Turn the styling wiki note into a more reference-oriented page and make
wiki drift checks an explicit repository rule.

### Work done

**`docs/wiki/label-styling-engine.md`**
- Reworked the note into a compact styling reference page.
- Documented the non-obvious default that plain `linear` and
  `discrete` expressions are implicitly LOD-based.
- Added the explicit-domain `linear2` / `discrete2` forms, built-in
  scale-related `#...` values, `lod-scaled`, and the interaction with
  `line-width-units`.
- Retained the textured-line and `texture` vs `textured` findings in a
  more reference-style structure.

**`docs/wiki/index.md`**
- Updated the entry description for the styling page to match its new
  reference-oriented role.

**`AGENTS.md`**
- Added an explicit note that the wiki may drift from the code.
- Added the rule that, at an appropriate moment or on explicit wiki
  update requests, the current session must check for wiki drift and
  update obsolete or missing information.
- Added `index.md` and `label-styling-engine.md` to the wiki file list.

## 2026-04-15 — Wiki index page

### Goal

Create a dedicated wiki landing page with a table of contents so the
wiki does not depend on `architecture.md` as its navigation hub.

### Work done

**`docs/wiki/index.md`**
- Added a dedicated wiki index page with a table of contents covering
  overview pages and narrower subsystem / feature notes.
- Added a short navigation note describing the intended direction
  toward a more hierarchical reference-manual structure.

**`docs/wiki/architecture.md`**
- Removed the temporary wiki-guide section.
- Repositioned the page as an architecture document and pointed readers
  to `index.md` for navigation.

## 2026-04-15 — Label styling engine wiki note

### Goal

Document non-obvious style-engine findings discovered while checking
whether geodata lines support a dot-dash pattern.

### Work done

**`docs/wiki/label-styling-engine.md`**
- Added a focused note describing the shared `LetteringLayerBase`
  property family used by both `labels` and `lines`.
- Documented the bitmap-based textured-line path as the current way to
  achieve custom repeated line patterns.
- Recorded the current `line-style` spelling mismatch:
  TypeScript declares `textured`, while the runtime validator accepts
  `texture`.
- Described the effective shape and meaning of
  `line-style-texture`.

### Non-obvious findings

- The style engine has no dedicated numeric dash-array property for
  geodata lines. Patterned lines are authored as repeated bitmap
  strips.
- The `labels` and `lines` layer types share one broader styling base,
  which is why line-decoration properties live next to text and icon
  properties in the style spec.

## 2026-04-14 — Illumination style spec cleanup

**Branch:** feature/relief-lab

### Goal

Wire illumination, vertical exaggeration, atmosphere, and map config
flags correctly into the style spec, and make colour fields consistent
with the rest of the codebase.

### Work done

**`src/core/map/style.ts`**
- Added `config?: Record<string, unknown>` to `StyleSpecification`.
  `loadStyle` iterates it and calls `map.setConfigParam()` for each
  entry, so any map config flag can be set from style with factory
  options acting as override. See architecture note on the known
  awkwardness of this block.
- Moved `diffuseColor` from `IlluminationSpecification` into
  `LightSpecification`, where it belongs semantically alongside
  `specularColor`.
- Renamed `specular` → `specularColor` in `LightSpecification` for
  consistency.

**`src/core/map/map.d.ts`** — declared `setConfigParam(key, value)`
which was missing from the type declaration.

**`src/core/renderer/renderer.ts`**
- Updated `IlluminationDef`, the internal `Illumination` type,
  `setIllumination()`, and `getIllumination()` to match the new
  field layout (`specularColor`, `diffuseColor` inside `light`).
- Changed colour range for `specularColor` and `diffuseColor` from
  0–1 to 0–255, consistent with the rest of the style/API colour
  convention. `getIllumination()` multiplies back to 0–255 on the way
  out so the round-trip is stable.
- Added JSDoc to `IlluminationDef`.

**`demos/relief-lab/index.html`** — updated `applyIllumination()` and
`syncFromIllumination()` to use the new field names and `hexToRgb255`
/ `rgb255ToHex` helpers instead of the old 0–1 converters.

**`docs/wiki/architecture.md`** — added colour encoding convention
note, style `config` block awkwardness note, and `mario` obsolete
config key note.

**`AGENTS.md`** — expanded documentation rules: adding JSDoc to
existing non-trivial functions is encouraged; `@link` clarified to
mean all hyperlink-producing tags.

### Non-obvious findings

- `validateNumberArray` mutates its input array in place. When
  `getIllumination()` returned 0–1 values and the UI called
  `setIllumination()` with the result, the `/255` conversion fired
  again, driving colours to near-zero (black) on the third toggle.
  Fixed by making `getIllumination()` return 0–255 throughout.
- The style `config` block passes the full flat config namespace
  through to the map, which means it can set UI-level options (compass,
  search bar) that have nothing to do with visual styling. A cleaner
  split between rendering config and application config is noted in
  architecture.md as future work.

## 2026-04-14 — `Viewer.checkVisibility()` kept experimental only

### Goal

Keep the public visibility-check API available for future debugging or
iteration, but stop relying on it in the waypoint demo until its depth
comparison is made reliable.

### Work done

**`src/browser/viewer.ts`** — retained `checkVisibility(pos, mode)` on
the public `Viewer` surface, but marked it in JSDoc as experimental and
unreliable.

**`demos/waypoint/waypoint.js`** — removed the demo's dependency on
`viewer.checkVisibility(...)` and restored the original simple behavior:
markers are shown whenever their projected point is in front of the
camera, subject only to waypoint `show` / `hide` filtering.

**`docs/wiki/waypoint-spec.md`** — reverted the demo spec to the
front-of-camera-only marker behavior and noted that the public
visibility API exists but is not used by the demo.

## 2026-04-14 — `waypoint` demo: terrain-occluded marker visibility

### Goal

Hide waypoint markers when terrain in the current view occludes their
anchored geographic position.

### Work done

**`src/browser/viewer.ts`** — added `checkVisibility(pos, mode)` as a
flat public `Viewer` method. It converts public coords to nav/canvas,
samples the existing cached hitmap via `map.getScreenDepth()`, and
compares terrain depth against point depth with the same tolerant
behavior used for label occlusion.

**`demos/waypoint/waypoint.js`** — marker updates now call
`viewer.checkVisibility(...)` before placing the HTML overlay element.
Markers still use canvas projection for placement, but hidden markers
are no longer drawn through the globe.

**`docs/wiki/waypoint-spec.md`** — updated the marker loop and replaced
the old occlusion limitation note with the new depth-map behavior and
its cached-hitmap caveat.

### Non-obvious findings

The existing hitmap path is already suitable for this feature, but it
is intentionally cached and throttled by `mapDMapCopyIntervalMs`.
Waypoint occlusion therefore tracks terrain correctly without new render
paths, while still allowing a small delay during camera motion.

## 2026-04-14 — `waypoint` demo: marker filters and occlusion docs

Follow-on to the initial waypoint implementation.

### Goal

1. Document the HTML-overlay occlusion limitation (markers visible
   through the planet during cross-planetary navigation).
2. Add per-marker `show` / `hide` filter lists referencing symbolic
   waypoint names, so authors can suppress off-context markers.

### Work done

**`demos/waypoint/waypoint.js`**
- Header comment: added `DEPTH / OCCLUSION LIMITATION` and `MARKER
  VISIBILITY FILTERING` sections; updated CONFIG SCHEMA to show
  `name`, `show`, and `hide` fields.
- `_updateMarkers()`: filter step added before projection. Reads
  `this._config.positions?.[this._index]?.name` and tests against
  `marker.show` / `marker.hide` before any coordinate conversion.

**`demos/waypoint/config.example.json`** — added `"name"` to all
three positions; added `"show": ["whitney"]` to the clip-art marker.

**`docs/wiki/waypoint-spec.md`** — updated config schema, marker
update loop, and added occlusion limitation section; updated
Modified files list to reflect the actual screenshot.js changes.

### Key decision

`show` / `hide` reference symbolic waypoint names (not indices) so
filters remain stable when positions are reordered or new entries
are inserted.

## 2026-04-14 — `waypoint` demo: implementation

See [waypoint-spec.md](waypoint-spec.md) for the full specification.

### Goal

New `demos/waypoint/` demo: a geographic story / presentation device.
Arrow-key navigation flies the camera between a JSON-configured list
of map positions. HTML image markers stay pinned to geographic
coordinates. Embeddable as a vanilla ES module in reveal.js
presentations.

### Work done

**`demos/waypoint/waypoint.js`** — self-contained vanilla ES module.
Exports `WaypointMap`. Manages flyTo navigation, marker projection
loop (subscribes to `'tick'`), keyboard handler, and lifecycle.

**`demos/waypoint/index.html`** — demo page. Fetches and
placeholder-expands the style (same `__backend__` pattern as
`demos/map/`) before passing the object to `WaypointMap`. URL params:
`style=`, `config=`, `backend=`.

**`demos/waypoint/config.example.json`** — three positions (Whitney,
Grossglockner, Glacier Peak) and one marker using the clip-art URL.

**`src/browser/viewer.ts`** — added
`convertCoordsFromPublicToNav()` and `convertCoordsFromNavToCanvas()`
in the "Hit testing and coordinate conversion" section.

**`src/core/map/interface.d.ts`** — declared both new methods on
`MapInterface`.

**`test/screenshot.js`** — added `${config}` substitution; fixed
template fallback logic so `{ "dev": "waypoint" }` entries are
gracefully skipped on the prod side rather than falling back to the
default CDN template.

**`demos/index.html`** — new demo index listing six demos:
simple-terrain, complex-terrain, map, relief-lab, depth-test,
waypoint.

### Key decisions

- **Module shape:** vanilla ES module in `demos/waypoint/waypoint.js`.
  No webpack entry; loaded directly alongside `cartolina.js`.
- **Marker anchor:** bottom-center of the image sits on the geo point.
  Default display height 90 px, proportional width. Overridable via
  `height` / `width` per marker.
- **Terrain-surface markers:** `coords` with 2 elements (lon/lat)
  uses `'float'` height mode; 3 elements uses `'fix'`.
- **Reveal.js:** one-reveal-slide-per-waypoint pattern. `keys: false`
  disables keyboard listeners. Slides without `data-waypoint` are
  skipped; mixed decks work.
- **Style template expansion:** lives in `index.html`, not in
  `WaypointMap`. The class accepts a pre-resolved style object,
  keeping it backend-agnostic.

### Non-obvious findings

- The `convertCoordsFromNavToCanvas` return value uses `depth <= 1`
  to indicate a point is in front of the camera (consistent with
  the existing `measure.js` usage in `src/browser/ui/`).
- The screenshot test `buildUrl` function silently fell back to
  `default` when a template object omitted a side (e.g. prod). This
  caused incorrect prod URLs for dev-only templates. Fixed by
  returning `null` instead of falling back.
- CDN-hosted styles contain `__backend__` placeholders even when
  fetched directly; expansion must happen before `cartolina.map()`
  receives the object.
- `_buildMarkers` originally set `containerEl.style.position =
  'relative'` unconditionally, collapsing a `position: absolute;
  top: 0; bottom: 0` container to zero height. Fixed by checking
  `getComputedStyle(el).position === 'static'` first.

### Verification

- `npx tsc --noEmit` passes.
- `node test/screenshot.js simple-terrain` — dev ok, prod ok.
- `node test/screenshot.js complex-terrain` — dev ok, prod ok.

## 2026-04-14 — Style validation moved to exact typia

**Branch:** feature/strict-ts-checks

### Spec

Enable exact typia validation for style objects and widen the TypeScript
style schema so the shipped demo styles validate cleanly without the
previous manual top-level key check.

### Work done

**`src/core/map/style.ts`** now uses
`typia.createValidateEquals<MapStyle.StyleSpecification>()`.

The style schema was widened to reflect the actual stylesheet language
currently in use:

- `'vertical-exaggeration'` remains the canonical field name.
- `constants` and `bitmaps` now use a recursive expression type instead
  of placeholder `any`.
- The expression type covers the object-form operators used by the
  demos and supported by `worker-style.js`, including `if`, arithmetic
  operators, `linear2`, `discrete2`, `logScale`, `str2num`,
  `uppercase`, `round`, and related helpers.
- Lettering layers now explicitly allow computed local fields with
  `&...` keys instead of relying on a blanket loose object shape.
- The internal free-layer stylesheet compilation path was tightened to
  use concrete types instead of `any`.

### Non-obvious findings

- Exact validation was viable once the real stylesheet DSL was modeled
  directly in TypeScript. The earlier need for a hand-written top-level
  key check was a schema-gap problem, not an inherent typia limitation.
- The important compatibility boundary is the stylesheet language
  actually accepted by `worker-style.js`, not just the visible top-level
  style object shape.
- The demo styles did not reveal any suspicious authored values in this
  pass; the main missing piece was the recursive expression vocabulary.

### Verification

- `npx tsc --noEmit` passes.
- All demo styles under `demos/map/styles/*.json` load in the browser
  smoke test with no style-validation errors.
- `node test/screenshot.js simple-terrain` passes in dev and prod.
- `node test/screenshot.js complex-terrain` passes in dev and prod.
- `node test/screenshot.js full-terrain` passes in prod; dev still hit
  external fetch failures, so treat that as a data-path verification gap
  rather than an exact-validation regression.

## 2026-04-13 — Style validation tightened around top-level schema

**Branch:** feature/strict-ts-checks

### Spec

Make style validation catch typoed top-level fields such as
`verticalExaggeration`, align the TypeScript style spec with the
canonical `vertical-exaggeration` wire key, and remove the `as any`
escape hatch from vertical-exaggeration loading.

### Work done

**`src/core/map/style.ts`** — changed `StyleSpecification` to use the
canonical `'vertical-exaggeration'` key, removed the direct `any`
escape when reading it, and routed validation through a new
`validateStyleSpecification()` helper.

That helper keeps typia's existing structural validation for nested
objects but adds exact checking for the top-level style object. Unknown
top-level keys now fail validation with a direct error, and the common
camelCase typo suggests the supported hyphenated spelling.

The same pass also corrected two style-spec mismatches surfaced by the
stricter check:

- `label-origin` is typed as a string-valued property.
- `zbuffer-offset` uses the runtime spelling already consumed by the
  geodata worker and demo styles.

### Non-obvious findings

- Full `typia.createValidateEquals()` exactness was too disruptive for
  the current style ecosystem. Existing demo styles use nested
  expression objects and legacy ad-hoc keys that are accepted by the
  runtime but not representable as an exact recursive schema yet.
- The practical boundary today is therefore: exact top-level style
  object, permissive nested structures.
- The earlier `verticalExaggeration` / `vertical-exaggeration`
  mismatch had gone unnoticed because typia's non-exact validator does
  not reject unknown extra keys.

### Verification

- `npx tsc --noEmit` passes.
- All example styles under `demos/map/styles` load in the demo app with
  no style-validation errors.
- A deliberate camelCase `verticalExaggeration` style fails with:
  `did you mean 'vertical-exaggeration'?`
- `node test/screenshot.js simple-terrain` passes in dev and prod.
- `node test/screenshot.js full-terrain` passes in dev and prod.
- `node test/screenshot.js complex-terrain` passes in prod; dev hit
  remote geodata fetch failures, so treat that as an external data-path
  verification gap rather than a validator regression.

## 2026-04-13 — Strict TypeScript completed

**Branch:** feature/relief-lab

### Spec

Enable `"strict": true` in `tsconfig.json` and fix all resulting
errors so the codebase compiles cleanly under strict mode.

### Work done

Strict mode now compiles cleanly. The work started from a large batch of
implicit-`any` errors and finished with a smaller set of real nullability,
discriminated-union, and tooling-path issues in the render and style
loading paths.

The outcome included both code changes and migration-rule cleanup:

- **`AGENTS.md`** — added `npx tsc` to the auto-approved command list
  and tightened the JS→TS migration guidance: do not use `any` /
  `unknown` when the real shape already exists in `types.ts`, a sibling
  `.d.ts`, or an imported legacy `.js` module.
- **`src/core/map/interface.d.ts`** — added the missing declaration next
  to the legacy ES5 `MapInterface` implementation so TypeScript callers
  consume concrete method signatures instead of inferred `any`.
- **`src/browser/index.ts`** — removed `unknown` from
  `MapRuntimeOptionValue`; that union had collapsed the whole type to
  `unknown`.
- **`src/browser/viewer.ts`** — replaced placeholder types on the new
  public API with concrete runtime/config shapes.
- **`src/core/map/tile-render-rig.ts`** and
  **`src/core/renderer/renderer.ts`** — resolved the remaining strict
  issues without weakening types, mainly by tightening discriminated
  unions and handling actual nullable states.
- **`src/core/map/style.ts`** — replaced the ad-hoc `any` mapConfig
  load with a concrete local `SurfaceMapConfig` type and narrowed the
  typia validation failure branch explicitly.
- **`src/types/globals.d.ts`** — added `declare module '*.css'` so the
  browser entrypoint's side-effect stylesheet imports are accepted by
  editor and webpack TypeScript tooling.

### Non-obvious findings

- A union that includes `unknown` is just `unknown`, so it silently
  defeats the whole annotation.
- The final strict failures were not more annotation work; they were
  actual model inconsistencies such as maybe-null GPU resources and
  optional layer fields that needed proper narrowing.
- `npx tsc --noEmit` and the webpack/editor TypeScript path do not
  always fail on the same set of issues. CSS side-effect imports and
  typia narrowing in `style.ts` were caught by the latter.

### Verification

- `npx tsc --noEmit` passes.
- `node test/screenshot.js simple-terrain` passes in dev and prod.
- `node test/screenshot.js complex-terrain` passes in dev and prod.
- `node test/screenshot.js full-terrain` still reports remote tile fetch
  failures in both dev and prod; treat this as an external verification
  gap rather than a local compile/runtime regression.

## 2026-04-13 — dist build regression after BrowserInterface removal

**Branch:** feature/relief-lab

### Spec

Restore the production dist bundle after the `Viewer` migration:
`cartolina.min.css` had disappeared from output and the legacy browser
API shape had regressed.

### Work done

**`src/browser/index.ts`** — moved browser CSS imports to the browser
entry module so webpack still emits `cartolina.min.css` and
`cartolina.min.css.map` after wrapper refactors.

### Non-obvious findings

- Removing `BrowserInterface` also removed the only browser-CSS side
  effect imports, so webpack silently stopped emitting the stylesheet.

- The missing browser CSS was enough to mimic a major runtime failure:
  the browser/map wrapper lost its full-size layout and the generic
  fallback "needs WebGL capable browser" overlay became visible because
  CSS, not code, hides it by default.

## 2026-04-13 — Viewer TS API and JS→TS migration groundwork

**Branch:** feature/relief-lab

### Spec

Establish `Viewer` as the typed TypeScript public API surface, put
migration rules in place, and apply them to a first concrete case.

### Work done

**`src/browser/viewer.ts`** — new `Viewer` class wrapping `Browser` /
`CoreInterface`. Flat, typed method surface covering lifecycle, events,
camera, render control, coordinate conversion, and hit-testing.
Exported as the type alias `Map` from the package index.

**`src/core/types.ts`** — shared primitive types for the core layer:
`HeightMode`, `Lod`, `CoreEventMap`. `CoreEventMap` types the event
name parameter on `on()` / `once()` so unknown event names are a
compile error.

**`src/core/interface.d.ts`** — declaration file alongside
`interface.js`, replacing the earlier `ICoreInterface` boundary
interface in `types.ts`. Shape declaration co-located with
implementation.

**`src/core/map/surface-tile.d.ts`** — declaration file alongside
`surface-tile.js`, covering the properties accessed by
`tile-render-rig.ts`. Replaced the local `SurfaceTile` adapter type
that was defined at the bottom of that file.

**`AGENTS.md`** — JS→TS migration rules section added (when to use
direct JS references, `.d.ts`, or `types.ts`).

**`docs/wiki/architecture.md`** — event bus, kill pattern, and
Browser→Viewer dissolution goal documented.

### Design decisions

- No parallel boundary interfaces (`IFoo` in a separate file). Use
  `.d.ts` next to the `.js` for complex shapes; use `types.ts` for
  simple reusable primitives. Both patterns validated this session.

- `Viewer` is the only place for new public functionality. `Browser`
  is legacy infrastructure on the path to dissolution — nothing new
  goes there.

- `CoreEventMap` payloads typed as `unknown` for now; the value is
  in the typed event names, not the payloads.

### Non-obvious findings

- `@ts-ignore` is not needed on JS module imports under `allowJs`.
  TypeScript resolves them cleanly without it.

- A single `as T` cast is sufficient when the source is `any`.
  The `as unknown as T` double cast is only needed when both the
  source and target are concrete, non-overlapping types.

- `.d.ts` alongside `.js` works correctly under `allowJs: true` —
  TypeScript prefers the `.d.ts` over inferred JS types even when the
  JS file is part of the compilation. The pattern is valid for
  incremental migration.

## 2026-04-12 — labels render flag

**Branch:** main

### Spec

Add a `labels` render flag (`useLabels`, `FlagUseLabels`) that
suppresses style-defined labels from the user’s perspective and expose
it through map options, diagnostics render-flags mode, and
`demos/relief-lab`.

### Design decisions

- The public-facing `labels` flag is implemented by suppressing the
  geodata/free-layer render paths in the draw loop, because authored
  label layers are compiled into synthetic geodata free layers.
- The effective value follows the same precedence as the other render
  flags: `renderer.debug.flagLabels ?? map.config.mapFlagLabels`.
- The flag is propagated through the frame render-flags UBO even though
  no current shader consumes it directly.
- Geodata hit-testing is gated by the same effective flag so hidden
  labels do not remain hoverable or clickable.
- Diagnostics render-flags mode uses plain `k` for labels, leaving the
  existing `Shift+K` “all labels” debug shortcut intact.

## 2026-04-12 — relief-lab atmosphere controls

**Branch:** main

### Spec

Add live atmosphere controls to the `Light & Shading` tab in
`demos/relief-lab`, with public core/browser API readback and update
support.

### Design decisions

- The public atmosphere API exposes only the three runtime-tunable
  fields: `maxVisibility`, `visibilityToEyeDistance`, and
  `edgeDistanceToEyeDistance`. These are defined on
  `Atmosphere.RuntimeParameters`; `Atmosphere.Specification` is derived
  as `MapBody.Atmosphere & RuntimeParameters` (not the reverse) to avoid
  duplicating the field definitions.
- `setAtmosphere()` / `getAtmosphere()` are on `CoreInterface` and
  `BrowserInterface` only. They reach `map.atmosphere` directly — the
  renderer interface is not in the chain.
- `markDirty()` is called inside `Atmosphere.setRuntimeParameters()`
  via `this.renderer.core.map.markDirty()`, so the interface layer does
  not need to handle it.
- The `useAtmosphere` render flag remains the master on/off switch and
  is replicated at the top of the new panel section; disabling it does
  not discard the authored atmosphere parameter state.
- The two ratio parameters remain presence-based optionals, so the UI
  uses checkboxes to control whether each field is authored at all.

## 2026-04-12 — relief-lab demo and runtime-state sync

**Branch:** main

### Spec

Implement `demos/relief-lab/index.html` from
[docs/wiki/relief-lab-spec.md](relief-lab-spec.md), then make the demo
follow live map state rather than initializing itself from style JSON.

### Design decisions

- Added public renderer readback for illumination, rendering options,
  and vertical exaggeration, proxied through renderer/core/browser
  interfaces, so the demo can treat the map as the source of truth.
- `setIllumination()`, `setRenderingOptions()`, and
  `setVerticalExaggeration()` now mark the map dirty so runtime changes
  redraw immediately.
- The demo polls those public getters on each `tick` and reconciles its
  controls from live renderer state instead of reading style internals.
- Rendering-option overrides remain on `renderer.debug`; the public API
  intentionally reuses that existing storage rather than introducing a
  second override layer.
- `useLighting` remains part of illumination rather than
  `RenderingOptions`; the frame render flag follows
  `illumination.useLighting` through the existing illumination-state
  path.
- `diffuseColor` was added to the authored illumination spec and
  renderer runtime, replacing the previous hardcoded white diffuse term.

## 2026-04-11 — Geographic illumination mode

**Branch:** main

### Spec

Add a second illumination light type, `geographic`, alongside the
existing observer-relative `tracking` light.

### Design decisions

- The public light shape stays shared across modes:
  `{ type, azimuth, elevation, specular? }`, with legacy tuple syntax
  kept for `tracking` only.
- Runtime illumination state stores one authored vector plus the two
  renderer-facing derived vectors, `vectorNED` and `vectorVC`.
- `tracking` keeps the existing lNED-authored behavior: `vectorVC` is
  initialized once in `setIllumination()`, while `updateIllumination()`
  recomputes only `vectorNED`.
- `geographic` authors the vector in scene-center NED: `vectorNED` is
  initialized once in `setIllumination()`, while
  `updateIllumination()` derives only `vectorVC` through the existing
  `ned2lned`/`ned2vc` path.
- `setIllumination()` is now proxied on renderer, core, and browser
  interfaces just like `setVerticalExaggeration()`.

### Non-obvious finding

Style loading can call `setIllumination()` before `map.position` is
initialized. The geographic runtime recompute therefore needs a guarded
initialization path and must defer the full position-dependent update to
the first render-frame refresh.

## 2026-04-11 — Fully functional aspect-based shading

**Branch:** main

### Spec

Finish the previously plumbed aspect shading mode so it affects diffuse
terrain shading together with Lambertian and slope shading.

### Design decisions

- `diffuseCoef()` now centralizes the shading combination logic instead
  of duplicating the per-term calculations inline in `main()`.
- The combined shading formula is treated as a weighted geometric mean
  of the three shading coefficients' complements, then remapped back to
  the final shading coefficient.
- The accumulator was named `diffuseComplement` to reflect the math more
  accurately than the earlier `invDiffuseCoef`.

### Non-obvious finding

Aspect shading produced black speckles on nearly flat terrain. The
underlying issue was not the weighted-product formula itself but numeric
instability in the projected-direction cosine used by the aspect term:
on flat areas the tangent-plane projection of the normal approaches
zero, so aspect needs a neutral fallback in those degenerate cases to
avoid visible artifacts.

## 2026-04-11 — Aspect shading flag/weight plumbing

**Branch:** main

### Spec

Add a third diagnostic/configurable shading mode, `aspect`, following
the existing Lambertian and slope plumbing. The new mode must expose:

- `mapShadingAspect` config flag, default `false`
- `shadingAspectWeight` illumination/style option, default `0.25`
- renderer debug override and frame-UBO propagation
- diagnostic render-flags toggle on plain `x` inside `Shift+F`

The fragment shader must receive the new flag and weight but must not
change rendered output yet.

### Design decisions

- Aspect shading uses the next render-flag bit after slope
  (`FlagShadingAspect = 1 << 9`).
- `shadingParams.z` carries the aspect weight; `w` stays reserved.
- The diagnostic shortcut remains `a` for atmosphere; aspect uses `x`
  to avoid conflicting with the existing render-flags key map.

### Non-obvious finding

The tile fragment shader already computes an `aspectCoef`, so the
plumbing work only needed a no-op reference to the new flag/weight to
keep them live without changing shading behavior.

## 2026-04-10 — Scale-denominator vertical exaggeration

**Branch:** main
**HEAD:** 4c2239734393de3a99c334699243ffc10931143e

### Spec

> *Reconstructed from session context — review for accuracy.*

Introduce a new `vertical-exaggeration` style interface with two
independent components:

**1. Elevation ramp** — piecewise linear by terrain height, same
semantics as the existing `heightRamp`. Specified as two pivot pairs:

```yaml
vertical-exaggeration:
  elevationRamp:
    min: [height_min, factor_min]
    max: [height_max, factor_max]
```

**2. Scale-denominator ramp** — power-law function of the CSS scale
denominator. Specified as two pivot pairs:

```yaml
vertical-exaggeration:
  scaleRamp:
    min: [sd_min, va_min]
    max: [sd_max, va_max]
```

The scale denominator is a cartographic quantity independent of canvas
size and DPI:

```
sd = extent / (cssH_px / cssDpi * 0.0254)
```

where `cssH_px` is the apparent canvas height in CSS pixels and
`cssDpi` defaults to 96.

The ramp is log-log linear (power law) between the two pivots:

```
va(sd) = va_min * (sd / sd_min) ^ (log(va_max / va_min) / log(sd_max / sd_min))
```

At `sd = sd_min` this returns `va_min`; at `sd = sd_max` it returns
`va_max`. Outside the range, `sd` is clamped.

**Compatibility:** The legacy `heightRamp` / `viewExtentProgression`
style syntax must continue to work. It is converted internally to the
new `veScaleRamp` representation using a canonical canvas height of
1113 CSS px (the historical tuning baseline), giving 1:1 behavioural
equivalence at that height.

**New public method** `setVerticalExaggeration(spec)` on `Renderer`,
proxied on `RendererInterface`, `CoreInterface`, and `BrowserInterface`.

**New config param** `rendererCssDpi` (default 96) for deployments
where CSS DPI differs from the standard.

### Design decisions

- The internal type `VeScaleRamp { sd0, va0, sd1, va1, exponent }`
  replaces `SeProgression`. The exponent is precomputed as
  `log(va1/va0) / log(sd1/sd0)`.

- Legacy `viewExtentProgression` input is converted to `veScaleRamp` at
  load time using a canonical 1113 CSS px height. This value matches the
  historical tuning baseline (maximized browser window on the development
  machine), giving a 1:1 behavioural match for existing styles.

- `VerticalExaggerationSpecification` in `style.ts` is a strict
  discriminated union: new format (`elevationRamp`/`scaleRamp`) or legacy
  format (`heightRamp`/`viewExtentProgression`), never mixed.

- `rendererCssDpi` (default 96) is a new renderer config param for
  deployments where CSS DPI differs from the standard 96.

### Non-obvious finding: hitmap framebuffer and `curSize`

During label hierarchy computation, the engine periodically switches to
a fixed-size offscreen framebuffer (hitmap). This temporarily sets
`curSize = [hitmapSize, hitmapSize]`. Any code reading `this.css()[1]`
during this window gets the framebuffer height instead of the viewport
height.

**Fix:** `mainViewportCssH` — a dedicated field updated only in
`applySizes` (called on real viewport resize). `currentScaleDenominator`
uses this field instead of `this.css()[1] * this.visibleScale_[1]`.

### Renames

| Old name | New name |
|---|---|
| `getSeProgressionFactor` | `getVeScaleFactor` |
| `setSuperElevationProgression` | `setVeScaleRampFromProgression` (deprecated) |

---
