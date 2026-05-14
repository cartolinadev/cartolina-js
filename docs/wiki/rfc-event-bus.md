# RFC: event bus — extraction and redesign

**Status:** Accepted — ready to implement
**Context:** event bus section in [architecture.md](architecture.md);
`core.js` suppression track in [backlog.md](backlog.md)

---

## 1. Problem

The event bus is implemented as prototype methods on `Core`
(`src/core/core.js`): `on`, `once`, `callListener`, `removeListener`,
backed by a flat `this.listeners` array. `Core` is a legacy ES5 object
scheduled for dissolution into `Map` and other TypeScript modules. The
bus must move out before `core.js` can be deleted.

The move is also an opportunity to fix defects in the current
implementation:

- `Core.once()` does not forward the unsubscribe function returned by
  `Core.on()`. Every call site expecting a cancellation token gets
  `undefined`. `getSurfaceAreaGeometry` (`interface.js:273`) relies on
  this return value and silently cannot cancel its retry listener.
- `Browser.kill()` registers listeners at construction but stores no
  unsubscribe closures and removes none. After `kill()`, those listeners
  remain in the array and dispatch into dead callbacks until `Core` is
  garbage-collected.
- All event payloads are typed `unknown` in `CoreEventMap`. Every
  consumer must cast or ignore types.
- Six browser-layer events (`autorotate-changed`, `fly-start`,
  `fly-final-phase`, `fly-progress`, `fly-end`, `loading-screen-hidden`)
  and three position-gesture events (`map-position-panned/rotated/zoomed`)
  are emitted via `Browser.callListener` → `Core.callListener` directly,
  bypassing `CoreEventMap` and the typed public API.
- `callListener` scans the entire flat array for every emit. With many
  listeners across many event types, each high-frequency `tick` emit
  visits every record regardless of how many are `tick` listeners.
- The `wait` mechanism — an integer countdown that skips the first N
  firings — is an undocumented workaround with two known call sites that
  each require separate analysis before removal.

### Where the bus should live after Core is gone

`Core`'s ownership of the bus is incidental; `Core` owns it only because
the bus was originally implemented there. The bus is not a coordinator
concern — it is a shared communication channel used by `LegacyMap`,
`GpuDevice`, `Browser`, and the public `Viewer` API.

The right owner after the migration is `Map`. `Map` already exposes
`on()` / `once()` and `Map` constructs `Core`, which means `Map` can
pass the bus to `Core` at construction without any new forwarding method
on `Core`. Moving the bus directly onto `Map` also removes the
`core_.on(...)` indirection that the current `Map` methods carry.

---

## 2. Event inventory

All events are public — accessible via `Viewer.on()`. The current split
between `CoreEventMap` events and events emitted only via
`Browser.callListener` is an implementation accident, not a policy
decision. All events belong in the typed map.

The type is currently named `CoreEventMap`. Once the bus moves to `Map`,
the name is a misnomer; renaming to `ViewerEventMap` is tracked in the
open questions.

### Currently in `CoreEventMap`

| Event | Source | Frequency |
|---|---|---|
| `map-mapconfig-loaded` | `Core.loadMap()` — legacy mapConfig path | once |
| `map-loaded` | `Core.onUpdate()` — first `srsReady` frame | once |
| `map-unloaded` | `Core` unload path | rare |
| `map-update` | `LegacyMap.update()` — every tile tree pass | high |
| `map-position-changed` | `LegacyMap` — camera move | medium |
| `map-position-fixed-height-changed` | `LegacyMap` — terrain height | medium |
| `tick` | `Core.onUpdate()` — every rAF frame | 60 Hz |
| `gpu-context-lost` | `GpuDevice` via `renderer.core.callListener` | rare |
| `gpu-context-restored` | `GpuDevice` via `renderer.core.callListener` | rare |
| `geo-feature-enter` | `LegacyMap` — cursor enters feature | medium |
| `geo-feature-leave` | `LegacyMap` — cursor leaves feature | medium |
| `geo-feature-hover` | `LegacyMap` — cursor over feature | medium |
| `geo-feature-click` | `LegacyMap` — feature clicked | low |

### Emitted via `Browser.callListener`, not yet in `CoreEventMap`

All of these are promoted into the typed map by this RFC.

