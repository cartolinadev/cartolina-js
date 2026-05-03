# Session log

## 2026-05-03 — Resurrect feature/render-targets

### Goal

Resurrect the orphan branch `feature/render-targets` (RenderTarget
abstraction refactor). The branch was abandoned due to a visual
regression in the label hierarchy.

Plan:
`/home/prochazka/.claude/plans/there-is-an-orphan-frolicking-noodle.md`

### Branches

- `fix/render-targets` — cherry-pick of `ce20f7a` onto main, with the
  render-target fix and diagnostics during investigation.
- `diag/main-labels` — main HEAD with identical diagnostic
  instrumentation (used as the correct-behavior reference).

### Diagnostic setup

Viewport: **1280×800** (Playwright headless). User's viewport is
1920×1080; at 1280×800 Brennkogel appears on both branches (not a
useful regression indicator). Use **Figerhorn** and **Kreuzwandspitze**
as the regression indicators at 1280×800.

Test script: `test/diag-labels.js` — loads the `complex-terrain` URL
on the dev server, waits 12 s, prints console output.

### What has been established empirically

**Feature IDs:**
- Figerhorn = OSM id **1712141446**, prominence 50.7
- Kreuzwandspitze = OSM id **2667064383**, prominence 51.2

**Sort order** (`radixSortFeatures` output, `featureCacheSize=209`):
Both branches produce **identical** top-25. Figerhorn ranks #10,
Kreuzwandspitze ranks #12. The bug is NOT in the sort.

**Placement loop** (`gmap6-place` log, logged inside `processGMap6`
for every feature when `featureCacheSize=209`):
- `diag/main-labels`: Figerhorn **OK** at cnt=15, Kreuzwandspitze
  **OK** at cnt=17. `pp=[195,468]`, `rect=[161,478,230,524]`.
- `fix/render-targets` before the fix: Figerhorn **SKIP** at
  cnt=14, Kreuzwandspitze **SKIP** at cnt=15. Same `pp` and `rect`.
- `fix/render-targets` after preserving the screen camera aspect for
  offscreen passes: Figerhorn **OK** at cnt=15, Kreuzwandspitze
  **OK** at cnt=17 through late settled frames.

**rmap.clear() reads `renderer.curSize`** (lines 36-37, 46, 52-53
in `rmap.js`). On `fix/render-targets`, `curSize` is a getter
returning `currentRenderTarget.logicalSize`. The leading hypothesis was
that `rmap.clear()` was seeing the 1024×1024 hitmap target. Logging
ruled this out: failing frames cleared the rmap at `1280×800`.

The actual regression was in `Renderer.switchToFramebuffer()`.
The render-target refactor routed all offscreen targets through
`updateLogicalSize()`, which calls `camera.setAspect(width / height)`.
For square hitmap targets this changed the camera aspect to `1`.
Legacy rendering changed `curSize` to the hitmap size and updated the
camera, but left the screen camera aspect intact. That is why the
depth map no longer matched screen-coordinate label depth checks.

Fix: bind the framebuffer target and viewport for `depth`, `geo`, and
`geo2` passes, but do not call `updateLogicalSize()` for those offscreen
passes. The base canvas pass remains responsible for syncing the screen
logical size and camera aspect.

Diagnostics were removed after the fix.

### Follow-up documentation

Added `render-targets.md` to document the render-target ownership rule:
auxiliary hitmap buffers are storage for the current screen view, so they
bind their framebuffer and viewport without changing camera aspect.

### Legacy render-to-image removal

Removed the unused legacy `Map.renderToImage()` path. It rendered the
current map view into a temporary power-of-two framebuffer texture and
read pixels back from it, but no demos, tests, or browser UI called it.
The real screenshot shortcut uses `Renderer.saveScreenshot()` and
`rendererAllowScreenshots`.

Removed with it:
- `MapInterface.renderToImage()`
- `MapDraw.drawToTexture()`
- the `texture` mode in `Renderer.switchToFramebuffer()`
- unused power-of-two helpers in `utils.ts`

### Screenshot test note

Parallel `test/screenshot.js` runs repeatedly triggered intermittent CDN
tile/resource fetch failures. Added an `AGENTS.md` note to run canonical
screenshot captures sequentially until that behavior is diagnosed.

### Rendering size documentation

Added `rendering-sizes.md` to document the renderer's size vocabulary:
canvas layout size, physical backing size, CSS visual scale, render-target
viewport size, render-target logical size, and `renderer.curSize`.
The page records the intentional reveal-style behavior where label
placement stays in pre-transform canvas coordinates while pixel-sized
visual features compensate with `visibleScale()` so labels keep stable
visible sizes under CSS transforms.

### Offscreen render-pass backlog

Added a backlog entry for the future offscreen render-pass API. It keeps
`GpuDevice.setRenderTarget()` as a low-level binding operation and calls
for higher-level pass setup to distinguish screen auxiliary targets from
independent targets, so shadow maps, selective blur, zenith rendering,
and future multipass work do not reintroduce hidden camera mutations.

### `curSize` clarification

Clarified that `renderer.curSize` is a backward-compatibility getter for
legacy code, not a recommended size source for new renderer work. Do not
use `curSize` in new code; choose explicit canvas, render-target logical,
viewport, or visual-scale sizes according to intent.

Also clarified `RenderTarget.logicalSize`: it is the width and height of
the target-local 2D coordinate system used when mapping projected NDC
coordinates into draw positions and when building `imageProjectionMatrix`,
not another name for physical framebuffer pixels.

