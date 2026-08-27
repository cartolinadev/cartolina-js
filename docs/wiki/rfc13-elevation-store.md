# RFC 13: the elevation store

**Status:** In review — lookup and consumer design reopened after gate 2
failed its performance gate.
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
does not implement that source format. It implements the client-side
heightcoding machinery the format will use after geodata metatiles and
server-side heightcoding are retired.

Client-side heightcoding is camera-bound. It heightcodes geometry for the
current view at the terrain resolution the current view can use. It does not
populate terrain outside the traversal or above the resolution selected for
rendering, because geometry outside the current view is not drawn by that
view.

Raster elevation sources provide another illustration of the boundary. A
raster source already contains heights while `cartolina-surface` provides an
irregular mesh. A consumer should query the terrain selected by the map
without knowing which representation supplied it. Raster terrain itself is
out of scope.


## 2. Decision and scope

`Map` will own an elevation store. It is a bounded, temporal, GPU-backed
height field derived from terrain resources which are ready for normal
rendering.

Population follows the current frustum-culled terrain traversal. The LRU may
retain units populated by earlier views, but no off-camera pass refreshes them.
A visited rig is rasterized over its complete tile UV extent without a
viewport scissor. Its unit therefore extends beyond the visible part of the
tile, and reduced ancestors cover progressively larger regions. A lookup can
still miss. Current-view lookup is the only supported population model.

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

The design delivers:

- the store representation, population pass, lookup, and memory policy;
- one retained sample-set update operation for one or many positions;
- waypoint placement through the store;
- switchable client-side heightcoding for monolithic and tiled geodata,
  plus comparison against existing server-side heights;
- store-based resolution of floating map positions; and
- store-based terrain following during pan motion.

Each of the last four items is an implementation and manual validation gate.
Work stops after each gate until its manual result has been accepted.

The sink extraction and `drawChannel` removal land first as a separate,
behaviour-preserving foundation milestone. They are validated independently
before elevation-store implementation begins.

Out of scope: a two-dimensional vector source format, removal of geodata
metatiles from delivered tiled geodata, removal of server-side heightcoding as
a delivery option, raster terrain, full navigation-tile removal, node height
ranges, and VHR morphological opening. Sections 8 and 9 state the
representation constraints needed by those later changes.


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
camera-relative position produced by `uModel`. Both operands and the result are
float32. At Earth radius the reconstructed Cartesian components have a 0.5 m
unit in the last place. The subsequent ellipsoid calculation subtracts
quantities near Earth radius, so its camera-dependent height quantization is
of order one metre. The planned consumers do not require better than
metre-scale height.

The shader then converts the Cartesian position to geodetic height. The
semi-minor axis `b` is derived from the semi-major axis and major-to-minor
ratio in `uFrame.bodyParams`.

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
shared calculation. The elevation store needs the accurate formula for stored
height.

### 3.3 Terrain composition

The existing draw traversal owns composition. It selects terrain sources in
style order, handles partial coverage, and decides when a finer child or a
coarser fallback draws. The elevation store does not reproduce those rules.

The shared transient depth attachment is cleared before each ready rig draws.
Within that one draw it keeps the upper height where projected triangles
overlap. This matters for mesh data with overhangs; DEM-derived meshes normally
have one height at each XY. The depth test orders triangles from one rig only.
Across child reduction, fallback rigs, and terrain sources, the traversal's
coverage mask is the only coverage rule.

The reference frame's declared height range supplies the depth ordering. For
range `[minimum, maximum]`, the fragment shader writes:

```text
depth = (maximum - height) / (maximum - minimum)
```

The attachment is cleared to one and uses `LEQUAL`, so the greatest height
wins. A value outside the declared range is a reference-frame or terrain-data
error; the draw omits it.

Coverage from finer children and higher-priority sources is applied before a
fallback rig draws. A lower-priority or coarser rig therefore fills gaps and
does not replace established values.


## 4. Store representation

### 4.1 Logical layout

The store follows the reference frame's tile hierarchy at and below each
reference-frame node root. It does not create units for global traversal tiles
above those roots, because one such tile can span nodes with different
projected SRSs. Each resident tile in that range has one height-field unit.
Tile IDs are unique within a reference frame, so a tile ID `[lod, x, y]` is
the complete unit key.

A unit is a 256 by 256 grid. Its samples lie on the tile boundary:

```text
sample(i, j) = [ll.x + i * width / 255,
                ll.y + j * height / 255]
```

where `i` and `j` range from zero through 255. Adjacent units duplicate their
shared edge. A lookup is therefore bilinear within one unit, including the
strip next to any edge; it never needs a neighbouring unit or a seam rule.
The elevation raster draw expands tile geometry by half a texel so the fill
rule reaches the boundary texels and the stored grid includes both endpoints.

Different LODs may cover different regions. Fine units from an earlier view
may remain until eviction, but are not refreshed off camera. Coarser units
cover broader areas, and the root unit of every reference-frame node remains
resident after it first obtains coverage. Reduction stops at that root.

### 4.2 Texture format

Each unit owns one 256 by 256 `RGBA8UI` texture. A finite IEEE 754 float is
stored as four bytes. One NaN bit pattern represents no coverage. There is no
persistent mask texture; validity is part of the stored value.

The grid has 256 samples per tile and 255 sample intervals between duplicated
tile-boundary edges. Using 257 samples would provide 256 intervals, but a
257 by 257 texture loses the predictable power-of-two layout and 1024-byte
row. The store reports nominal gsd from the tile span divided by 256; the
boundary-sampled texture layout is a storage detail.

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

An update builds a shared replacement texture and publishes it only after the
whole reference-frame tile has been processed. The replacement is cleared to
the invalid value once. It is not cleared between terrain sources.

During traversal backtracking, the elevation sink first reduces published
child units and then draws the current node's selected fallbacks into
uncovered samples. All terrain sources selected at the node draw into the
same replacement in traversal order. The unit is committed after the node has
completed. A query therefore sees either the old complete unit or the new
complete unit, never an intermediate source.

Commit copies the replacement into the resident unit after all replacement
commands have been queued, and stamps that unit with the next build generation.
WebGL command order makes earlier lookups observe the previous contents and
later lookups observe the completed replacement. The shared replacement counts
as a fixed store allocation.

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
root. This supplies all coarser gsds even when fallback cadence skipped direct
rendering at an intermediate LOD. Every visited unit is rebuilt; skipping an
unchanged input set is deferred until a measurement justifies retaining and
comparing contributor state.


## 5. Lookup API

### 5.1 Obtaining / updating elevation samples

`ElevationStore` is internal and owned by `Map`. Its update operation updates a
reusable sample set:

```ts
updateTerrainSamples(
    sampleSet: ElevationStore.SampleSet,
): Promise<boolean>;
```

The promise resolves to `true` when at least one sample changed.

The associated internal types occupy the class's same-name namespace:

```ts
namespace ElevationStore {
    export type Position = readonly [number, number];

    export type SampleSet = {
        positions: readonly Position[];
        desiredGsd: number;
        samples?: (Sample | undefined)[];
    };

    export type Sample = {
        height: number;
        actualGsd: number;
        unit: UnitRef;
    };

    export type UnitRef = unknown;
}
```

