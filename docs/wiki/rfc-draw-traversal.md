# RFC: unified recursive draw traversal

**Status:** In review — author responded to round 1; mask decision
revised to screen-space
**Context:** REFACTOR: replace legacy map draw path in
[backlog.md](backlog.md); surface metatile and glue background in
[surface-metatile.md](surface-metatile.md),
[glue-alien-flag.md](glue-alien-flag.md),
[vts-storage-and-virtual-surfaces.md](vts-storage-and-virtual-surfaces.md)

---

## 1. Problem

The tile tree traversal lives in `src/core/map/surface-tree.js` as four
separate iterative methods:

| Method | Mode config value |
|---|---|
| `drawSurface` | `topdown` |
| `drawSurfaceWithSpliting` | `topdown` + `mapSplitMeshes` |
| `drawSurfaceFit` | `fit` |
| `drawSurfaceFitOnly` | `fitonly` |

Each method is a manual stack loop (`processBuffer` / `newProcessBuffer`
arrays swapped on each generation). Combined they are roughly 1 200
lines and share no code. The split variant (`drawSurfaceWithSpliting`)
contains the embryo of the masking idea: it propagates a `splitMask`
array of four `0|1` values to the tile, which the tile shader reads
via `vClipCoord` (external texture coordinates, `aTexCoords2`) and
discards fragments that fall in masked quadrants. This is a one-level
binary mask that does not propagate up the hierarchy. `mapSplitMeshes`
defaults to `false` in `core.js:54`; it is a configurable option, not
a hardcoded restriction.

Multi-surface rendering relies on server-side glues. A glue is a
pre-baked tileset covering the seam between two surfaces; it carries
stitched geometry for seam tiles and a `sourceReference` for non-seam
tiles that redirects to a component surface. The alien-flag mechanism in
`createVirtualMetanode` was designed to select the correct copy of each
glue entry but is permanently dead: the server never writes the alien
bit into metatile output (`glue-alien-flag.md`).

**Why eliminating glues matters.**

Glue generation is computationally expensive. The pipeline
(`vts-libs/vts/tileset/glue.cpp`, `merge.cpp`, `meshop/`) is roughly
5 000 lines of computational geometry. For each tile in the seam region
at every LOD it: rasterizes each surface's mesh coverage using scan
conversion; clips mesh triangles against coverage contours using
non-convex polygon clipping; refines coarser meshes to match finer LOD
resolution when surfaces differ in detail; and repacks UV texture
atlases. This runs for every tile at every LOD across the seam boundary.
For datasets with global or continent-scale seams the tile count is
large and generation must be repeated whenever source data changes.
The generated glue tilesets add storage proportional to seam area.
Per user report: generating a glue between two planet-wide Viewfinder
Panoramas DEMs (3 arc-second merged with 1 arc-second) took multiple
days on a stock desktop machine using vts-tools.

Glues introduce client-side complexity that exists solely to serve the
abstraction: `createVirtualMetanode`, `sourceReference` handling,
proper/alien glue sequence entries, the alien flag mechanism. The alien
flag was designed to make this work correctly and has never functioned —
the server never writes it. The complexity is present without delivering
its intended benefit.

Glues are a concept specific to the VTS tileset format. No equivalent
exists in WMTS, 3D Tiles, or other tile formats. For users and
integrators unfamiliar with VTS internals they are opaque.

**Goals of this RFC:**

- Replace the four traversal methods with one recursive function.
- Replace server-side seam stitching with client-side mask compositing,
  eliminating the need to generate or serve glue tilesets.
- Allow progressive loading via configurable fallback LODs, eliminating
  the data-intensity of the topdown mode without requiring separate code.

---

## 2. Algorithm

### 2.1 Traversal structure

The new function is a depth-first recursive descent of the tile
quadtree. Current terrain surfaces do not exceed LOD 15 in practice
(ground resolution ~9.6 m at the equator in the melown2015 reference
frame, computed as `6378137 × 2π / 2^(lod−1+8)`). LOD 25 gives ~9.3
mm at the equator by the same formula — well beyond any realistic use
of the library.

Recursion at this depth is not a concern. Measured on V8 in the
current Node.js build (984 KB default stack), a function with seven
local variables — a reasonable proxy for a traversal frame carrying
tile position, mask reference, and loop variables — overflows at
approximately 6 500 frames. Thirty frames consume roughly 4.6 KB
(0.46 % of the stack), a safety margin of about 220×. Per-frame call
overhead when JIT-compiled is approximately 0.005 µs; thirty frames
add ~0.15 µs per descending path, which is noise against the cost of
a single GPU draw call (1–10 µs). Browser engines allocate larger
default stacks than Node.js on most platforms, so browser limits are
at least as generous.

The traversal visits a single sequence of tile positions (lod, x, y)
shared across all active surfaces. At each position it queries each
plain surface's metatile tree independently via the existing
`getMetatile()` + `getNode()` path. The descent decision (whether to
go deeper or treat this position as a leaf) is taken over the combined
view: descend if any surface's SSE test says the tile is too coarse,
and if any surface reports child tiles exist. Glues and virtual surfaces
are not consulted.

At each node:

1. If the metanode is not ready, return a null mask (nothing rendered).
2. If the node is frustum-culled, return a null mask.
3. For each surface in the sequence, check independently whether it is
   at its natural leaf position at this node: SSE passes or it has no
   children at this LOD. Surfaces at their natural leaf render here in
   priority order, accumulating the mask, before any descent (see §2.2).
   This ensures a front surface always claims its pixels at its own LOD,
   regardless of whether a back surface has finer data available.
4. Attempt to descend into each of the up to four children for surfaces
   that still need finer detail (SSE does not pass and children exist).
   Each child is visited recursively. Collect the returned masks.
