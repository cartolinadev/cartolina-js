# Nav-tiles

See [index.md](index.md) for the wiki table of contents.

A **navtile** is a small raster image associated with a terrain
surface tile. It stores the terrain elevation of that tile's area in
the **navigation SRS** Z axis — for `melown2015`, metres above the
WGS84 ellipsoid. Each pixel's red channel encodes one elevation
sample; the image covers the tile's geographic cell at low resolution.

The term is part of the VTS-geospatial heritage. The word "navigation"
refers to the navigation SRS, not to a specific rendering feature.

---

## Where navtile data lives

### Metanode flag and height range

Every metanode carries a `flags` byte. Bit 1 (`navtilePresent`) marks
whether the tile has a navtile. The parser in
[src/map/metanode.js](../../src/map/metanode.js) exposes
this as `MapMetanode.prototype.hasNavtile()`.

When the flag is set, two `int16` fields at the end of the common
metanode suffix are valid:

```
minHeight   int16   — minimum elevation (navSRS, metres)
maxHeight   int16   — maximum elevation (navSRS, metres)
```

These bound the elevation range of the tile's navtile texture.

`minZ` and `maxZ` (used for bounding-box construction) are explicit
float32 values in the spatial division node's coordinate system (SDS)
and are completely independent of `minHeight`/`maxHeight`.

See [surface-metatile.md](surface-metatile.md) for the full metanode
binary layout.

### Navtile texture URL

The navtile texture is a separate per-tile HTTP resource. Its URL is
produced by `MapSurface.prototype.getNavUrl()` in
[src/map/surface.js](../../src/map/surface.js), which
expands the surface's `navUrl` template with the tile's LOD, X, and Y
indices.

Textures are loaded on demand through the normal resource-tree
machinery and stored as `tile.heightMap` on the `MapSurfaceTile`.

---

## Active usage

### Terrain height queries (navigation)

This is the primary and only fully-active use of navtile textures.

`MapMeasure.prototype.getSurfaceHeight()` in
[src/map/measure.js](../../src/map/measure.js) answers
queries of the form "what is the terrain elevation at these navigation
coordinates?" The answer drives the camera, coordinate conversion, and
the public `getTerrainHeightAt` API.

The query path:

1. `measure.getSurfaceHeight()` resolves the spatial division node
   and iterates the per-surface helper trees front-to-back (the same
   trees the recursive draw traversal descends), calling
   `tree.traceHeight()` on each. A tree claims the answer only with
   terrain evidence at the coordinate: a usable navtile, or geometry
   somewhere along the traced path (`params.sawGeometry`). A tree
   whose trace dead-ends on structural (geometry-less) nodes — see
   [surface-metatile.md](surface-metatile.md) — has no terrain at the
   coordinate and falls through to the next surface back. A consulted tree that could not answer conclusively —
   a metanode or navtile texture is still loading — marks the result
   provisional (third tuple element false) so callers query again.
2. `MapSurfaceTree.prototype.traceHeightTileByMap()` in
   [surface-tree.js](../../src/map/surface-tree.js) descends the
   tile tree toward the desired LOD. At each level it checks
   `node.hasNavtile()`. When set and the node's `minHeight`/`maxHeight`
   range is usable (not inverted, not outside the reference frame's
   global height range — `isNavtileRangeValid`), it loads the navtile
   texture via `tile.resourceSurface.getNavUrl(tile.id)` and stores it
   in `tile.heightMap`. A navtile with a corrupt range is treated as
   absent and the descent continues to finer navtiles.
3. Once the texture is ready,
   `MapMeasure.prototype.getHeightmapValue()` bilinearly interpolates
   the red-channel pixels at the query coordinates to produce the
   navSRS elevation.
4. If the claiming tree has no navtile at any LOD, the fallback path
   `getSurfaceHeightNodeOnly()` uses the metanode's `diskPos`
   (the tile centre in physical SRS, converted to navigation SRS),
   yielding one altitude value per tile rather than a pixel-sampled one.

The inspector stats display (
[src/inspector/stats.js](../../src/inspector/stats.js))
reports `heightClass = 2` when a navtile texture was used and
`heightClass = 1` when the metanode centre fallback was used.

