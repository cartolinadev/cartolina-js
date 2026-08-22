# RFC 13: the elevation store

**Status:** In review
**Opened:** 2026-08-21
**Related:** [backlog #1](backlog.md#backlog-1),
[nav-tiles.md](nav-tiles.md),
[reference-frames.md](reference-frames.md),
[gpu-subsystem.md](gpu-subsystem.md)


## 1. Context

Cartolina needs terrain elevation whenever it places a two-dimensional
position on the three-dimensional map. Current examples are:

- a floating map position;
- terrain following while the user pans;
- a waypoint whose input contains longitude and latitude only; and
- every geographic coordinate in tiled geodata.

The client currently obtains the first three values from navigation tiles.
A navigation tile is a separately produced and delivered elevation raster.
Its finest available LOD can be coarser than the mesh which is on screen, and
its delivered representation has no coverage mask. It can therefore disagree
with the rendered terrain.

The [navtile encoder][vts-navtile-encoding] shows where coverage is lost. An
in-memory navtile contains a height grid and a coverage mask, but serialization
writes only an eight-bit height image scaled by the metanode height range. The
client therefore cannot distinguish an inpainted value outside coverage from
terrain data.

[Backlog #1](backlog.md#backlog-1) records the measured consequence at
Mount Whitney. The navigation tile returns 3480 m while the mesh renders
3597 m. The waypoint is projected below a ridge and is classified as hidden.

The tileserver handles tiled geodata differently. It heightcodes every
geographic coordinate before delivery. The server decodes the vector tile,
samples the configured DEM, and emits three-dimensional geodata together with
a metatile. This work is one of the costs which the planned vector redesign
removes.

The intended vector source reads ordinary two-dimensional tiles, including
OpenMapTiles data, and adds terrain height in the client. The elevation store
does not implement that source. It supplies the elevation lookup required by
that later work, which can then retire geodata metatiles and server-side
heightcoding.

Raster elevation sources provide another illustration of the boundary. A
raster source already contains heights while `cartolina-surface` provides an
irregular mesh. A consumer should query the terrain selected by the map
without knowing which representation supplied it. Raster terrain itself is
outside this RFC.


## 2. Decision and scope

`Map` will own an elevation store. It is a bounded, temporal, GPU-backed
height field derived from terrain resources which are ready for normal
rendering.

The store follows the same tile selection, source order, fallback, and partial
coverage rules as terrain drawing. It never requests a metatile, mesh,
texture, or raster. An elevation pass may use a render rig once that rig is
ready for normal rendering; it need not wait for a color frame to draw it.

The store has one canonical value at each covered sample. It does not record
which terrain source supplied the value. A change to the terrain source list
clears the store. Values already retained by consumers are not withdrawn
merely because a region is later evicted or no longer covered by the store.

Mesh terrain is written without filtering. A future VHR input will be able to
apply morphological opening to its rasterized height field before composition.
Only the opened field is then stored. Most terrain sources will continue to
produce an effectively unfiltered field, and the store will never retain a
second raw VHR field.

This RFC delivers:

- the store representation, population pass, lookup, and memory policy;
- one lookup operation for a single position or an array of positions;
- waypoint placement through the store;
- a comparison between existing server heights and client lookup;
- store-based resolution of floating map positions; and
- store-based terrain following during pan motion.

Each of the last four items is an implementation and manual validation gate.
Work stops after each gate until its manual result has been accepted.

This RFC does not add a two-dimensional vector source, remove geodata
metatiles, remove server-side heightcoding, add raster terrain, or remove all
navigation-tile code. It also does not compute node height ranges or perform
VHR morphological opening. Sections 9 and 10 state the representation
constraints needed by those later changes.


## 3. Height and composition

### 3.1 Coordinate meaning

On a geocentric reference frame, lookup input is longitude and latitude in
the geographic SRS of the reference ellipsoid. The returned third coordinate
is geodetic height above that ellipsoid.

On a projected reference frame, lookup input is physical XY and the returned
height is physical Z. The storage and lookup algorithms are otherwise the
same.

The stored value never includes vertical exaggeration. Exaggeration is a
rendering transform. A height function already applied to mesh geometry is
part of that geometry and is present in the store.

Reference-frame consistency is not an elevation-store concern. The reference
frame must validate its coordinate systems when it is parsed. That work is
tracked by [backlog #54](backlog.md#backlog-54), rather than repeated by
the store.

### 3.2 Height extraction in the shader

For a geocentric frame, the elevation vertex shader reconstructs absolute
physical coordinates by adding `uFrame.physicalEyePos.xyz` to the
camera-relative position produced by `uModel`. It then converts the Cartesian
position to geodetic height using the reference ellipsoid axes already stored
in the frame uniform buffer.

The shader uses Bowring's formula. With semi-major axis `a`, semi-minor axis
`b`, `p = length(xy)`, first eccentricity squared `e2`, and second
eccentricity squared `ep2`:

```text
lon = atan(y, x)
theta = atan(z * a, p * b)
lat = atan(z + ep2 * b * sin(theta)^3,
           p - e2 * a * cos(theta)^3)
N = a / sqrt(1 - e2 * sin(lat)^2)
q = [N * cos(lat) * cos(lon),
     N * cos(lat) * sin(lon),
     N * (1 - e2) * sin(lat)]
normal = [cos(lat) * cos(lon),
          cos(lat) * sin(lon),
          sin(lat)]
height = dot(ecef - q, normal)
```

The geocentric axis uses `abs(z) - b`. A projected frame writes physical Z
and does not run this conversion.

This shader calculation exists because `proj4` is not available in GLSL. It
computes the same ellipsoidal quantity as the library's CPU SRS conversion.
The frame shader and `VerticalExaggeration` currently use a less accurate
scaled-sphere estimate for the same quantity.
[Backlog #55](backlog.md#backlog-55) tracks replacing both estimates with one
shared calculation. RFC 13 needs the accurate formula for stored height.

### 3.3 Terrain composition

The existing draw traversal owns composition. It selects terrain sources in
style order, handles partial coverage, and decides when a finer child or a
coarser fallback draws. The elevation store does not reproduce those rules.

During one ready rig's draw, a transient depth attachment keeps the upper
height where projected triangles overlap. This matters for mesh data with
overhangs; DEM-derived meshes normally have one height at each XY. The depth
test is a natural consequence of rasterizing a mesh and adds no separate
terrain model.

The reference frame's declared height range supplies the depth ordering. For
range `[minimum, maximum]`, the fragment shader writes:

```text
depth = (maximum - height) / (maximum - minimum)
```

The attachment is cleared to one and uses `LEQUAL`, so the greatest height
wins. A value outside the declared range is a reference-frame or terrain-data
error; the draw omits it and increments an elevation-store diagnostic count.

Coverage from finer children and higher-priority sources is applied before a
fallback rig draws. A lower-priority or coarser rig therefore fills gaps and
does not replace established values.


## 4. Store representation

### 4.1 Logical layout

The store follows the reference frame's tile hierarchy. Each resident tile
has one height-field unit. Tile IDs are unique within a reference frame, so a
tile ID `[lod, x, y]` is the complete unit key.

A unit is a 256 by 256 grid. Its samples lie on the tile boundary:

```text
sample(i, j) = [ll.x + i * width / 255,
                ll.y + j * height / 255]
```

where `i` and `j` range from zero through 255. Adjacent units duplicate their
shared edge. A lookup is therefore bilinear within one unit, including the
strip next to any edge; it never needs a neighbouring unit or a seam rule.
The elevation raster draw maps external mesh UV `[0, 1]` to the centres of
the first and last texels so the stored grid includes both endpoints.

Different LODs may cover different regions. Current and recent views retain
fine units. Coarser units cover broader areas, and the root unit of every
reference-frame node remains resident after it first obtains coverage.

### 4.2 Texture format

Each unit owns one 256 by 256 `RGBA8UI` texture. A finite IEEE 754 float is
stored as four bytes. One NaN bit pattern represents no coverage. There is no
persistent mask texture; validity is part of the stored value.

The grid therefore has 255 sample intervals per tile. Using 257 samples would
provide 256 intervals and reduce the spacing by 0.39 percent. It would add
only 0.78 percent more samples, and a 257 by 257 render target is valid in
WebGL2. The reason to prefer 256 is predictability: WebGL does not expose a
texture's physical layout or padding, while 256 gives a power-of-two texture
and a 1024-byte row. The store computes GSD from the actual 255 intervals, so
the slightly coarser spacing is explicit in lookup selection.

The existing [`DepthUint` texture](../../src/renderer/gpu/texture.ts) and
[depth fragment shader](../../src/renderer/shaders/tile-depth.frag.glsl)
already render a float bit pattern into `RGBA8UI` and read the same bytes on
the CPU. The elevation texture uses that byte order and packing rule.

The texture uses nearest filtering. Lookup and reduction shaders decode four
samples and perform bilinear filtering explicitly. This keeps the store on
the WebGL2 baseline. Rendering to `R32F` would require
`EXT_color_buffer_float`, and linear filtering would also depend on float
filtering support. Four decoded reads happen only during elevation lookup and
reduction, not in the color render loop, so the optional extensions do not
justify a second format or a fallback path.

One unit occupies:

```text
256 * 256 * 4 = 262144 bytes = 256 KiB
```

### 4.3 Complete unit replacement

An update builds a replacement texture and publishes it only after the whole
reference-frame tile has been processed. The replacement is cleared to the
invalid value once. It is not cleared between terrain sources.

During traversal backtracking, the elevation sink first reduces published
child units and then draws the current node's selected fallbacks into
uncovered samples. All terrain sources selected at the node draw into the
same replacement in traversal order. The unit is committed after the node has
completed. A query therefore sees either the old complete unit or the new
complete unit, never an intermediate source.

Commit swaps the published texture after all replacement commands have been
queued. WebGL command order makes a later lookup observe the completed writes.
An old texture referenced by an in-flight lookup is retained until that
lookup's fence signals, then released. Both textures count against the memory
limit during this interval.

Four child grids form one 511 by 511 grid after their duplicated shared edges
are counted once. Parent reduction maps parent sample `[i, j]` to child-grid
sample `[2i, 2j]` and applies the separable weights `[1, 2, 1] / 4` in each
dimension. At the outer boundary, coordinates are clamped to the boundary
sample. Invalid samples carry no weight and the remaining weights are
renormalized; an all-invalid neighbourhood produces an invalid parent sample.
The reduction shader binds the four child textures and routes each of the
nine reads to the child containing that sample, so it does not materialize
the 511 by 511 grid.

Reduction continues through every ancestor up to the reference-frame node
root. This supplies all coarser GSDs even when fallback cadence skipped direct
rendering at an intermediate LOD.

Each unit records the ready render rigs which contributed to it, in
traversal order, and the revisions of child units used by reduction. If those
inputs are unchanged at the next interval, the existing unit is retained and
no raster draw is submitted. This is whole-unit rebuild state. It is not
terrain-source information attached to individual samples.


## 5. GSD selection

GSD is the physical metres represented by one stored sample. Larger values
are coarser. A request of zero asks for the finest covered resident unit.
A positive request asks for the closest covered GSD which is higher than or
equal to the requested value. If every resident value is finer, the coarsest
covered resident unit is returned.

This defines the lookup order. For zero, resident units are tried from finest
to coarsest. For a positive request, units which meet the request are tried
from the closest GSD towards coarser GSDs. Finer units follow from coarsest to
finest and are used only when no covered unit meets the request. The GPU
coverage test selects the first valid unit in that order.

The tile hierarchy is defined in the projected SRS of its reference-frame
node. Its nominal sample spacing at LOD `lod` is:

```text
rootSpacing = sqrt(rootWidth * rootHeight) / 256
nominalSpacing(lod) = rootSpacing / 2^(lod - rootLod)
```

Projection scale varies across an RF node. Each RF node owns a small grid
containing physical metres per projected SRS unit. The grid
samples include the RF node boundary and are bilinearly interpolated at the
lookup position. `mapElevationStoreGsdGridSize` controls both dimensions and
accepts an integer of at least 2. It defaults to 5, giving a 5 by 5 grid and
4 by 4 interpolation cells. Changing the setting requires a new map; there is
no adaptive refinement.

When PROJ projection factors are available, the value at a grid sample is:

```text
metresPerUnit = srsUnitMetres / sqrt(arealScale)
```

The browser's current `proj4` package does not expose projection factors, so
the browser obtains the same areal scale from a numerical Jacobian. For each
axis, the difference step represents one metre in that SRS's declared linear
unit, limited to one quarter of the RF-node extent when the node is smaller.
Interior samples use centred differences; boundary samples use an inward
one-sided difference. The points are transformed at height zero to Cartesian
physical coordinates. The square root of the cross-product length of the two
derivatives is physical metres per projected unit.

If a boundary point is outside the projection domain, its grid value is
copied from the closest finite grid sample. An RF node for which no grid
sample can be evaluated cannot answer elevation queries. All of this work
runs once while the RF node's grid is built.

At lookup position `p`:

```text
requestedNominal = requestedPhysical / metresPerUnit(p)
actualPhysical = selectedNominal * metresPerUnit(p)
```

The CPU uses `requestedNominal` to choose a LOD. It reports
`actualPhysical` with the result. This is the same nominal-GSD adjustment
used by the [tileserver's spatial GSD pruning][mapproxy-gsd-grid], with a
smaller configurable grid because projection scale varies smoothly within an
RF node.


## 6. Lookup API

### 6.1 Store operation

`ElevationStore` is internal and owned by `Map`. Its only consumer operation
accepts one position or an array of positions. Every position in an array has
the same requested GSD.

```ts
heightcode(
    position: ElevationStore.Position,
    desiredGsd?: number,
): Promise<ElevationStore.Sample | undefined>;

heightcode(
    positions: readonly ElevationStore.Position[],
    desiredGsd?: number,
): Promise<readonly (ElevationStore.Sample | undefined)[]>;
```

The associated internal types occupy the class's same-name namespace:

```ts
namespace ElevationStore {
    export type Position = readonly [number, number];

    export type Sample = {
        position: readonly [number, number, number];
        actualGsd: number;
    };
}
```

Results preserve input order. `undefined` means that no resident unit covers
that position. The store does not overwrite a value retained by a consumer:
the consumer keeps its previous sample when a later call returns `undefined`.
It compares the returned height and GSD with its retained sample when it needs
to know whether geometry must be rebuilt.

An omitted `desiredGsd` is zero. A supplied value must be finite and
non-negative; otherwise the promise rejects with `RangeError`. An empty array
resolves to an empty array. Every position must contain two finite numbers;
an invalid member rejects the whole call with `TypeError`. A finite position
outside every RF node resolves to `undefined`. Clearing or disposing the store
resolves pending single-position calls to `undefined` and pending arrays to
arrays of `undefined`, so no query promise is left unsettled.

A refresh is another `heightcode()` call; it accepts neither a previous result
nor a cancellation token. Each library caller keeps at most one request in
flight for its position set and submits the next refresh after that promise
settles. Overlapping calls are still valid: calls received before one
animation tick are combined into one GPU submission, while their promises
remain separate. The store does not reject a caller for submitting a second
request.

### 6.2 Public terrain query

The waypoint demo is outside `Map`, so it cannot call `ElevationStore`.
`Viewer` therefore exposes the terrain operation rather than the store:

The input follows section 3.1: longitude and latitude for a geocentric frame,
or physical XY for a projected frame. `desiredGsd` is in physical metres.

```ts
queryTerrainElevation(
    position: readonly [number, number],
    desiredGsd?: number,
): Promise<Viewer.TerrainSample | undefined>;

queryTerrainElevation(
    positions: readonly (readonly [number, number])[],
    desiredGsd?: number,
): Promise<readonly (Viewer.TerrainSample | undefined)[]>;

namespace Viewer {
    export type TerrainSample = {
        position: readonly [number, number, number];
        actualGsd: number;
    };
}
```

`Viewer.TerrainSample` contains `position` and `actualGsd` with the same
meaning as above. It is a Viewer-owned public type, not an alias of an
`ElevationStore` or `Map` type. The method exposes no store lifetime,
texture, unit, revision, or update operation. It exists because terrain
elevation is a map query needed by application code; the store remains an
implementation detail.

### 6.3 Query execution

The reference-frame object resolves each input position to its RF node, local
projected coordinates, and tile path. This is a normal reference-frame
operation and is implemented once on `MapRefFrame`; `ElevationStore` does not
repeat manual-partition or RF-node selection.

For every input position, the CPU orders resident units on that tile path by
the GSD rule in section 5. Position conversion and unit selection remain in
double-precision CPU code. The GPU receives only a result index and normalized
unit UV, where float precision is sufficient for a 256-sample grid.

One lookup submission performs these operations:

1. Clear two one-row `RGBA8UI` attachments and a depth attachment. The first
   color attachment holds height bits. The second holds the preference index
   of the unit which supplied them.
2. Group position-unit pairs by unit, bind each unit texture once, and draw
   one point per pair at that position's result pixel. The fragment shader
   decodes and filters the four neighbouring samples. The unit answers only
   when every sample with non-zero bilinear weight is valid; otherwise the
   fragment is discarded and a later unit may answer.
3. For zero-based preference index `i` and the submission's greatest index
   `m`, write depth `(i + 1) / (m + 2)`. With the attachment cleared to one,
   `LESS` keeps the valid unit nearest the start of the CPU ordering,
   independent of draw order.
4. Read both color attachments into consecutive ranges of one pixel-pack
   buffer and insert a WebGL fence. The CPU maps the returned preference index
   to the corresponding `actualGsd` calculated in section 5.

The result target and pixel-pack buffer hold at most the device's maximum
texture width. A larger batch is processed as consecutive chunks through the
same buffers. Each chunk gets one fence; animation ticks poll it with a zero
timeout, copy its results after it signals, and then submit the next chunk. No
animation tick waits for the GPU. A call's promise settles after all chunks
which contain its positions have completed.

Only one GPU lookup chunk is in flight. Calls which arrive meanwhile join the
next batch. This bounds the result targets, pixel-pack buffer, and fences
without exposing queue control in the API.


## 7. Population and lifecycle

### 7.1 One traversal, three sinks

Elevation population invokes the existing terrain traversal with an elevation
sink. The same traversal also receives explicit color and depth sinks. The
current mutable `Map.drawChannel` is removed; adding a third value to it would
retain rendering decisions throughout map and traversal code.

The traversal remains responsible for terrain policy:

- reference-frame node traversal, visibility, and LOD descent;
- terrain-source order and the rule which stops lower-priority sources;
- natural-leaf and fallback selection, including fallback cadence;
- whether a readiness check may request a resource;
- child-coverage folding, coverage masks, and watertightness; and
- the coverage result returned to the parent.

A sink is responsible for producing one kind of output from the tiles selected
by that policy:

- readiness of a particular render rig for its output;
- render-target and shader selection;
- the tile draw itself; and
- output-specific effects such as color credits and draw statistics.

A sink does not decide whether to descend, which terrain source has priority,
whether a node is watertight, or which fallback LOD is attempted. Moving those
decisions into a sink would create three traversal implementations in another
form.

### 7.2 Sink contract

`drawTerrainTraversal()` receives the sink and a pass-wide `doNotLoad` flag.
The latter is combined with the traversal's existing off-cadence no-load rule.
The sink contract is an internal structural type. It has two required
operations and two optional node hooks:

```ts
type TerrainTraversalSink = {
    beginNode?(tileId: TileId): void;
    isReady(
        rig: TileRenderRig,
        readiness: TileRenderRig.ReadinessLevels,
        priority: TileRenderRig.Priority,
        options: TileRenderRig.IsReadyOptions,
    ): boolean;
    draw(
        tile: MapSurfaceTile,
        rig: TileRenderRig,
        maskTexture?: GpuTexture,
    ): void;
    endNode?(tileId: TileId, covered: boolean): void;
};
```

The three concrete sinks are stateful classes which satisfy this type
structurally. They require no common base class or TypeScript `interface`.
Each captures its map and camera when constructed and owns its render-target
selection. These do not need to be repeated in every draw call. `readiness`
and `options.doNotLoad` are decisions made by the traversal.

Rig ownership and selection remain in the traversal. It creates or rebuilds
the current rig under the existing tile lifecycle, asks the sink whether that
rig is ready, and falls back to the last rig only when the current rig is not
ready. The last rig is checked at fallback readiness. If neither rig is ready,
the traversal suppresses lower-priority surfaces at that node. Structural and
malformed geometry contributes no coverage. After a sink draws the selected
rig, the traversal applies watertightness or adds that rig's footprint to its
coverage mask.

The current-then-last sequence affects fallback and coverage, so it is shared
traversal policy. The sink supplies only the output-specific readiness test
used by that sequence.

The extraction from the current `renderTile()` is mechanical. Each
color/depth gate around rig readiness, the rig draw, credits, and terrain
debug drawing becomes the corresponding sink method. Resource acquisition,
rig creation, current-versus-last selection, and the coverage code surrounding
those gates stay in `renderTile()`. Code moves beyond that boundary only when
required to remove `drawChannel`.

`beginNode()` runs during backtracking, after the children have completed and
before the current node's fallback surfaces are drawn. `endNode()` receives
only whether the completed node has coverage. It does not expose
watertightness or another traversal state to the sink. Every node for which
`beginNode()` ran must reach `endNode()` exactly once, including a node whose
children eliminate its fallback draw. Color and depth omit both hooks.

The three sinks apply the contract as follows:

- `ColorTerrainSink` uses normal rig readiness and `TileRenderRig.draw()`. It
  owns imagery and mesh credits, color draw statistics, and terrain debug
  drawing.
- `DepthTerrainSink` uses mesh-only readiness and
  `TileRenderRig.drawDepth()`. It writes only the depth hitmap and performs no
  color-pass effects.
- `ElevationTerrainSink` requires the rig to be ready for normal rendering,
  always checks it with `doNotLoad`, and draws unexaggerated height through
  external UV. It performs no color-pass effects or loader-priority updates.

The elevation sink uses the node operations to implement complete unit
replacement. At `beginNode()`, it clears a replacement once and reduces any
published child units into their quadrants. Calls to `draw()` then compose the
selected fallback rigs through the coverage mask supplied by the traversal.
At `endNode()`, it commits a replacement when `covered` is true and discards
it otherwise. Child tile IDs are derived from the current tile ID; the sink
does not traverse terrain trees or interpret child coverage.

Mask creation stays in the traversal. Materializing a mask may change the GPU
target, so each sink restores its own target immediately before drawing.

### 7.3 Pass entry points

The sink is selected by the caller rather than global state:

```text
color frame:
    frame setup -> terrain traversal(color sink) -> geodata -> overlays

depth update:
    depth setup -> terrain traversal(depth sink) -> hitmap readback

elevation update:
    elevation setup -> terrain traversal(elevation sink)
```

The depth and elevation paths do not call the complete `Map.draw()` method.
They initialize only the camera, renderer state, and target required by their
pass. Geodata, atmosphere, labels, credits, and overlays are reached only by
the color-frame entry point. This replaces the channel checks which currently
protect those operations during the depth pass; those outer operations do not
become terrain-sink responsibilities.

Color and depth move to sinks in the same change which introduces the sink
contract. The implementation must not retain a channel path beside the sink
path: two dispatch mechanisms would allow readiness and side effects to drift.

### 7.4 Timing and resource demand

The store is always present after the reference frame is ready. There is no
enable setting.

`mapElevationStoreUpdateIntervalMs`, defaulting to 1000 ms, is the minimum
time between elevation-pass starts. It accepts a non-negative value; zero
makes every animation frame eligible. A runtime change applies to the next
eligibility check. A due pass runs from the current camera state whether or
not a color frame was drawn since the previous pass. It uses the traversal's
existing no-load path for metanodes and
`TileRenderRig.isReady(..., { doNotLoad: true })` for render rigs. A resource
which is not ready for normal rendering contributes nothing at that interval
and is reconsidered later.

The elevation pass never marks a resource used in a way that changes loader
priority, and never creates a terrain request. It may allocate store textures
and submit raster or reduction draws.

### 7.5 Lifetime

`Map` constructs the store when its reference frame is ready and disposes it
before the renderer. Map disposal, a terrain source-list change, and WebGL
context loss clear every unit and pending readback. Context recovery starts
with an empty store.

Vertical exaggeration, imagery, atmosphere, and lettering do not clear the
store. Ready terrain resources are immutable; when a different ready rig or a
new child unit contributes, the next timed pass replaces the affected unit.


## 8. Memory and eviction

`mapElevationStoreGPUCache` sets the maximum GPU memory owned by the store in
MiB and defaults to 64. Replacement textures count against the limit while old
units remain queryable. Fixed raster and lookup work buffers are reserved from
the same limit before unit textures are admitted. A runtime decrease evicts
unpinned units before the next elevation pass and is rejected if it is smaller
than the fixed buffers plus the root reservation defined below.

A 1920 by 1080 view contains about 8 by 5 finest visible units when one
256-sample terrain tile covers about 256 screen pixels. That is 40 units. For
an aligned rectangle at RF-node depth 16, its unique ancestors contain 12,
4, and 1 units over the next three levels, followed by one unit at each of the
remaining 13 levels. The representative total is therefore 70 units:

```text
70 * 262144 bytes = 18350080 bytes = 17.5 MiB
```

With maximum texture width `W`, the shared raster depth attachment and lookup
color, depth, pixel-pack, and point buffers reserve at most approximately:

```text
262144 + 40 * W bytes
```

At a common `W = 16384`, that is 0.88 MiB and leaves room for 252 units in a
64 MiB limit. Alignment, perspective, partial coverage, deeper RF nodes, and
recently visited areas change the real count. The default therefore holds
about 3.6 times the representative 1920 by 1080 set. Validation records the
actual peak on `complex-terrain`; this calculation selects the default but is
not an acceptance measurement.

Unpinned units use least-recently-used eviction. Building a unit and returning
a successful lookup both move it to the front of the LRU list. The least
recently built or queried unit is removed first. RF-node root units are
pinned after they obtain coverage, so every visited RF node retains its
coarsest available field.

When the reference frame is parsed, `Map` verifies that the budget remaining
after fixed buffers can hold one unit for every RF node. Those slots are
reserved for roots. A smaller configured budget is invalid, because silently
evicting roots would break the coarse-result guarantee.

Before allocating a replacement, the store evicts unpinned units until both
the old published unit and its replacement fit. If the root reservation and
units currently being rebuilt leave insufficient space, that unit is skipped
until a later pass. Allocated unit textures never exceed the configured
budget.

Eviction releases only the GPU unit and its metadata. It does not change a
sample already held by a consumer. The store owns no persistent CPU copy of
the height fields. In addition to unit textures, the store owns one shared
256 by 256 raster depth attachment, two one-row lookup color attachments, one
one-row lookup depth attachment, and one lookup pixel-pack buffer. The lookup
allocations are capped by the device's maximum texture width and reused
between chunks. CPU memory consists of unit metadata, the small GSD grids,
queued inputs, and completed values still held by callers.


## 9. Future node height ranges

Node minimum and maximum heights are not implemented by this RFC. Until they
exist, a vector traversal uses the reference frame's global height range for
every node. This weakens culling but does not reject valid geometry.

The 256 by 256 boundary-sampled units leave a direct later path: reduce the
finite samples for a tile to a minimum and maximum and cache that pair on the
CPU under the same tile ID. Missing pairs fall back to the global range. The
pair describes the canonical store field, including VHR opening when that is
configured; it does not replace terrain-rendering bounds.


## 10. Future VHR morphological opening

Morphological opening is an optional step after a VHR terrain input has been
rasterized to a staging height field and before that field is composed into
the store. The input may have been a mesh or a raster source. Opening is not a
lookup mode and does not apply to ordinary DEM terrain.

The operation is erosion followed by dilation over valid samples. Only the
opened field is committed; the unfiltered staging field is released. Coarser
units and future node ranges are derived from the opened field.

The [VTS height-map implementation][vts-heightmap] is the prior art. Its
separable erosion and dilation ignore invalid neighbours and retain invalid
centres. The tileset production code converts the configured physical radius
to pixels before running the operation. A later VHR RFC should reuse those
semantics. RFC 13 adds no opening shader, configuration, or retained raw
field.


## 11. Implementation and validation sequence

Implementation proceeds through four application gates. Mechanism-level
diagnostics may explain a failure, but they are not acceptance gates and do
not replace the application run. After each gate, implementation stops for a
manual application run. Work on the next gate begins only after the reviewer
accepts that result.

### 11.1 Foundation and gate 1: waypoint

The first step implements only the store needed by the waypoint:

1. Add 256 by 256 packed unit textures, elevation rasterization, reduction,
   compact lookup, asynchronous readback, LRU eviction, and the three settings
   from sections 5, 7, and 8.
2. Add RF-node and tile-path lookup to `MapRefFrame` and use it from the store.
3. Extract the existing color and depth gates from `drawTerrainTraversal()`
   into the two sinks defined in section 7. Remove `Map.drawChannel` and give
   color frames and depth updates explicit entry points.
4. Add `ElevationTerrainSink` and the unexaggerated height draw to
   `TileRenderRig`. Elevation traversal and rig checks always use
   `doNotLoad: true`.
5. Add the internal `heightcode()` operation and the public
   `queryTerrainElevation()` operation.
6. Change the waypoint demo so every two-dimensional marker submits its
   existing geographic coordinates with GSD zero. It keeps one request in
   flight, retains its last resolved value, and moves the marker only when the
   returned height or GSD changes. The returned fixed coordinate is passed to
   `checkVisibility()` with mode `fix`, restoring the terrain-occlusion check
   which the navigation-tile error forced the demo to remove.

Manual validation uses `a-3d-mountain-map` and the waypoint demo at the Mount
Whitney position `[-118.302348, 36.560197]`. The reviewer verifies that the
marker appears on the rendered summit as terrain loads, remains visible under
`checkVisibility()`, and follows a better store sample when finer terrain
becomes ready. The run also confirms that enabling the waypoint adds no
terrain request.

Implementation stops for manual validation after this gate.

### 11.2 Gate 2: client heightcoding analysis

Add `debugElevationStoreGeodataShadow`. On `complex-terrain`, the diagnostic
processes every delivered three-dimensional geodata coordinate:

1. use the existing CPU SRS conversion to obtain lookup XY and the delivered
   geodetic height, then discard that height from the query input;
2. request store height at GSD `geodataTileWidth / pixelSize`;
3. retain the last result and resubmit after each settled store interval; and
4. compare the resulting client height with the delivered server height for
   the same coordinate.

The report states exactly what is compared. It records resolved-coordinate
coverage, actual GSD, refresh count, and the client-minus-server height
difference as mean, standard deviation, p50, p90, p99, minimum, and maximum.
Equality is not required because the server DEM and the composed client
terrain can differ. The reviewer examines the distribution and the geographic
location of large differences.

At viewport 1920 by 1080, run matched `complex-terrain` performance captures
with the diagnostic off and on after terrain has settled. Client heightcoding
must add no terrain request and must not reduce measured FPS by more than ten
percent. This is the primary performance acceptance test for the store.

Implementation stops for manual review of the map, report, and performance
capture after this gate.

### 11.3 Gate 3: floating map positions

Move the current map-position terrain sample from
`MapMeasure.getSurfaceHeight()` to the elevation store. `Map` retains the last
resolved sample for the current XY and keeps one asynchronous refresh in
flight. The requested GSD is:

```text
viewExtent / mapNavSamplesPerViewExtent
```

`MapCamera` and current-position fixed/float conversion read that retained
sample synchronously. Moving to a new XY does not erase it while a new lookup
is pending. A result replaces the sample only if its requested XY is still the
current XY; an older result is discarded and the current XY is submitted.
When a current result arrives, `Map` marks the map dirty. This preserves a
continuous render loop without synchronous GPU reads.

The manual run uses `simple-terrain`, `complex-terrain`, and `full-terrain`.
The reviewer changes fixed and floating height modes, changes view extent, and
moves between areas with different terrain LOD. The displayed position must
keep the authored above-terrain offset, settle to finer terrain without a
camera discontinuity, and issue no navigation-tile request for the migrated
operation.

Implementation stops for manual validation after this gate.

### 11.4 Gate 4: pan motion

Move pan terrain following to the same retained current-position sample. Pan
input updates the desired XY immediately and queues the latest position after
the current request settles. The camera continues with the retained terrain
height meanwhile. A returned pan sample changes the terrain component of the
camera height even if input has advanced since submission, then lookup starts
for the latest queued XY. Pan therefore follows terrain with at most one
lookup in flight rather than issuing a request for every input event. Each
change preserves the user's above-terrain offset.

The manual run pans continuously over steep terrain in `complex-terrain` and
`full-terrain`, including direction reversals while a lookup is in flight.
The reviewer verifies that the camera neither enters the terrain nor jumps
when a new sample arrives, and that pan motion causes no navigation-tile
request. The matched `complex-terrain` FPS check from gate 2 is repeated with
continuous pan input.

Implementation stops for manual validation after this gate. RFC 13 is ready
to be marked implemented only after all four application gates have been
accepted.


## 12. Source changes

The expected ownership is:

| File | Change |
|---|---|
| `src/map/elevation-store.ts` | units, timed updates, lookup, readback state, and LRU |
| `src/map/terrain-traversal-sink.ts` | sink type and color/depth implementations |
| `src/map/refframe.ts` | migrate the current JS owner and add RF-node/tile-path lookup |
| `src/map/map.ts` | store ownership, explicit pass entry points, and current-position sample |
| `src/map/draw.js` | invoke the depth entry point without the complete map draw |
| `src/map/draw-traversal.ts` | retain traversal policy and dispatch selected rigs to a sink |
| `src/map/tile-render-rig.ts` | test normal readiness and draw unexaggerated height |
| `src/map/surface-tree.js`, `src/map/draw-tiles.js` | remove terrain-channel routing |
| `src/map/legacy-map.d.ts` | remove the declaration of channel-owned map state |
| `src/renderer/renderer.ts` | initialize each terrain pass without a global channel |
| `src/renderer/gpu/device.ts` | compact result target, pixel-pack buffer, and fence operations |
| `src/renderer/gpu/texture.ts` | packed unit texture and byte accounting |
| `src/renderer/shaders/elevation-*.glsl` | rasterization, reduction, and lookup |
| `src/viewer/viewer.ts` | public terrain query used by the waypoint demo |
| `src/viewer-config.ts` | store settings and the gate-2 diagnostic switch |
| `demos/waypoint/waypoint.js` | gate-1 consumer |
| `src/map/elevation-store-geodata-analysis.ts` | gate-2 coordinate collection, refresh, and report |
| `src/map/geodata-view.js` | invoke gate-2 analysis before worker processing |
| `src/map/camera.js`, `src/map/convert.js` | gate-3 current-position migration |
| `src/viewer/control-mode/map-observer.js` | gate-4 pan migration |

The implementation may reduce this list by placing an operation on an
existing owner. It must not create a second terrain traversal, duplicate
reference-frame routing, or expose `ElevationStore` through `Viewer`.


## 13. Alternatives

### Continue using navigation tiles

Rejected as the common height source. They duplicate terrain elevation, can
stop at a coarser LOD than the mesh, and omit delivered coverage. They do not
represent the composed terrain selected by the client.

### Continue server-side vector heightcoding

Rejected as the vector direction. It processes every geographic coordinate on
the server and retains the geodata free-layer and metatile formats which the
planned two-dimensional vector source removes.

### Query mesh triangles on the CPU

Rejected. It requires a CPU spatial index over retained irregular geometry,
duplicates GPU mesh residency, and does not provide the GSD hierarchy needed
for filtered lookup.

### Build the height field on the CPU

Rejected. Converting irregular meshes to a regular field is rasterization.
The GPU already owns the mesh and performs that operation directly.

### Add a separate elevation traversal

Rejected. It would duplicate the draw traversal's descent, fallback, source
order, and coverage rules. The shared traversal with explicit sinks preserves
one implementation of those rules.

### Add an elevation draw channel

Rejected. A third `Map.drawChannel` value would extend mutable pass state and
add elevation branches beside the existing color and depth branches. Explicit
sinks remove those branches from traversal and prevent auxiliary passes from
entering the complete color-frame draw.

### Build an ordered tile list before rasterization

Rejected for this change. Coverage masks and fallback draws are resolved while
the recursive traversal backtracks. Retaining an ordered list would also have
to retain that intermediate coverage state. Sinks separate rasterization from
selection without introducing another representation of the traversal result.

### Let lookup load terrain

Rejected. Lookup observes terrain already ready for rendering. Loading would
create a second terrain-demand and priority path.

### Use floating-point render targets

Rejected while they require optional WebGL extensions. Packed `RGBA8UI` is
renderable and readable in core WebGL2, and the explicit four-sample filtering
is outside the color render loop.

### Retain raw and opened VHR fields

Rejected. No consumer needs the raw VHR field. When opening is configured,
the opened result is the canonical stored terrain.


[vts-heightmap]:
https://github.com/cartolinadev/vts-libs/blob/1285bd1c0196bd96735f63494cfcad9f3baab447/vts-libs/vts/heightmap.cpp
[mapproxy-gsd-grid]:
https://github.com/cartolinadev/cartolina-tileserver/blob/d45071b3fcb35f30091a837510b6d356ac780656/mapproxy/src/tiling/unified.cpp#L409-L533
[vts-navtile-encoding]:
https://github.com/cartolinadev/vts-libs/blob/1285bd1c0196bd96735f63494cfcad9f3baab447/vts-libs/vts/opencv/navtile.cpp#L66-L117


## Review round 1

The design holds together: one traversal with explicit sinks, a UV-space
composition that reuses the existing coverage masks, and a lookup that
stays off the color render loop. The notes below are the places where the
text does not yet survive contact with `draw-traversal.ts`, the frame
uniform, or the existing reference-frame code.

### Direction

This is the right next change, and the right one now.

It deletes a concept rather than modelling one better. A navigation tile
is a second, separately produced representation of the same physical
surface as the mesh, and two representations will disagree forever; no
amount of ranking or lod-hinting in `MapMeasure.getSurfaceHeight()` closes
the 117 m at Mount Whitney, because the field genuinely stops at lod 7
there. Answering from the geometry the GPU actually rasterized removes the
disagreement instead of tuning it.

It is also on the critical path to the vector redesign, which is the
larger prize. Server-side heightcoding is what forces the tileserver to
decode every vector tile, sample a DEM, and emit a bespoke geodata format
with its own metatiles. Client elevation is what makes ordinary
two-dimensional vector tiles usable directly. That is the difference
between a VTS client and a web map library, and nothing else on the
backlog unlocks it.

The mechanism follows from that: the GPU already owns the mesh, so
rasterizing it into a regular field is the cheap operation and any CPU
alternative rebuilds mesh residency and a spatial index to get less.
Section 13 argues this honestly. Reusing the draw traversal rather than
writing a second one is the same judgement applied one level up, and the
sink extraction pays for itself independently: `drawChannel` is mutable
pass state read from five legacy modules, and removing it is worth doing
whether or not a store ever lands.

Three reservations.

**Gate 1 is not "the waypoint".** It is a new GPU resource class with its
own LRU and budget; asynchronous readback machinery the codebase does not
have in any form (no `fenceSync` and no `PIXEL_PACK_BUFFER` anywhere in
`src/`); three new shaders; a traversal-wide refactor; possibly a
`refframe.js` migration; and a new public API — validated by one marker
landing on one summit. The gating discipline is right, but four fifths of
the risk sits behind the weakest acceptance test. Consider splitting it:
the sink extraction and `drawChannel` removal are a behaviour-preserving
change that the existing screenshot and performance runs already validate
on their own, and landing that first leaves gate 1 as the store alone.

**The store is a cache of the current view, and consumers carry the
consequence.** Because population rides the frustum-culled traversal, a
query can always miss, so every consumer needs the same retain-last-value,
compare-height-and-GSD, refresh-after-settle protocol. The RFC specifies
it correctly three times — waypoint, map position, pan — and the vector
source will be the fourth, over thousands of coordinates. That protocol is
now a load-bearing convention of the library with no single owner. Either
name it and implement it once, or say plainly that it is a first step and
that a store which can be asked to cover a region is the end state.

**The 1000 ms interval is the one number in the design with nothing behind
it.** It does not set the latency of terrain following: a pan query
resolves through the fence path in a few animation ticks, and the store
only has to *cover* the position, not have been rebuilt recently. Coverage
during pan is better than the interval suggests, because composition is in
tile UV space with no scissor — a drawn rig writes its whole footprint
into the unit, so every visited tile contributes coverage well past the
viewport, and each coarser ancestor extends it further. Panning inside
that buffer is answered from resident units, and answering from a coarser
GSD is what `mapNavSamplesPerViewExtent` already does deliberately today.

What the interval does set is how long a newly covered or newly refined
region waits before it enters the store at all — fast motion into terrain
no pass has visited, where the best resident answer is a distant ancestor.
That is still better than the navtile path it replaces, which cannot
answer until a tile has been fetched and parsed. So the interval is not a
predicted failure; it is an untested policy sitting on the library's
tightest loop.

Two things would settle it. Give section 7.4 an on-demand trigger beside
the timer: a lookup that finds no unit at all, or one many levels coarser
than requested, schedules the next pass immediately rather than waiting
out the interval, rate-limited by the same setting. That turns the
interval into a refresh cadence instead of a correctness parameter, and
costs one flag. Then have gate 4 record the age and `actualGsd` of the
sample the camera is actually using during continuous pan, so the default
is chosen against a measurement rather than assumed.

One thing the design does not yet give consumers: `actualGsd` reports
horizontal resolution, but nothing reports vertical reliability. A coarse
unit's sample is a reduced average, and note 2 adds a floor of its own.
The map position and the camera make decisions from that number without
being able to see its uncertainty. Deferring that is reasonable; say so.

### 1. Backtrack hooks land after three early returns

Section 7.2 places `beginNode()` "after the children have completed and
before the current node's fallback surfaces are drawn". Three returns in
`traverseNode()` leave the function inside that window:

- [draw-traversal.ts:261](../../src/map/draw-traversal.ts#L261) — every
  quadrant off-screen;
- [draw-traversal.ts:265-266](../../src/map/draw-traversal.ts#L265-L266) —
  every on-screen quadrant watertight; and
- [draw-traversal.ts:314](../../src/map/draw-traversal.ts#L314) — a surface
  drew watertight, ending the surface loop.

The second one is the common case at coarse LODs and, in any view whose
on-screen quadrants are covered, at the top of the tree. A node that
returns there draws nothing, so an implementation that places the hooks
after the surface loop builds no unit for it. Section 4.3's "Reduction
continues through every ancestor up to the reference-frame node root" and
section 8's root pinning then never happen, and the coarse end of the GSD
ladder in section 5 is empty.

Section 7.2 already requires `endNode()` on every path that ran
`beginNode()`. The other half would settle it: `beginNode()` running at
every node that reached backtracking, whether or not a surface draws
there. A node with no draw and no published children then commits
nothing, and a node whose children covered it commits the reduction
alone. Naming the three returns in 7.2 would also help, since the hooks
read as belonging around the surface loop, which is exactly where they
must not go.

### 2. Reconstructed absolute position costs about half a metre of height

Section 3.2 rebuilds absolute physical coordinates as the camera-relative
position plus `uFrame.physicalEyePos.xyz`. Both are float32:
[renderer.ts:1073](../../src/renderer/renderer.ts#L1073) writes the frame
uniform through an `f32` view, and
[frame.inc.glsl:131](../../src/renderer/shaders/includes/frame.inc.glsl#L131)
does the same addition today for the exaggeration estimate. At an Earth
radius the float32 ulp is 0.5 m, and section 3.2's height is a difference
of two quantities of that magnitude (`dot(ecef - q, normal)`), so the
stored value carries roughly half a metre of quantization noise.

That noise is not static. `physicalEyePos` changes every frame, so the
same terrain rasterized at two elevation intervals quantizes differently.
Gate 4 asks the reviewer to confirm the camera does not jump when a new
sample arrives, and gate 3 that it settles without discontinuity; a
metre-scale step between passes is exactly what this produces.
[Backlog #55](backlog.md#backlog-55), which this section cites, requires
that the unified calculation "must still preserve the shader's
camera-relative precision" — the formula as written discards it.

The conversion should stay camera-relative. One way: supply per-draw
reference quantities computed on the CPU in double precision — the
submesh origin, its geodetic height, its zenith, and the prime-vertical
radius there — and evaluate height as a second-order expansion about that
origin. Whatever the mechanism, section 3.2 should state the achievable
accuracy, because the store's whole claim is that it agrees with the mesh
it rasterizes.

### 3. Three names for this node, none of them declared canonical

Withdrawing the first version of this note, which claimed RFC 13 coined
"RF node". It did not. `RFNode` is the vts-libs type — `nodeinfo.hpp`,
`RFNode::Id`, `rfNodeId()` in `tileop.hpp`, `sds2rfnode_` in
`ntgenerator.hpp` — vts-tools comments say "RF node" outright, and the
tileserver says "reference frame node" in `rf-mask/main.cpp` and
"reference-frame node" in its `tile-index.md`. RFC 13's vocabulary
matches upstream, and I had only searched this repository's wiki.

The finding that survives is different and smaller. Three names are in
live use and nothing states which one is authoritative. The tileserver
carries all three inside its own source: "reference-frame division node"
in `mapproxy/src/tiling/unified.hpp`, "Spatial division nodes" in
`mapproxy/src/tiling/main.cpp`, and bare "division node" throughout
`unified.cpp`. cartolina-js uses the third form only: `MapDivisionNode`,
`MapRefFrame.getSpatialDivisionNodes()`, and four uses of "division
nodes" in [reference-frames.md](reference-frames.md). A reader moving
between the two repositories has to work out that these are one thing.

Suggest settling it in [reference-frames.md](reference-frames.md), which
is the page that owns the concept: "reference frame spatial division
node" as the full term, with "reference-frame node" and "spatial
division node" as accepted short forms and bare "division node" avoided
because it drops the qualifier that makes it a reference-frame concept
rather than a map one.

The abbreviation is a separate matter, and there the original note was
half right. `RFNode` earns its contraction as a C++ type name; "RF node"
in prose is an initialism a reader has to expand, and a type name is not
a prose name. RFC 13's body uses it sixteen times across sections 5, 6,
8, 11, and 12 — "an RF node for which no grid sample can be evaluated",
"RF-node depth 16", "RF-node root units are pinned". Spelling those out
as "reference-frame node" costs nothing and removes the one part of the
vocabulary that actually reads as jargon.

`MapDivisionNode` is a legacy identifier and can stay as it is. Fixing
[reference-frames.md](reference-frames.md)'s own four uses is a wiki
edit rather than something RFC 13 should carry.

### 4. The rebuild skip cannot be evaluated where section 4.3 puts it

"Each unit records the ready render rigs which contributed to it... If
those inputs are unchanged at the next interval, the existing unit is
retained and no raster draw is submitted."

The sink learns which rigs contribute only from the `draw()` calls, which
arrive after `beginNode()` has cleared a replacement and reduced the
children. There is no point at which it can compare the rig set before
doing the work the comparison is meant to avoid.

Either drop it — it is a speculative optimization over roughly seventy
256 by 256 draws per second, with no measurement behind it — or move the
decision to `endNode()`, which can compare the accumulated rig set and
child revisions against the published unit and keep the old texture.

### 5. Section 5 divides by 256, section 4.2 says 255

`rootSpacing = sqrt(rootWidth * rootHeight) / 256` contradicts "The store
computes GSD from the actual 255 intervals, so the slightly coarser
spacing is explicit in lookup selection." The whole point of the 255-vs-257
argument in 4.2 is that the interval count is explicit, which makes 255
look like the intended divisor.

### 6. The hierarchy above a division-node root is undefined

Two problems share a root cause.

`refframe.js` parses `division.rootLod`, so section 5's `rootLod` in
`nominalSpacing(lod) = rootSpacing / 2^(lod - rootLod)` reads as that
field. It has to be the reference-frame node's own id lod — melown2015's four
nodes sit at LOD 1, earth-qsc's six at LOD 2 — and `rootWidth`/`rootHeight`
are that node's extents in its own projected SRS. Naming the field
explicitly would remove the ambiguity.

Above that lod the traversal is still descending: it starts at the surface
tree root, which is one global tile. A unit there would span several
reference-frame nodes with different projected SRSs, and section 5 has no
`rootWidth` to give it. Section 4.1 says only that "the store follows the
reference frame's tile hierarchy". The simplest resolution is for 4.1 to
say that units exist only at and below a reference-frame node root, and
that reduction stops there.

### 7. Two coverage rules meet at the same texel

Section 3.3 scopes the transient depth attachment to "one ready rig's
draw" and lets the greatest height win. Section 4.3 says a coarser or
lower-priority rig "fills gaps and does not replace established values".
Where reduced child coverage and a fallback draw overlap, those give
different answers, and they will overlap: the traversal mask is eroded by
`mapTraversalMaskErosion` (default 1) at the mask pool's resolution, while
reduction renormalizes weights over invalid neighbours and so widens
coverage by a sample at 256.

Two things would resolve it: stating when the depth attachment is
cleared — per rig draw, per node, or once per replacement — and letting
the coverage mask be the only coverage rule, with the depth test ordering
triangles inside a single draw and nothing more. Clearing per rig draw
gives that reading directly.

### 8. Say what bounds coverage, and say that it exceeds the viewport

`traverseNode` culls with `bboxVisible` at the root and at every child
quadrant, so the set of tiles that get units is bounded by what the
current and recent traversals visited. Section 4.1's "Different LODs may
cover different regions" is the closest the text comes, and section 2's
scope list does not mention it at all.

The property worth stating alongside it is the one that makes the bound
tolerable, and the RFC never claims it: composition happens in tile UV
space with no scissor, so a drawn rig writes its entire footprint into the
unit, not the on-screen part. A visited tile therefore covers its whole
extent, and each coarser ancestor covers more. Coverage reaches
substantially past the viewport, and it is why a query outside the current
view usually still answers.

Both would sit well in section 2: what limits coverage, and how far it
reaches beyond the frustum. Section 1 could then say what that means for
the intended vector source, whose coordinates can lie outside the view
that loaded their tile.

### 9. Position-to-node resolution exists, and division nodes overlap

Section 6.3 says the reference frame resolves a position to its node,
local coordinates, and tile path, "implemented once on `MapRefFrame`".
[measure.js:559](../../src/map/measure.js#L559) already implements the node
half as `MapMeasure.getSpatialDivisionNode()`, called from four sites in
`measure.js` and from
[geodata-builder.js:1495](../../src/map/geodata-builder.js#L1495). Step 2
of section 11.1 reads better as *move* it and repoint those callers — an
adopting change removes what it obsoletes.

That function also settles a case section 6 does not. Reference-frame
node extents overlap ([reference-frames.md](reference-frames.md), "How
partitioning ranges act at run time"), and the existing tiebreak takes the
highest-lod node. A position can therefore resolve to a node with no store
coverage while an overlapping node has some, and section 6.1 would return
`undefined`. Section 6.3 could say which node answers; falling through to
the next candidate in the existing highest-lod order costs little and
turns a miss into a coarser answer.

### 10. Sections 11 and 12 disagree about `refframe.js`

Step 2 of 11.1 says "Add RF-node and tile-path lookup to `MapRefFrame`".
Section 12 says `src/map/refframe.ts` — "migrate the current JS owner and
add RF-node/tile-path lookup". Migrating the module to TypeScript is a
separate body of work from adding a lookup to it, and gate 1 is already
the largest of the four.

Suggest keeping the migration out. The lookup this RFC needs is one
function moved
from `MapMeasure` (note 9) plus a tile-path walk, and both can land on
the existing `MapRefFrame` with a sibling `.d.ts` under the migration
rules. Section 12's row could say that, leaving `refframe.js` to be
migrated by whatever feature next needs the whole module.

### 11. The elevation pass overwrites shared traversal state

Section 7.2 moves draw statistics into the color sink, but the state that
matters here belongs to `drawTerrainTraversal()` and `renderTile()`, not
to the gates being extracted:

- `draw.drawCounter++` at
  [draw-traversal.ts:86](../../src/map/draw-traversal.ts#L86) and
  `tile.drawCounter` at
  [draw-traversal.ts:557](../../src/map/draw-traversal.ts#L557) advance the
  shared draw generation;
- `stats.usedNodes`, `stats.processedNodes`, and
  `stats.processedMetatiles` are written by the entry point itself at
  [draw-traversal.ts:112-114](../../src/map/draw-traversal.ts#L112-L114);
- `gpuCache.skipCostCheck` is toggled and `checkCost()` run around the
  descent; and
- `renderTile` gates on `stats.gpuRenderUsed >= draw.maxGpuUsed`.

A pass every second clobbers the inspector's per-frame counters and runs a
GPU cache cost check outside the color frame. The smallest change that
would keep one traversal: make the draw generation and the counters a
property of the pass rather than of `MapDraw` and `MapStats`, so the
entry point supplies the counter to advance and the object to accumulate
into, and only the color entry point supplies the frame-wide ones — with
the GPU cache check staying with the color frame.

### 12. The no-load metanode path skips a side effect the draw needs

`isMetanodeReady(tree, priority, preventLoad)` assigns `tile.surface` only
when `preventLoad` is false
([surface-tile.js:273-278](../../src/map/surface-tile.js#L273-L278)), and
`renderTile` bails at `if (!tile.surface) return 'partial'`. An elevation
pass that always passes `doNotLoad` can therefore only draw tiles a color
frame has already touched.

That is probably the behaviour you want. If it is not, the assignment
reads no resource and could move ahead of the `preventLoad` guard.
Either way, section 7.4 stating the coupling would save discovering it
during gate 1.

### 13. Section 8's rejected budget has no mechanism

"A runtime decrease... is rejected", "A smaller configured budget is
invalid". The config store validates per-key ranges; this is a cross-key
constraint against a parsed reference frame, which it cannot express.
Section 8 could say what happens at runtime. Clamping up to the smallest
viable budget and warning would keep a configuration value from failing a
map outright, which seems the kinder of the options.

While there, bound the reservation. Shipped frames have few
reference-frame nodes (melown2015 four, earth-qsc six), so the reserved
roots are under 2 MiB.
As written a reader cannot tell whether the reservation is bounded at all.

### 14. Two names for one operation

`ElevationStore.heightcode()` and `Viewer.queryTerrainElevation()` have the
same signature and the same meaning. Heightcoding is the tileserver's name
for adding height to delivered geodata, not for a point query — section 1
uses it that way. One name for both would read better, and the public
method's is the accurate one.

### 15. Smaller points

1. Section 3.2: the semi-minor axis is not in the frame uniform.
   `bodyParams` carries the major axis and the major-to-minor ratio (see
   the `uboFrame` block in
   [frame.inc.glsl](../../src/renderer/shaders/includes/frame.inc.glsl));
   say `b` is derived from it.
2. Section 6.3: the second color attachment can go. One `RGBA8UI` target
   with two rows — height in the first, preference index in the second —
   needs one attachment and one `readPixels`.
3. Section 6.3: fence polling needs to sit outside the dirty gate at
   [map.ts:981-997](../../src/map/map.ts#L981-L997) — the animation frame
   always runs, the draw does not. Worth a sentence in 6.3.
4. Section 8: `262144 + 40 * W` is unexplained. Naming the five buffers
   and their per-texel bytes would make it checkable. The rest of the
   section's arithmetic checks out.
5. Section 7.5 clears the store on a terrain source-list change but says
   nothing about a reference-frame change. Section 5 says
   `mapElevationStoreGsdGridSize` "requires a new map" — the `internal`
   scope tag carries that meaning; worth saying which tag it takes.
6. Section 12 lists `legacy-map.d.ts` for "the declaration of
   channel-owned map state". `drawChannel` is declared on `Map`
   ([map.ts:1347](../../src/map/map.ts#L1347)); `legacy-map.d.ts` only
   mentions it in a comment.
