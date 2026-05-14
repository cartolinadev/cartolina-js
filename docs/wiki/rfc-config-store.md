# RFC: ConfigStore — reactive configuration for cartolina-js

**Status:** In review  
**Context:** core.js suppression; see [architecture.md](architecture.md)

---

## 1. Problem

The library currently manages configuration through three independent
`config` objects (Browser, Core, LegacyMap), a stringly-typed
`setConfigParam(key, value)` chain, and a string-prefix routing
convention (`map*`, `renderer*`, `debug*`) spread across four files.
Adding or changing a config option requires edits in multiple switch
statements with no compiler assistance.

Concrete symptoms:

- ~200 runtime keys, none documented in one place; a developer must
  grep four files to discover valid keys and their types.
- Three separate `this.config` stores with no shared source of truth;
  live values differ depending on which store you read.
- Routing is implicit (prefix matching in switch/default branches),
  not enforced by the type system.
- `Core`'s routing logic is a blocker for absorbing Core into `Map`,
  which in turn blocks `core.js` suppression.

---

## 2. Prior art — config store libraries

Two npm packages implement the observable key-value store pattern and
were evaluated as potential replacements for a hand-written
`ConfigStore`.

**nanostores** (`@nanostores/map`) provides a typed map store with
`setKey()` and `listenKeys(store, keys, callback)`. It is framework-
agnostic, ~200 bytes, and TypeScript-native. Changes fire immediately
on `setKey()` — there is no built-in batching or deferred flush
mechanism.

**@preact/signals-core** uses one `signal()` per value rather than a
map. An explicit `batch(() => { ... })` groups writes and defers
listener dispatch until the batch closes. Fine-grained and well-
typed, but the one-signal-per-key model requires more setup than a
single typed store.

**Recommendation: write the store.** The flush-at-frame-boundary
contract is the key invariant for a renderer: no subsystem should
re-initialize mid-frame because several keys were set in one call.
Neither library provides this. nanostores fires immediately with no
workaround; signals-core requires wrapping every write site in
`batch()`, which re-introduces the coordination burden at every call
site. In both cases the library would be used against its grain.

The store implementation is ~50 lines with no dependencies. That is
not a threshold worth crossing for a third-party package. The custom
store is also easier to audit for correctness in a rendering context
where unexpected callbacks during a frame are a real failure mode.

---

## 3. Prior art — mapping and rendering libraries (survey)

The four most relevant external libraries were surveyed.

**MapLibre GL JS** accepts a flat typed `MapOptions` at construction
and provides specific typed setter methods for live updates
(`setCenter()`, `setBearing()`, `setStyle()`, etc.). No generic
string setter exists. Each subsystem receives its slice via direct
constructor arguments or method calls; there is no central config
store. Live update → method → subsystem; clean but verbose as the
API surface grows.

**CesiumJS** accepts a loose options bag in the `Viewer` constructor,
which routes to subsystem constructors imperatively. After
construction, all config is done by direct property mutation on
exposed sub-objects (`camera.position = ...`,
`scene.fog.enabled = true`). No reactive layer; subsystems are
open for external mutation. Flexible but offers no notification
mechanism — callers cannot observe config changes.

**Babylon.js** is the closest prior art. `Scene` exposes typed
property setters that fire dedicated observables on change
(e.g., setting `scene.fogEnabled = true` triggers
`onFogEnabledChangedObservable`). Materials and lights subscribe
to scene observables and react accordingly. Each config domain has
its own observable; the Scene acts as a broker. The key insight:
*subsystems declare what they watch, not the Scene routing what to
push.* Babylon.js warns that external reactive frameworks
(Vue, React) must not hold Scene references — the internal
observable system conflicts with framework change detection.

**Pixi.js v8** uses a plugin self-selection model. Every subsystem
implements `init(options)` and receives the full flat `ApplicationOptions`
bag; each plugin reads the keys it cares about and ignores the rest.
No central routing table. No live-update mechanism in the plugin
contract — that is plugin-local. The composability is excellent;
the lack of a watch mechanism means consumers must poll or re-init
for live changes.

**Synthesis.** None of the surveyed libraries implement a general
reactive config store. MapLibre and Pixi.js handle initialization
well but have no watch mechanism. Babylon.js has per-property
observables but no unified config type. The design proposed here
combines Pixi.js's self-selection model (subsystems pull, nothing
pushes) with Babylon.js's observer pattern (watchers fire on change)
and applies it to a single typed config surface.

---

## 4. Proposed design

### 3.1 ConfigStore

A small, self-contained class:

```typescript
class ConfigStore<T extends object> {
    constructor(defaults: T)

    get<K extends keyof T>(key: K): T[K]

    set(patch: Partial<T>): void

    watch<K extends keyof T>(
        keys: K[],
        fn: (values: Pick<T, K>) => void,
    ): () => void   // returns unsubscribe

    flush(): void
}
```