`positions` are geographic positions being resolved to geodetic heights.
`desiredGsd` and `actualGsd` are nominal spacings in the reference-frame node
spatial division system: consumers choose `desiredGsd` in their own gates,
`actualGsd` is the nominal gsd of the store unit that supplied the height.

`samples` is optional on the first call; the store creates it and then updates
it in place. A missing or `undefined` sample means no retained covered value
for that position. `UnitRef` records the resolved node and its local
coordinate, plus the answering tile ID and that unit's build generation as the
walk's stop bound. The tile at any LOD is derived arithmetically from the local
coordinate, so no tile path is stored. The resolved node and local coordinate
may be retained before any pass covers the position, so a sample never repeats
spatial-division-node resolution. `UnitRef` is opaque to the consumer and does
not retain or pin a resident store unit.

A sample set represents one stable positions array. If those positions change,
the consumer creates a new sample set or clears `samples`. While an update is
queued or running, the store may keep a transient request record so repeated
calls for the same sample set share the same promise. That record is discarded
when the update settles or the store is disposed.

Clearing or disposing the store resolves pending updates with `false`, so no
update promise is left unsettled. A consumer that discards its sample set before
an in-flight update settles — a `MapGeodataView` killed by the cache, for
instance — marks the set disposed, and the store drops that update's writeback
rather than writing into freed geometry.

Implementation note: The current store-level `queryTerrainElevation()` becomes
`updateTerrainSamples()`. A caller that needs one result creates a one-position
sample set. Existing internal callers retain their sets instead of issuing
one-shot array queries.


### 5.2 gsd selection

The tile hierarchy is defined in the projected SRS of its reference-frame
node. A unit's gsd at LOD `lod` is:

```text
extentWidth = node.extents.ur[0] - node.extents.ll[0]
extentHeight = node.extents.ur[1] - node.extents.ll[1]
rootLod = node.id[0]
rootGsd = sqrt(extentWidth * extentHeight) / 256
gsd(lod) = rootGsd / 2^(lod - rootLod)
```

Implementation note: The current implementation converts gsd to physical metres
during lookup. Gate 1 removes that conversion from store selection and result
reporting. Selection and reporting stay in the reference-frame node's local
projected coordinates, removing per-lookup projection-scale conversion from the
store path.

Keep conversion functions for diagnostics or application APIs that need a
physical-metre estimate for a gsd, but do not retain per-node conversion grids.
That conversion is reference-frame support, not store selection policy. The
existing numerical-Jacobian helper may remain in `ElevationStore` or move to
`Map` while `MapRefFrame` is still a legacy JavaScript module; the later
reference-frame refactor moves it to the reference-frame owner.

### 5.3 Sample protocol

A sample set is caller-owned retained storage for one stable list of
geographic positions. The caller submits the same sample set while that list
and its requested gsd remain valid. The store updates `samples` in place and
keeps no settled request state of its own.

Consumers request updates only when they need the samples:

- tiled geodata updates from `MapGeodataView.isReady()` while preparing a
  rendered tile view for the current frame;
- monolithic geodata updates from its layer `MapGeodataView` while the layer is
  active in the current frame;
- current map position and pan following update from `Map` for the current
  requested XY; and
- waypoints update when their owner asks for a fresh terrain height.

Sample-set ownership follows the same boundary:

- tiled geodata owns one sample set per rendered tile `MapGeodataView`;
- monolithic geodata owns one sample set on the layer `MapGeodataView`,
  whether the payload came from a URL, inline data, or `MapGeodataBuilder`;
- current map position and pan following use one-position sample sets owned by
  `Map`; changing the requested XY replaces the sample set, while the last
  accepted terrain height is retained separately until the new set answers; and
- waypoint owners keep one sample set for the waypoint positions they manage.

For retained sample-set consumers, the requested gsd is:

- tiled geodata: rendered geodata tile nominal side (from reference frame)
  divided by `displaySize`;
- waypoints: zero;
- monolithic geodata: highest current rendered terrain LOD's (from stats)
  nominal tile side divided by 256, reprocessing the whole set on a change.
  Monolithic layers carry few coordinates by design, so this stays cheap and is
  not the vector workload gate 2 stresses; and
- current map position and pan following: the existing float/fix conversion
  rule. `MapMeasure.getOptimalHeightLod()` computes the target LOD:

  ```text
  log2(mapNavSamplesPerViewExtent * nodeExtent / viewExtent) - 8 + node.id[0]
  ```

  The store request uses that LOD's nominal gsd.

Implementation note: The current gate-2 implementation uses
`MapGeodataHeightcoder` and `Map.queryTerrainElevationNav()` to rebuild query
arrays from unresolved indices and tick them from map-level state. Remove that
global lifetime. Rewrite `MapGeodataHeightcoder` as a TypeScript component
owned by each `MapGeodataView`; the view supplies the same retained sample-set
lifecycle for tiled and monolithic payloads. Tile-tree traversal decides which
tiled views ask for updates. A tiled view not prepared for the current frame
does not reach the update call.


### 5.4 Query execution

`updateTerrainSamples()` scans the sample set and builds a temporary batch of
samples that can change. A retained sample's `UnitRef` describes its previous
answer, not the request, so it remains valid when `desiredGsd` changes. For a
sample whose position is not yet resolved, the store first resolves its
reference-frame node and local coordinate.

A consumer may call every frame, but need not. A set whose samples are all
settled at the current request and build generation produces an empty batch.
A settled outcome changes only when a later pass commits a unit, so the store
tracks the last committed generation and short-circuits a settled set without
rescanning until then.

For each sample, the store calculates its ideal LOD from the gsd formula in
section 5.2:

```text
idealLod = desiredGsd === 0
    ? Infinity
    : max(rootLod, rootLod + floor(log2(rootGsd / desiredGsd)))
```

For a positive gsd no greater than `rootGsd`, `idealLod` identifies the finest
unit whose nominal gsd is at least `desiredGsd`. A coarser request clamps to
the node root. At zero, the ideal LOD is unbounded. The store tracks the
deepest LOD it holds and calculates:

```text
startLod = min(idealLod, deepestLod)
```

`startLod` only bounds the walk and does not change `idealLod`.

The store walks from `startLod` towards the node root in fine-to-coarse order.
Each resident unit carries a build generation stamped at commit (section 4.3),
and `UnitRef` records the answering unit's generation. When the walk reaches the
retained answering tile it stops there, but re-reads that tile when a resident
unit's generation differs from the retained one, because section 6.5 rebuilds
the same tile ID as finer rigs contribute. An unchanged generation — the empty
walk when the retained tile is also the start tile — accepts the retained sample
without GPU work. If the retained tile is not encountered, the walk includes the
node root. The store records each resident unit encountered in fine-to-coarse
order. If none is resident, the sample is unchanged.

When `desiredGsd` grows — a consumer zooming out — `startLod` can fall below the
retained tile, so the walk does not encounter it and re-answers from a coarser
resident unit. A retained sample therefore re-targets to the requested
resolution; the store matches the request, it does not only refine.

