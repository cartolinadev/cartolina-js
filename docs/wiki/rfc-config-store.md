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
task (see §6, step 1). The interface is derived from the key
catalogue (§4.5); no key exists unless the catalogue declares it.

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

### 4.5 Single-source key catalogue

The surface implemented by steps 1–6 declares each key in up to
five places: the `ViewerConfig` interface, the
`defaultViewerConfig()` literal, the `normalizers` table, a
public-subset key array (all in `viewer-config.ts`), and a
key-type set in `url-config.ts` that restates the key's parse
type for URL values. The declared default also diverges from the
normalizer's invalid-input fallback for 29 of the 146 keys
(see round 6).

This revision collapses all five into one `catalogue` object.
Each entry is built by a typed spec constructor and carries every
per-key fact, with the entry's doc comment serving as the key's
documentation:

```ts
const catalogue = {

    /** Enables pan gestures. Ignored while `interactive`
     *  is false. */
    panAllowed: bool(true),

    /** Metatile cache budget in megabytes. */
    mapMetatileCache: num(10, MAX, 60),

    /** The WebGL context is created with antialiasing.
     *  Read once at renderer construction. */
    rendererAntialiasing: bool(true, 'construction'),
} as const;
```

A spec holds the value type, the default, the normalizer, the URL
parse kind, and a visibility class: `runtime`, `construction`,
`structural`, `internal`, or `debug`. Everything else is derived:

- `ViewerConfig` becomes a mapped type over the catalogue. Doc
  comments propagate: hovering a `ViewerConfig` or public-subset
  property shows the catalogue entry's comment.
- `defaultViewerConfig()` collects the specs' defaults.
- `normalizeConfigValue` dispatches to the spec's normalizer.
- `PublicRuntimeConfig` and `PublicConstructionConfig`, with
  their runtime key arrays, filter by visibility at the type
  level and at runtime: `runtime` keys form the runtime subset,
  `runtime` plus `construction` the construction subset;
  `structural`, `internal`, and `debug` keys are on neither
  public surface.
- `url-config.ts` parses a query value through the spec's URL
  parse kind; its five key-type sets are deleted.
  `STRUCTURAL_KEYS`, the positional `pos` parser, and the alias
  table remain, as URL-layer concerns.

A spec stores its default as a producer function. Scalar
constants are wrapped trivially; array and tuple defaults are
copied on every production, so each store — and each
invalid-input fallback — receives a fresh allocation, and no two
viewers share a mutable default. Environment-dependent defaults
(`mapLanguage` and `mapMetricUnits` from the browser language,
`mapAsyncImageDecode` from `createImageBitmap` availability) pass
an explicit factory reading that state. The reads are pure and
stable within a session, so a fallback produced during
normalization equals the value selected when the store was
constructed. The factories are guarded for non-browser
environments, so the unit build still loads the module.

One value per key: the catalogue default is also the fallback for
invalid input. Valid-path behavior is unchanged — the divergent
legacy fallbacks fire only when a caller writes an invalid value,
and such a write now yields the key's documented default. The
alternative — rejecting the invalid write and keeping the current
value — is a `setParam` behavior change and is not adopted.

One deliberate exception to default-as-fallback: a `geojsonStyle`
value that is a malformed JSON string throws from programmatic
normalization, matching current behavior — a loud failure at the
typed boundary, like the unknown-key throw. The URL layer instead
catches the parse failure and drops the parameter, consistent
with its permissive contract of silently filtering unknown keys;
today a malformed JSON query parameter aborts startup, which
step 9 corrects.

Deliberately outside the catalogue: the `keyAliases` table and
the `mapNoTextures` expansion in `normalizeConfigPatch`.

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

**Step 7 — Fold defaults into the normalizer table (catalogue)**

Merge the `defaultViewerConfig()` values into the `normalizers`
entries, forming the catalogue of §4.5. Reconcile the 29 keys
whose default and invalid-input fallback diverge to the catalogue
default; enumerate them in the implementing commit message.

**Step 8 — Derive the types and subsets**