| Event | Source | Known consumer |
|---|---|---|
| `map-position-panned` | `map-observer.js` | `Browser.onMapPositionPanned` |
| `map-position-rotated` | `map-observer.js` | `Browser.onMapPositionRotated` |
| `map-position-zoomed` | `map-observer.js` | `Browser.onMapPositionZoomed` |
| `autorotate-changed` | `autopilot.js` | none found in codebase |
| `fly-start` | `autopilot.js` | none found in codebase |
| `fly-final-phase` | `autopilot.js` | none found in codebase |
| `fly-progress` | `autopilot.js` | none found in codebase |
| `fly-end` | `autopilot.js` | `demos/waypoint/waypoint.js` via `viewer.on` |
| `loading-screen-hidden` | `loading.js` | none found in codebase |

### Dead

`positionchanged` — subscribed in `explore-bar.js`, never emitted.
Remove.

---

## 3. The `wait` mechanism

`Core.once(name, listener, wait)` attaches a countdown to a listener
record. For each firing of the named event while `wait > 0`, the counter
decrements and the listener is skipped. It fires on the next event after
the counter reaches zero.

There are two call sites.

**`getSurfaceAreaGeometry` (`interface.js:273`)** registers
`once('map-update', retry, 1)` when tile meshes are not yet loaded.
The `wait=1` skips one `map-update`. The reason: this call often
originates from inside a `map-update` handler. The current
`callListener` iterates the live `listeners` array, so a record
appended mid-iteration would be visited in the same pass — delivering
the retry on the update that just reported the data was missing.

Any bus that snapshots the active listener set at the start of each emit
makes this impossible: a listener registered during event X cannot
receive event X. `wait=1` is then unnecessary, and the call site
simplifies to `once('map-update', retry)`.

**`measure.js` (`src/browser/ui/control/measure.js:612, 620`)** uses
`once('tick', traceVolumeLine, 1)` to spread a volume calculation across
frames. `traceVolumeLine` is a step function that reschedules itself each
time it runs. Tracing the execution with the current live-array dispatch:
`traceVolumeLine` fires on tick N and registers `once('tick',
traceVolumeLine, 1)`. `callListener` continues iterating, finds the new
record mid-pass, decrements `wait` from 1 to 0, and skips it without
firing. On tick N+1 the record fires. The computation runs once per tick.

With snapshot dispatch and no `wait`: the reschedule registration is not
in the snapshot, so tick N ends without a second call. Tick N+1 fires.
Same once-per-tick rate. `wait=1` at both call sites is the
mid-dispatch workaround — not a rate limiter — and can be removed
alongside `getSurfaceAreaGeometry`.

---

## 4. Alternatives

### 4A. Native `EventTarget` — `Viewer` as an `EventTarget`

`Viewer` extends `EventTarget`. Callers use the standard DOM API:

```ts
viewer.addEventListener('map-loaded', handler);
viewer.removeEventListener('map-loaded', handler);

// one-shot:
viewer.addEventListener('map-loaded', handler, { once: true });

// lifecycle-scoped cleanup:
const ac = new AbortController();
viewer.addEventListener('map-loaded', handler, { signal: ac.signal });
ac.abort(); // removes the listener
```

Internally, `Map.emit(name, payload)` calls
`dispatchEvent(new CustomEvent(name, { detail: payload }))`.

**Gains**

- Standard browser API — no dispatch code to maintain.
- Browser DevTools show listeners in the Elements inspector.
- `AbortController` makes scope-bound cleanup explicit and readable.
- `{ once: true }` is built in.
- `EventTarget` subclassing works in all target browsers today (Chrome
  64+, Firefox 59+, Safari 14+).

**Costs**

*API shape mismatch.* `addEventListener` returns `void`. The
unsubscribe-closure pattern used across `Viewer`, `Browser`, demos, and
`interface.js` must all become either `{ signal }` or explicit
`removeEventListener` calls that require the caller to hold a stable
function reference. This is a mechanical change at every call site.

*Payload in `.detail`.* Callbacks receive a `CustomEvent` whose payload
is in `.detail`. Every listener body changes from `e.position` to
`e.detail.position`. TypeScript typing requires overloading
`addEventListener` for each event name, or a declaration-merge table;
payload types do not flow from a plain string name without that
machinery.