The GPU lookup batch contains one pair for each submitted sample and resident
unit. Pairs are grouped by unit so each unit texture is bound once. The shader
bilinearly reads the four neighbouring stored heights and discards when any
non-zero-weight neighbour is invalid. Depth keeps the first covered answer in
fine-to-coarse order. A miss leaves the retained sample unchanged.

Readback is asynchronous. Chunks are no wider than the device limit and reuse
the result target; each has a transient pixel-pack buffer. `Map.update()` polls
fences outside the dirty-frame draw gate, so lookup completion does not depend
on rendering a color frame. When a chunk completes, answered samples are
updated in place with `height`, `actualGsd`, and the new `UnitRef`. Repeating an
update for a sample set already queued or running returns the same promise.

Implementation note: Replace the current one-shot query queue with transient
in-flight records keyed by sample set. Add a concrete `UnitRef` that retains
the resolved node, local coordinate, answering tile ID, and answering unit
generation. Keep the existing deepest-resident-LOD tracker. Only samples without
a resolved position run spatial-division-node resolution; the rest reuse it and
the bounded walk above.
Remove physical-gsd conversion from query execution. Adapt batch assembly and
readback to update `SampleSet.samples` in place, including the new `UnitRef`,
and resolve the shared promise from those changes. The GPU lookup and readback
resources remain the same; they receive only the pairs selected by the walk.

### 5.5 Public sample sets

The waypoint demo is outside `Map`, so `Viewer` exposes the same retained
sample-set operation:

```ts
updateTerrainSamples(
    sampleSet: Viewer.TerrainSampleSet,
): Promise<boolean>;

namespace Viewer {
    export type TerrainSampleSet = {
        positions: readonly (readonly [number, number])[];
        desiredGsd: number;
        samples?: (TerrainSample | undefined)[];
    };

    export type TerrainSample = {
        height: number;
        actualGsd: number;
        unit: unknown;
    };
}
```

Its positions and heights use section 3.1. `unit` is an opaque retained handle:
application code does not inspect or change it, but retains the same sample set
so the next call returns it to the store. The Viewer sample-set types are public
types, not aliases of `ElevationStore` or `Map` types. The operation exposes no
store placement policy or resource lifetime.

Implementation note: Remove `Viewer.queryTerrainElevation()` and its
`Map.queryTerrainElevation()` bridge. `Viewer.updateTerrainSamples()` forwards
the retained set to the store-facing path and preserves the opaque unit handle.
The waypoint demo owns one Viewer sample set for all two-dimensional markers,
submits it when marker heights are needed, and reads the updated samples in
their existing order.


## 6. Population and lifecycle

### 6.1 One traversal, three sinks

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

### 6.2 Sink contract

`drawTerrainTraversal()` receives the sink, a pass-wide `doNotLoad` flag, and
pass-owned traversal state. Rig readiness keeps the existing
`MapStats.gpuRenderUsed` accounting; the value is reset before terrain reads it
in a dirty color frame, while auxiliary passes use `doNotLoad`.

Color traversal state also supplies its draw generation and node and metatile
counters. The traversal updates legacy tile and metatile generation fields and
publishes counters only when that color accounting is present. Depth and
elevation omit it, so they cannot overwrite the inspector's color-frame state.

Only the color caller brackets traversal with `gpuCache.skipCostCheck` and
`checkCost()`. Auxiliary passes leave normal cache enforcement active. The
pass-wide `doNotLoad` flag is combined with the traversal's existing
off-cadence no-load rule. The sink contract is an internal structural type. It
has two required operations and two optional node hooks:

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

`beginNode()` runs during backtracking after child recursion and before any
post-child return or fallback draw. It therefore runs before the all-off-screen
return, the children-covered return, and the watertight surface-loop return.
`endNode()` receives only whether the completed node has coverage. It does not
expose watertightness or another traversal state to the sink. Every node for
which `beginNode()` ran reaches `endNode()` exactly once on each of those
returns and on the final partial-or-empty path. A node with neither a draw nor
a published child commits nothing; a node covered by published children can
commit reduction without a fallback draw. Color and depth omit both hooks.

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

### 6.3 Pass entry points

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

### 6.4 Timing and resource demand

The store is always present after the reference frame is ready. There is no
enable setting.

`mapElevationStoreUpdateIntervalMs` is a `runtime` setting defaulting to
1000 ms. It is the minimum time between elevation-pass starts and accepts a
non-negative value; zero makes every animation frame eligible. A runtime
change applies to the next eligibility check. A due pass runs from the current
camera state whether or not a color frame was drawn since the previous pass.
It uses the traversal's existing no-load path for metanodes and
`TileRenderRig.isReady(..., { doNotLoad: true })` for render rigs. A resource
which is not ready for normal rendering contributes nothing at that interval
and is reconsidered later.

Lookups do not start or accelerate elevation passes. Consumers request sample
updates opportunistically while they need them. A later elevation pass admitted
by `mapElevationStoreUpdateIntervalMs` may make a better answer available.

The elevation pass never marks a resource used in a way that changes loader
priority, and never creates a terrain request. It may allocate store textures
and submit raster or reduction draws.

The no-load metanode check intentionally does not assign `tile.surface`.
Elevation can therefore draw only a tile which the normal color traversal has
already classified, although it need not wait for that traversal to draw the
ready rig. This keeps the auxiliary pass from creating terrain ownership or
demand as a side effect.

### 6.5 Lifetime

`Map` constructs the store when its reference frame is ready and disposes it
before the renderer. Map disposal, replacement of the reference frame, and a
terrain source-list change clear every unit and pending readback.

Vertical exaggeration, imagery, atmosphere, and lettering do not clear the
store. Ready terrain resources are immutable; when a different ready rig or a
new child unit contributes, the next timed pass replaces the affected unit.


## 7. Memory and eviction

`mapElevationStoreGPUCache` is a `construction` setting which sets the maximum
GPU memory owned by the store in MiB and defaults to 192. Fixed replacement
and lookup resources are reserved from the limit before resident units are
admitted.

With maximum texture width `W`, the reserved allocations are:

- one 256 by 256 replacement texture at four bytes per texel:
  `262144` bytes;
- its 256 by 256 depth attachment at four bytes per texel:
  `262144` bytes;
- one two-row `RGBA8UI` lookup result attachment at four bytes per texel:
  `8 * W` bytes;
- one matching two-row lookup depth attachment at four bytes per texel:
  `8 * W` bytes;
- one transient pixel-pack buffer for the two result rows: `8 * W` bytes; and
- one reusable lookup point-input buffer with 16 bytes per record:
  `16 * W` bytes.

The total logical reservation is:

```text
524288 + 40 * W bytes
```

At a common `W = 16384`, that is 1.125 MiB and leaves room for 763 resident
units in the 192 MiB default.

Unpinned units use least-recently-used eviction. Building a unit and returning
a successful lookup both move it to the front of the LRU list. The least
recently built or queried leaf unit is removed first. A parent remains while
it has a resident child. Reference-frame node root units are pinned after they
obtain coverage, so every visited node retains its coarsest available field.

