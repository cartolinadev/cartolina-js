# Normal map encoding

## Background

Normal maps in cartolina-js are served by the tileserver as two-channel
textures, currently encoded as WebP images. The tile fragment shader
reads those two channels and reconstructs a 3-D surface normal before
applying lighting and bump-layer blends.

### Coordinate frame

Normals are stored in the **ellipsoid tangent frame**: a right-handed
frame whose z-axis is the ellipsoid surface normal at the tile's
geographic location. This is a deliberate departure from the standard
CG convention of expressing normals relative to the local mesh surface.
The reason is that the tileserver generates normal maps independently
of any mesh — see "Why the frame is mesh-independent" below.
`tangentialFrame2Wc` in `tile.frag.glsl` constructs this frame from
the ellipsoid zenith and the tile's up-vector and converts stored
normals to world coordinates.

The tileserver and client shader construct the identical frame
independently:

- **Tileserver** (`TangentialPlaneConvertor` in `srs.hpp`):
  `b2 = normalize(p * [1,1,axisRatioSq])` (ellipsoid normal via
  axis-ratio correction for oblate spheroid), `b0 = normalize(up × b2)`,
  `b1 = b2 × b0`. Returns `trans([b0,b1,b2])`: rotates a vector from
  ECEF into the tangent frame.

- **Client shader** (`tangentialFrame2Wc` in `tile.frag.glsl`):
  same basis vectors, returns `mat3(b0, b1, b2)`: rotates from the
  tangent frame back to world space. The two matrices are inverses of
  each other, as required.

The up-vector is the average physical direction `0.5*(ul+ur−ll−lr)`
of the tile corners in the tileserver, and the same tile-corner
geometry delivered via metatile node information in the client.

### Why the frame is mesh-independent

Terrain meshes and terrain normal maps are produced independently.
The tileserver generates a mesh from the same geographic area as the
normal map, but the two are not coupled: a mesh tile is a geometric
approximation of the surface; a normal map tile describes surface
shading detail at a finer scale. A given normal map must be usable
with any mesh that covers the same tile — including meshes produced
by different algorithms, at different resolutions, or by different
versions of the tileserver.

For this to work, the normal map encoding must be defined in a frame
that is **stable and derivable from geography alone**, without any
reference to mesh geometry. The ellipsoid tangent frame satisfies
this: it depends only on the tile's geographic position and the
reference ellipsoid, both of which are known to the tileserver when
generating the normal map and to the client shader when rendering it.
Neither side needs to know anything about the other's mesh.

The tileserver generates normal maps from **terrain data only** —
a DEM height field or a flat surface — using a 3×3 moving window to
estimate height gradients (`demNormals` in `normalmap.hpp`). It has no
knowledge of the mesh that will ultimately render the tile. The
transformation pipeline is:

```
DEM heightfield
  → demNormals (gradient in local projected SDS space)
  → convertNormals (SDS → ECEF via Jacobian of the SRS convertor)
  → TangentialPlaneConvertor (ECEF → ellipsoid tangent frame)
  → encodeOct (octahedral two-channel encoding)
  → WebP image
```

Because the frame is defined purely by the ellipsoid geometry and the
geographic position, the same normal map is valid for any mesh
representing the terrain at that tile — regardless of how the mesh was
produced, what its triangulation looks like, or how it departs from the
DEM. The normal map describes the terrain shape, not the mesh shape.

### Sign of z and overhangs

For DEM-derived normals `z > 0` always holds: a height field cannot
overhang, so every surface normal has a positive ellipsoid-zenith
component.

For general mesh surfaces (procedurally generated terrain, vertical
cliffs, arches) a surface normal can point downward relative to the
ellipsoid, giving `z < 0`. Two channels of plain XY storage cannot
represent this — `sqrt(1 − x² − y²)` always returns non-negative.
Octahedral encoding with the fold step handles the full sphere and is
therefore necessary for any surface driver that can produce overhanging
geometry.

## Octahedral encoding — current scheme

### What it does