Added `renderer-coordinate-spaces.md` to define renderer projection,
target-local 2D coordinates, screen-space draw helpers, and their
relationship to GL viewport pixels. This removes implicit terminology
from the render-target size docs.

### Framebuffer readback cleanup

Removed the legacy hitmap readback `fastMode` behavior for
`mapDMapMode == 2`; mode 2 now follows the normal direct readback path.
Moved framebuffer readback binding into `GpuDevice.readFramebufferPixels()`
and removed public raw framebuffer binding from `GpuTexture`, so render
target switching remains the only public draw-target operation.

Added the missing JSDoc for the new readback methods and exported GPU
types. Updated `AGENTS.md` to require a pre-commit check that new public
TypeScript methods and exported types have JSDoc in the same commit.

Clarified `AGENTS.md` module-placement guidance: new TypeScript modules
belong where the architecture says they belong, not automatically under
`src/core/`.

Removed `GpuDevice.canvasRenderTarget` as shared mutable side storage.
`Renderer` now creates the canvas render-target object from the current
`pixelSize` and `canvasCssSize` whenever it binds the base canvas pass.

Added field-level JSDoc for `GpuDevice` render-target types so
`viewportSize` and `logicalSize` are defined in code as well as in the
wiki.

## 2026-04-19 — Trajectory: nadir departure + extent-proximity duration patches

### Goal

Fix two independent cases where ballistic flight duration was too long
relative to what was visually meaningful:

1. Departing from nadir (straight-down) view: yaw rotation during the
   departure phase is invisible, wasting `headingDuration` ms.
2. Translating a short distance within a tight viewport: the linear travel
   phase is barely perceptible, yet still consumed the full computed time.

### Work done

**`src/core/map/trajectory.js`** — two additions at the end of
`detectDuration()`:

**Patch 1 — near-nadir departure** (pre-existing; documented here):
- `headingDurationStart` is now independent of `headingDuration`.
- When `startPitch < −60°`, `headingDurationStart` is scaled toward 0 via
  `nadirFactor = (pitch + 90) / 30` (1 at −60°, 0 at −90°).
- `duration` is trimmed by the saved departure phase, floored at
  `minDuration`.

**Patch 2 — extent-proximity short flight** (new this session):
- After the nadir patch, checks whether `distance < min(e1, e2)`.
- If so, scales only the linear travel portion of `duration` by
  `max(distRatio, 0.2)`, where `distRatio = distance / min(e1, e2)`.
- Arrival phase (`headingDuration`) is left unchanged.

**`docs/wiki/trajectory-behavior.md`** — new reference page covering
phase structure, base duration rules, and both patches with worked
examples.

**`docs/wiki/index.md`** — added entry for `trajectory-behavior.md`.

### Non-obvious findings

- Using `meanExtent` instead of `min(e1, e2)` as the reference incorrectly
  triggers the short-flight patch on large-scale-change transitions (e.g.
  krkonose regional → central Europe continental). The mean of a small and
  a large extent is mid-range, so a 105 km flight falsely appears "short"
  and gets compressed to ~950 ms of travel with a 2,700 ms zoom-out
  at the destination — exactly the disorienting "pan then zoom" artifact.
  `min(e1, e2)` is the conservative bound: if the distance fits inside the
  *smaller* viewport, the travel is genuinely imperceptible from that view.

- The arrival `headingDuration` phase holds position at the destination
  while orientation settles. Extent and FOV continue interpolating via the
  raw double-smoothstep factor during this time. Compressing the linear
  phase while keeping `headingDuration` unchanged therefore makes the
  zoom-out/zoom-in portion appear to happen *after* the pan rather than
  during it when the two extents differ greatly — another reason to keep
  the patch scoped to same-scale transitions.

## 2026-04-15 — Added pitch-related styling limitations to reference

### Goal

Capture the non-obvious findings from checking whether line color can
depend on camera pitch.

### Work done

**`docs/wiki/label-styling-engine.md`**
- Added that camera pitch is not currently exposed as a normal style
  expression input.
- Documented the nearby precedent that tilt-aware behavior already
  exists for `dynamic-reduce` through `tilt`, `tilt-cos`, and
  `tilt-cos2`.
- Added the architectural note that geodata line color is resolved in
  worker-generated render jobs rather than at draw time, so exposing a
  `#pitch` variable alone would not be enough for live pitch-driven
  line color changes.

## 2026-04-15 — Backlog note for line dissipation by view angle

### Goal

Record the need for a future line-dissipation feature so the visual
motivation and likely implementation shape are not lost.

### Work done

**`docs/wiki/backlog.md`**
- Added a deferred feature item for pitch / horizon-based line
  dissipation.
- Captured the visual motivation: ridgeline-following boundaries become
  noisy and unnatural at high oblique angles and near the horizon.
- Noted the likely desired behavior: increased transparency as the view
  approaches that state, preferably as a built-in or style-configurable
  mechanism.
- Recorded the current limitation that line color is not currently
  driven by camera pitch through normal style expressions and is baked
  into worker-generated geodata jobs.

## 2026-04-15 — Clarified legacy documentation-source wording

### Goal

Remove a ghost note in the wiki index that incorrectly implied a
separate Web Archive documentation source.

### Work done

**`docs/wiki/index.md`**
- Removed the stray Web Archive note.
- Kept `melowntech/workshop` as the legacy conceptual reference already
  being pointed to.