When the reference frame is parsed, `Map` calculates a minimum effective
budget: the fixed allocation and one unit for every reference-frame node root.
The reference frames documented in
[reference-frames.md](reference-frames.md) have at most six nodes, so root
textures reserve at most 1.5 MiB. If the configured value is smaller, the
store warns once and raises its effective budget without changing the reported
construction setting. This preserves the coarse-result guarantee without
failing map creation.

Before allocating a resident unit, the store evicts eligible units until it
fits. If the pinned roots leave insufficient space, that unit is skipped until
a later pass. Allocated resources never exceed the effective budget.

Eviction releases only the GPU unit and its metadata. It does not change a
sample already held by a consumer. The store owns no persistent CPU copy of
the height fields. In addition to unit textures, the store owns one shared
256 by 256 replacement texture and depth attachment, one two-row lookup color
and depth target, one transient pixel-pack buffer, and one point-input buffer.
The lookup allocations are capped by the device's maximum texture width. Store
CPU memory consists of unit metadata and transient update records; consumers
own completed samples.


## 8. Future node height ranges

Node minimum and maximum heights are not implemented. Until they exist, a
vector traversal can use the reference frame's global height range for every
node. This weakens culling but does not reject valid geometry. Another option is
too reuse terrain traversal for vector traversal (abstracting metanode
operations away from the traversal itself, the same we did with sinks). Both
is out of scope of this effort.

The 256 by 256 boundary-sampled units leave a direct later path: reduce the
finite samples for a tile to a minimum and maximum and cache that pair on the
CPU under the same tile ID. Missing pairs fall back to the global range. The
pair describes the canonical store field, including VHR opening when that is
configured; it does not replace terrain-rendering bounds.


## 9. Future VHR morphological opening

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
to pixels before running the operation. A later VHR design should reuse those
semantics. No opening shader, configuration, or retained raw field is added
here.


## 10. Implementation and validation sequence

Implementation begins with one behaviour-preserving foundation milestone,
then proceeds through four application gates. Mechanism-level diagnostics may
explain a failure, but they are not acceptance gates and do not replace the
application run. After each gate, implementation stops for a manual
application run. Work on the next gate begins only after the reviewer accepts
that result.

### 10.1 Foundation: explicit traversal sinks

Extract the existing color and depth gates from
`drawTerrainTraversal()` into the two sinks defined in section 6. Remove
`Map.drawChannel`, give color frames and depth updates explicit entry points,
and move draw generation and counters into pass-owned state. This milestone
adds no elevation resource, shader, setting, or public API.

Run the three canonical public screenshot cases sequentially, exercise depth
hit testing, and run the matched `complex-terrain` performance capture. Land
the foundation as its own commit before elevation-store implementation.

### 10.2 Gate 1: waypoint

#### Goals

Deliver the elevation-store sample protocol and its public Viewer counterpart
for one retained waypoint sample set. The gate does not heightcode geodata.

The waypoint demo at the Mount Whitney position `[-118.302348, 36.560197]`
must appear on rendered terrain, retain its last height while an update is
pending, and follow later store updates. It adds no terrain request.

#### Existing work

The elevation population, resident-unit cache, GPU lookup, asynchronous
readback, LRU budget, and deepest-resident-LOD tracker already exist. Lookup
still uses a one-shot `Request` queue, physical-gsd selection, and public
`queryTerrainElevation()` bridges. The waypoint rebuilds a positions array,
keeps a separate result array, and drives the one-shot query periodically.

#### Changes needed

Replace the queue and its result arrays with the sample-set protocol in sections
5.1 through 5.5. Batch selection scans a `SampleSet`, resolves a position only
when it has no `UnitRef`, follows the nominal unit walk, and writes the answer
back to the same set. The deepest-resident-LOD tracker remains only the lookup
bound. Remove physical-gsd selection, its per-node interpolation grids, and
`mapElevationStoreGsdGridSize`. Remove `queryTerrainElevation()` from
`ElevationStore`, `Map`, and `Viewer`; add the Viewer sample-set operation.
Replace the waypoint's position array, pending flag, and separate result array
with one retained Viewer sample set.

### 10.3 Gate 2: client geodata heightcoding

#### Goals

Deliver the purpose of the store: switchable client-side heightcoding of both
monolithic and tiled geodata. It has two settings:

```text
mapHeightcoding = legacy | store
mapHeightcodingShadow = false | true
```

`mapHeightcoding` defaults to `legacy`; `mapHeightcodingShadow` defaults to
`false`.

`legacy` draws the delivered server-heightcoded geometry. `store` draws the
same geodata heightcoded from the elevation store. `mapHeightcodingShadow` is
available only with `store`: it retains the delivered legacy heights as the
comparison reference and publishes store-minus-legacy statistics, but the
store-heightcoded geometry remains the geometry shown on the map. There is no
third comparison render mode.

Visual inspection is the primary acceptance test. On both monolithic and tiled
layers, compare `legacy` and `store` through movement, zoom, and terrain LOD
changes; store geometry must remain attached to the rendered terrain. With
shadow enabled, the visible result remains the store geometry and the report
tracks the same live views. Store heightcoding adds no terrain request and
never updates a view outside the current frame.

At 1920 by 1080, store heightcoding must not reduce matched measured FPS by
more than ten percent. The bound is measured separately on both paths, because
their cost differs: a tiled layer settles per rendered tile view, while a
monolithic layer requests one gsd for its whole set and reprocesses every
coordinate atomically each time the highest rendered terrain LOD changes. The
gate uses the `a-3d-mountain-map` mapConfig that carries both a `geodata-tiles`
and a `geodata` free layer, loaded through the compatibility library, so one
case exercises both paths; a config variant lacking the monolithic `geodata`
layer does not qualify. Each capture includes a zoom that raises the highest
rendered terrain LOD. A failure on either blocks the gate and requires
optimization or reconsideration of the approach.

#### Existing work

`MapGeodataView.isReady()` starts a tiled-only shadow collection before worker
processing. `MapGeodataHeightcoder` owns sample arrays and is ticked globally
by `Map`; `Map.queryTerrainElevationNav()` feeds it one-shot batches. The
global `ElevationStoreGeodataAnalysis` retains every collected tiled payload.
`MapGeodataBuilder` separately heightcodes and rebuilds only builder-created
monolithic free layers. The debug-only shadow switch never changes what is
drawn, so delivered server-heightcoded geometry remains visible.

The previous gate allowed at most a ten-percent FPS reduction. Its matched
`complex-terrain` capture used JSON geodata at 1920 by 1080. Enabling the
shadow reduced achieved FPS from about 60 to about 39, near 35 percent, while
terrain-request counts remained identical at 1116. The engine profiler moved
only from 45.7 to 43.7 fps because it measured draw time, not frames rendered.
A direct probe measured `ElevationStore.resolveBatch()` at about 3.86 ms per
frame while it resolved about 50000 coordinates per second. `desiredGsd` was
zero, so the global engines queried their whole sets continuously, and each
query repeated division-node resolution, projection-scale interpolation,
tile-path walking, key construction, and resident-unit lookup for every
coordinate.

#### Changes needed

