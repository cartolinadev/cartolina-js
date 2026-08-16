# LOD selection and screen-space error

See [index.md](index.md) for the wiki table of contents.

This page documents the tile selection quantity inherited from VTS: the
screen-space error proxy that `MapSurfaceTile.updateTexelSize()`
computes from a metanode. Both tile selection paths use it — the
recursive terrain traversal in `draw-traversal.ts` and the legacy
`MapSurfaceTree` tree that tiled-geodata free layers still descend.
Glues and virtual surfaces are not traversed.

The short version:

1. A metanode gives the client a physical length per nominal tile
   sample, or enough fallback data to estimate that length from tile
   size.
2. `updateTexelSize()` projects that length to viewport pixels for the
   current camera.
3. The traversal descends while the tile would draw too coarsely.
4. It renders the tiles that satisfy the threshold, and renders coarser
   ancestors as fallback where finer tiles are not ready.


## Names

`texelSize` is the projected size of one terrain sample in physical
viewport pixels. Larger values mean the tile is too coarse for the
current view. The traversal descends when `tile.texelSize` is greater
than `draw.texelSizeFit`.

The name is historical. In old VTS datasets it was tied to imagery
texels. For `surface-dem` in cartolina-tileserver it means one nominal
sample in a 256 by 256 tile-density model. It is not a texture object
size and not the final mesh triangle size.

`priority` in the loader calls is also historical. It is an inverse
priority: a smaller number is scheduled sooner. Code comments in
`surface-tree.js` call this out before the `priority =
child.id[0] * typeFactor * child.distance` calculation.


## The Stored Sample Length

The fast path starts with `node.pixelSize`. The field is parsed in
`src/map/metanode.js` from the metanode suffix `texelSize` field
when metanode flag bit 2, `applyTexelSize`, is set. The parser stores it
as `node.pixelSize`.

`node.pixelSize` is a physical length per nominal tile sample in the
surface's physical coordinate system. The name is misleading because the
client later turns it into pixels. The value comes from the
producer-side formula:

```text
texelSize = sqrt(physical surface area / nominal sample count)
```

For `surface-dem` resources, `cartolina-tileserver` computes it in
`mapproxy/src/mapproxy/generator/metatile.cpp`. The generator samples
each metanode tile on an 8 by 8 grid, converts valid DEM samples to
physical coordinates, sums the physical area of valid triangles, then
divides by a nominal sample count for the same covered part of the tile.
This happens during on-the-fly metatile generation. The prepared
`delivery.index` records which metatiles and tiles exist; it does not
store per-node `texelSize` values.

The code calls that denominator `textureArea`. That name comes from the
older VTS mesh-and-imagery model. The `surface-dem` generator does not
load source textures and does not produce imagery. It only uses
`BoundLayer::tileArea()` as the conventional tile density: 256 by 256
samples per full tile.

For each valid quad, `quadArea()` returns the physical area and the
number of valid triangles, one or two. The nominal sample count is:

```text
triangleCount * 256 * 256 / (2 * 8 * 8)
```

`256 * 256` is `BoundLayer::tileArea()`. The division by two accounts
for the fact that two triangles cover one grid cell. The result is the
number of nominal 256-tile samples represented by the valid DEM
triangles inside the tile. The square root gives physical units per
nominal sample.

The same formula appears in `surface-spheroid.cpp` and in the embedded
VTS tileset writer for mesh tiles. `surface-dem` uses the shared
`metatileFromDem()` helper and passes no `displaySize`, so DEM terrain
metanodes normally set `applyTexelSize`, not `applyDisplaySize`.

The stored value is written by `vts::MetaNode::save()` in the embedded
VTS library. It sits in the common metanode suffix after
`internalTextureCount`:

```text
flags
geometry extents
internalTextureCount
texelSize      uint16 half-float
displaySize    uint16
minHeight      int16
maxHeight      int16
sourceReference, when present
```

The writer clamps `texelSize` to `65000.0`, converts it to a half-float,
and writes the resulting 16-bit value. The client decodes the half-float
back to `node.pixelSize`.


## Projection To Pixels

The hot path in `updateTexelSize()` begins:

```js
screenPixelSize = draw.ndcToScreenPixel * node.pixelSize;
```

`draw.ndcToScreenPixel` is set once per `drawMap()` call from the render
target's apparent (CSS) width:

```js
this.ndcToScreenPixel =
    this.renderer.gpu.currentRenderTarget.apparentSize[0] * 0.5;
```

The projection maps clip-space X to NDC X in `[-1, 1]`, so one NDC unit
corresponds to half the apparent width in CSS pixels. Apparent size also
keeps the color pass and the auxiliary depth pass on the same LOD: the
depth hitmap has a smaller storage `viewportSize` but inherits the canvas
`apparentSize`, so both passes compute the same `ndcToScreenPixel` and
select the same tiles. At this point the
variable name `screenPixelSize` is premature: the value still needs the
projection scale factor. Its units are:

```text
physical sample length * pixels per NDC unit
```

The remaining perspective step multiplies this pixel value by a camera
scale factor:

