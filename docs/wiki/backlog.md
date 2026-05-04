# Task backlog

## REFACTOR: build the `Map` TypeScript public class

**Opened:** 2026-05-04
**Status:** deferred

### Motivation

`Viewer` currently promotes rendering methods by reaching directly into
legacy internals — `_map` (terrain engine), `_mapInterface`, and `_renderer`
— all via `this._core?.core?.*`. This is the wrong layering. Every new
promoted method deepens the problem.

The fix is to build the `Map` TypeScript class first, then route all
delegations through it. `Map` wraps `CoreInterface`, keeps the legacy
objects private, and exposes a flat typed surface. `Viewer` holds a `Map`
instance and delegates to it. Direct internal access is removed from
`Viewer` entirely.

### Shape

```ts
class Map {
    constructor(core: CoreInterface) { ... }

    // lifecycle, events, config — delegated from CoreInterface
    // hit testing, coordinate conversion — absorbed from MapInterface
    // illumination, atmosphere, VE — absorbed from Renderer / RendererInterface
}
```

### Relevant files

| File | Note |
|---|---|
| `src/browser/viewer.ts` | `_map`, `_mapInterface`, `_renderer` — all to be replaced by `Map` delegation |
| `src/core/interface.js` | `CoreInterface` — the constructor input |
| `src/core/map/interface.js` | `MapInterface` — first set of methods to absorb |
| `src/core/renderer/renderer.ts` | `Renderer` — second set of methods to absorb |

---

## BUG: `setAtmosphere` silently no-ops on styles without an `atmosphere` section

**Opened:** 2026-04-24
**Status:** deferred

### Symptom

Calling `map.setAtmosphere(spec)` on a map whose style has no `atmosphere`
section has no effect. `map.getAtmosphere()` continues to return `null` — the
setter provides no error, warning, or other indication that the call was
discarded.

### Root cause

`src/browser/viewer.ts` — `setAtmosphere`:

```ts
this._map?.atmosphere?.setRuntimeParameters(spec);
```

When the style has no atmosphere section, `this._map.atmosphere` is `null` and
the optional chain silently short-circuits. The get/set pair therefore lacks
basic symmetry: a successful `setAtmosphere` call should be reflected by a
subsequent `getAtmosphere`.

The same code path also means enabling `mapFlagAtmosphere` via
`setRenderingOptions` has no visible effect on styles that were created without
an atmosphere section — there are no parameters for the renderer to use.

### Workaround

None viable in the demo without a cartolina-js fix. Injecting a default
`atmosphere` section into the style before `cartolina.map()` does initialise
the subsystem and makes `setAtmosphere` work, but it also activates the
background sky shader unconditionally — `mapFlagAtmosphere: false` does not
suppress it. The injection was tried and reverted.

### Suggested fix

`setAtmosphere` should create the atmosphere subsystem if it does not yet
exist, rather than relying on optional chaining. `getAtmosphere` should return
the live runtime parameters set via `setAtmosphere`, not just what the original
style declared.

### Relevant files

| File | Note |
|---|---|
| `src/browser/viewer.ts:205` | `setAtmosphere` — the silent no-op |
| `src/browser/viewer.ts:212` | `getAtmosphere` — always returns null when no style section |

---

## BUG: `mapFlagAtmosphere: false` does not suppress the background sky shader

**Opened:** 2026-04-24
**Status:** deferred

### Symptom

Setting `mapFlagAtmosphere: false` in the style config suppresses terrain haze
but leaves the background sky shader active. The sky is always visible whenever
the style has an `atmosphere` section, regardless of the flag.

### Root cause (suspected)

The flag likely gates only the terrain haze pass. The background sky is a
separate render pass that checks only whether an atmosphere subsystem exists,
not the `mapFlagAtmosphere` flag.

### Expected behaviour

`mapFlagAtmosphere: false` should mean no atmosphere at all — no terrain haze
and no background sky. The flag should control both components together.

### Observed during

Relief-lab demo investigation: injecting a default `atmosphere` section into a
style that had `mapFlagAtmosphere: false` caused the background sky to appear
unconditionally. Toggling `mapFlagAtmosphere` via `setRenderingOptions` had no
effect on the background.

---

## BUG: control-mode listens for `mousewheel` instead of `wheel`

**Opened:** 2026-04-19
**Status:** deferred

### Symptom

In an embed where reveal.js sits above the cartolina container in the DOM, scroll-wheel zoom does not work when events are forwarded synthetically via `dispatchEvent`. Synthetic `WheelEvent('wheel', …)` dispatched to the map container has no effect.