Every `MapGeodataView` must retain geographic source coordinates, authored
float offsets, delivered legacy heights, and one sample set. Existing payloads
obtain the source data by converting delivered physical coordinates once; a
later two-dimensional payload supplies it directly. In store mode, add each
sampled geodetic terrain height to its float offset and process the resulting
geometry for rendering. Legacy mode uses the delivered height.

Tiled data owns one set per rendered tile view. Its draw preparation requests
updates using the tile-side/display-size gsd. Monolithic data owns one set on
its layer view, whether from a URL, inline data, or `MapGeodataBuilder`; its
active view requests updates from the highest rendered terrain LOD as specified
in section 5.3. A changed set reprocesses the whole view and atomically replaces
its geometry. A tiled view that is not prepared for the current frame does not
request samples.

Rewrite `MapGeodataHeightcoder` around one view-owned sample set. Remove
`Map.queryTerrainElevationNav()`, the heightcoder's global registration and
tick, and `ElevationStoreGeodataAnalysis`. Remove `MapGeodataBuilder`'s
heightcoder lifetime and bound-free-layer rebuild. Migrate the measure tool
from `processHeights()` to its own retained sample set, then remove
`processHeights()` and `stopHeightcoding()`. Replace the debug shadow switch
with `mapHeightcoding` and `mapHeightcodingShadow`. Shadow statistics read the
same live view sample sets which supply the visible store geometry; they record
coordinate count, covered count, actual gsd, refresh count, and
store-minus-legacy height difference as mean, standard deviation, p50, p90,
p99, minimum, and maximum. Equality is not required because delivered heights
and composed terrain can differ.

### 10.4 Gate 3: floating map positions

Move the current map-position terrain sample from
`MapMeasure.getSurfaceHeight()` to the elevation store. `Map` owns a
one-position sample set for the requested XY and retains the last accepted
terrain height separately. Changing XY replaces the set but not that height.
The requested gsd follows the float/fix conversion rule in section 5.3.

`MapCamera` and current-position fixed/float conversion read the retained
height synchronously. `Map` requests updates for the current set as needed;
repeated calls for that set share its promise. A completion is applied only if
its set is still current. A changed sample marks the map dirty. This preserves
a continuous render loop without synchronous GPU reads.

The manual run uses `simple-terrain`, `complex-terrain`, and `full-terrain`.
The reviewer changes fixed and floating height modes, changes view extent, and
moves between areas with different terrain LOD. The displayed position must
keep the authored above-terrain offset, settle to finer terrain without a
camera discontinuity, and issue no navigation-tile request for the migrated
operation.

Implementation stops for manual validation after this gate.

### 10.5 Gate 4: pan motion

Move pan terrain following to the same retained current-position mechanism.
`Map` keeps one submitted one-position sample set and the latest unsubmitted
XY. Input replaces the latter immediately while the camera continues with the
retained terrain height. When the submitted update completes, its answer
becomes the newest terrain observation even if input has advanced; `Map` then
submits a new set for the latest XY. This bounds queued work without issuing an
update for every input event. Each accepted height preserves the user's
above-terrain offset.

The manual run pans continuously over steep terrain in `complex-terrain` and
`full-terrain`, including direction reversals while a lookup is in flight.
The reviewer verifies that the camera neither enters the terrain nor jumps
when a new sample arrives, and that pan motion causes no navigation-tile
request. Record the age and `actualGsd` of every retained sample used by the
camera. The matched `complex-terrain` FPS check from gate 2 is repeated with
continuous pan input.

Implementation stops for manual validation after this gate. Mark the design
implemented only after all four application gates have been accepted.


## 11. Source changes

The expected ownership is:

| File | Change |
|---|---|
| `src/map/elevation-store.ts` | units, retained sample updates, lookup, readback state, and LRU |
| `src/map/terrain-traversal-sink.ts` | sink type and color/depth implementations |
| `src/map/refframe.js`, `src/map/refframe.d.ts` | move node selection to the current owner and add tile-path and nominal-gsd helpers without migrating it |
| `src/map/measure.js`, `src/map/geodata-builder.js` | use reference-frame-owned node selection |
| `src/map/map.ts` | store ownership, channel removal, explicit pass entry points, fence polling, and current-position sample |
| `src/map/draw.js` | invoke the depth entry point without the complete map draw |
| `src/map/draw-traversal.ts` | retain traversal policy, consume pass-owned state, and dispatch selected rigs to a sink |
| `src/map/tile-render-rig.ts` | test normal readiness and draw unexaggerated height |
| `src/map/surface-tree.js`, `src/map/draw-tiles.js` | remove terrain-channel routing |
| `src/renderer/renderer.ts` | initialize each terrain pass without a global channel |
| `src/renderer/gpu/device.ts` | compact two-row result target, pixel-pack buffer, and fence operations |
| `src/renderer/gpu/texture.ts` | packed unit texture and byte accounting |
| `src/renderer/shaders/elevation-*.glsl` | rasterization, reduction, and lookup |
| `src/viewer/viewer.ts` | public retained terrain sample sets used by the waypoint demo |
| `src/viewer-config.ts` | store settings, `mapHeightcoding`, and `mapHeightcodingShadow` |
| `demos/waypoint/waypoint.js` | gate-1 consumer |
| `src/map/geodata-heightcoder.ts` | retained sample-set heightcoding owned by one geodata view |
| `src/map/elevation-store-geodata-analysis.ts` | remove the global comparison path |
| `src/map/geodata-view.js` | own and drive heightcoding for tiled and monolithic geodata |
| `src/map/geodata-builder.js` | remove heightcoding state, `processHeights()`, `stopHeightcoding()`, and free-layer rebuilds |
| `src/viewer/ui/control/measure.js` | own the retained sample set for area measurement |
| `src/map/camera.js`, `src/map/convert.js` | gate-3 current-position migration |
| `src/viewer/control-mode/map-observer.js` | gate-4 pan migration |

The implementation may reduce this list by placing an operation on an
existing owner. It must not create a second terrain traversal, duplicate
reference-frame routing, or expose `ElevationStore` through `Viewer`.


## 12. Alternatives

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
duplicates GPU mesh residency, and does not provide the gsd hierarchy needed
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

*Adopted. Section 11 now lands the sink extraction and `drawChannel` removal
as a separately validated foundation commit before gate 1 adds the store.*

**The store is a cache of the current view, and consumers carry the
consequence.** Because population rides the frustum-culled traversal, a
query can always miss, so every consumer needs the same retain-last-value,
compare-height-and-gsd, refresh-after-settle protocol. The design text
specified it three times — waypoint, map position, pan — and the vector
source would add thousands of coordinates. That protocol is
now a load-bearing convention of the library with no single owner. Either
name it and implement it once, or say plainly that gate 2 must make that
shared coordinate-set machinery carry the visible vector workload.

*Partially adopted. Section 6.1 names the retained-sample protocol and section
11.3 makes geodata heightcoding its main coordinate-set consumer. Map position,
pan motion, and application geometry still react differently to a changed
value, so the low-level store operation remains a query rather than a retained
sample owner.*

