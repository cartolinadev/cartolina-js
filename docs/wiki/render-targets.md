# Render Targets

`GpuDevice.RenderTarget` separates the framebuffer binding and GL
viewport from the canvas element. The renderer currently uses two kinds
of targets:

- the canvas target, which represents the onscreen map view
- auxiliary framebuffer targets, which store data for that same view

## Setting render targets

Four methods on `GpuDevice` install or update render targets:

**`setCanvasRenderTarget()`** — reads the canvas DOM element, computes
all five size fields (viewport, apparent, CSS layout, CSS scale, DPR),
resizes the canvas DOM element, installs the canvas target, and returns
it. The caller must then call `Renderer.setProjection()`. This is the
only method that performs DOM reads or changes the canvas backing-store
size.

**`updateCanvasRenderTargetIfNeeded()`** — performs the same DOM size
calculation, compares the result with the active target, and installs a
new canvas target only when a canvas size field changed. Returns `null`
when no size update was needed. `Renderer.updateSizeIfNeeded()` uses
this method and updates projection only when the previous target was the
canvas.

**`setAuxiliaryRenderTarget(texture, viewportSize)`** — installs a
framebuffer target for a pass that shares the current screen view.
Updates only the viewport. All other size fields (apparentSize,
cssLayoutSize, cssScale, dpr) are inherited from the current render
target. Does not call `setProjection()`.

**`setRenderTarget(target)`** — low-level primitive used by the two
methods above. Binds the framebuffer and applies the GL viewport.
Caller is responsible for all size and projection state.

## Projection policy

`setProjection()` is a `Renderer` method. It is called explicitly after
`setCanvasRenderTarget()` and never for auxiliary targets. This keeps
the camera aspect locked to the screen view even when the framebuffer
has a different size or aspect.

The depth and geodata hitmaps are square textures for storage and
readback convenience, but they still describe the rectangular screen
view. Changing the camera aspect to match a square hitmap would make
the hitmap projection diverge from screen-coordinate label placement
and hit-testing.

## Framebuffer readback

`GpuDevice.readFramebufferPixels()` temporarily binds the texture
framebuffer for readback and restores the tracked render-target binding
afterward. Raw framebuffer binding is not public rendering API.

## Independent targets (future)

A future `setIndependentTarget()` method will allow callers to install
a fully specified target where projection and sizes are defined by the
offscreen pass itself, not inherited from the canvas view. This covers
shadow maps, environment maps, SSAA passes, and similar. See the
backlog entry "FEATURE: explicit offscreen render-pass API".

See `rendering-sizes.md` for the complete size vocabulary and the
distinction between `apparentSize`, `viewportSize`, and
`cssLayoutSize`.