- Kept `cartolina-tileserver/docs/resources.md` identified as the
  authoritative source for current resource definitions.

## 2026-04-15 — Wiki index as documentation hub

### Goal

Make the wiki landing page the actual documentation starting point by
moving the broader documentation-source guidance there.

### Work done

**`docs/wiki/index.md`**
- Added an `Other documentation sources` section.
- Moved the useful orientation pointers for `README.md`,
  `vts-browser-js` wiki, `melowntech/workshop`,
  `cartolina-tileserver`, and the backend `docs/resources.md` into the
  wiki landing page.
- Kept the backend resource docs marked as authoritative.

**`AGENTS.md`**
- Replaced the duplicated documentation-source prose with a shorter
  pointer to `docs/wiki/index.md` as the canonical documentation
  starting point.

## 2026-04-15 — Styling reference and wiki drift rule

### Goal

Turn the styling wiki note into a more reference-oriented page and make
wiki drift checks an explicit repository rule.

### Work done

**`docs/wiki/label-styling-engine.md`**
- Reworked the note into a compact styling reference page.
- Documented the non-obvious default that plain `linear` and
  `discrete` expressions are implicitly LOD-based.
- Added the explicit-domain `linear2` / `discrete2` forms, built-in
  scale-related `#...` values, `lod-scaled`, and the interaction with
  `line-width-units`.
- Retained the textured-line and `texture` vs `textured` findings in a
  more reference-style structure.

**`docs/wiki/index.md`**
- Updated the entry description for the styling page to match its new
  reference-oriented role.

**`AGENTS.md`**
- Added an explicit note that the wiki may drift from the code.
- Added the rule that, at an appropriate moment or on explicit wiki
  update requests, the current session must check for wiki drift and
  update obsolete or missing information.
- Added `index.md` and `label-styling-engine.md` to the wiki file list.

## 2026-04-15 — Wiki index page

### Goal

Create a dedicated wiki landing page with a table of contents so the
wiki does not depend on `architecture.md` as its navigation hub.

### Work done

**`docs/wiki/index.md`**
- Added a dedicated wiki index page with a table of contents covering
  overview pages and narrower subsystem / feature notes.
- Added a short navigation note describing the intended direction
  toward a more hierarchical reference-manual structure.

**`docs/wiki/architecture.md`**
- Removed the temporary wiki-guide section.
- Repositioned the page as an architecture document and pointed readers
  to `index.md` for navigation.

## 2026-04-15 — Label styling engine wiki note

### Goal

Document non-obvious style-engine findings discovered while checking
whether geodata lines support a dot-dash pattern.

### Work done

**`docs/wiki/label-styling-engine.md`**
- Added a focused note describing the shared `LetteringLayerBase`
  property family used by both `labels` and `lines`.
- Documented the bitmap-based textured-line path as the current way to
  achieve custom repeated line patterns.
- Recorded the current `line-style` spelling mismatch:
  TypeScript declares `textured`, while the runtime validator accepts
  `texture`.
- Described the effective shape and meaning of
  `line-style-texture`.

### Non-obvious findings

- The style engine has no dedicated numeric dash-array property for
  geodata lines. Patterned lines are authored as repeated bitmap
  strips.
- The `labels` and `lines` layer types share one broader styling base,
  which is why line-decoration properties live next to text and icon
  properties in the style spec.

## 2026-04-14 — Illumination style spec cleanup

**Branch:** feature/relief-lab

### Goal

Wire illumination, vertical exaggeration, atmosphere, and map config
flags correctly into the style spec, and make colour fields consistent
with the rest of the codebase.

### Work done

**`src/core/map/style.ts`**
- Added `config?: Record<string, unknown>` to `StyleSpecification`.
  `loadStyle` iterates it and calls `map.setConfigParam()` for each
  entry, so any map config flag can be set from style with factory
  options acting as override. See architecture note on the known
  awkwardness of this block.
- Moved `diffuseColor` from `IlluminationSpecification` into
  `LightSpecification`, where it belongs semantically alongside
  `specularColor`.
- Renamed `specular` → `specularColor` in `LightSpecification` for
  consistency.

**`src/core/map/map.d.ts`** — declared `setConfigParam(key, value)`
which was missing from the type declaration.

**`src/core/renderer/renderer.ts`**
- Updated `IlluminationDef`, the internal `Illumination` type,
  `setIllumination()`, and `getIllumination()` to match the new
  field layout (`specularColor`, `diffuseColor` inside `light`).
- Changed colour range for `specularColor` and `diffuseColor` from
  0–1 to 0–255, consistent with the rest of the style/API colour
  convention. `getIllumination()` multiplies back to 0–255 on the way
  out so the round-trip is stable.
- Added JSDoc to `IlluminationDef`.

**`demos/relief-lab/index.html`** — updated `applyIllumination()` and
`syncFromIllumination()` to use the new field names and `hexToRgb255`
/ `rgb255ToHex` helpers instead of the old 0–1 converters.

**`docs/wiki/architecture.md`** — added colour encoding convention
note, style `config` block awkwardness note, and `mario` obsolete
config key note.

**`AGENTS.md`** — expanded documentation rules: adding JSDoc to
existing non-trivial functions is encouraged; `@link` clarified to
mean all hyperlink-producing tags.

### Non-obvious findings