**The 1000 ms interval is the one number in the design with nothing behind
it.** It does not set the latency of terrain following: a pan query
resolves through the fence path in a few animation ticks, and the store
only has to *cover* the position, not have been rebuilt recently. Coverage
during pan is better than the interval suggests, because composition is in
tile UV space with no scissor — a drawn rig writes its whole footprint
into the unit, so every visited tile contributes coverage well past the
viewport, and each coarser ancestor extends it further. Panning inside
that buffer is answered from resident units, and answering from a coarser
gsd is what `mapNavSamplesPerViewExtent` already does deliberately today.

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

*Adopted. Section 7.4 adds a rate-limited on-demand pass for misses and
coarser fallback answers, and gate 4 now records retained-sample age and gsd
before the 1000 ms default is accepted.*

One thing the design does not yet give consumers: `actualGsd` reports
horizontal resolution, but nothing reports vertical reliability. A coarse
unit's sample is a reduced average, and note 2 adds a floor of its own.
The map position and the camera make decisions from that number without
being able to see its uncertainty. Deferring that is reasonable; say so.

*Adopted. Section 5 now separates horizontal gsd from vertical reliability
and defers a reliability value to later vector-format placement rules.*

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
section 8's root pinning then never happen, and the coarse end of the gsd
ladder in section 5 is empty.

Section 7.2 already requires `endNode()` on every path that ran
`beginNode()`. The other half would settle it: `beginNode()` running at
every node that reached backtracking, whether or not a surface draws
there. A node with no draw and no published children then commits
nothing, and a node whose children covered it commits the reduction
alone. Naming the three returns in 7.2 would also help, since the hooks
read as belonging around the surface loop, which is exactly where they
must not go.

*Adopted. Section 7.2 places `beginNode()` before all three post-child exits
and requires exactly one `endNode()` on every subsequent return path.*

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

*Rejected. The planned heightcoding scenarios do not require sub-metre
precision. Compensated position arithmetic would add complexity without serving
a requirement.*

### 3. Three names for this node, none of them declared canonical

Withdrawing the first version of this note, which claimed the design coined
"RF node". It did not. `RFNode` is the vts-libs type — `nodeinfo.hpp`,
`RFNode::Id`, `rfNodeId()` in `tileop.hpp`, `sds2rfnode_` in
`ntgenerator.hpp` — vts-tools comments say "RF node" outright, and the
tileserver says "reference frame node" in `rf-mask/main.cpp` and
"reference-frame node" in its `tile-index.md`. The vocabulary matches
upstream, and I had only searched this repository's wiki.

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
a prose name. The body uses it sixteen times across sections 5, 6,
8, 11, and 12 — "an RF node for which no grid sample can be evaluated",
"RF-node depth 16", "RF-node root units are pinned". Spelling those out
as "reference-frame node" costs nothing and removes the one part of the
vocabulary that actually reads as jargon.

`MapDivisionNode` is a legacy identifier and can stay as it is. Fixing
[reference-frames.md](reference-frames.md)'s own four uses is a wiki
edit rather than elevation-store design work.

*Adopted. [reference-frames.md](reference-frames.md) now declares the full
term and its two accepted short forms. The body spells out every prose use;
the legacy class name remains unchanged.*

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

*Adopted. Section 4.3 drops the speculative skip. Every visited unit is
rebuilt unless later measurement justifies contributor tracking.*

### 5. Section 5 divides by 256

`rootSpacing = sqrt(rootWidth * rootHeight) / 256` uses the tile-resolution
divisor rather than the 255 intervals between boundary samples. Section 4.2
needs to keep that storage detail separate from nominal gsd selection.

*Adopted. Section 5 uses the tile-resolution divisor.*

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

*Adopted. Sections 4.1 and 5 bound units and reduction to each
reference-frame node root and use `node.id[0]` as the LOD origin.*

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

*Adopted. Section 3.3 clears depth per rig and makes the traversal mask the
only coverage rule across draws and reductions.*

### 8. Say what bounds coverage, and say that it exceeds the viewport

`traverseNode` culls with `bboxVisible` at the root and at every child
quadrant, so the set of tiles that get units is bounded by what the
current and recent traversals visited. Section 4.1's "Different LODs may
cover different regions" is the closest the text comes, and section 2's
scope list does not mention it at all.

The property worth stating alongside it is the one that makes the bound
tolerable: composition happens in tile UV space with no scissor, so a drawn
rig writes its entire footprint into the unit, not the on-screen part. A
visited tile therefore covers its whole
extent, and each coarser ancestor covers more. Coverage reaches
substantially past the viewport, and it is why a query outside the current
view usually still answers.

Both would sit well in section 2: what limits coverage, and how far it
reaches beyond the frustum. Section 1 could then say what that means for
the intended vector source, whose coordinates can lie outside the view
that loaded their tile.

*Adopted. Section 2 now states both the frustum-visited bound and full-tile
UV coverage. Section 1 states that vector heightcoding is camera-bound.*

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

*Adopted. Section 6.3 moves selection to
`MapRefFrame.resolveSpatialDivisionNodes()`, repoints the existing callers,
and tries overlapping candidates in the established highest-LOD-first order.*

### 10. Sections 11 and 12 disagree about `refframe.js`

Step 2 of 11.1 says "Add RF-node and tile-path lookup to `MapRefFrame`".
Section 12 says `src/map/refframe.ts` — "migrate the current JS owner and
add RF-node/tile-path lookup". Migrating the module to TypeScript is a
separate body of work from adding a lookup to it, and gate 1 is already
the largest of the four.

Suggest keeping the migration out. The lookup needs one function moved
from `MapMeasure` (note 9) plus a tile-path walk, and both can land on
the existing `MapRefFrame` with a sibling `.d.ts` under the migration
rules. Section 12's row could say that, leaving `refframe.js` to be
migrated by whatever feature next needs the whole module.

*Adopted. Sections 11 and 12 keep `refframe.js`, add a sibling declaration,
and limit the change to moving selection plus adding the tile-path walk.*

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

*Adopted. Section 7.2 makes GPU-build usage pass-owned and makes color draw
generation and traversal counters optional pass state. Auxiliary passes omit
the color accounting; only the color caller publishes it or brackets traversal
with the deferred GPU cache cost check.*

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

*Adopted. Section 7.4 states that the coupling is intentional: elevation uses
only tiles already classified by color traversal and does not move the
surface assignment across the no-load guard.*

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

*Adopted. Section 8 defines a clamp written back to `ConfigStore` with one
warning. It gives the root reservation as one 256 KiB unit per parsed node,
records the current six-node maximum, and reserves one replacement slot.*

### 14. Two names for one operation

`ElevationStore.heightcode()` and `Viewer.queryTerrainElevation()` have the
same signature and the same meaning. Heightcoding is the tileserver's name
for adding height to delivered geodata, not for a point query — section 1
uses it that way. One name for both would read better, and the public
method's is the accurate one.

*Adopted. The internal and public methods are both named
`queryTerrainElevation()`.*

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

*Adopted. Section 3.2 derives `b`; section 6.3 uses one two-row attachment and
polls fences outside the dirty gate; section 8 itemizes all five fixed
allocations; sections 5, 7, and 8 state setting visibility and reference-frame
lifetime; and section 12 removes the erroneous `legacy-map.d.ts` row.*


## Review round 2