`set()` records which keys changed and marks watchers dirty; it
does not fire callbacks immediately. `flush()` fires all dirty
watchers once, called at the start of each render frame by the
render loop. This ensures no subsystem re-initializes mid-frame
when multiple keys are set together (e.g., a `setConfigParams({})`)
batch).

The store holds no domain knowledge. It does not know what `mapFog`
means, which subsystem owns it, or what valid values are. It is a
typed, observable key-value map.

### 3.2 ViewerConfig

A single TypeScript interface that enumerates every valid config
key. It replaces the three `this.config` objects and the partial
`CoreConfig` type in `src/core/types.ts`.

The interface is divided into named groups by comment block for
readability, but remains flat — no nesting. Flat layout keeps
`set({ mapFog: true, antialias: false })` natural and avoids
deeply nested patch types.

```typescript
interface ViewerConfig {
    // --- UI controls (Browser) ---
    interactive: boolean;
    panAllowed: boolean;
    rotationAllowed: boolean;
    zoomAllowed: boolean;
    sensitivity: number;
    navigationMode: string;
    // ... (all ~31 Browser keys)

    // --- Terrain engine (LegacyMap) ---
    mapFog: boolean;
    mapCache: number;
    mapMaxProcessingTime: number;
    // ... (all ~80 map* keys)

    // --- Renderer ---
    antialias: boolean;
    anisotropic: boolean;
    cssDpi: number;
    // ... (all ~4 renderer* keys)

    // --- Cross-cutting ---
    style: StyleSpecification | null;
    position: MapPosition | null;
    authorization: AuthConfig | null;
    // ...
}
```

Exact key names, types, and defaults are a separate cataloguing
task (see §6, step 1). The interface is the authoritative
definition; no key exists unless it is declared here.

### 3.3 Subsystem pattern

Each subsystem that cares about config takes a `ConfigStore` at
construction and calls `watch()` for the keys it owns:

```typescript
class Atmosphere {
    constructor(store: ConfigStore<ViewerConfig>) {
        const init = store.get('atmosphere');
        this.enabled = init.enabled;
        this.density = init.density;

        store.watch(['atmosphere'], ({ atmosphere }) => {
            this.apply(atmosphere);
        });
    }
}
```

The subsystem is fully responsible for its own config slice.
Nothing else needs to know that `Atmosphere` exists or which keys
it uses. Adding a new subsystem requires no changes to any router.

### 3.4 Compatibility shim

Legacy JS code calls `setConfigParam(key, value)` throughout the
codebase. These call sites cannot all be migrated at once, and some
(in `LegacyMap`) may never be migrated while legacy JS remains.

The shim is trivial:

```javascript
// In Browser (and any other surviving legacy entry point)
setConfigParam(key, value) {
    this.configStore.set({ [key]: value });
}
```

The entire routing switch and prefix-matching logic is deleted.
`setConfigParam` becomes a two-line compatibility wrapper that
writes to the store. The store dispatches to watchers at next
flush. Legacy call sites require no changes; they continue to work
indefinitely through the shim.

This resolves the incremental-migration concern: the routing
complexity is eliminated in one PR (when the store is wired up),
regardless of how many legacy call sites remain.

---

## 5. Relation to core.js suppression

The current `Core` constructor takes a ~130-key config object and
owns the routing logic that distributes it to `LegacyMap`,
`Renderer`, and `Inspector`. This routing is the main reason `Core`
cannot simply be inlined into `Map`: the logic is substantial and
entangled with the three separate `this.config` stores.

With `ConfigStore` in place:

- `Core`'s config routing switch is replaced by subsystem watchers.
- `Core.config`, `Browser.config`, and the `configStorage` deferred
  map are all replaced by the single store.
- `Core`'s constructor shrinks to: create store, instantiate
  subsystems with the store reference.
- Inlining what remains of `Core` into `Map` becomes a mechanical
  move with no routing logic to untangle.

`ConfigStore` is therefore a prerequisite for clean `core.js`
suppression, not just a config improvement.

---

## 6. Implementation steps

**Step 1 — Catalogue ViewerConfig (prerequisite, ~1 day)**

Enumerate every valid key across `Browser.initConfig()`,
`Core.setConfigParam()`, `LegacyMap.setConfigParam()`, and
`Renderer.setConfigParam()`. Write the full `ViewerConfig`
interface with types and defaults. This step has zero runtime
impact and can be reviewed independently.

**Step 2 — Implement ConfigStore (~2 hours)**

Write `src/core/config-store.ts`. Unit-test `set`, `get`, `watch`,
and `flush` in isolation.

**Step 3 — Wire store at Browser construction (~half day)**

