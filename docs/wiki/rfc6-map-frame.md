# RFC 6: Map owns the frame loop

**Status:** Implemented
**Context:** Promotes step 2 of
[REFACTOR: replace legacy map draw path with `TileRenderRig`](backlog.md)
to a full design. Complementary to
[rfc3-draw-traversal.md](rfc3-draw-traversal.md), which covers step 3
(the unified surface-tree traversal). This RFC owns the per-frame
entry points above the traversal; the two RFCs can land in either
order.

---

## 1. Problem

`Map` in `src/core/map.ts` is the destination class for map data
model and logic. `LegacyMap` is the unfinished JS version of the
same object; absorption goes straight from one into the other.
There is no separate engine to relegate frame state to.

Two structural facts pull new per-frame state onto `LegacyMap`
instead:

1. **The auxiliary legacy classes inherit `LegacyMap`, not typed
   `Map`.** `MapDraw`, `MapDrawTiles`, `MapSurfaceTree`, `Renderer`,
   and the others under `src/core/` all hold a `this.map`
   reference to `LegacyMap`. None of them has a reference to typed
   `Map`. Any state they need to read or write must live somewhere
   reachable through `LegacyMap`.

2. **The frame loop entry point lives in `LegacyMap.update`**
   ([map.js:1484](../../src/core/map/map.js#L1484)). It owns dirty
   tracking, position-change events, canvas-target sync, the draw
   call, overlay dispatch, deferred geodata hover/click processing,
   and the loader/worker tick work. Anything that needs to happen
   "once per frame" lands on `LegacyMap` because that is what is in
   scope at the loop entry.

The first source is the dominant one. The second amplifies it for
state that the loop itself needs.

Two recent additions illustrate. The typed `drawChannel` state
(`'color' | 'depth'`) is read from `MapDraw`, `MapDrawTiles`,
`MapSurfaceTree`, and `Renderer` — none of them with a path to
typed `Map`. It had to land on `LegacyMap`. The overlay registry
hit both pulls at once: its state needed to be reachable from the
auxiliary classes, and its dispatcher had to be called from the
frame loop. Both landed on `LegacyMap` in commit `ff70938e` despite
conceptually belonging on `Map`.

This RFC addresses both sources: an `outerMap` back-pointer adds
the missing edge in the object graph (auxiliary classes can reach
typed `Map`), and `Map.tick` replaces `LegacyMap.update` as the
frame entry point.

## 2. Scope

**In scope:**

- Move `MapDraw.drawMap` into typed `Map.draw`. The draw-refactor
  step 2 brief originally framed this as "write a smaller draw
  function," but the body has already shrunk substantially through
  earlier refactors (frame-init split, renderer init centralisation,
  freeze-camera narrowing, dead-code removal). The remaining win is
  the move into TypeScript and onto the right class, not further size
  reduction.
- Move the frame loop from `LegacyMap.update` into typed `Map.tick`.
  `LegacyMap` retains a smaller `LegacyMap.tick` for the residual
  JS work that has not been promoted yet (loader update, worker
  callbacks, deferred geodata hover/click event processing).
- Install a `outerMap` back-pointer from `LegacyMap` to typed `Map`
  so JS code reaches typed-`Map` state where it must.
- Migrate the post-`55a34f27` additions on `LegacyMap` that are
  trivially typed: `drawChannel`, the overlay registry and methods,
  `initFrame`, `getNavigationPosition`, `getSelectionPosition`.
- Update `Viewer` overlay delegation to call `Map` directly, not
  through `LegacyMap`.

**Out of scope** (already tracked elsewhere, not blocking):

- The unified recursive tile-tree traversal —
  [rfc3-draw-traversal.md](rfc3-draw-traversal.md), step 3 of the draw
  refactor.
- `withNavigationCamera` / `withSelectionCamera` — slated for removal
  by "REFACTOR: pass explicit draw contexts" in
  [backlog.md](backlog.md).
- `MapInterface` deletion — completed independent track, see
  "REFACTOR: delete `MapInterface`" in [backlog.md](backlog.md).
  No design overlap with this RFC.
- The large surface-of-getters on `LegacyMap` (`addSurface`,
  `addGlue`, `addBoundLayer`, `addFreeLayer`, named views, credits,
  body/SRS/reference-frame registries). These are part of the map
  model and will absorb into `Map` as feature work touches them;
  this RFC does not preempt them.
- `Core` (`src/core/core.js`). It is residual JS and scheduled to
  dissolve into `Map`; this RFC does not move it but is compatible
  with that direction.

## 3. Design

### 3.1 The two-tier frame entry

```text
Core.onUpdate                 (JS, src/core/core.js — minimal shim)
  → if killed | contextLost: return
  → this.outerMap.tick()      ← Core's typed-Map back-pointer,
                                set by Map ctor; non-null from
                                the first frame onwards (rAF runs
                                after Map ctor returns)
  → requestAnimationFrame(onUpdate)

Map.tick                      (TypeScript, src/core/map.ts)
  → if legacyMap is null (async style load or post destroyMap):
      → emit public 'tick' event
      → return
  → first-load completion (one-time, when reference frame becomes ready):
      → set legacyMap.srsReady = true
      → emit 'map-loaded'
      → resolve Map.ready (via core_.markReady_)
  → if !legacyMap.srsReady (still loading reference frame / geoid):
      → legacyMap.loader.update()
      → emit public 'tick' event
      → return
  → position-change events
  → canvas render-target sync
  → stats.begin
  → LegacyMap.tickBefore      (JS, pre-draw residual)
      → loader.update
      → processProcessingTasks
  → if dirty:
      → Map.draw
      → Map.runOverlays_
      → legacyMap.loader.update()   ← post-draw promotion of
                                      requests queued during draw
      → emit 'map-update'
  → LegacyMap.tickDeferredEvents()  (JS, every frame; no-op if no
                                     hover/click queued)
  → stats.end                  ← runs before 'tick' so listeners
                                  read stats for the just-completed
                                  frame
  → emit public 'tick' event
```

The split is by topic, not by visibility. `Map.tick` owns frame
state and orchestration; `LegacyMap` exposes two narrow callbacks
(`tickBefore`, `tickDeferredEvents`) for the residual JS work that
has not been rewritten yet. The line is "is this map data model
state and logic" (typed `Map`) versus "is this JS code that hasn't
been promoted yet" (legacy). The line will move as absorption
continues.

`Core.onUpdate` shrinks to a `requestAnimationFrame` shim that
calls `this.outerMap.tick()` through `Core`'s own back-pointer to
typed `Map` (round 2 note 1). The reason `Core` has its own
back-pointer rather than reaching through `core.map.outerMap` is
that `Core.map` is null during async style loading and after
`destroyMap()`; the `Core` shim must still call into typed `Map`
in those states so the public `tick` event keeps firing. `Map.tick`
owns the null-`LegacyMap` branch and returns early after emitting
`tick`. The first-load completion (`map-loaded`, `Map.ready`
resolution) and the regular public `tick` event both live in
`Map.tick`, so `Core` does not accrete new logic (round 1 note 2).
`Map.ready` continues to resolve through `Core.ready`; the trigger
is `core_.markReady_(payload)`, a thin setter that owns the Promise
plumbing without owning the gate decision.

The `srsReady` early-return gate sits at the top of `Map.tick`,
after the first-load completion check (round 2 note 2). The
not-ready branch matches the current `LegacyMap.update` behaviour:
only `loader.update()` runs, then `tick` fires, then return. The
position-change events, canvas sync, `stats.begin`,
`tickBefore`, draw block, and `tickDeferredEvents` only run on the
ready path. This preserves the invariant that position-change
events and worker callbacks never fire before `map-loaded`, and
that no `stats.begin` ever runs without a matching `stats.end`.

The `tickDeferredEvents` placement after the dirty block (round 1
note 3) preserves the current ordering: hover/click handlers see
hit-test results from the canvas that was just drawn, not from the
previous frame. The post-draw `loader.update()` (round 1 note 4)
stays inside the dirty block immediately after `runOverlays_` to
promote requests discovered during traversal and draw, matching
the existing two-call pattern in `LegacyMap.update`.

`stats.end` runs before the public `tick` event (round 2 note 3).
This matches the current order: today `LegacyMap.update` closes
the stats frame before returning, and `Core.onUpdate` emits `tick`
afterwards. Listeners can read `map.getStats()` and have it
describe the frame that just completed.

### 3.2 `Map.draw` — the canvas frame draw

`Map.draw` replaces `MapDraw.drawMap`. Its body:

- GPU state setup: clear color and depth based on `Map.drawChannel`.
- Skydome / background draw when atmospheric and channel is `'color'`.
- Surface tree draw via the existing `TileRenderRig` path
  (`MapSurfaceTree.draw`).
- Free layer traversal (the existing
  `freeLayerSequence` loop, including monolithic geodata and tiled
  free layers).
- Freeze frustum draw when the inspector freeze is active.
- Queued geodata label/icon jobs via
  `RendererDraw.drawGpuJobs()`.

`Map.draw` is also called from `Map.drawHitmap`: that method toggles
`Map.drawChannel = 'depth'`, switches the framebuffer, calls
`Map.draw`, restores the framebuffer, and resets the channel.

The body is essentially what `MapDraw.drawMap` does today, rewritten
in TypeScript on the right class. Earlier refactors have already
removed the legacy noise; the residual is close to the essential
shape, so this step is a relocation more than a rewrite. The
freeze-frustum draw is part of the active freeze-mode feature, not
inspector residue.

### 3.3 State that moves to typed `Map`

| State | Today | After |
|---|---|---|
| `drawChannel: 'color' \| 'depth'` | `LegacyMap` (field) | `Map` (field) |
| `overlays` registry | `LegacyMap` (field) | `Map` (field) |
| `addOverlay` / `removeOverlay` / `setOverlayEnabled` | `LegacyMap.prototype` | `Map` (public methods) |
| `runOverlays_` / `findOverlayIndex_` / `overlayContext_` | `LegacyMap.prototype` | `Map` (private methods) |
| `initFrame` (frame-state reset) | `LegacyMap.prototype` | `Map` (private, called by `Map.draw`) |
| `getNavigationPosition` / `getSelectionPosition` | `LegacyMap.prototype` | `Map` (internal methods, not promoted to `Viewer`). Current callers — `Renderer.initFrame`, `Renderer.updateBuffers`, inspector stats, `MapDraw.drawMap`, `MapDraw.drawGeodataHitmap`, and `Viewer.getViewExtent` — keep working; the methods reach them through the typed `Map` reference (note 5 of round 1). `Viewer.getPosition()` already returns the navigation position via `this.position.clone()`; the freeze-mode-aware accessors stay internal. |

`Viewer.addOverlay` / `removeOverlay` / `setOverlayEnabled` delegate
directly to `Map` after the move, not to `LegacyMap`. The
`legacyMap_.addOverlay(...)` calls in
[src/browser/viewer.ts](../../src/browser/viewer.ts) become
`map_.addOverlay(...)`.

### 3.4 What stays on `LegacyMap`

`LegacyMap` retains:

- The map authoring registries: `addSurface` / `addGlue` /
  `addBoundLayer` / `addFreeLayer` / named views / credits / body /
  SRS / reference-frame.
- The terrain surface tree: `tree`, `surfaceSequence`,
  `freeLayerSequence`, `freeLayersHaveGeodata`.
- The loader and worker pipeline: `loader`, `processingTasks`.
- The legacy camera / position / convert / measure / config helper
  objects (`camera`, `position`, `convert`, `measure`).
- `LegacyMap.tick` — the residual loop work listed in §3.1.

These are all map data model and logic. They will move into typed
`Map` piecemeal as feature work requires. None of them is a
separate subsystem; the name "LegacyMap" refers to "the JS half of
`Map` that hasn't been rewritten yet," nothing more.

### 3.5 `outerMap` back-pointers

The typed `Map` constructor installs a back-pointer on the two JS
classes that need to call into typed-`Map` state during normal
operation: `LegacyMap` and `Core`.

```ts
// src/core/map.ts — Map constructor (sketch)
this.core_ = new Core(element, config);
this.core_.outerMap = this;
// LegacyMap is created later by Core during loadMap / loadMapFromStyle;
// Core installs `legacyMap.outerMap = this.outerMap` at that point.
```

```js
// src/core/map/map.js — LegacyMap constructor
var LegacyMap = function(outerMap, core, path, config, configStorage) {
    this.outerMap = outerMap;
    // ... existing init
};
```

Two reasons two back-pointers, not one:

- `LegacyMap.outerMap` lets the auxiliary classes (`MapDraw`,
  `MapDrawTiles`, `MapSurfaceTree`, `Renderer`, ...) reach typed
  `Map` via `this.map.outerMap.<field>`. This is the dominant
  gravity fix from §1: those classes hold `this.map = LegacyMap`
  references and otherwise cannot see typed `Map`.
- `Core.outerMap` lets `Core.onUpdate` call `Map.tick` even when
  `Core.map` (the `LegacyMap` instance) is still null. That happens
  on the style path (`loadMapFromStyle` is async, the first few
  animation frames have no `LegacyMap`) and after `destroyMap()`.
  Without a back-pointer on `Core`, the shim would either have to
  reintroduce a no-map branch or risk dropping public `tick`
  events during async loading.

The `Core.outerMap` field is non-null from the first animation
frame onwards: `Map.constructor` runs synchronously and finishes
setting `core_.outerMap = this` before any `rAF` callback fires.

Both back-pointers go away with their host classes; they are not
permanent architecture.

## 4. Migration steps

Each step compiles and renders independently. Screenshot regression
runs after each.

1. **Add `outerMap` back-pointers.** Install on both `Core` (so
   `Core.onUpdate` can call into typed `Map` even when `Core.map`
   is null) and `LegacyMap` (so auxiliary classes can reach typed
   `Map` state). The typed `Map` constructor sets `core_.outerMap`
   immediately after `new Core(...)`; `Core` installs
   `legacyMap.outerMap` when it creates the `LegacyMap` instance
   during `loadMap` / `loadMapFromStyle`. No behaviour change.
   Independent prep; can land first.

2. **Move `drawChannel` to typed `Map`.** Update the 26 read sites in
   `draw.js`, `draw-tiles.js`, `surface-tree.js`, `renderer.ts`,
   `map.js` to read `outerMap.drawChannel` (or the equivalent
   typed-`Map` reference where available). Remove the field from
   `LegacyMap`. Update `map.d.ts`.

3. **Move the overlay registry to typed `Map`.** Promote the six
   methods plus the `overlays` field. `Viewer` switches to call
   `map_.addOverlay(...)` directly. `LegacyMap.kill` no longer
   needs the overlay-onRemove block (`Map[Symbol.dispose]()` owns
   it). `demos/overlay/` still works unchanged from the consumer
   side.

4. **Implement `Map.draw`.** Move the body of `MapDraw.drawMap` into
   typed `Map.draw` (relocation and TypeScript rewrite; the body is
   already close to its essential shape after earlier shrink work).
   Move `initFrame`, `getNavigationPosition`,
   `getSelectionPosition` at the same time. Switch
   `MapDraw.drawHitmap` to call `this.map.outerMap.draw()`. Delete
   `MapDraw.drawMap`.

5. **Implement `Map.tick` and the `LegacyMap` residual hooks.**
   Split `LegacyMap.update` into:

   - `LegacyMap.tickBefore()` — ready-path pre-draw work:
     `loader.update`, `processProcessingTasks`. (The `srsReady`
     gate is upstream in `Map.tick`, not in this hook.)
   - `LegacyMap.tickDeferredEvents()` — every-frame post-draw work:
     hit-test the queued click / hover, fire geo-feature events
     (no-op if no event is queued).

   The second `loader.update()` (post-draw promotion of requests
   queued during traversal) stays inline in `Map.tick`'s dirty
   block: `this.core_.map.loader.update()`. It is one line and does
   not warrant a wrapper.

   Typed `Map.tick` orchestrates per §3.1 in this order:

   - No-map branch (round 2 note 1): if `core_.map` is null (async
     style load or post-`destroyMap`), emit public `'tick'` and
     return.
   - First-load completion (one-time, when
     `LegacyMap.isReferenceFrameReady()` first holds): set
     `srsReady`, emit `'map-loaded'`, call
     `core_.markReady_(payload)` to resolve `Map.ready`.
   - Not-ready early-return (round 2 note 2): if
     `legacyMap.srsReady` is still false, call
     `legacyMap.loader.update()`, emit `'tick'`, return. Matches
     the current `LegacyMap.update` not-ready branch.
   - Ready path: position-change events, canvas sync,
     `stats.begin`, `legacyMap.tickBefore()`, the dirty block
     (draw, overlays, second loader update, `map-update`
     listener), then `legacyMap.tickDeferredEvents()`, then
     `stats.end`, then emit `'tick'` (round 2 note 3 — `stats.end`
     before `tick`).

   `Core.onUpdate` shrinks to a `requestAnimationFrame` shim:
   `if (killed || contextLost) return; this.outerMap.tick();
   rAF(onUpdate);`. It calls through `Core.outerMap`, not
   `Core.map.outerMap`, so the call works during async loading and
   after `destroyMap()`. `Core._resolveReady` / `_readyResolved`
   move into a thin `Core.markReady_(payload)` internal method
   that owns only the Promise plumbing.

   Delete `LegacyMap.update`. `MapDraw.drawHitmap` already calls
   `Map.draw` after step 4, so no further changes there.

6. **Audit pass.** Two checks:

   a. Review remaining `LegacyMap` additions since commit
      `55a34f27` (`Map.ts` creation). Anything trivially typed and
      not tied to loader / worker / data-pipeline state moves to
      `Map`. Anything non-trivial stays for a later step and is
      noted in the backlog.

   b. Audit `Viewer`'s use of `legacyMap_`. For each call site,
      check whether the same capability is already available on
      `Map`; if so, route through `map_` instead. `legacyMap_`
      stays available where the capability has not been promoted
      yet — this audit closes accidental gaps, it does not force
      premature promotion. The check is mechanical: grep
      `legacyMap_` in `src/browser/viewer.ts`, then verify each
      hit either lacks a `Map` equivalent or is already on the
      backlog for promotion.

Steps 1, 2, 3 can land as separate small PRs before steps 4–5.
Steps 4 and 5 are paired (single PR or back-to-back) because they
touch the same draw / update flow. The independent `MapInterface`
deletion track is already complete; no frame-loop design changed with
that deletion.

## 5. Verification

Per [AGENTS.md](../../AGENTS.md) testing rules:

- `npx tsc --noEmit` clean after each step.
- Screenshot regression on `simple-terrain`, `complex-terrain`,
  `full-terrain` shows no visual change after each step.
- Hit testing returns valid coordinates at a known terrain pixel
  on `simple-terrain` (no depth-pass corruption).
- `demos/overlay/` renders the marker, `onAdd` / `render` /
  `onRemove` lifecycle fires as before, toggle and re-register
  buttons work.
- Inspector freeze frustum still draws when active (`Shift+D`,
  `Shift+Z`, `F`, `C`).

## 6. Open questions

- Split `Map.draw` per channel? Today `MapDraw.drawMap` branches on
  `drawChannel` at almost every step, and the color path is
  substantially longer than the depth path. Two methods
  (`Map.drawColor` / `Map.drawDepth`) would remove the branching
  and let each path read straight through, at the cost of some
  duplicated surface / free-layer traversal scaffolding. Not a
  hard requirement of this RFC — implementer can decide based on
  what the post-relocation body actually looks like.

- Naming: `Map.tick` vs `Map.frame` vs `Map.update`. The verb
  "tick" matches the existing `tick` event on `CoreEventMap` and
  is short. `update` clashes with the JS-side method being replaced
  during migration. Picked `tick` unless reviewers prefer otherwise.

## 7. After this RFC lands

The frame entry point lives on typed `Map`. New per-frame features
land on typed `Map` by default — the gravity that was pulling
everything into `LegacyMap` is gone. Subsequent absorption work
(promoting `addSurface`, `addGlue`, the camera/position/convert
helpers, etc.) follows the same pattern: rewrite in TypeScript,
land on `Map`, remove the JS equivalent.

The triage rule in `AGENTS.md` becomes the standing instruction:
**state that belongs to the map data model and logic goes on typed
`Map`; nothing new lands on `LegacyMap`.** This RFC removes the
last structural reason for that rule to be violated.

## Review round 1

1. Non-blocking clarification: name the `Core.onUpdate` call route.

   The RFC establishes `outerMap` as the JS-to-typed bridge, and the
   same pattern is enough for `Core.onUpdate`: after step 1 it can call
   `this.map.outerMap.tick()`. The RFC would be clearer if §3.1 or the
   migration steps named that exact call site. Do not add typed-owner
   state to `Core`; `core.js` is legacy code scheduled for deletion.

   *Implemented.* §3.1 now shows the `Core.onUpdate` shim explicitly:
   `if (killed) return; map.outerMap.tick(); rAF(onUpdate);`. The
   migration step 5 names the same call site. `Core` does not accrete
   new state — `Core.markReady_(payload)` (note 2) is a thin Promise-
   resolution wrapper around fields already on `Core`, not new state.

2. The first-load gate and the public `tick` event need an owner.

   `Core.onUpdate` currently checks `map.isReferenceFrameReady()`,
   sets `map.srsReady`, emits `map-loaded`, resolves `Core.ready`,
   calls `map.update()`, then emits the public `tick` event. The RFC's
   diagram moves an `srsReady` gate into `LegacyMap.tick`, but it does
   not say where `map-loaded`, `ready`, and the public `tick` event
   live after `Core.onUpdate` delegates to typed `Map.tick`.

   Pick one owner and preserve the order. If `Core` remains the owner,
   §3.1 should show `Core.onUpdate` doing the first-load check before
   `Map.tick` and emitting `tick` after it. If typed `Map` becomes the
   owner, the RFC should move ready resolution and `tick` dispatch into
   `Map.tick` and explain how `Core.ready` is still resolved.

   *Implemented.* Typed `Map` becomes the owner. `Map.tick` does the
   first-load completion (`isReferenceFrameReady` check, set
   `legacyMap.srsReady`, emit `'map-loaded'`) and emits the public
   `'tick'` event at the end. `Map.ready` continues to resolve through
   `Core.ready`; the trigger is `core_.markReady_(payload)`, a thin
   internal method on `Core` that owns only the Promise plumbing
   (`_readyResolved`, `_resolveReady`) without owning the gate
   decision. `Core.onUpdate` no longer touches readiness or events —
   it is the `requestAnimationFrame` shim from note 1.

3. `LegacyMap.tick` is placed before drawing, but deferred geodata
   events currently run after drawing.

   In `LegacyMap.update`, hover and click processing happens after
   `drawMap()`, `runOverlays_()`, the post-draw `loader.update()`, and
   `map-update`, but before `stats.end(dirty)`. The RFC lists deferred
   geodata hover/click processing inside `LegacyMap.tick`, which the
   diagram runs before `Map.draw`.

   That order can make hover/click callbacks use state from the
   previous canvas frame. It also moves the work outside the current
   stats window if `stats.end` remains after the dirty block. Split the
   residual JS work into pre-draw and post-draw hooks, or make the
   diagram show `LegacyMap.tick` running after the canvas draw for the
   deferred event portion.

   *Implemented.* Split into two `LegacyMap` hooks:
   `LegacyMap.tickBefore()` for pre-draw work (loader, workers,
   `srsReady` gate) and `LegacyMap.tickDeferredEvents()` for the
   post-draw deferred geodata events. §3.1 places
   `tickDeferredEvents` after the dirty block and before `'tick'` /
   `stats.end`, matching the original ordering: hit-test sees the
   freshly drawn canvas, and the work stays inside the stats window.

4. The post-draw loader update is missing from the new frame order.

   `LegacyMap.update` calls `loader.update()` before
   `processProcessingTasks()`, then calls `loader.update()` again after
   `drawMap()` when the frame was dirty. The second call promotes
   requests queued during traversal and draw. The RFC diagram has only
   one loader update inside `LegacyMap.tick`, before `Map.draw`.

   Preserve the second call in the design. It can be a named
   post-draw step on `Map.tick`, or part of the post-draw residual hook
   from note 3. Without it, tile requests discovered during a drawn
   frame wait an extra animation frame before entering the loader.

   *Implemented.* The second `loader.update()` stays inline in
   `Map.tick`'s dirty block immediately after `runOverlays_`:
   `this.core_.map.loader.update()`. Kept inline rather than wrapped
   because it is a single line and bundling it into
   `tickDeferredEvents` would conflate the dirty-gated loader
   promotion with the every-frame deferred-event check.

5. The proposed private position methods are still called from other
   objects.

   §3.3 moves `getNavigationPosition` and `getSelectionPosition` to
   private typed-`Map` methods. Current callers include
   `Renderer.initFrame`, `Renderer.updateBuffers`, inspector stats,
   `MapDraw.drawMap`, `MapDraw.drawGeodataHitmap`, and `Viewer`
   methods that derive the selection view extent. After the move, those
   callers either need a typed public/internal method they are allowed
   to call, or the needed positions must be passed into them.

   Do not make these methods private in the RFC unless the design also
   removes all external calls. A narrower option is to keep them as
   internal typed `Map` methods and document that they are not promoted
   to `Viewer`.

   *Implemented.* The §3.3 table cell for these methods now reads
   "internal methods, not promoted to `Viewer`" (instead of
   "private"). External callers — `Renderer.initFrame`,
   `Renderer.updateBuffers`, inspector stats, `MapDraw.drawMap`,
   `MapDraw.drawGeodataHitmap`, `Viewer.getViewExtent` — continue to
   reach them through the typed `Map` reference (`map.outerMap.*`
   from JS, direct `map_.*` from `Viewer`). The "private" wording was
   wrong about the surface that exists; "internal" captures the right
   intent (not part of the public `Viewer` API, but callable from
   inside the implementation).

## Review round 2

1. `Core.onUpdate` still needs a no-map branch.

   `Core` schedules `onUpdate` in its constructor. On the style path,
   `loadMapFromStyle` is async, so `Core.map` can be null for one or
   more animation frames. The current code handles that by skipping
   `map.update()`, still emitting the public `tick` event, and
   scheduling the next frame.

   The RFC's shim calls `map.outerMap.tick()` unconditionally. That
   throws before the first `LegacyMap` exists, and it also leaves no
   owner for the public `tick` event during async loading or after
   `destroyMap()`. Preserve the null branch explicitly. Either
   `Core.onUpdate` emits `tick` itself when `this.map` is null, or
   the RFC must choose a different route that lets `Core` call typed
   `Map.tick` without going through `Core.map`.

   *Implemented.* Took the "different route" option. `Core` gets its
   own `outerMap` back-pointer to typed `Map`, set by the typed
   `Map` constructor immediately after `new Core(...)`.
   `Core.onUpdate` calls `this.outerMap.tick()` directly. `Map.tick`
   owns the null-`LegacyMap` branch — it emits public `'tick'` and
   returns. Single owner for the public `'tick'` event, no
   reintroduced null branch in `Core`, and the call works during
   async loading and after `destroyMap()`. §3.5 explains why two
   back-pointers (one on `LegacyMap`, one on `Core`) address two
   different reachability gaps. Step 1 of §4 covers installing both.

2. The `srsReady` early-return gate moved too late.

   Today `LegacyMap.update` checks `!srsReady` before position-change
   events, canvas-target sync, `stats.begin`, and
   `processProcessingTasks`. The not-ready branch only calls
   `loader.update()` and returns.

   The RFC puts position-change events, canvas sync, `stats.begin`,
   `loader.update`, and `processProcessingTasks` before the
   `srsReady` gate in `LegacyMap.tickBefore`. That can emit
   position-change events before `map-loaded`, process worker
   callbacks before the reference frame is ready, and start a stats
   frame that has no defined close path when `tickBefore` returns
   false.

   Keep the first-load check at the top of `Map.tick`, then preserve
   the old not-ready branch: if `legacyMap.srsReady` is still false,
   call `legacyMap.loader.update()`, emit the public `tick` event if
   that remains part of the public contract before map load, and skip
   the rest of the map-frame work.

   *Implemented.* The `srsReady` gate is now at the top of `Map.tick`
   (after the first-load completion check and after the null-map
   branch from note 1), exactly mirroring the current
   `LegacyMap.update` ordering. Not-ready branch calls
   `legacyMap.loader.update()`, emits the public `'tick'` event,
   returns. Position-change events, canvas sync, `stats.begin`,
   `tickBefore`, the dirty block, and `tickDeferredEvents` only run
   on the ready path. `LegacyMap.tickBefore` no longer owns the gate
   — its description in step 5 is updated. This restores the
   invariants that position-change events and worker callbacks
   cannot fire before `map-loaded`, and that no `stats.begin` runs
   without a matching `stats.end`.

3. `stats.end` must run before the public `tick` event.

   In the current code, `LegacyMap.update` calls `stats.end(dirty)`
   before it returns, and `Core.onUpdate` emits the public `tick`
   event only after `map.update()` returns. The RFC diagram reverses
   that order: public `tick` fires before `stats.end`.

   Preserve the current order. Tick listeners can read stats through
   `map.getStats()`, and control code can use `frameTime` for
   time-normalized input handling. The stats object should describe
   the frame that just completed when public `tick` listeners run.

   *Implemented.* Swapped the order in §3.1 and §4 step 5: the
   ready path now does `stats.end` and then emits public `'tick'`.
   The not-ready and no-map branches do not open a stats frame, so
   they emit `'tick'` without a matching `stats.end`, matching the
   current behaviour (today's `LegacyMap.update` not-ready branch
   never calls `stats.begin` either).

## Review round 3 — sign-off

Accepted.

The design now preserves the current frame-loop lifecycle:

- async style loading and post-`destroyMap()` states keep emitting
  public `tick`;
- not-ready maps only dispatch loader work before returning;
- ready frames close stats before public `tick`;
- deferred geodata events and the post-draw loader update keep their
  current order relative to the canvas draw.

The two temporary back-pointers are acceptable migration scaffolding.
`LegacyMap.outerMap` gives old helper objects a route to typed `Map`,
and `Core.outerMap` keeps `Core.onUpdate` as a thin animation-frame
shim even when no `LegacyMap` exists. Both disappear with their host
legacy classes.

Editorial note, not a blocker: the round 1 response to note 1 still
says `Core` does not gain new state. Round 2 supersedes that with the
explicit `Core.outerMap` design.
