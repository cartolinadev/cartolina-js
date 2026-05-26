# RFC: unified recursive draw traversal

**Status:** Accepted
**Context:** REFACTOR: replace legacy map draw path in
[backlog.md](backlog.md); surface metatile and glue background in
[surface-metatile.md](surface-metatile.md),
[glue-alien-flag.md](glue-alien-flag.md),
[vts-storage-and-virtual-surfaces.md](vts-storage-and-virtual-surfaces.md)

---

## 1. Problem

The tile tree traversal lives in `src/core/map/surface-tree.js` as five
separate iterative methods:

| Method | Mode config value |
|---|---|
| `drawSurface` | `topdown` |
| `drawSurfaceWithSpliting` | `topdown` + `mapSplitMeshes` |
| `drawSurfaceFit` | `fit` |
| `drawSurfaceFitOnly` | `fitonly` |
| `drawSurfaceDownTop` | `downtop` |

Each method is a manual stack loop (`processBuffer` / `newProcessBuffer`
arrays swapped on each generation). Combined they are roughly 1 300
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

- Replace the five traversal methods with one recursive function.
- Replace server-side seam stitching with client-side mask compositing,
  eliminating the need to generate or serve glue tilesets.
- Allow progressive loading via configurable fallback LODs, eliminating
  the data-intensity of the topdown mode without requiring separate code.

**Out of scope: geodata rendering.**

Geodata free layers also call `MapSurfaceTree.draw()`, but they use the
tree as a tile selector and loader for label and icon jobs. The selected
geodata tiles call `MapGeodataView.draw()`, which collects jobs into
`renderer.jobZBuffer`; `RendererDraw.drawGpuJobs()` draws those jobs
later. The mask-compositing design in this RFC applies to terrain
surface rendering through `TileRenderRig`; it does not apply to geodata
job collection or label collision.

The implementation must keep a geodata traversal path until geodata has
its own replacement. Only the fitted-frontier behavior is needed for
that path: descend to the tiles whose `texelSize` fits the configured
threshold, collect jobs for those tiles, and use parent fallback only
while fitted tiles load. It may share culling, texel-size, and loader
helpers with the new terrain traversal, but it must not route geodata
through terrain mask rendering.

Non-geodata free layers are not supported by the new traversal. The
legacy path can render free layers that behave like independent tiled
surface trees, but style-based maps do not produce them and no current
test URL depends on them. The new path ignores such layers and emits a
one-off console warning naming the unsupported free layer.

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

The traversal visits one sequence of tile positions (lod, x, y) shared
by the surfaces that remain active for that subtree. It is a combined
tree traversal, not one traversal per surface. At each position it
queries each active plain surface's metatile tree independently via the
existing `getMetatile()` + `getNode()` path. The descent decision is
taken over the combined active set: descend if at least one active
surface needs finer detail and has a child that can contribute to that
detail. Glues and virtual surfaces are not consulted.

A surface is active at a node when all of these hold:

- it was not deactivated by an ancestor;
- its metatile and metanode are ready for this tile position;
- the node is not frustum-culled for this surface;
- no higher-priority watertight surface has already claimed the
  whole node for this subtree.

Active status is propagated downward. A surface is removed from the
child active set when it reaches its natural leaf at the current node
(SSE passes, or no children exist), when it is culled, when its metatile
is not ready, or when a higher-priority watertight surface deactivates
it. A removed surface is not tested, drawn, or used for resource
loading in descendants of that node.

At each node:

1. Exclude any surface whose metatile is not ready from this node's
   rendering and from the descent decision. If no surface remains,
   return a null mask.
2. If the node is frustum-culled, return a null mask.
3. Build child active sets per quadrant from surfaces that still need
   finer detail and whose current metanode reports that child. Recurse
   once into each quadrant whose child active set is non-empty. Collect
   the masks returned by child calls and OR them together into a
   combined mask.
4. On backtrack: for each surface at its **natural leaf** at this node
   — SSE passes or it has no children at this LOD — render it using
   the combined child mask as input (see §2.2). OR the rendered
   coverage into the mask. This is unconditional: a surface at its
   natural leaf always renders on backtrack here, regardless of
   fallback cadence, because there is no finer data for it anywhere
   in the tree.
5. If this node is a **fallback LOD** (see §2.4), also render surfaces
   that are not at their natural leaf here (they have children but
   provide early coverage as a fallback). Use the combined mask as
   input and OR the rendered coverage into the mask.
6. Return the combined mask.

There is no mode switch. The surface rendering called in steps 4 and 5
is described in §2.2.

The distinction between steps 4 and 5 matters for mixed-LOD surface
stacks. A coarse back surface whose LOD range ends at this node renders on
backtrack in step 4 regardless of fallback cadence; it sees the child
mask that the front surface's descendants already wrote, so it fills
only the gaps the front surface left. A front surface that could go
deeper but renders early as fallback coverage is handled in step 5 on
backtrack, gated by the fallback cadence.

### 2.2 Leaf rendering

At a leaf node, the input mask is empty before the first surface is
processed. The function iterates the ordered list of surfaces active at
this node, and for each surface whose `TileRenderRig` is ready:

1. Call `rig.draw()` with the current input mask. The
   fragment shader discards fragments where the mask indicates coverage,
   then writes the newly rendered fragments into the mask output.
2. The updated mask becomes the input mask for the next surface.

After all surfaces are processed, return the accumulated mask.

**Surface ordering convention:** in the existing `surfaceSequence`
array, the primary (front) surface is at the **last** index and back
surfaces are at lower indices. This follows the same convention as glue
IDs: the back surface appears first, the front surface last. The sort
in `surface-sequence.ts` is alphabetical ascending; the primary surface
has the highest sort key, landing at the end of the array, and receives
`viewSurfaceIndex = 0` — the value that wins comparisons in the current
rendering path (`surface-tile.js:549`).

The new traversal iterates the sequence **from last to first** to give
the primary (front) surface first rendering priority. This is a
deliberate choice: iterating in the natural array direction would give
priority to the back surface, which is wrong. The rest of this document
uses "front surface" to mean the primary surface at the last index of
`surfaceSequence`, and "back surface" for surfaces at lower indices.
Depth testing still operates within each individual surface's own
geometry; the mask handles ordering between surfaces at the same node.

If a higher-priority active surface is watertight at this tile
position, it claims the entire UV area for this node and its subtree.
All lower-priority surfaces are deactivated for descendants of this
node: they do not fetch metatiles, request meshes or textures, or draw
inside the covered subtree. This is not a separate watertight state; it
is the same active-surface propagation used for culling and natural-leaf
termination. See §4.0 for how watertight status is encoded.

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

Render-readiness checks happen on backtrack, after child recursion has
returned and immediately before the traversal decides whether the tile
will draw. Nodes not selected for natural-leaf rendering or fallback
rendering do not call `rig.isReady()`.

Natural leaves call `rig.isReady()` with
`{ minimum: 'fallback', desired: 'full' }`: fallback-level resources are
enough to draw something, but optional resources may be requested for
the final leaf tile. Fallback tiles call `rig.isReady()` with
`{ minimum: 'fallback', desired: 'fallback' }`: coarse fallback should
not request optional resources that would compete with natural-leaf
loads.

If child results prove that this node is already covered by a
watertight subtree from the same or a higher-priority surface, the
parent fallback will not render and no readiness check is made for it.

The resource priority follows the current draw path as the initial
rule: metatile checks use LOD as priority, and mesh/texture readiness
uses an inverse priority derived from LOD and distance. The exact
formula may be adjusted during implementation if diagnostics show a
better queueing signal.

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

## 4. Mask technology

The algorithm requires a mask that encodes which regions have been
covered by finer tiles. The implementation uses the geographic mask.
The screen-space mask remains a documented fallback design, but it is
out of scope for this milestone.

- **Geographic mask (§4.2, accepted design):** a UV-space texture
  rasterized from the mesh geometry. Camera-independent; prone to
  cracks at tile boundaries, mitigated by mask erosion.
- **Screen-space mask (§4.1, deferred alternative):** a single
  screen-resolution texture, written as a side effect of rendering.
  Crack-free by construction; camera-dependent.

Before describing either, §4.0 covers watertight tiles — a property
that both approaches can exploit to skip rendering and data requests
for back surfaces, and that the geographic approach additionally uses
to eliminate its footprint pass for the majority of tiles.

### 4.0 Watertight tiles

A tile is watertight if its mesh fully covers the geographic cell
allocated to the tile by the spatial division. Boundary edges are not
enough: a tile can have covered edges and still contain interior holes.
The v5 SDS horizontal extents (`llX, llY, urX, urY`) record the
geographic coverage of valid DEM samples, not full-cell coverage, and
cannot substitute.

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

### 4.1 Screen-space mask (deferred alternative)

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

### 4.2 Geographic (UV-space) mask (accepted design)

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

**Mask texture pool:** one R8 texture per active recursion depth level,
plus one R8 scratch texture reused across footprint draws. The texture
resolution is a configurable power of two. The default is 256×256; with
16 active levels that is about 1 MB total.

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

**Deferred mitigation — eroded mask:** shrink incomplete covered regions
before another tile or surface samples them. The first implementation
sets `k = 0`, so no erosion occurs. The architecture reserves a place
for erosion, but the base traversal and watertight optimization must be
validated before erosion is implemented or tuned.