*`CustomEvent` allocation on every emit.* `tick` fires at 60 Hz,
`map-update` on every tile-tree pass. Each emit allocates one
`CustomEvent` object (plus its `detail` object if the payload is not
primitive). At 60 Hz over a 10-minute session, `tick` alone accounts for
~36 000 `CustomEvent` allocations. Short-lived objects are inexpensive
for modern GC, but the pressure is constant and unnecessary — no listener
needs the `Event` wrapper fields (`bubbles`, `cancelable`, `target`,
`timeStamp`, etc.).

*Diverges from the MapLibre reference API.* MapLibre GL JS uses a
hand-rolled `Evented` class with `on(type, listener)` /
`off(type, listener)` / `fire(type, data)`. Making cartolina-js callers
use `addEventListener` / `removeEventListener` moves away from the
reference ergonomics.

**Verdict: rejected.** The existing `on()` / unsubscribe-closure surface
is established at every call site; `addEventListener` is a breaking
change to that contract. The `CustomEvent` allocation at 60 Hz and the
`.detail` indirection are additional costs with no compensating gain for
an internal event bus.

---

### 4B. `EventTarget` internally, `on()`/`off()` externally

Keep the `on()`/`once()` surface. Back it with an `EventTarget` instance
hidden inside `Map`. Each `on()` call creates a wrapper closure and
registers it with `addEventListener`; `on()` returns a closure that calls
`removeEventListener` with the wrapper.

```ts
on(name, cb) {
    const wrapped = (e: CustomEvent) => cb(e.detail);
    this.target_.addEventListener(name, wrapped);
    return () => this.target_.removeEventListener(name, wrapped);
}

emit(name, payload) {
    this.target_.dispatchEvent(
        new CustomEvent(name, { detail: payload }));
}
```

**Gains**

- Preserves the `on()` / unsubscribe return API.
- The browser's native dispatch machinery handles listener storage.

**Costs**

- One wrapper closure allocation per `on()` call (to bridge `.detail`).
- One `CustomEvent` allocation per `emit()` call — same problem as 4A.
- No net reduction in maintained code: the wrapper layer *is* the bus.

**Verdict: rejected.** Inherits the allocation cost of 4A without the
API-surface benefit. It is the worst of both approaches.

---

### 4C. Standalone typed `EventBus<EventMap>` class

A small TypeScript class owned by `Map`. Callers use the same
`on()` / `once()` surface. `LegacyMap` and `GpuDevice` receive the bus
instance directly at construction and call `this.bus.emit(...)`.

```ts
// src/core/event-bus.ts

type Listener<T> = (event: T) => void;
interface Record_<T> { listener: Listener<T>; once: boolean; }

class EventBus<M extends object> {

    private sets_: { [K in keyof M]?: Set<Record_<M[K & keyof M]>> }
        = Object.create(null);

    on<K extends keyof M & string>(
        name: K,
        fn: Listener<M[K]>,
    ): () => void {

        const set = (this.sets_[name] ??= new Set());
        const rec: Record_<M[K]> = { listener: fn, once: false };
        set.add(rec);
        return () => set.delete(rec);
    }

    once<K extends keyof M & string>(
        name: K,
        fn: Listener<M[K]>,
    ): () => void {

        const set = (this.sets_[name] ??= new Set());
        const rec: Record_<M[K]> = { listener: fn, once: true };
        set.add(rec);
        return () => set.delete(rec);
    }

    emit<K extends keyof M & string>(name: K, event: M[K]): void {

        const set = this.sets_[name];
        if (!set || set.size === 0) return;

        for (const rec of [...set]) {
            if (rec.once) set.delete(rec);
            rec.listener(event);
        }
    }
}
```

Properties:

- `on()` and `once()` both return an unsubscribe function.
- `emit` returns immediately with zero allocation when no listeners are
  registered for the named event.
- Dispatch is O(listeners for this event type), not O(all listeners).
- Snapshot-at-dispatch: the `[...set]` spread copies the active listener
  set before iteration. Listeners registered during the current emit do
  not receive it; listeners removed during the current emit are still
  called if they were in the snapshot.
- `once` records are deleted from the set before the listener is called,
  so a throwing listener does not prevent its own removal.
- One listener throwing aborts the remaining listeners in the same emit
  call — the exception propagates out of `emit`. This matches the
  current `callListener` behavior. Exception isolation (try/catch per
  listener) is left as an open question.

**Verdict: recommended.**

---

## 5. Performance comparison

