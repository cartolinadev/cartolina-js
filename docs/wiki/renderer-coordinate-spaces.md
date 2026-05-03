# Renderer Coordinate Spaces

This page defines renderer terms used by `rendering-sizes.md` and
`render-targets.md`.

## Renderer-Local 3D Space

Renderer-local 3D space is the 3D coordinate system consumed by renderer
draw jobs and camera matrices. A renderer-local 3D position is a
physical position translated so the camera center is the origin:

```text
rendererLocalPosition = physicalPosition - physicalCameraPosition
```

The current code stores the physical camera position in
`map.camera.position`, exposes it to draw code as
`renderer.cameraPosition`, and keeps the renderer camera itself at
`[0, 0, 0]` during normal map rendering. `MapConvert` and legacy
`RendererDraw` paths subtract `map.camera.position` or
`renderer.cameraPosition` before projection.

Map-level code often works in physical or navigation coordinates first,
then prepares renderer-local 3D positions for the draw layer.

The renderer camera provides model-view, projection, and combined MVP
matrices. Terrain, meshes, lines, labels, and hitmap passes use these
matrices to transform renderer-local 3D positions into clip space.

## Renderer Projection

Renderer projection means this transform chain:

```text
renderer-local 3D position
-> model-view-projection matrix
-> clip coordinates
-> normalized device coordinates
-> target-local 2D coordinates
```

`Renderer.project2()` performs this transform on the CPU. It multiplies
a 3D point by an MVP matrix, divides by `w`, then maps NDC to
target-local 2D coordinates:

```text
x = (ndcX + 1) * 0.5 * logicalWidth
y = (1 - ndcY) * 0.5 * logicalHeight
```

The result is not a physical framebuffer pixel unless the render target's
logical size equals its viewport size. On the base canvas target, the
result is normally in canvas layout CSS units.

## Target-Local 2D Space

Target-local 2D space is the post-projection 2D space of the active render
target. Its width and height are `RenderTarget.logicalSize`.

Examples:

- Base canvas pass: target-local 2D coordinates are canvas layout CSS
  coordinates.
- Auxiliary hitmap pass: target-local 2D coordinates are hitmap texture
  coordinates.

This is the space used for projected label anchors, debug overlays, 2D
images, and screen-space lines before GL maps them to the viewport.

## Screen-Space Draw Helpers

"Screen-space draw helpers" are legacy `RendererDraw` paths that accept
2D target-local coordinates instead of normal 3D world geometry. The name
is historical; when an offscreen target is active, "screen-space" really
means target-local 2D space.

Examples:

- `RendererDraw.drawImage()`
- `RendererDraw.drawText()`
- `RendererDraw.drawLineString(..., screenSpace = true, ...)`
- label and icon quad paths that combine a projected anchor from
  `project2()` with 2D glyph or icon offsets

These paths use `Renderer.imageProjectionMatrix` to map target-local 2D
coordinates into clip space. `setProjection()` rebuilds that matrix
from a logical width and height.

Many of these paths still read `renderer.curSize` internally because they
come from legacy code. New renderer work should use the active
`RenderTarget.logicalSize` for target-local 2D coordinates. These helpers
belong in the base canvas pass; calling them while an auxiliary target is
active indicates a scheduling problem.

## Relationship To Viewport Pixels

GL finally maps clip/NDC coordinates to physical viewport pixels via
`gl.viewport()`. That viewport size is `RenderTarget.viewportSize`.

For CPU-projected 2D draw helpers, the path is:

```text
renderer-local 3D coordinates -> target-local 2D coordinates via renderer projection (`project2()`)
target-local 2D -> clip coordinates via imageProjectionMatrix
clip/NDC -> viewport pixels via gl.viewport()
```

Normal GPU geometry does not use this CPU 2D path. Vertex shaders
transform renderer-local 3D positions to clip coordinates with the
camera matrices, then GL maps clip/NDC coordinates to viewport pixels.

Keeping these steps separate is what allows the base canvas to use
pre-transform CSS layout coordinates while drawing into a DPR- and
CSS-transform-adjusted backing canvas.
