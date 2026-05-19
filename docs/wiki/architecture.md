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


## Build structure

The webpack config produces one library build:

| Entry point | Output | Purpose |
|---|---|---|
| `src/browser/index.ts` | `cartolina.js` / `.esm.js` | Production library |

The build exports `map()`, returning a `Viewer` instance (re-exported
as the type alias `Map`). `browser()` is a deprecated alias kept for
backward compatibility with the vts-browser-js browser API.

Worker bundles (`map-loader-worker.js`, `geodata-processor-worker.js`)
are produced separately and are not application entry points.

### Construction errors

Factory functions such as `map()` and `browser()` return usable objects
or throw. They do not return `null` for unsupported WebGL, failed engine
creation, or invalid construction state.

If construction fails (unsupported WebGL, invalid state), the constructor
raises an exception before inserting any DOM nodes. This keeps `Viewer`,
`Browser`, and `Map` out of half-initialized states.

Legacy optional chains and `null` returns that only exist to tolerate
missing core objects are migration debt. Remove them when touching the
owning method. Keep `null` only for real query results, such as a hit test
with no terrain under the cursor or a map property that is not loaded yet.

### Former core build

Until 2026-05, a separate `vts-core.js` was built from
`src/core/index.ts`. It exposed a headless `Map` class with no UI or
input handling. It was removed because the size difference (9%) did
not justify maintaining a separate entry point, and the same use case
is now covered by `interactive: false` on the browser build. See
`non-interactive.md` for the full rationale and migration notes.

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
        └── core: Map            ← map engine boundary (src/core/map.ts)
              └── core_: Core   ← map engine coordinator (src/core/core.js)
                    ├── map: LegacyMap ← terrain engine (src/core/map/map.js)
                    │     ├── camera
                    │     ├── tree     ← tile LOD tree
                    │     ├── loader
                    │     ├── measure
                    │     ├── convert
                    │     ├── atmosphere: Atmosphere
                    │     └── renderSlots
                    ├── mapInterface: MapInterface ← legacy terrain API wrapper
                    │     (src/core/map/interface.js; still alive)
                    └── renderer: Renderer  ← WebGL2 pipeline (src/core/renderer/renderer.ts)
                          └── gpu: GpuDevice
