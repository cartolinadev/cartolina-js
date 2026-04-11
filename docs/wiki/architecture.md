# Architecture

## Overview

cartolina-js is a WebGL2 3D terrain cartography library. It is the
frontend half of a two-component stack; the backend is
`cartolina-tileserver`, a C++ daemon that processes geospatial data and
streams formatted tiles to the client over an nginx reverse proxy
(default: `localhost:8070/mapproxy`).

Tile types: terrain surfaces (TIN meshes + bundled normal maps), overlay
raster imagery, bump maps, specular reflection maps.

## Two-level API

- **Core API** (`src/core/`) — rendering only; consumer wires their own
  UI and navigation.
- **Browser API** (`src/browser/`) — higher-level; built-in UI controls
  and navigation.

Config params flow downward: `BrowserInterface` → `CoreInterface` →
`Core` → `Renderer` / `Map`. Renderer params use the `renderer*` key
prefix; map params use the `map*` prefix — both are auto-routed in
`Core.setConfigParam`.

## Source layout

```
src/core/
  map/          — map-level objects (Atmosphere, Style, TileRenderRig…)
  renderer/     — rendering pipeline (Renderer, GpuDevice, GpuProgram…)
  renderer/gpu/ — low-level GPU abstractions
  utils/        — math, utilities
src/browser/    — Browser API layer
```

## Renderer internals

The `Renderer` class owns the WebGL2 context and the render loop. It
maintains a `curSize` field (CSS layout size) that is temporarily
overwritten during hitmap/depth-map passes to the framebuffer dimensions.
Code that needs the stable viewport size must use `mainViewportCssH`
(updated only in `applySizes`) rather than reading `curSize` directly.

Illumination supports two light frames:

- `tracking` — azimuth/elevation authored in observer-relative lNED.
- `geographic` — azimuth/elevation authored in the scene-center NED
  frame and converted each frame through the existing `NED -> lNED ->
  VC` position/orientation machinery.

The geographic implementation deliberately does not build its own
physical tangent-frame basis. In this codebase, current north is already
established by the map-position/NED logic, so illumination should reuse
that machinery rather than layering a separate pole or basis convention
on top.

## Vertical exaggeration

VE is the product of two independent factors:

1. **Elevation ramp** (`seHeightRamp`) — piecewise linear by terrain
   height. Defined by two pivot pairs `[height, factor]`.

2. **Scale ramp** (`veScaleRamp`) — power-law by CSS scale denominator.
   Defined by two pivot pairs `[sd, va]`; interpolated log-log linearly
   between them and clamped outside the range.

Scale denominator formula:
```
sd = extent / (mainViewportCssH / cssDpi * 0.0254)
```

Scale ramp formula:
```
va(sd) = va0 * (sd / sd0) ^ (log(va1/va0) / log(sd1/sd0))
```

The legacy `viewExtentProgression` format is converted to `veScaleRamp`
at load time using a canonical canvas height of 1113 CSS px (matching
the historical tuning baseline). The legacy public API is kept and
marked `@deprecated`; new code uses `setVerticalExaggeration()`.

## Terrain shading

Diffuse terrain shading in `tile.frag.glsl` combines up to three
coefficients: Lambertian, slope, and aspect. The mixed case is
expressed as a weighted geometric mean of their complements, then
remapped back to the final shading coefficient with `1.0 - ...`.

Aspect shading is computed from the cosine between the projected surface
normal and projected light direction in the local tangent plane. On
nearly flat terrain this quantity becomes ill-defined because the normal
projection approaches zero, so the shader treats those cases with a
neutral aspect value to avoid visible artifacts.