Replace the hand-written `ViewerConfig` interface and the
public-subset key arrays with derivations from the catalogue. A
compile-time assertion pins the derived runtime-subset key union
to the audited 58-key list from the live-subset audit. The
assertion lives in the type-test suite (`test/types/`) and
remains after the migration as the public-API contract: an
incidental visibility edit cannot change the audited public
surface without an explicit test update.

**Step 9 — Derive URL parsing**

Replace the five key-type sets in `url-config.ts` with lookups of
the specs' URL parse kinds. The JSON parse kind catches a
malformed value and drops the parameter instead of letting the
parse failure abort startup.

**Step 10 — Document every key**

Write a doc comment for every catalogue entry stating what the
key does, checkable against the consumer that reads it. Keys
already documented in the interface keep their text.

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

---

## Addendum — 2026-07-11 — branch review fixes

A review of the implementation branch raised three findings; all
are addressed.

- `ConfigStore.flush()` cleared every dirty mark before dispatch,
  so a `set()` from one callback to a key of another
  already-scheduled watcher delivered the new value in the same
  flush and fired that watcher again with the same values on the
  next one. `flush()` now clears each watcher's mark at its own
  invocation over a snapshot of the scheduled watchers: a mid-flush
  write to a watcher that has not run yet is absorbed into its
  pending delivery, and a write to a watcher that already ran
  re-schedules it — exactly one callback per change, payloads
  current at delivery time. An unsubscribe from an earlier callback
  now also drops a pending delivery. The dispatch rules are pinned
  by unit tests. No watcher in the tree writes the store during
  dispatch, so no runtime behavior changed.
- The normalized-store invariant was not enforced for the keys that
  used an unchecked `raw` cast. Known shapes now have structural
  guards: `view`, `geojson`, `geodata`, and `style` accept strings
  and plain objects only; `position` accepts strings, arrays, and
  `MapPosition`-like objects (identified structurally by `toArray`);
  `controlSearchElement` accepts strings and `HTMLElement`;
  `mapFeaturesReduceParams` must be a non-empty all-number array.
  The two remaining shallow spots are annotated in `ViewerConfig`:
  `style` object shapes are validated at style load, and
  `mapSplitSpace` stays an unchecked legacy payload. Invalid-input
  tests run `normalizeConfigPatch` from an untyped call site; the
  unit build now compiles through `tsconfig.unit.json`.
- The renderer watched all four renderer keys but could apply only
  one. `rendererAntialiasing` and `rendererAllowScreenshots` are
  WebGL-context-creation flags, and `rendererAnisotropic` is baked
  into per-texture sampling parameters at texture creation, so a
  live change cannot take effect without recreating those objects.
  The watcher now covers only the live `rendererCssDpi`; the three
  construction-only keys are annotated in `ViewerConfig` and the
  distinction is documented in `api-and-lifecycle.md`.

---

## Addendum — 2026-07-11 — re-review: deep normalization guards

The re-review found the first-pass guards shallow: `[NaN, 2]`
passed the number-array check, `position` accepted any array,
`geojsonStyle` stored parsed non-record JSON and array objects, and
the plain-object check accepted class instances such as `Date`.

Fixed:

- `numberArray` requires `Number.isFinite` per element.
- `recordOrNull` checks the prototype (`Object.prototype` or
  `null`), rejecting arrays, class instances, and DOM objects; the
  `view`, `geojson`, `geodata`, and `style` guards inherit this.
- Both `geojsonStyle` forms (JSON string and object) route through
  `recordOrNull`.
- `position` accepts only arrays whose elements are strings or
  finite numbers — the legacy position vocabulary that
  `MapPosition.validate` consumes — or a `MapPosition`-like object.
  Its `ViewerConfig` type is corrected to
  `MapPosition | (number | string)[] | null`: the previous
  `number[]` was inaccurate (position arrays carry mode strings),
  and the `string` member never worked — `MapPosition` treats
  non-array input as empty, and the URL path parses `pos` strings
  into arrays before they reach the store.
  `LegacyMap.setPosition`'s declaration is corrected to match.
- The `rendererAnisotropic` note now says the level is read once at
  renderer creation and a change takes effect when the renderer is
  recreated; the store no longer feeds `GpuDevice.anisoLevel` at
  all, so the earlier "textures created afterwards" wording was
  wrong.

