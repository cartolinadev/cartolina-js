# Rendering architecture

See [index.md](index.md) for the wiki table of contents.

This page records the current renderer boundary and terrain draw
direction. Format details live in
[surface-metatile.md](surface-metatile.md),
[lod-selection.md](lod-selection.md),
[normal-encoding.md](normal-encoding.md),
[render-targets.md](render-targets.md), and
[renderer-coordinate-spaces.md](renderer-coordinate-spaces.md).

## Map And Renderer Boundary

`Map` in `src/core/map.ts` is the future home for map data, camera
state, tile selection, culling decisions, coordinate conversion,
measurement, style interpretation, and calls that decide what should be
drawn.

Supporting TypeScript files under `src/core/map/` should hold pieces of
that work when a separate file keeps the code clearer. Legacy files such
as `map.js`, `draw.js`, and `surface-tree.js` are being absorbed into
`Map` and supporting TypeScript files as feature work touches them.

`Renderer` stays separate. It owns the WebGL2 context, GPU resources,
shader programs, render targets, renderer-local camera data, draw
commands, and state needed to issue rendering work.

`Renderer.initFrame()` is the frame entry point for renderer-owned
runtime state. It reads the current `Map`, updates renderer caches,
updates illumination, and uploads the frame UBO from
`Map.getSelectionPosition()`. Legacy draw code must not write those
renderer fields directly. `Renderer.syncCameraState()` recomputes the
camera-derived caches after `FreezeCameraState` swaps the ambient map
camera context.

Frame setup is split by ownership:

- `Map.initFrame()` resets map-visible accumulators and loader channel
  state.
- `Renderer.initFrame()` resets renderer state and uploads frame UBOs.
- `MapDraw.initFrame()` resets legacy traversal and grid draw state.

The intended boundary is:

- map code builds per-pass context data and render requests
- renderer code consumes those requests and manages GPU state

Freeze diagnostics expose why this split matters. Tile selection and
final rendering can need different camera contexts. The current code
swaps legacy camera fields; the target design passes explicit contexts
through draw traversal.

## Terrain Tile Rendering

`src/core/map/tile-render-rig.ts` is the current terrain tile renderer.
One `TileRenderRig` resolves tile resources, tracks readiness, builds
the style layer stack, collapses bump maps into the normal map when
possible, and renders color and depth passes for one terrain tile.

The default terrain draw path now enters
`src/core/map/draw-traversal.ts` from `MapSurfaceTree.draw()`.
It performs recursive backtracking over the legacy-selected terrain
surface and uses UV-space R8 masks from
`src/core/map/draw-traversal-mask.ts` to stop fallback tiles from
overdrawing finer child coverage. The mask path is the phase-1 client
implementation from [rfc-draw-traversal.md](rfc-draw-traversal.md):
v6 metatiles can now populate `metanode.watertight`, but the traversal
does not yet consult the flag; there is no erosion or multi-surface
active-set optimization yet.

This replaced the old terrain draw-command path that was split across:

- `MapDrawTiles.drawMeshTile`
- `MapDrawTiles.updateTileBounds`

`MapMesh.drawSubmesh` was removed with the 3D Tiles octree path in
2026-05. Remaining draw code still serves runtime behaviour, especially
mapConfig-era maps and geodata.
The legacy draw files include:

- `src/core/map/draw.js`
- `src/core/map/draw-tiles.js`
- `src/core/map/surface-sequence.ts`
- map-config helpers that order surfaces, glues, and bound layers

Those files predate the style layer stack and the per-tile rig. They are
shrunk only when feature work removes a caller or replaces a behaviour
with `TileRenderRig`.

## Terrain Rendering Direction

The next design target is:

- style specs are the only authored composition model
- `TileRenderRig` is the only terrain tile render path
- GLSL ES 3.00 shaders own terrain, depth, atmosphere, layer stack, and
  vertical exaggeration
- legacy mapConfig and view support becomes an adapter, then disappears
- `Viewer` remains the flat public API
- legacy sub-objects remain private until they are deleted