```js
texelSize = camera.projection[0] / distance * screenPixelSize;
```

That expression appears through `Camera.scaleFactor()` and
`Camera.scaleFactor2()`. The code uses Euclidean distance rather than
camera-space depth, so rotating the camera does not change LOD for a
fixed camera-to-tile distance.

In effect, the fast path is:

```text
pixels per sample =
    metanode physical sample length
  * viewport width / 2
  * projection[0] / representative distance
```

`projection[0] / distance` converts a physical length at the tile to
NDC width. The viewport multiplier then converts NDC width to physical
viewport pixels. The metatile carries the expensive, tile-specific
surface-area measurement. The client supplies the current viewport and
camera distance.


## Fallback Display Size Path

Some metanodes do not set `applyTexelSize`. When flag bit 3,
`applyDisplaySize`, is set, the client estimates the same quantity from
the tile's physical extent and the surface display size.

For projected or non-precise-distance cases:

```js
screenPixelSize =
    ndcToScreenPixel * bboxMaxSize / displaySize;
```

For geocentric precise-distance cases:

```js
screenPixelSize =
    ndcToScreenPixel
  * (diskAngle2A * planetRadius * sqrt(2))
  / displaySize;
```

`parseMetanode()` reads `displaySize` from the metanode's uint16 field. It
keeps that decoded value when `applyDisplaySize` is set and substitutes 256
when the flag is clear.

For metatile version 5 and newer, `generateCullingHelpers()` computes
`bboxMaxSize` from the physical bbox points when `applyDisplaySize` is
set. For geocentric tiles the disk-angle formula estimates the tile
diagonal from angular radius and planet radius.

The fallback path is less direct than the `node.pixelSize` path. It
reconstructs a projected sample size from a physical tile size and an
assumed tile density.


## Geometry-less nodes and the structural descent brake

A metanode with no geometry carries no sample length, so
`updateTexelSize()` sets `texelSize` to `Infinity`. Following that value
unconditionally can create a tile-request storm when geometry starts below
a deep chain of structural nodes. This occurs while legacy coverage is still
being inferred and in newer surfaces built without partial ancestors.

`MapSurfaceTile.fallbackTexelSize` is a finite structural estimate used
only by the traversal's descent test. `texelSize` stays `Infinity`, so
leaf detection, readiness, rendering, and the watertight-fit stop are
unchanged. The estimate models the cell at a 256-sample density:

```text
fallbackTexelSize = distanceFactor * ndcToScreenPixel
                  * (physicalCellSpan / 256)
```

Version 4 takes `physicalCellSpan` from the stored quantized physical bbox.
Versions 5–6 derive it from the physical bbox corners generated for
culling.

`mapStructuralDescentBrake` controls when this estimate may stop descent.
It is a cross-version safety limit, not a format-compatibility switch. The
value is clamped to 0-1 and defaults to 0.25:

```text
descend = fallbackTexelSize
          > texelSizeFit * mapStructuralDescentBrake
```

Zero is transparent: the right-hand side is zero, so every valid positive
structural estimate continues descending. A positive value stops structural
descent later than the normal geometry fit: 0.5 requires half the normal fit
threshold and 0.25 requires one quarter. When the estimate halves per LOD,
those settings allow one and two extra levels respectively.

The brake bounds speculative descent until real geometry or inferred
watertight coverage can govern traversal. Loading readiness is tracked
separately: a higher-priority tile waiting for resources stops the
front-to-back render loop, while a classified structural tile lets lower
surfaces provide coverage. Horizon degradation is not applied to the
estimate.


## Distance Estimates

After `screenPixelSize` is known, `updateTexelSize()` picks one of two
distance functions.

`getPixelSize()` is used for projected maps. It classifies the camera
into one of the regions around the tile bbox, chooses a representative
point on the nearest bbox face, and calls `Camera.scaleFactor()` for
that point.

If the camera is inside the bbox, the function returns infinite
`texelSize`. The traversal then descends, because the current tile cannot
represent nearby terrain at useful detail.

`getPixelSize3()` is used for geocentric maps. It uses the metanode
disk:

- `diskNormal` gives the tile center normal.
- `diskAngle2` is the cosine of the tile angular radius.
- `diskAngle2A` is the angular radius in radians.
- `diskDistance` is the radius at the tile's lower height.
- `minZ` and `maxZ` give the vertical range.

The function compares the camera normal with `diskNormal`. When the
camera is outside the tile cone, it adds a horizontal distance from the
cone edge. When the camera is above or below the tile height range, it
adds the vertical distance. If the camera is inside the tile's horizontal
and vertical range, it returns infinite `texelSize`.

Both functions return `[texelSize, distance]`. The traversal uses
`texelSize` for LOD and uses `distance` for loader scheduling, child
ordering, horizon degradation, and statistics.


## Threshold

`draw.texelSizeFit` is computed in `MapDraw.setupDetailDegradation()`:

```js
this.texelSizeFit =
    mapTexelSizeFit * Math.pow(2, factor);
```

`mapTexelSizeFit` defaults to `1.1`. `factor` comes from detail
degradation. The threshold is DPI-independent, matching the apparent-size
basis of `ndcToScreenPixel`, so the fit test gives the same result on the
color pass and the auxiliary depth pass.

