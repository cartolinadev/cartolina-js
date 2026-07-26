# Lettering and vector overlay rendering

See [index.md](index.md) for the wiki table of contents.

---

## What this subsystem does

Cartolina renders two distinct kinds of content on top of the terrain:
raster overlays (satellite imagery, hillshading, normal maps) and
vector-derived lettering and overlays (labels, icons, lines, polygon
fills). This page covers the second kind.

The terrain supplies geometry and elevation. The lettering subsystem
supplies everything that annotates it: place names, peak labels,
political boundaries, road overlays, watershed polygons. The
`complex-terrain` test style draws country and state boundaries,
mountain peak labels, and settlement labels, all sourced from
OpenStreetMap and positioned relative to the 3D terrain underneath.

The central challenge is that the terrain is three-dimensional and the
camera can tilt to near-oblique angles. A label must remain readable
whether the camera looks straight down or across a mountain range at a
steep angle. That constraint drives several design decisions that flat
web map renderers do not need.

### Terminology note

The internal code uses the term **geodata** throughout — a carry-over
from the VTS-geospatial stack that cartolina-js was forked from. It is
not a cartolina or cartography term, and MapLibre does not use it
either. In this document, "geodata" refers to the internal code
construct; "lettering" refers to the broader concept of styled vector
features rendered over the terrain.

On the public API, the relevant concept is exposed as label layers.

The code also calls the layer sources **free layers** — another VTS-era
name for any data layer not tightly coupled to a specific terrain tile
mesh. Free layers come in two forms:

- **`geodata-tiles`** — a tile pyramid, one JSON or binary file per
  tile, fetched on demand as the camera moves.
- **`geodata`** — a single monolithic file, loaded once and applied
  globally.

The `complex-terrain` style uses `geodata-tiles`. The monolithic form
is suited to sparse, planet-wide datasets: when the total feature
count is small, a single globally-scoped file is simpler than a tile
pyramid. The `peaklist-org-ultras` free layer from the
`a-3d-mountain-map` mapConfig map is a live example — ultra-prominent
Earth peaks from peaklist.org, delivered as one JSON file with
Earth-spanning extents.

---

## What the lettering system achieves

The system turns a stream of feature records into a stable, readable
set of visual annotations on the terrain surface. That involves several
jobs:

**Feature selection.** Only a fraction of features from any tile are
shown. Prominence-ranked selection and filter expressions control which
features make it to screen.

**Geometry classification.** Points get icons or text labels. Lines get
stroke rendering and optionally on-path text (road names). Polygons get
fill colours and optionally border strokes or labels.

**Text shaping.** Label text is laid out using SDF (Signed Distance
Field) glyph atlases. Multi-line text, line breaking, alignment, and
language fallback are all handled here.

**Collision avoidance.** Labels and icons compete for screen space. The
system maintains a screen-space occupancy grid and discards any feature
that would overlap an already-placed one.

**Temporal stability.** Labels should not flicker as the camera moves.
A hysteresis mechanism delays appearance and disappearance, trading
immediacy for visual stability.

**Density management.** In dense regions the system must limit label
count adaptively. Several tilt- and distance-aware reduction modes
control how many labels survive at a given view.

MapLibre GL JS achieves all of the same goals but with a different
architecture. Understanding that gap is useful context for any
refactoring work here; see the comparison section at the end of this
document.

---

## Data format

Each tile served by a `geodata-tiles` free layer is a JSON object (or
a compressed binary equivalent) whose top-level key is `groups`. A
group holds a bounding box, a coordinate resolution, and three feature
arrays: `points`, `lines`, and `polygons`. Each feature is an object
with a geometry field (`points`, `lines`, or `vertices`/`surface`) and
a `properties` map.

The stylesheet that controls how features look is separate from the
tile data. It is a JSON document listed under `layers` in the style
file. Each layer entry specifies:

- `source` — which free layer to draw from
- `filter` — which features to include
- `type` — `labels` or `lines` (both share the same property family
  internally; see [label-styling-engine.md](label-styling-engine.md))