Round 1 is closed. Every adopted change is in the body and each one does
what its response says: `beginNode()` now precedes all three post-child
exits, the depth attachment clears per rig with the traversal mask as the
sole coverage rule, units and reduction stop at each reference-frame node
root, the gsd divisor is 256 with `node.id[0]` as the LOD origin, the
budget clamp is defined and its 1.5 MiB root reservation and 0.25 MiB
replacement slot are arithmetically right, the on-demand pass in 7.4 is
specified rather than gestured at, and section 11's foundation milestone
separates the sink extraction from the store. `RF node` survives only
inside round 1's quoted text, which is correct.

Two notes.

### 1. The rejection is right; the limitation still needs stating

Agreed, and not re-raised. None of the four gates needs sub-metre height:
the waypoint places a marker, the map position and pan following move a
camera, and the path all three replace is wrong by 117 m at the case that
motivated the elevation-store work. Buying compensated position arithmetic
against no requirement is the trade the project's own rules tell you not to
make.

What the rejection leaves behind is that the design states no accuracy. Section
3.2 still says the shader "computes the same ellipsoidal
quantity as the library's CPU SRS conversion". With a float32
reconstruction of an absolute Cartesian position it does not — it computes
that quantity to about half a metre at Earth radius, and to a value that
shifts as `physicalEyePos` moves. Section 5's new reliability paragraph
describes reduced averages and renormalized edges but not this floor, so a
reader has no way to tell what the store's numbers are worth.

Suggest section 3.2 saying it outright: the reconstruction is float32, the
resulting height carries roughly half a metre of camera-dependent
quantization at Earth radius, and this is accepted because no planned consumer
works below metre scale. Section 5's reliability paragraph can
then name it as one of the three contributions to vertical error, and gate
2 reads its difference distribution against a known floor instead of
discovering one in the standard deviation.

Stating a limitation is cheaper than removing it and is the part that
survives into the next vector-format design, whose placement rules may need a
vertical reliability value.

*Adopted. Sections 3.2 and 5 state the sub-metre, camera-dependent float32
quantization and the reason it is accepted.*

### 2. Terrain-anchored placement has no depth tolerance, and gate 1 needs one

This is unaddressed rather than wrong, and it is the one thing that can
fail gate 1 while every designed mechanism works.

Gate 1 passes the returned coordinate to `checkVisibility()` with mode
`fix` and asks the reviewer to confirm the marker "remains visible". But a
store sample is not the drawn mesh height, and the difference is
one-sided in the direction that hides the marker:

- the store is a regular 256-sample grid and the mesh is irregular, so a
  bilinear read between grid samples reconstructs a bilinear patch. On a
  ridge crest — which is where the Mount Whitney case sits — that patch
  lies below the mesh;
- section 5 already says a coarse unit holds reduced averages with
  renormalized edges; and
- the float32 floor from note 1 adds its share.

The first term scales with `actualGsd`. During load-in the selected unit can
be coarse, exactly the window the gate asks the reviewer to watch when it says
the marker should "follow a better store sample when finer terrain becomes
ready". A point at or just below the drawn surface reads as occluded.

