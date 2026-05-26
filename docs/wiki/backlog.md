# Task backlog

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

The replay inspector (see
[archaeology-replay-inspector.md](archaeology-replay-inspector.md))
required a snapshot step followed by a separate display step, with five
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
Legacy draw code scopes ambient camera and position reads with
`withSelectionCamera` and `withNavigationCamera`. Final terrain and
geodata rendering use the navigation context for camera matrices while
passing the selection position to `Renderer.updateBuffers()` or
`drawGpuJobs()` so scale-dependent vertical exaggeration follows the
selected tile set. `src/core/inspector/freeze.ts` owns mode state, DOM
controls, and frustum capture. `Renderer` draws the frustum with the
modern `useProgram2` shader path.

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

2. Move the map draw function and the frame loop onto typed `Map`.
   **Promoted to [rfc-map-frame.md](rfc-map-frame.md).**

   The RFC moves `MapDraw.drawMap` into `Map.draw` and
   `LegacyMap.update` into `Map.tick`, with a residual
   `LegacyMap.tick` for the loader / worker / deferred-event work
   that has not been promoted yet. The "simplified draw function"
   wording of the original brief is satisfied by earlier shrink
   refactors; the remaining win is the relocation and TypeScript
   rewrite, not further size reduction. Also covers the audit and
   relocation of post-`55a34f27` additions on `LegacyMap`
   (`drawChannel`, overlay registry, `initFrame`, position
   accessors). `MapInterface` deletion runs as an independent
   track — see the dedicated entry below.

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
**Status:** open — independent track, no design overlap with
[rfc-map-frame.md](rfc-map-frame.md)

### Goal

Delete `src/core/map/interface.js`. Today it is a thin layer that
delegates 69 methods to `LegacyMap` (after the render-slot removal in
commit `ff70938e`). `Viewer` reaches it via the `legacyMapInterface_`
getter.

### Plan

For each method `Viewer` calls via `legacyMapInterface_`:

- If the same capability is already on `Map`, route the call through
  `map_` instead.
- If not, either promote it to a typed `Map` (or `Viewer`) method, or
  route directly to `legacyMap_.method()` if the promotion is not
  trivial yet.

Once no `Viewer` caller remains, delete `interface.js` and the
`legacyMapInterface_` getter on `Viewer`.

The 69 methods break down into clear groups and can land as one PR
per group:

- `get*Info` queries (`getCreditInfo`, `getViewInfo`,
  `getBoundLayerInfo`, `getFreeLayerInfo`, `getSurfaceInfo`,
  `getSrsInfo`).
- Coordinate conversion (`convertCoords`,
  `convertCoordsFromNavToPublic`, `convertPositionHeightMode`,
  `convertPositionViewMode`).
- Registry add / remove (`addFreeLayer`, `removeFreeLayer`,
  `addBoundLayer`, `removeBoundLayer`, with their option pairs).
- Position / view (`setPosition`, `getPosition`, `setView`,
  `getView`, `getViews`).
- Reference frame / SRS (`getReferenceFrame`, `getSrses`).
- Loader and miscellaneous (`setLoaderSuspended`, `redraw`,
  `getConfigParam`).

### Why a separate item

The deletion is mechanical but not small. It targets `interface.js`
exclusively and does not interact with the frame-loop relocation
covered by [rfc-map-frame.md](rfc-map-frame.md). Keeping it as an
independent track avoids inflating the RFC's scope and lets the two
streams run in parallel.

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
| `MapInterface` | Pending — first methods to promote onto `Map` |
| `RendererInterface` | Pending — second set |
| `LegacyMap` (JS half of `Map`) | Pending — long-term absorption |
| `Renderer` | Pending — private implementation of `Map` |

### Next steps

- Promote `MapInterface` hit-testing and coordinate-conversion methods
  onto `Map`; update `Viewer` callers; shrink `_mapInterface` usage.
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

- `Core.map` and `Core.mapInterface` are `null` before async style or
  mapConfig load finishes, and after `destroyMap()` / `unloadMap()`.
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

- `src/core/map.ts`: document which `core_.mapInterface?.` calls mean
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
`style.layers`. A runtime call to `MapInterface.addFreeLayer()` only adds the
free layer object to `map.freeLayers`; it does not add a style layer entry, so
the renderer never sees it in `map.freeLayerSequence`.

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
| `src/core/map/interface.js` | Legacy `addFreeLayer` registers only the object |

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

See `render-targets.md` for the current auxiliary-buffer policy and
`rendering-sizes.md` for the size vocabulary used by render targets.

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

Keep `architecture.md` as a high-level entry point, then move narrow
topics into dedicated pages linked from that overview.

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
**Status:** early design — expand into RFC when implementation starts

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
| `src/core/map/interface.js:232` | `convertCoordsFromPhysToCameraSpace` |
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
