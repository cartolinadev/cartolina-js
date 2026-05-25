# Geodata rendering

See `index.md` for the wiki table of contents.

This page records the current geodata render path. The code still lives
mostly in legacy JavaScript. Names such as `draw()` can mean "collect
jobs" rather than "issue GL draw calls".

`rfc-draw-traversal.md` does not replace this path. Its mask-based
traversal applies to terrain rendering through `TileRenderRig`; geodata
keeps using tree traversal for tile selection and job collection until
a geodata-specific replacement exists.

Only the fitted-frontier behavior is needed for geodata: choose the
tiles whose `texelSize` fits the current threshold, collect jobs for
those tiles, and use parent fallback only while fitted tiles load. The
terrain topdown, downtop, splitting, and fitonly modes do not need to
survive for geodata.

## Frame Flow

`MapDraw.drawMap()` in `src/core/map/draw.js` handles geodata in two
steps during the base draw channel.

First, it clears the renderer geodata job buffers when labels are
enabled and the map has geodata free layers:

```js
renderer.draw.clearJobBuffer();
```

Then terrain and free-layer tree traversal run inside
`Map.withSelectionCamera()`. For `geodata-tiles` layers, this stage
chooses visible tiles, loads geodata resources, builds `MapGeodataView`
objects, and collects render jobs. It does not draw the label and icon
jobs to the framebuffer.

After terrain, free layers, and the freeze-frustum overlay are handled,
`MapDraw.drawMap()` calls `RendererDraw.drawGpuJobs()` inside
`Map.withNavigationCamera()`:

```js
renderer.draw.drawGpuJobs(this.map.getSelectionPosition());
```

That call sorts, filters, and draws the queued geodata jobs.

## Tiled Geodata

`MapDraw.drawMap()` calls `layer.tree.draw()` for tiled free layers,
including `geodata-tiles` layers.

For non-geodata surface free layers, traversal reaches
`MapDrawTiles.drawSurfaceTile()` and renders terrain through
`TileRenderRig`. No geodata jobs are collected for that path.

Tree traversal reaches `MapDrawTiles.drawGeodataTile()` in
`src/core/map/draw-tiles.js` only when `tile.surface.geodata` is true.
That method:

- creates or reuses `tile.surfaceGeodata`
- creates `tile.surfaceGeodataView` when the geodata resource is ready
- stores a `DRAWCOMMAND_GEODATA` command in `tile.drawCommands[channel]`
- calls `MapDraw.processDrawCommands()` when cached commands are ready

`MapDraw.processDrawCommands()` calls `MapGeodataView.draw(cameraPos)`.
Despite the method name, `MapGeodataView.draw()` updates matrices for
each `GpuGroup` and calls `GpuGroup.draw()`.

`GpuGroup.draw()` in `src/core/renderer/gpu/group.js` appends visible
jobs to `renderer.jobZBuffer`. `RendererDraw.drawGpuJobs()` later reads
that buffer and issues the draw calls.

## LOD Selection

Geodata free layers use `mapGeodataLoadMode`, whose default is `fit`.
The `fit` path calls `MapSurfaceTree.drawSurfaceFit()`.

`drawSurfaceFit()` descends until a visible tile satisfies
`tile.texelSize <= draw.texelSizeFit`, has no children, or reaches the
geodata surface's maximum LOD. Matching tiles are placed in the draw
buffer. Lower LODs are traversed through, but they are not drawn when
the fitted tile is ready.

For geodata surfaces, `MapMetanode` uses `surface.displaySize`
(`1024` by default) as the metanode display size. `MapSurfaceTile`
uses that value in `updateTexelSize()` to estimate how large the tile's
authored resolution appears on screen. This makes the selected LOD the
first fitted tile under the current screen-size threshold.

If a fitted tile is not ready, `drawSurfaceFit()` searches loaded
parents and may draw a parent while it triggers child loading. That
parent fallback is a loading fallback, not a second steady-state geodata
LOD. Once fitted tiles are ready, the parent disappears from the draw
set.

## Monolithic Geodata

`type == 'geodata'` free layers use
`MapDraw.drawMonoliticGeodata()` in `src/core/map/draw.js`.

That method checks the layer extent against the current camera, creates
`surface.monoGeodata`, creates `surface.monoGeodataView`, applies
credits, and calls `surface.monoGeodataView.draw(this.camera.position)`
inside `Map.withNavigationCamera()`.

The view draw call follows the same job-buffer path as tiled geodata.
`RendererDraw.drawGpuJobs()` still performs the final draw.

## Camera Contexts

Tile selection and job collection for free layers run under
`Map.withSelectionCamera()`. The final `drawGpuJobs()` call runs under
`Map.withNavigationCamera()` but receives
`Map.getSelectionPosition()`.

This split exists because freeze diagnostics can select tiles from one
camera state while drawing the final map from another. The explicit
argument to `drawGpuJobs()` keeps scale-dependent computations tied to
the selection position.

## Related Files

- `src/core/map/draw.js`
- `src/core/map/draw-tiles.js`
- `src/core/map/geodata-view.js`
- `src/core/renderer/gpu/group.js`
- `src/core/renderer/draw.js`
