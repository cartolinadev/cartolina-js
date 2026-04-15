# Task backlog

Bugs and deferred work that are not yet scheduled.

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

### Root cause (partial — investigation stopped before confirming)

Two different things are being compared:

* **`screenDepth`** — decoded from the hitmap texture.  The GPU shader
  (`heightmapDepthVertexShader` / `heightmapDepthFragmentShader` in
  `src/core/renderer/gpu/shaders.js`) writes
  `camDist = length(camSpacePos.xyz)` where
  `camSpacePos = uMV * vec4(worldPos, 1.0)`.
  This is the Euclidean distance from the **actual OpenGL eye** (the
  camera origin used by the renderer) to each terrain fragment.

* **`pointDepth`** — computed in `Viewer.checkVisibility()` as
  `Math.hypot(...convertCoordsFromPhysToCameraSpace(physPos))`.
  That conversion (`MapInterface.convertCoordsFromPhysToCameraSpace`,
  `src/core/map/interface.js:232`) simply subtracts
  `map.camera.position` from the world-space point.

The mismatch: `map.camera.position` is **not** the GL eye.  In
`MapCamera.update()` (`src/core/map/camera.js`) the GL camera is set
with `this.camera.setPosition([0,0,0])` — the renderer always sits at
the world origin — while `this.position` is set to the full absolute
world-space position of the eye (a point on or above the ECEF
ellipsoid, on the order of 6 400 000 m from the geocentre).  The
distance subtracted by `convertCoordsFromPhysToCameraSpace` is
therefore measured from the wrong origin, producing a value that is
off by the camera-to-surface orbit distance (hundreds to thousands of
metres depending on zoom).

An existing comment in `MapConvert.getPositionCameraSpaceCoords()`
(`src/core/map/convert.js:280`) already flags this:
`// mmm, this does not look like camera space coords to me`.

There may also be a secondary issue with how `uMV` encodes tile-local
coordinates relative to the GL origin, but the primary cause is the
wrong reference point.

### Suggested fix direction

Before computing `pointDepth`, transform the physical point into the
same coordinate frame the renderer uses.  Concretely:

1. Apply the MVP matrix (`map.camera.getMvpMatrix()`) to the physical
   point as the renderer does — i.e. use
   `MapConvert.getPositionCanvasCoords` with `physical = true`, which
   already calls `renderer.project2` via the MVP path.
2. Recover the pre-projection depth from that pipeline (the
   `-z` component before the perspective divide), or alternatively
   use the `w` component of the clip-space position.
3. Compare that against `screenDepth` (which is already a Euclidean
   camera-space distance, not NDC depth).

Alternatively: reuse the existing `getHitCoords` / `hitTest` ray
machinery to reconstruct the depth at the screen pixel and compare it
against the projected point depth in a consistent unit.

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
