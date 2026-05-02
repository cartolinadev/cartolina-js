# Render Targets

`GpuDevice.RenderTarget` separates the framebuffer binding and GL viewport
from the canvas element. The renderer currently uses two kinds of targets:

- the base canvas target, which represents the onscreen map view
- auxiliary framebuffer targets, which store data for that same map view

The base canvas pass is the only pass that calls `updateLogicalSize()`.
That method updates screen-space state: camera aspect and
`imageProjectionMatrix`. Those values describe the current map view and
therefore follow the canvas layout, not every framebuffer texture.

The depth and geodata hitmaps are auxiliary buffers. They are rendered into
square textures because a fixed square backing store is convenient for
sampling and CPU readback, but they still describe the rectangular screen
view. Changing the camera aspect to the square texture aspect would make
the hitmap projection diverge from screen-coordinate label placement,
hit-testing, and depth checks.

Auxiliary passes should therefore bind their framebuffer and viewport with
`GpuDevice.setRenderTarget()`, clear the target, and render using the
screen camera. A future independent render-to-texture pass should make its
camera/logical-size policy explicit instead of reusing the auxiliary
hitmap setup.

The legacy `Map.renderToImage()` path used a temporary power-of-two
framebuffer as a screenshot/readback workaround. It had no internal demo
or test callers and was removed from `fix/render-targets`; it should not
be used as the model for future multipass rendering.
