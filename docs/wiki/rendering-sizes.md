# Rendering Sizes

The renderer deliberately keeps several size concepts separate. This is
most visible when the map canvas is CSS-transformed, as in reveal-style
presentations, and when the renderer switches from the base canvas to
auxiliary framebuffer targets.

## Canvas Sizes

`Renderer.canvasCssSize`

- Defined in `Renderer.calculateSizes()` from `offsetWidth`/`clientWidth`
  and `offsetHeight`/`clientHeight`.
- It is the stable layout size of the onscreen map in CSS pixels.
- It is measured before CSS transforms.
- It is always the canvas size, regardless of the active render target.

`Renderer.pixelSize`

- Defined in `Renderer.calculateSizes()` from
  `getBoundingClientRect() * devicePixelRatio`.
- It is the physical backing-canvas size used for WebGL drawing.
- It includes CSS transforms and DPR.
- `GpuDevice.resizeCanvas()` writes it to `canvas.width` and
  `canvas.height`.

`Renderer.visibleScale()`

- Defined in `Renderer.calculateSizes()` as
  `getBoundingClientRect() / layoutSize`.
- It is the CSS transform scale between layout size and visible size.
- A reveal-style slide that scales a `1280 x 800` map to half size has
  `canvasCssSize = [1280, 800]`, `visibleScale = [0.5, 0.5]`, and, at
  DPR 1, `pixelSize = [640, 400]`.

This split lets the map keep stable logical coordinates while matching
the actual number of visible device pixels.

## Render Target Sizes

Every `GpuDevice.RenderTarget` has two sizes:

`RenderTarget.viewportSize`

- The GL viewport size passed to `gl.viewport()`.
- For the canvas target, this is `Renderer.pixelSize`.
- For auxiliary framebuffer targets, this is the backing texture size
  such as `[hitmapSize, hitmapSize]`.

`RenderTarget.logicalSize`

- The coordinate-space size for the active target.
- For the canvas target, this is `Renderer.canvasCssSize`.
- For current auxiliary hitmap targets, this defaults to the framebuffer
  texture size.

`Renderer.curSize`

- A getter for `gpu.currentRenderTarget.logicalSize`.
- A legacy compatibility surface for old renderer code.
- During the base canvas pass, it is the canvas CSS layout size.
- During auxiliary framebuffer passes, it is the framebuffer logical size.
- Do not use it in new code. Choose an explicit size source instead.

## Base Canvas Pass

The base canvas render target represents the user-visible map view:

```text
canvas target viewportSize = pixelSize
canvas target logicalSize  = canvasCssSize
renderer.curSize           = canvasCssSize
```

When the canvas size changes, `syncCanvasRenderTarget()` stores these
values on `gpu.canvasRenderTarget`. The base pass then calls
`updateLogicalSize(canvasCssSize)`, which updates:

- camera aspect
- `imageProjectionMatrix`

Those values describe the screen view, so they belong to the base canvas
layout size.

## Auxiliary Framebuffer Passes

Depth and geodata hitmaps are auxiliary buffers for the same screen view.
They use square textures for storage, sampling, and readback:

```text
hitmap target viewportSize = [hitmapSize, hitmapSize]
hitmap target logicalSize  = [hitmapSize, hitmapSize]
renderer.curSize           = [hitmapSize, hitmapSize]
```

These passes bind their framebuffer and viewport with
`GpuDevice.setRenderTarget()`, but they do not call
`updateLogicalSize()`. The camera aspect must remain the screen aspect.
If a square hitmap target changed the camera aspect to `1`, depth and
geodata checks would no longer match screen-coordinate label placement
and hit testing.

## Visual Scale And Labels

Label placement is mostly expressed in logical canvas coordinates, but
visible label size should not change just because a presentation or UI
wrapper scales the canvas.

`RendererDraw.drawGpuJobs()` computes:

```js
screenPixelSize = [
    1.0 / (renderer.curSize[0] * renderer.visibleScale()[0]),
    1.0 / (renderer.curSize[1] * renderer.visibleScale()[1])
]
```

For a reveal-style `scale(0.5)`, `visibleScale` is `0.5`. The renderer
therefore draws label quads twice as large into the smaller backing
canvas; the CSS transform then shrinks the canvas by half. The visible
font size stays stable.

This is intentional. Logical map coordinates follow the pre-transform
canvas layout, while pixel-sized visual features compensate for the
post-transform visible scale.

## Practical Rule

- Use `canvasCssSize` for code that describes the onscreen map view.
- Use `RenderTarget.logicalSize` when target-local coordinates are what
  the code really wants.
- Use `viewportSize` for GL viewport/backing-storage dimensions.
- Use `visibleScale()` when a pixel-sized visual feature must remain
  stable under CSS transforms.
- Do not use `curSize` in new code. It is a backward-compatibility getter
  for existing legacy code, not part of the new renderer size model.