5. OR the up to four child masks together into a single combined mask
   and merge it with any mask already written in step 3.
6. If this node is a **fallback LOD** (see §2.4), render the surfaces
   that did not render in step 3 using the combined mask from step 5 as
   input. OR the rendered coverage into the mask.
7. Return the combined mask.

This is the complete algorithm. There is no mode switch.

### 2.2 Leaf rendering

At a leaf node, the input mask is empty (no prior coverage). The
function iterates the surface sequence — the ordered list of surfaces
active at this node — and for each surface whose `TileRenderRig` is
ready:

1. Call `rig.draw()` with the current accumulated mask as input. The
   fragment shader discards fragments where the mask indicates coverage,
   then writes the newly rendered fragments into the mask output.
2. Pass the updated mask to the next surface.

After all surfaces are processed, return the accumulated mask.

**Surface ordering convention:** the sequence is ordered front-to-back.
Index 0 is the front surface — it renders first and its pixels take
precedence over all surfaces behind it. A surface at a higher index is
a back surface — it renders only into pixels not yet claimed by surfaces
in front of it. "Earlier in the sequence" and "front" are synonymous;
"later in the sequence" and "back" are synonymous. Depth testing still
operates within each individual surface's own geometry; the mask handles
ordering between surfaces at the same node.

If a surface is watertight at this tile position (its geometry covers
the full tile cell), it claims the entire UV area. All subsequent
surfaces in the sequence can skip rendering and mesh/texture loading
at this node. Metatile fetches for lower surfaces are not skipped:
the traversal still needs per-surface metatile data to determine child
structure and SSE at descendant nodes, where a lower surface may
contribute coverage that the watertight surface's children do not reach.
Skipping entire subtrees for lower surfaces below a watertight ancestor
is a valid further optimisation but requires propagating the watertight
state downward through the recursion and is deferred. See §4.0 for
how each mask approach uses watertight status.

### 2.3 Backtrack and mask propagation

When the recursive call for a child returns, its mask describes what
geographic regions that subtree has covered. The parent accumulates
these into its own mask before deciding whether to render.

The mask is in the tile's geographic UV space (external texture
coordinates). Child tiles occupy known quadrants of the parent's UV
space: child `[lod+1, 2x, 2y]` (upper-left) occupies UV
`[0,0]–[0.5,0.5]`; child `[lod+1, 2x+1, 2y]` (upper-right) occupies
`[0.5,0]–[1.0,0.5]`; and so on. Writing a child's mask into the parent
mask texture is a scale-translate blit: the child mask is rendered at
half size into its quadrant of the parent texture. No per-pixel logic
is required.

### 2.4 Fallback LOD configuration

Every node on the descent path calls `rig.isReady()` with the
`minimum: 'fallback'` level only for nodes whose LOD satisfies a
configured fallback cadence — for example, every third or fifth LOD.
Nodes not on a fallback LOD do not request render readiness and do not
render.

This directly replaces the topdown/fitonly distinction:

- `fitonly` behavior: set fallback cadence to infinity (no fallback
  LODs). Only leaves render. No geometry is requested for inner nodes.
- Topdown behavior: set fallback cadence to 1 (every LOD is a fallback
  LOD). Every inner node that can render does so, exactly as topdown.
- Recommended default: fallback every 3–5 LODs. Provides progressive
  loading with coarser tiles appearing first, while requesting far
  less data than topdown.

The cadence is a single integer configuration parameter.

---

## 3. Prior art — vts-browser-cpp

vts-browser-cpp (by Tomáš Malý) is a C++ client for the same VTS tile
format. Its traversal was examined as potential inspiration for the
design here. The findings are recorded for context.

**LOD hierarchy — UV clip.** vts-browser-cpp uses `travModeBalanced`
as its primary mode. When a child node is not ready, it calls
`renderNodeCoarser`, which walks up the tree to find the nearest ready
ancestor and renders it via `renderNodeDraws(ancestor, orig)`. Inside
`renderNodeDraws`, a UV clip rectangle `uvClip` is computed
analytically by composing `updateRangeToHalf` once per LOD level
difference — halving the UV range and shifting it based on each
ancestor step's quadrant position (`t->id.x % 2`,
`1 - t->id.y % 2`). This gives the exact UV sub-rectangle of the
ancestor corresponding to the unready descendant. The ancestor is then
rendered clipped to that rectangle.

This is the existing cartolina-js `uClip`/`splitMask` mechanism
generalised to arbitrary LOD depth. cartolina-js only goes one level;
vts-browser-cpp walks however many levels are needed.

**Why this does not eliminate cracks.** The UV clip restricts which
fragments the shader produces, but rasterization still happens in
screen space. The triangle edges of the ancestor mesh do not
perfectly abut the triangle edges of the child mesh in screen space at
oblique angles. The crack problem is the same as for a geographic mask
— the boundary is defined geographically but gaps appear in screen
space. vts-browser-cpp manages cracks in practice through dense mesh
geometry and, critically, server-side glues that pre-stitch geometry at
actual surface seam positions. Without glues, cracks at surface
boundaries remain.

**Multi-surface — glues and bound layer masks.** vts-browser-cpp does
not render multiple surfaces simultaneously at the same tile position.
It selects one winning surface per node (topmost non-empty in the
surface stack). Seam stitching between surfaces relies on server-side
glue tilesets, which carry pre-stitched geometry at seam positions. For
texture compositing, it downloads precomputed raster mask textures from
the server's bound layer mask URLs.

**What this means for the RFC design.** The vts-browser-cpp approach
works under different constraints: glues are load-bearing. The UV clip
handles the LOD hierarchy given that surface seams are already resolved
by the server. Removing glues means the client must own the compositing
fully, for both LOD hierarchy and multi-surface seam stitching.

