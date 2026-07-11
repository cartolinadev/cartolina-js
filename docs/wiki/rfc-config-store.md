# RFC 1: ConfigStore — reactive configuration for cartolina-js

**Status:** Implemented  
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

### 4.1 ConfigStore

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
when multiple keys are set together (e.g., a `setConfigParams({})`
batch).

`flush()` governs post-construction live updates only. For
construction-time reads — `style`, `position`, and any other key
that must be available before the frame loop starts — subsystems
call `store.get()` directly. `store.get()` returns the current
value immediately, with no flush required. The initial defaults
object passed to the constructor covers all keys, so a value set
before subsystem construction is always visible via `get()`.

The store holds no domain knowledge. It does not know what `mapCache`
means, which subsystem owns it, or what valid values are. It is a
typed, observable key-value map.

### 4.2 ViewerConfig

A single TypeScript interface that enumerates every valid config
key. It replaces the three `this.config` objects and the partial
`CoreConfig` type in `src/core/types.ts`.

The interface is divided into named groups by comment block for
readability, but remains flat — no nesting. Flat layout keeps
`set({ mapCache: 512, antialias: false })` natural and avoids
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
    transformRequest: TransformRequestCallback | null;
    // ...
}
```

Exact key names, types, and defaults are a separate cataloguing
task (see §6, step 1). The interface is the authoritative
definition; no key exists unless it is declared here.

Values in the store are already normalized. Typed `Map` public
methods normalize in the method body before calling `store.set()`.
The `setConfigParam` shim normalizes before writing (see §4.4).
Watchers receive values that have passed normalization and may
treat them as valid.

### 4.3 Subsystem pattern

Each subsystem that cares about config takes a `ConfigStore` at
construction and calls `watch()` for the keys it owns:

```typescript
class LegacyMap {
    constructor(store: ConfigStore<ViewerConfig>) {
        this.config.mapFlagAtmosphere = store.get('mapFlagAtmosphere');

        store.watch(['mapFlagAtmosphere'], ({ mapFlagAtmosphere }) => {
            this.config.mapFlagAtmosphere = mapFlagAtmosphere;
        });
    }
}
```

The subsystem is fully responsible for its own config slice.
Nothing else needs to know that `Atmosphere` exists or which keys
it uses. Adding a new subsystem requires no changes to any router.

### 4.4 Compatibility shim

Legacy JS code calls `setConfigParam(key, value)` throughout the
codebase. These call sites cannot all be migrated at once, and some
(in `LegacyMap`) may never be migrated while legacy JS remains.

The shim normalizes the incoming value using the same logic
currently in each switch case (boolean coercion, range clamping,
JSON parsing), then writes to the store. During the incremental
migration it also keeps the old routing working:

```javascript
// In Browser — full bridge shim for steps 3–4
setConfigParam(key, value) {
    const normalized = normalizeConfigValue(key, value);
    this.configStore.set({ [key]: normalized });
    // dual-write: keep Browser readers seeing correct values
    this.config[key] = normalized;
    // forward non-Browser keys through the old Core route
    // until the corresponding subsystem migrates to watch()
    if (!isBrowserKey(key)) {
        this.core.setConfigParam(key, normalized);
    }
}
```

As each subsystem migrates to `watch()` in step 4, the forwarding
call for its key group is removed from the shim. `this.config` and
the forwarding call are both gone by step 5.

Legacy call sites require no changes; they continue to work
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

Browser constructs a `ConfigStore<ViewerConfig>` with defaults
and assigns it as `this.configStore`. The existing `this.config`
object is kept. `Browser.initConfig()` is deleted; defaults move
into the `ViewerConfig` defaults object passed to the store
constructor.

`setConfigParam` is replaced by the full bridge shim from §4.4.
The shim writes to the store, dual-writes to `this.config` for
Browser-local readers (`control-mode/map-observer.js`), and
forwards all non-Browser keys to `Core.setConfigParam` through
the existing route. `Core`, `LegacyMap`, and `Renderer` config
objects are updated exactly as before.

Nothing watches the store yet. Behaviour is unchanged.

**Step 4 — Migrate subsystems one at a time**

For each subsystem, replace `setConfigParam` case handling with a
`watch()` call in the subsystem constructor. Order of preference:

1. `Renderer` — small surface (~4 keys), already TypeScript.
   `Renderer.setConfigParam()` currently delegates to
   `Core.setRendererConfigParam()`; the switch lives in `Core`.
   Move that switch into `Renderer` first, then replace it with
   `watch()`.
2. `Browser` UI controls — self-contained, no `Map` or `LegacyMap`
   involvement.
3. `LegacyMap` — large (~80 keys), but migration is mechanical;
   each case becomes a `watch()` entry.
4. `Inspector` — small, low risk.

Each subsystem migration can be its own PR. The shim ensures
existing call sites keep working throughout.

**Step 5 — Delete routing logic and legacy config objects**

Once all subsystems watch the store, the `setConfigParam` switch
statements in Core, Browser, and LegacyMap are empty. Delete them.
The dual-write from the shim is removed — nothing reads `this.config`
any more. Remove `this.config` from Browser and Core.
`setConfigParam` remains as the normalization shim for as long as
legacy JS call sites exist.

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

   *Author: implemented. Step 3 now keeps `this.config` in place and
   adds `this.configStore` alongside it. The shim dual-writes to both.
   Legacy readers see correct values through `this.config` throughout
   the migration. Step 5 now removes `this.config` once all subsystems
   have migrated.*

2. Validation is underspecified. Q1 frames validation as a choice
   between runtime key checks and TypeScript, but the existing setters
   also normalize values from untyped sources: booleans, bounded
   numbers, fixed-length arrays, `MapPosition`, `geojsonStyle` JSON,
   and authorization values. `ViewerConfig` types do not protect calls
   from JavaScript, URL params, style JSON, or `browserOptions`. The
   RFC should define where raw authored values become normalized store
   values and whether watchers may assume every value they receive has
   already been validated.

   *Author: implemented. §4.2 now states that values in the store are
   already normalized. Typed `Map` public methods normalize in the
   method body; the `setConfigParam` shim normalizes before writing
   (§4.4 updated). Watchers may treat received values as valid.*

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

   *Author: implemented, with a narrowed response. A type-level split
   between construction-only and live keys is not adopted — the same
   key may be read at construction and watched for live updates.
   Instead §4.1 now specifies the mechanism: construction-time reads
   use `store.get()` directly, which returns the current value
   immediately. The keys cited (`style`, `position`, `browserOptions`)
   are all in the initial defaults object and therefore available
   synchronously at subsystem construction before any flush occurs.*

4. The subsystem migration order is inaccurate for renderer config.
   `Renderer.setConfigParam()` currently delegates back to
   `Core.setRendererConfigParam()`, and the actual validation and
   storage switch lives in `Core`. Migrating `Renderer` first is still
   possible, but the RFC should say that the renderer switch is moved
   out of `Core`, not that `Renderer` already owns the behavior.

   *Author: implemented. Step 4, item 1 now notes that the renderer
   switch lives in `Core` and must be moved into `Renderer` before
   `watch()` can replace it.*

5. Section numbering under "Proposed design" starts at 3.1 even though
   it is section 4. Renumber those subsections before the RFC is
   accepted.

   *Author: implemented. §3.1–§3.4 renumbered to §4.1–§4.4.*

## Review round 2

1. Step 3 still drops live routing for non-Browser keys if
   `setConfigParam` becomes only the normalization shim described in
   §4.4. Dual-writing to `Browser.this.config` keeps Browser readers
   working, but it does not update the separate `Core.config`,
   `LegacyMap.config`, or renderer config objects. Current
   `Browser.setConfigParam(key, value, true)` forwards `map*`,
   `renderer*`, `debug*`, and `authorization` keys to the existing core
   route so live `Viewer.setParam()` calls take effect. Until the
   corresponding watchers exist, the compatibility shim must keep
   forwarding those keys through the old route, or Step 3 must include
   the first watchers needed to replace that route. Otherwise Step 3 is
   not behavior-preserving.

   *Author: implemented. §4.4 shim now shows all three bridge
   operations: store write, `this.config` dual-write, and forwarding
   of non-Browser keys to `Core.setConfigParam`. Step 3 updated to
   match. The forwarding call is removed per key-group in step 4 as
   each subsystem migrates.*

## Review round 3

Signed off. The bridge shim now preserves current Browser, Core,
LegacyMap, and Renderer config behavior during the migration, and the
earlier validation, flush timing, renderer ownership, and numbering
comments have been addressed.

## Review round 4 — requested

`mapFog` was removed as dead code (the fog tile system it controlled
was replaced by `Atmosphere` and never drew in the `TileRenderRig`
path). Three places in this document that used `mapFog` as a
representative example have been updated to use `mapCache` instead.
No design decisions changed; only the example key was replaced.

---

## Review round 4

Not signed off yet. The requested example replacement is verified and
accepted, but the delta since the round-3 sign-off is larger than the
requested section describes, and one later commit rewrote reviewer
text inside closed rounds. Editorial: the requested section above was
retitled by the reviewer from `## Review round 4` to
`## Review round 4 — requested`, the heading form the protocol
prescribes for an author request; its text is untouched.

