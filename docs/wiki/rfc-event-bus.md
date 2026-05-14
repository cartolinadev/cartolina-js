# RFC: event bus — extraction and redesign

**Status:** Draft
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
- `Browser.kill()` registers 9 listeners at construction but stores no
  unsubscribe closures and removes none. After `kill()`, those listeners
  remain in the array and dispatch into dead callbacks until `Core` is
  garbage-collected.
- All event payloads are typed `unknown` in `CoreEventMap`. Every
  consumer must cast or ignore types.
- Three position-gesture events (`map-position-panned/rotated/zoomed`)
  are emitted via `Browser.callListener` → `Core.callListener` directly,
  bypassing `CoreEventMap` and the typed public API.
- `callListener` scans the entire flat array for every emit. With 9
  listeners across 13 event types, each high-frequency `tick` emit
  visits all 9 records regardless of how many are `tick` listeners.
- The `wait` mechanism — an integer countdown that skips the first N
  firings — is an undocumented workaround specific to one call site and
  should not travel to any new design.

### Where the bus should live after Core is gone

`Core`'s ownership of the bus is incidental; `Core` owns it only because
the bus was originally implemented there. `Core` is a coordinator object
being dissolved; its responsibilities are migrating to `Map`. The bus is
not a coordinator concern — it is a shared communication channel used by
`LegacyMap`, `GpuDevice`, `Browser`, and the public `Viewer` API.

The right owner after the migration is `Map`. `Map` already exposes
`on()` / `once()` and holds the `Core` reference through which the bus
is reached today. Moving the bus directly onto `Map` removes the
`core_.on(...)` indirection and means the bus object and its API live in
the same TypeScript class that callers already interact with.

---

## 2. Event inventory

### Public events (`CoreEventMap`)

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

### Browser-internal (not in `CoreEventMap`)

These are emitted via `Browser.callListener` → `Core.callListener`
directly, bypassing the typed public surface. They should be promoted
into `CoreEventMap` so `Viewer.on()` can access them.

| Event | Source |
|---|---|
| `map-position-panned` | `map-observer.js` |
| `map-position-rotated` | `map-observer.js` |
| `map-position-zoomed` | `map-observer.js` |

### Dead

`positionchanged` — subscribed in `explore-bar.js`, never emitted.
Remove.

---

## 3. The `wait` mechanism

`Core.once(name, listener, wait)` attaches a countdown to a listener
record. For each firing of the named event while `wait > 0`, the counter
decrements and the listener is skipped. It fires on the next event after
the counter reaches zero.

The only actual use is `getSurfaceAreaGeometry` (`interface.js:273`),
which registers `once('map-update', retry, 1)` when tile meshes are not
yet loaded. The `wait=1` skips one `map-update` firing. The reason: this
call often originates from inside a `map-update` handler. The current
`callListener` iterates the live `listeners` array, so a record appended
mid-iteration would be visited in the same pass — delivering the retry
on the update that just reported the data was missing.

Any implementation that snapshots the active listener set at the start
of each emit (dispatching to a copy) makes this problem impossible: a
listener registered during event X cannot receive event X. The `wait`
workaround then has no purpose, and the call site simplifies to:

```js
return this.map.core.once('map-update',
    this.getSurfaceAreaGeometry.bind(this, ...));
```

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

**Verdict: rejected.** The API shape mismatch at the call sites and the
per-emit allocation overhead outweigh the DevTools and standardisation
benefits for a high-frequency internal event bus.

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
- The browser's native dispatch machinery handles the rest.
- DevTools listener visibility (though via the internal target, not
  the `Viewer` object itself — limited practical value).

**Costs**

- One wrapper closure allocation per `on()` call (to bridge `.detail`
  back to the callback argument).
- One `CustomEvent` allocation per `emit()` call — same problem as 4A.
- `e.detail` indirection inside every listener body (the wrapper hides
  this from external callers, but it still happens in the hot path).
- No net reduction in maintained code: the wrapper layer *is* the event
  bus. The `EventTarget` underneath provides dispatch, but a plain `Map`
  or `Set` provides equivalent dispatch with less overhead.

**Verdict: rejected.** This option inherits the allocation cost of 4A
without the API-surface benefit. It is the worst of both approaches.

---

### 4C. Standalone typed `EventBus<EventMap>` class

A small TypeScript class owned by `Map` (not `Core`). Callers use the
same `on()` / `once()` surface; `Map` holds the bus as a field and
delegates to it. `LegacyMap` and `GpuDevice` call `map.emit(name, payload)`
or a thin forwarding method.