- styling properties — `label`, `line`, `icon`, colors, sizes,
  expressions, and so on

The same source can be referenced by multiple style layers with
different filters and styling, producing independent visual passes over
the same feature set.

---

## Architecture of the rendering pipeline

Lettering rendering happens in two distinct phases every frame.

**Phase 1 — job collection.** Tile traversal visits all visible
free-layer tiles, ensures each tile's feature data has been processed
into GPU-ready jobs, and pushes those jobs into a z-indexed buffer
(`renderer.jobZBuffer`). This phase also covers loading, feature
processing in a web worker, and uploading vertex data to the GPU.

**Phase 2 — job dispatch.** After all traversal finishes,
`RendererDraw.drawGpuJobs()` reads the buffer in z-index order, applies
per-job culling and collision checks, and issues GL draw calls.

The two-phase split means that collision detection and draw calls happen
once, on a stable set of visible jobs, not interleaved with tile
traversal. The job buffer acts as the boundary between the two phases.

The sections below trace each phase in detail.

---

## Phase 1 — Job collection

### Frame entry

`MapDraw.drawMap()` in `src/map/draw.js` opens the frame by
clearing the job buffer:

```js
renderer.draw.clearJobBuffer();
```

Then terrain traversal and free-layer traversal run inside
`Map.withSelectionCamera()`. For each `geodata-tiles` free layer,
`layer.tree.draw()` descends the tile tree.

### LOD selection

Geodata tiles follow a fitted-frontier strategy. `drawSurfaceFit()`
descends until a tile's `texelSize` falls below the current threshold,
or until the surface's maximum LOD is reached. Matched tiles enter the
draw buffer.

If a fitted tile is not yet loaded, `drawSurfaceFit()` draws a loaded
parent as a temporary stand-in. That parent disappears once its child
is ready — it is a loading fallback, not a second steady-state LOD.

The `mapGeodataLoadMode` config option selects between traversal modes,
but fitted-frontier is the only mode that makes sense for lettering
tiles. The option is a candidate for removal.

### From tile to GPU jobs

`MapDrawTiles.drawGeodataTile()` in `src/map/draw-tiles.js`
handles a single matched tile. It creates a `MapGeodataView` for the
tile, waits for the geodata resource to load and for worker processing
to finish, then calls `MapGeodataView.draw()`.

`MapGeodataView.draw()` iterates over its `GpuGroup` objects, computes
a modelview-projection matrix for each group's bounding box, and calls
`GpuGroup.draw()`. `GpuGroup.draw()` appends each job into
`renderer.jobZBuffer` at the job's z-index slot. No GL draw calls are
issued here.

### Monolithic free layer

A `type: 'geodata'` free layer (non-tiled) goes through
`MapDraw.drawMonoliticGeodata()` instead of tree traversal. The job
buffer path is the same once the `MapGeodataView` is ready.

### Camera contexts

Tile selection and job collection run under `Map.withSelectionCamera()`.
The final `drawGpuJobs()` call runs under `Map.withNavigationCamera()`
but receives `Map.getSelectionPosition()` as an argument. This keeps
scale-dependent computations tied to the tile-selection camera position,
not the current navigation position, which matters when the freeze
diagnostic separates the two.

---

## Off-thread feature processing

Converting raw tile JSON into GPU-ready vertex buffers is too slow to
do on the main thread without frame drops. `MapGeodataProcessor`
(`src/map/geodata-processor/processor.js`) spawns a dedicated web
worker (`geodata-processor-worker.js`) that handles this work
asynchronously.

One worker is shared per free-layer surface (not per tile). When a tile's
data becomes available, `MapGeodataView.isReady()` checks whether the
worker is idle and, if so, sends it the raw tile data along with the
current stylesheet, font data, tile metadata, and device pixel ratio.

The worker runs `processGeodata()`, which iterates the tile's `groups`
array. For each group it calls `processFeatures()` for each feature
type — points first, then lines, then polygons. For each feature,
`processLayerFeature()` evaluates the stylesheet filters and property
expressions and calls the appropriate geometry builder.