- The `mapFog` claim is confirmed against the code. The fog tile
  system and its `mapFog` key were removed in `89bfd044`; no live
  reference remains in `src/` or `demos/`. `mapCache` is a live key
  with a default in `core.js` and a setter and getter in
  `map/map.js`. The three updated sites match: the §4.1
  domain-knowledge sentence, the §4.2 `set()` example, and the §4.2
  interface listing — where the change removes the `mapFog: boolean;`
  line and the pre-existing `mapCache: number;` line becomes the
  representative key. Accepted.

  *Author: implemented. The accepted `mapFog` replacement is retained.*

- The requested section names only the `mapFog` replacement, but two
  later commits also edited the signed-off body while the RFC sat in
  review. `77704cb9` rewrote step 4 item 2 from "no terrain engine
  involvement" to "no `Map` or `LegacyMap` involvement", following
  the docs-wide retirement of the "terrain engine" label. `2dc6a183`
  replaced the §4.2 cross-cutting key `authorization` (typed
  `AuthConfig | null`) with `transformRequest` (typed
  `TransformRequestCallback | null`). Both edits are verified correct
  against the current tree: no `authorization` config key remains in
  the source, and `transformRequest` is normalized in
  `Browser.setConfigParam` and forwarded through
  `Core.setConfigParam` (`browser.js`, `core.js`). A file-history
  check confirms these two commits and the requested `mapFog` change
  are the only body edits since sign-off (`ba486b46` changed only the
  title, adding the RFC number). This note records the complete
  delta; confirm below.

  *Author: implemented. The complete post-sign-off body delta is
  confirmed. Both additional edits describe the current code and are
  retained.*