```

`Viewer` also holds `_core` as a direct shortcut reference to `_browser.core`
(`Map`) to avoid the extra indirection on every method call.

### What each layer owns

**`Viewer`** — the public entry point. Provides a flat, typed method surface
for all map operations. Owns `_browser` (the UI engine) and holds `_core` as
a shortcut reference to `_browser.core` (`Map`). Reaches the terrain engine
and renderer through the `_core.core` migration shim while the `Map` public
surface is being built out.

**`Browser`** — the **UI engine**. Creates and owns all user-facing interface
elements: DOM controls (`UI`), input handling (`ControlMode`), camera
animation (`Autopilot`), and tour playback (`Presenter`). Think of it as the
interactive shell around the map engine. It instantiates `Map` for the canvas
element managed by the UI. The name "browser" is a legacy term from the
original vts-browser-js; it does not refer to the web browser.
`Browser` has no public future: it is to be dissolved into `Viewer`.
Each piece of `Browser` behaviour migrates to `Viewer` as feature work
touches it, until `Browser` disappears entirely.

**`Map`** (public class, `src/core/map.ts`) — the boundary between the UI
engine and the map engine. Owns the event bus (`on` / `once`), the `ready`
Promise, and lifecycle (`[Symbol.dispose]()`). Replaces the legacy
`CoreInterface` ES5 wrapper. The `core` getter is a temporary migration
shim; it will be removed as internal engine objects are absorbed into `Map`.

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
`Core` is to be dissolved into `Map`.

**`LegacyMap`** (terrain engine, `src/core/map/map.js`) — the terrain data
and scene management layer. Owns the tile LOD tree, the loader, geodata
processors, camera state, coordinate conversion, measurement, and render
slots. The atmospheric model (`Atmosphere`) and surface-rendering logic
live here. `Core.map` is `null` until the style or mapConfig is loaded.
TypeScript modules import this class under the alias `LegacyMap` to avoid
clashing with the new `Map` public class. `LegacyMap` is to be dissolved
into `Map`.

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

### Design references

Cartolina should check modern web map and graphics libraries during API
design, feature work, and refactoring. These projects are references for
comparison and inspiration, not compatibility targets.

- MapLibre GL JS is the strongest reference. Use it for the public map
  API: flat construction options, event naming, style-oriented
  vocabulary, and familiar map methods where the concepts match. Also
  consult it for TypeScript organization, source handling, vector data,
  and performance choices in vector-data rasterization.
- Three.js is worth checking for modern web graphics practice,
  including shader source organization, shader chunks/includes,
  renderer-state handling, and WebGL/WebGPU-era conventions that are not
  map-specific.
- CesiumJS is worth checking for globe, terrain, reference-frame, and
  camera math when cartolina faces a matching geospatial problem.


## Public API transformation

### Why `Viewer` / `Browser` and `Map` / `Core` still exist as pairs

The original vts-browser-js codebase used a repeated ES5 pattern: a
thick internal object holding all state, paired with a thin `*Interface`
wrapper that exposed only the intended public surface. This was
necessary because ES5 had no classes, no `private` keyword, and no
TypeScript.

That pattern is partially retired. `CoreInterface` and
`RendererInterface` have been deleted; their public methods were
promoted directly onto the TypeScript `Map` class. `MapInterface`
(`src/core/map/interface.js`) still exists and is accessed via
`Core.mapInterface`. It will be absorbed into `Map` incrementally
as feature work touches its methods.

The two remaining pairs (`Viewer` / `Browser` and `Map` / `Core`) are
structural leftovers of the same origin, but they are not
`*Interface`-style wrappers. `Browser` is the UI engine — a substantial
object with its own lifecycle and sub-components — and `Core` is the
map-engine coordinator that bootstraps `LegacyMap` and `Renderer`. Both
are scheduled for dissolution into `Viewer` and `Map` respectively, but
they are being absorbed incrementally as feature work touches them.

### One public surface

There is one public entry point: `Viewer`, exported as the type alias
`Map` from `src/browser/index.ts`. It follows the MapLibre GL JS
convention — a single flat class, no required sub-object access.

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

`Map` (`src/core/map.ts`) remains as an **internal** boundary class
between `Browser` and the engine — it is not a public API. Its methods
are promoted to `Viewer` as feature work touches them. The `Map.core`
getter is a temporary migration shim that exposes engine internals while
that promotion work is in progress; it will be removed once `LegacyMap`
is fully absorbed.

### Current state and direction

| Name | Role | Status |
|---|---|---|
| `Viewer` | Public API | Done; **`Browser` dissolves into it** |
| `Browser` | Legacy UI engine | **To be dissolved into `Viewer`** |
| `Map` | Internal engine boundary | Not a public API; replaces `CoreInterface` |
| `CoreInterface` | Legacy public wrapper | **Deleted** |
| `MapInterface` | Legacy terrain wrapper | **Still alive**; dissolves into `Map` |
| `RendererInterface` | Legacy renderer wrapper | **Deleted** |
| `Core` | Map-engine coordinator | **To be dissolved into `Map`** |
| `LegacyMap` | Terrain engine (`map/map.js`) | **To be dissolved into `Map`** |
| `Renderer` | WebGL2 pipeline | **To be absorbed into `Map`** |

The priority order for remaining work is:

- route all existing `Viewer` delegations through `Map`; remove the
  `Map.core` escape hatch
- continue dissolving `Browser` into `Viewer`
- absorb legacy core objects into `Map` incrementally as feature work
  touches them

None of these happen speculatively. Each step is taken only when active
feature work already touches that layer.


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
the `Map` public class.

This is a legacy pattern. The accepted replacement is a typed
`EventBus<EventMap>` owned by `Map` and passed to engine objects that
emit events. `EventTarget` / `addEventListener` was evaluated and
rejected because it does not match the MapLibre-style `on()` / `once()`
API, allocates `CustomEvent` objects for high-frequency events, and
would require an adapter without removing the underlying coordination
work. See `rfc-event-bus.md`.

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

**Future direction** — new classes and major refactors should prefer the
modern equivalents:

- *Async cancellation* (tile fetches, GPU uploads): accept an
  `AbortSignal` parameter and pass it to `fetch()` and async chains
  instead of polling `this.killed`.
- *Engine teardown*: implement `[Symbol.dispose]()` (TypeScript 5.2+)
  as the canonical teardown hook; `kill()` / `destroy()` can delegate
  to it. Call sites can then use `using obj = new Foo(...)` for
  automatic scope-bound cleanup.


## Renderer internals

The `Renderer` class owns the WebGL2 context and the render loop. Size
information is owned by the active `GpuDevice` render target and read via
`gpu.currentRenderTarget.apparentSize`. `renderer.apparentSize` is a
convenience accessor for the same value.

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
sd = extent / (gpu.currentRenderTarget.apparentSize[1] / cssDpi * 0.0254)
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


## Regression test: expected network errors from upstream tile sources

Some tileserver resource drivers (`tms-normalmap`, `tms-raster`) fetch
tiles from remote GDAL sources — typically WMS or WMTS servers. When
the upstream server returns a 500, the tileserver must propagate the
failure; neither GDAL nor the CDN cache can absorb it on the first
request. cartolina-js handles this gracefully: for bump-map layers the
tile is rendered without that layer; for diffuse layers the renderer
falls back to a coarser tile.

Consequence for regression testing: a screenshot test run that follows
a long idle period may report network fetch errors for affected tile
URLs. These are upstream availability failures, not cartolina-js
regressions. The visual output is degraded but structurally correct:
terrain geometry and the primary colour layer are unaffected. On a
second run, CDN and GDAL caches are usually warm and the errors
disappear.

If a test run reports network fetch errors, repeat the test before
concluding it is a cartolina-js regression. Only treat fetch errors
as a regression if they persist across repeated runs.