### Root cause

`src/browser/control-mode/control-mode.js` line 26 registers:
```js
this.mapElement.on('mousewheel', this.onWheel.bind(this));
```

`mousewheel` is a deprecated, non-standard event. Modern browsers fire `wheel` (W3C standard) and additionally still fire `mousewheel` for legacy code when a real user scrolls — but a synthetically constructed `new WheelEvent('wheel', …)` does NOT also fire `mousewheel`. So the forwarding never reaches `onWheel`.

### Fix

Replace `mousewheel` with `wheel` in `control-mode.js`. The `wheel` event provides `deltaX`, `deltaY`, `deltaMode` (all that `onWheel` uses). If `wheelDelta` (deprecated) is referenced anywhere downstream, replace with `-deltaY * 120 / 3` (the conventional scaling).

### Relevant files

| File | Note |
|---|---|
| `src/browser/control-mode/control-mode.js:26` | the `mousewheel` listener to replace |

---

Bugs and deferred work that are not yet scheduled.

---

## FEATURE: explicit offscreen render-pass API

**Opened:** 2026-05-03
**Status:** deferred

### Motivation

The `GpuDevice.RenderTarget` abstraction is the right low-level direction
for multipass rendering: it separates framebuffer binding and viewport
state from the canvas element. The next layer above it must make camera
and logical-size intent explicit.

Upcoming renderer work will need offscreen rendering for:

- shadow maps
- selective blur and postprocessing ping-pong buffers
- zenith rendering for direct processing of OpenMapTiles data instead of
  server-side translations
- masks, object IDs, and G-buffer-like data for the current view
- generated lookup, normal, atmosphere, or compositing textures

The render-target regression showed why this distinction matters:
`updateLogicalSize()` silently mixed framebuffer size, camera aspect, and
screen-space matrix updates. Routing a square hitmap through it changed
the screen camera aspect to `1`, so auxiliary depth data diverged from
screen-coordinate label placement and hit testing.

### Suggested direction

Keep `GpuDevice.setRenderTarget()` as the low-level GPU operation. It
should bind the framebuffer, store the active target, and call
`gl.viewport()`. Higher-level render-pass setup should name the intended
projection policy.

Two useful categories:

- **Auxiliary target:** stores extra data for the current onscreen map
  view. It may have its own framebuffer size, but it uses the same
  camera/projection as the canvas pass. Examples: depth hitmaps, geodata
  hitmaps, object IDs, masks, and G-buffer data for the current view.
- **Independent target:** renders something whose projection is defined
  by the offscreen target itself, not by the current screen view. It may
  use a special camera, a target-aspect projection, or no scene camera at
  all. Examples: shadow maps, environment maps, postprocessing buffers,
  blur passes, lookup textures, generated normal maps, atmosphere
  textures, and compositing buffers.

The API could express this as an explicit pass target:

```ts
type RenderPassTarget = {
    texture: GpuTexture;
    viewportSize: Size2;
    logicalSize: Size2;
    projectionPolicy: 'auxiliary' | 'independent' | 'none';
};
```

Alternatively, split setup into named paths:

```ts
setAuxiliaryTarget(target);
setIndependentTarget(target);
```

The policy names mean:

- `auxiliary`: preserve the current canvas camera/projection even when
  the framebuffer has a different aspect or resolution.
- `independent`: update or choose a projection that belongs to the
  offscreen target, such as a light-space projection for a shadow map.
- `none`: the pass has no scene camera, such as a blur, lookup-table
  generation, or compositing pass.

The important rule is that multipass code must not infer projection
behavior from framebuffer dimensions. Target binding, camera aspect, and
screen-space matrices are separate decisions.

### Related notes

See `render-targets.md` for the current auxiliary-buffer policy and
`rendering-sizes.md` for the size vocabulary used by render targets.

---

## DOCS: split wiki into a more hierarchical reference manual

**Opened:** 2026-04-15
**Status:** deferred

### Motivation

`docs/wiki/architecture.md` currently acts as both the main overview
page and a catch-all home for many detailed notes. As the wiki grows,
it becomes harder to navigate than a more explicit reference-manual
layout.

### Suggested direction

Restructure the wiki into a clearer hierarchy, for example:

- overview / getting-oriented pages
- architecture / cross-cutting system design pages
- subsystem notes
- feature-specific notes
- session log