Erosion must preserve tile-edge coverage. If erosion blindly shrinks
every OR or child blit, it destroys watertight seams between children
of the same surface and lets coarser tiles or lower-priority surfaces
show through. When erosion is implemented:

- OR-into-node-mask erosion must leave pixels within `k` texels of the
  tile edge unchanged.
- Child-to-parent composition must first OR the accumulated child masks
  into the parent mask, then erode the combined parent mask with the
  same edge protection.

With those constraints, erosion only opens a narrow overlap zone around
incomplete interior coverage, which is the crack case it is meant to
cover. Depth testing resolves the overlap in that zone.

**Deferred erosion implementation:** use a morphological min-filter of
radius k texels on the source mask before writing into the destination.
For each destination texel, sample a (2k+1)² neighborhood of the source
and output the minimum. This shrinks covered regions by k texels in the
destination texture's coordinate space. With `k = 0`, the operation is
the identity and the shader reduces to a single texture sample.

The deferred shader must implement the edge-preservation rules above.
Samples outside the source mask or outside the child quadrant are
treated as uncovered only for interior erosion. Pixels within `k`
texels of the destination tile edge keep the un-eroded value, so the
operation does not create cracks along tile boundaries. For
child-to-parent composition, erosion runs after the parent has ORed the
child masks into the parent mask.

At coarser LODs the same k texels represent a larger geographic width.
That growth is useful only after child masks are combined in the parent;
per-child erosion would break watertight seams between siblings.

**Summary of tradeoffs:**

- Advantage: camera-independent correctness; no incorrect blocking at
  any LOD difference. Watertight optimization eliminates most footprint
  passes and most lower-surface data requests.
- Risk: cracks at tile boundaries. The first implementation tests this
  with `k = 0`; edge-preserving erosion is deferred.
- Complexity: footprint program, OR/blit program, mask texture pool —
  more infrastructure than screen-space.

### 4.3 Decision: geographic mask

**Accepted design: geographic (UV-space) mask.**

The mask is in tile UV space, bounded to each tile's geographic extent.
It is camera-independent: the same mask is valid for any camera
position, and cross-branch screen-space overlaps between geographically
separate tiles are handled by the depth buffer, not the mask. The
watertight fast path is trivially implementable: clear the mask FBO to
1.0 and skip the footprint draw entirely. For most interior tiles this
eliminates the footprint pass. §2 describes the traversal in terms of
this design; no rewrite of the traversal algorithm is required.

The crack problem is the accepted risk. The first implementation tests
the geographic mask with erosion disabled (`k = 0`). If visible cracks
remain after the base traversal and watertight path are correct, add
the edge-preserving erosion described in §4.2 as a separate step. The
prior artifact with `drawSurfaceWithSpliting` was caused by the
one-level binary `splitMask`; the geographic mask keeps the same
coverage model across fallback LODs and surface stacking.

**Screen-space mask: deferred alternative.**

The screen-space approach is documented in §4.1. It remains useful
context, but it is outside this implementation milestone. Two design
questions identified in review — the correctness of a frame-global
binary mask under arbitrary traversal order (comment 2, round 2), and
the depth buffer lifecycle when each tile draw blits to the canvas
(comment 3, round 2) — do not have clean closed-form solutions for the
general case and are deferred with the screen-space design.

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

These backend changes belong to the server phase of the rollout, not
to the first client implementation phase. The client is implemented and
validated first against existing v5 metatiles, where every tile is
treated as non-watertight. That exercises the non-optimized traversal
path. After that path is stable, update cartolina-tileserver and
vts-vtsd, deploy them in the local test environment, and validate the
watertight optimized path against v6 metatiles. Production rollout uses
the same order: client first, server later.

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

### 5.1 Per-surface mask sequence (geographic)

The geographic mask uses one R8 `node_mask` texture per active
recursion depth level and one R8 `scratch` texture reused across
footprint draws. The mask resolution is a configurable power of two;
256×256 is the default. The pool size is derived from the maximum
traversal depth for the loaded data, with 16 levels sufficient for
current DTM surfaces.

**Node mask lifecycle.** `node_mask[depth]` is cleared to 0 at node
entry, before any surface or child is processed. The node accumulates
surface footprints via the OR step and child blits as recursion
returns. On backtrack, the completed `node_mask[depth]` is blitted
into the parent's `node_mask[depth-1]` at the child's quadrant. After
the blit, `node_mask[depth]` is dead and will be cleared again when
the next sibling at the same depth enters. There is one additional R8
`scratch` texture at the same resolution, reused across all footprint
draws.

The same texture cannot be simultaneously attached as an FBO attachment
and bound as a sampler. The per-surface sequence makes ownership
explicit.

For each surface S at a node, in front-to-back order:

1. **Screen draw.** Bind `node_mask[depth]` as a sampler. Draw S in
   screen space. The fragment shader samples `node_mask[depth]` at
   the fragment's UV coordinate (`aTexCoords2`) and discards if the
   value exceeds 0.5. Unbind `node_mask[depth]` sampler.

   For a watertight surface: perform this draw against the current
   (prior-coverage) mask, then clear `node_mask[depth]` to 1.0 and
   skip all remaining surfaces at this node.

2. **Footprint pass.** Clear `scratch` to 0. Bind `scratch` FBO.
   Draw S with UV coordinates as clip position
   (`aTexCoords2 * 2.0 - 1.0`). The fragment shader writes 1.0 to
   `scratch` at every rasterized UV position.
   Unbind `scratch` FBO.

3. **OR into node mask.** Bind `node_mask[depth]` FBO. Enable blending
   with `gl.blendEquation(gl.MAX)` and `gl.blendFunc(gl.ONE, gl.ONE)`.
   Draw a full-screen quad sampling `scratch`. The first implementation
   uses `k = 0`, so the shader writes `scratch` unchanged and blending
   writes `max(existing, scratch)` per texel.
   Unbind `node_mask[depth]` FBO. Disable blending.

Total per surface: 1 screen draw + 1 footprint draw + 1 OR pass =
3 draw calls. A watertight surface: 1 screen draw + 1 FBO clear, and
all remaining surfaces at this node are skipped.

**Child-to-parent blit (backtrack, §2.3).** The same OR/blit program
blits `node_mask[depth]` into the parent's `node_mask[depth-1]` at the
child's quadrant position. The first implementation uses `k = 0`. If
erosion is added later, child masks must be combined in the parent
before edge-preserving erosion is applied (§4.2).

The mask pass needs a no-projection framebuffer target: the footprint
shader writes clip coordinates directly from tile UVs and does not use
the camera projection. Add an explicit texture-space/no-projection
`GpuDevice.RenderTarget` kind and bind it through
`GpuDevice.setRenderTarget()`. Do not bind FBOs outside the render-
target mechanism. Do not use `setAuxiliaryRenderTarget()` unless its
semantics are generalized so it no longer implies sharing the canvas
projection. The pool is allocated once at init.

`src/core/renderer/textureblend.ts` is an existing texture-space pass
that predates this render-target policy and binds raw FBOs directly.
Migrating it to the same texture-space `RenderTarget` kind is out of
scope for this RFC, but it is the closest existing example of the pass
class the mask pipeline needs.

### 5.2 Framebuffer ordering guarantee

Within a single WebGL2 context, a draw call that writes to texture T
via an FBO is complete before a subsequent draw call that samples T
as a uniform sampler, provided that T is not simultaneously attached
as both FBO attachment and sampler. This is a WebGL2 correctness
guarantee, not a race condition. The per-surface sequence in §5.1
respects this rule at two points.

