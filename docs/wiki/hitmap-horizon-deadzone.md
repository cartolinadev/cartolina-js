# Depth hitmap: horizon dead zone

## Problem statement

`getScreenDepth` returns no reading for a strip of pixels immediately
below the visual horizon. The dead zone is approximately 8 pixels wide
at the centre of the viewport and narrows to ~4 pixels at the edges,
forming a curved band that follows the horizon arc. It manifests only
when looking at distant terrain; it disappears in raking views where
the horizon is very close to the camera.

The symptom propagates to `getHitCoords`, which uses `getScreenDepth`
internally, so elevation and distance readings also fail in that strip.

## How it manifests

- **Depth scan** (x=757, y=1..80 at the demo position): readings are
  `—` for y=1..55, first finite reading at y=56 (~363 km).
- **Binary hitmap overlay**: a red strip follows the horizon — broader
  at the viewport centre, narrower at the left and right edges.
- **Grayscale depth TIFF** (0-400 km, 16-bit): the dead zone appears
  as a strip of zeros at the top of the terrain region; ridgeline
  detail below aligns perfectly with the main render.
- **Raking viewpoint** (tilt ≈ 0°, horizon at ~57 km): no dead zone
  at all. The band only appears when looking obliquely at distant
  terrain near the geometric horizon.

## Investigation — what was ruled out

| Hypothesis | Test | Result |
|---|---|---|
| Hitmap resolution / coordinate mismatch | Changed hitmap to exact canvas size (1524×1085) | Dead zone unchanged |
| `ndcToScreenPixel` LOD difference between ch0 and ch1 | Patched draw.js to use canvas scale in both passes | No change |
| `applyTileClip` discarding horizon fragments | Disabled tile clip in `tile-depth.frag.glsl` | Dead zone grew larger |
| Tile selection difference between ch0 and ch1 | Logged tile IDs per channel for one frame each | Identical sets (236 tiles each) |
| NDC-to-viewport registration error | Grayscale depth TIFF overlaid on debug terrain image | Perfect alignment |
| Missing external UVs causing wrong clip coords | Checked `rt.externalUVs` for all tiles in ch1 | All 1400 tile draws had external UVs |
| `isDepthReady` rejecting tiles differently | Counted `curRigDepthReady` in `drawSurfaceTile` | All 1400 depth-ready, zero skipped |

## What we know

1. **Same tiles, same readiness** — `processDrawBuffer` fires with the
   same 57-tile buffer for both channels. All tiles pass `isDepthReady`.
   None are geodata tiles. Mesh submesh count is non-zero for all.

2. **`drawDepth` is reached** — adding `console.log` at the top of
   `drawDepth` in `TileRenderRig` showed 236 unique tiles drawn per
   ch1 frame, matching ch0 exactly.

3. **Geometry simply absent in the hitmap** — raw pixel reads from
   `hitmapData` at the failing rows are all (255,255,255,255) even
   immediately after a forced `drawHitmap()` call. The GL color buffer
   was never written at those rows.

4. **Dead zone shape** — broader in the centre, narrower at edges.
   This follows the perspective projection of the geometric horizon arc.

5. **Raking views work** — when the horizon is close (a few tens of
   kilometres), the dead zone is absent. The problem is specific to
   very distant geometry near the geometric horizon of the Earth.

## Possible causes (not yet tested)

**A — Back-face culling of horizon triangles**
The tile mesh is a grid of triangles on a curved Earth. Near the top
edge of a far tile, some triangles may face away from the camera due
to Earth's curvature. Both ch0 and ch1 use `culling: true`, so any
back-face-culled triangle is absent in both — yet the main render does
show terrain there. However, the main render uses a different vertex
shader path (atmosphere, etc.) which might affect the effective
winding order or rely on two-sided rendering for some geometry.

**B — Depth precision failure near z≈1**
Far-horizon tiles have GL NDC z ≈ 0.99999 with a 16-bit depth buffer.
Two tiles at virtually the same distance may be assigned the same
quantised depth level. With `gl.LESS`, the second tile fails the depth
test. If the correct (colour-writing) tile renders second, the
clear-colour (255,255,255,255) value left by the earlier tile is what
is read back.

**C — Some sky/dome geometry writing to the depth buffer**
If a sky dome or atmosphere geometry writes to the depth buffer during
the main pass but is NOT rendered in the depth channel (ch1), those
depth-buffer values could cause subsequent tile fragments to fail
`gl.LESS`. In ch0 the sky would be behind terrain, but in ch1 the sky
dome might render first (or at z=1.0 exactly), blocking horizon tiles.

**D — Vertex exaggeration sign flip**
VE scales terrain elevation radially. For a tile whose vertices straddle
the geometric horizon, VE might push some vertices to the "wrong" side
of the planet ellipsoid in view space, flipping triangle winding and
triggering back-face culling only for specific elevation profiles.

## Possible next steps

1. **Disable back-face culling for ch1** — add `gl.disable(gl.CULL_FACE)`
   in `switchToFramebuffer('depth')`, before `processRenderSlots`.
   If the dead zone fills in, winding-order flip is the cause.

2. **Check depth-buffer writes from sky/dome** — log whether any
   non-tile geometry (dome, sky, water) runs during ch1 and writes
   to the depth buffer, which could block tile fragments.

3. **Switch depth buffer to `DEPTH_COMPONENT32F`** — rules out
   precision failure at z≈1.

4. **Add GL_POLYGON_OFFSET_FILL** in the depth pass — biases fragment
   depth slightly, may reveal if depth-test collisions are the cause.

## Related files

- `src/core/renderer/renderer.ts` — `initHitmapTexture`, `copyHitmap`,
  `getDepth`, `switchToFramebuffer`
- `src/core/map/tile-render-rig.ts` — `drawDepth`
- `src/core/renderer/shaders/tile-depth.vert.glsl` — depth vertex shader
- `src/core/renderer/shaders/tile-depth.frag.glsl` — depth fragment shader
- `src/core/map/draw.js` — `drawMap`, `drawHitmap`
- `scripts/hitmap-vis.js` — Playwright helper for hitmap visualisation

## Diagnostic tools preserved

`scripts/hitmap-vis.js` — run as a Playwright script to:
- Overlay the hitmap as a binary hit/miss canvas on the live map
- Overlay as grayscale depth (configurable km range)
- Export a 16-bit depth TIFF via the companion Python script

`scripts/hitmap-to-tiff.py` — reads the Playwright evaluate output
file and writes a 16-bit grayscale TIFF.