The reviewer's invalid examples are unit tests in
`test/unit/viewer-config.test.js`.

---

## Addendum — 2026-07-11 — PositionInput on the public surfaces

Follow-up to the re-review: the corrected position type had not
reached the public API, which still declared `MapPosition` (or
`MapPosition | number[]`) and therefore rejected the documented
array form. `PositionInput` in `src/core/types.ts` is now the one
definition — `MapPosition | (number | string)[]` — used by
`ViewerConfig`, `MapOptions`, the `browser()` config,
`Viewer.Config`, `Viewer.setPosition`, and the `LegacyMap`
declarations (`setPosition`, `convertPositionHeightMode`). It is
re-exported as `Map.PositionInput` and from the package index. The
exact ten-component tuple stays deferred until the position module
is typed precisely.

---

## Addendum — 2026-07-12 — typed public runtime boundary

A post-implementation review found the public accessors untyped:
`Viewer.setParam(key: string, value: MapRuntimeOptionValue)` erased
the type information `ViewerConfig` introduced — no key discovery,
no key-specific value or return types, no typo detection — unknown
keys were silently ignored, and the `setParam` JSDoc still
described the removed `map*` / `renderer*` prefix routing.
Addressed:

- `PublicRuntimeConfig` (`src/core/viewer-config.ts`) is the
  deliberate public subset of `ViewerConfig`: 66 keys that are live
  (a change after construction takes effect, through a watcher or a
  read of the store's value map at time of use) and
  application-facing (interaction, UI controls, cartographic
  appearance, units and language, resource budgets). The subset is
  a `const` key array checked against `ViewerConfig` by
  `satisfies`; `Pick` derives the type and a `Set` backs the
  runtime guard `isPublicRuntimeConfigKey`. Deliberately absent:
  construction-only keys, keys consumed only at map or style load
  (`mapDefaultFont`, `geojson`, `geodata`, `geojsonStyle`),
  structural and command keys with dedicated methods or
  construction options (`style`, `map`, `position`, `view`,
  `transformRequest`), debug keys and diagnostics, loader and
  traversal internals, and legacy payloads.
- `Viewer.setParam` and `Viewer.getParam` are typed with correlated
  key and value generics over the subset, surfaced as
  `Viewer.PublicRuntimeConfig` and exported from the package index.
  Keys outside the subset throw, so a JavaScript typo fails loudly.
  The permissive ingestion paths are unchanged and keep filtering
  silently through `canonicalConfigKey`: URL parameters,
  construction option bags, the style `config` block, and legacy
  `Browser.setConfigParam` callers. The `pos` / `rotate` / `pan`
  aliases are thereby confined to compatibility ingestion.
- The `setParam` prefix-routing JSDoc is replaced by the typed
  contract; callers see one flat surface with no subsystem
  ownership.
- Compile-time tests (`test/types/viewer-api.ts`, compiled by
  `tsconfig.types.json` inside `npm run test:unit`) pin the
  contract: a mistyped value, a misspelled key, a non-public key,
  and an alias all fail to compile, and `getParam` infers the
  key-specific return type. Unit tests in
  `test/unit/viewer-config.test.js` pin the runtime guard.

Validation: `npx tsc` clean on the typecheck, unit, and types
configs; 37 unit tests; the `simple-terrain`, `complex-terrain`,
and `full-terrain` URLs render correctly with no console or network
errors; a live probe confirmed typed round-trips with clamping,
chaining, and the unknown-key, non-public-key, and alias throws.

---

## Addendum — 2026-07-12 — factory typing and live-subset audit

The second post-implementation review raised two blockers: the
factory option bags remained untyped records, and several
`PublicRuntimeConfig` keys were not verified against their runtime
consumers. Both are addressed; every reviewer claim was confirmed
against the code before changing it.

Factory boundary:

- `PublicConstructionConfig` (`src/core/viewer-config.ts`) types
  the factory bags: every public runtime key plus the deliberately
  public construction keys (`interactive`, the three renderer
  creation flags, the UI keys read once when their control is
  built — `controlSearchElement`, `controlSearchValue`,
  `controlMeasureLite`, `controlLoading`, `bigScreenMargins` — and
  the load-time keys `mapDefaultFont`, `geojson`, `geodata`,
  `geojsonStyle`). `MapOptions.options` and `BrowserConfig` use it;
  the untyped `MapRuntimeOptions` record and `MapRuntimeOptionValue`
  are removed. The typed bag has no index signature, so a
  misspelled, wrong-typed, or internal-only factory option fails
  compilation.
- Permissive records remain only at the ingestion boundaries: the
  URL parser internals and the `Viewer.Config` constructor glue.
  The URL helpers now declare the public types, with a documented
  note that the URL vocabulary is wider and parsed internal or
  debug keys still apply at runtime.

Live-subset audit — every key checked against its consumer:

- Dead configuration removed from the catalogue, defaults,
  normalizers, and URL vocabulary: `mapFeaturesPerSquareInch` (the
  label density in effect comes from `mapFeaturesReduceParams`
  slots), `positionUrlHistory` (no consumer), and `controlGithub`
  (every read was commented out; those lines are deleted).
- Demoted from the runtime subset to construction-only:
  `controlSearchElement`, `controlSearchValue`,
  `controlMeasureLite`, and `controlLoading` (read once when their
  control is built; their watchers had no `UI.setParam` case and
  are removed from `Browser.watchConfig`), and `bigScreenMargins`
  (applied only when a control's visibility next changes).
- Missing propagation added: `mapMobileDetailDegradation` joins
  the cache watcher (`LegacyMap.setupCache` reads it);
  `mapTexelSizeFit`, `mapDegradeHorizon`, and
  `mapDegradeHorizonParams` join the redraw watcher (they are read
  during drawing, which a settled map skips);
  `mapLabelFreeMargins` is copied into `Renderer.labelFreeMargins`
  by the renderer watcher (previously copied once at renderer
  construction); `mapMetricUnits` and `mapLanguage` get a watcher
  calling the new `LegacyMap.refreshGeodataStylesheets`, which
  re-sends each free layer's stylesheet to its geodata processor
  and bumps `geodataCounter`, so the worker rebuilds label text
  with the current units and language.
- The runtime subset is now 58 keys, each verified live: covered
  by a watcher with the required side effect, or read from the
  store's value map at time of use (per input event, per frame,
  per loader run, or per search query).

Compile-time factory tests join `test/types/viewer-api.ts`: a
valid mixed bag is accepted; a misspelled option, a wrong-typed
value, an internal-only key, and a debug key each fail to compile.
Unit tests pin the demotions and catalogue removals.

Validation: `npx tsc` clean on all three configs; 37 unit tests;
the three regression URLs render correctly with no console or
network errors; live probes on a settled map confirmed the units
toggle rebuilding every label (`12461 ft` → `3798 m`), a
`mapTexelSizeFit` change redrawing at coarser detail, and the
accessor round-trips and throws unchanged.

---

## Addendum — 2026-07-12 — factory runtime guard, MapOptions shape

The third review round raised two findings: JavaScript factory
typos still failed silently (the typed bag does not constrain
untyped callers), and `MapOptions` contradicted its own
documentation by rejecting the README's string-style form and by
requiring `position`. Addressed:

- `publicConstructionConfigKeys` is a runtime `const` array,
  parallel to `publicRuntimeConfigKeys`, and
  `PublicConstructionConfig` is derived from it.
- `map()` validates its options bag before construction:
  `assertCataloguedConfigKeys` throws for any key that is not in
  the config catalogue after alias resolution. This deviates from
  the review's proposition to validate against the construction
  set, for a verified reason: the documented
  `map({ options: runtimeOptionsFromUrl() })` pattern carries
  catalogued internals — every `test/urls.json` template sets
  `mapExposeFpsToWindow` — so a construction-set guard would break
  the required test URLs. The review's failing cases (misspelled
  and invented keys) throw either way, which closes the
  inconsistency with `setParam`.