For the OR-to-next-screen-draw step (previous surface's OR must be
complete before the next surface's screen draw reads the mask):

1. OR pass: bind `node_mask[depth]` FBO → write → unbind.
2. Screen draw (next surface): bind `node_mask[depth]` as sampler →
   draw mesh.

For the footprint-to-OR step:

1. Footprint pass: bind `scratch` FBO → write → unbind.
2. OR pass: bind `scratch` as sampler → draw full-screen quad.

Each unbind is a one-line call, not a synchronization primitive.

### 5.3 Render target lifecycle during traversal

The traversal interleaves three render targets: the screen render
target (the existing color + depth FBO used by the current renderer),
the `node_mask[depth]` FBO (footprint OR and screen draw mask), and
the `scratch` FBO (footprint pass output).

The screen render target is unchanged from the current renderer:
color, depth, and stencil live on the same target as before. No
offscreen blit to the canvas is introduced. Depth testing across
separately drawn tiles works exactly as it does today.

The mask FBOs are entirely separate from the screen render target.
Switching between them requires binding no-projection framebuffer
targets and restoring the screen render target before the screen draw.
No camera projection update is part of the mask pass.

The recursive structure is safe: a child's draw calls complete before
the parent renders. By the time the parent renders, all child coverage
has been blitted into `node_mask[parent_depth]` via the
child-to-parent blit (§2.3), and the current node's mask correctly
reflects child coverage.

### 5.5 `TileRenderRig` changes

`TileRenderRig` currently does not support mask-aware rendering. The
following changes are required:

**Mask-aware draw method:**

```ts
draw(cameraPos: vec3, maskTexture?: GpuTexture): void
```

The existing `draw(cameraPos)` method gains an optional `maskTexture`
parameter.
When present, the tile shader samples `maskTexture` at the fragment's
UV coordinate (`aTexCoords2`) and discards if the value exceeds 0.5.
When absent, no mask discard occurs (existing behavior).

The current `uClip` / `splitMask` mechanism is replaced by this mask
texture input. The `splitMask` field on `MapSurfaceTile` is removed.

**Footprint method:**

```ts
footprint(maskTexture: GpuTexture): void
```

A new method renders the tile mesh into a UV-space R8 texture with a
framebuffer. A no-projection framebuffer target binds that texture as
the active draw target. The vertex shader uses
`aTexCoords2 * 2.0 - 1.0` as the clip-space position; the fragment
shader outputs 1.0. Called once per non-watertight surface in the
footprint pass (step 2 of §5.1).

**Depth program:**

The rig already has `isDepthReady()` and `drawDepth(cameraPos)`, backed
by `Renderer.programTileDepth()`. The depth program prerequisite from
the original RFC text is implemented.

### 5.6 Tile shader changes

The legacy tile shader in `src/core/renderer/gpu/shaders.js` uses
`vClipCoord` and `uClip[4]` or `uClip[8]` to discard fragments by
quadrant. The current `TileRenderRig` shader path also still carries
the one-level clipping concept through `tile-clip.inc.glsl`,
`splitMask`, and the `uClip[4]` uniform. This mechanism is one level
deep and binary per quadrant.

The new tile shader in the rig's program (`TileRenderRig`) replaces
this with a UV-space mask read:

```glsl
uniform sampler2D uMask;      // R8 geographic mask
uniform bool      uMaskEnabled;

// in fragment shader:
if (uMaskEnabled) {
    float covered = texture(uMask, vTexCoords2).r;
    if (covered > 0.5) discard;
}
```

`vTexCoords2` is the interpolated `aTexCoords2` passed from the vertex
shader. No `gl_FragCoord` or resolution uniform is needed.

The footprint program is a separate shader pair used only in the
footprint pass:

```glsl
// vertex
in vec2 aTexCoords2;
void main() {
    gl_Position = vec4(aTexCoords2 * 2.0 - 1.0, 0.0, 1.0);
}

// fragment
out float fragCoverage;
void main() { fragCoverage = 1.0; }
```

The OR/blit program is a full-screen quad. It uses
`gl.blendEquation(gl.MAX)` with `gl.blendFunc(gl.ONE, gl.ONE)`:
blending writes `max(existing, scratch)` per texel without the shader
reading the current FBO value, which WebGL2 does not permit. The first
implementation has no erosion:

```glsl
// fragment
uniform sampler2D uScratch;
in  vec2 vUV;
out float fragCoverage;
void main() {
    fragCoverage = texture(uScratch, vUV).r;
}
```

If erosion is later implemented, it is added around this program as the
edge-preserving operation defined in §4.2, not as a per-child blind
min-filter.

---

## 6. Performance analysis

### 6.1 Draw call count

For a typical scene with N visible tiles at the fit LOD, single
surface. Let W be the fraction of tiles that are watertight (close
to 1 for interior tiles of a well-formed surface).

- **Current fitonly:** N draw calls.
- **New traversal, fitonly mode (cadence = ∞), watertight tiles:**
  W×N FBO clears + W×N screen draws. FBO clears are not draw calls;
  effective draw call count ≈ W×N.
- **New traversal, fitonly mode, non-watertight boundary tiles:**
  (1-W)×N footprint draws + (1-W)×N OR passes +
  (1-W)×N screen draws = 3(1-W)×N draw calls.
- **Combined:** approximately N + 2(1-W)×N draw calls. For mostly
  watertight data (W ≈ 0.9) this is ≈ 1.2N. Screen-space pays
  2N regardless of watertight status.
- **Fallback cadence 3:** approximately N/8 additional inner-node
  tiles render, with the same watertight split applied.
- **Child-to-parent blits:** 1 quad draw per child rendered. For a
  subtree of depth D with K leaves, at most 4K blit calls. Each is
  a small quad draw with a fixed scale-translate; no vertex
  computation beyond UV mapping.

For multi-surface scenes: back surfaces blocked by a watertight front
surface cost 0 draw calls. Back surfaces at boundary tiles pay the
same 3-call sequence as above.

### 6.2 Mask texture bandwidth

One R8 `scratch` texture plus one R8 `node_mask` texture per active
depth level are allocated at the configured mask resolution. At the
default 256×256 resolution and 16 active levels, this is
17 × 64 KB = ~1 MB total. This is substantially less than
screen-resolution alternatives. Each node mask is written once per
footprint OR pass and read once per screen draw at that depth level.
Blit draws are 64 KB quad draws at most at the default resolution.

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
| `drawSurfaceFit` (fit) | terrain: fallback cadence < ∞; geodata keeps fitted-frontier traversal until replaced |
| `drawSurfaceFitOnly` (fitonly) | fallback cadence = ∞ |
| `drawSurfaceDownTop` (downtop) | fallback cadence < ∞ |
| `processBuffer`, `newProcessBuffer` arrays | JS call stack |
| `drawBuffer`, `processDrawBuffer` | direct `rig.draw()` call |
| `tile.splitMask` field | mask texture uniform |
| `uClip` / `splitMask` clipping | `uMask` sampler in rig shader |
| `mapLoadMode` config value | `mapFallbackLodCadence` integer |
| `mapGeodataLoadMode` config value | removed; geodata always uses fitted-frontier traversal until replaced |
| `mapSplitMeshes` config flag | always-on in new traversal |

`drawSurfaceFit` currently serves two callers. Terrain reaches it
through `mapLoadMode = 'fit'`; geodata reaches it through
`mapGeodataLoadMode = 'fit'`, selected in `MapSurfaceTree.draw()` when
`freeLayerSurface.geodata` is true. The new design removes
`mapGeodataLoadMode` rather than preserving a one-value mode switch.
The terrain replacement may stop terrain from using `drawSurfaceFit`,
but the method or an equivalent fixed geodata fitted-frontier traversal
must remain until the geodata replacement exists.

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

Virtual surfaces are not plain renderable surfaces. Their metatiles
carry `sourceReference` fields that redirect tile fetches to
constituent surfaces. Treating a virtual surface metatile as a plain
surface would skip that redirect, removing the resource lookup that
makes the legacy map render.

The new traversal does not use the virtual-surface replacement. During
mapConfig loading, if a `mapConfig.virtualSurfaces` entry matches the
active surface set, the new path keeps the real constituent surfaces
available for traversal and emits a one-off warning. In the current
code this means bypassing the `generateSurfaceSequence` collapse that
replaces the full surface list with one `MapVirtualSurface` entry. The
new traversal then filters to plain surfaces and ignores glues and
virtual surfaces.

The legacy path can keep using `MapVirtualSurface` while both paths
coexist. Once the old traversal is removed, the virtual-surface
collapse and `sourceReference` rendering path can be deleted with the
rest of the glue machinery.

### Code expected to shrink substantially

- `src/core/map/surface-tree.js` — terrain rendering stops using the
  five draw methods and both draw buffers. Geodata keeps only the
  fitted-frontier traversal until it has a dedicated replacement. The
  file retains utility traversals (height tracing, area tiles,
  `findSurfaceTile`). Non-geodata free-layer traversal is removed.
- `src/core/map/surface-tile.js` — loses `splitMask`, `drawGrid`
  fallback path, `createVirtualMetanode`, alien flag handling.
- `src/core/map/draw-tiles.js` — `drawSurfaceTile` orchestration
  becomes simpler; no more `preventRender` / `preventLoad` mode
  variations in the traversal hot path.
- `src/core/renderer/gpu/shaders.js` — legacy `uClip` /
  `vClipCoord` logic and split shader variants are removed.
- `src/core/renderer/shaders/includes/tile-clip.inc.glsl` and the
  `TileRenderRig` `uClip` bindings are removed once mask sampling
  replaces quadrant clipping in the modern shader path.

---

## 8. Compatibility and rollout

The old traversal and new traversal coexist only as a validation
scaffold. The motivation is to compare the new recursive path against
the current terrain renderer on the same branch, keep screenshot
regression checks meaningful, and keep a local fallback while the new
path is being brought up.

Execution: implement the recursive terrain traversal in TypeScript,
outside the legacy `MapSurfaceTree` JavaScript module. The preferred
shape is a private method on the typed `Map`, because terrain traversal
is core frame orchestration. If implementation state grows enough to
make that method unwieldy, extract a focused auxiliary TypeScript class
in `src/core/map/` owned by `Map`. During validation, `Map.draw()` uses
a terrain-only dispatch switch in two layers: a per-frame runtime
override on `Map.overrides.terrainTraversal` (`'recursive' | 'legacy'
| undefined`) and a session-level `mapTerrainTraversal` key on
`CoreConfig` (URL-configurable). The override wins when set; otherwise
the config value is used; the default is `'recursive'`. When the
resolved mode is `'recursive'`, terrain calls the TypeScript recursive
traversal with the legacy tree as its data source; otherwise terrain
continues through `legacyMap.tree.draw()` and the existing
`mapLoadMode` / `drawSurface*` methods. Geodata free layers do not
use this switch. After validation, the switch and old terrain modes
are removed.

`TileRenderRig` is the terrain tile drawing backend used by the new
traversal, not the gate that selects the traversal.
Geodata free layers keep calling the fitted-frontier traversal directly
until the dedicated geodata path exists. `mapGeodataLoadMode` is removed
because fitted-frontier traversal is the only retained geodata behavior.
Non-geodata free layers are ignored with a one-off console warning; they
are not routed through the terrain traversal as one-surface sequences.

Implementation phases:

1. **Implemented, concept proof and validation scaffold.**
   Bring up the mask machinery end to end against the legacy surface
   selection so the design's core claims can be validated on real
   data before the combined descent lands. The driver walks the
   legacy `MapSurfaceTile` tree and uses `tile.metanode` at each
   position; it does not yet implement the combined descent of §2.1.
   This phase exercises mask compositing on the fallback-LOD axis
   only, not the surface-stacking axis.

   - add configurable mask resources: one R8 `node_mask` texture per
     active recursion depth, one R8 `scratch` texture, and no-projection
     framebuffer target binding. Default resolution is 256×256;
   - implement the footprint program and non-eroding OR/blit program
     (§5.6), with `k = 0`;
   - add `footprint()` and mask-aware `draw()` to `TileRenderRig`
     (§5.5), sampling the mask at `aTexCoords2`;
   - implement the recursive driver as a private method on the typed
     `Map` (`Map.drawTerrainRecursive_`), targeting the default
     terrain path (`drawSurface`). The descent body lives in
     `src/core/map/draw-traversal.ts`; the mask pool is owned by the
     typed `Map`. Dispatch is the override + config resolution
     described above.

   Manual checkpoint completed for the dev side of `simple-terrain`,
   `complex-terrain`, and `full-terrain` on a fresh webpack server.
   Production comparison requests had transient upstream tile failures.

   Validated by this phase:

   - **§4.2** — UV-space masks are precise enough on real terrain at
     `k = 0`. Seam cracks appear as expected for the accepted `k = 0`
     design choice; their visibility matches the prediction in §4.2
     and does not indicate a mask precision problem.
   - **§4.2** — mask compositing reduces fragment overdraw. The
     legacy topdown path draws every visible ancestor; the mask
     turns this into "fill the gaps only," a measurable GPU win on
     the single-surface case.
   - **§2.4** — the natural-leaf / fallback readiness split
     de-pollutes the loader queue. Coarse stand-in tiles call
     `isReady` with `desired: 'fallback'` so they no longer pull
     optional resources that would slow leaf loads. Visible as
     consistently lower data transfers and faster tile loading than
     the legacy path on complex terrain.
   - **Phase tradeoff** — without the watertight fast path (phase
     6) the mask pass issues one footprint draw and one blit per
     tile per recursion depth. This produces more FBO switches and
     draw calls than the legacy path, which is visible as lower FPS
     and slightly reduced map responsiveness. The tradeoff is
     expected and resolves in phase 6.

2. Combined descent over plain surfaces.

   Replace the single-surface driver with the §2.1 algorithm: query
   each active plain surface's metatile tree independently via
   `getMetatile()` + `getNode()` at each `(lod, x, y)` position,
   compute child active sets per quadrant, propagate active status
   into recursion, and iterate the surface sequence front-to-back at
   the leaf and fallback render steps. Still no watertight metadata;
   v5 metatiles only.

   Manual checkpoint: a single-surface map renders identically to
   phase 1; a two-plain-surface map, or a virtual-surface map
   rerouted to its constituent plain surfaces per §7, renders the
   seam through mask compositing rather than glues, and no visible
   regressions appear under progressive load.

3. Extend fallback cadence.

   Add the `mapFallbackLodCadence` integer config (§2.4). Combined
   descent already distinguishes natural-leaf and fallback rendering,
   so cadence wiring is the gating decision on step 5 only.

   Manual checkpoint: cadence 1 reproduces topdown behavior; cadence
   ∞ reproduces fitonly; cadence 3–5 shows progressive loading where
   coarser fallback tiles appear first and are then replaced by finer
   tiles. Confirm that fallback readiness uses `desired: 'fallback'`
   and does not starve natural-leaf loads.

4. Client v6 metatile parsing.

   In `src/core/map/metatile.js`, raise the supported version cap
   from 5 to 6 and extend `applyMetatanodeBitplanes` to read bitplane
   1 as `metanode.watertight`. For v5 metatiles `metanode.watertight`
   stays false. The traversal does not yet consult the flag; this
   phase is a parser capability bump, sized so a v6-emitting server
   does not break v5 clients in the field.

   Manual checkpoint: every existing test URL still renders against
   the unchanged v5 servers; where a v6 fixture exists, the bitplane
   is parsed without throwing and the flag is set on the expected
   nodes.

5. Server v6 metatile emission.

   Apply the `vts-libs` and mapproxy changes in §4.5: bump VERSION
   from 5 to 6, add `watertightPlane = 0x02` to `MetaTileFlag`,
   extend `flagPlanes` and `flagMapping`, add
   `MetaNode::Flag::watertight` with accessor and setter, patch
   `ti2metaFlags()`. Apply the same vts-libs changes to vts-vtsd's
   vendored copy in lockstep. Deploy to the local test environment.

   Manual checkpoint: a regenerated v6 dataset loads in the phase-4
   client without traversal changes; nodes from watertight source
   data carry `metanode.watertight = true`; nodes from partial source
   data carry `false`.

6. Watertight fast path.

   Wire `metanode.watertight` into the active-set logic from phase 2.
   A watertight active surface at a node performs its normal screen
   draw, then clears the node mask to 1.0 and deactivates
   lower-priority surfaces for the subtree, including their metatile
   fetches (§2.2, §4.2 round-8 update).

   Manual checkpoint: a multi-surface map whose front surface is
   watertight on most interior tiles shows the expected reduction in
   draw calls and lower-surface mesh requests, with no visible
   artefacts at boundary tiles where partial coverage falls back to
   depth testing.

7. Edge-preserving erosion.

   Consider erosion only after the combined descent and watertight
   fast path are correct. Keep `k = 0` unless visible cracks require
   the deferred erosion step in §4.2.

   Manual checkpoint: tune against real multi-surface data only if
   this step is implemented; verify that watertight seams between
   same-surface siblings are preserved.

8. Delete the legacy terrain traversal.

   Remove the five legacy methods (`drawSurface`,
   `drawSurfaceWithSpliting`, `drawSurfaceFit`, `drawSurfaceFitOnly`,
   `drawSurfaceDownTop`), the `mapLoadMode` and `mapGeodataLoadMode`
   config keys, the `splitMask` and `uClip` plumbing,
   `createVirtualMetanode`, and the alien-flag path. Wait until the
   geodata caller keeps a fitted-frontier traversal of its own, or
   moves to a dedicated geodata replacement. Do not retain the old
   topdown, downtop, splitting, or fitonly modes only for geodata.

---

## 9. Verification and deferred work

**Mask texture resolution:** 256×256 is the default. The value is a
configurable power of two and should be profiled after the base
implementation works.

**Erosion margin:** the first implementation uses `k = 0`. If cracks
remain visible, implement the edge-preserving erosion described in
§4.2 and tune it against real multi-surface data.

**Watertight bitplane field verification:** during the server phase,
verify that `TileIndex::Flag::watertight` is correctly set for all
surface types served by cartolina-tileserver, including spheroid
surfaces and any path not covered by the DEM-based
`metatileFromDemImpl`.

**Per-surface mask pool (deferred).** The current design uses one
`node_mask[depth]` that combines coverage from all surfaces. This
produces a priority inversion in two related cases.

The first is a steady-state geometry case: at a dataset boundary seam
tile, a back surface may have finer LOD children than the front surface
(because the front surface's data ends at that boundary). The back
surface's fine child coverage enters the combined mask and can block
the front surface's coarser fallback render. The design assumes that
coarser LODs do not contain finer data, even across different surfaces,
so LOD is a valid ordering relation. Data that violates this is a data
modeling problem rather than a traversal problem.

The second case is resource readiness during progressive loading. A
front surface can have finer children in the metatile tree but fail to
render them because metatile, mesh, texture, or `TileRenderRig`
readiness has not arrived. A lower-priority back child can be ready
first, write the combined mask, and temporarily block the front
parent's fallback. This can occur inside the front surface's interior,
not only at dataset edges. It is transient — once the front surface's
finer tiles load, they render normally — but it means lower-priority
data may briefly appear where higher-priority data is still pending.

Both cases share the same root cause and the same fix. Replace
`node_mask[depth]` with per-surface `surface_mask[i][depth]` textures
plus a per-node `claimed_mask[depth]` that accumulates front-to-back.
Each surface samples its own `surface_mask[i]` (finer descendants) and
`claimed_mask` (higher-priority coverage) independently. Pool grows to
16 × (N + 1) + 1 textures; blit calls per inner node multiply by N.

Implement after the single-surface path is validated. Validation should
include a progressive-loading multi-surface case and a seam case before
the legacy draw path is removed, to establish whether these effects are
visible in practice.

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

   *Implemented. §2.1 now separates natural-leaf rendering (step 4,
   unconditional) from fallback-cadence rendering (step 5, gated).
   A surface at its natural leaf — SSE passes or no children at this
   LOD — always renders on backtrack, using the child mask as input.
   This covers the case where a coarse back surface's LOD range ends
   at a node that the finer front surface's children have already
   populated: the back surface renders in the gaps the front surface
   left, without needing that node to be a fallback LOD.*

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

   *Implemented. §4.3 declares the accepted design and documents the
   other as a deferred alternative. §4.2 is geographic (accepted);
   §4.1 is screen-space (deferred). The initial round 1 response
   chose screen-space; that decision was reversed after round 2
   identified two structural design gaps in the screen-space
   approach (frame-global mask correctness and depth buffer
   lifecycle) that do not apply to geographic. §5.1 through §5.6,
   §6.1, §6.2, §8, and §9 are updated for the geographic design.*

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

## Review round 2

1. The main algorithm still describes a geographic, returned-mask model
   after the RFC changed the accepted design to screen-space.

   Sections 2.1 through 2.3 still say child calls return masks, child
   masks are ORed into a combined parent mask, the parent passes that
   combined mask into rendering, and the mask is in the tile's
   geographic UV space with child-to-parent quadrant blits. Sections 4.3
   and 5.1 now say the accepted design is a single global
   screen-space `accumulated_mask`, with no per-depth pool and no
   child-to-parent blit.

   These are different algorithms. The RFC should rewrite §2 around the
   accepted screen-space data flow or explicitly split §2 into abstract
   traversal plus mask-space-specific implementations. As written, an
   implementer cannot tell whether recursion returns a mask texture, a
   logical coverage state, or nothing because the frame-global mask has
   already been updated.

   *Resolved. Geographic is the accepted design (§4.3); §2 correctly
   describes the geographic returned-mask algorithm and requires no
   rewrite. The inconsistency was introduced by the screen-space
   pivot after round 1 and is eliminated by reverting that
   decision.*

2. The global screen-space mask can block unrelated later fragments, not
   only coarse fallback ancestors.

   Section 4.1 describes the correctness risk as a fine tile blocking a
   coarse ancestor under an oblique camera. The accepted implementation
   goes further: `accumulated_mask` persists for the whole frame and is
   sampled by every later tile and surface by `gl_FragCoord` alone. That
   means any earlier fragment at a screen pixel can discard any later
   fragment at the same pixel, even when the later fragment belongs to a
   different tile, a different branch of the tree, or a different depth
   order that normal depth testing would have resolved.

   The RFC needs a rule that bounds the mask's scope, or a proof that
   traversal order plus depth state makes a frame-global binary mask
   safe. If the intended behavior is to use the mask only for ancestor
   fallback and same-node surface composition, the texture cannot be a
   single unqualified frame-global coverage buffer without additional
   keys such as depth, subtree ownership, or a reset/scope rule.

   *Resolved by design choice. The geographic mask (§4.2) is bounded
   by each tile's UV coordinate space. Cross-branch screen-space
   overlaps between geographically separate tiles are handled by
   the existing depth buffer, not the mask. The frame-global
   correctness risk is a screen-space-specific problem; it does
   not apply to the accepted geographic design.*

3. The offscreen color/depth lifecycle is underspecified.

   Section 5.1 says each screen draw targets an offscreen FBO with color
   and `scratch_mask`, then blits the color attachment to the canvas.
   It does not define where the depth buffer lives, whether it is shared
   across all tile draws, when the offscreen color attachment is cleared,
   or whether the canvas depth buffer participates at all after color is
   blitted. The current map renderer relies on depth testing across
   separately drawn tiles. A color-only blit after each tile draw does
   not preserve that relationship unless the offscreen FBO owns the real
   frame depth buffer and the canvas is only a presentation target.

   The RFC should define the render target for the whole terrain pass:
   color attachment, depth attachment, scratch attachment, clear points,
   and final presentation. If the canvas remains the primary depth
   target, choose the two-pass `DEPTH_EQUAL` variant and specify how it
   captures coverage without changing the color/depth result.

   *Resolved by design choice. The geographic mask FBOs (footprint
   and node mask pool) are entirely separate from the screen render
   target. The screen draw uses the normal render path with its
   existing color and depth buffer unchanged. No offscreen blit
   to the canvas is introduced. Depth testing across tiles works
   exactly as it does today. See §5.3.*

4. The screen-space OR pass text describes an impossible read from the
   current accumulated FBO value before switching to blending.

   Section 5.1 says the OR shader writes `max(current, scratch)`, and
   §5.6 shows pseudo-code with a "current accumulated value read from
   FBO". A fragment shader cannot read the current value of the same
   attachment it is writing unless that texture is also sampled, which
   would violate the read/write rule stated in §5.2. The later sentence
   says the actual implementation uses `gl.blendEquation(gl.MAX)`.

   Drop the manual-read description and make blending the normative
   design. Also specify the scratch clear before each surface draw; stale
   scratch coverage would be ORed into `accumulated_mask`.

   *Fixed. §5.6 specifies `gl.blendEquation(gl.MAX)` as the normative
   OR mechanism. The pseudo-code describing a manual read from the
   current FBO attachment is removed. §5.1 specifies that `scratch`
   is cleared to 0 before each footprint pass.*

5. The watertight fast path is not implementable as written for
   screen-space.

   Sections 4.1 and 5.1 say a watertight surface can fill
   `accumulated_mask` for its screen footprint, or skip back surfaces
   before any draw call. To know the screen footprint in the accepted
   screen-space design, the renderer still has to rasterize the mesh or
   an equivalent conservative screen shape. Skipping before any draw call
   would also skip the front surface's color unless another draw path
   renders it first.

   The RFC should state that a watertight front surface still performs
   the normal screen draw for color and coverage, then suppresses later
   surfaces at the same node. If a separate footprint fill is intended,
   define the draw that produces that footprint and include it in the
   performance estimate.

   *Resolved. For the geographic mask, the watertight fast path is:
   clear `node_mask[depth]` to 1.0 (a single FBO clear, not a draw
   call), then skip all remaining surfaces at this node. The color
   screen draw still executes normally. No mesh rasterization is
   needed to establish the mask. §4.2 and §5.1 are updated
   accordingly.*

6. The rollout and open-question sections still describe the deferred
   geographic design as if it were part of the accepted implementation.

   Section 8 says to implement the footprint pass and mask blit program,
   and §6.3 still mentions footprint and blit passes. Section 9 lists
   erosion margin, 256x256 mask resolution, and UV footprint
   rasterization as open questions. Those belong to the deferred
   geographic alternative, not to the accepted screen-space design.

   Move those items under §4.2 as deferred alternative notes, and replace
   the accepted-design rollout with the screen-space work: depth-capable
   tile render FBO or `DEPTH_EQUAL` coverage pass, `accumulated_mask`,
   `scratch_mask`, MRT or second pass, OR blending, and validation cases
   for oblique overlap.

   *Resolved. With geographic as the accepted design, §9 open
   questions (erosion margin, mask resolution, UV footprint
   rasterization) are correct for the accepted path and remain
   there. A screen-space fallback threshold question is added to
   §9 to document the condition under which §4.1 would be adopted.
   §8 rollout is updated with geographic work items: mask pool
   allocation, footprint and OR/blit programs, mask-aware rig
   methods, and an erosion tuning step.*

## Review round 3

1. The per-surface mask sequence renders each surface after adding its
   own footprint to the mask.

   Section 5.1 orders the steps as footprint pass, OR into
   `node_mask[depth]`, then screen draw sampling `node_mask[depth]`.
   That means the surface samples a mask that already contains its own
   coverage and discards its own fragments. The watertight branch has
   the same problem: clearing `node_mask[depth]` to 1.0 before the screen
   draw would discard the watertight surface's color.

   The sequence needs to be: draw the surface while sampling only the
   prior coverage mask, then add the surface's footprint to the node
   mask for later surfaces and parent backtracking. For a watertight
   surface, draw it against the prior mask first, then mark the node mask
   fully covered and skip later surfaces. If the intended implementation
   uses a separate read mask and write mask, name both textures and state
   when each is swapped or copied.

   *Fixed. §5.1 step order corrected to: (1) screen draw sampling the
   prior mask, (2) footprint pass into scratch, (3) OR eroded scratch
   into node mask. The watertight branch now performs the screen draw
   first against the prior mask, then clears `node_mask[depth]` to
   1.0 and skips remaining surfaces. §5.2 updated to reflect the
   corrected ordering.*

2. The mask texture lifecycle for sibling nodes is underspecified.

   Section 5.1 says there is one `node_mask` texture per recursion depth,
   and that only the root node is cleared at frame start. With depth-first
   recursion, sibling tiles at the same LOD reuse the same depth texture.
   If `node_mask[depth]` is not cleared before each node starts, coverage
   from one sibling can be blitted into another sibling's parent quadrant
   or sampled by an unrelated node.

   The RFC should define the lifecycle precisely: clear the current
   depth texture at node entry, accumulate that node's children and
   surfaces into it, blit it into the parent before returning, then treat
   it as scratch for the next sibling at the same depth. If child masks
   must remain available after return, one texture per depth is not
   enough and the pool design needs to change.

   *Fixed. §5.1 now opens with a Node mask lifecycle paragraph: clear
   `node_mask[depth]` to 0 at node entry; accumulate surfaces and
   child blits during processing; blit into the parent on backtrack;
   the texture is then dead and will be cleared again by the next
   sibling at the same depth. One texture per depth is sufficient
   because the blit completes before the sibling clears.*

3. The erosion shader is specified in prose but absent from the normative
   shader description.

   Sections 4.2 and 5.1 say the OR/blit shader applies a morphological
   min-filter with radius `k`. Section 5.6 then defines the OR/blit
   shader as a single `texture(uScratch, vUV).r` sample, with blending
   doing only `max(existing, scratch)`. That shader does not erode the
   mask, so the accepted crack mitigation is not implemented by the
   normative shader text.

   Update §5.6 so the OR/blit shader includes the min-filter, or split
   it into two programs if erosion is only used for selected blits. The
   document should also state whether `k = 0` is allowed for debugging
   and whether the same shader samples outside the child quadrant as 0
   when eroding a child mask into a parent quadrant.

   *Fixed. §5.6 OR/blit shader updated with the full (2k+1)²
   min-filter loop. `uErosionRadius = 0` is explicitly allowed and
   reduces to a single texture sample (no erosion). UV samples
   outside `[0, 1]` return 0.0 (uncovered) via an explicit bounds
   check, ensuring correct inward erosion at tile and quadrant
   boundaries.*

4. The rollout still leaves the virtual-surface gate without an
   implementation handle.

   Section 7 names `vsurfaceCount` inside `generateSurfaceSequence` as
   the gate, but that value is currently local to the function. The RFC
   should say where the result is stored for the draw traversal to read,
   for example a `tree.usesVirtualSurfaces` boolean or equivalent. This
   is small, but without it the rollout rule is not actionable from
   `MapSurfaceTree`.

   *Fixed. §7 now specifies that `generateSurfaceSequence` stores
   the result as `hasVirtualSurfaces: boolean` on the `SurfaceSequence`
   object it returns. The new traversal reads
   `surfaceSequence.hasVirtualSurfaces` at its entry point.*

## Review round 4

1. The combined child mask can make lower-priority child coverage block
   higher-priority parent fallback coverage.

   Section 2.1 descends into children first, ORs all returned child masks
   into one combined mask, then renders natural leaves and fallback LODs
   against that combined mask. A child mask represents coverage from all
   surfaces rendered in that child subtree, including back surfaces that
   filled gaps left by front surfaces. When a front surface later renders
   at the parent as fallback coverage, it samples the combined mask and
   discards pixels already claimed by those back child surfaces.

   That violates the surface priority rule in §2.2. A front surface's
   fallback tile is still front-surface coverage. It should be blocked by
   finer front coverage, and by higher-priority surfaces if any exist,
   but not by lower-priority back surfaces that happened to render in a
   child before the parent fallback ran. The watertight parent case has
   the same failure: the parent front surface draws against a mask that
   can already include back-surface child coverage, so it cannot repaint
   those pixels before marking the node mask fully covered.

   The root cause is that "coverage already claimed" is not one
   category once LOD fallback and surface priority interact. At least
   four meanings are being collapsed into the same binary mask:
   coverage from higher-priority surfaces, coverage from the same
   surface at finer LOD, coverage from lower-priority surfaces, and
   coverage used only to keep fallback ancestors from overdrawing their
   descendants. Those categories do not have the same blocking rules.

   A useful way to name the split is:

   - `surface_mask`: temporary coverage produced by one surface's
     traversal. It answers "what did this surface cover in this tile
     subtree, including finer children and fallback ancestors?"
   - `claimed_mask`: persistent front-to-back coverage already claimed
     by higher-priority surfaces. It answers "what must this surface
     not draw over?"

   A surface should draw against `claimed_mask` plus its own finer
   `surface_mask`, then add its new coverage to `surface_mask`. After
   that surface's priority level is complete, its `surface_mask` becomes
   part of `claimed_mask` for lower-priority surfaces. The current RFC
   has one `node_mask` doing both jobs at once, so lower-priority
   coverage can enter the mask before a higher-priority fallback has
   finished claiming its own region.

   One possible direction is to render surface trees independently,
   front to back. That gives a simple time-order invariant: a back
   surface can only see masks created by surfaces in front of it. The
   cost is that the inter-surface "claimed" state is not a single
   texture. In a geographic-mask design, claimed coverage is per tile
   node, because each mask is defined in that node's UV space. A
   high-level per-surface traversal would therefore need a per-frame
   mask tree keyed by tile id, or an equivalent mechanism to carry
   claimed coverage between independent surface passes at matching,
   finer, and coarser nodes. In this design, `surface_mask` is local to
   the current surface traversal, while `claimed_mask[lod,x,y]` must
   persist for all visible nodes until lower-priority surfaces have
   consumed it. That is substantial bookkeeping.

   A more local alternative is to keep the single tile-position
   traversal but make the masks priority-aware. The key invariant would
   be: a surface may sample only coverage from higher-priority surfaces
   plus its own finer descendants; it must not sample coverage from
   lower-priority surfaces. This could be expressed as per-surface
   coverage masks, prefix masks (`coverageBeforeSurface[i]`), or child
   recursion returning separate coverage classes rather than one
   combined mask. In this design, the per-depth mask stack would carry
   `surface_mask[i]` values and construct `claimed_mask` or prefix masks
   inside the node traversal. Because surface stacks are small, this may
   be cheaper than maintaining a persistent claimed-mask tree outside
   the traversal.

   The RFC should choose between these approaches, or define another
   mechanism with the same invariant. The accepted design must state
   which coverage blocks each surface at natural-leaf and fallback
   render time, how that coverage is propagated from children to
   parents, when `surface_mask` is merged into `claimed_mask`, and why
   lower-priority coverage cannot block a higher-priority fallback tile.

   *Acknowledged as a known limitation. The reviewer's analysis of
   the priority inversion is technically correct. This response
   explains the precondition required for the bug to manifest, why
   that precondition is unlikely in the target use case, what the
   correct fix would cost, and why the fix is deferred.*

   *Precondition for the bug.* The priority inversion fires only when
   a back surface (B) renders at a finer LOD than the front surface
   (A) at the same geographic tile position. Concretely: at some node
   (lod, x, y), B has a child tile at lod+1 that A does not, so B's
   child renders at the finer LOD and writes into the combined child
   mask. When A then renders as a fallback at lod, it samples that
   mask and finds B's child coverage blocking it.

   *Why this is unlikely in practice.* The reason a surface is placed
   front (higher priority) is that it has higher-quality data for the
   region it covers. Higher quality almost always means finer LOD
   tiles: a 1 arc-second DEM renders to LOD 14–15, a 3 arc-second
   DEM to LOD 12–13. In any geographic position where A (front) has
   data, A will have finer LOD tiles than B. B's LOD saturates
   coarser than A's everywhere inside A's coverage area. The
   precondition — B having a finer child than A at the same position
   — cannot be met in that interior region.

   *The one case where it can happen.* At the edge of A's dataset,
   the seam tile. A tile cell that straddles A's coverage boundary
   may have some children inside A's dataset (where A has LOD n+1
   tiles) and some outside (where A has no LOD n+1 tile). B has LOD
   n+1 tiles everywhere. For the outside children, B renders at fine
   LOD. If lod n is a fallback LOD and A has a lod-n tile that covers
   the full cell (including the outside children), A's fallback draw
   is blocked by B's fine child coverage on the outside side.

   *Why the visual outcome is acceptable even there.* In the outside
   children — where A has no fine data — A's lod-n fallback tile
   carries only coarse data. B's lod-n+1 tiles there are drawn from
   B's own dataset at a finer sampling frequency. Showing B's finer
   data instead of A's coarser fallback in that thin strip is not a
   visual regression: B's data is more detailed, continuous across
   the boundary, and the artifact is confined to the seam tile's
   outside fringe. For elevation surfaces both representations look
   reasonable; the seam is not made worse. The priority violation is
   semantic — A should win — but the visual consequence in this
   specific geometry is defensible.

   *What the correct fix would require.* The reviewer's local
   alternative (per-surface masks inside the single traversal) is
   the tractable path. It replaces `node_mask[depth]` with two
   structures: `surface_mask[i][depth]` (this surface's own coverage,
   propagated via blits to the parent) and `claimed_mask[depth]`
   (running OR of all surfaces rendered so far at this node, used
   only to block lower-priority renders and discarded on return).
   Each surface's screen draw samples both its own `surface_mask` and
   the `claimed_mask`, discarding if either exceeds 0.5. After the
   OR pass, eroded scratch is written into both `surface_mask[i]` and
   `claimed_mask`. On backtrack, each `surface_mask[i]` is blitted to
   the parent separately; `claimed_mask` is not blitted (the parent
   reconstructs it from its own surface renders). This produces the
   correct invariant: a surface is blocked only by its own finer
   coverage and by coverage from surfaces with strictly higher
   priority; lower-priority coverage is invisible to it.

   The cost is real: the texture pool grows from 16 textures to
   16 × (N + 1) + 1 (for N surfaces and one scratch): roughly 3 MB
   for N = 2, 4 MB for N = 3. Blit calls per inner node multiply by
   N. The screen draw shader gains a second texture sample and a
   two-condition discard. The per-node lifecycle gains a second clear
   (for `claimed_mask`). The conceptual model presented to a future
   reader — already non-trivial — acquires a new distinction that
   requires careful explanation.

   *Why the fix is deferred.* The priority inversion occurs in one
   geometry: seam tiles at a dataset boundary, on the outside-of-A
   side. That is a small fraction of total rendered tiles even in a
   multi-surface configuration. The "wrong" outcome in those tiles —
   B's fine data showing instead of A's coarse fallback — is
   visually acceptable for elevation surfaces, which are the primary
   target. The fix adds complexity proportional to the surface count
   to every node in the traversal, including the single-surface path
   and all interior tiles where the bug cannot occur. That cost is
   not justified before the single-surface path is validated and real
   multi-surface data confirms the artifact is visible. The fix is
   documented here and in §9 so it can be implemented in a targeted
   pass once empirical evidence establishes that it is needed.*

## Review round 5 — sign-off

The design is accepted.

The remaining readiness-driven priority inversion is an accepted
transient loading tradeoff, not a blocker.

The round 4 response correctly identifies the steady-state geometry
needed for the priority inversion: a lower-priority back surface must
provide finer coverage than the higher-priority front surface at the
same tile position. That is unusual for the target data ordering and,
where it occurs at dataset edges, the visual result is defensible for
elevation surfaces.

There is one broader case: resource readiness. A front surface can have
finer children in the metatile tree but fail to render them because
metatile, mesh, texture, or `TileRenderRig` readiness has not arrived
yet. A lower-priority back child can be ready first, write the combined
child mask, and temporarily block the front parent fallback. This can
happen during progressive loading inside the front surface's interior.

I accept the author's conclusion that this is not worth fixing in the
first design. Resource readiness is transient, and the alternative is
the per-surface mask pool described above: more textures, more blits,
another mask concept, an extra shader sample, and more traversal
bookkeeping on every node. That cost would be paid in the common case
to eliminate a temporary loading imperfection.

The combined geographic mask keeps the traversal smaller and keeps the
first implementation focused. A per-surface mask pool would give
stricter priority semantics, but it would add texture state, additional
blits, another mask concept, and extra shader work across the traversal.
That cost is not justified before the simpler design is validated
against real multi-surface data.

During progressive loading, lower-priority ready data may temporarily
appear where higher-priority data is still pending. At dataset seams, a
lower-priority finer tile may also beat a higher-priority coarse
fallback in a narrow fringe. These are acceptable if they are transient
or visually unobtrusive for elevation surfaces. The validation work
should include a progressive-loading multi-surface case and a seam case
before the legacy draw path is removed.

## Review round 6 — requested

The accepted design now states that geodata rendering is out of scope.
The previous text treated `MapSurfaceTree.draw()` as if every caller
could move to the mask-based terrain traversal. That is false for
geodata free layers: they use the tree to select fitted tiles, load
geodata resources, and collect label/icon jobs into `renderer.jobZBuffer`.

The review text now distinguishes the five legacy terrain traversal
methods from the single geodata behavior that must remain. Terrain
rendering still replaces `drawSurface`, `drawSurfaceWithSpliting`,
`drawSurfaceFit`, `drawSurfaceFitOnly`, and `drawSurfaceDownTop`.
Geodata keeps only fitted-frontier traversal: select fitted tiles,
collect jobs there, and use parent fallback while fitted tiles load.

The rollout section now says the old terrain traversal methods can be
deleted after geodata keeps a fitted-frontier traversal or moves to a
geodata-specific replacement. The mask-compositing traversal remains a
terrain `TileRenderRig` design.

This review also verified the RFC against the current codebase. The
problem statement now includes `drawSurfaceDownTop`; the rollout no
longer lists the completed `TileRenderRig` depth program as future work;
and the proposed `TileRenderRig` signatures now match the current
`draw(cameraPos)` and `GpuDevice` render-target model.

## Review round 6

1. The geodata traversal path is not identified in the RFC, and
   `mapGeodataLoadMode` is absent from the removal table.

   The §1 out-of-scope section gives the correct behavioral description
   for geodata (fitted-frontier, `texelSize` threshold, job collection
   via `MapGeodataView.draw()`), and §8 step 8 correctly gates deletion
   of the terrain methods on a geodata replacement. Neither section names
   the current dispatch path or the config key that drives it.

   In `MapSurfaceTree.draw()` (`surface-tree.js:162`), the geodata
   caller is distinguished from terrain by `freeLayerSurface.geodata`.
   The dispatch reads `map.config.mapGeodataLoadMode` (not `mapLoadMode`)
   and routes through the same switch, defaulting to `drawSurfaceFit`.
   `mapGeodataLoadMode` is not in the §7 removal table. `drawSurfaceFit`
   appears in that table as a terrain replacement, with no note that
   geodata also uses it.

   Two things are missing:

   - §7 or §8: state that `drawSurfaceFit` is the method geodata
     currently calls, via `mapGeodataLoadMode = 'fit'`. That method must
     not be deleted until the geodata replacement exists, regardless of
     when the terrain path is complete.
   - §7 removal table: add `mapGeodataLoadMode` alongside `mapLoadMode`.

   Without these, §7 as written authorises deleting `drawSurfaceFit`
   while geodata still depends on it.

   *Implemented.* §7 now lists `mapGeodataLoadMode` in the removal
   table and states that `drawSurfaceFit` currently has both terrain
   and geodata callers. The resolution removes `mapGeodataLoadMode`
   rather than preserving it as a one-value option. §8 now states that
   geodata keeps calling fixed fitted-frontier traversal directly until
   the dedicated geodata path exists.

## Review round 7 — requested

This request makes non-geodata free layers unsupported in the new path.
The legacy renderer can draw free layers that behave like independent
tiled surface trees, but style-based maps do not produce them and no
known mapConfig or test URL depends on them. Supporting them would mean
running the terrain traversal once per free layer as a one-surface
sequence.

The proposed design does not do that. The new path ignores non-geodata
free layers and emits a one-off console warning naming the unsupported
layer. Geodata free layers remain covered by the fitted-frontier path
described above.

## Review round 7 — sign-off

The design is accepted.

Round 6 note 1 is resolved. §7 now names `drawSurfaceFit` as the method
geodata currently calls via `mapGeodataLoadMode = 'fit'`, adds
`mapGeodataLoadMode` to the removal table, and states the geodata
deletion dependency clearly. §8 states that geodata keeps the
fitted-frontier traversal directly and `mapGeodataLoadMode` is removed.

The round 7 scope decision — non-geodata free layers unsupported in the
new path — is correct. In `surface.js:38`, a non-geodata free layer
requires `type == 'free'` with `geodata == false`. No current test URL
mapConfig produces that type (`test/urls.json` has no free-layer
references), so ignoring it with a warning drops no active functionality.

Two editorial notes, neither a blocker:

1. §1 describes non-geodata free layers as absent from "style-based
   maps", a term not defined in the codebase. Replace with a verifiable
   claim: "No current test URL mapConfig includes a type-`'free'` free
   layer."

2. §1 says the new path "emits a one-off console warning naming the
   unsupported free layer." "One-off" leaves the throttle undefined; at
   60 fps an unthrottled warning fires every frame the layer is visible.
   Specify the throttle: once per unique free layer name per session, or
   move the definition to an implementation note in §8.

## Review round 8

1. The virtual-surface handling is too conservative and contradicts the
   removal plan.

   Virtual surfaces are a server-side optimization that replace several
   metatile trees with one metatile tree. They are not renderable
   surfaces. The new traversal can ignore them, but only if the client
   does not replace the whole surface sequence with the virtual surface.
   If that replacement happens, the traversal loses the drawable
   constituent surfaces.

   The RFC should not say that virtual-surface maps keep using the
   legacy traversal. Instead, mapConfig loading should bypass the
   virtual-surface replacement, keep the real constituent surfaces, and
   emit a one-off warning when a virtual surface is encountered.

   *Implemented.* §7 now says the new path bypasses the
   `generateSurfaceSequence` collapse to one `MapVirtualSurface`, keeps
   the constituent surfaces, filters to plain surfaces, and emits a
   one-off warning. The legacy path may keep using `MapVirtualSurface`
   while both paths coexist.

2. The algorithm still reads as if it loops independently over surfaces.

   Phrases such as "for each surface" are misleading. The descent should
   be a single traversal of a combined tree, similar in role to the old
   `virtualMetanode` mechanism, but without selecting one winning
   surface.

   The RFC should define "surface active at this node." A surface is
   active only if it was not culled at a higher level, did not stop
   descent at a higher level, and is not culled at the current node.
   Surfaces that fail a hierarchical condition should not be tested,
   drawn, or used for resource loading in the subtree.

   *Implemented.* §2.1 now defines one combined traversal and defines
   active surfaces. Active status is carried into child calls; culling,
   missing metatile data, natural-leaf termination, and watertight
   coverage remove a surface from descendant work.

3. The traversal should propagate surface deactivation, not watertight
   state.

   Watertight coverage is one reason to deactivate lower-priority
   surfaces for a subtree. Frustum culling and SSE decisions are other
   reasons. Carrying the active-surface set downward is necessary
   traversal state, not an optional watertight optimization.

   *Implemented.* §2.1 and §2.2 now describe active-surface
   propagation. Watertight coverage is modeled as one deactivation
   reason, using the same mechanism as culling and natural-leaf
   termination.

4. The watertight optimization should skip lower-surface metatile
   fetches for the affected subtree.

   The current text says lower-surface metatiles are still fetched below
   a watertight higher surface. That defeats the optimization. If a
   geometric condition applies to the entire node, such as full coverage
   by a higher-priority watertight surface or full frustum exclusion, it
   applies to the subtree. Lower inactive surfaces should not have their
   descendant metatiles fetched for that subtree.

   *Implemented.* §2.2 now states that a higher-priority watertight
   surface deactivates lower-priority surfaces for the node's
   descendants, including metatile fetches. This revises the round 1
   response that kept lower-surface metatile fetches.

5. The leaf-rendering mask wording needs a small clarification.

   "The current accumulated mask" should mean the input mask for the
   current surface. For the first surface at the node, that input mask is
   empty.

   *Implemented.* §2.2 now says the first surface receives an empty
   input mask and each updated mask becomes the next surface's input
   mask.

6. Readiness should be described as a backtrack operation.

   It makes more sense to call `rig.isReady()` after returning from the
   subtree, immediately before drawing natural leaves or fallback
   coverage. The text currently reads as if every descent-path node calls
   readiness on the way down.

   There are also cases where readiness should not be called: if child
   results prove a watertight subtree for the same or a higher-priority
   surface, the parent fallback will not render.

   *Implemented.* §2.4 now places readiness checks on backtrack,
   immediately before a natural-leaf or fallback draw. It also states
   that covered parent fallback tiles skip readiness checks.

7. Fallback readiness needs both minimum and desired levels.

   `minimum: 'fallback'` is the floor before any readiness call. On the
   backtrack fallback path, `fallback` should also be the desired
   readiness. Otherwise coarse fallback tiles may request optional
   resources, such as bump maps, and slow loading of natural leaf tiles.

   The RFC should also specify readiness priority. The existing LOD-based
   priority is a reasonable starting point unless implementation testing
   finds a better signal.

   *Implemented.* §2.4 now distinguishes natural-leaf readiness
   (`minimum: 'fallback', desired: 'full'`) from fallback readiness
   (`minimum: 'fallback', desired: 'fallback'`). Code inspection shows
   `TileRenderRig` already has these readiness levels. The current draw
   path uses LOD and distance for mesh/texture priority, so the RFC
   records that as the starting rule rather than LOD alone.

8. The screen-space mask path is out of scope for this milestone.

   The screen-space discussion can remain in the RFC as useful design
   context, but it should not be framed as an open design question for
   this implementation. The screen-space fallback threshold is also out
   of scope.

   *Implemented.* §4 is no longer titled as an open design question,
   §4.3 says the screen-space path is outside this milestone, and §9 no
   longer carries a screen-space fallback threshold question.

9. The watertight definition is too weak.

   A tile is watertight if it fully covers the geographic space allocated
   to the node by the spatial division. Boundary-edge coverage alone is
   insufficient: a tile can have covered edges and still contain interior
   holes. Watertightness is determined by the tileserver, but the RFC
   should not introduce a boundary-only definition.

   *Implemented.* §4.0 now defines watertightness as full coverage of
   the geographic cell allocated by the spatial division. It explicitly
   rejects boundary-edge coverage as sufficient.

10. The backend change needs an explicit rollout sequence.

   Implement the client traversal first. Initial testing will use old
   metatiles without the watertight flag, so the optimized path will not
   run; that is useful because it tests the non-optimized path first.

   Then implement and build the tileserver and `vts-vtsd` changes,
   deploy them in the local test environment, and test the optimized
   watertight pipeline. Production rollout should follow the same order:
   client first, server later. Treating old or unknown metatiles as
   non-watertight remains conservative and correct.

   *Implemented.* §4.5 now states the client-first/server-later rollout.
   §8 splits validation into client v5 testing, server/vts-vtsd changes,
   and v6 watertight validation.

11. The mask render-target architecture needs a deliberate home.

   The footprint and mask programs should be GLSL ES 3.00 shaders owned
   by the renderer. The RFC should decide whether their render targets
   are `GpuDevice` auxiliary targets, no-projection targets, or a new
   category. The current auxiliary-target terminology may imply a target
   that shares the canvas projection machinery, which is not true for a
   UV-space footprint pass.

   *Implemented.* §5.1 and §5.3 now require no-projection framebuffer
   targets for mask passes. The text keeps `GpuDevice.RenderTarget` as
   the mechanism, requires an explicit texture-space/no-projection
   target kind, and no longer treats `setAuxiliaryRenderTarget()` as the
   chosen API. It also records `textureblend.ts` as an existing
   pre-policy texture-space pass whose migration is out of scope.

12. The mask pool and resolution should not be hardcoded.

   The design needs at least one mask texture per active recursion level
   plus a scratch texture. It is unclear whether OR/composition needs an
   additional temporary texture, or whether a child mask can be blitted
   directly into the parent accumulation mask.

   The mask resolution should be configurable as a power of two.
   `256x256` is a reasonable default, not the only supported size.

   *Implemented.* §5.1 now derives the mask pool from active traversal
   depth and makes resolution a configurable power of two, with 256x256
   as the default. §6.2 uses the default only for the memory estimate.

13. Erosion must not be applied blindly on every OR or blit.

   Blind erosion would break watertight seams between same-surface,
   same-LOD tiles. Coarser tiles or lower-priority surfaces would then
   show through cracks introduced by the mask algorithm.

   For OR-into-node-mask erosion, pixels within `k` texels of the tile
   edge must not be eroded. For child-to-parent blits, the parent should
   first OR the accumulated child masks, then optionally erode the
   combined parent mask with the same edge protection.

   *Implemented.* §4.2 now defines erosion as deferred and
   edge-preserving. It forbids blind per-OR and per-child erosion.

14. Erosion should be deferred from the first implementation.

   The first implementation should use `k = 0`. The architecture should
   leave a place for erosion so adding it later does not require a major
   refactor, but erosion itself can be a later implementation step. Base
   traversal and watertight behavior should be tested before any erosion
   tuning.

   *Implemented.* §4.2, §5.1, §5.6, §8, and §9 now set the first
   implementation to `k = 0` and move erosion to a later step.

15. The erosion shader and child-blit text must be revised.

   The implementation text that applies a morphological min-filter to
   `scratch` is directly affected by the previous note. The text that
   says the same OR/blit program erodes each child blit and lets erosion
   compound naturally is invalid. Child masks must be combined before
   any optional parent-level erosion.

   *Implemented.* §5.1 and §5.6 now describe non-eroding OR/blit for the
   first implementation. §4.2 preserves the deferred min-filter design,
   with edge protection and parent-level erosion after child masks are
   combined.

16. The "fully rasterized" limitation is unclear.

   The phrase "a tile's UV-space footprint is fully rasterized but the
   mesh does not cover every UV position in screen space" is not clear
   and may be self-contradictory. If this describes the known crack
   problem, use that description instead. "Fully rasterized" should not
   remain undefined.

   *Implemented.* The unclear remaining-limitation paragraph was
   removed. The RFC now relies on the explicit crack discussion in §4.2.

17. "Footprint rasterization at tile boundaries" may not be a separate
   risk.

   This appears to be the same crack and erosion problem already covered
   elsewhere. Verify whether it is a distinct failure mode; if not, fold
   it into the crack discussion or remove it as a separate open question.

   *Implemented.* The separate footprint-rasterization open question was
   removed. The relevant risk is now covered by the crack and deferred
   erosion discussion.

18. Several implementation-plan references appear stale.

   The target method should be `drawSurface`, the current default, not
   `drawSurfaceFitOnly`. The `src/core/renderer/gpu/shaders.js` item and
   references to legacy shader behavior may already be stale and should
   be verified against the current codebase. If the shader no longer
   exists, use past tense when discussing it as prior art.

   *Partially implemented.* §8 now targets `drawSurface` behavior, which
   code inspection confirms is the current default terrain mode, but the
   recursive traversal is assigned to a private typed `Map` method, or a
   focused auxiliary TypeScript class if implementation pressure
   warrants it, rather than to `MapSurfaceTree`. The shader concern was
   partly rejected:
   `src/core/renderer/gpu/shaders.js` still exists and still contains
   `uClip` / `vClipCoord`; the modern `TileRenderRig` path also still
   binds `uClip` through `tile-clip.inc.glsl`. §5.6 and §7 now name both
   removal sites.

19. The rollout section should be reworked into human-reviewed phases.

   This should not be one large agent implementation followed only by
   automatic tests. The plan should have clear implementation boundaries
   and manual testing checkpoints between phases: base client traversal,
   fallback behavior, non-optimized multi-surface behavior, server
   metatile changes, optimized watertight behavior, and only then any
   erosion experiments.

   *Implemented.* §8 now presents the rollout as ordered phases with
   the base client traversal as one implementation unit and manual
   checkpoints after each later capability: fallback behavior,
   multi-surface testing, server rollout, watertight validation, and
   deferred erosion if implemented.

20. Some open questions should be reframed.

   Watertight bitplane field verification is a verification step, not an
   open design question. The per-surface mask-pool discussion is useful,
   but the model assumes coarser LODs do not contain finer data, even
   across different surfaces. LOD can therefore be used as an ordering
   relation. If data violates that assumption, treat it as a
   data-modeling problem rather than an algorithmic problem.

   *Implemented.* §9 is now "Verification and deferred work." Watertight
   bitplane field verification moved there as a rollout verification
   step, and the per-surface mask-pool note records the LOD-ordering
   data-model assumption.

## Review round 9 — sign-off

The design is accepted.

Round 8 is resolved. The RFC now describes a combined traversal with
active-surface propagation, watertight subtree deactivation, backtrack
readiness checks, a client-first/server-later watertight rollout,
texture-space render targets inside the `GpuDevice.RenderTarget`
mechanism, configurable mask resources, and deferred erosion with
initial `k = 0`.

The implementation ownership is correct: the recursive traversal belongs
in TypeScript, preferably as private typed `Map` orchestration, with a
focused auxiliary class only if implementation state warrants it. The
legacy `MapSurfaceTree` remains a compatibility/data source during
validation rather than the home for the new code.

The rollout is acceptable: the base client traversal is one
implementation unit with manual inspection after bring-up, and later
capabilities have separate manual checkpoints. The old traversal may
coexist only as validation scaffolding and is removed after the new path
and geodata fitted-frontier path are settled.