Results are serialised into a packed binary buffer and posted back to
the main thread. The main thread deserialises incrementally across
frames (bounded by `mapMaxGeodataProcessingTime`) and uploads vertex
data to WebGL as `GpuGroup` objects.

This design means a tile is invisible for one to several frames after
it loads, while the worker processes it. Processing latency is the main
source of the label pop-in effect seen when panning quickly.

---

## Feature types and what they produce

### Points and point labels

The `point-array` feature type (and line-string or polygon features
with `label: true` or `point: true`) is handled by
`processPointArrayPass()` in `worker-pointarray.js`.

The function first determines where to place anchors. The `line-points`
style property controls this: `vertices` uses all vertices, `by-length`
or `by-ratio` samples the line at a fixed spacing, `middle` picks the
midpoint, and so on. For plain point features the geometry already
supplies the anchors directly.

**Icons** — `processIcon()` writes a two-triangle quad as screen-space
pixel offsets from the 3-D world-space anchor. The anchor is uploaded
as a separate per-vertex attribute (`aOrigin`); the shader projects it
to screen space and adds the offset.

**Labels** — `processLabel()` shapes the text using SDF glyph atlases.
It splits the text on newlines, wraps each line at `label-width` using
word-boundary splitting, computes per-line widths, and lays out glyph
quads. Each quad is a screen-space pixel offset from the anchor point,
stored in a Float32Array. Origin alignment (`top-left`, `center-center`,
etc.) and pixel offsets from `label-offset` are applied here.

When there is a single anchor the buffers are compacted into a
`singleBuffer` format (16 floats per quad), and the job type is
`WORKER_TYPE_LABEL`. Multiple anchors use separate vertex, origin, and
texcoord buffers (`WORKER_TYPE_LABEL2`).

If `label-source` is `$name` and the selected font cannot render the
text, the function retries with `$name:en`.

### Line features and on-path labels

`processLineStringPass()` in `worker-linestring.js` handles line
rendering and on-path text.

For plain lines it triangulates the polyline into a triangle strip with
optional rounded joins. Thin lines skip the joins for performance. The
resulting buffer goes to one of five job types depending on the
coordinate space and whether the line is textured:

- **`JOB_FLAT_LINE`** — world-space flat line, width in world units
- **`JOB_FLAT_RLINE`** — world-space flat line, width as a fraction of
  view extent
- **`JOB_FLAT_TLINE`** — world-space textured line (road markings, etc.)
- **`JOB_PIXEL_LINE`** — screen-space fixed-pixel-width line
- **`JOB_PIXEL_TLINE`** — screen-space textured line

For on-path text (`line-label: true`), `addStreetTextOnPath()` lays
out glyph quads along the line polyline at a series of LOD-scaled
spacings. It stores multiple candidate placements as a `labelPoints`
array (one entry per candidate spacing), each with two orientations
(forward and reverse along the line). The renderer picks the best
candidate at draw time based on current zoom level, then collision-tests
it. This lazy pick-at-draw-time approach avoids re-processing label
geometry when the camera zooms.

### Polygon features

`processPolygonPass()` in `worker-polygon.js` handles three things:

**Filled polygon surfaces** — triangulates the pre-tessellated surface
index list into a flat vertex buffer. This is a `JOB_POLYGON` job.

**Polygon borders** — if the style requests a line stroke, the border
vertices are extracted and routed through `processLineStringPass()`.

**Polygon labels and points** — if the style requests `label: true` or
`point: true`, the border vertices are extracted as line strings and
routed through `processPointArrayPass()`.

**There is no centroid computation.** Area labels are placed at
positions sampled along the polygon border, not at the visual centre.
This is a known gap: for irregularly shaped polygons the label may
appear outside the polygon or far from where a reader expects it. A
proper implementation would compute a pole of inaccessibility or an
area-weighted centroid.

---

## Job types

The following job types are stored in `renderer.jobZBuffer`. The
z-index slot determines draw order; higher z-index draws on top.