- `2dc6a183` also rewrote reviewer text inside the closed rounds:
  round 1 note 2 now reads "request-transform values" and round 2
  note 1 now reads "`transformRequest` keys", where the signed-off
  text (`31fc5301`) reads "authorization values" and "`authorization`
  keys". The review protocol forbids altering the reviewer's note
  text, and closed rounds are historical record. As rewritten, the
  record shows the round-1 and round-2 reviewer citing a hook that
  entered the tree on 2026-06-19, after sign-off; at sign-off the
  code forwarded `authorization` keys and `Core` held an
  `authorization` config value. Restore the original wording in both
  notes; the rename is already recorded by the §4.2 body edit and by
  this round. Blocker.

  *Author: implemented. The round-1 and round-2 reviewer notes now use
  their original signed-off wording: "authorization values" and
  "`authorization` keys".*

- Same class as the requested change, one more stale example key:
  §4.3 illustrates the subsystem pattern with
  `store.get('atmosphere')` returning an object with `enabled` and
  `density` fields. No `atmosphere` key exists; the live key is the
  boolean `mapFlagAtmosphere` (`map/map.js`). The example also treats
  one key as a nested group of values, which the flat-layout rule in
  §4.2 excludes. Rework the example around real flat keys before
  sign-off.

  *Author: implemented. The example now shows `LegacyMap` reading and
  watching the real flat boolean key `mapFlagAtmosphere`.*

- The rest of the body re-verified against the current tree and
  holds: the three separate config objects (`Browser`, `Core`,
  `LegacyMap`); prefix routing of `map*`, `renderer*`, and `debug*`
  keys in `Browser.setConfigParam`; `Renderer.setConfigParam`
  delegating to `Core.setRendererConfigParam` with the switch living
  in `Core`; `configStorage` in `Core` with replay through
  `setLoaderParams`; `Browser.initConfig()`; `CoreConfig` in
  `src/core/types.ts`; `control-mode/map-observer.js` reading
  `this.config` directly. The key counts hold to their stated
  tolerance: 81 `map*` cases and 4 `renderer*` keys today.

  *Author: implemented. No further body change is required for the
  re-verified material.*

---

## Review round 5 — sign-off

All round-4 notes are resolved and verified against the tree. The
round-1 and round-2 reviewer notes are byte-identical to the
signed-off text in `31fc5301` — the "authorization values" and
"`authorization` keys" wording is restored, which clears the round-4
blocker. The §4.3 example now reads and watches the real flat boolean
key `mapFlagAtmosphere` through `LegacyMap`, matching the live setter
in `map/map.js`. The post-sign-off body delta is confirmed complete
and correct: the `mapFog` → `mapCache` example replacement, the
step 4 terminology fix, and the §4.2 `authorization` →
`transformRequest` key replacement all describe the current code.
Design accepted.