[rfc-draw-traversal.md](rfc-draw-traversal.md) describes the accepted
traversal replacement.
[rfc-bump-bake.md](rfc-bump-bake.md) records the implemented
bump-layer collapse.

## Renderer Responsibilities

`Renderer` owns the WebGL2 context and draw calls. Size information is
owned by the active `GpuDevice.RenderTarget` and read through
`gpu.currentRenderTarget.apparentSize`. `renderer.apparentSize` is a
convenience accessor for the same value.

Render-target policy is documented in
[render-targets.md](render-targets.md). Coordinate space terminology
is documented in
[renderer-coordinate-spaces.md](renderer-coordinate-spaces.md).

## Illumination

Illumination supports two light frames:

- `tracking` uses azimuth and elevation authored in observer-relative
  local NED
- `geographic` uses azimuth and elevation authored in the scene-center
  NED frame

The geographic path converts through the existing `NED -> lNED -> VC`
position and orientation machinery each frame. It does not construct a
separate physical tangent-frame basis. Current north is already defined
by map-position and NED logic, so illumination reuses that convention.

## Vertical Exaggeration

Vertical exaggeration is the product of two independent factors:

1. elevation ramp, `seHeightRamp`, piecewise linear by terrain height
2. scale ramp, `veScaleRamp`, power-law by CSS scale denominator

Each ramp is defined by two pivot pairs. The elevation ramp uses
`[height, factor]`; the scale ramp uses `[sd, va]`.

Scale denominator:

```text
sd = extent / (gpu.currentRenderTarget.apparentSize[1] / cssDpi * 0.0254)
```

Scale ramp:

```text
va(sd) = va0 * (sd / sd0) ^ (log(va1/va0) / log(sd1/sd0))
```

The legacy `viewExtentProgression` format is converted to `veScaleRamp`
at load time using a canonical canvas height of 1113 CSS px. That height
matches the historical tuning baseline. The legacy public API remains
and is marked `@deprecated`; new code uses `setVerticalExaggeration()`.

## Terrain Shading

Diffuse terrain shading in `tile.frag.glsl` combines up to three
coefficients: Lambertian, slope, and aspect. The mixed case is a
weighted geometric mean of their complements, remapped to the final
shading coefficient with `1.0 - ...`.

Aspect shading is computed from the cosine between the projected surface
normal and projected light direction in the local tangent plane. On
nearly flat terrain this quantity is ill-defined because the normal
projection approaches zero. The shader uses a neutral aspect value for
those cases to avoid visible artifacts.

## Runtime Overrides

`overrides` is a single runtime object holding all per-frame rendering
overrides. Its type, `Overrides`, and its defaults, `defaultOverrides`,
are defined in `src/core/map/overrides.ts` and derived with `typeof` so
the type and the defaults cannot drift.

The typed `Map` (`map.ts`) owns the object as a class field:

```ts
overrides: Overrides = { ...defaultOverrides };
```

`Renderer` shares the same reference, installed in
`Renderer.initFrame()`:

```ts
this.overrides = map.outerMap.overrides;
```

`draw.*` fields are explicit booleans (`false` by default). They
toggle debug visualizations.

`flag*` fields default to `undefined`, meaning "defer to the
corresponding `config` value". Any explicit `boolean` overrides the
config for that frame.

Inspector and input code reach the object via `map.outerMap.overrides`.
Legacy JS files that still read `renderer.debug.X` reach the same
object through a `get debug()` accessor on `Renderer`.

## Colour Encoding

All colour values in the style spec and public APIs use integer 0-255
per channel. This includes `label-color`, `line-color`, `diffuseColor`,
`specularColor`, and atmosphere colours.

The renderer converts colours to 0.0-1.0 when they enter rendering code,
for example in `tile-render-rig.ts`, `renderer.ts`, and
`atmosphere.ts`. Do not pass 0-1 floats to these APIs; values can clamp
or wash out.

The long-term direction is hex string colours, such as `#rrggbb`,
matching MapLibre convention. That style-wide change has not been done.