| Constant | What it renders |
|---|---|
| `JOB_FLAT_LINE` | World-space flat line or polygon fill |
| `JOB_FLAT_RLINE` | Ratio-width flat line |
| `JOB_FLAT_TLINE` | Textured flat line |
| `JOB_PIXEL_LINE` | Fixed-pixel-width billboard line |
| `JOB_PIXEL_TLINE` | Textured fixed-pixel-width line |
| `JOB_LINE_LABEL` | On-path text following a line feature |
| `JOB_ICON` | Icon sprite at a point anchor |
| `JOB_LABEL` | SDF text label at a point anchor |
| `JOB_PACK` | Icon + label pair with shared collision state |
| `JOB_VSPOINT` | Visibility-switch: chooses one sub-job set by view extent |
| `JOB_POLYGON` | Filled polygon, flat or colour-shaded |

---

## Phase 2 — Job dispatch

`RendererDraw.drawGpuJobs()` in `src/renderer/draw.js` iterates
over the z-buffer from slot 0 to 512. For each slot it calls
`drawGpuJob()` for every queued job, then runs any pending density pass
and resolves deferred label draws.

### Checks applied to every job

`drawGpuJob()` runs these checks in order before issuing a draw call:

1. **Feature state.** Each job carries a `state` byte encoding whether
   it belongs to the default, hover, or selected visual variant of a
   feature. Only the job whose state matches the current
   hover/selection state of that feature passes this check. This is
   how hover and selection styling work without a separate render pass.

2. **Super-elevation.** If vertical exaggeration is active, the job's
   3-D anchor position (`center`) is transformed through the
   super-elevation matrix before any screen-space computation.

3. **Visibility range.** The camera-to-feature distance is checked
   against the job's `visibility` property. Supports absolute distance,
   view-extent range, or size-at-distance range.

4. **Culling angle.** The dot product of the camera-to-feature
   direction and the terrain normal is checked. Jobs with
   `culling < 180` are skipped when the terrain is seen nearly edge-on.

5. **Stick height.** If `label-stick` is set, a pixel shift is computed
   that lifts the label above the terrain surface proportionally to the
   current tilt angle.

6. **No-overlap.** If the job has a `noOverlap` rectangle, the label
   anchor is projected to screen space and tested against the
   occupancy grid (see below). Failed jobs are discarded.

7. **Hysteresis.** Jobs with a `hysteresis` property are not drawn
   immediately. Instead they are registered in a per-z-level tracking
   table (`jobZBuffer2`) and drawn only after the appear timer expires.
   During the hide timer, the job continues to draw from cached state
   until the timer expires.

### Collision detection

`RendererRMap` in `src/renderer/rmap.js` is a screen-space
occupancy grid. The screen is divided into fixed-size cells; each cell
holds a list of the rectangles and circles already placed in that area.

**Point labels** occupy an axis-aligned bounding box. When a label is
tested, its anchor is projected to screen space and the `noOverlap`
rectangle (computed in the worker from glyph layout bounds) is checked
against all rectangles in the overlapping cells. If any existing
rectangle intersects, the label is rejected.

**Line labels** occupy a series of circles, one per glyph character
along the path. `RendererRMap.addLineLabel()` projects each character
position, tests it against both existing AABB rectangles and existing
circles, and rejects the whole label if any character collides.

A label inner window margin (`_isInsideLabelInnerWindow()`) rejects any
label whose bounding box falls within a configurable band around the
screen edges, keeping labels away from UI overlay zones.

The grid is a flat, per-frame data structure. It does not persist across
frames; it is rebuilt from scratch every frame during job dispatch.

### Density management

When `importance-source` is set on a style layer, the worker injects a
`dynamic-reduce` expression that encodes one of several `scr-count`
density modes. Jobs with these modes are not drawn immediately during
their z-level pass. Instead they are collected into `renderer.gmap[]`,
and after each z-level batch, one of `processGMap4()` through
`processGMap7()` in `src/renderer/gmap.js` decides which to draw
based on spatial density and the feature's prominence score.