| Metric | Current | 4A (`EventTarget`) | 4C (`EventBus`) |
|---|---|---|---|
| `emit` with 0 listeners | O(n) scan, 0 allocs | 1 `CustomEvent` alloc | 0 allocs |
| `emit` with k listeners | O(n) scan | 1 `CustomEvent` alloc | 1 array alloc |
| Dispatch per event type | O(total listeners) | O(listeners for type) | O(listeners for type) |
| `on()` cost | 1 closure | 1 closure + 1 wrapper | 1 closure + 1 record |
| Maintained dispatch code | 40 lines JS | 0 | ~40 lines TS |

The zero-listener case matters most: `tick` and `map-update` are emitted
at high frequency and often have no listeners registered. The current
implementation scans all registered listeners (across all event types)
on every emit. `EventBus` exits immediately. `EventTarget` allocates a
`CustomEvent` regardless.

For the one-listener case, `EventBus` allocates one small spread array
per emit. V8 optimises same-shape short-lived arrays; this should not be
measurable at 60 Hz. `EventTarget` allocates a `CustomEvent` and a
`detail` wrapper object — roughly 200 bytes each, ~36 000 objects per
10-minute session for `tick` alone. On memory-constrained mobile devices
this adds GC pressure that the other approaches avoid.

---

## 6. Proposed design

### 6.1 Module and ownership

`EventBus<ViewerEventMap>` is implemented in `src/core/event-bus.ts`
and instantiated by `Map` (`src/core/map.ts`):

```ts
class Map {
    private bus_: EventBus<ViewerEventMap> = new EventBus();

    on<K extends keyof ViewerEventMap & string>(
        name: K,
        fn: (e: ViewerEventMap[K]) => void,
    ): () => void {
        this.assertAlive_();
        return this.bus_.on(name, fn);
    }

    once<K extends keyof ViewerEventMap & string>(
        name: K,
        fn: (e: ViewerEventMap[K]) => void,
    ): () => void {
        this.assertAlive_();
        return this.bus_.once(name, fn);
    }

    /** @internal */
    emit<K extends keyof ViewerEventMap & string>(
        name: K,
        event: ViewerEventMap[K],
    ): void {
        this.bus_.emit(name, event);
    }
}
```

`Map` constructs `Core` and passes the `EventBus` instance at
construction time. `Core` stores it as `this.bus` and calls
`this.bus.emit(...)` for the events it still owns (`tick`, `map-loaded`,
`map-unloaded`, `map-mapconfig-loaded`). As those responsibilities are
absorbed into `Map`, the `Core.bus` field disappears with them.

`LegacyMap` and `GpuDevice` also receive the bus at construction time
from `Core` and `Renderer` respectively, replacing their
`this.core.callListener(...)` call sites with `this.bus.emit(...)`. No
new methods are added to `Core`.

`Viewer.on()` and `Viewer.once()` delegate to `this.map_.on()` /
`this.map_.once()` as today. `Viewer.once()` return type changes from
`void` to `() => void`.

### 6.2 Typed payloads

`CoreEventMap` in `src/core/types.ts` is renamed `ViewerEventMap`. Known
payload fields are given concrete types; `unknown` remains only where the
source is still untyped ES5 and cannot be verified without migrating that
file. The autopilot and loading events, previously invisible to the public
API, are added:

```ts
export interface ViewerEventMap {
    'map-mapconfig-loaded': Record<string, unknown>;
    'map-loaded': { browserOptions: Record<string, unknown> };
    'map-unloaded': Record<string, never>;
    'map-update': Record<string, never>;
    'map-position-changed': {
        position: number[];
        'last-position': number[];
    };
    'map-position-fixed-height-changed': {
        height: number;
        'last-height': number;
    };
    'map-position-panned': Record<string, never>;
    'map-position-rotated': Record<string, never>;
    'map-position-zoomed': Record<string, never>;
    'tick': Record<string, never>;
    'gpu-context-lost': Record<string, never>;
    'gpu-context-restored': Record<string, never>;
    'geo-feature-enter': GeoFeatureEvent;
    'geo-feature-leave': GeoFeatureEvent;
    'geo-feature-hover': GeoFeatureEvent;
    'geo-feature-click': GeoFeatureEvent;
    'autorotate-changed': { autorotate: number };
    'fly-start': { startPosition: unknown; endPosition: unknown };
    'fly-final-phase': { position: unknown };
    'fly-progress': { position: unknown; progress: number };
    'fly-end': { position: unknown };
    'loading-screen-hidden': Record<string, never>;
}

export interface GeoFeatureEvent {
    feature: unknown;           // typed once LegacyMap migrates to TS
    'canvas-coords': number[];
    'world-coords': number[];
}
```

