# API and lifecycle

See [index.md](index.md) for the wiki table of contents.

This page records public API direction, construction, initialization,
configuration, events, and teardown rules.
[architecture.md](architecture.md) keeps only the high-level
ownership map.

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
as feature work touches them. `Map` exposes internal fields such as
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
| `Browser` | Legacy UI helpers | Moves into `Viewer` |
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
Named mapConfig view switching is exposed only as flat `Viewer` methods
for migration and compatibility tooling:

- `viewer.setView(view)`
- `viewer.getView()`
- `viewer.getNamedViews()`

Deprecated entry points and concepts:

- `browser()` and the `map` config key for mapConfig loading
- tileserver-injected `browserOptions`
- views from vts-browser-js
- `addBoundLayer` promotion to `Viewer`

Layer visibility in new code belongs in the style specification. Avoid
new branches that split behaviour by "style or mapConfig" unless the
branch is deleting or isolating the mapConfig path.

## Configuration

Runtime configuration lives in one `ConfigStore<ViewerConfig>`
(`src/core/config-store.ts`), implemented by
[rfc-config-store.md](rfc-config-store.md). The single-source
`catalogue` object (`src/core/viewer-config.ts`) declares every
valid key exactly once — doc comment, producer default,
normalizer, URL parse kind, and visibility class — and the
`ViewerConfig` type, `defaultViewerConfig()`,
`normalizeConfigPatch()`, the public subsets, and the URL parsing
all derive from it. Invalid input falls back to the key's
catalogue default, produced fresh for array values.

The store's live value map is the single config object: `Map.config`,
`LegacyMap.config`, `Renderer.config`, and `Browser.config` all alias
it, so reads anywhere see the same normalized values immediately.

`Viewer.setParam(key, value)` and `Viewer.getParam(key)` are typed
over `Viewer.PublicRuntimeConfig` (`src/core/viewer-config.ts`), the
deliberate public subset of `ViewerConfig`: live, application-facing
keys only. Every key in the subset is verified live — covered by a
watcher with the required side effect, or read from the store's
value map at time of use. Key and value types correlate, so a typed
caller gets key completion, value checking, and key-specific return
types; a key outside the subset throws at runtime, so a JavaScript
typo fails loudly. `setParam` reaches `Browser.setConfigParam`,
which normalizes the value and writes it to the store; `getParam`
reads `store.get()`. The contract is pinned by compile-time tests
in `test/types/viewer-api.ts`, run by `npm run test:unit`.

The factory option bags (`MapOptions.options` and the `browser()`
config) are typed by `PublicConstructionConfig`: the public runtime
keys plus the deliberately public construction and load-time keys.
The bag has no index signature, so a misspelled or internal-only
factory option fails compilation. At runtime, `map()` rejects any
option key that is not in the catalogue (after alias resolution),
so a JavaScript typo throws at construction; catalogued keys
outside the typed surface pass, because the query-string vocabulary
flows through the factory. `runtimeOptionsFromUrl` keeps catalogued
keys only, dropping arbitrary query parameters before they reach
the factory guard.

The remaining permissive ingestion paths accept the full catalogue
and the legacy `pos` / `rotate` / `pan` aliases, and filter unknown
keys silently: the deprecated `browser()` factory, the style
`config` block, and legacy `Browser.setConfigParam` callers, where
`position` and `view` additionally act on the loaded map at once.

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
(`src/core/viewer-config.ts`) and excluded from
`PublicRuntimeConfig`.

A loaded mapConfig's `browserOptions` apply through
`Map.applyBrowserOptions_`, which skips keys the caller configured
explicitly, so user settings always win.

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
is set after the style or mapConfig is fetched and parsed:

1. The `Map` constructor starts the style load or `loadMap`.
2. On success, `Map.map` is assigned.
3. `Map.tick` emits `map-loaded` after the reference frame is ready
   and resolves the one-shot `ready` Promise.

Viewer methods that reach into the legacy map guard with optional
chaining, so they are no-ops before `ready` resolves.

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

`Map.loadMap()` and `Map.unloadMap()` reset the per-loaded-map
`map-loaded` gate. The `ready` Promise remains one-shot for the typed
`Map` wrapper.

## Event Bus

The event bus is a typed `EventBus<ViewerEventMap>`
(`src/core/event-bus.ts`) owned by `Map`. `Map.on` and `Map.once`
both return an unsubscribe function; both are surfaced on `Viewer`.
`Map.emit` is internal — applications only subscribe.

`Map` emits its own lifecycle events (`tick`, `map-loaded`,
`map-mapconfig-loaded`, `map-unloaded`, `map-update`, the
position-change pair). The legacy emitters receive the bus instance
at construction and publish through it directly: `LegacyMap`
(geo-feature events) and `GpuDevice` (context-loss events).
Browser-layer code emits through `Map.emit`.

Dispatch is per event name: `emit` visits only listeners registered
for the emitted name and returns without allocation when none are
registered. `emit` iterates a snapshot of the listener set; listeners
added during an emit do not receive it, listeners removed during an
emit still do. A throwing listener aborts the remaining listeners in
the same emit call. `EventTarget` was rejected because it does not
match the MapLibre-style `on()` / `once()` API, allocates
`CustomEvent` objects for frequent events, and still needs an
adapter. See [rfc-event-bus.md](rfc-event-bus.md).

Event names and payload types are defined by `ViewerEventMap` in
`src/core/types.ts`:

- `map-mapconfig-loaded`
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

Engine objects such as `Map`, `LegacyMap`, and `Browser` hold a
`killed` flag. After disposal or `kill()`, the animation frame
callback and pending async callbacks check that flag before touching
the object.

`LegacyMap.kill()` releases map-owned resources but does not destroy
the shared `Renderer`. `Map.unloadMap()` may unload one map and later
load another through the same `Renderer`; `Map[Symbol.dispose]()`
owns final renderer teardown.

The tile cache also evicts resources by calling `kill()`. Pending
network fetches or GPU uploads check `this.killed` before writing
results, so evicted resources are discarded.

`Browser.kill()` drains the unsubscribe closures stored for every
listener registered at construction.

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

`Renderer` uses `disposed_` as its guard field. The legacy `killed`
name is retained on `Map`, `LegacyMap`, `Browser`, and their JS
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
