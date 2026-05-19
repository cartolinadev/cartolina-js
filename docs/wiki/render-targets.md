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

## Depth hitmap format

The depth hitmap uses an RGBA8 colour attachment, not an R32F colour
attachment and not direct depth-attachment readback.

The fragment shader writes camera distance as four base-255 digits in
RGBA8. The clear value `[255,255,255,255]` is the no-hit sentinel. The
decoder treats any other value as a surface hit and reconstructs:

```js
r / 255 + g + b * 255 + a * 65025
```

The shader subtracts `0.5 / 255.0` from each packed channel before the
value reaches the RGBA8 attachment. WebGL converts float colour output
to normalized bytes by rounding to the nearest byte. The negative half
byte makes that conversion behave like floor for the packed digits, so
one channel does not round up and carry into the next digit. The term is
old VTS-era code: it appears in the initial imported `melown-core`
history at `df230fef`, with the un-biased encoding left nearby as a
commented alternative.

Commit `8928b855` implemented an R32F hitmap. It made the shader and
CPU readback simpler, but it also made renderer startup require
`EXT_color_buffer_float`. That extension is not part of the WebGL2
baseline. The performance benefit was limited because RGBA8 and R32F
both read four bytes per hitmap pixel, and the dominant cost is the
synchronous `readPixels()` call rather than the small decode expression.
The R32F path was reverted; the typed clear helpers from that commit
were kept.

Direct depth-attachment readback was considered and rejected for the CPU
hitmap path. WebGL2 can render to depth attachments without an
extension, but portable `readPixels()` support is not available for
`DEPTH_COMPONENT` in the same way it is for RGBA8 colour attachments. A
local Chromium WebGL2 probe accepted an RGBA8 colour attachment plus a
`DEPTH_COMPONENT24` depth texture as framebuffer-complete, but
`readPixels(..., DEPTH_COMPONENT, UNSIGNED_INT, ...)` returned
`INVALID_ENUM`. Using a depth attachment would therefore still need a
colour-readable resolve pass for CPU hit testing.

## Independent targets (future)

A future `setIndependentTarget()` method will allow callers to install
a fully specified target where projection and sizes are defined by the
offscreen pass itself, not inherited from the canvas view. This covers
shadow maps, environment maps, SSAA passes, and similar. See the
backlog entry "FEATURE: explicit offscreen render-pass API".

See `rendering-sizes.md` for the complete size vocabulary and the
distinction between `apparentSize`, `viewportSize`, and
`cssLayoutSize`.