- `runtimeOptionsFromUrl` keeps catalogued keys only: query strings
  carry arbitrary parameters, and the result feeds the strict
  factory. Six dead URL vocabulary entries with no consumer in the
  tree are removed (`screenshot`, `sync`, `syncServer`, `syncId`,
  `debugShader`, `debugHeightmap`).
- The deprecated `browser()` factory stays permissive, as the
  compatibility side of the decided split.
- `MapOptions.style` is `string | MapStyle.StyleSpecification`,
  matching its JSDoc, the README example, and
  `Map.loadMapFromStyle`; `MapOptions.position` is optional (the
  load path picks a default). `Viewer.Config.style` matches.
- Tests: the compile-time suite gains the README construction form
  and a rejected non-style value; unit tests pin the guard
  (misspelled and invented keys throw, catalogued internals and
  aliases pass); a live probe confirms the factory throw and the
  URL filtering.

Validation: `npx tsc` clean on all three configs; 38 unit tests;
the three regression URLs render correctly with no console or
network errors; a live probe confirmed both factory throw cases
and `runtimeOptionsFromUrl` dropping unknown query parameters
while keeping catalogued keys and aliases.

---

## Addendum — 2026-07-12 — own-property lookups, top-level guard

The fourth review round found one blocker and one gap; the blocker
reproduced exactly as reported.