A tile passes the LOD test when:

```js
tile.texelSize <= draw.texelSizeFit
```

Higher `texelSizeFit` values allow coarser terrain. The current code
does not use a fixed `4.4` threshold for normal traversal. The `4.4`
value still appears in old grid/debug code and should not be read as the
surface-tile selection rule.


## Detail Degradation

Two mechanisms intentionally bias the test toward coarser terrain.

When `texelSizeFit > 1.1` and precise geocentric distance is not active,
the code applies a "move camera away" approximation. It scales
`screenPixelSize` by `texelSizeFit / 1.1`, then evaluates distance from a
point displaced backward along the camera view vector by
`camera.distance * texelSizeFit / 1.1`.

When `mapDegradeHorizon` is enabled, `updateTexelSize()` divides the
computed `texelSize` by a fade factor. The factor grows with tile
distance between `mapDegradeHorizonParams[1]` and `[2]`, is reduced by
camera tilt, and is disabled when `camera.perceivedDistance` exceeds
`mapDegradeHorizonParams[3]`. Dividing `texelSize` makes distant terrain
pass the threshold sooner.


## Tree Traversal

Terrain selection is one recursive descent over the tile pyramid, shared
by every surface in view (see
[draw-traversal.ts](../../src/map/draw-traversal.ts)). A node is a tile
position, not a tile: every surface with a visible metanode there is
measured against the same threshold, and the position refines while any
of them is too coarse. A watertight surface that already fits ends the
descent, since it covers the cell alone. Nodes without geometry have no
error to test and fall to the structural brake above.

A position is decided only after every surface has been classified
against it. A surface whose metadata has not arrived suspends the branch
rather than dropping out of it, so the result does not depend on the
order tiles arrive in.

Selection ignores what is loaded. Where a selected tile has no geometry
yet, its ancestors stand in beneath it, and coverage masks (see
[draw-traversal-mask.ts](../../src/map/draw-traversal-mask.ts)) keep
them off the finer tiles that are ready. Only every few levels may fetch
geometry to serve as such a stand-in — `mapFallbackCadence` sets the
interval — so fallback fetching does not crowd out the tiles actually
selected. Requests go out coarse and near first.

Tiled-geodata free layers make selection and readiness one decision
instead. Their frontier leaves the fitted level in whichever direction
has data: finer when the fitted tile is not loaded, coarser when a
fitting tile's children are not, bounded by `mapMaxHiresLodLevels`.
Their requests also outrank comparable terrain ones.


## Validity Of The Approach

The algorithm is a reasonable terrain LOD method for its time. It has a
clear invariant: estimate projected pixels per nominal tile sample and
refine until that value is below a target. Precomputing the tile's
physical sample length in the metatile keeps per-frame work small. The
client only needs a distance estimate, a projection scale, and the
current viewport size.

The main weakness is that the error quantity is not geometric error. It
does not say how far the rendered terrain surface can deviate from a
finer surface in screen pixels. It says how large one nominal sample
would appear. That works when source resolution, mesh resolution, and
terrain frequency are coupled, but it is an indirect proxy. It cannot
distinguish a flat tile from a tile with high relief if both have the
same nominal sample density.

The second weakness is the distance approximation. `getPixelSize()` uses
a representative bbox point. `getPixelSize3()` is better for globe tiles,
but it still models the tile as a disk plus height range. Both are cheap
and stable; neither projects the actual tile footprint and measures the
worst visible error.

The third weakness is policy coupling. LOD choice, load scheduling,
resource readiness, and horizon degradation span `surface-tile.js` and
`draw-traversal.ts`; geodata free layers use a separate policy in
`surface-tree.js`. That makes the threshold harder to reason about than the
underlying SSE formula.


## Comparison With Other Renderers

CesiumJS exposes terrain quality as `Globe.maximumScreenSpaceError`.
That is the same kind of test: refine terrain until a screen-space
error falls below a threshold. Cesium's public name describes the test
directly. Cartolina's inherited `texelSize` name hides that the value is
a screen-space error proxy.

Google Maps and MapLibre GL JS primarily expose map detail through zoom
and tiled source pyramids. Their public APIs discuss zoom levels,
tile coordinates, and source `minzoom`/`maxzoom`, not a terrain SSE
threshold. MapLibre's terrain support consumes raster DEM tiles through
a raster-DEM source and renders terrain for the current map zoom. That
fits the slippy-map model: screen scale selects a discrete tile zoom.

Deck.gl's `TileLayer` exposes refinement policy, including whether to
show parent tiles while children load. That is close to the traversal
side of Cartolina's code: both systems must choose between a coarse
ready tile and finer incomplete children.

Cartolina differs from flat slippy-map renderers because the camera is a
free 3D camera over terrain. A single integer map zoom cannot describe
apparent detail across the view: near foreground terrain and distant
horizon terrain need different decisions. A screen-space error test is
the right category of method for that problem. The current
implementation should be treated as a legacy SSE proxy that is useful
but not authoritative about geometric error.