Splitting the two problems — UV clip for LOD hierarchy, mask texture
for multi-surface — would produce two interacting systems rather than
one. The unified mask approach in this RFC handles both dimensions with
the same mechanism: a coarser fallback tile reads the mask produced by
its finer children exactly as a back surface reads the mask
produced by surfaces above it. The complexity stays constant.

---

## 4. Mask technology: open design question

The algorithm requires a mask that encodes which geographic regions have
been covered by finer tiles. Two implementations are candidates.

### 4.0 Watertight tiles

A tile is watertight if its mesh has no gaps along any of the four
tile boundary edges. This is a topological property of the mesh
geometry, not a bounding-box property: a tile whose bounding extents
fill the cell can still be non-watertight if triangles are missing
along an edge or diagonal. The v5 SDS horizontal extents (`llX, llY,
urX, urY`) record the geographic coverage of valid DEM samples, not
mesh edge continuity, and cannot substitute.

Most interior tiles in a well-formed surface are watertight. Partial
tiles occur at dataset edges, coastlines, and surface boundaries.

**Where watertight information lives today.** `TileIndex::Flag::watertight`
exists and is set by the tiling step (`tiling.cpp:343`). The surface
generator reads it at mesh-mask generation time (`surface.cpp:594`).
However, `ti2metaFlags()` in `mapproxy/src/mapproxy/generator/metatile.cpp`
only maps `TiFlag::mesh → MetaFlag::geometryPresent` and
`TiFlag::navtile → MetaFlag::navtilePresent`; it does not map
`TiFlag::watertight` to any `MetaNode` field. The flag is therefore
available during tile generation but is not written into the metatile
binary.

**Metatile v6 — adding the watertight flag.** The per-node flags field
in the metatile binary is a uint8 (`bin::write(out, std::uint8_t(flags_))`
in `MetaNode::save()`), and all eight bits are assigned. Adding a bit
there would require widening the field, a larger format change. The
cleaner path follows the precedent set by the alien flag: use a header
bitplane.

The metatile header flags byte currently allocates bit 0
(`MetaTileFlag::alienPlane = 0x01`) for the alien bitplane; bits 1–5
are unused. The `MetaTileFlag::flagMapping` table maps header bitplane
bits to `MetaNode::Flag` values at load time, and the save path
iterates the same table to write bitplanes from node flags. `MetaNode::Flag`
already stores the alien flag as `0x100` (bit 8), above the uint8
on-disk range — the bitplane is the only vehicle. Watertight follows
the same pattern exactly.

The required changes in `vts-libs` (both repositories share it as an
`externals` copy; they must be updated in sync):

- `metatile.cpp`: bump `VERSION` from 5 to 6; add
  `watertightPlane = 0x02` to `MetaTileFlag`; update
  `flagPlanes = alienPlane | watertightPlane`; add
  `{ MetaTileFlag::watertightPlane, MetaNode::Flag::watertight }` to
  `flagMapping`.
- `metatile.hpp`: add `watertight = 0x200` to `MetaNode::Flag`; add
  `watertight()` accessor and setter to `MetaNode`.

`MetaNode::load()` and `save()` do not need changes: the bitplane
mechanism already handles reading and writing any flag in `flagMapping`
without per-node code.

In `mapproxy/src/mapproxy/generator/metatile.cpp`, `ti2metaFlags()` gains:

```cpp
if (ti & TiFlag::watertight) {
    meta |= MetaFlag::watertight;
}
```

See §4.5 for the full backend change discussion including vts-vtsd.

Watertight status affects both mask approaches, though more strongly
for the geographic approach:

- **Screen-space:** a watertight tile renders every pixel in its
  projected boundary area. Its screen-space mask contribution fully
  covers those pixels and subsequent surfaces can be skipped.
- **Geographic:** a watertight tile covers the full UV area with no
  gaps. Its geographic mask is trivially known without rasterization.

### 4.1 Screen-space mask

The mask is a texture at screen resolution. Each rendered fragment
writes to the mask at its screen position (`gl_FragCoord`). A later
tile reads the mask at its own fragments' screen positions and discards
any already-covered pixel.

**Properties:**

- Crack-free by construction. The mask records exactly which screen
  pixels were produced. A parent tile can never claim a pixel a child
  already wrote.
- Camera-dependent. The mask is valid only for the camera position at
  which it was built. This is not a problem within a single frame, but
  it means the mask cannot be reused across frames.

**Correctness problem:** consider a fine tile at LOD 8 (covering
1/65536 of the mapped area) alongside a coarse tile at LOD 0. The
LOD 8 tile renders and writes its screen-space footprint. The LOD 0
tile then reads the mask at each fragment's screen position. Under
perspective, a LOD 0 fragment at a geographically different location
may project to the same screen pixel as a LOD 8 fragment. The mask
blocks the LOD 0 fragment even though it represents geography the LOD
8 tile does not cover. This is not a depth-test failure; it is an
incorrect mask discard.

This problem occurs specifically when the LOD difference between a
rendered child tile and an ancestor fallback tile is large and the
camera angle is oblique. In practice, fallback tiles are at most a
few LODs coarser (configured cadence), which limits the LOD difference
and reduces the frequency of the problem. Whether it is visible in
practice is an empirical question.

**Watertight optimization:** when iterating the surface sequence at
a leaf node, a watertight surface tile fully covers the tile's screen
area. All subsequent surfaces in the sequence are masked out and can
be skipped. For a non-watertight tile (a partial boundary tile), do
not use its mask to block subsequent surfaces: let depth testing
resolve the overlap in those boundary regions. The non-watertight
tile's rendered pixels still contribute to the backtrack mask (so
the parent knows those pixels were already handled), but subsequent
surfaces at the same node render freely where the non-watertight tile
left gaps. This avoids both the crack problem and the
surface-stacking depth-test artifact in boundary regions, at the cost
of allowing the two effects to occur where a partial tile meets a
a back surface — both of which are edge conditions that are
unlikely to be visible.

