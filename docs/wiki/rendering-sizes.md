# Rendering Sizes

The renderer keeps several size concepts separate. This is most visible
when the map canvas is CSS-transformed, as in reveal-style presentations,
and when the renderer switches from the base canvas to auxiliary
framebuffer targets.

## Render target sizes

Every `GpuDevice.RenderTarget` has five size fields. The first two are
present on every target; the remaining three are optional and absent on
independent targets.

`RenderTarget.apparentSize`

- The apparent visible extent of the target in CSS units after any CSS
  transforms. Equal to `cssLayoutSize * cssScale`.
- This is the size used for projection matrices, camera aspect, and
  screen-space draw helpers. It drives `setProjection()`.
- For the canvas target: the `getBoundingClientRect()` dimensions.
- For auxiliary targets: inherited from the canvas target.
- Use this for all rendering code that works in logical coordinates:
  geometry, label-density, NDC-to-pixel conversions.

`RenderTarget.viewportSize`

- The GL viewport/backing-store size in physical pixels, passed to
  `gl.viewport()`.
- For the canvas target: physical backing size
  (`canvas.width`, `canvas.height`). For framebuffer targets: the
  texture/framebuffer storage size.

`RenderTarget.cssLayoutSize` *(optional)*

- Pre-transform CSS layout size in CSS pixels (`offsetWidth` /
  `offsetHeight`). Mouse event coordinates are reported in this space.
- Default input space for screen-coordinate hit-testing (`getScreenRay`,
  `hitTest`, `getDepth`, `hitTestGeoLayers`).

`RenderTarget.cssScale` *(optional)*

- Axis-aligned CSS transform scale: `apparentSize / cssLayoutSize`.
- A reveal-style `scale(0.5)` gives `[0.5, 0.5]`.
- Exposed in the inspector stats panel.

`RenderTarget.dpr` *(optional)*

- Device pixel ratio at the time the canvas target was built.

## GpuDevice target methods

`GpuDevice.setCanvasRenderTarget()`

- Reads the DOM element owned by `GpuDevice`, computes all five size
  fields, resizes the managed canvas element, installs the canvas
  render target, and returns it.
- Must be followed by `Renderer.setProjection()`.
- Call this when the canvas size may have changed.

`GpuDevice.updateCanvasRenderTargetIfNeeded()`

- Recomputes the canvas target fields from the DOM and compares them
  with `gpu.currentRenderTarget`.
- Installs and returns a new canvas target when any canvas size field
  changed. Returns `null` when the current target already matches the
  canvas DOM state.
- `Renderer.updateSizeIfNeeded()` uses this method so size calculation
  remains owned by `GpuDevice`, while projection remains owned by
  `Renderer`.

`GpuDevice.setAuxiliaryRenderTarget(texture, viewportSize)`

- Installs a framebuffer target with the given storage size. Inherits
  `apparentSize` and the optional CSS fields from the current render
  target. Does not modify projection.

## Renderer getters

`renderer.apparentSize`

- Returns `gpu.currentRenderTarget.apparentSize`.
- The right choice for rendering code that must work for any render
  target. Returns apparent CSS size during the canvas pass and the
  inherited value during auxiliary passes.

`renderer.curSize` *(deprecated alias for `apparentSize`)*

- Forwards to `apparentSize`. Do not use in new code.

## Canvas pass

The canvas render target sizes during a normal frame:

```text
canvas target viewportSize  = rect.width * dpr, rect.height * dpr
canvas target apparentSize  = rect.width, rect.height
canvas target cssLayoutSize = offsetWidth, offsetHeight
canvas target cssScale      = rect.width / offsetWidth, rect.height / offsetHeight
```

`setProjection(apparentSize)` updates camera aspect and
`imageProjectionMatrix`. Those values describe the screen view and
follow the apparent logical size.

## Auxiliary framebuffer passes

Depth and geodata hitmaps are auxiliary buffers for the same screen
view. They use square textures for storage, sampling, and readback:

```text
hitmap target viewportSize  = [hitmapSize, hitmapSize]
hitmap target apparentSize  = canvas apparentSize  (inherited)
hitmap target cssLayoutSize = canvas cssLayoutSize (inherited)
```

Auxiliary passes bind their framebuffer and viewport via
`setAuxiliaryRenderTarget()` and do not call `setProjection()`.
The camera aspect must remain the screen aspect.

## Screen-space helpers

`RendererDraw.drawGpuJobs()` computes:

```js
screenPixelSize = [
    1.0 / renderer.apparentSize[0],
    1.0 / renderer.apparentSize[1]
]
```

Label and icon quads are scaled by `screenPixelSize`. Worker-generated
bounding-box offsets (`job.noOverlap`) are already in apparent-logical
space, matching the coordinate space of projected anchors.

## Label collision grid

`RendererRMap.clear()` uses `apparentSize` for bounds and block-grid
dimensions. Projected label anchors and rectangles are in apparent
coordinates; using `cssLayoutSize` here clips labels in the right and
bottom CSS-transform bands before they can enter `gmap`.

## Mouse-event coordinate space

`getScreenRay`, `hitTest`, `hitTestGeoLayers`, and `getDepth` accept a
`Renderer.CoordinateSpace` argument. The default is `layout`, because
mouse events report `offsetX`/`offsetY` in pre-transform CSS layout
coordinates. In this mode the methods use `cssLayoutSize ??
apparentSize`.

Projected renderer values such as label anchors from `project2()` are in
apparent coordinates. Callers that pass those values to hitmap/depth APIs
must pass `apparent`, otherwise CSS-transformed canvases sample the wrong
hitmap pixel.

## Practical rule

- Rendering geometry, label placement, collision, NDC conversions:
  use `renderer.apparentSize` (or `gpu.currentRenderTarget.apparentSize`).
- GL viewport and backing-storage dimensions: use `viewportSize`.
- Mouse-event hit-testing: use default `layout` coordinate space.
- Projected label-depth tests: pass `apparent` coordinate space.
- Do not use `curSize` in new code.