- `canonicalConfigKey` used `key in keyAliases` and
  `key in normalizers`, so inherited object-property names
  (`toString`, `constructor`, `__proto__`, `hasOwnProperty`) were
  treated as catalogued keys. The factory guard accepted them and
  `normalizeConfigValue` then crashed calling the inherited value
  as a normalizer. Both lookups now use an own-property check
  (`Object.prototype.hasOwnProperty.call`; `Object.hasOwn` is
  unavailable under the es2020 lib target). The same defect class
  existed in `url-config.ts`, where `KEY_ALIASES[rawKey] ||
  rawKey` resolved a `toString` query key to the inherited
  function; it uses the own-property check as well. The four names
  are unit-tested to resolve to `null` and to throw the public
  unknown-key error from the factory guard.
- `map()` now validates its top-level keys against the complete
  public shape (`container`, `style`, `position`, `options`,
  `transformRequest`, `interactive`) before reading the object, so
  a misspelled top-level key such as `postion` throws instead of
  silently falling back to the default. All eight `map()` callers
  in the repository pass keys within this set. `browser()` remains
  permissive as the deprecated compatibility factory.

Validation: `npx tsc` clean on all three configs; 39 unit tests;
the three regression URLs render correctly with no console or
network errors; a live probe confirmed the `constructor` options
key and the `postion` top-level key both throwing, with the
earlier typo, invented-key, and URL-filtering behavior unchanged.

---

## Review round 6 — requested

The design body is edited after implementation; status returns to
`In review` per the RFC protocol. The change: §4.2's authority
sentence now defers to the new §4.5, which collapses the per-key
configuration artifacts into a single spec catalogue, and §6
gains steps 7–10. Documenting every option (step 10) is part of
the implementation scope. Motivation and evidence:

- After steps 1–6, a config key is declared in up to five places:
  the `ViewerConfig` interface, `defaultViewerConfig()`, the
  `normalizers` table, a public-subset key array, and a
  `url-config.ts` key-type set.