```ts
// src/core/event-bus.ts

type Listener<T> = (event: T) => void;

interface Record_<T> { listener: Listener<T>; once: boolean; }

class EventBus<M extends Record<string, unknown>> {

    private sets_: { [K in keyof M]?: Set<Record_<M[K]>> }
        = Object.create(null);

    on<K extends keyof M>(name: K, fn: Listener<M[K]>): () => void {

        const set = this.sets_[name] ??= new Set();
        const rec: Record_<M[K]> = { listener: fn, once: false };
        set.add(rec);
        return () => set.delete(rec);
    }

    once<K extends keyof M>(name: K, fn: Listener<M[K]>): () => void {

        const set = this.sets_[name] ??= new Set();
        const rec: Record_<M[K]> = { listener: fn, once: true };
        set.add(rec);
        return () => set.delete(rec);
    }

    emit<K extends keyof M>(name: K, event: M[K]): void {

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
- `emit` exits with zero allocation when no listeners are registered.
- Dispatch is O(listeners for this event type), not O(all listeners).
- Snapshot-at-dispatch (`[...set]`): registrations during emit do not
  receive the current event, eliminating the `wait` workaround.
- The snapshot allocates one temporary array per emit call that has
  listeners. For `tick` at 60 Hz with one listener this is one small
  array per frame. If this shows up in profiling, a two-pass approach
  (mark `once` records, delete after the loop) eliminates the array
  without changing the snapshot guarantee.

**Verdict: recommended.** See section 5 for the full design.

---

## 5. Performance comparison

| Metric | Current | 4A (`EventTarget`) | 4C (`EventBus`) |
|---|---|---|---|
| `emit` with 0 listeners | O(n) scan, 0 allocs | 1 `CustomEvent` alloc | 0 allocs |
| `emit` with k listeners | O(n) scan | 1 `CustomEvent` alloc, native dispatch | 1 array alloc (`[...set]`) |
| Dispatch per event type | O(total listeners) | O(listeners for type) | O(listeners for type) |
| `on()` alloc | 1 closure | 1 closure | 1 closure + 1 record object |
| Code to maintain | 40 lines JS | 0 (native) | ~40 lines TS |

For the zero-listener case the current implementation scans all 9
`Browser` listeners every `tick` and `map-update` emit. With 4C, zero
listeners means an immediate return. For 60 Hz `tick` that is ~60 × 9 =
540 wasted iterations per second eliminated.

For the typical case (1 `tick` listener in `Browser`), 4C allocates one
3-element array per frame (`[...set]` on a Set with one entry). This is
comparable to the closure allocation that `callListener` would make if it
were written differently; V8 optimises same-shape short-lived arrays
well. 4A allocates two objects (`CustomEvent` + `detail`) per frame with
no listener in the critical path at all. The `CustomEvent` objects are
larger and carry browser-internal state (`timeStamp`, event flags, DOM
propagation machinery).

`on()` allocation: all three approaches allocate one closure for the
unsubscribe function. 4C additionally allocates the `Record_` object
containing the listener reference and the `once` flag — one extra small
object per subscription, paid once at registration time, not per emit.

The practical difference between 4A and 4C at the emit site is the
`CustomEvent` allocation. At 60 Hz this is ~5 MB/min of short-lived
objects for `tick` and `map-update` combined, assuming a 200-byte
`CustomEvent`. This is unlikely to be a bottleneck on desktop but is
relevant on memory-constrained mobile devices where GC pauses are more
disruptive.

---

## 6. Proposed design

### 6.1 Module

`EventBus<CoreEventMap>` is implemented in `src/core/event-bus.ts` and
instantiated by `Map` (`src/core/map.ts`):

```ts
class Map {
    private bus_: EventBus<CoreEventMap> = new EventBus();

    on<K extends keyof CoreEventMap>(
        name: K,
        fn: (e: CoreEventMap[K]) => void,
    ): () => void {
        this.assertAlive_();
        return this.bus_.on(name, fn);
    }

    once<K extends keyof CoreEventMap>(
        name: K,
        fn: (e: CoreEventMap[K]) => void,
    ): () => void {
        this.assertAlive_();
        return this.bus_.once(name, fn);
    }