- `validateNumberArray` mutates its input array in place. When
  `getIllumination()` returned 0–1 values and the UI called
  `setIllumination()` with the result, the `/255` conversion fired
  again, driving colours to near-zero (black) on the third toggle.
  Fixed by making `getIllumination()` return 0–255 throughout.
- The style `config` block passes the full flat config namespace
  through to the map, which means it can set UI-level options (compass,
  search bar) that have nothing to do with visual styling. A cleaner
  split between rendering config and application config is noted in
  architecture.md as future work.

## 2026-04-14 — `Viewer.checkVisibility()` kept experimental only

### Goal

Keep the public visibility-check API available for future debugging or
iteration, but stop relying on it in the waypoint demo until its depth
comparison is made reliable.

### Work done

**`src/browser/viewer.ts`** — retained `checkVisibility(pos, mode)` on
the public `Viewer` surface, but marked it in JSDoc as experimental and
unreliable.

**`demos/waypoint/waypoint.js`** — removed the demo's dependency on
`viewer.checkVisibility(...)` and restored the original simple behavior:
markers are shown whenever their projected point is in front of the
camera, subject only to waypoint `show` / `hide` filtering.

**`docs/wiki/waypoint-spec.md`** — reverted the demo spec to the
front-of-camera-only marker behavior and noted that the public
visibility API exists but is not used by the demo.

## 2026-04-14 — `waypoint` demo: terrain-occluded marker visibility

### Goal

Hide waypoint markers when terrain in the current view occludes their
anchored geographic position.

### Work done

**`src/browser/viewer.ts`** — added `checkVisibility(pos, mode)` as a
flat public `Viewer` method. It converts public coords to nav/canvas,
samples the existing cached hitmap via `map.getScreenDepth()`, and
compares terrain depth against point depth with the same tolerant
behavior used for label occlusion.

**`demos/waypoint/waypoint.js`** — marker updates now call
`viewer.checkVisibility(...)` before placing the HTML overlay element.
Markers still use canvas projection for placement, but hidden markers
are no longer drawn through the globe.

**`docs/wiki/waypoint-spec.md`** — updated the marker loop and replaced
the old occlusion limitation note with the new depth-map behavior and
its cached-hitmap caveat.

### Non-obvious findings

The existing hitmap path is already suitable for this feature, but it
is intentionally cached and throttled by `mapDMapCopyIntervalMs`.
Waypoint occlusion therefore tracks terrain correctly without new render
paths, while still allowing a small delay during camera motion.

## 2026-04-14 — `waypoint` demo: marker filters and occlusion docs

Follow-on to the initial waypoint implementation.

### Goal

1. Document the HTML-overlay occlusion limitation (markers visible
   through the planet during cross-planetary navigation).
2. Add per-marker `show` / `hide` filter lists referencing symbolic
   waypoint names, so authors can suppress off-context markers.

### Work done

**`demos/waypoint/waypoint.js`**
- Header comment: added `DEPTH / OCCLUSION LIMITATION` and `MARKER
  VISIBILITY FILTERING` sections; updated CONFIG SCHEMA to show
  `name`, `show`, and `hide` fields.
- `_updateMarkers()`: filter step added before projection. Reads
  `this._config.positions?.[this._index]?.name` and tests against
  `marker.show` / `marker.hide` before any coordinate conversion.

**`demos/waypoint/config.example.json`** — added `"name"` to all
three positions; added `"show": ["whitney"]` to the clip-art marker.

**`docs/wiki/waypoint-spec.md`** — updated config schema, marker
update loop, and added occlusion limitation section; updated
Modified files list to reflect the actual screenshot.js changes.

### Key decision

`show` / `hide` reference symbolic waypoint names (not indices) so
filters remain stable when positions are reordered or new entries
are inserted.

## 2026-04-14 — `waypoint` demo: implementation

See [waypoint-spec.md](waypoint-spec.md) for the full specification.

### Goal

New `demos/waypoint/` demo: a geographic story / presentation device.
Arrow-key navigation flies the camera between a JSON-configured list
of map positions. HTML image markers stay pinned to geographic
coordinates. Embeddable as a vanilla ES module in reveal.js
presentations.

### Work done

**`demos/waypoint/waypoint.js`** — self-contained vanilla ES module.
Exports `WaypointMap`. Manages flyTo navigation, marker projection
loop (subscribes to `'tick'`), keyboard handler, and lifecycle.

**`demos/waypoint/index.html`** — demo page. Fetches and
placeholder-expands the style (same `__backend__` pattern as
`demos/map/`) before passing the object to `WaypointMap`. URL params:
`style=`, `config=`, `backend=`.

**`demos/waypoint/config.example.json`** — three positions (Whitney,
Grossglockner, Glacier Peak) and one marker using the clip-art URL.

**`src/browser/viewer.ts`** — added
`convertCoordsFromPublicToNav()` and `convertCoordsFromNavToCanvas()`
in the "Hit testing and coordinate conversion" section.

**`src/core/map/interface.d.ts`** — declared both new methods on
`MapInterface`.

**`test/screenshot.js`** — added `${config}` substitution; fixed
template fallback logic so `{ "dev": "waypoint" }` entries are
gracefully skipped on the prod side rather than falling back to the
default CDN template.

**`demos/index.html`** — new demo index listing six demos:
simple-terrain, complex-terrain, map, relief-lab, depth-test,
waypoint.

### Key decisions

- **Module shape:** vanilla ES module in `demos/waypoint/waypoint.js`.
  No webpack entry; loaded directly alongside `cartolina.js`.
