# relief-lab — Specification

## Purpose

`relief-lab` is an interactive demo for cartographers to explore and
tune the rendering parameters that govern terrain appearance:
illumination, shading, and vertical exaggeration.
It is accessible at `demos/relief-lab/index.html`.

---

## URL

```
http://localhost:8080/demos/relief-lab/?style=<style-url>&pos=<position-string>
```

| Parameter | Default |
|-----------|---------|
| `style`   | `https://localhost:8080/demos/map/styles/full.json` |
| `pos`     | `obj,15.588508,50.732641,fix,1059.58,55.91,-50.14,0.00,19305.21,30.00` |

The map position is kept in sync with the URL (read and write) via
`cartolina.runtimeOptionsFromUrl({ positionInUrl: true })`, matching
the behaviour of `demos/map/`.

---

## Layout

```
┌──────────────────────────────────────────────────────────────┐
│  [side panel: ≤25vw / ≤360px] ◄ │  [map: remaining width]   │
│                                   │                           │
│  Illumination & Shading │ Vertical│                           │
│  Exaggeration │ Options           │                           │
│  ─────────────────────────────── │                           │
│  tab content (overflow-y: scroll) │                           │
└──────────────────────────────────────────────────────────────┘
```

The ◄/► button on the right edge of the panel collapses and expands
it. When collapsed, only the toggle button is visible and the map
takes the full viewport width.

---

## Tab 1 — Illumination & Shading

### Light section

| Control | Type | Range / Options | Default | API field |
|---------|------|----------------|---------|-----------|
| Type | Select | Tracking / Geographic | Tracking | `light.type` |
| Azimuth | Slider | 0 – 360° | 315 | `light.azimuth` |
| Elevation | Slider | 0 – 90° | 45 | `light.elevation` |
| Ambient coefficient | Slider | 0.0 – 1.0 | 0.3 | `ambientCoef` |
| Diffuse color | Color picker | RGB | #ffffff | `diffuseColor` |
| Specular color | Color picker | RGB | #999980 | `light.specular` |

**Diffuse color semantics:** the color hue and saturation are authored
by the user, but brightness is always scaled so that the maximum RGB
component equals `1 − ambientCoef`. This avoids whiteouts regardless
of the chosen color. Pure black is treated as a special case and
results in zero diffuse output. The same scaling is enforced inside
`Renderer.updateBuffers()`.

### Shading section

Each of the three shading modes has a checkbox (active toggle) and a
weight slider. Unchecking a mode greys out its weight slider
(`opacity: 0.4; pointer-events: none`).

| Mode | Default active | Default weight | API fields |
|------|---------------|----------------|-----------|
| Lambertian | ✓ | 0.75 | `shadingLambertianWeight` |
| Slope | ✓ | 0.25 | `shadingSlopeWeight` |
| Aspect | ✗ | 0.0 | `shadingAspectWeight` |

Weights are normalized to sum to 1 before being sent to the API
(inactive modes contribute 0). This is enforced both in the UI and in
`Renderer.setIllumination()` (the shader already normalizes, so this
has no functional effect but keeps the values meaningful).

All Tab 1 changes call `map.setIllumination()` with the full current spec.

---

## Tab 2 — Vertical Exaggeration

### Scale-based ramp

Controlled by a checkbox ("Scale-based vertical exaggeration"). When
unchecked, the graph and numeric inputs are visually disabled
(`opacity: 0.4; pointer-events: none`).

- **Graph axes:** both logarithmic (power-law function)
- **X axis:** scale denominator, domain `[8 000, 1 000 000]`
- **Y axis:** VA factor, domain `[0.5, 15]`
- **Two draggable knobs** (min pivot and max pivot); numeric inputs
  below mirror knob state
- Drag constrains: `x1 < x2`, both clamped to axis range

API mapping:
```
spec.scaleRamp = { min: [x1, y1], max: [x2, y2] }
```

Default values: `x1 = 200 000, y1 = 1.0, x2 = 500 000, y2 = 12.3`

### Elevation-based ramp

Controlled by a checkbox ("Elevation-based vertical exaggeration").
Same gate behavior as above.

- **Graph axes:** both linear
- **X axis:** elevation metres, domain `[-1 000, 9 000]`
- **Y axis:** VA factor, domain `[1.0, 2.0]`
- **Two draggable knobs**; numeric inputs below

API mapping:
```
spec.elevationRamp = { min: [x1, y1], max: [x2, y2] }
```

Default values: `x1 = 0, y1 = 1.5, x2 = 4 000, y2 = 1.3`

All Tab 2 changes call `map.setVerticalExaggeration()` with both
ramps (those that are active).

---

## Tab 3 — Options

Toggle checkboxes for rendering flags:

| Label | API call |
|-------|----------|
| Illumination (lighting) | `map.setIllumination({ ...currentSpec, useLighting: bool })` |
| Normal maps | `map.setRenderingOptions({ useNormalMaps: bool })` |
| Diffuse maps (textures) | `map.setRenderingOptions({ useDiffuseMaps: bool })` |
| Specular maps | `map.setRenderingOptions({ useSpecularMaps: bool })` |
| Bump maps | `map.setRenderingOptions({ useBumpMaps: bool })` |
| Haze (atmosphere) | `map.setRenderingOptions({ useAtmosphere: bool })` |
| Foreground shadows | `map.setRenderingOptions({ useShadows: bool })` |

Note: `useLighting` is deliberately part of `IlluminationDef` rather
than `RenderingOptions`. The `flagLighting` render-flag bit in the
frame UBO is controlled indirectly through `illumination.useLighting`
— it is only set when `getIlluminationState()` returns true, which
requires `illumination.useLighting` to be true. Default config leaves
`flagLighting` override unset (falls back to `mapFlagLighting: true`),
so the illumination toggle is entirely controlled by
`setIllumination({ useLighting: bool })`.

---

## Required API additions

### 1. Diffuse color

`diffuseColor` added to:
- `MapStyle.IlluminationSpecification` (`src/core/map/style.ts`) —
  for style-file authoring
- `Renderer.IlluminationDef` (`src/core/renderer/renderer.ts`) —
  for programmatic use
- Internal `Illumination` type

Scaling logic in `Renderer.updateBuffers()` replaces the hardcoded
`[1−ambcf, …]` with a properly tinted and brightness-clamped version
(max-component normalization).

### 2. `setRenderingOptions()`

New public method on `Renderer`, proxied through `RendererInterface`,
`CoreInterface`, and `BrowserInterface`. Accepts
`Renderer.RenderingOptions` — optional boolean fields for each render
flag (excluding `useLighting`). Each defined field overwrites the
corresponding `renderer.debug` override, which takes precedence over
the config default on the next frame.

---

## Implementation files

| File | Change |
|------|--------|
| `src/core/map/style.ts` | Add `diffuseColor?: Color3Spec` to `IlluminationSpecification` |
| `src/core/renderer/renderer.ts` | `diffuseColor` in types + `setIllumination`; `setRenderingOptions()` + `RenderingOptions` type; `updateBuffers()` scaling |
| `src/core/renderer/interface.js` | Proxy `setRenderingOptions` |
| `src/core/interface.js` | Proxy `setRenderingOptions` |
| `src/browser/interface.js` | Proxy `setRenderingOptions` |
| `demos/relief-lab/index.html` | New demo |