Keep `architecture.md` as a high-level entry point, then move narrow
topics into dedicated pages linked from that overview.

## FEATURE: pitch / horizon-based line dissipation

**Opened:** 2026-04-15
**Status:** deferred

### Motivation

Lines such as boundaries that follow ridge lines become noisy and
unnatural-looking when rendered at high oblique viewing angles or close
to the horizon.

The desired behavior is a dissipation mechanism that increases line
transparency as the camera approaches that state, either as a built-in
renderer behavior or as a style-configurable feature.

### Current limitation

The current style system does not expose camera pitch as a normal style
expression input for line color, and geodata line color is currently
resolved in worker-generated render jobs rather than evaluated per
frame.

### Suggested direction

Possible implementation directions:

- add a built-in line dissipation behavior tied to camera pitch,
  horizon angle, or a related renderer-space measure
- expose a camera-dependent style input so line opacity or color can be
  driven from style
- prefer transparency / dissipation over a hard visibility cutoff so
  ridgeline boundaries fade out naturally instead of popping

### Notes

There is already tilt-aware runtime behavior in geodata reduction, so
the renderer does have camera-angle information available. The missing
piece is a render-time color / opacity path for geodata lines.

## BUG: `Viewer.checkVisibility()` depth comparison is broken

**Opened:** 2026-04-14
**Status:** deferred — method kept on the API surface but marked
experimental; the waypoint demo was reverted to not use it.

### Symptom

For a point sitting on the terrain surface the comparison always fails:
`pointDepth` is consistently 700–10 000 m larger than `screenDepth`,
so the method returns `false` (occluded) even when the point is plainly
visible.

### Root cause (confirmed by instrumentation, 2026-05-04)

`screenDepth` and `pointDepth` measure different things when vertical
exaggeration (super-elevation) is active.

* **`screenDepth`** — decoded from the hitmap texture. The GPU shader
  writes the Euclidean distance from the camera to each rendered terrain
  fragment. Because VE is applied on the GPU, this distance is to the
  **visually rendered (VE-exaggerated) surface**.

* **`pointDepth`** — computed as
  `Math.hypot(...convertCoordsFromPhysToCameraSpace(physPos))`.
  `convertCoordsFromPhysToCameraSpace` subtracts `map.camera.position`
  from the physical (ECEF) world-space point. `getHitCoords` adds the
  same quantity when reconstructing position from the hitmap, so the
  two operations cancel and the coordinate arithmetic is correct.
  However, `getHitCoords` applies `getUnsuperElevatedHeight` before
  returning nav coords, stripping the VE height offset. When those
  SE-adjusted nav coords are converted back to phys and then to
  camera-space, the result is the distance to the **true geographic
  surface**, not the rendered one.

Verified by disabling VE at runtime: with VE off and `dilate=0`,
`pointDepth` and `screenDepth` are identical. With VE on the gap is
proportional to VE scale; at the test position (~33 km view distance)
it was ~503 m.

The camera-origin mismatch described in the earlier analysis was
incorrect: `map.camera.position` is the correct reference, and
`convertCoordsFromPhysToCameraSpace` produces the right result. The
`// mmm` comment in `convert.js:280` refers to a different code path.

### Suggested fix direction

`checkVisibility` must compare in the same domain. Two options:

1. **Compare in the rendered domain.** Get the screen pixel the point
   projects to, sample `getScreenDepth` there, then compare against the
   distance from the camera to the VE-adjusted position of the point.
   Requires applying VE to the point's position before computing
   `pointDepth`.

2. **Compare in the geographic domain.** Use `getHitCoords` at the
   projected screen pixel to get the true surface position, convert to
   phys, compute camera-space distance, and compare against the same for
   the input point. Both values are then geographic distances with VE
   stripped out.

### Relevant files

| File | Note |
|---|---|
| `src/browser/viewer.ts` | `checkVisibility()` — the broken method |
| `src/core/map/interface.js:232` | `convertCoordsFromPhysToCameraSpace` |
| `src/core/map/convert.js:258` | `getPositionCameraSpaceCoords` (flagged comment) |
| `src/core/map/camera.js` | `MapCamera.update()` — shows GL eye is at `[0,0,0]` |
| `src/core/renderer/gpu/shaders.js:850` | shader writes `camDist = length(camSpacePos.xyz)` |
| `src/core/renderer/renderer.ts:1828` | `getDepth()` — decodes hitmap pixels |
| `demos/waypoint/waypoint.js` | the demo that was reverted |