- **Marker anchor:** bottom-center of the image sits on the geo point.
  Default display height 90 px, proportional width. Overridable via
  `height` / `width` per marker.
- **Terrain-surface markers:** `coords` with 2 elements (lon/lat)
  uses `'float'` height mode; 3 elements uses `'fix'`.
- **Reveal.js:** one-reveal-slide-per-waypoint pattern. `keys: false`
  disables keyboard listeners. Slides without `data-waypoint` are
  skipped; mixed decks work.
- **Style template expansion:** lives in `index.html`, not in
  `WaypointMap`. The class accepts a pre-resolved style object,
  keeping it backend-agnostic.

### Non-obvious findings

- The `convertCoordsFromNavToCanvas` return value uses `depth <= 1`
  to indicate a point is in front of the camera (consistent with
  the existing `measure.js` usage in `src/browser/ui/`).
- The screenshot test `buildUrl` function silently fell back to
  `default` when a template object omitted a side (e.g. prod). This
  caused incorrect prod URLs for dev-only templates. Fixed by
  returning `null` instead of falling back.
- CDN-hosted styles contain `__backend__` placeholders even when
  fetched directly; expansion must happen before `cartolina.map()`
  receives the object.
- `_buildMarkers` originally set `containerEl.style.position =
  'relative'` unconditionally, collapsing a `position: absolute;
  top: 0; bottom: 0` container to zero height. Fixed by checking
  `getComputedStyle(el).position === 'static'` first.

### Verification

- `npx tsc --noEmit` passes.
- `node test/screenshot.js simple-terrain` — dev ok, prod ok.
- `node test/screenshot.js complex-terrain` — dev ok, prod ok.

## 2026-04-14 — Style validation moved to exact typia

**Branch:** feature/strict-ts-checks

### Spec

Enable exact typia validation for style objects and widen the TypeScript
style schema so the shipped demo styles validate cleanly without the
previous manual top-level key check.

### Work done

**`src/core/map/style.ts`** now uses
`typia.createValidateEquals<MapStyle.StyleSpecification>()`.

The style schema was widened to reflect the actual stylesheet language
currently in use:

- `'vertical-exaggeration'` remains the canonical field name.
- `constants` and `bitmaps` now use a recursive expression type instead
  of placeholder `any`.
- The expression type covers the object-form operators used by the
  demos and supported by `worker-style.js`, including `if`, arithmetic
  operators, `linear2`, `discrete2`, `logScale`, `str2num`,
  `uppercase`, `round`, and related helpers.
- Lettering layers now explicitly allow computed local fields with
  `&...` keys instead of relying on a blanket loose object shape.
- The internal free-layer stylesheet compilation path was tightened to
  use concrete types instead of `any`.

### Non-obvious findings

- Exact validation was viable once the real stylesheet DSL was modeled
  directly in TypeScript. The earlier need for a hand-written top-level
  key check was a schema-gap problem, not an inherent typia limitation.
- The important compatibility boundary is the stylesheet language
  actually accepted by `worker-style.js`, not just the visible top-level
  style object shape.
- The demo styles did not reveal any suspicious authored values in this
  pass; the main missing piece was the recursive expression vocabulary.

### Verification

- `npx tsc --noEmit` passes.
- All demo styles under `demos/map/styles/*.json` load in the browser
  smoke test with no style-validation errors.
- `node test/screenshot.js simple-terrain` passes in dev and prod.
- `node test/screenshot.js complex-terrain` passes in dev and prod.
- `node test/screenshot.js full-terrain` passes in prod; dev still hit
  external fetch failures, so treat that as a data-path verification gap
  rather than an exact-validation regression.

## 2026-04-13 — Style validation tightened around top-level schema

**Branch:** feature/strict-ts-checks

### Spec

Make style validation catch typoed top-level fields such as
`verticalExaggeration`, align the TypeScript style spec with the
canonical `vertical-exaggeration` wire key, and remove the `as any`
escape hatch from vertical-exaggeration loading.

### Work done

**`src/core/map/style.ts`** — changed `StyleSpecification` to use the
canonical `'vertical-exaggeration'` key, removed the direct `any`
escape when reading it, and routed validation through a new
`validateStyleSpecification()` helper.

That helper keeps typia's existing structural validation for nested
objects but adds exact checking for the top-level style object. Unknown
top-level keys now fail validation with a direct error, and the common
camelCase typo suggests the supported hyphenated spelling.

The same pass also corrected two style-spec mismatches surfaced by the
stricter check:

- `label-origin` is typed as a string-valued property.
- `zbuffer-offset` uses the runtime spelling already consumed by the
  geodata worker and demo styles.

### Non-obvious findings

- Full `typia.createValidateEquals()` exactness was too disruptive for
  the current style ecosystem. Existing demo styles use nested
  expression objects and legacy ad-hoc keys that are accepted by the
  runtime but not representable as an exact recursive schema yet.
- The practical boundary today is therefore: exact top-level style
  object, permissive nested structures.
- The earlier `verticalExaggeration` / `vertical-exaggeration`
  mismatch had gone unnoticed because typia's non-exact validator does
  not reject unknown extra keys.

### Verification

- `npx tsc --noEmit` passes.
- All example styles under `demos/map/styles` load in the demo app with
  no style-validation errors.
- A deliberate camelCase `verticalExaggeration` style fails with:
  `did you mean 'vertical-exaggeration'?`