    /** @internal */
    emit<K extends keyof CoreEventMap>(
        name: K,
        event: CoreEventMap[K],
    ): void {
        this.bus_.emit(name, event);
    }
}
```

`LegacyMap` and `GpuDevice` currently call `this.core.callListener(...)`.
Rather than adding a forwarding method to `Core` (which contradicts the
goal of reducing its surface), the `EventBus` instance is passed directly
to each at construction time. `LegacyMap` receives it from `Core` when
`Core` constructs it; `GpuDevice` receives it from `Renderer`, which has
access to `Core` and therefore to the bus. Both store it as a local
field (`this.bus`) and call `this.bus.emit(...)`. The `EventBus` type
has no naming collision with `LegacyMap` or the TypeScript `Map`.

`Viewer.on()` and `Viewer.once()` delegate to `this.map_.on()` /
`this.map_.once()` as today. `Viewer.once()` return type changes from
`void` to `() => void`.

### 6.2 Typed payloads

`CoreEventMap` in `src/core/types.ts` replaces all `unknown` entries:

```ts
export interface CoreEventMap {
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
}

export interface GeoFeatureEvent {
    feature: unknown;           // typed once LegacyMap migrates to TS
    'canvas-coords': number[];
    'world-coords': number[];
}
```

### 6.3 Fixes bundled with the extraction

- `Browser.kill()` stores the 9 unsubscribe closures returned at
  construction and calls them on teardown.
- `map-position-panned`, `map-position-rotated`, `map-position-zoomed`
  are emitted via `map.emit(...)` instead of the
  `Browser.callListener` → `Core.callListener` reach-through.
- The dead `positionchanged` subscription in `explore-bar.js` is removed.
- The `wait` parameter is removed from `Core.once`, `Map.once`, and
  `Viewer.once`. The `getSurfaceAreaGeometry` call site is updated to
  use `once` without `wait`.

---

## 7. Implementation steps

1. Write `EventBus<EventMap>` in `src/core/event-bus.ts`. Unit-test
   snapshot-at-dispatch, `once` auto-removal, and unsubscribe.
2. Add `bus_: EventBus<CoreEventMap>` to `Map`. Implement `Map.on()`,
   `Map.once()`, `Map.emit()` delegating to `bus_`. Change
   `Map.once()` return type to `() => void`.
3. Update `Viewer.once()` return type to `() => void`.
4. Replace `Core.on` / `Core.once` / `Core.callListener` /
   `Core.removeListener` with forwarding calls to `Map.on` /
   `Map.once` / `Map.emit`. Remove the `listeners` array and
   `listenerCounter` from `Core`.
5. Pass the `EventBus` instance to `LegacyMap` and `GpuDevice` at
   construction time. Replace `this.core.callListener(...)` call sites
   with `this.bus.emit(...)`.
6. Remove the `wait` parameter. Fix `getSurfaceAreaGeometry`.
7. Type all payloads in `CoreEventMap`.
8. Add `map-position-panned/rotated/zoomed` to `CoreEventMap`; reroute
   their emission through `map.emit(...)`.
9. Fix `Browser.kill()` to store and invoke unsubscribers.
10. Remove the `positionchanged` subscription in `explore-bar.js`.
11. Run screenshot regression tests.

---

## 8. Open questions

None as of the draft date.

---

## 9. Reviewer notes

- The direction is sound: a typed `EventBus<EventMap>` owned by `Map`
  fits the `core.js` suppression track.
- Clarify the temporary migration path while `Core` still emits `tick`,
  `map-loaded`, `map-unloaded`, and `map-mapconfig-loaded`. `Map`
  should own the bus; `Core` can receive it only as temporary wiring
  until those responsibilities move into `Map`.
- The event inventory is incomplete. `Browser.callListener()` also emits
  `autorotate-changed`, `fly-start`, `fly-final-phase`, `fly-progress`,
  `fly-end`, and `loading-screen-hidden`. `fly-end` is used by
  `demos/waypoint/waypoint.js`.
- The `wait` section is incomplete. `getSurfaceAreaGeometry` is not the
  only use; `src/browser/ui/control/measure.js` also calls
  `core.once('tick', ..., 1)`.
- Define event policy explicitly: public core events, public
  browser/viewer events, internal-only events, and deleted events. The
  RFC currently promotes only three browser events without saying why
  the other browser events are excluded.
- Specify dispatch semantics: listener added during emit, listener
  removed during emit, `once` removal timing, and exception behavior.
- The sample type bound `EventBus<M extends Record<string, unknown>>`
  may reject named interfaces without a string index signature. Prefer
  `M extends object` plus `keyof M & string`.
- `Browser.kill()` should store and drain all unsubscribe closures, not
  rely on a fixed listener count.
- Keep `EventTarget` rejected. The existing reasoning is adequate; the
  stronger reason is the API mismatch with the existing `on()` /
  unsubscribe-closure surface.
- Replace `Open questions: none` with the unresolved migration and
  event-surface questions above before moving the RFC out of draft.
