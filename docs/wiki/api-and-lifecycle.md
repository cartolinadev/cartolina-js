# API and lifecycle

See [index.md](index.md) for the wiki table of contents.

This page records public API direction, construction, initialization,
configuration, events, and teardown rules.
[architecture.md](architecture.md) keeps only the high-level
ownership map.

## Public API Surface

There is one public entry point: `Viewer`, exported as the type alias
`Map` from `src/viewer/index.ts`. It follows the MapLibre GL JS
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

`Map` in `src/map/map.ts` is internal. It is the typed map-model
boundary below `Viewer`. Methods move from `Map` to `Viewer` as feature
work touches them. `Map` exposes internal fields such as
`map`, `renderer`, and `configStore` only while `LegacyMap` is being
absorbed; legacy modules reach the `Map` instance through their `core`
back-references.

## Legacy Wrapper State

The old vts-browser-js code used thick internal ES5 objects paired with
thin `*Interface` wrappers. ES5 had no classes, private fields, or
TypeScript, so the wrappers were the public boundary.

That pattern is partly gone:

| Name | Role | Status |
|---|---|---|
| `Viewer` | Public API | Stays |
| `Map` | Typed map data model and logic | Stays; absorbs JS halves below |
| `CoreInterface` | Legacy public wrapper | Deleted |
| `MapInterface` | Thin legacy delegation wrapper | Deleted |
| `RendererInterface` | Legacy renderer wrapper | Deleted |
| `Core` | Legacy startup / animation-frame shell | Absorbed into `Map` |
| `LegacyMap` | JS half of `Map` (unfinished) | Moves into `Map` |
| `Renderer` | WebGL2 renderer; public draw helpers | Stays separate |

Do not add new public wrapper objects. When a capability needs public
access, add a deliberate flat `Viewer` method.

## Construction

The `map()` factory returns a usable object or throws. It does not
return `null` for unsupported WebGL, failed engine creation, or
invalid construction state.

When construction fails after the UI wrapper is inserted, `Viewer`
disposes any constructed `Map` and removes the wrapper before rethrowing.
Unsupported WebGL and invalid top-level options fail before DOM insertion.

Legacy optional chains and `null` returns that only tolerate missing
core objects are migration debt. Remove them when touching the owning
method. Keep `null` for real query results, such as a hit test with no
terrain under the cursor or an unloaded map property.

## Style And MapConfig

The style specification is the only authored map contract. It is
represented by `MapStyle.StyleSpecification` in
`src/map/style.ts`. Every successfully constructed map has a
validated style; core map and renderer code cannot observe whether
the style was authored directly or converted.

Legacy `mapConfig.json` documents are an import format
(rfc11-mapconfig-to-style.md). The exported `mapConfigToStyle()`
converter (`src/compat/mapconfig-to-style.ts`) turns a mapConfig
into a style plus construction values — initial position, typed
viewer options, and named views as visibility profiles — which the
application passes to `map()`. The converter is called explicitly
by applications and migration tools; the runtime never calls it.

Runtime layer visibility is the terrain-applicability API on
`Viewer`: `setLayerTerrainSources` / `getLayerTerrainSources`,
`setTerrainSources` / `getTerrainSources`, and the atomic
`applyVisibilityProfile` / `getVisibilityProfile` pair. All six
methods throw before the `ready` promise resolves. A proposed mutation
that would activate a failed raster source also throws synchronously.
The authored overrides, effective style, render sequences, and rendered
map remain unchanged after either validation failure.

## Configuration

Runtime configuration lives in one `ConfigStore<ViewerConfig>`
(`src/config-store.ts`), implemented by
[rfc1-config-store.md](rfc1-config-store.md). The single-source
`catalogue` object (`src/viewer-config.ts`) declares every
valid key exactly once — doc comment, producer default,
normalizer, URL parse kind, and visibility class — and the
`ViewerConfig` type, `defaultViewerConfig()`,
`normalizeConfigPatch()`, the public subsets, and the URL parsing
all derive from it. Invalid input falls back to the key's
catalogue default, produced fresh for array values.

The store's live value map is the single config object: `Viewer.config`,
`Map.config`, `LegacyMap.config`, and `Renderer.config` all alias it, so
reads anywhere see the same normalized values immediately.

`Viewer.setParam(key, value)` and `Viewer.getParam(key)` are typed
over `Viewer.PublicRuntimeConfig` (`src/viewer-config.ts`), the
deliberate public subset of `ViewerConfig`: live, application-facing
keys only. Every key in the subset is verified live — covered by a
watcher with the required side effect, or read from the store's
value map at time of use. Key and value types correlate, so a typed
caller gets key completion, value checking, and key-specific return
types; a key outside the subset throws at runtime, so a JavaScript
typo fails loudly. `setParam` normalizes the value
(`normalizeConfigPatch`) and writes the patch to the store;
`getParam` reads `store.get()`. The contract is pinned by
compile-time tests in `test/types/viewer-api.ts`, run by
`npm run typecheck`.