- `node test/screenshot.js simple-terrain` passes in dev and prod.
- `node test/screenshot.js full-terrain` passes in dev and prod.
- `node test/screenshot.js complex-terrain` passes in prod; dev hit
  remote geodata fetch failures, so treat that as an external data-path
  verification gap rather than a validator regression.

## 2026-04-13 — Strict TypeScript completed

**Branch:** feature/relief-lab

### Spec

Enable `"strict": true` in `tsconfig.json` and fix all resulting
errors so the codebase compiles cleanly under strict mode.

### Work done

Strict mode now compiles cleanly. The work started from a large batch of
implicit-`any` errors and finished with a smaller set of real nullability,
discriminated-union, and tooling-path issues in the render and style
loading paths.

The outcome included both code changes and migration-rule cleanup:

- **`AGENTS.md`** — added `npx tsc` to the auto-approved command list
  and tightened the JS→TS migration guidance: do not use `any` /
  `unknown` when the real shape already exists in `types.ts`, a sibling
  `.d.ts`, or an imported legacy `.js` module.
- **`src/core/map/interface.d.ts`** — added the missing declaration next
  to the legacy ES5 `MapInterface` implementation so TypeScript callers
  consume concrete method signatures instead of inferred `any`.
- **`src/browser/index.ts`** — removed `unknown` from
  `MapRuntimeOptionValue`; that union had collapsed the whole type to
  `unknown`.
- **`src/browser/viewer.ts`** — replaced placeholder types on the new
  public API with concrete runtime/config shapes.
- **`src/core/map/tile-render-rig.ts`** and
  **`src/core/renderer/renderer.ts`** — resolved the remaining strict
  issues without weakening types, mainly by tightening discriminated
  unions and handling actual nullable states.
- **`src/core/map/style.ts`** — replaced the ad-hoc `any` mapConfig
  load with a concrete local `SurfaceMapConfig` type and narrowed the
  typia validation failure branch explicitly.
- **`src/types/globals.d.ts`** — added `declare module '*.css'` so the
  browser entrypoint's side-effect stylesheet imports are accepted by
  editor and webpack TypeScript tooling.

### Non-obvious findings

- A union that includes `unknown` is just `unknown`, so it silently
  defeats the whole annotation.
- The final strict failures were not more annotation work; they were
  actual model inconsistencies such as maybe-null GPU resources and
  optional layer fields that needed proper narrowing.
- `npx tsc --noEmit` and the webpack/editor TypeScript path do not
  always fail on the same set of issues. CSS side-effect imports and
  typia narrowing in `style.ts` were caught by the latter.

### Verification

- `npx tsc --noEmit` passes.
- `node test/screenshot.js simple-terrain` passes in dev and prod.
- `node test/screenshot.js complex-terrain` passes in dev and prod.
- `node test/screenshot.js full-terrain` still reports remote tile fetch
  failures in both dev and prod; treat this as an external verification
  gap rather than a local compile/runtime regression.

## 2026-04-13 — dist build regression after BrowserInterface removal

**Branch:** feature/relief-lab

### Spec

Restore the production dist bundle after the `Viewer` migration:
`cartolina.min.css` had disappeared from output and the legacy browser
API shape had regressed.

### Work done

**`src/browser/index.ts`** — moved browser CSS imports to the browser
entry module so webpack still emits `cartolina.min.css` and
`cartolina.min.css.map` after wrapper refactors.

### Non-obvious findings

- Removing `BrowserInterface` also removed the only browser-CSS side
  effect imports, so webpack silently stopped emitting the stylesheet.

- The missing browser CSS was enough to mimic a major runtime failure:
  the browser/map wrapper lost its full-size layout and the generic
  fallback "needs WebGL capable browser" overlay became visible because
  CSS, not code, hides it by default.

## 2026-04-13 — Viewer TS API and JS→TS migration groundwork

**Branch:** feature/relief-lab

### Spec

Establish `Viewer` as the typed TypeScript public API surface, put
migration rules in place, and apply them to a first concrete case.

### Work done

**`src/browser/viewer.ts`** — new `Viewer` class wrapping `Browser` /
`CoreInterface`. Flat, typed method surface covering lifecycle, events,
camera, render control, coordinate conversion, and hit-testing.
Exported as the type alias `Map` from the package index.

**`src/core/types.ts`** — shared primitive types for the core layer:
`HeightMode`, `Lod`, `CoreEventMap`. `CoreEventMap` types the event
name parameter on `on()` / `once()` so unknown event names are a
compile error.

**`src/core/interface.d.ts`** — declaration file alongside
`interface.js`, replacing the earlier `ICoreInterface` boundary
interface in `types.ts`. Shape declaration co-located with
implementation.

**`src/core/map/surface-tile.d.ts`** — declaration file alongside
`surface-tile.js`, covering the properties accessed by
`tile-render-rig.ts`. Replaced the local `SurfaceTile` adapter type
that was defined at the bottom of that file.

**`AGENTS.md`** — JS→TS migration rules section added (when to use
direct JS references, `.d.ts`, or `types.ts`).

**`docs/wiki/architecture.md`** — event bus, kill pattern, and
Browser→Viewer dissolution goal documented.

### Design decisions

- No parallel boundary interfaces (`IFoo` in a separate file). Use
  `.d.ts` next to the `.js` for complex shapes; use `types.ts` for
  simple reusable primitives. Both patterns validated this session.

