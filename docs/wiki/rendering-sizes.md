# Rendering Sizes

The renderer deliberately keeps several size concepts separate. This is
most visible when the map canvas is CSS-transformed, as in reveal-style
presentations, and when the renderer switches from the base canvas to
auxiliary framebuffer targets.

## Canvas Sizes

These three values are computed together by `Renderer.calculateSizes()`
and returned as `Renderer.CanvasState`. They are passed explicitly to
the functions that need them and are not stored as fields.

`cssSize`

- Defined from `offsetWidth`/`clientWidth` and
  `offsetHeight`/`clientHeight`.
- The stable layout size of the onscreen map in CSS pixels.
- Measured before CSS transforms.

`pixelSize`

- Defined from `getBoundingClientRect() * devicePixelRatio`.
- The physical backing-canvas size used for WebGL drawing.
- Includes CSS transforms and DPR.
- Written to `canvas.width` and `canvas.height` by
  `GpuDevice.resizeCanvas()`.

`visibleScale`

- Defined as `getBoundingClientRect() / layoutSize`.
- The axis-aligned CSS transform scale between layout size and visible
  bounding-box size.
- A reveal-style slide that scales a `1280 x 800` map to half size has
  `cssSize = [1280, 800]`, `visibleScale = [0.5, 0.5]`, and, at DPR 1,
  `pixelSize = [640, 400]`.
- This assumes scale-like transforms. Rotation, skew, and composed
  transforms are not modeled; supporting them would require using the
  composed DOM transform matrix rather than bounding-box ratios.

`Renderer.visibleScale()` returns the most recently computed value.
This split lets the map keep stable logical coordinates while matching
the actual number of visible device pixels.

See `renderer-coordinate-spaces.md` for definitions of renderer
projection, target-local 2D coordinates, and screen-space draw helpers.

## Render Target Sizes

Every `GpuDevice.RenderTarget` has two sizes:

`RenderTarget.viewportSize`

- The GL viewport size passed to `gl.viewport()`.
- For the canvas target, this is the physical pixel size.
- For auxiliary framebuffer targets, this is the backing texture size
  such as `[hitmapSize, hitmapSize]`.

`RenderTarget.logicalSize`

- The width and height of the target-local 2D coordinate system used by
  renderer projection and screen-space draw helpers.
- It is the size used when converting projected NDC coordinates into
  target-local positions: `x = (ndcX + 1) * 0.5 * logicalWidth`,
  `y = (1 - ndcY) * 0.5 * logicalHeight`.
- It is also the size used by `setProjection()` to build
  `imageProjectionMatrix`.
- For the canvas target, this is the CSS layout size.
- For current auxiliary hitmap targets, this defaults to the framebuffer
  texture size.

`Renderer.logicalSize`

- A getter for `gpu.currentRenderTarget.logicalSize`.
- The right choice for rendering code that must work for any render
  target: returns CSS layout size during the canvas pass and the
  target's own logical size during independent offscreen passes.
- Use this in rendering geometry and label-density code.

`Renderer.curSize`

- Deprecated alias for `logicalSize`. Kept for backward compatibility.
- Do not use in new code.

## Base Canvas Pass

The base canvas render target represents the user-visible map view:

```text
canvas target viewportSize = pixelSize   (physical pixels)
canvas target logicalSize  = cssSize     (CSS layout pixels)
renderer.logicalSize       = cssSize
```

When the canvas size changes, the renderer recalculates sizes,
resizes the backing canvas, and creates a new canvas render target.
The base pass then calls `setProjection(cssSize)`, which updates:

- camera aspect
- `imageProjectionMatrix`

Those values describe the screen view, so they belong to the CSS
layout size.

## Auxiliary Framebuffer Passes

Depth and geodata hitmaps are auxiliary buffers for the same screen
view. They use square textures for storage, sampling, and readback:

```text
hitmap target viewportSize = [hitmapSize, hitmapSize]
hitmap target logicalSize  = [hitmapSize, hitmapSize]
```

These passes bind their framebuffer and viewport with
`GpuDevice.setRenderTarget()`, but they do not call
`setProjection()`. The camera aspect must remain the screen aspect.
If a square hitmap target changed the camera aspect to `1`, depth and
geodata checks would no longer match screen-coordinate label placement
and hit testing.

## Visual Scale And Labels

Label anchors are projected into target-local logical coordinates, but
glyph and icon quad offsets are scaled through `screenPixelSize`.
Collision boxes also compensate for `visibleScale()` when converting
style offsets into target-local extents.

`RendererDraw.drawGpuJobs()` computes:

```js
screenPixelSize = [
    1.0 / (renderer.logicalSize[0] * renderer.visibleScale()[0]),
    1.0 / (renderer.logicalSize[1] * renderer.visibleScale()[1])
]
```

For a reveal-style `scale(0.5)`, `visibleScale` is `0.5`. The renderer
therefore draws label quads twice as large into the smaller backing
canvas; the CSS transform then shrinks the canvas by half. The visible
font size stays stable.

This is intentional. Logical map coordinates follow the pre-transform
canvas layout, while pixel-sized visual features compensate for the
post-transform visible scale.

Feature-count reduction currently uses `renderer.logicalSize` and a
fixed CSS `ppi = 96`, without `visibleScale()`. This keeps the maximum
label count stable under presentation transforms. If `visibleScale()`
is used to represent the actual visible map area rather than a transient
CSS reveal/scale effect, the density policy may need to account for it.

## Practical Rule

- Use `renderer.logicalSize` in rendering code that must work for any
  render target: geometry, label-density calculations, NDC-to-pixel
  conversions. It is the active render target's `logicalSize`.
- Use `RenderTarget.logicalSize` directly when you have an explicit
  target reference; this is the same value `renderer.logicalSize`
  returns while that target is active.
- Use `viewportSize` for GL viewport and backing-storage dimensions.
- Use `visibleScale()` when a pixel-sized visual feature must remain
  stable under CSS transforms.
- Do not use `curSize` in new code — it is a deprecated alias for
  `logicalSize`.