The complete factory input is `Map.Config`. Its nested `options` bag is typed by
`PublicConstructionConfig`: the public store-backed runtime keys plus
the deliberately public store-backed construction and load-time keys.
It has no index signature, so a misspelled or internal-only option fails
compilation. `Viewer` accepts the same complete `Map.Config` object as
`map()`: the factory only delegates.

Dedicated construction inputs are top-level `Map.Config` fields.
`Viewer` passes `style` and initial `position` directly to `Map`, and
passes `interactive` directly to `ControlMode`. They are not flattened
into the config store. `transformRequest` is also top-level and becomes
an immutable field on `Map`, which owns resource loading. Map and renderer
loaders read the hook from that owner.

Construction rejects an unknown top-level option, an unknown nested
config key, or a dedicated top-level input placed inside `options`.
Catalogued internal and debug keys outside the typed surface pass so the
query-string vocabulary can flow through the factory.
`runtimeOptionsFromUrl` keeps catalogued config keys only and excludes
dedicated factory inputs, dropping arbitrary query parameters before
they reach the constructor guard.

The catalogue contains the native style-map defaults. mapConfig
conversion emits the retired mapConfig factory's six-value control
and interaction profile explicitly in `viewerOptions`. Converted
`browserOptions` override that profile, and application options
override the complete conversion result. Compatibility is therefore
ordinary construction input, not a second implicit default source.

The remaining permissive ingestion paths accept the full catalogue and
the legacy `rotate` / `pan` aliases. Unknown keys are dropped, and a
dropped key carrying a config prefix (`map`, `renderer`, `control`,
`debug`) is logged. The style `config` block also accepts the full
catalogue and aliases, but drops unknown keys without logging. The vts-era
`Browser.setConfigParam` / `getConfigParam` accessors are removed;
no repository or documented integration called them.

Subsystems declare `store.watch(keys, fn)` for the side effects a
change requires (cache resizing, redraws, UI refresh, autopilot,
inspector debug parameters). `Map.tick` flushes the store at the
start of every frame, so watchers fire once per batch of changes
and never mid-frame.

Not every accepted key has a live effect. Keys consumed only at
construction time (the WebGL context flags `rendererAntialiasing`
and `rendererAllowScreenshots`, the per-texture
`rendererAnisotropic`) accept writes through the ingestion paths
but change nothing until the consuming object is next created. The
construction-only keys are annotated in `ViewerConfig`
(`src/viewer-config.ts`) and excluded from
`PublicRuntimeConfig`.

`transformRequest(url, resourceType)` follows the MapLibre-style host
application hook. It may return a rewritten URL, headers, and
credentials mode for outgoing resource requests. See
[request-transform.md](request-transform.md) for API shape, resource
types, coverage, and authentication guidance.

### Style Config Block

The `config` block in `StyleSpecification` writes key-value pairs
through the config store at style load. This is pragmatic but too
permissive:
the style can currently set UI options such as compass visibility and
search bar visibility.

The target split is:

- rendering and shading parameters belong in the style
- application and UI parameters belong in factory config
- UI parameters should not be style-addressable

This has not been done because the config dictionary is still a flat
untyped bag.

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

`Map.map` (the loaded `LegacyMap`) is `null` at construction time. It
is set after the style and its required source metadata are fetched and
parsed:

1. The `Map` constructor starts the style load.
2. Raster metadata requests start concurrently and overlap terrain
   metadata loading. Successful sources and permanent failures enter the
   map-owned raster registry.
3. The effective initial style rejects any failed raster source that it
   activates. Failures used only by inactive layers remain recorded.
4. On success, `Map.map` is assigned.
5. `Map.tick` emits `map-loaded` after the reference frame is ready
   and resolves the one-shot `ready` Promise.

An asynchronous construction error rejects `ready`, disposes the partial
legacy map, and leaves `Map.map` null. It does not emit `map-loaded`.
Viewer methods that reach into the legacy map guard with optional
chaining, so they are no-ops before `ready` resolves or after failed
construction.

## Render Loop

`Map` owns the `requestAnimationFrame` loop. Each frame it flushes
the config store and runs `Map.tick()`, which:

1. emits public `tick` and returns if no `LegacyMap` is loaded
2. emits `map-loaded` once per loaded `LegacyMap` after the reference
   frame is ready