Octahedral encoding (Cigolle et al., "Survey of Efficient Representations
for Independent Unit Vectors") projects a unit vector onto the L1 unit
octahedron, maps the result to `[0, 1]²`, and handles the lower
hemisphere via a fold step:

**Encode:**
```
n  /= (|n.x| + |n.y| + |n.z|)        // project to octahedron
p   = n.z >= 0 ? n.xy
               : (1 − |n.yx|) * sign(n.xy)   // fold for z < 0
rg  = p * 0.5 + 0.5                   // pack to [0,1]
```

**Decode (tile.frag.glsl `decodeOct`):**
```
p  = rg * 2 − 1
n  = (p.x, p.y, 1 − |p.x| − |p.y|)
t  = clamp(−n.z, 0, 1)                // > 0 only when z < 0
n.xy += (p.x >= 0 ? −t : t,
         p.y >= 0 ? −t : t)           // undo fold
n  = normalize(n)
```

Because the projection denominator `(|x| + |y| + z)` varies per
texel, octahedral is a **nonlinear** encoding: blending two encoded
values in RG space is not equivalent to blending the decoded 3-D
vectors.

### Why we keep it

**1. Full-sphere coverage.**
DEM-derived normals always have `z > 0`, but the tileserver also
generates normals for general mesh geometry — vertical cliffs and
overhanging surfaces can produce `z < 0` in the ellipsoid tangent frame
(see Background above). Plain XY storage cannot represent these; only
the fold-equipped octahedral encoding handles the full sphere.

**2. Uniform precision.**
The octahedral mapping distributes encoded directions roughly uniformly
over the hemisphere. Plain XY concentrates precision near `z ≈ 1` and
loses resolution on steep faces (`z ≈ 0`). The difference is measurable
(~27% more unique encoded directions per texel area) and perceptible on
near-vertical terrain.

**3. Canonical for two-channel compressed formats.**
When the tileserver moves from WebP to KTX/BC5 (two-channel block
compression designed for normal maps), the stored data is still two
channels. Octahedral remains the correct per-texel encoding, exactly as
with WebP.

### Manual bilinear filtering

Because the octahedral map has a seam where `z < 0` encoded values fold
back across the diamond boundary, standard GPU bilinear interpolation of
encoded values produces artefacts at that seam.

The tile shader works around this with `sampleOctBilinear`: four manual
texel fetches, decode each to a 3-D normal, bilinear-blend the decoded
vectors, then normalize. For `z > 0` normals (the common case) the seam
never occurs, so `sampleOctBilinear` is conservative but harmless.

## Bump-map collapse and TextureBlend

The `TileRenderRig` bump-layer collapse (see [rfc04-bump-bake.md]) bakes
bump-map textures into a rig-local collapsed normal texture using
`nmblender` (`TextureBlend`). This collapses one UBO slot, one texture
unit, and one shader loop iteration per bump layer for the lifetime of
the rig.

### The blending problem

Naïve raw-RGBA blending (what `TextureBlend` did originally) mixes
octahedral-encoded RG values directly. Because the encoding is nonlinear,
`lerp(encode(n1), encode(n2))` ≠ `encode(lerp(n1, n2))`. In practice the
L1 projection shrinks the encoded XY components when `z` is large, so
blended encoded values decode to normals that point more towards `(0,0,1)`
than the correct blend would — producing a visually lighter, lower-relief
result.

### The fix — `TextureBlend` oct-normal mode

`TextureBlend` now supports two modes, selected via `init()`:

| mode | use | approach |
|---|---|---|
| `'trivial'` | legacy `MapDraw` bump path | raw RGBA hardware blend into one FBO |
| `'oct-normal'` | `TileRenderRig` collapse | decode→lerp in ℝ³→normalize→encode, ping-pong two FBOs |

The `'oct-normal'` fragment shader replicates the tile shader's
`decodeOct` (including the fold step, so `z < 0` normals from overhangs
are handled correctly), blends the decoded 3-D vectors at the configured
weight, normalizes, and re-encodes as octahedral RG. This makes the
collapse produce bit-equivalent normals to what the tile shader would
compute from the un-collapsed layer stack.

`TileRenderRig.collapseNormalStack` passes `'oct-normal'` to
`nmblender.init()`; all other callers use the default `'trivial'`.

[rfc04-bump-bake.md]: rfc04-bump-bake.md