**Infrastructure:** a single R8 texture at screen resolution,
`accumulated_mask`, persists for the entire frame and is cleared at
frame start. It is global — not pooled by recursion depth. There are
no per-level textures and no blit from child to parent: because the
mask is in screen space, fine tiles write directly into the same texture
that coarse fallback tiles will later sample. Backtrack propagation is
free.

Per surface S at a node, in priority order:

1. **Screen draw.** Bind `accumulated_mask` as a sampler. Draw S in
   screen space. The fragment shader reads `accumulated_mask` at
   `gl_FragCoord.xy` and discards the fragment if the value exceeds
   0.5. Simultaneously, write coverage to a `scratch_mask` R8 texture
   via a second color attachment (WebGL2 MRT). Because the canvas
   default framebuffer does not support additional attachments, the
   screen draw targets an offscreen FBO with two color attachments
   (color + scratch), and the color attachment is then blitted to the
   canvas. Alternatively: render to the canvas in a first pass, then
   re-render S with a depth test set to `EQUAL` in a second pass
   targeting only `scratch_mask` — this avoids the FBO/blit overhead
   at the cost of a second mesh draw.

2. **OR pass.** Bind `accumulated_mask` FBO. Draw a full-screen quad
   sampling `scratch_mask`. Write `max(current, scratch)` per fragment.
   Unbind.

Total per surface: 2 draw calls (or 3 with the depth-equal variant),
one render-target switch (or two). A watertight surface fills
`accumulated_mask` for its entire screen footprint; all subsequent
surfaces at this node are skipped — 0 additional draw calls.

**Summary of tradeoffs:**

- Advantage: no cracks; global mask, no UV transform, no per-depth
  pool, no child-to-parent blit.
- Risk: incorrect blocking at large LOD differences under oblique
  angles. Bounded by fallback cadence; not observed in current data.
- Non-watertight boundary handling: back surfaces render freely where
  the front surface left gaps, with depth testing resolving overlap.

### 4.2 Geographic (UV-space) mask

The mask is a small texture in the tile's external UV coordinate space.
External UV coordinates (`aTexCoords2`) are per-vertex attributes that
map each mesh vertex to a normalized position within the tile's
geographic cell. They are present in tileserver-generated meshes.

**Writing the mask (footprint pass):** render the tile mesh with
external UV coordinates as the vertex position:

```glsl
gl_Position = vec4(aTexCoords2 * 2.0 - 1.0, 0.0, 1.0);
```

This rasterizes the mesh in UV space without camera dependency. The
rasterized fragments write 1 to the mask texture at their UV positions.
This is a separate draw call targeting an offscreen framebuffer.

**Reading the mask:** the screen-space tile shader samples the mask
at the fragment's UV coordinate (`aTexCoords2`). If the value indicates
coverage, discard.

**Backtrack transform:** a child's mask maps to the parent's UV space
via a scale-translate. Child `[lod+1, 2x, 2y]` (upper-left) occupies
UV `[0,0]–[0.5,0.5]` in the parent; the others follow the same
pattern. Writing the child mask into the parent is a viewport-restricted
blit of the child mask texture into the parent mask FBO. No resampling
issues.

**Mask texture pool:** one R8 texture per active recursion depth level.
The tree depth in practice is bounded by the data (LOD 15 for current
DTM surfaces). A pool of 16 textures at 256×256 = 1 MB total is ample.

**Watertight optimization:** this approach benefits more strongly than
the screen-space approach from watertight status.

- A watertight tile covers the full UV area. No footprint pass is
  needed: the mask is trivially set to fully covered (fill the mask
  texture with 1). This eliminates the most expensive step for the
  majority of tiles.
- When the frontmost watertight surface renders at
  a given tile position, all subsequent surfaces in the stack are
  completely masked out. They can be skipped for both rendering and
  data retrieval. Since most interior tiles are watertight, this
  eliminates a large fraction of surface requests for datasets with
  multiple overlapping surfaces.

**Crack problem:** the geographic mask has hard edges at tile
boundaries. At those edges, the mesh triangles may not rasterize
perfectly in UV space, leaving sub-pixel gaps. In screen space these
gaps become cracks — pixels where neither the child tile nor the
parent tile rendered a fragment. This is the same artifact that caused
splitting to be disabled in cartolina today.

**Mitigation — eroded mask:** shrink the footprint mask by a small UV
margin before writing it to the parent mask texture. The margin forces
the parent to render into a thin border zone around each child tile.
In that zone, depth testing resolves the overlap. The depth-test
failure mode (a later surface in the stack incorrectly occluding an
earlier one at an oblique angle) can occur in the border zone, but the
zone is narrow and the failure is imperceptible for surfaces with
similar geometry.

The erosion margin cannot be derived analytically; it depends on mesh
density and camera angle. A reasonable starting value is 1–2 texels of
the mask texture (1/256–1/128 UV units). It is an empirical parameter.

**Remaining limitation:** if a tile's UV-space footprint is fully
rasterized but the mesh does not cover every UV position in screen
space at a given camera angle, the parent is blocked from rendering
there. This can produce a dark region where neither tile contributes.
For tileserver meshes this is rare because mesh density tracks UV
coverage. It was not observed in the screenshots that prompted removal
of splitting.

**Summary of tradeoffs:**

- Advantage: camera-independent correctness; no incorrect blocking at
  any LOD difference. Watertight optimization eliminates most footprint
  passes and most lower-surface data requests.