`checkVisibility()` has one tolerance, `const tolerance = 0.01` at
[viewer.ts:735](../../src/viewer/viewer.ts#L735). It is 1% of the point's
camera distance and its comment says what it was sized for: the 0.4%
spread from sampling terrain depth somewhere inside a texel. It is not an
anchor-height allowance, and being radial it does not widen as the view
angle grazes — which is the case [backlog #1](backlog.md#backlog-1)
recorded as ill-conditioned in the anchor height. The store takes that
error from 117 m to metres. It does not change the conditioning.

The library already solved this for the other terrain-anchored geometry it
draws, which is the precedent worth pointing at rather than inventing a
second mechanism. `zbuffer-offset` is a public style property
([style-schema.ts:248](../../src/map/style-schema.ts#L248)), a
three-component `[constant, distance, tilt]` bias turned into a
projection-matrix depth offset by `Renderer.getZoffsetFactor()`
([renderer.ts:1949](../../src/renderer/renderer.ts#L1949)) and applied at
every geodata draw site in `src/renderer/draw.js`; `geodata-builder.js`
defaults its own generated styles to `[-5, 0, 0]`. The tilt term exists
for the grazing case specifically.

The store does not have to solve this, but leaving gate 1 silently dependent
on it is the risk. Cheapest first:

1. Section 6 could say what a returned sample means for placement — that
   it puts a point *on* the terrain, so a consumer drawing a marker there
   lifts it — and section 11.2 could state the offset the waypoint demo
   uses and where it comes from. A small multiple of `actualGsd` is the
   natural unit, because that is what the dominant term scales with.
2. If the offset belongs in the library rather than in a demo,
   `checkVisibility()` taking the anchor's `actualGsd` into account
   instead of a flat 1% is a `Viewer` change. That reads like a backlog
   entry rather than elevation-store work, but the gate should open it
   instead of finding it late.

One reason to treat it as elevation-store work either way:
[backlog #1](backlog.md#backlog-1)'s status line says the remaining work
is tracked here, and that remaining work is precisely a
terrain-anchored point that survives `checkVisibility()`. Store accuracy
is necessary for that and, on this evidence, not sufficient.

*Adopted. Section 11.2 makes the waypoint add `max(1 metre, actualGsd)` to the
returned height for both marker placement and its `checkVisibility()`
coordinate. The floor covers float32 quantization, and gate 1 validates the
result. This policy belongs to the waypoint; the store returns the unmodified
terrain sample.*


## Review round 3

Round 2 is adopted and verified in the body; section 8's five allocations
sum to the `40 * W` it claims. Two notes, neither about the store itself.

### 1. Drop the clearance from section 11.2

Waypoint markers are DOM elements in an overlay div
([waypoint.js](../../demos/waypoint/waypoint.js) builds them with
`createElement('img')` and toggles `style.visibility`). Nothing depth-tests
them. The only gate is the `checkVisibility()` boolean, so a tolerance
there is the whole mechanism and `max(1 metre, actualGsd)` buys nothing.

It also costs. Uncapped, a coarse answer lifts the marker out of the view:
`melown2015`'s `pseudomerc` root spacing is about 126 km at that position
and section 8 pins the root. Capped, the cap does nothing when the coarse
value sits thousands of metres below the terrain.

Suggest placing at the returned height unchanged. The residual question is
the shape of `checkVisibility()`'s flat `const tolerance = 0.01`
([viewer.ts:735](../../src/viewer/viewer.ts#L735)), which does not widen as
the view grazes — the case [backlog #1](backlog.md#backlog-1) called
ill-conditioned. `Renderer.getZoffsetFactor()`
([renderer.ts:1949](../../src/renderer/renderer.ts#L1949)) already has the
shape that fits, `c0 + c1 * distanceFactor + c2 * tiltFactor`. That is
`Viewer` work under backlog #1; the design only needs to stop specifying a
placement rule.

*Adopted. Section 11.2 now places and checks the waypoint at the returned
height unchanged. Any change to `checkVisibility()` remains Viewer work under
backlog #1 rather than elevation-store placement policy.*

### 2. Editorial

The gate 1 position `[-118.302348, 36.560197]` is 2.2 km south-southwest
of the Mount Whitney summit, so "appears on the rendered summit" should be
"appears on the rendered terrain at that position". Backlog #1 recites the
same thing and can be corrected with it.

Section 3.2's "sub-metre" bounds one operand, not the result: the chain
ends in `dot(ecef - q, normal)`, a cancellation of two quantities near
6.4e6. "Of order a metre" is true either way.

*Adopted. Gate 1 now describes terrain at the stated position, backlog #1 no
longer calls it the Mount Whitney marker, and sections 3.2 and 5 describe the
resulting float32 height quantization as being of order one metre.*


## Review round 4 — sign-off

The design is accepted.

Rounds 1 to 3 are closed. The body carries every adopted change and I have
read it in final form: the sink contract brackets the three post-child
returns, units and reduction stop at each reference-frame node root, the
coverage mask is the sole coverage rule across draws and reductions,
section 8's five fixed allocations sum to the `40 * W` the text claims and
its seventy-unit estimate is consistent with the node-relative depth it now
uses, and section 11.2 places the waypoint at the returned height with the
tilt-aware tolerance left to backlog #1 where it belongs.

Two editorial points, neither a blocker and neither needing a response:

- Section 12 gives `terrain-traversal-sink.ts` as "sink type and
  color/depth implementations" and never says where `ElevationTerrainSink`
  lives. Whichever file it lands in, the table is the place a reader looks.
- Section 12's rows are marked by gate but not by milestone, so the
  foundation of section 11.1 has to be inferred from the change text. A
  marker on those rows would make the first commit's boundary readable from
  the table alone.


## Addendum — 2026-08-27 — design correction after gate 2 failure

The signed-off design produced a point-lookup implementation which failed the
store's vector-heightcoding gate. This revision changes the design, not only
the gate:

- Client-side heightcoding is camera-bound. It heightcodes geometry for the
  current view at the terrain resolution the current view can use.
- The store exists to replace server-side heightcoding for complex vector
  geometry. Waypoints and navigation-tile removal are secondary consumers.
- Consumers retain sample sets, and each sample retains the node and tile path
  needed to decide whether a better resident unit exists. Settled values do
  not pass through whole-array queries again.
- Monolithic and tiled geodata use the same `MapGeodataView`-owned mechanism.
  Monolithic geodata owns one set; tiled geodata owns one set per rendered
  tile view.
- The store-facing terminology is geographic source coordinates and geodetic
  heights. Do not describe store inputs with legacy coordinate terminology.
- Store gsd is nominal. Consumers request nominal gsds from
  reference-frame-node tile geometry, and the store returns nominal
  `actualGsd`.
- The public one-shot query is replaced by the retained sample-set operation.
- Gate 2 selects either legacy or store heightcoding. Optional shadow
  statistics compare the two while store-heightcoded geometry remains visible.

Gates 1 and 2 are reopened to replace the existing APIs and global geodata
engines, deliver the view-owned heightcoding path, and retest whether the store
can meet its intended workload.


## Review round 5 — requested

The signed-off design failed at gate 2: its one-shot point API and
comparison-only shadow made bulk consumers re-resolve complete coordinate sets
without delivering switchable client heightcoding. Measured FPS fell about 35
percent against the gate's ten-percent limit.

The revised design uses retained sample sets, incremental unit references, and
nominal gsd throughout; confines work to active views; gives monolithic and
tiled geodata one view-owned heightcoding path; replaces the public query; and
rewrites gates 1 and 2 around that contract. Please review the whole revised
design, especially the lookup algorithm, ownership boundaries, and whether the
gates now test the store's intended vector workload.


## Review round 5 — findings and sign-off

The revised design is accepted. The lookup, the ownership split, and gate 2 all
hold. This RFC is on a fast track: by explicit approval of the project leader,
the notes below were applied to the body in this pass rather than returned for
the author to adopt in a later round. They are recorded here for the trail.

The redesign is aimed at the measured failure. The 35 percent drop was CPU-side
per-coordinate work: at `desiredGsd` zero nothing settled, so every covered
coordinate repeated node resolution, projection-scale conversion, tile walking,
and residency lookup each pass across every active view. The retained `UnitRef`
caches that resolution, nominal gsd removes the conversion, and settling stops
the re-query. For the covered, settled population — which sticky node roots and
bottom-up reduction make the norm almost at once — the measured cost is gone.

### 1. `UnitRef` over-describes what it retains

Section 5.1 listed a "tile path" among the retained fields. The tile at any LOD
is derived arithmetically from the local coordinate, so there is no path to
store. The one request-independent expensive step is the geographic-to-projected
resolution; the rest of the walk is arithmetic.

*Applied. Sections 5.1 and 5.4 record the resolved node and local coordinate,
plus the answering tile ID and unit generation as the walk's stop bound, and
allow the position to be retained before any pass covers it. No cost bound
against uncovered lookups was added: sticky node roots make a standing uncovered
tail a corner case, not the workload.*

### 2. The start-tile skip freezes a sample against same-LOD rebuilds

Section 5.4 accepts a retained sample without GPU work when its answering tile
is the walk's start tile. Section 6.5 rebuilds a unit at the same tile ID as finer
rigs contribute, so a sample pinned at its ideal LOD — the steady state for
tiled geodata — would never see that refinement and could stay attached to a
coarse load-in fallback.

*Applied. Each unit carries a build generation stamped at commit (section 4.3);
`UnitRef` records the answering unit's generation, and the walk re-reads the
start tile when the resident unit's generation has moved. About six lines of
implementation.*

### 3. Gate 2 measured only one of the two paths it introduces

The failed capture was the tiled path, and gate 2 retests it. The monolithic
path is new: a monolithic layer requests one gsd for its whole set and
reprocesses every coordinate when the highest rendered terrain LOD changes. No
capture exercised it.

*Applied. Gate 2 measures the ten-percent bound on both paths, naming
`a-3d-mountain-map`, which carries a `geodata-tiles` and a `geodata` free layer,
each capture including a zoom that raises the highest rendered terrain LOD.
Bounding the monolithic reprocess to changed-LOD coordinates was considered and
declined: monolithic layers carry few coordinates by design, now recorded in
section 5.3 as a decision rather than left implicit.*

### 4. A settled set should not rescan every frame

Consumers may call `updateTerrainSamples()` every frame. A fully settled set
still scanned its whole coordinate list to find nothing to do.

*Applied. Section 5.4 short-circuits a settled set against the last committed
build generation, so it rescans only after a pass commits a unit.*

### 5. A view disposed mid-readback

Section 5.1 resolved pending updates only on store clear or disposal. A
`MapGeodataView` killed by the cache while its update is in flight would write
into freed geometry.

*Applied. Section 5.1 drops the writeback of an update whose sample set was
disposed before it settled.*

### 6. A coarsening request re-answers coarser

When `desiredGsd` grows, the walk re-targets a retained sample to a coarser unit
and overwrites it. That is a departure from "the store only improves" and was
unstated.

*Applied. Section 5.4 states that the store matches the request rather than only
refining.*

The design is accepted. The one change with behavioural weight is the build
generation in note 2; the rest tighten wording, gate coverage, and lifecycle.