- `Viewer` is the only place for new public functionality. `Browser`
  is legacy infrastructure on the path to dissolution — nothing new
  goes there.

- `CoreEventMap` payloads typed as `unknown` for now; the value is
  in the typed event names, not the payloads.

### Non-obvious findings

- `@ts-ignore` is not needed on JS module imports under `allowJs`.
  TypeScript resolves them cleanly without it.

- A single `as T` cast is sufficient when the source is `any`.
  The `as unknown as T` double cast is only needed when both the
  source and target are concrete, non-overlapping types.

- `.d.ts` alongside `.js` works correctly under `allowJs: true` —
  TypeScript prefers the `.d.ts` over inferred JS types even when the
  JS file is part of the compilation. The pattern is valid for
  incremental migration.


## 2026-04-12 — labels render flag

**Branch:** main

### Spec

Add a `labels` render flag (`useLabels`, `FlagUseLabels`) that
suppresses style-defined labels from the user’s perspective and expose
it through map options, diagnostics render-flags mode, and
`demos/relief-lab`.

### Design decisions

- The public-facing `labels` flag is implemented by suppressing the
  geodata/free-layer render paths in the draw loop, because authored
  label layers are compiled into synthetic geodata free layers.
- The effective value follows the same precedence as the other render
  flags: `renderer.debug.flagLabels ?? map.config.mapFlagLabels`.
- The flag is propagated through the frame render-flags UBO even though
  no current shader consumes it directly.
- Geodata hit-testing is gated by the same effective flag so hidden
  labels do not remain hoverable or clickable.
- Diagnostics render-flags mode uses plain `k` for labels, leaving the
  existing `Shift+K` “all labels” debug shortcut intact.

## 2026-04-12 — relief-lab atmosphere controls

**Branch:** main

### Spec

Add live atmosphere controls to the `Light & Shading` tab in
`demos/relief-lab`, with public core/browser API readback and update
support.

### Design decisions

- The public atmosphere API exposes only the three runtime-tunable
  fields: `maxVisibility`, `visibilityToEyeDistance`, and
  `edgeDistanceToEyeDistance`. These are defined on
  `Atmosphere.RuntimeParameters`; `Atmosphere.Specification` is derived
  as `MapBody.Atmosphere & RuntimeParameters` (not the reverse) to avoid
  duplicating the field definitions.
- `setAtmosphere()` / `getAtmosphere()` are on `CoreInterface` and
  `BrowserInterface` only. They reach `map.atmosphere` directly — the
  renderer interface is not in the chain.
- `markDirty()` is called inside `Atmosphere.setRuntimeParameters()`
  via `this.renderer.core.map.markDirty()`, so the interface layer does
  not need to handle it.
- The `useAtmosphere` render flag remains the master on/off switch and
  is replicated at the top of the new panel section; disabling it does
  not discard the authored atmosphere parameter state.
- The two ratio parameters remain presence-based optionals, so the UI
  uses checkboxes to control whether each field is authored at all.

## 2026-04-12 — relief-lab demo and runtime-state sync

**Branch:** main

### Spec

Implement `demos/relief-lab/index.html` from
[docs/wiki/relief-lab-spec.md](relief-lab-spec.md), then make the demo
follow live map state rather than initializing itself from style JSON.

### Design decisions

- Added public renderer readback for illumination, rendering options,
  and vertical exaggeration, proxied through renderer/core/browser
  interfaces, so the demo can treat the map as the source of truth.
- `setIllumination()`, `setRenderingOptions()`, and
  `setVerticalExaggeration()` now mark the map dirty so runtime changes
  redraw immediately.
- The demo polls those public getters on each `tick` and reconciles its
  controls from live renderer state instead of reading style internals.
- Rendering-option overrides remain on `renderer.debug`; the public API
  intentionally reuses that existing storage rather than introducing a
  second override layer.
- `useLighting` remains part of illumination rather than
  `RenderingOptions`; the frame render flag follows
  `illumination.useLighting` through the existing illumination-state
  path.
- `diffuseColor` was added to the authored illumination spec and
  renderer runtime, replacing the previous hardcoded white diffuse term.

## 2026-04-11 — Geographic illumination mode

**Branch:** main

### Spec

Add a second illumination light type, `geographic`, alongside the
existing observer-relative `tracking` light.

### Design decisions

- The public light shape stays shared across modes:
  `{ type, azimuth, elevation, specular? }`, with legacy tuple syntax
  kept for `tracking` only.
- Runtime illumination state stores one authored vector plus the two
  renderer-facing derived vectors, `vectorNED` and `vectorVC`.
- `tracking` keeps the existing lNED-authored behavior: `vectorVC` is
  initialized once in `setIllumination()`, while `updateIllumination()`
  recomputes only `vectorNED`.
- `geographic` authors the vector in scene-center NED: `vectorNED` is
  initialized once in `setIllumination()`, while
  `updateIllumination()` derives only `vectorVC` through the existing
  `ned2lned`/`ned2vc` path.
- `setIllumination()` is now proxied on renderer, core, and browser
  interfaces just like `setVerticalExaggeration()`.

### Non-obvious finding

Style loading can call `setIllumination()` before `map.position` is
initialized. The geographic runtime recompute therefore needs a guarded
initialization path and must defer the full position-dependent update to
the first render-frame refresh.

## 2026-04-11 — Fully functional aspect-based shading

**Branch:** main

### Spec

Finish the previously plumbed aspect shading mode so it affects diffuse
terrain shading together with Lambertian and slope shading.