- Risk: cracks at tile boundaries, mitigated by mask erosion with
  depth-test fallback in the border zone.
- Complexity: footprint program, blit program, mask texture pool,
  erosion pass — more infrastructure than screen-space.

### 4.3 Decision: screen-space mask

**Accepted design: screen-space mask.**

The mask records exactly which screen pixels were rendered. Cracks are
impossible by construction: a parent tile can never claim a pixel a
child already wrote. The global, frame-persistent texture requires no
UV transform, no per-depth pool, and no child-to-parent blit — the
simplest possible backtrack propagation.

The oblique-angle blocking artifact is the known risk. It is bounded
by the fallback cadence: with a cadence of 3–5, the maximum LOD
difference between any rendered fine tile and any fallback ancestor is
small, and the conditions that make the artifact visible (large LOD
gap plus highly oblique camera) are unlikely to coincide in practice.
The artifact has not been observed in current test data.

Cracks, by contrast, are a concrete known problem. The eroded-mask
mitigation for geographic masks is empirical — the correct erosion
margin varies with camera angle and mesh density and cannot be derived
analytically. The artifact was observed with the split-mask approach
(`drawSurfaceWithSpliting`) and is the concrete reason `mapSplitMeshes`
defaults to `false`.

**Geographic mask: deferred alternative.**

The geographic approach is documented in §4.2. It is the correct
fallback if the oblique-angle artifact proves visible in real
multi-surface data: camera-independent correctness is unconditional,
and the watertight optimization substantially reduces the additional
cost. It is not the implementation target of this RFC.

### 4.5 Backend changes — cartolina-tileserver and vts-vtsd

**cartolina-tileserver** is the primary target. All changes are in
`externals/vts-libs`, which is a vendored copy shared with vts-vtsd:

| File | Change |
|---|---|
| `vts-libs/vts/metatile.cpp` | Bump `VERSION` 5→6; add `watertightPlane = 0x02` to `MetaTileFlag`; update `flagPlanes`; extend `flagMapping` |
| `vts-libs/vts/metatile.hpp` | Add `watertight = 0x200` to `MetaNode::Flag`; add accessor and setter |
| `mapproxy/src/mapproxy/generator/metatile.cpp` | Add `TiFlag::watertight → MetaFlag::watertight` mapping in `ti2metaFlags()` |

No change is required to `MetaNode::save()` or `MetaNode::load()`:
the bitplane infrastructure already handles all flags in `flagMapping`
generically.

The metatile generator (`metatileFromDemImpl`) calls `ti2metaFlags()`
to convert tile-index flags to metanode flags for each node. Once
`ti2metaFlags()` maps the watertight flag, the save path will include
a watertight bitplane automatically whenever any node in the metatile
has the flag set.

**vts-vtsd** is a sunsetting component but is still part of some
deployments. It uses an independent copy of `externals/vts-libs` with
the same VERSION = 5 constant. The question is whether to patch it.

vts-vtsd does not generate metatiles from DEM data; it serves
pre-stored VTS tilesets from disk. Its role is delivery, not
generation. If a stored tileset was generated by cartolina-tileserver
v6+, vtsd must be able to parse the v6 metatile binary or it will
refuse to serve it (the current load code raises an error on
`version > VERSION`).

The patch for vtsd is identical to the vts-libs portion of the
tileserver change (metatile.hpp and metatile.cpp), with VERSION bumped
to 6 and the watertight bitplane added to `flagMapping`. The
`ti2metaFlags()` change does not apply (vtsd does not have a mapproxy
metatile generator).

Recommendation: patch vts-vtsd. The change is small, confined to
the shared vts-libs copy, and the alternative — requiring all vtsd
deployments to be replaced before v6 tilesets can be used — is a
harder operational constraint.

**Client-side (cartolina-js) metatile parsing.** The client metatile
parser in `src/core/map/metatile.js` calls
`applyMetatanodeBitplanes()` to set per-node flags from bitplanes.
Currently it handles the alien bitplane (bitplane 0). It must be
extended to handle bitplane 1 (watertight) by setting
`metanode.watertight = true` on each node where the bitplane bit is
set. For metatiles with version < 6, no watertight bitplane is
present; all nodes default to `metanode.watertight = false`, which
means the client treats every pre-v6 tile as non-watertight and falls
back to depth testing throughout. This is conservative and correct:
the watertight optimization is a performance benefit, not a
correctness requirement.

---

## 5. WebGL2 infrastructure

### 5.1 Per-surface mask sequence (screen-space)

The screen-space mask uses two R8 textures at screen resolution:

- `accumulated_mask`: the global frame mask, cleared at frame start,
  accumulates claimed pixels across the entire traversal.
- `scratch_mask`: a per-surface working texture, cleared before each
  surface draw.

Both are `TEXTURE_2D` with internal format `R8`. `accumulated_mask` is
attached to a dedicated FBO for the OR pass. `scratch_mask` is the
second color attachment of the tile render FBO (MRT).

The same texture cannot be simultaneously attached as an FBO attachment
and bound as a sampler. The per-surface sequence makes ownership
explicit:

For each surface S at a node, in front-to-back order:

1. **Screen draw.** Bind `accumulated_mask` as a sampler.
   Target: the tile render FBO (two attachments: color + `scratch_mask`).
   Draw S in screen space. The fragment shader reads `accumulated_mask`
   at `gl_FragCoord.xy` and discards if > 0.5. Color writes to
   attachment 0; coverage writes 1.0 to `scratch_mask` (attachment 1)
   at every non-discarded fragment.
   After the draw, blit the color attachment to the canvas.