The static `reduce` property (evaluated in the worker) is different: it
filters features before any GPU work, keeping only the top-N by a
property value. The two mechanisms are complementary. `reduce` limits
the feature count per tile; `dynamic-reduce` limits density on screen
across tiles.

The `complex-terrain` style uses `importance-source: '&importance'` on
its peaks layer, triggering `scr-count7`/`scr-count8` density
management. Settlement labels use hysteresis but not dynamic-reduce.

### Hysteresis detail

Jobs with `hysteresis: [showMs, hideMs, id, fade]` are tracked in
`jobZBuffer2` across frames, keyed by the feature ID string. A job
visible in the current frame increments `timerShow`; once `timerShow`
exceeds `showMs` the label appears. A job absent from the current frame
increments `timerHide`; once `timerHide` exceeds `hideMs` the label is
removed. When `fade` is `true`, the renderer interpolates alpha during
both transitions.

If `sortHysteresis` is active, all hysteresis jobs are depth-sorted
with `radixDepthSortFeatures()` before drawing, so closer labels win
over distant ones when they compete for screen space.

---

## Shaders

Labels use SDF rendering throughout. Each character quad is drawn twice:
once with the outline threshold and color, once with the fill threshold
and color. The two-pass draw happens inside `drawGpuJob()`.

| Job type | Normal render | Hitmap render |
|---|---|---|
| `JOB_FLAT_LINE` / `JOB_POLYGON` | `progLine` / `progCFlatShadeTile` | `progELine` |
| `JOB_FLAT_RLINE` | `progRLine` | `progERLine` |
| `JOB_FLAT_TLINE` | `progTLine` / `progTBLine` | `progETLine` (missing) |
| `JOB_PIXEL_LINE` | `progLine3` | `progELine3` |
| `JOB_PIXEL_TLINE` | `progTPLine` / `progTPBLine` | `progETPLine` (missing) |
| `JOB_LINE_LABEL` | `progText2` | white texture |
| `JOB_ICON` (singleBuffer) | `progImage` | same |
| `JOB_LABEL` (singleBuffer) | `progLabel16` … `progLabel128` | same |
| `JOB_ICON` (vertex buffers) | `progIcon` | same |
| `JOB_LABEL` (vertex buffers) | `progIcon2` | same |

`progLabel16` through `progLabel128` are size-bucketed variants that
differ in how many glyph quads they can handle in one draw call.

When super-elevation is active, line shaders switch to their `*SE`
variants (`progLineSE`, `progLine3SE`, `progText2SE`).

---

## Dead code and suspects

The following items are candidates for removal. Evidence for each is
noted.

**`getLineInfo()` in `worker-linestring.js` line 25.**
Empty body, never called. Likely a stub that was never completed.

**`GpuGroup.prototype.addRenderJob` in `group.js` line 795.**
Commented out entirely inside `/* ... */`. The live path is
`addRenderJob2()`.

**The pre-baked `JOB_LINE_LABEL` draw path.**
The `JOB_LINE_LABEL` branch in `drawGpuJob()` contains a live
`console.log('job4')` at line 1556 of `draw.js`. That log would print
every frame if the path were active. No console spam is seen on
`complex-terrain`, so the path is not exercised by any current test
style. The current worker emits `WORKER_TYPE_LINE_LABEL2` (singleBuffer
path) for modern styles; `WORKER_TYPE_LINE_LABEL` (pre-baked vertex
buffer) is the old format.

**Vertex-buffer label and icon paths (`console.log('job1')`,
`console.log('job2')`).**
Lines 2029 and 2086 of `draw.js` print `job1` and `job2` to the
console. These are in the `job.vertexPositionBuffer` draw path for
`JOB_LABEL` and `JOB_ICON`. These paths handle multi-anchor features
(`WORKER_TYPE_LABEL2`, `WORKER_TYPE_ICON2`), which require
`totalPoints > 1`. Neither `complex-terrain` nor current test styles
produce such features.

