# LOD selection and screen-space error

See `index.md` for the wiki table of contents.

The renderer selects which tile resolution to draw by comparing a
tile's projected screen size against a configurable threshold. This
page describes how that comparison works, starting from the metatile
fields and ending at the traversal decision.


## Key quantities

### `ndcToScreenPixel`

Set in `draw.js` at the start of each `drawMap` call:

```js
this.ndcToScreenPixel =
    this.renderer.gpu.currentRenderTarget.viewportSize[0] * 0.5;
```

The OpenGL projection maps world geometry to NDC space, where the
full viewport width spans from -1 to +1. `ndcToScreenPixel` converts
one NDC unit to physical pixels in the current render target:
`viewportSize[0] / 2`.


### `texelSizeFit`

Set in `draw.js` (`setupDetailDegradation`):

```js
this.texelSizeFit = this.config.mapTexelSizeFit
    * Math.pow(2, factor) * dpiRatio;
```

The target pixel size per texel. When a tile's computed `texelSize`
is at or below `texelSizeFit`, the tile is detailed enough to render.
`mapTexelSizeFit` defaults to `1.1`. `factor` encodes any active
detail-degradation step; `dpiRatio` is
`currentRenderTarget.devicePixelRatio ?? 1`, scaling the threshold
so that high-DPI displays request finer tiles to match their physical
pixel density. Render targets without a known DPR default to `1`.

### Metanode fields used for LOD

Each metanode exposes two families of size metrics:

- **texel-size path** (`node.usedTexelSize()` is true): the metanode
  carries `node.pixelSize`, a pre-computed NDC-space texel size
  derived from the tile's texture resolution and geometry extent.
- **display-size path** (`node.usedDisplaySize()` is true): the
  metanode carries `node.displaySize`, a reference size in the tile's
  native coordinate units, together with the tile's bounding box
  (`node.bbox`, `node.bboxMaxSize`).

For geocentric (spherical) surfaces the metanode also provides disk
geometry: `node.diskAngle2A` (angular half-radius in radians),
`node.diskDistance` (distance from planet centre to the tile disk),
`node.diskNormal` (outward normal of the disk), `node.minZ` and
`node.maxZ` (height range above the reference ellipsoid).


## `updateTexelSize()`

`MapSurfaceTile.prototype.updateTexelSize` in `surface-tile.js`
computes `this.texelSize` and `this.distance` for one tile.

### Orthographic camera

```js
pixelSize = [(screenPixelSize * 2.0) / height, height];
```

`height` is the orthographic view height. `texelSize` is the number
of screen pixels per texel when the full view height spans `height`
units.

### Perspective camera — no geometry

When the node has no geometry (`!node.hasGeometry()`), `texelSize`
is forced to `+Infinity`. The traversal must descend to children to
find renderable tiles.

### Perspective camera — texel-size path

Hot path for tiles with texture metadata:

```js
screenPixelSize = ndcToScreenPixel * node.pixelSize;
```

`node.pixelSize` is already in NDC units, so multiplying by
`ndcToScreenPixel` gives the tile's projected size in canvas pixels.

### Perspective camera — display-size path

For tiles without pre-computed texel size, `screenPixelSize` is
derived from the bounding box or disk geometry:

**Geocentric precise-distance mode:**
```js
screenPixelSize = ndcToScreenPixel
    * (node.diskAngle2A * planetRadius * Math.SQRT2)
    / node.displaySize;
```

`diskAngle2A * planetRadius` converts the tile's angular half-radius
to a chord length. `Math.SQRT2` accounts for the diagonal. Dividing
by `displaySize` normalises by the content detail density.

**Projected or non-precise mode:**
```js
screenPixelSize = ndcToScreenPixel
    * node.bbox.maxSize / node.displaySize;
```

`bbox.maxSize` is the largest axis-aligned extent of the bounding
box. Dividing by `displaySize` gives the same normalisation.

### `getPixelSize` vs `getPixelSize3`

After `screenPixelSize` is known, one of two functions converts it
to an actual `texelSize` by accounting for the camera-to-tile
distance and projection scale.

**`getPixelSize(bbox, screenPixelSize, cameraPos, ...)`**

Used for projected surfaces and when `preciseDistance` is false.
Bins the camera position into one of nine regions relative to the
bounding box (corners, edges, faces, interior), picks a
representative point on the nearest bbox face, and calls
`camera.scaleFactor()` to compute the perspective scale at that
point. Returns `scaleFactor * screenPixelSize`.

**`getPixelSize3(node, screenPixelSize)`**

Used for geocentric surfaces when `preciseDistance` is true
(geocentric maps with metatile version ≥ 4, or when
`mapPreciseDistanceTest` is set). Computes the true shortest
distance from the camera to the tile disk by:

1. Measuring the angular separation between the camera's geocentric
   normal and `node.diskNormal`.
2. If the camera is inside the disk's cone, decomposing the distance
   into a horizontal component (from cone edge) and a vertical
   component (above or below the bbox height range).
3. Calling `camera.scaleFactor2(distance)` with the result.

`scaleFactor2` converts a camera-space distance to a perspective
scale factor. The final `texelSize = scaleFactor2(d) * screenPixelSize`.

### `texelSizeFit > 1.1` fast-path

When `texelSizeFit` is significantly above 1.1, both paths share an
optimisation: the camera is virtually displaced along the view vector
by `camera.distance * (texelSizeFit / 1.1)` before calling
`getPixelSize`. This makes the tile appear farther away, reducing
`texelSize`, and allows coarser LODs when detail degradation is
acceptable. The `screenPixelSize` is also scaled by the same factor
so the threshold comparison remains consistent.

### Degrade-horizon adjustment

After computing `texelSize`, if `mapDegradeHorizon` is enabled, the
value is divided by a `degradeFactor`:

```js
this.texelSize /= degradeFactor;
```

A smaller `texelSize` makes distant tiles appear to meet the
threshold with coarser LODs. `degradeFactor` grows from 1.0 (full
detail) toward its configured maximum as tile distance increases from
`degradeFadeStart` to `degradeFadeEnd`. A second fade based on the
observer's perceived distance (`camera.perceivedDistance`) prevents
degradation when the viewer is close. A tilt factor
(`degradeHorizonTiltFactor`) reduces degradation when the camera
looks sideways rather than at the horizon.


## Tree traversal

`MapSurfaceTree` in `surface-tree.js` drives a breadth-first
top-down traversal:

1. Call `tile.updateTexelSize()`.
2. If `tile.texelSize <= texelSizeFit`: render this tile.
3. Otherwise attempt to descend to children:
   - Call `updateTexelSize()` on each child.
   - If all four children have loaded geometry and pass their own
     threshold check, add them to the next traversal round.
   - If any child is not ready, fall back to rendering the parent.

An alternative mode `drawSurfaceFit` is used for geodata-heavy
scenes. It applies additional lookahead and LOD-shift logic to avoid
stalling on non-ready intermediate levels.


## Free layers vs surface layers

Both use the same `updateTexelSize` computation. The difference is
in traversal priority weighting:

- Surface layers use a high priority factor (`typeFactor ≈ 2000`),
  favouring aggressive LOD descent.
- Free layers (geodata overlays) use a low factor (`typeFactor = 0.1`),
  giving them lower loading priority relative to base terrain.

Free layers also support additional load modes (`fit`, `fitonly`,
`topdown`, `downtop`) that control whether the traversal is allowed
to skip intermediate LODs.