Autopilot payload fields are typed `unknown` where they originate from
untyped ES5 objects; they will be tightened when `autopilot.js` migrates.

### 6.3 Fixes bundled with the extraction

- `Browser.kill()` stores all unsubscribe closures returned at
  construction and calls each on teardown. The count is not fixed;
  the array is drained in full regardless of how many were registered.
- All browser-layer events are emitted via `map.emit(...)` instead of
  the `Browser.callListener` → `Core.callListener` reach-through.
- The dead `positionchanged` subscription in `explore-bar.js` is removed.
- `wait` is removed from `Core.once`, `Map.once`, and `Viewer.once`.
  Both `getSurfaceAreaGeometry` and the `measure.js` `traceVolumeLine`
  reschedule are updated to use `once` without `wait`. Both use `wait=1`
  only as a mid-dispatch workaround; snapshot dispatch makes it
  unnecessary at both sites without changing computation rate.

---

## 7. Implementation steps

1. Write `EventBus<M>` in `src/core/event-bus.ts`. Unit-test
   snapshot-at-dispatch, `once` auto-removal, and unsubscribe.
2. Rename `CoreEventMap` to `ViewerEventMap` in `src/core/types.ts`.
   Add all missing events. Type known payload fields; leave `unknown`
   where the source is still untyped ES5.
3. Add `bus_: EventBus<ViewerEventMap>` to `Map`. Implement `Map.on()`,
   `Map.once()`, `Map.emit()` delegating to `bus_`. Change return types
   of `Map.once()` and `Viewer.once()` to `() => void`.
4. Pass the bus to `Core` at construction. Replace `Core.on` /
   `Core.once` / `Core.callListener` / `Core.removeListener` with
   direct `this.bus.emit(...)` calls at the emission sites. Remove the
   `listeners` array and `listenerCounter` from `Core`.
5. Pass the bus to `LegacyMap` and `GpuDevice` at construction.
   Replace `this.core.callListener(...)` call sites with
   `this.bus.emit(...)`.
6. Remove `wait` from `Core.once`, `Map.once`, `Viewer.once`.
   Update `getSurfaceAreaGeometry` and `measure.js` `traceVolumeLine`
   to use `once` without `wait`.
7. Reroute all `Browser.callListener(...)` emission sites through
   `map.emit(...)`.
8. Fix `Browser.kill()` to store and drain all unsubscribe closures.
9. Remove the `positionchanged` subscription in `explore-bar.js`.
10. Run screenshot regression tests.

---

## 8. Open questions

**Exception isolation in `emit`.** One listener throwing currently aborts
remaining listeners in `callListener`. The new `EventBus.emit` has the
same behaviour. Wrapping each call in try/catch gives isolation but hides
errors. Decide whether to isolate before implementing step 1.

---

## 9. Reviewer notes

- The direction is sound: a typed `EventBus<EventMap>` owned by `Map`
  fits the `core.js` suppression track.

  *Author: accepted.*

- Clarify the temporary migration path while `Core` still emits `tick`,
  `map-loaded`, `map-unloaded`, and `map-mapconfig-loaded`. `Map`
  should own the bus; `Core` can receive it only as temporary wiring
  until those responsibilities move into `Map`.

  *Author: implemented. Section 6.1 now states that `Map` constructs
  `Core` and passes the bus at construction. `Core` stores it as
  `this.bus` and uses it directly; no forwarding method is added to
  `Core`.*

- The event inventory is incomplete. `Browser.callListener()` also emits
  `autorotate-changed`, `fly-start`, `fly-final-phase`, `fly-progress`,
  `fly-end`, and `loading-screen-hidden`. `fly-end` is used by
  `demos/waypoint/waypoint.js`.

  *Author: implemented. All six events added to the inventory table and
  to `ViewerEventMap` in section 6.2. Payload fields typed where the
  source is clear; `unknown` used where the origin is untyped ES5.*

- The `wait` section is incomplete. `getSurfaceAreaGeometry` is not the
  only use; `src/browser/ui/control/measure.js` also calls
  `core.once('tick', ..., 1)`.

  *Author: implemented. Section 3 now covers both call sites. The
  `measure.js` case is treated separately because removing `wait` there
  changes the computation rate, not just the dispatch semantics. It is
  tracked as an open question.*