2. **OR pass.** Unbind `accumulated_mask` sampler.
   Bind `accumulated_mask` FBO.
   Draw a full-screen quad sampling `scratch_mask`.
   The fragment shader writes `max(current, scratch)`.
   Unbind `accumulated_mask` FBO.

A watertight surface replaces steps 1–2 with a single fill of
`accumulated_mask` for its screen footprint (or marks all back surfaces
at this node as skipped before any draw call). The revised performance
estimate is in §6.1.

`GpuDevice.setAuxiliaryRenderTarget()` handles FBO binding and viewport.
No new `GpuDevice` API is needed beyond allocating `scratch_mask` as a
second attachment on the tile render FBO.

### 5.2 Framebuffer ordering guarantee

Within a single WebGL2 context, a draw call that writes to texture T
via an FBO is complete before a subsequent draw call that samples T
as a uniform sampler, provided that T is not simultaneously attached
as both FBO attachment and sampler. This is a WebGL2 correctness
guarantee, not a race condition. The constraint is: unbind the mask FBO
before sampling it as a uniform. Concretely:

1. OR pass: bind `accumulated_mask` FBO → write → unbind.
2. Screen draw: bind `accumulated_mask` as sampler → draw mesh.

The unbind between them is a one-line call, not a synchronization
primitive.

### 5.3 Render target lifecycle during traversal

The traversal interleaves the tile render FBO (screen draw + scratch
write), the `accumulated_mask` FBO (OR pass), and the canvas (blit).
Because `accumulated_mask` is global and frame-persistent, no
render-target state needs to be saved or restored across recursion
levels. The canvas blit after each screen draw is the only additional
operation compared to the current rendering path.

The recursive structure is safe: a child's draw calls complete before
the parent renders. By the time the parent samples `accumulated_mask`,
all child surfaces have already ORed their coverage into it.

### 5.5 `TileRenderRig` changes

`TileRenderRig` currently does not support mask-aware rendering. The
following changes are required:

**Mask-aware draw method:**

```ts
draw(program: GpuProgram, cameraPos: vec3,
     maskTexture?: GpuTexture): void
```

The existing `draw()` method gains an optional `maskTexture` parameter.
When present, the tile shader samples `maskTexture` at `gl_FragCoord`
and discards the fragment if the value exceeds 0.5. When absent, no
mask discard occurs (existing behavior).

The current `uClip` / `splitMask` mechanism is replaced by this mask
texture input. The `splitMask` field on `MapSurfaceTile` is removed.

**Depth program:**

The rig also needs a depth program for draw channel 1 (the depth
hitmap), as specified in the backlog. This is prerequisite for the
traversal refactor because the new traversal replaces both color and
depth draw paths. See backlog §1 for the depth program plan.

### 5.6 Tile shader changes

The legacy tile shader in `shaders.js` uses `vClipCoord` (interpolated
`aTexCoords2`) and `uClip[4]` or `uClip[8]` to discard fragments by
quadrant. This mechanism is one level deep and binary per quadrant.

The new tile shader in the rig's program (`TileRenderRig`) replaces
this with a screen-space mask read:

```glsl
uniform sampler2D uMask;        // R8 screen-space mask
uniform vec2      uMaskTexelSize; // 1.0 / mask resolution

// in fragment shader:
if (uMaskEnabled) {
    vec2 maskUV = gl_FragCoord.xy * uMaskTexelSize;
    float covered = texture(uMask, maskUV).r;
    if (covered > 0.5) discard;
}
```

The shader also outputs coverage to a second color attachment
(`scratch_mask`) via MRT:

```glsl
layout(location = 0) out vec4 fragColor;
layout(location = 1) out float fragCoverage;

// in fragment shader (after mask discard):
fragColor    = /* computed color */;
fragCoverage = 1.0;
```

The OR pass is a minimal full-screen quad program:

```glsl
// fragment
uniform sampler2D uScratch;
out float fragCoverage;
void main() {
    fragCoverage = max(
        texture(uScratch, uv).r,
        /* current accumulated value read from FBO */ 0.0);
}
```

In practice the OR is done with `gl.blendEquation(gl.MAX)` and
`gl.blendFunc(gl.ONE, gl.ONE)` with blending enabled, avoiding a
manual max operation and allowing a single quad draw to OR any scratch
value ≥ existing without explicit reads.

---

## 6. Performance analysis

### 6.1 Draw call count

For a typical scene with N visible tiles at the fit LOD, single surface:

- **Current fitonly:** N draw calls.
- **New traversal, fitonly mode (cadence = ∞):** N screen draws +
  N OR passes = 2N draw calls.
- **New traversal, fallback cadence 3:** approximately N + N/8 tiles
  render. Each contributes 2 draw calls: ≈ 2.25N total.

For multi-surface scenes, add 2 draw calls per additional surface per
node (or 0 for watertight surfaces where back surfaces are skipped).
Interior tiles of a well-formed surface are predominantly watertight,
so the overhead is concentrated at surface boundaries.

The OR pass is cheap: a single full-screen quad with blending enabled,
no UBO, no texture sampling beyond the scratch texture.

### 6.2 Mask texture bandwidth

Two R8 textures at screen resolution (e.g. 1920×1080 = ~2 MB each).
Reading and writing 2 MB per frame is not a bottleneck on current
hardware. The global mask is written once per rendered fragment and
read once per rendered fragment of subsequent tiles and surfaces.

### 6.3 Data requests

The fallback cadence directly controls how many inner node meshes are
requested. With cadence 5, only 1/31 of all traversed nodes are
fallback nodes. Compare to topdown, which requests readiness for every
node. For a 25-level tree with 4× branching per level (in the worst
case), topdown requests metatiles and geometry for every visible inner
node; cadence-5 fallback requests for a small fraction. Initial map
load should be substantially faster.