- The catalogue default and the normalizer's invalid-input
  fallback disagree for 29 of the 146 keys. The fallbacks mirror
  the legacy switch defaults by design (per the `normalizers`
  table's own comment); the divergence list was produced by
  comparing `defaultViewerConfig()` against
  `normalizeConfigValue(key, invalid)` for every key over the
  compiled unit build:

  | Key | Default | Legacy fallback |
  |---|---|---|
  | `sensitivity` | [1, 0.06, 0.05] | [1, 0.12, 0.05] |
  | `inertia` | [0.81, 0.9, 0.7] | [0.85, 0.9, 0.7] |
  | `controlSpace` | true | false |
  | `controlSearch` | true | false |
  | `controlSearchFilter` | false | true |
  | `controlFullscreen` | false | true |
  | `minViewExtent` | 20 | 100 |
  | `mapCache` | 1100 | 900 |
  | `mapGPUCache` | 600 | 360 |
  | `mapDownloadThreads` | 20 | 6 |
  | `mapMaxProcessingTime` | 10 | 50 |
  | `mapMobileModeAutodect` | true | false |
  | `mapMobileDetailDegradation` | 0 | 2 |
  | `mapPreciseCulling` | true | false |
  | `mapBasicTileSequence` | false | true |
  | `mapPreciseBBoxTest` | false | true |
  | `mapXhrImageLoad` | true | false |
  | `mapSortHysteresis` | true | false |
  | `mapFeatureStickMode` | [1, 1] | [0, 1] |
  | `map16bitMeshes` | true | false |
  | `mapIndexBuffers` | true | false |
  | `mapFeatureGridCells` | 31 | 0 |
  | `mapFeaturesReduceMode` | 'scr-count7' | 'scr-count4' |
  | `mapDMapMode` | 3 | 1 |
  | `mapDegradeHorizon` | false | true |
  | `mapDegradeHorizonParams` | [1,1500,97500,3500] | [1,3000,15000,7000] |
  | `mapDefaultFont` | the noto.fnt CDN URL | '' |
  | `mapMetricUnits` | false | true |
  | `mapLabelFreeMargins` | [30, 30, 30, 30] | [0, 0, 0, 0] |

  `mapSplitSpace` also differs under this probe, but its
  normalizer is the identity pass-through for the unchecked
  legacy payload, not a fallback; it is excluded. `mapLanguage`
  additionally falls back to `'en'` where its default is
  navigator-derived; under the one-value rule its fallback
  becomes the navigator-derived default.

- Feasibility is verified on a standalone prototype compiled with
  the repository's TypeScript in strict mode: the derived
  `ViewerConfig` preserves exact value types including tuples;
  visibility filtering yields exact key unions at the type level;
  `normalizeConfigValue` keeps its per-key return type; and a
  language-service probe confirms the doc comment on a catalogue
  entry appears when hovering the derived `ViewerConfig` and
  public-subset properties.

Decision points for the reviewer:

- Invalid-write semantics: §4.5 adopts default-as-fallback.
  The alternative (reject the write, keep the current value)
  changes `setParam` behavior and is not adopted.
- Whether the step-8 assertion pinning the 58-key runtime subset
  stays after the migration or is dropped once the catalogue
  lands.

---

## Review round 6

Not signed off. The catalogue is a sound replacement for the five
parallel declarations, and the prototype establishes that the mapped
types and documentation propagation are feasible. Four details need
resolution before the design is complete.

1. The default representation does not cover all current dynamic
   defaults. `defaultViewerConfig()` computes three values from the
   environment: `mapLanguage` and `mapMetricUnits` from the browser
   language, and `mapAsyncImageDecode` from `createImageBitmap`
   availability. Section 4.5 mentions a guarded helper only for
   `mapLanguage`. A static value stored in each spec cannot preserve
   the other two, or make their invalid-input fallback equal to the
   value selected for that store. Specify whether a spec holds a
   default factory, or another mechanism that evaluates all three
   environment-dependent defaults once per store and reuses the
   selected values during normalization. Blocker.

   *Author: implemented. §4.5 now specifies that every spec stores
   its default as a producer function; the three
   environment-dependent keys pass explicit factories reading the
   browser language and `createImageBitmap` availability. A
   per-store snapshot is not adopted: the environment reads are
   pure and stable within a session, so a producer evaluated at
   normalization time yields the value selected at store
   construction. The current `mapAsyncImageDecode` normalizer
   already re-probes `createImageBitmap` on every call
   (`viewer-config.ts`); the producer mechanism generalizes that
   pattern to all three keys.*

2. Collecting defaults from a module-level catalogue can share mutable
   arrays between viewers. The current `defaultViewerConfig()` creates
   fresh tuples and arrays on each call, while `ConfigStore` clones
   only the top-level object and exposes array values by reference
   through `get()`, `values`, and `Viewer.getParam()`. The catalogue
   contains array defaults for `sensitivity`, `inertia`, `autoPan`,
   `mapFeaturesReduceParams`, and several other keys. Define per-store
   allocation or cloning for mutable defaults, including the value
   returned as an invalid-input fallback, so one viewer or caller
   cannot mutate another viewer's configuration. Blocker.

   *Author: implemented, by the same producer mechanism as note 1.
   Spec constructors copy array and tuple defaults on every
   production — both when `defaultViewerConfig()` assembles a
   store's initial values and when a normalizer returns a
   fallback — so no allocation is shared between stores. The
   `ConfigStore` shallow copy and by-reference reads are
   unchanged; the guarantee added is per-store ownership of every
   default and fallback allocation.*

3. The example changes valid-path behavior. The current
   `mapMetatileCache` normalizer is `num(10, MAX, 60)`, but the proposed
   entry is `num(10, 4000, 60)`. That would clamp every valid value
   above 4000 despite the statement that valid-path behavior is
   unchanged. Use the existing upper bound in the example, or use an
   example whose complete spec matches the implementation. Blocker.

   *Author: implemented. The example now shows the live spec
   `num(10, MAX, 60)`. The 4000 bound was an invented example
   value, not a proposed change; no bound changes are part of this
   revision.*

4. The default-as-fallback rule is not total over the current
   normalizers. `geojsonStyle` calls `JSON.parse()` for a string, so
   malformed JSON throws instead of returning its `null` default.
   The URL layer's `parseJson()` likewise throws before normalization.
   Decide whether malformed JSON is deliberately an error, in which
   case §4.5 must narrow its claim, or whether both paths catch the
   parse failure and return the catalogue default. The catalogue
   consolidation alone does not establish the stated behavior.
   Blocker.

   *Author: implemented, with a boundary split. Programmatic
   normalization keeps the throw for a malformed `geojsonStyle`
   JSON string — current behavior, and consistent with the typed
   boundary's unknown-key throw. The URL layer catches the parse
   failure and drops the parameter, consistent with its permissive
   contract of silently filtering unknown keys; the current abort
   of startup on a malformed JSON query parameter is corrected in
   step 9. §4.5 now states the exception explicitly, so the
   default-as-fallback claim is narrowed rather than total.*

The step-8 58-key assertion should remain as a compile-time public-API
contract, preferably in the type-test suite rather than as production
derivation data. The catalogue remains the source used to construct
the subset; the assertion independently prevents an incidental
visibility edit from changing the audited public surface without an
explicit test update.

*Author: implemented. Step 8 now states the assertion lives in the
type-test suite and remains after the migration as the public-API
contract.*

---

## Review round 7 — sign-off

All round-6 notes are resolved. Default producers now cover all three
environment-dependent values and allocate fresh array and tuple defaults
for each store and each fallback. The `mapMetatileCache` example uses the
live `MAX` upper bound. The default-as-fallback rule explicitly excludes
malformed programmatic `geojsonStyle` JSON, while step 9 gives malformed
URL JSON the URL layer's permissive drop behavior. The 58-key assertion
remains in the type-test suite as an independent contract for the derived
public runtime surface. Design accepted.

---

## Addendum — 2026-07-13 — steps 7–10 implemented

The single-source catalogue of §4.5 is implemented. Each of the 146
keys is one entry in the `catalogue` object in
`src/core/viewer-config.ts`, carrying its doc comment, producer
default, normalizer, URL parse kind, and visibility class.
Everything else derives from it: `ViewerConfig` (a mapped type over
the producers' return types; doc comments propagate to the derived
properties), `defaultViewerConfig()`, `normalizeConfigValue`, both
public subset types and key arrays (visibility-filtered at the type
level and at runtime), and the new `urlParseKind()` consumed by
`url-config.ts`, whose five hand-written key-type sets are deleted.
Every key is documented (step 10); keys with no live consumer say
so explicitly instead of inventing behavior.

Reconciliations (step 7) — one value per key, the catalogue default
winning over the divergent legacy switch fallback, as accepted in
round 6: `sensitivity`, `inertia`, `controlSpace`, `controlSearch`,
`controlSearchFilter`, `controlFullscreen`, `minViewExtent`,
`mapCache`, `mapGPUCache`, `mapDownloadThreads`,
`mapMaxProcessingTime`, `mapMobileModeAutodect`,
`mapMobileDetailDegradation`, `mapPreciseCulling`,
`mapBasicTileSequence`, `mapPreciseBBoxTest`, `mapXhrImageLoad`,
`mapSortHysteresis`, `mapFeatureStickMode`, `map16bitMeshes`,
`mapIndexBuffers`, `mapFeatureGridCells`, `mapFeaturesReduceMode`,
`mapDMapMode`, `mapDegradeHorizon`, `mapDegradeHorizonParams`,
`mapDefaultFont`, `mapMetricUnits`, `mapLabelFreeMargins`; plus the
two environment-conditional fallbacks, `mapLanguage` (browser
language instead of `'en'`) and `mapAsyncImageDecode`
(`createImageBitmap` availability instead of `false`). All fire on
invalid input only.

Deviations from the accepted design:

- The visibility parameter on the spec constructors is required,
  not optional as the §4.5 example sketch implied. An omitted
  visibility cannot silently default a key into a public surface.
- The step-8 assertion is implemented as a type-level equality pin
  on `keyof PublicRuntimeConfig` in `test/types/viewer-api.ts`
  (per the round-6 reviewer note), plus runtime size pins (58 and
  71 keys) in the unit suite.
- Spec-driven URL parsing covers catalogued keys that the deleted
  hand-written sets missed, so these now parse from query strings
  instead of arriving as raw strings that normalized to defaults:
  `interactive`, `autoRotate`, `autoPan`, `rendererCssDpi`,
  `mapMaxHiresLodLevels`, `mapLoadErrorRetryTime`,
  `mapLoadErrorMaxRetryCount`, `mapSplitMargin`,
  `mapTraversalMaskResolution`, `mapSmartNodeParsing`,
  `mapNoTextures`, `mapNoNormalMaps`, `mapFeaturesReduceFactor`,
  `mapFeaturesReduceFactor2`. Uncatalogued `debug*`-prefixed query
  keys lose their string parse; they were discarded by the
  catalogue filters either way.

Size: `viewer-config.ts` went from 944 to 1169 lines while gaining
a doc comment on every key; `url-config.ts` shrank from 308 to 174.
The five per-key declaration sites are one.

Validation: `npx tsc` clean on the typecheck, unit, and types
configs; 44 unit tests, including the reconciled fallbacks, fresh
allocations per store and per fallback, the `geojsonStyle` throw,
and the URL kind resolution; the `simple-terrain`,
`complex-terrain`, and `full-terrain` URLs render correctly on a
freshly restarted dev server with no console or network errors; a
live probe confirmed a malformed `geojsonStyle` query parameter is
dropped (startup completes with no page errors), `mapFlagLighting=1`
parses to `true`, the `mapCache` fallback returns 1100, clamping
and the unknown-key, non-public-key, and alias throws are
unchanged, and stored fallback arrays are not shared between
writes.

---

## Addendum — 2026-07-13 — URL drop warning for config-prefixed keys

A misspelled config key in a query string
(`mapStructuralDescentBreak=0.5`) was dropped with no trace on
every URL path: `runtimeOptionsFromUrl` filters uncatalogued keys
before the strict factory guard can see them, so the `map()` typo
throw never fires for URL input. Silence is still right for the
shared query-string namespace (analytics tags, application
parameters), but not for keys that carry a config prefix.

`runtimeOptionsFromUrl` now logs a console warning for a dropped
uncatalogued key starting with `map`, `renderer`, `control`, or
`debug`, and keeps dropping it. Other unknown keys stay silent.
`mapConfig` joins the structural exclusion set — it is the query
parameter the demo applications read themselves — so legacy-style
URLs do not warn. `url-config.ts` joins the unit build; the new
suite pins the warning, the silent drops, the structural
exclusions, the `zoomAlowed` alias, and the malformed-JSON drop.

Validation: `npx tsc` clean on all three configs; 50 unit tests; a
live probe on a demo URL carrying the misspelled key and
`utm_source` showed exactly one warning naming the misspelled key
and no page errors.