- Define event policy explicitly: public core events, public
  browser/viewer events, internal-only events, and deleted events. The
  RFC currently promotes only three browser events without saying why
  the other browser events are excluded.

  *Author: partially accepted. A public/private event split is not
  adopted — all events are public and accessible via `Viewer.on()`. The
  inventory now includes all events and the promotion rationale is
  stated: the split was an implementation accident, not a policy.
  `positionchanged` is the only event marked for deletion.*

- Specify dispatch semantics: listener added during emit, listener
  removed during emit, `once` removal timing, and exception behavior.

  *Author: implemented. Section 4C now states all four behaviors
  explicitly. Exception isolation is left as an open question.*

- The sample type bound `EventBus<M extends Record<string, unknown>>`
  may reject named interfaces without a string index signature. Prefer
  `M extends object` plus `keyof M & string`.

  *Author: implemented. The class declaration and all method signatures
  in sections 4C and 6.1 use `M extends object` and
  `K extends keyof M & string`.*

- `Browser.kill()` should store and drain all unsubscribe closures, not
  rely on a fixed listener count.

  *Author: implemented. Section 6.3 and implementation step 8 now say
  the array is drained in full rather than assuming a fixed count.*

- Keep `EventTarget` rejected. The existing reasoning is adequate; the
  stronger reason is the API mismatch with the existing `on()` /
  unsubscribe-closure surface.

  *Author: accepted. The verdict in 4A leads with the API contract
  break.*

- Replace `Open questions: none` with the unresolved migration and
  event-surface questions above before moving the RFC out of draft.

  *Author: implemented. Section 8 now lists three open questions:
  `measure.js` computation rate, `ViewerEventMap` rename confirmation,
  and exception isolation policy.*

---

## 10. Review round 2

Not signed off yet. The major architecture concerns from round 1 are
addressed, but three points remain.

- Section 4C contradicts itself on exception behavior. It says one
  listener throwing does not stop others, then says exceptions propagate
  out of `emit` and abort the remaining listeners. Choose one behavior.
  Current `callListener` behavior is abort-on-throw.

  *Author: implemented. The contradiction is removed. Section 4C now
  states clearly that one listener throwing aborts the remaining
  listeners in the same emit call, matching current behavior. Exception
  isolation remains an open question.*

- Step 6 says to remove `wait` while deferring `measure.js`. That is not
  safe as written. If `measure.js` is deferred, `wait` cannot be removed
  globally unless a temporary compatibility path preserves its current
  every-other-tick behavior.

  *Author: implemented, with a correction to the underlying analysis.
  The `measure.js` `traceVolumeLine` runs once per tick — not every
  other tick. Tracing the live-array execution: `traceVolumeLine` fires
  on tick N, registers `once('tick', traceVolumeLine, 1)`, `callListener`
  finds the new record mid-pass, decrements `wait` to 0, and skips it
  without removing it; it fires on tick N+1. `wait=1` is the
  mid-dispatch workaround, not a rate limiter. With snapshot dispatch it
  is unnecessary at both call sites. `wait` is now removed globally in
  step 6 with no deferral. Section 3 updated with the corrected trace.
  The `measure.js` open question is closed.*

- Section 6.2 says all `unknown` payload entries are replaced with
  concrete types, but the proposed map still contains `unknown` for
  legacy payloads. That is acceptable, but the text should say known
  payloads are tightened and `unknown` remains only where the source is
  still untyped ES5.

  *Author: implemented. Section 6.2 introductory text now says known
  fields are given concrete types and `unknown` remains only where the
  source is untyped ES5.*

With those changes, the design is ready to implement.

---

## 11. Review round 3 — sign-off

Architecture and implementation direction signed off. Two editorial
cleanup comments, not design blockers.

- Step 2 still says "Replace all `unknown` payload entries" but section
  6.2 correctly keeps `unknown` for legacy ES5 payloads.

  *Author: fixed. Step 2 now says "type known payload fields; leave
  `unknown` where the source is still untyped ES5."*

- `ViewerEventMap` is listed as an open question but step 2 already
  commits to the rename. Either close the question or make step 2
  conditional.

  *Author: open question closed. Step 2 commits to the rename; no
  further confirmation needed.*