Without fallback (fitonly mode), the new traversal makes no more
data requests than the current `drawSurfaceFitOnly`. Frame time may be
slightly higher due to footprint and blit passes, but this is expected
to be imperceptible.

### 6.4 Tile visibility

The recursive structure naturally prunes invisible subtrees: if a node
is frustum-culled, the entire subtree is skipped without processing its
metatiles. The current iterative variants do the same via
`bboxVisible()`. No regression expected here.

---

## 7. What disappears

After this traversal is validated and the old methods are removed:

| Removed | Replaced by |
|---|---|
| `drawSurface` (topdown) | fallback cadence = 1 |
| `drawSurfaceWithSpliting` (topdown+split) | new traversal |
| `drawSurfaceFit` (fit) | fallback cadence < ∞ |
| `drawSurfaceFitOnly` (fitonly) | fallback cadence = ∞ |
| `processBuffer`, `newProcessBuffer` arrays | JS call stack |
| `drawBuffer`, `processDrawBuffer` | direct `rig.draw()` call |
| `tile.splitMask` field | mask texture uniform |
| `uClip` uniform in legacy shader | `uMask` sampler in rig shader |
| `mapLoadMode` config value | `mapFallbackLodCadence` integer |
| `mapSplitMeshes` config flag | always-on in new traversal |

Glues are ignored entirely. The new traversal visits plain surface
entries only; it never constructs a `surfaceSequence` entry for a glue,
and it never calls `createVirtualMetanode`.

It is worth clarifying what `createVirtualMetanode` actually does:
it resolves which of two competing entries in the sequence — a glue's
proper copy and a glue's alien copy — should win at a seam tile
position. This is a glue-specific mechanism. The multi-surface
coordination that the new traversal needs — knowing which plain surfaces
have geometry at a given tile position — is a different and simpler
question. It is answered by querying each surface's metatile tree
directly via `getMetatile()` + `getNode()`, the same per-surface lookup
already used in `validate()`. No merge mechanism is required because we
collect all ready surfaces rather than selecting one winner.

`createVirtualMetanode` and the alien-flag check in `surface-tile.js`
can be deleted once the old traversal methods are gone.
`generateSurfaceSequence` still produces glue entries for the legacy
path; after the legacy path is deleted, glue entry production can be
removed there as well.

Virtual surfaces are not plain renderable surfaces: their metatile
carries `sourceReference` fields that redirect tile fetches to
constituent surfaces. Treating a virtual surface metatile as a plain
surface would skip that redirect, removing the resource lookup that
makes the map render. The new traversal must not be activated for
maps that use `mapConfig.virtualSurfaces`.

The gate is `vsurfaceCount` in `generateSurfaceSequence`
(`surface-sequence.ts`): when `vsurfaceCount > 0`, the virtual-surface
path is active and the surface list has been replaced by a single
virtual entry. The new traversal is enabled only when `vsurfaceCount
=== 0`. Maps with virtual surfaces continue to use the legacy traversal
until they are either migrated to plain constituent surfaces or
virtual-surface support is added to the new path as a later
optimisation.

Test URLs in `test/urls.json` that exercise virtual-surface
configurations must remain on the legacy path during the transition.
Any URL migrated to plain surfaces must be verified to produce
equivalent screenshots before the legacy path is removed.

### Code expected to shrink substantially

- `src/core/map/surface-tree.js` — loses all four draw methods and
  both draw buffers; retains only utility traversals (height tracing,
  area tiles, `findSurfaceTile`).
- `src/core/map/surface-tile.js` — loses `splitMask`, `drawGrid`
  fallback path, `createVirtualMetanode`, alien flag handling.
- `src/core/map/draw-tiles.js` — `drawSurfaceTile` orchestration
  becomes simpler; no more `preventRender` / `preventLoad` mode
  variations in the traversal hot path.
- `src/core/renderer/gpu/shaders.js` — `uClip` / `vClipCoord` logic
  and the split shader variants are removed.

---

## 8. Compatibility and rollout

The old traversal and new traversal can coexist behind the
`TileRenderRig` gate already used in the color-pass draw path.
The new traversal applies only when `TileRenderRig` is active.
The old `drawSurface*` methods remain untouched during validation.

Validation sequence:

1. Implement the depth program for `TileRenderRig` (backlog §1).
2. Implement the footprint pass and mask blit program.
3. Implement the recursive traversal as a new method on
   `MapSurfaceTree`, replacing only the `drawSurfaceFitOnly` mode
   first. Validate against screenshot regression tests.
4. Extend to fallback cadence. Validate progressive loading.
5. Compare against old topdown mode for equivalent loaded data.
6. Delete the old methods.

---

## 9. Open questions

**Erosion margin:** the UV erosion value that prevents cracks while
minimising the border zone where depth testing may produce incorrect
results for stacked surfaces is an empirical constant. It should be
tuned against real data — particularly multi-surface datasets where
surfaces have differing mesh density near their boundary.

**Mask texture resolution:** 256×256 is a reasonable starting value.
It may need to be larger for fine-grained surfaces or smaller for
performance. Should be profiled.

**Footprint rasterization at tile boundaries:** at coarse LODs a tile
mesh has few vertices, and UV-space rasterization may not cover the
tile's full UV extent if the mesh has concave boundaries. This is
expected to be rare for tileserver-generated meshes, whose UV coverage
is dense, but should be verified.

**Watertight bitplane field verification:** before implementing, verify
that `TileIndex::Flag::watertight` is correctly set for all surface
types served by cartolina-tileserver — in particular for spheroid
surfaces and any surface type that goes through a path not covered by
the DEM-based `metatileFromDemImpl`. The `tiling.cpp` path sets the
flag correctly, but confirm that other entry paths (`surface-spheroid`
etc.) also produce correct watertight flags in the tile index before
relying on them in the metatile.