Browser constructs a `ConfigStore<ViewerConfig>` with defaults,
replaces `this.config` with the store, and reduces
`setConfigParam` to the two-line shim. `Browser.initConfig()` is
deleted; defaults move into the `ViewerConfig` defaults object
passed to the store constructor.

At this point the store exists but nothing watches it yet —
behaviour is unchanged because the shim writes to the store and
legacy subsystems still read from it via the existing getters.

**Step 4 — Migrate subsystems one at a time**

For each subsystem, replace `setConfigParam` case handling with a
`watch()` call in the subsystem constructor. Order of preference:

1. `Renderer` — small surface (~4 keys), already TypeScript.
2. `Browser` UI controls — self-contained, no terrain engine
   involvement.
3. `LegacyMap` — large (~80 keys), but migration is mechanical;
   each case becomes a `watch()` entry.
4. `Inspector` — small, low risk.

Each subsystem migration can be its own PR. The shim ensures
existing call sites keep working throughout.

**Step 5 — Delete routing logic**

Once all subsystems watch the store, the `setConfigParam` switch
statements in Core, Browser, and LegacyMap are empty. Delete them.
`setConfigParam` remains as the two-line shim for as long as legacy
JS call sites exist.

**Step 6 — Inline Core into Map**

With routing gone, `Core`'s constructor reduces to subsystem
instantiation. It can be absorbed into `Map` cleanly. This is the
`core.js` suppression step.

---

## 7. Open questions

**Q1: Validation.**  
The store accepts `Partial<T>` with no range or type checks beyond
TypeScript's structural check. Unknown string keys from legacy JS
will silently be ignored (TypeScript won't catch them at the call
site if the caller is JS). Decide: add a runtime key check in
`set()`, or accept that the type system is the only guard?

**Q2: Initial flush.**  
Subsystems initialize from `store.get()` at construction time, then
watch for changes. This means a subsystem constructed before the
store is fully populated will see partial defaults. Define
construction order carefully, or introduce an explicit
post-construction `flush()` call that fires all watchers once with
the full initial state (eliminating the `get()`-at-construction
pattern entirely).

**Q3: LegacyMap coupling.**  
`LegacyMap` is the largest config consumer and is pure JS. The
`watch()` pattern requires passing a store reference at
construction, which is a change to how `Core` creates `LegacyMap`.
This is straightforward but must be done before step 4 can reach
the map* keys. Budget a separate PR for this constructor change.

**Q4: configStorage.**  
`Core` maintains a `configStorage` map for keys set before the map
is loaded, which are replayed on load. With the store, this is
unnecessary — the store always holds the current value and
subsystems read it at construction. Confirm no other purpose for
`configStorage` before deleting it.

## Review round 1

1. Step 3 does not preserve current behavior as written. The RFC says
   `Browser` replaces `this.config` with the store, reduces
   `setConfigParam` to a store write, and has no watchers yet. Current
   browser code and `control-mode/map-observer.js` read `this.config`
   fields directly, while `Core`, `LegacyMap`, and `Renderer` only
   update their own `config` objects through their current switch
   handlers. A store-only shim would stop those legacy readers from
   seeing writes. The rollout needs an explicit bridge: either keep the
   existing config objects updated until each owner watches the store,
   or migrate the first required watchers before replacing the old
   routing.

2. Validation is underspecified. Q1 frames validation as a choice
   between runtime key checks and TypeScript, but the existing setters
   also normalize values from untyped sources: booleans, bounded
   numbers, fixed-length arrays, `MapPosition`, `geojsonStyle` JSON,
   and authorization values. `ViewerConfig` types do not protect calls
   from JavaScript, URL params, style JSON, or `browserOptions`. The
   RFC should define where raw authored values become normalized store
   values and whether watchers may assume every value they receive has
   already been validated.

3. The deferred `flush()` contract is too broad for all current config
   keys. Frame-boundary dispatch is a good renderer invariant, but
   loading and construction keys need synchronous availability:
   `style`/`map` start async loading in the `Core` constructor,
   `position`/`view` are replayed when `LegacyMap` appears, loader
   flags are applied in `Map.setLoaderParams`, and mapConfig
   `browserOptions` are merged with caller options after load. The RFC
   should separate construction-only state from live reactive state, or
   specify which keys are read synchronously from the store and which
   keys are delivered by frame flush.

4. The subsystem migration order is inaccurate for renderer config.
   `Renderer.setConfigParam()` currently delegates back to
   `Core.setRendererConfigParam()`, and the actual validation and
   storage switch lives in `Core`. Migrating `Renderer` first is still
   possible, but the RFC should say that the renderer switch is moved
   out of `Core`, not that `Renderer` already owns the behavior.

5. Section numbering under "Proposed design" starts at 3.1 even though
   it is section 4. Renumber those subsections before the RFC is
   accepted.