**Commented-out `logDebugInfo` block at line 564 of `draw.js`.**
A logging loop inside `drawGpuJobs()` that was wrapped in a comment
rather than deleted. Both the block and the `logDebugInfo` variable
declaration at line 485 can be removed.

**`export-geometry` / `WORKER_TYPE_POINT_GEOMETRY` /
`WORKER_TYPE_LINE_GEOMETRY`.**
The geometry-export feature stores raw world-space vertex data in
`renderer.geometries` for retrieval via legacy map methods. No test style
uses `export-geometry: true`, and no demo application queries the
result. It may be retained for external API callers but has no tests
and no style-level usage.

---

## Area labels — a known gap

The polygon label path has no centroid computation. When a style applies
`label: true` to a polygon feature, the border vertices are extracted
and passed through the point-label path. The anchor ends up somewhere
on the polygon boundary, not at its visual centre.

For most current uses (country boundaries, land use) the border
placement is tolerable or the feature is styled as a line anyway. But
proper area label placement — computing a pole of inaccessibility or an
area-weighted centroid and placing the label there — is absent and would
be needed before polygon labels could be used reliably for dense or
irregularly shaped regions.

---

## Comparison with MapLibre GL JS

MapLibre's symbol system addresses the same goals but uses a different
architecture. The differences matter for understanding where cartolina's
label subsystem falls short and where future work should go.

**Placement pass.** MapLibre runs a dedicated placement pass (`Placement.ts`)
after tile loading and before each frame draw. It evaluates all symbol
features across all tiles simultaneously and assigns stable positions.
Cartolina has no equivalent global pass. Each tile's labels are
independent, and collision is resolved in z-index order during draw.
The consequence is that labels in adjacent tiles can collide at tile
boundaries because the occupancy grid is populated in draw order, not
in a globally consistent spatial order.

**Cross-tile deduplication.** MapLibre deduplicates labels that appear
in more than one tile (a city name straddling a tile edge). Cartolina
does not. The same text can appear twice when emitted by two adjacent
tiles.

**Polygon centroids.** MapLibre computes a pole of inaccessibility for
polygon features (see the gap noted above).

**Symbol layout properties.** MapLibre supports `text-rotate`,
`text-pitch-alignment`, and `text-rotation-alignment` as style
properties. On-path text direction in cartolina is determined by the
geometry tangent in the worker and is not overridable at draw time.

**SDF rendering.** Both systems use SDF glyph atlases for text and
support two-pass outline rendering. The core technique is equivalent.

**Icon-label coupling.** MapLibre treats an icon and its label as one
logical symbol with a single shared collision bounding box. Cartolina
can group icon and label via `pack: true` (`JOB_PACK`), which unions
their `noOverlap` rectangles. The pack mechanism exists in the code
but is not used by any current test style.

---

## Files referenced

- `src/map/draw.js` — frame entry, job collection, monolithic
  geodata path
- `src/map/draw-tiles.js` — `MapDrawTiles.drawGeodataTile()`
- `src/map/geodata-view.js` — `MapGeodataView`, worker bridge,
  GPU group matrix updates
- `src/map/geodata-processor/processor.js` — worker lifecycle and
  stylesheet dispatch
- `src/map/geodata-processor/worker-main.js` — `processGeodata()`,
  `processGroup()`, `processFeatures()`, hover/selection state routing
- `src/map/geodata-processor/worker-pointarray.js` — point and
  label geometry: `processLabel()`, `processIcon()`
- `src/map/geodata-processor/worker-linestring.js` — line
  triangulation and on-path text layout
- `src/map/geodata-processor/worker-polygon.js` — polygon fill,
  border routing to line and point processors
- `src/renderer/gpu/group.js` — `GpuGroup`, job buffer insertion,
  `addRenderJob2()`
- `src/renderer/draw.js` — `RendererDraw.drawGpuJobs()`,
  `drawGpuJob()`, `processNoOverlap()`
- `src/renderer/rmap.js` — `RendererRMap`, screen-space occupancy
  grid
- `src/renderer/gmap.js` — density-based label reduction passes
- `src/constants.ts` — job type and worker command constants