## Review round 1

1. The traversal needs a rule for surfaces whose LOD availability
   differs at the same tile position.

   Section 2.1 defines one combined descent decision: descend if any
   surface is too coarse and any surface has children. That can hide a
   surface that is a leaf at the current node. Example: surface A has no
   children below LOD 8 and surface B continues to LOD 12. At LOD 8, B
   can force descent. If LOD 8 is not a fallback LOD, A is not rendered.
   If LOD 8 is a fallback LOD and A renders after B's children have
   written the mask, the back surface or later-rendered subtree can
   block A even when A should have claimed the region first.

   The RFC should define mixed-LOD surface semantics before
   implementation starts. The design must state whether a per-surface
   leaf is rendered at its own leaf level, carried into descendants as a
   clipped ancestor, or handled by another rule. The answer must preserve
   surface ordering and avoid making data availability in one surface
   suppress coverage from another.

   *Implemented. §2.1 now evaluates each surface independently at each
   node. A surface at its natural leaf position (SSE passes or no
   children at this LOD) renders in priority order before any descent,
   so a front surface always claims its pixels at its own LOD
   regardless of whether a back surface has finer data
   available.*

2. The mask data flow is underspecified and appears to require
   ping-pong or separate accumulation textures.

   Section 2.2 says `rig.draw()` reads the current accumulated mask and
   writes newly rendered fragments into the mask output. Section 5.2
   correctly states that the same texture cannot be attached to an FBO
   while it is sampled. For the geographic approach, the screen draw also
   cannot directly write the UV-space footprint. The RFC needs an
   explicit per-surface sequence such as: sample accumulated mask during
   screen draw, unbind it, draw the UV footprint into a scratch mask,
   OR scratch into the accumulated mask, then continue to the next
   surface. If the intended sequence is different, describe the concrete
   textures, render targets, and read/write ownership at each step.

   This affects correctness and performance accounting. It changes the
   number of mask textures, draw calls, and render-target switches from
   the simplified `N footprint + N screen + N - 1 blit` estimate.

   *Implemented. §5.1 now gives the explicit per-surface 3-step sequence:
   (1) screen draw sampling accumulated mask, (2) footprint draw into
   scratch mask, (3) OR scratch into accumulated mask. Two R8 textures
   per recursion level (accumulated + scratch). The revised draw-call
   count per surface is 3, reduced to 1 fill for watertight surfaces.
   §6.1 updated accordingly.*

3. The RFC has not chosen the first implementation path.

   Section 4.3 recommends prototyping screen-space first, while sections
   5.1, 5.3, 5.4, 5.6, 6.1, and the rollout sequence describe the
   geographic implementation: footprint pass, child-mask blit, per-depth
   mask pool, and UV-space shader sampling. The status line says mask
   space is unresolved.

   An implementer cannot follow the document as written without making
   a new design decision. Either choose screen-space for the first
   implementation and rewrite the infrastructure, shader, performance,
   and rollout sections to match, or choose geographic as the RFC's
   accepted design and move screen-space to rejected or deferred
   alternative status.

   *Implemented. §4.3 now declares screen-space mask as the accepted
   design and documents geographic as a deferred alternative. §4.1
   completed with full infrastructure description. §5.1 describes the
   screen-space per-surface sequence. §5.5, §5.6, §6.1, §6.2 updated
   for screen-space. The decision was reconsidered after initial review:
   cracks have no robust solution and have already caused visible
   artifacts in cartolina; the oblique-angle artifact of screen-space
   is bounded by cadence and has not been observed in practice.*

4. Compatibility with existing virtual-surface configurations needs a
   rollout rule.

   Section 7 says virtual surfaces are ignored and `sourceReference` is
   ignored. Current virtual surfaces are not plain renderable surfaces;
   their metatile tells the client which constituent surface or glue to
   fetch. Treating such a metatile as a plain surface can remove the
   resource lookup that makes the current map render. The project rule
   says entries in `test/urls.json` must continue to render after code
   changes.

   The RFC should state how configurations with `mapConfig.virtualSurfaces`
   are handled during the transition. Acceptable answers include keeping
   the legacy traversal for those maps until client-side composition is
   implemented, expanding the virtual surface into its plain constituent
   surfaces before traversal, or documenting that specific test URLs are
   intentionally migrated with equivalent plain-surface styles.

   *Implemented. §7 now specifies the gate: the new traversal is enabled
   only when `vsurfaceCount === 0`. Maps with `mapConfig.virtualSurfaces`
   continue to use the legacy path. Test URLs exercising virtual-surface
   configurations remain on the legacy path and must be verified before
   the legacy path is removed.*

5. The watertight optimization needs a source for "no data requests"
   skipping.

   Sections 2.2 and 4.2 say that after a front watertight surface
   claims a tile, back surfaces can be skipped for rendering and data
   retrieval. Before metatile v6, the client treats all nodes as
   non-watertight. After metatile v6, it still has to fetch enough
   metatile data for back surfaces to know whether they have children
   and whether their SSE would force descent, unless the traversal rule
   says the front watertight surface terminates the whole surface stack
   at that node.

   The RFC should define when that early termination is legal and which
   metadata has already been loaded at that point. This matters for the
   data-request reduction claimed in sections 4.2 and 6.3.

   *Implemented. §2.2 now states that "no data requests" means mesh and
   texture loading, not metatile fetching. Metatile data is still
   fetched for back surfaces at each node (lightweight and needed for
   child-structure and SSE decisions at descendant nodes). Only mesh and
   texture resources are skipped when a front watertight surface renders
   at the same node. Subtree skipping (which
   would also skip metatile fetches for lower surfaces in entire
   subtrees) is a deferred optimisation.*
