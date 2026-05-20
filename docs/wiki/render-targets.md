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

The depth hitmap uses an RGBA8UI integer colour attachment. The fragment
shader writes the raw IEEE 754 bit pattern of the camera distance as
four little-endian bytes (LSB in R) using `floatBitsToUint`. The GPU
stores the bytes exactly — RGBA8UI carries no float normalization step.
The clear value `[255,255,255,255]` maps to the bit pattern
`0xFFFFFFFF`, which is a quiet NaN in IEEE 754. The decoder reads four
bytes back with `DataView.getFloat32(..., true)` and treats any
non-finite value as the no-hit sentinel.

`GpuDevice.clearColorAndDepth()` dispatches on the active render
target's texture type: integer targets use `gl.clearBufferuiv` for the
colour buffer and `gl.clearBufferfv` for depth; normalized targets use
the existing `gl.clearColor` + `gl.clear` path.
`GpuDevice.readFramebufferPixels()` similarly switches between
`gl.RGBA_INTEGER` and `gl.RGBA` based on texture type.

**Format history.** The hitmap was originally RGBA8 normalized. The
fragment shader packed camera distance as four base-255 digits and
subtracted a half-byte bias (`0.5 / 255.0`) intended to make WebGL's
float-to-UNORM8 rounding behave like floor. The encoding had carry
errors: floating-point rounding in the shader or in the UNORM8
conversion could increment a digit and carry into the next one,
producing a decoded value wrong by a multiple of 255. The role of the
bias in those errors is unclear. Commit `8928b855` switched to R32F,
which eliminated the carry errors entirely, but required
`EXT_color_buffer_float` — not part of the WebGL2 baseline. That path
was reverted. The current RGBA8UI approach achieves the same
correctness as R32F (exact bit-pattern transfer, no normalization, no
carry errors) without any extension.

Direct depth-attachment readback was considered and rejected for the CPU
hitmap path. WebGL2 can render to depth attachments without an
extension, but portable `readPixels()` support is not available for
`DEPTH_COMPONENT` in the same way it is for colour attachments. A local
Chromium WebGL2 probe accepted an RGBA8 colour attachment plus a
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
