# API and lifecycle

See `index.md` for the wiki table of contents.

This page records public API direction, construction, initialization,
configuration, events, and teardown rules. `architecture.md` keeps only
the high-level ownership map.

## Public API Surface

There is one public entry point: `Viewer`, exported as the type alias
`Map` from `src/browser/index.ts`. It follows the MapLibre GL JS
convention: one flat class, no required access through sub-objects.

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

`Map` in `src/core/map.ts` is internal. It is the typed boundary between
`Browser` and the engine objects. Methods move from `Map` to `Viewer`
as feature work touches them. The `Map.core` getter exposes internals
only while `Core` and `LegacyMap` are being absorbed.

## Legacy Wrapper State

The old vts-browser-js code used thick internal ES5 objects paired with
thin `*Interface` wrappers. ES5 had no classes, private fields, or
TypeScript, so the wrappers were the public boundary.

That pattern is partly gone:

| Name | Role | Status |
|---|---|---|
| `Viewer` | Public API | Stays |
| `Browser` | Legacy UI helpers | Moves into `Viewer` |
| `Map` | Typed map data model and logic | Stays; absorbs JS halves below |
| `CoreInterface` | Legacy public wrapper | Deleted |
| `MapInterface` | Thin legacy delegation wrapper | Moves into `Map` |
| `RendererInterface` | Legacy renderer wrapper | Deleted |
| `Core` | Legacy startup / animation-frame shell | Dissolves into `Map` |
| `LegacyMap` | JS half of `Map` (unfinished) | Moves into `Map` |
| `Renderer` | WebGL2 renderer; public draw helpers | Stays separate |

Do not add new public wrapper objects. When a capability needs public
access, add a deliberate flat `Viewer` method.

## Construction

Factory functions such as `map()` and `browser()` return usable objects
or throw. They do not return `null` for unsupported WebGL, failed engine
creation, or invalid construction state.

When construction fails, the constructor raises before inserting DOM
nodes. This keeps `Viewer`, `Browser`, and `Map` out of half-created
states.

Legacy optional chains and `null` returns that only tolerate missing
core objects are migration debt. Remove them when touching the owning
method. Keep `null` for real query results, such as a hit test with no
terrain under the cursor or an unloaded map property.

## Style And MapConfig

The style specification is the authored map contract for new code. It
is represented by `MapStyle.StyleSpecification` in
`src/core/map/style.ts`.

The inherited `mapConfig.json` path remains for compatibility. It has
limited functionality: it does not support the style terrain renderer,
illumination model, atmosphere, or vertical exaggeration as first-class
features. Do not add new features to the mapConfig path.

Deprecated entry points and concepts:

- `browser()` and the `map` config key for mapConfig loading
- tileserver-injected `browserOptions`
- views from vts-browser-js
- `setView`, `getView`, `getViews`, and related `MapInterface` methods
- `addBoundLayer` promotion to `Viewer`

Layer visibility in new code belongs in the style specification. Avoid
new branches that split behaviour by "style or mapConfig" unless the
branch is deleting or isolating the mapConfig path.

## Configuration Routing

`Core.setConfigParam(key, value)` is the inherited universal setter. It
routes by key prefix:

| Prefix | Destination |
|---|---|
| `map*` | `LegacyMap.setConfigParam` or deferred storage |
| `renderer*` | `Renderer.setConfigParam` |
| `debug*` | `Inspector.setParameter` |
| Structural | `map`, `style`, `position`, `view`, `authorization` |

`Viewer.setParam(key, value)` still passes through
`Browser.setConfigParam` and reaches `Core.setConfigParam`.
`rfc-config-store.md` describes the accepted replacement.

### Style Config Block

The `config` block in `StyleSpecification` passes key-value pairs
verbatim to `map.setConfigParam`. This is pragmatic but too permissive:
the style can currently set UI options such as compass visibility and
search bar visibility.

The target split is:

- rendering and shading parameters belong in the style
- application and UI parameters belong in factory config
- UI parameters should not be style-addressable

This has not been done because the config dictionary is still a flat
untyped bag.

### Obsolete Keys

The `mario` key in `map.setConfigParam` and `map.js` is obsolete and
safe to remove with any code it gates.

### URL Number Arrays

`url-config.ts` parses number-array parameters by splitting on commas.
Do not include brackets in URL values:

```text
?mapFeaturesReduceParams=0.05,0.085,11,1,1000
```

Brackets corrupt the first value because `parseFloat('[0.05')` returns
`NaN`. In style JSON, brackets are correct because the value is a JSON
array:

```json
"mapFeaturesReduceParams": [0.05, 0.085, 11, 1, 1000]
```

## Async Initialization

`Core.map` is `null` at construction time. It is set after the style or
mapConfig is fetched and parsed:

1. `Core` starts `loadMapFromStyle` or `loadMap`.
2. On success, `Core.map` is assigned and `Core.mapInterface` is
   created.
