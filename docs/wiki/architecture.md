# Architecture

See `index.md` for the wiki table of contents.

## Stack overview

cartolina-js is the frontend half of a two-component stack.

- **cartolina-tileserver** — a C++ Unix daemon that processes geospatial data
  and streams formatted tiles over an nginx reverse proxy (default:
  `localhost:8070/mapproxy`). Authoritative resource documentation is in
  `docs/resources.md` in that repository.

- **cartolina-js** — a WebGL2 3D terrain cartography library. It fetches tiles
  from the tileserver, manages a tile tree, and drives the render loop.

Tile types consumed by cartolina-js:

| Type | Description |
|---|---|
| Terrain surfaces | TIN meshes with bundled normal maps |
| Raster overlays | Satellite / aerial imagery |
| Bump maps | Per-surface bump texture |
| Specular maps | Per-surface specular reflection texture |

Normal maps are bundled with terrain surfaces and discovered automatically
via tileserver-provided metadata; no client-side configuration is needed.


## Divergence from the VTS-geospatial architecture

cartolina-js is a fork of
[vts-browser-js](https://github.com/melowntech/vts-browser-js), the
browser client of VTS-geospatial — a system developed by Melown
Technologies / Leica Geosystems between roughly 2015 and 2023 and now
discontinued. VTS-geospatial was a large, general-purpose 3D geospatial
stack: 10+ components, 20+ supporting libraries, 70 software
repositories.

Understanding what was dropped clarifies what cartolina is and is not.


### What VTS-geospatial looked like

The VTS-geospatial backend consisted of three layers:

**Streaming servers**
- **mapproxy** — on-the-fly conversion of raster/vector GIS formats
  (GDAL, OGR, MVT) to VTS-geospatial tile streams. Also served
  `mapConfig.json` for simple setups.
- **vtsd** (VTS-Daemon) — a thin HTTP server that streamed static
  pre-built tilesets and translated *storage views* into
  `mapConfig.json`. Required for 3D models and complex configurations.

**Data management toolchain**
- **vts** CLI — managed a filesystem tileset storage: adding tilesets,
  generating *glues* (pre-baked seam tiles) between overlapping
  surfaces, removing surfaces.
- **Encoders** — converted external hierarchical mesh formats (VEF,
  I3S/SLPK, LODTree) into VTS-geospatial tilesets.
- **Mapproxy tools** — raster preprocessing (overview generation,
  measurement, tiling metainfo).

**Global registry**
- A separate system package (`vts-registry`) containing the canonical
  reference frame and SRS definitions. All VTS-geospatial components
  depended on it being installed at `/opt/vts/etc/registry`.

The frontend had two implementations: vts-browser-js (WebGL,
JavaScript) and vts-browser-cpp (C++, multiplatform, Unity plugin).

The key server-side composition mechanism was the **storage view**: a
human-editable JSON file that selected a subset of tilesets from the
storage and combined them with bound and free layers, credits, and
other options. vtsd translated a storage view into a `mapConfig.json`
served to the browser. The browser then had no configuration
responsibility of its own: it just fetched and rendered what the
server described.


### What cartolina dropped

| Dropped | Reason |
|---|---|
| vtsd + storage views | Replaced by client-side style spec |
| vts CLI + storage | No glue generation; each surface is independent |
| Encoders (vef2vts, etc.) | Out of scope; focus is DEM-based terrain |
| vts-browser-cpp | Out of scope; cartolina is browser-only |
| vts-registry system package | RF definitions embedded in mapConfig.json |
| nginx caching layer | Deployable outside the VTS-geospatial backend package |

The glue system deserves a note: in VTS-geospatial, two overlapping
surfaces in
storage required pre-computed glue tilesets to render seamlessly.
cartolina has no glue system — surfaces are independent and the tile
pipeline does not blend between them at overlap boundaries.


### What replaced server-side composition

The central architectural shift is that **map configuration moved from
the server to the client**. In VTS-geospatial the server assembled
`mapConfig.json` from a storage view; in cartolina the application
author writes a `style.json` that the browser reads directly.

The tileserver's role shrinks to: serve per-surface `mapConfig.json`
endpoints (one per resource, containing that surface's full reference
frame and tile URL templates) and stream tiles. It has no knowledge of
how the client combines surfaces.

The client's role expands: the style spec is the composition contract.
It lists sources (surfaces, TMS, free layers), defines terrain sources,
specifies the layer stack (diffuse, bump, specular), configures
illumination, atmosphere, and vertical exaggeration. Everything the
VTS-geospatial storage view did on the server now happens in the style
file on the
client side.

This also means the reference frame is not negotiated between server
and client: the tileserver embeds the full RF definition in every
`mapConfig.json`, and the client extracts it from the first surface it
loads. See `reference-frames.md` for details.


## Two-build structure

The webpack config produces two distinct library builds from two entry points:

| Build | Entry point | Output | Purpose |
|---|---|---|---|
| **Full build** | `src/browser/index.ts` | `cartolina.js` / `.esm.js` | Production library; includes UI controls, navigation, autopilot, presenter |
| **Core build** | `src/core/index.js` | `vts-core.js` | Headless rendering only; consumer wires their own UI and navigation |

The full build exports the `map()` and `browser()` factory functions, both
returning a `Viewer` instance. The core build exports a `core()` factory
returning a `CoreInterface` instance.

Worker bundles (`map-loader-worker.js`, `geodata-processor-worker.js`) are
produced separately and are not application entry points.

### Browser CSS is a runtime dependency, not decoration

The browser build depends on `src/browser/browser.css` and presenter CSS
for correct runtime behavior, not just appearance.

- `.vts-browser` and `.vts-map` define the absolute-positioned
  full-size layout that the browser/UI wrapper expects.
- `.vts-fallback` is hidden by CSS (`display: none`) until the browser
  explicitly enables it.

If these stylesheets drop out of the webpack entry graph, the result can
look like an application failure rather than an unstyled page:

- the internal browser wrapper can get wrong dimensions,
- map bootstrap can stall or behave erratically,
- the fallback overlay text ("needs WebGL capable browser") can appear
  even when WebGL support is fine, because the control exists in the DOM
  and CSS was what hid it by default.

## Object model

The full object chain from the public API inward:

```
Viewer                           ← public API (src/browser/viewer.ts)
  └── _browser: Browser          ← UI engine (src/browser/browser.js)
        ├── ui: UI               ← DOM controls
        ├── autopilot: Autopilot ← camera animation
        ├── presenter: Presenter ← tour / flythrough
        ├── controlMode          ← input handling
        └── core: CoreInterface  ← map engine boundary (src/core/interface.js)
              └── core: Core     ← map engine coordinator (src/core/core.js)
                    ├── map: Map       ← terrain engine (src/core/map/map.js)
                    │     ├── camera
                    │     ├── tree     ← tile LOD tree
                    │     ├── loader
                    │     ├── measure
                    │     ├── convert
                    │     ├── atmosphere: Atmosphere
                    │     └── renderSlots
                    └── renderer: Renderer  ← WebGL2 pipeline (src/core/renderer/renderer.ts)
                          └── gpu: GpuDevice
```

`Viewer` also holds `_core` as a direct shortcut reference to `_browser.core`
(`CoreInterface`) to avoid the extra indirection on every method call.

### What each layer owns

**`Viewer`** — the public entry point. Provides a flat, typed method surface
for all map operations. Owns `_browser` (the UI engine) and holds `_core` as
a shortcut reference to `_browser.core` (`CoreInterface`). Reaches directly
into `Core.map` / `Core.renderer` for rendering operations, bypassing the
`MapInterface` / `RendererInterface` wrappers.

**`Browser`** — the **UI engine**. Creates and owns all user-facing interface
elements: DOM controls (`UI`), input handling (`ControlMode`), camera
animation (`Autopilot`), and tour playback (`Presenter`). Think of it as the
interactive shell around the map engine. It instantiates `CoreInterface` for
the canvas element managed by the UI. The name "browser" is a legacy term
from the original vts-browser-js; it does not refer to the web browser.

**`CoreInterface`** — the boundary between the UI engine and the map engine.
Owns the event bus (`on` / `once` / `callListener`), the `ready` Promise,
and configuration routing to `Core`.

**`Core`** — the **map engine coordinator**. This is a thick object; it owns:
- The master config object (70+ keyed parameters).
- The `requestAnimationFrame` render loop (`onUpdate`).
- Lifecycle of `Map` and `Renderer`: creates them, destroys them,
  coordinates map loading.
- Auth / token / cookie injection for protected tileservers.
- Config routing: `map*` keys → `Map.setConfigParam`; `renderer*` keys →
  `Renderer.setConfigParam`; `debug*` keys → `Inspector`.

The name `Core` is a legacy holdover; conceptually it is the map engine
coordinator — the bootstrap and message-routing layer that sits above `Map`
and `Renderer`. It has no public-facing name in the current API.

**`Map`** (terrain engine) — the terrain data and scene management layer.
Owns the tile LOD tree, the loader, geodata processors, camera state,
coordinate conversion, measurement, and render slots. The atmospheric model
(`Atmosphere`) and surface-rendering logic live here. `Core.map` is `null`
until the style or mapConfig is loaded. The name `Map` is a legacy holdover
that unfortunately clashes with the public `Map` type alias — an artefact of
the pre-TypeScript era that will be resolved when the internal object is
eventually renamed.

**`Renderer`** — owns the WebGL2 context (`GpuDevice`), the render pipeline,
shading, illumination, vertical exaggeration, and all GPU resource management.

### Modern tile rendering vs the legacy draw subsystem

The current tile-rendering direction is centered on
`src/core/map/tile-render-rig.ts`.

`TileRenderRig` is the newer per-tile render-preparation object. It resolves
resources, tracks readiness, builds the layer stack, and renders a tile in a
 single unified pass. Its purpose is to replace older rendering logic that was
 historically split across `MapDrawTiles.drawMeshTile`,
 `MapDrawTiles.updateTileBounds`, and `MapMesh.drawSubmesh`.

The older pipeline is not just `surface-sequence.ts`. It is a broader legacy
draw subsystem spread across modules such as:

- `src/core/map/draw.js`
- `src/core/map/draw-tiles.js`
- `src/core/map/surface-sequence.ts`
- related map-config-era helpers that prepare surface, glue, and bound-layer
  ordering for the original multi-step draw path

These modules still carry important runtime behavior, especially for
map-config-based maps and older render paths, but they are not the target
design. They represent historical orchestration that predates the
style-driven layer stack and the newer per-tile rig model.

The architectural direction is to continue consolidating tile rendering around
style-driven layer stacks and `TileRenderRig`, while gradually shrinking this
legacy draw subsystem as old map-config-only paths and multi-stage draw logic
are retired.

First major milestone:

- Style specs are the only authored composition model.
- `TileRenderRig` is the only terrain tile render path.
- New GLSL 300 shaders own terrain, depth, atmosphere, layer stack, and VE.
- Legacy `mapConfig`/view support becomes an adapter, then disappears.
- `Viewer` remains the flat public API. Legacy sub-objects stay private.


## Public API transformation

### The recurring migration pattern

The legacy codebase uses a repeated ES5 pattern:

- a functional crux object that owns the real state and behavior
- a thin `*Interface` wrapper that exposes the intended public methods

That pattern existed because ES5 had no classes, no `private` members,
and no TypeScript. In a TypeScript class, the public API and the private
implementation live on the same object, so the extra wrapper becomes
unnecessary.

```js
// ES5 pattern: internal object holds everything
var Map = function(core, data) { this.camera = ...; this.tree = ...; };
Map.prototype.internalHelper = function() { ... };

// Wrapper exposes only the intended public surface
var MapInterface = function(map) { this.map = map; };
MapInterface.prototype.setPosition = function(p) { this.map.setPosition(p); };
// internalHelper is not forwarded, so it is effectively private
```

The long-term refactoring pattern in cartolina-js is therefore:

1. Identify the legacy pair: `*Interface` wrapper plus internal engine.
2. Introduce a clean TypeScript class as the new public API.
3. Promote public methods onto that class as flat typed methods.
4. Gradually absorb the internal engine into private fields and methods
   of the new class, then delete the old wrapper.

### Two future public surfaces

The end state is two public TypeScript classes, one per build:

**`Map`** — the core build public API. Absorbs everything in the current
core layer: `CoreInterface`, `Core`, the internal terrain engine (currently
also called `Map`), `Renderer`, `MapInterface`, and `RendererInterface`.
All of those are implementation detail behind a single flat typed class.

**`Viewer`** — the full build public API. Absorbs `BrowserInterface` and
`Browser` (UI engine, controls, navigation, autopilot, presenter).
Rendering and map methods from `Map` are promoted flat onto `Viewer` as
well, following the MapLibre GL JS convention of a single entry point with
no required sub-object access. Each promoted method must delegate through
the `Map` public surface, not bypass it into internals.

```ts
import { map } from 'cartolina-js';

const viewer = map({ container: 'map', style: './style.json' });

viewer.on('map-loaded', () => {
    viewer.setAtmosphere({ visibility: 80000 });
    viewer.setVerticalExaggeration({
        scaleRamp: { min: [50000, 1], max: [500000, 4] }
    });
});
```

### Current state and direction

`Viewer` is done on the browser side. `Browser` is being absorbed into it.

The core-side `Map` class does not exist yet. The right approach is to
build it before promotion continues, not after. Without it, every method
promoted onto `Viewer` reaches directly into the legacy internals (`_map`,
`_mapInterface`, `_renderer`), each accessed via `this._core?.core?.*`.
That is the wrong layering and will not clean up on its own — it will grow
as promotion continues.

The `Map` class should be built as a thin TypeScript wrapper around core,
replacing current `CoreInterface`. It keeps the terrain engine, renderer, 
and legacy wrappers as private implementation detail and exposes a flat 
typed public surface. Every subsequent method promotion goes through `Map`, 
never into the legacy layer directly. `Viewer` holds a `Map` instance and 
delegates rendering methods to it.

| Current name | Current role | Direction |
|---|---|---|
| `Viewer` | Full-build public API | Absorb `Browser`; delegate rendering to `Map` |
| `Browser` | Legacy UI engine | Become private implementation inside `Viewer`, then disappear |
| `Map` (new) | Core-build public API | Wrap `CoreInterface`; absorb all legacy core objects behind it |
| `CoreInterface` | Legacy public wrapper for core build | Absorbed into `Map` |
| `Core` | Legacy map-engine coordinator | Absorbed into `Map` |
| `MapInterface` | Legacy wrapper around terrain engine | Absorbed into `Map` |
| `RendererInterface` | Legacy wrapper around `Renderer` | Absorbed into `Map` |
| `Map` (internal) | Terrain engine | Absorbed into `Map`; rename resolves naming collision |
| `Renderer` | WebGL2 pipeline | Absorbed as private implementation of `Map` |

The priority order is:

- build the `Map` TypeScript class wrapping `CoreInterface`
- route all existing `Viewer` delegations through it; remove direct
  internal access from `Viewer`
- continue dissolving `Browser` into `Viewer`
- absorb legacy core objects into `Map` incrementally as feature work
  touches them

None of these happen speculatively. Each step is taken only when active
feature work already touches that layer.

### Naming

Both builds expose a `Map` object. The full build re-exports `Viewer` under
that name (`export type { default as Map } from './viewer'`); the core build
will export its own `Map` class. The two `Map` objects have overlapping
capabilities — the full-build one has promoted rendering methods on top of
its UI layer — and that overlap is intentional. Consumers of either build
get a familiar `Map` entry point; the distinction between builds is a
deployment concern, not an API-shape concern.

The internal terrain engine object (also informally `Map` in `map.js`) is
a codebase-only conflict that disappears when it is absorbed into the new
class.


## Style-based API is canonical; mapConfig and views are deprecated

### mapConfig

The original vts-browser-js used a server-provided `mapConfig.json` as its
primary map definition contract. cartolina-js inherits this loading path for
backward compatibility but it is a dead end:

- **mapConfig-based maps already have limited functionality.** They do not
  support the style-based rendering pipeline, the illumination model,
  atmosphere, or vertical exaggeration as first-class citizens.
- **No new features will be added to the mapConfig path.** Bug fixes for
  mapConfig-based maps may be declined if they would add complexity to code
  that is scheduled for removal.
- **The `browser()` factory and the `map` config key are the entry points
  for mapConfig-based maps.** Both are considered deprecated. New
  applications must use the `map()` factory with a `style` specification.
- **The `browserOptions` mechanism** — where the tileserver injects runtime
  options into the client via the mapConfig response — is also deprecated and
  will be removed with mapConfig support.

### Views

The "view" concept from vts-browser-js is a named configuration of visible
bound layers and free layers, stored in the mapConfig. It has no equivalent
in the style-based API and no future in cartolina-js:

- `setView` / `getView` / `getViews` and related `MapInterface` methods are
  deprecated and will not be promoted to `Viewer`.
- The style-based equivalent of layer visibility is expressed directly in the
  style specification.

### What this means in practice

- All new style-driven features are expressed in `MapStyle.StyleSpecification`
  (`src/core/map/style.ts`).
- Do not add code that branches on whether a mapConfig or style was used.
- Do not promote `setView`, `getView`, `addBoundLayer`, or any other
  view-related `MapInterface` method to `Viewer`.
- Code in `Browser.onMapLoaded` and `Browser.onGeoJsonLoaded` that handles
  `browserOptions` and view manipulation is scheduled for removal alongside
  the mapConfig path.


## Config routing

`Core.setConfigParam(key, value)` is the universal config setter. It routes
by key prefix:

| Prefix | Destination |
|---|---|
| `map*` | `Map.setConfigParam` (or `Core.configStorage` if map not yet loaded) |
| `renderer*` | `Core.setRendererConfigParam` → `Renderer` |
| `debug*` | `Inspector.setParameter` |
| Structural | Handled inline (`map`, `style`, `position`, `view`, `authorization`) |

`Viewer.setParam(key, value)` routes through `Browser.setConfigParam` which
ultimately calls `Core.setConfigParam`.

### URL encoding for number-array params

`url-config.ts` parses number-array params (e.g. `mapFeaturesReduceParams`,
`mapLabelFreeMargins`, `sensitivity`) by splitting on commas. Do **not**
include brackets in the URL value — they break `parseFloat` on the first
element and silently corrupt the array.

```
# correct
?mapFeaturesReduceParams=0.05,0.085,11,1,1000

# wrong — brackets corrupt params[0]
?mapFeaturesReduceParams=[0.05,0.085,11,1,1000]
```

In style JSON, brackets are correct (it is a JSON array):
`"mapFeaturesReduceParams": [0.05, 0.085, 11, 1, 1000]`


## Async initialization

`Core.map` is `null` at construction time. It is set asynchronously after the
style (or mapConfig) is fetched and parsed:

1. `Core` constructor starts `loadMapFromStyle` or `loadMap`.
2. On success, `Core.map` is assigned and `Core.mapInterface` is created.
3. `Core` emits `'map-loaded'` and resolves the `ready` Promise.

Viewer methods that reach into `_map` all guard with optional chaining
(`this._map?.xxx`) so they are safely no-ops before `ready` resolves.


## Render loop

`Core.onUpdate` is the `requestAnimationFrame` callback. Each frame it:

1. Checks `Core.map.srsReady` and emits `'map-loaded'` / resolves `ready`
   on the first frame after the reference frame is ready.
2. Calls `Core.map.update()` — drives tile loading, LOD selection,
   geodata processing, and calls `Renderer` to draw the frame.
3. Emits the `'tick'` event (used by `Browser` for navigation integration).


## Event bus

A plain listener array on `Core` (`src/core/core.js`), not `EventTarget`
or `EventEmitter`. `Core.on` returns an unsubscribe function; `Core.once`
auto-removes after first invocation. Both are surfaced on `Viewer` via
`CoreInterface`.

`once` accepts an optional `wait` parameter that skips the first *N*
firings — used internally to defer a callback past a stale update cycle
(e.g. `getSurfaceAreaGeometry`). No equivalent in standard libraries.

Available events: `map-mapconfig-loaded`, `map-loaded`, `map-unloaded`,
`map-update`, `map-position-changed`,
`map-position-fixed-height-changed`, `tick`,
`gpu-context-lost` / `gpu-context-restored`,
`geo-feature-enter` / `geo-feature-leave` / `geo-feature-hover` /
`geo-feature-click`.


## The `kill()` pattern

`kill()` is a pervasive lifecycle convention used across ~26 classes,
from engine objects (`Core`, `Map`, `Renderer`, `Browser`) down to
individual GPU and tile resources (`MapMesh`, `GpuFont`, `MapSurfaceTile`,
etc.).

The pattern substitutes for destructors and cancellable promises, which
were unavailable or impractical when the codebase was written. Two
related uses:

**Engine teardown** — `Core`, `Map`, `Renderer`, `Browser`, `Viewer`
each hold a `killed` flag. After `destroy()` / `kill()` is called, the
rAF loop and any in-flight async callbacks check the flag before
touching the object.

**Resource eviction** — the tile cache evicts resources by calling
`kill()`. Any pending async operation (network fetch, GPU upload) checks
`this.killed` before writing results back to the object, so evicted
resources are silently discarded.

Known gap: `Browser.kill()` does not unsubscribe its `tick` listener
from `Core.on`, so the callback keeps firing and hitting the flag until
`Core` is GC'd.


## Renderer internals

The `Renderer` class owns the WebGL2 context and the render loop. It
maintains a `curSize` field (CSS layout size) that is temporarily
overwritten during hitmap/depth-map passes to the framebuffer dimensions.
Code that needs the stable viewport size must use `mainViewportCssH`
(updated only in `applySizes`) rather than reading `curSize` directly.

Illumination supports two light frames:

- `tracking` — azimuth/elevation authored in observer-relative lNED.
- `geographic` — azimuth/elevation authored in the scene-center NED
  frame and converted each frame through the existing `NED -> lNED ->
  VC` position/orientation machinery.

The geographic implementation deliberately does not build its own
physical tangent-frame basis. In this codebase, current north is already
established by the map-position/NED logic, so illumination reuses that
machinery rather than layering a separate pole or basis convention on top.


## Tooling details

### TypeScript needs an explicit CSS module declaration

The browser entrypoint imports CSS files for their side effects:

- `src/browser/browser.css`
- `src/browser/presenter/css/*.css`

Webpack understands these imports through its loader pipeline, but
TypeScript and editor tooling need an ambient `declare module '*.css'`
declaration to accept them. In this repository that declaration lives in
`src/types/globals.d.ts`.

If the CSS declaration is missing, `npx tsc --noEmit` may still pass in
some setups while VS Code or the webpack TypeScript path reports TS2307
"Cannot find module ... .css" errors on the browser entrypoint.


## Vertical exaggeration

VE is the product of two independent factors:

1. **Elevation ramp** (`seHeightRamp`) — piecewise linear by terrain
   height. Defined by two pivot pairs `[height, factor]`.

2. **Scale ramp** (`veScaleRamp`) — power-law by CSS scale denominator.
   Defined by two pivot pairs `[sd, va]`; interpolated log-log linearly
   between them and clamped outside the range.

Scale denominator formula:
```
sd = extent / (mainViewportCssH / cssDpi * 0.0254)
```

Scale ramp formula:
```
va(sd) = va0 * (sd / sd0) ^ (log(va1/va0) / log(sd1/sd0))
```

The legacy `viewExtentProgression` format is converted to `veScaleRamp`
at load time using a canonical canvas height of 1113 CSS px (matching
the historical tuning baseline). The legacy public API is kept and
marked `@deprecated`; new code uses `setVerticalExaggeration()`.


## Terrain shading

Diffuse terrain shading in `tile.frag.glsl` combines up to three
coefficients: Lambertian, slope, and aspect. The mixed case is
expressed as a weighted geometric mean of their complements, then
remapped back to the final shading coefficient with `1.0 - ...`.

Aspect shading is computed from the cosine between the projected surface
normal and projected light direction in the local tangent plane. On
nearly flat terrain this quantity becomes ill-defined because the normal
projection approaches zero, so the shader treats those cases with a
neutral aspect value to avoid visible artifacts.

## Colour encoding convention

All colour values in the style spec and public APIs (`label-color`,
`line-color`, `diffuseColor`, `specularColor`, atmosphere colours, etc.)
use integer 0–255 per channel. The renderer converts them to 0.0–1.0
internally at the point they enter the pipeline (e.g. `/ 255.` in
`tile-render-rig.ts`, `setIllumination()` in `renderer.ts`, and
`atmosphere.ts`). Do not pass 0–1 floats to these APIs; the conversion
is not symmetric and values will silently clamp or wash out.

The long-term direction is hex string colours (`#rrggbb`) matching
MapLibre convention. That is a style-wide change not yet undertaken.


## Obsolete config keys

The `mario` key in `map.setConfigParam` / `map.js` is entirely obsolete
and safe to remove along with any code it gates.

## Style config block — known awkwardness

The `config` block in `StyleSpecification` passes key-value pairs
verbatim to `map.setConfigParam`. This is pragmatic but too permissive:
the style can currently set UI-level options (compass visibility, search
bar, etc.) that have nothing to do with visual styling. The right fix is
a cleaner split in the config namespace — rendering and shading
parameters belong in the style, application/UI parameters belong
exclusively in the factory config and are not style-addressable. This
has not been done yet because the config dict is a flat untyped bag with
no such distinction.
