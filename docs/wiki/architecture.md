# Architecture

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


## Public API philosophy

### `Viewer` is the single entry point and the only place for new code

`Viewer` (exported as the type alias `Map`) is the one object that new
applications interact with. It follows the MapLibre GL JS convention: a
single class whose methods cover all public operations, with no sub-object
access required.

**No new functionality goes into `Browser`.** `Browser` is legacy
infrastructure on the path to dissolution. New capabilities belong on
`Viewer` as flat, typed methods. When a feature requires something from
`Browser`'s internals, promote it to `Viewer` directly rather than
adding it to `Browser` first.

```ts
import { map } from 'cartolina-js';

const viewer = map({ container: 'map', style: './style.json' });

viewer.on('map-loaded', () => {
    viewer.setAtmosphere({ visibility: 80000 });
    viewer.setVerticalExaggeration({ scaleRamp: { min: [50000, 1], max: [500000, 4] } });
});
```

### Why `Viewer` / `Map`?

The class is named `Viewer` internally because the name `Map` would collide
with the internal terrain engine (`Core.map`). The public type alias `Map` is
re-exported from the package index so that consumers see the familiar name in
their IDE.

### No sub-object access in the public API

The legacy API exposed `.map` (→ `MapInterface`) and `.renderer` (→
`RendererInterface`) as public properties of `BrowserInterface`. These are
gone from `Viewer`. All operations are flat methods.

### The `*Interface` pattern — why it existed, why it is being removed

The original vts-browser-js was written in ES5 JavaScript, which had no
classes, no `private` members, and no TypeScript. The only way to expose a
controlled public API was to build a thin wrapper object that forwarded only
the intended public methods, while the real implementation lived in a
separate internal object that was never handed to consumers:

```js
// ES5 pattern: internal object holds everything
var Map = function(core, data) { this.camera = ...; this.tree = ...; };
Map.prototype.internalHelper = function() { ... };

// Wrapper exposes only the intended public surface
var MapInterface = function(map) { this.map = map; };
MapInterface.prototype.setPosition = function(p) { this.map.setPosition(p); };
// internalHelper is not forwarded, so it is effectively private
```

With TypeScript and ES6 classes, this separation is unnecessary. Private
members are enforced by the compiler and invisible to consumers. The
public API is simply the set of `public` methods on the class itself.

`MapInterface` (`src/core/map/interface.ts`), `RendererInterface`
(`src/core/renderer/interface.js`), `BrowserInterface` (deleted), and
`CoreInterface` (`src/core/interface.js`) are all instances of this pattern.
They are being removed: `BrowserInterface` is already gone (replaced by
`Viewer`). `MapInterface` and `RendererInterface` are deleted incrementally
— each time a new application needs a capability, the corresponding method
is promoted as a flat, typed method on `Viewer`, bypassing the wrapper.

### Core build — `CoreInterface`

`CoreInterface` (`src/core/interface.js`) is the public API for the core
build (headless rendering, no UI). It is another ES5-era `*Interface`
wrapper around `Core`, and will eventually be replaced by a proper TypeScript
class. That conversion is deferred until there are active consumers of the
core build.


## Future naming and structural direction

The current internal names carry significant legacy baggage. The intended
long-term direction:

| Current name | What it really is | Future direction |
|---|---|---|
| `Browser` | UI engine (controls, navigation) | Dissolve into `Viewer`; its subsystems (`UI`, `Autopilot`, etc.) become private fields of `Viewer` directly |
| `CoreInterface` | ES5 wrapper around `Core` | Replace with a proper TypeScript class once core-build consumers exist |
| `Core` | Map engine coordinator (render loop, config routing, lifecycle) | Rename to reflect its actual role; merge with or delegate cleanly to `Map` and `Renderer` |
| `Map` (internal) | Terrain engine (tile tree, camera, geodata) | Rename to avoid collision with the public `Map` type alias |
| `MapInterface` | ES5 wrapper (to be deleted) | Deleted incrementally as methods are promoted to `Viewer` |
| `RendererInterface` | ES5 wrapper (to be deleted) | Deleted incrementally as methods are promoted to `Viewer` |

The priority order is: finish removing `MapInterface` / `RendererInterface`
first (lowest risk, clear value), then tackle `Browser` dissolution into
`Viewer`, then the `Core` / `Map` rename (highest blast radius).

None of these are done speculatively. Each rename happens as part of a
feature or refactoring that already touches the relevant code.


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