**Callers of `getSurfaceHeight`:**

| Caller | Purpose |
|---|---|
| [src/map/camera.js:36](../../src/map/camera.js) | Every frame: terrain height at the camera look-at point; drives float-height mode, near/far plane, and orbit distance |
| [src/map/convert.js](../../src/map/convert.js) | Multiple coordinate conversion methods: fly-to altitude, position clamping, marker placement |
| [src/map/legacy-map.js:931](../../src/map/legacy-map.js) | Public API `getTerrainHeightAt()` |
| [src/map/geodata-builder.js:1506](../../src/map/geodata-builder.js) | `heightmap-by-precision` / `heightmap-by-lod` draping modes: projects geodata features onto the terrain surface |

**Config flag:** setting `mapIgnoreNavtiles = true` bypasses the
navtile texture path entirely and forces the metanode-centre fallback
for all queries. The flag is exposed via `map.setParam()` and parsed
at
[src/map/legacy-map.js:1175](../../src/map/legacy-map.js).

---

## Legacy draw path — grid fallback

The config flag `mapHeightfiledWhenUnloaded` (default `true`) enables
`tile.drawGrid()` as a visual fallback while mesh tiles are still
loading. The grid draws a flat quad over the tile's geographic cell.

The grid's 3D position uses `mnode.minZ` (and neighbouring tiles'
`minZ` values read from the tree) — **not the navtile texture**. The
two are independent: `minZ` is an SDS float32 field,
`minHeight`/`maxHeight` are the navSRS int16 navtile range.

The grid's visual texture is loaded from a configured bound layer
(`mapGridTextureLayer`), not from the navtile URL.

The grid fallback path exists only in the **legacy draw traversal** in
[src/map/surface-tree.js](../../src/map/surface-tree.js).
The new traversal in
[src/map/draw-traversal.ts](../../src/map/draw-traversal.ts)
does not call `drawGrid()`. This path will disappear when the legacy
traversal is retired.

---

## Dead code paths

### `{geonavtile}` geodata URL template

`MapSurface` has a field `geodataNavtileInfo`, explicitly initialised
to `false` at
[src/map/surface.js:150](../../src/map/surface.js). When
true it would embed a navtile identifier into the geodata tile URL via
the `{geonavtile}` template variable in
[src/map/url.js:199](../../src/map/url.js), allowing the
server to clip geodata by navtile coverage. The flag is disabled and
the template variable is never populated.

### Heightmap mesh and vertex shader

`RendererInit.prototype.initHeightmap()` in
[src/renderer/init.js:106](../../src/renderer/init.js)
builds a 5×5 vertex-grid mesh via
`RendererGeometry.buildHeightmap(5, true)` but immediately comments
out the `new GpuMesh()` call. The mesh geometry is built and discarded.

The `renderer.heightmapTexture` that `initHeightmap()` does create is
a 64×64 procedural texture — dark grey interior with a white border.
It produces the grid-line pattern in `tile.drawGrid()` when no bound
layer texture is configured. It does not contain terrain height data.

The `heightmapVertexShader` / `heightmapFragmentShader` pair that
would have deformed a grid mesh using a navtile texture (storing
`hmin`/`hmax` in a `vec3 uHeights` uniform) was deleted with the
legacy mesh tile rendering pipeline in 2026-05-21. The deletion is
recorded in the
[REFACTOR: delete legacy mesh tile rendering pipeline](backlog.md)
backlog entry.

---

## Relationship to metatile versions

The client reads versions 4 through 6; the parser rejects anything
outside that range.

| Version | navtile role |
|---------|-------------|
| 4 | Explicit float32 `minZ`/`maxZ`/`surrogatez` in SDS, independent of the navSRS `minHeight`/`maxHeight` range. Navtile texture used for height queries. Quantized geomExtents still present in the stream and read by the client. |
| 5 | Quantized geomExtents removed from stream; SDS horizontal extents added. Same navtile behaviour as v4. |
| 6 | Adds the watertight bitplane. Same navtile behaviour as v4. |