One editorial note, not a blocker: the paragraph after the §4.3
example still says "Nothing else needs to know that `Atmosphere`
exists or which keys it uses"; the example class is now `LegacyMap`.

---

## Addendum — 2026-07-11 — implementation note

All six implementation steps are done, in four commits (steps 1, 2,
3, 4+5, and 6). `ViewerConfig` and `defaultViewerConfig()` live in
`src/core/viewer-config.ts`; `ConfigStore<T>` in
`src/core/config-store.ts` with a mocha suite in
`test/unit/config-store.test.js`. `Map.tick` flushes the store at
the start of every frame. The `setConfigParam` switches in
`Browser`, `Core`, and `LegacyMap`, `Core.setRendererConfigParam`,
`Browser.initConfig`, and `Core.configStorage` are deleted, and
step 6 removed `core.js` and `core.d.ts` entirely: `Map` absorbed
the frame loop, map loading, `browserOptions` application, the
`ready` promise, and construction of `Renderer` and `Inspector`.
The legacy `core` back-references now hold the `Map` instance.

Deviations from the accepted design:

- Steps 4 and 5 landed as one commit. The §4.4 bridge shim's
  dual-write and per-key-group forwarding existed only during
  step 3: from step 4 on, the store's live value map (exposed as
  `ConfigStore.values`, an extension over the §4.1 signature) *is*
  the config object — `Map.config`, `LegacyMap.config`,
  `Renderer.config`, and `Browser.config` all alias it. That keeps
  every legacy reader and the direct config writes in
  `control-mode/map-observer.js` working with no migration window,
  and eliminates the three separate stores in one move.
- Step 5's "remove `this.config` from Browser and Core" is
  fulfilled in substance, not in letter: the fields remain as
  aliases of the store's value map because roughly ten browser-layer
  modules and twenty map modules read them on hot paths.
- Normalization is centralized in `normalizeConfigValue()` /
  `normalizeConfigPatch()` (`viewer-config.ts`) rather than living
  in the shim: the same functions serve `Browser.setConfigParam`,
  `Map.applyBrowserOptions_`, and the style `config` block.
  `canonicalConfigKey()` resolves the legacy `pos`, `rotate`, and
  `pan` aliases and filters unknown keys; `mapNoTextures` expands to
  also set `mapDisableCulling`.
- `position` and `view` stay command-like: the shim and the load
  path apply them to the loaded map immediately and null them in
  the store; watchers do not deliver them.
- `Core.configStorage` (Q4) is gone. Its replay role is covered by
  `LegacyMap` reading current store values at construction; its
  user-precedence role by `applyBrowserOptions_` skipping keys
  present in the caller's original options, and by
  `setLoaderParams` applying the same precedence for the five
  loader keys.
- The store is constructed by `Browser` (per step 3) and handed to
  `Map`, which owns flushing; `Map` does not construct it because
  `Browser` must normalize the caller options before `Map` starts
  loading.
- Behavior fixes bundled with the migration: live `pan` changes now
  reach `Autopilot.setAutopan` (the old switch re-applied
  autorotate instead); `Browser.getConfigParam('position')` returns
  the live position (the old switch dropped the return); the
  renderer's consume-once `mapForceFrameTime` reset writes through
  the store. Default-value reconciliations (the `Number.MAXINTEGER`
  typo, keys that were undefined until set, dead
  `searchElement`/`searchValue` defaults) are listed in the step-1
  commit message.
- `CoreConfig` in `src/core/types.ts` is deleted per §4.2; typed
  modules use `Readonly<ViewerConfig>`.

Open questions resolved: Q1 — runtime key filtering via
`canonicalConfigKey` plus central normalization; watchers receive
normalized values. Q2 — construction-time reads use `get()`/the
value map, as §4.1 specified; no post-construction full flush was
needed. Q3 — `LegacyMap` reaches the store through its `core`
reference, registers its watchers in the constructor, and
unsubscribes them in `kill()`. Q4 — confirmed and deleted.

Validation: `npx tsc --noEmit` clean; 22 unit tests; the
`simple-terrain`, `complex-terrain`, and `full-terrain` URLs render
correctly; Playwright probes confirmed gesture events, `setParam` /
`getParam` round-trips with clamping and aliases, a live
`mapFlagLighting` toggle redrawing the scene, and the
mapConfig-path load (position and `browserOptions` application)
rendering with no errors.
