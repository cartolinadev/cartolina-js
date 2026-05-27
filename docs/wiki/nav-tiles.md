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
[src/core/map/metanode.js](../../src/core/map/metanode.js) exposes
this as `MapMetanode.prototype.hasNavtile()`.

When the flag is set, two `int16` fields at the end of the common
metanode suffix are valid:

```
minHeight   int16   — minimum elevation (navSRS, metres)
maxHeight   int16   — maximum elevation (navSRS, metres)
```

These bound the elevation range of the tile's navtile texture.

For metatile versions 1–3, `minZ` and `maxZ` (used for bounding-box
construction) are aliased to `minHeight` and `maxHeight` at parse time
because those older formats store only navSRS heights and have no
separate SDS height fields. From version 4 onward, `minZ`/`maxZ` are
explicit float32 values in the spatial division node's coordinate
system (SDS) and are completely independent of `minHeight`/`maxHeight`.

See [surface-metatile.md](surface-metatile.md) for the full metanode
binary layout.

### Navtile texture URL

The navtile texture is a separate per-tile HTTP resource. Its URL is
produced by `MapSurface.prototype.getNavUrl()` in
[src/core/map/surface.js](../../src/core/map/surface.js), which
expands the surface's `navUrl` template with the tile's LOD, X, and Y
indices.

Textures are loaded on demand through the normal resource-tree
machinery and stored as `tile.heightMap` on the `MapSurfaceTile`.

---

## Active usages

### 1. Terrain height queries (navigation)

This is the primary and only fully-active use of navtile textures.

`MapMeasure.prototype.getSurfaceHeight()` in
[src/core/map/measure.js](../../src/core/map/measure.js) answers
queries of the form "what is the terrain elevation at these navigation
coordinates?" The answer drives the camera, coordinate conversion, and
the public `getTerrainHeightAt` API.

The query path:

1. `measure.getSurfaceHeight()` resolves the spatial division node
   and calls `tree.traceHeight()` on each surface tree.
2. `MapSurfaceTree.prototype.traceHeightTileByMap()` in
   [surface-tree.js](../../src/core/map/surface-tree.js) descends the
   tile tree toward the desired LOD. At each level it checks
   `node.hasNavtile()`. When set, it loads the navtile texture via
   `tile.resourceSurface.getNavUrl(tile.id)` and stores it in
   `tile.heightMap`.
3. Once the texture is ready,
   `MapMeasure.prototype.getHeightmapValue()` bilinearly interpolates
   the red-channel pixels at the query coordinates to produce the
   navSRS elevation.
4. If no navtile is available at any LOD in any tree, the fallback
   path `getSurfaceHeightNodeOnly()` uses the metanode's `diskPos`
   (the tile centre in physical SRS, converted to navigation SRS),
   yielding one altitude value per tile rather than a pixel-sampled one.

The inspector stats display (
[src/core/inspector/stats.js](../../src/core/inspector/stats.js))
reports `heightClass = 2` when a navtile texture was used and
`heightClass = 1` when the metanode centre fallback was used.

**Callers of `getSurfaceHeight`:**

| Caller | Purpose |
|---|---|
| [src/core/map/camera.js:36](../../src/core/map/camera.js) | Every frame: terrain height at the camera look-at point; drives float-height mode, near/far plane, and orbit distance |
| [src/core/map/convert.js](../../src/core/map/convert.js) | Multiple coordinate conversion methods: fly-to altitude, position clamping, marker placement |
| [src/core/map/map.js:931](../../src/core/map/map.js) | Public API `getTerrainHeightAt()` |
| [src/core/map/geodata-builder.js:1506](../../src/core/map/geodata-builder.js) | `heightmap-by-precision` / `heightmap-by-lod` draping modes: projects geodata features onto the terrain surface |