### Design decisions

- `diffuseCoef()` now centralizes the shading combination logic instead
  of duplicating the per-term calculations inline in `main()`.
- The combined shading formula is treated as a weighted geometric mean
  of the three shading coefficients' complements, then remapped back to
  the final shading coefficient.
- The accumulator was named `diffuseComplement` to reflect the math more
  accurately than the earlier `invDiffuseCoef`.

### Non-obvious finding

Aspect shading produced black speckles on nearly flat terrain. The
underlying issue was not the weighted-product formula itself but numeric
instability in the projected-direction cosine used by the aspect term:
on flat areas the tangent-plane projection of the normal approaches
zero, so aspect needs a neutral fallback in those degenerate cases to
avoid visible artifacts.

## 2026-04-11 — Aspect shading flag/weight plumbing

**Branch:** main

### Spec

Add a third diagnostic/configurable shading mode, `aspect`, following
the existing Lambertian and slope plumbing. The new mode must expose:

- `mapShadingAspect` config flag, default `false`
- `shadingAspectWeight` illumination/style option, default `0.25`
- renderer debug override and frame-UBO propagation
- diagnostic render-flags toggle on plain `x` inside `Shift+F`

The fragment shader must receive the new flag and weight but must not
change rendered output yet.

### Design decisions

- Aspect shading uses the next render-flag bit after slope
  (`FlagShadingAspect = 1 << 9`).
- `shadingParams.z` carries the aspect weight; `w` stays reserved.
- The diagnostic shortcut remains `a` for atmosphere; aspect uses `x`
  to avoid conflicting with the existing render-flags key map.

### Non-obvious finding

The tile fragment shader already computes an `aspectCoef`, so the
plumbing work only needed a no-op reference to the new flag/weight to
keep them live without changing shading behavior.

## 2026-04-10 — Scale-denominator vertical exaggeration

**Branch:** main
**HEAD:** 4c2239734393de3a99c334699243ffc10931143e

### Spec

> *Reconstructed from session context — review for accuracy.*

Introduce a new `vertical-exaggeration` style interface with two
independent components:

**1. Elevation ramp** — piecewise linear by terrain height, same
semantics as the existing `heightRamp`. Specified as two pivot pairs:

```yaml
vertical-exaggeration:
  elevationRamp:
    min: [height_min, factor_min]
    max: [height_max, factor_max]
```

**2. Scale-denominator ramp** — power-law function of the CSS scale
denominator. Specified as two pivot pairs:

```yaml
vertical-exaggeration:
  scaleRamp:
    min: [sd_min, va_min]
    max: [sd_max, va_max]
```

The scale denominator is a cartographic quantity independent of canvas
size and DPI:

```
sd = extent / (cssH_px / cssDpi * 0.0254)
```

where `cssH_px` is the apparent canvas height in CSS pixels and
`cssDpi` defaults to 96.

The ramp is log-log linear (power law) between the two pivots:

```
va(sd) = va_min * (sd / sd_min) ^ (log(va_max / va_min) / log(sd_max / sd_min))
```

At `sd = sd_min` this returns `va_min`; at `sd = sd_max` it returns
`va_max`. Outside the range, `sd` is clamped.

**Compatibility:** The legacy `heightRamp` / `viewExtentProgression`
style syntax must continue to work. It is converted internally to the
new `veScaleRamp` representation using a canonical canvas height of
1113 CSS px (the historical tuning baseline), giving 1:1 behavioural
equivalence at that height.

**New public method** `setVerticalExaggeration(spec)` on `Renderer`,
proxied on `RendererInterface`, `CoreInterface`, and `BrowserInterface`.

**New config param** `rendererCssDpi` (default 96) for deployments
where CSS DPI differs from the standard.

### Design decisions

- The internal type `VeScaleRamp { sd0, va0, sd1, va1, exponent }`
  replaces `SeProgression`. The exponent is precomputed as
  `log(va1/va0) / log(sd1/sd0)`.

- Legacy `viewExtentProgression` input is converted to `veScaleRamp` at
  load time using a canonical 1113 CSS px height. This value matches the
  historical tuning baseline (maximized browser window on the development
  machine), giving a 1:1 behavioural match for existing styles.

- `VerticalExaggerationSpecification` in `style.ts` is a strict
  discriminated union: new format (`elevationRamp`/`scaleRamp`) or legacy
  format (`heightRamp`/`viewExtentProgression`), never mixed.

- `rendererCssDpi` (default 96) is a new renderer config param for
  deployments where CSS DPI differs from the standard 96.

### Non-obvious finding: hitmap framebuffer and `curSize`

During label hierarchy computation, the engine periodically switches to
a fixed-size offscreen framebuffer (hitmap). This temporarily sets
`curSize = [hitmapSize, hitmapSize]`. Any code reading `this.css()[1]`
during this window gets the framebuffer height instead of the viewport
height.

**Fix:** `mainViewportCssH` — a dedicated field updated only in
`applySizes` (called on real viewport resize). `currentScaleDenominator`
uses this field instead of `this.css()[1] * this.visibleScale_[1]`.

### Renames

| Old name | New name |
|---|---|
| `getSeProgressionFactor` | `getVeScaleFactor` |
| `setSuperElevationProgression` | `setVeScaleRampFromProgression` (deprecated) |
| `seProgression` / `SeProgression` | `veScaleRamp` / `VeScaleRamp` |