3. `Map.tick` emits `map-loaded` after the reference frame is ready and
   calls `Core.markReady_()` to resolve the one-shot `ready` Promise.

Viewer methods that reach into `_map` guard with optional chaining, so
they are no-ops before `ready` resolves.

## Render Loop

`Core.onUpdate` is a thin `requestAnimationFrame` callback. Each frame
it calls `Map.tick()` through `Core.outerMap`; `Map.tick()` then:

1. emits public `tick` and returns if no `LegacyMap` is loaded
2. emits `map-loaded` once per loaded `LegacyMap` after the reference
   frame is ready
3. runs the not-ready loader branch until `LegacyMap.srsReady` is true
4. runs the ready path: position events, canvas sync, stats, residual
   legacy loader / worker work, draw, overlays, deferred geodata events,
   then public `tick`

`Map.loadMap()` and `Map.unloadMap()` reset the per-loaded-map
`map-loaded` gate. The `ready` Promise remains one-shot for the typed
`Map` wrapper.

## Event Bus

The current event bus is a listener array on `Core`, not `EventTarget`
or `EventEmitter`. `Core.on` returns an unsubscribe function. `Core.once`
removes itself after firing. Both are surfaced on `Viewer` through
`Map`.

The accepted replacement is a typed `EventBus<EventMap>` owned by `Map`
and passed to engine objects that emit events. `EventTarget` was
rejected because it does not match the MapLibre-style `on()` / `once()`
API, allocates `CustomEvent` objects for frequent events, and still
needs an adapter. See `rfc-event-bus.md`.

`once` accepts an optional `wait` parameter that skips the first N
firings. `getSurfaceAreaGeometry` uses this to defer a callback past a
stale update cycle.

Known events:

- `map-mapconfig-loaded`
- `map-loaded`
- `map-unloaded`
- `map-update`
- `map-position-changed`
- `map-position-fixed-height-changed`
- `tick`
- `gpu-context-lost`
- `gpu-context-restored`
- `geo-feature-enter`
- `geo-feature-leave`
- `geo-feature-hover`
- `geo-feature-click`

## Teardown

`kill()` is the inherited lifecycle convention used by engine objects,
map resources, GPU resources, and tile resources.

Engine objects such as `Core`, `LegacyMap`, `Browser`, and `Viewer`
hold a `killed` flag. After `destroy()` or `kill()`, the animation
frame callback and pending async callbacks check that flag before
touching the object.

`LegacyMap.kill()` releases map-owned resources but does not destroy the
shared `Renderer`. `Core.destroyMap()` may unload one map and later load
another through the same `Renderer`; `Core.destroy()` owns final renderer
teardown.

The tile cache also evicts resources by calling `kill()`. Pending
network fetches or GPU uploads check `this.killed` before writing
results, so evicted resources are discarded.

Known gap: `Browser.kill()` does not unsubscribe its `tick` listener
from `Core.on`. The callback keeps firing and hitting the flag until
`Core` is garbage collected.

The following TypeScript classes implement `[Symbol.dispose]()` as the
canonical teardown hook:

| Class | `kill()` shim? | Reason |
|---|---|---|
| `Map` | no | no JS callers |
| `Viewer` | no | no JS callers |
| `Renderer` | yes | `map.js`, `core.js` |
| `GpuTexture` | yes | `subtexture.js` |
| `GpuMesh` | yes | `mesh.js` |
| `GpuDevice` | no | no JS callers |
| `Atmosphere` | no | no JS callers |

Classes that keep `kill()` retain it only because a legacy JS file
calls it directly. The shim delegates to `[Symbol.dispose]()` and
carries a comment naming the JS file. Remove it once that file is
migrated to TypeScript.

`Renderer` uses `disposed_` as its guard field. The legacy `killed`
name is retained on `Core`, `LegacyMap`, `Browser`, and their JS
resource callbacks.

New classes and major refactors should prefer modern forms:

- use `AbortSignal` for tile fetches, GPU uploads, and async chains
- implement `[Symbol.dispose]()` as the canonical teardown hook
- let `kill()` delegate to `[Symbol.dispose]()` when a legacy JS
  file calls it directly; name the file in the comment

## CSS Imports

The browser entry point imports CSS files for side effects:

- `src/browser/browser.css`
- `src/browser/presenter/css/*.css`

Webpack handles these imports through loaders. TypeScript and editor
tooling need an ambient declaration for `*.css`; it lives in
`src/types/globals.d.ts`.

The CSS is runtime state, not decorative styling. `.vts-browser` and
`.vts-map` provide the absolute full-size layout expected by the UI
wrapper. `.vts-fallback` is hidden until the browser explicitly enables
it. Without these styles, the map wrapper can get wrong dimensions and
the fallback overlay can appear even when WebGL2 is available.