3. runs the not-ready loader branch until `LegacyMap.srsReady` is true
4. runs the ready path: position events, canvas sync, stats, residual
   legacy loader / worker work, draw, overlays, deferred geodata events,
   then public `tick`

The `ready` Promise resolves once for the typed `Map` wrapper.

## Event Bus

The event bus is a typed `EventBus<Map.ViewerEventMap>`
(`src/map/event-bus.ts`) owned by `Map`. `Map.on` and `Map.once`
both return an unsubscribe function; both are surfaced on `Viewer`.
`Map.emit` is internal — applications only subscribe.

`Map` emits its own lifecycle events (`tick`, `map-loaded`,
`map-unloaded`, `map-update`, the position-change pair). The legacy
emitters receive the bus instance at construction and publish through
it directly: `LegacyMap`
(geo-feature events) and `GpuDevice` (context-loss events).
Viewer-layer code emits through `Map.emit`.

Dispatch is per event name: `emit` visits only listeners registered
for the emitted name and returns without allocation when none are
registered. `emit` iterates a snapshot of the listener set; listeners
added during an emit do not receive it, listeners removed during an
emit still do. A throwing listener aborts the remaining listeners in
the same emit call. `EventTarget` was rejected because it does not
match the MapLibre-style `on()` / `once()` API, allocates
`CustomEvent` objects for frequent events, and still needs an
adapter. See [rfc2-event-bus.md](rfc2-event-bus.md).

Event names and payload types are defined by `Map.ViewerEventMap` in
`src/map/map.ts`:

- `map-loaded`
- `map-unloaded`
- `map-update`
- `map-position-changed`
- `map-position-fixed-height-changed`
- `map-position-panned`
- `map-position-rotated`
- `map-position-zoomed`
- `tick`
- `gpu-context-lost`
- `gpu-context-restored`
- `geo-feature-enter`
- `geo-feature-leave`
- `geo-feature-hover`
- `geo-feature-click`
- `autorotate-changed`
- `fly-start`
- `fly-final-phase`
- `fly-progress`
- `fly-end`
- `loading-screen-hidden`

## Teardown

`kill()` is the inherited lifecycle convention used by engine objects,
map resources, GPU resources, and tile resources.

Engine objects such as `Map` and `LegacyMap` hold a `killed` flag.
After disposal or `kill()`, the animation frame callback and pending
async callbacks check that flag before touching the object.

`LegacyMap.kill()` releases map-owned resources.
`Map[Symbol.dispose]()` owns both loaded-map and final renderer
teardown; there is no separate public partial-unload operation.

The tile cache also evicts resources by calling `kill()`. Pending
network fetches or GPU uploads check `this.killed` before writing
results, so evicted resources are discarded.

`Viewer[Symbol.dispose]()` drains its event and configuration
unsubscribe closures, disposes `Map`, and removes the UI wrapper.

The following TypeScript classes implement `[Symbol.dispose]()` as the
canonical teardown hook:

| Class | `kill()` shim? | Reason |
|---|---|---|
| `Map` | no | no JS callers |
| `Viewer` | no | no JS callers |
| `Renderer` | no | no JS callers |
| `GpuTexture` | yes | `subtexture.js` |
| `GpuMesh` | yes | `mesh.js` |
| `GpuDevice` | no | no JS callers |
| `Atmosphere` | no | no JS callers |

Classes that keep `kill()` retain it only because a legacy JS file
calls it directly. The shim delegates to `[Symbol.dispose]()` and
carries a comment naming the JS file. Remove it once that file is
migrated to TypeScript.

`Renderer` and `Viewer` use `disposed_` as their guard field. The
legacy `killed` name is retained on `Map`, `LegacyMap`, and their JS
resource callbacks.

New classes and major refactors should prefer modern forms:

- use `AbortSignal` for tile fetches, GPU uploads, and async chains
- implement `[Symbol.dispose]()` as the canonical teardown hook
- let `kill()` delegate to `[Symbol.dispose]()` when a legacy JS
  file calls it directly; name the file in the comment

## CSS Imports

The browser entry point imports CSS files for side effects:

- `src/viewer/viewer.css`
- `src/viewer/presenter/css/*.css`

Webpack handles these imports through loaders. TypeScript and editor
tooling need an ambient declaration for `*.css`; it lives in
`src/types/globals.d.ts`.

The CSS is runtime state, not decorative styling. `.vts-browser` and
`.vts-map` provide the absolute full-size layout expected by the UI
wrapper. `.vts-fallback` is hidden until the browser explicitly enables
it. Without these styles, the map wrapper can get wrong dimensions and
the fallback overlay can appear even when WebGL2 is available.