**Config flag:** setting `mapIgnoreNavtiles = true` bypasses the
navtile texture path entirely and forces the metanode-centre fallback
for all queries. The flag is exposed via `map.setParam()` and parsed
at
[src/core/map/map.js:1175](../../src/core/map/map.js).

### 2. Height range propagation for bounding-box culling (v1–v3 only)

`MapMetanode.prototype.parseMetanode()` sets
`this.heightReady = this.hasNavtile()` immediately after parsing. When
the flag is set the metanode's `minHeight`/`maxHeight` range is
considered authoritative and does not need to be inherited from a
parent.

`MapSurfaceTree.prototype.updateNodeHeightExtents()` in
[surface-tree.js:157](../../src/core/map/surface-tree.js) propagates
the height range from the nearest ancestor whose `heightReady` is true
down to a child that does not yet have its own range. The function is
guarded by `node.metatile.useVersion < 4`: it fires only for metatile
versions 1–3.

This propagated range feeds into `generateCullingHelpers()`, which
builds the tile's 3D bounding disc. The bounding disc is used for
frustum culling and camera-distance computation. Both the legacy draw
traversal and the new typed traversal
([src/core/map/draw-traversal.ts:306](../../src/core/map/draw-traversal.ts))
call `updateNodeHeightExtents()`.

For metatile version 4 and above, `minZ`/`maxZ` are stored as float32
and are immediately available at parse time. The propagation code never
fires for those tiles.

---

## Legacy draw path — grid fallback

The config flag `mapHeightfiledWhenUnloaded` (default `true`) enables
`tile.drawGrid()` as a visual fallback while mesh tiles are still
loading. The grid draws a flat quad over the tile's geographic cell.

The grid's 3D position uses `mnode.minZ` (and neighbouring tiles'
`minZ` values read from the tree) — **not the navtile texture**. For
v1–v3 metatiles `minZ` is aliased to `minHeight`, so the navtile's
elevation range contributes indirectly; for v4+ tiles the values are
independent.

The grid's visual texture is loaded from a configured bound layer
(`mapGridTextureLayer`), not from the navtile URL.

The grid fallback path exists only in the **legacy draw traversal** in
[src/core/map/surface-tree.js](../../src/core/map/surface-tree.js).
The new traversal in
[src/core/map/draw-traversal.ts](../../src/core/map/draw-traversal.ts)
does not call `drawGrid()`. This path will disappear when the legacy
traversal is retired.

---

## Dead code paths

### `{geonavtile}` geodata URL template

`MapSurface` has a field `geodataNavtileInfo`, explicitly initialised
to `false` at
[src/core/map/surface.js:150](../../src/core/map/surface.js). When
true it would embed a navtile identifier into the geodata tile URL via
the `{geonavtile}` template variable in
[src/core/map/url.js:199](../../src/core/map/url.js), allowing the
server to clip geodata by navtile coverage. The flag is disabled and
the template variable is never populated.

### Heightmap mesh and vertex shader

`RendererInit.prototype.initHeightmap()` in
[src/core/renderer/init.js:106](../../src/core/renderer/init.js)
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

| Version | navtile role |
|---------|-------------|
| 1–3 | `minZ`/`maxZ` are aliased from `minHeight`/`maxHeight` (navSRS int16) because no SDS float fields exist yet. `updateNodeHeightExtents` propagation active. |
| 4 | Explicit float32 `minZ`/`maxZ`/`surrogatez` added; no longer aliased to navSRS values. `updateNodeHeightExtents` propagation never fires. Navtile texture still used for height queries. Quantized geomExtents still present in the stream and read by the client. |
| 5 | Quantized geomExtents removed from stream; SDS horizontal extents added. Same navtile behaviour as v4. |

The mapy.com production deployment serves **version 4** metatiles,
confirmed by inspecting live metatile responses in 2026-05 (see
[compat-mapy-integration.md](compat-mapy-integration.md)). The v1–v3
propagation code is therefore inactive against all known live data.
