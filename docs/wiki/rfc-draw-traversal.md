# RFC: unified recursive draw traversal

**Status:** In review — author responded to round 2; mask decision
revised to geographic
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
3. For each surface, descend into children if the surface needs finer
   detail (SSE does not pass and children exist). Collect the masks
   returned by child calls and OR them together into a combined mask.
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

At a leaf node, the input mask is empty (no prior coverage). The
function iterates the surface sequence — the ordered list of surfaces
active at this node — and for each surface whose `TileRenderRig` is
ready:

1. Call `rig.draw()` with the current accumulated mask as input. The
   fragment shader discards fragments where the mask indicates coverage,
   then writes the newly rendered fragments into the mask output.
2. Pass the updated mask to the next surface.

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

The algorithm requires a mask that encodes which regions have been
covered by finer tiles. Two implementations are candidates:

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

**Mitigation — eroded mask:** shrink the covered region before writing
it into the destination mask — either the parent's mask (child-to-
parent blit) or the node mask read by the next surface (OR-into-node-
mask). The margin forces the receiving tile or surface to render into
a thin border zone around the covered region; depth testing resolves
the overlap there. The depth-test failure mode (a later surface
incorrectly occluding an earlier one at an oblique angle) can occur
in the border zone, but the zone is narrow and the failure is
imperceptible for surfaces with similar geometry.

**Implementation:** the OR/blit shader applies a morphological
min-filter of radius k texels on the source texture before writing
into the destination. For each destination texel the shader samples a
(2k+1)² neighborhood of the source and outputs the minimum — an image
erosion that shrinks the covered region by k texels on each side. This
operates in the destination texture's coordinate space. The same
program handles both the OR-into-node-mask step (eroding a surface's
footprint before back surfaces sample it) and the child-to-parent blit
(eroding the child mask before the parent samples it). A single
`uErosionRadius` uniform controls the radius in both contexts.

**Geometric growth in the LOD hierarchy:** each child-to-parent blit
erodes by k texels in the destination (parent) UV space. The parent's
UV space covers 4× the geographic area of the child, so each parent
texel represents twice the geographic width of a child texel. Over
multiple blit levels the erosion margin grows proportionally to the
LOD difference — naturally providing more border zone where the
geometry mismatch between a fallback ancestor and its descendants is
larger.

The erosion radius k is an empirical parameter. A reasonable starting
value is 1–2 texels of the mask texture (1/256–1/128 UV units). It
should be tuned against real multi-surface data with differing mesh
density at the surface boundary.

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
- Complexity: footprint program, OR/blit program with erosion
  min-filter, mask texture pool — more infrastructure than
  screen-space.

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

The crack problem is the accepted risk. The eroded-mask mitigation
(§4.2) is empirical — the correct margin varies with mesh density and
camera angle — but it is a bounded, tunable parameter. The prior
artifact with `drawSurfaceWithSpliting` was caused by the one-level
binary `splitMask`, which has no erosion and no depth-test fallback
in the border zone. The geographic mask with erosion plus depth
testing in the border zone is a materially different mechanism.

**Screen-space mask: deferred alternative.**

The screen-space approach is documented in §4.1. It is the correct
fallback if the erosion margin proves insufficient for specific
datasets. Two design questions identified in review — the correctness
of a frame-global binary mask under arbitrary traversal order
(comment 2, round 2), and the depth buffer lifecycle when each tile
draw blits to the canvas (comment 3, round 2) — do not have
clean closed-form solutions for the general case and are deferred
with the screen-space design.

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

### 5.1 Per-surface mask sequence (geographic)

The geographic mask uses one R8 texture per active recursion depth
level. The pool holds 16 textures at 256×256 each (1 MB total). Each
texture is the accumulated coverage mask for one node in the current
descent path.

The per-node mask starts as the ORed result of child blits (§2.3). At
frame start, the root node's mask is cleared to 0. There is one
additional R8 `scratch` texture at the same resolution, reused across
all footprint draws.

The same texture cannot be simultaneously attached as an FBO attachment
and bound as a sampler. The per-surface sequence makes ownership
explicit.

For each surface S at a node, in front-to-back order:

1. **Footprint pass.** Clear `scratch` to 0. Bind `scratch` FBO.
   Draw S with UV coordinates as clip position
   (`aTexCoords2 * 2.0 - 1.0`). The fragment shader writes 1.0 to
   `scratch` at every rasterized UV position. This records which
   geographic area S covers at this tile.

   Skip this step for a watertight surface: clear `node_mask[depth]`
   to 1.0 directly (a single FBO clear), then skip all remaining
   surfaces at this node.

2. **OR into node mask.** Unbind `scratch` FBO.
   Bind `node_mask[depth]` FBO. Enable blending with
   `gl.blendEquation(gl.MAX)` and `gl.blendFunc(gl.ONE, gl.ONE)`.
   Draw a full-screen quad. The shader applies a morphological
   min-filter of radius k texels on `scratch` (§4.2 erosion): for
   each texel it samples a (2k+1)² neighborhood of `scratch` and
   outputs the minimum. Blending then writes
   `max(existing, eroded_scratch)` per texel without reading
   the current attachment.
   Unbind `node_mask[depth]` FBO. Disable blending.

3. **Screen draw.** Bind `node_mask[depth]` as a sampler.
   Draw S in screen space. The fragment shader samples
   `node_mask[depth]` at the fragment's UV coordinate (`aTexCoords2`)
   and discards if the value exceeds 0.5.
   Unbind `node_mask[depth]` sampler.

Total per surface: 1 footprint draw + 1 OR pass + 1 screen draw =
3 draw calls. A watertight surface: 1 FBO clear + 1 screen draw, and
all remaining surfaces at this node are skipped.

**Child-to-parent blit (backtrack, §2.3).** The same OR/blit program
with the same `uErosionRadius` blits `node_mask[depth]` into the
parent's `node_mask[depth-1]` at the child's quadrant position.
Erosion compounds naturally up the hierarchy: each blit erodes by k
texels in the parent's UV space, which represents increasingly larger
geographic area at coarser LODs. See §4.2 for the growth property.

`GpuDevice.setAuxiliaryRenderTarget()` handles FBO binding. The pool
is allocated once at init; no new `GpuDevice` API is required beyond
a `clearFBO(texture, value)` helper.

### 5.2 Framebuffer ordering guarantee

Within a single WebGL2 context, a draw call that writes to texture T
via an FBO is complete before a subsequent draw call that samples T
as a uniform sampler, provided that T is not simultaneously attached
as both FBO attachment and sampler. This is a WebGL2 correctness
guarantee, not a race condition. The per-surface sequence in §5.1
respects this rule at two points.

For the footprint-to-OR step:

1. Footprint pass: bind `scratch` FBO → write → unbind.
2. OR pass: bind `scratch` as sampler → draw full-screen quad.

For the OR-to-screen-draw step:

1. OR pass: bind `node_mask[depth]` FBO → write → unbind.
2. Screen draw: bind `node_mask[depth]` as sampler → draw mesh.

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
Switching between them requires only binding and unbinding
`GpuDevice` auxiliary targets — no state save or restore is needed
across recursion levels.

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
draw(program: GpuProgram, cameraPos: vec3,
     maskTexture?: GpuTexture): void
```

The existing `draw()` method gains an optional `maskTexture` parameter.
When present, the tile shader samples `maskTexture` at the fragment's
UV coordinate (`aTexCoords2`) and discards if the value exceeds 0.5.
When absent, no mask discard occurs (existing behavior).

The current `uClip` / `splitMask` mechanism is replaced by this mask
texture input. The `splitMask` field on `MapSurfaceTile` is removed.

**Footprint method:**

```ts
footprint(maskFBO: GpuFramebuffer): void
```

A new method renders the tile mesh into a UV-space R8 FBO. The vertex
shader uses `aTexCoords2 * 2.0 - 1.0` as the clip-space position;
the fragment shader outputs 1.0. Called once per non-watertight
surface in the footprint pass (step 1 of §5.1).

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
the blend operation writes `max(existing, scratch)` per texel
without the shader reading the current FBO value, which WebGL2
does not permit. The shader simply outputs the sampled scratch value:

```glsl
// fragment
uniform sampler2D uScratch;
in vec2 vUV;
out float fragCoverage;
void main() {
    fragCoverage = texture(uScratch, vUV).r;
}
```

Blending handles the max; the shader output is just the input value.

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

One R8 `scratch` texture plus 16 R8 `node_mask` textures, all at
256×256: 17 × 64 KB = ~1 MB total. This is substantially less than
screen-resolution alternatives. Each node mask is written once per
footprint OR pass and read once per screen draw at that depth level.
Blit draws are 64 KB quad draws at most.

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
2. Allocate the mask texture pool: 16 R8 256×256 `node_mask`
   textures, 1 R8 256×256 `scratch` texture, and the FBO set.
3. Implement the footprint program and OR/blit program (§5.6).
4. Add `footprint()` and mask-aware `draw()` to `TileRenderRig`
   (§5.5). Mask sampled at `aTexCoords2`, not `gl_FragCoord`.
5. Implement the recursive traversal as a new method on
   `MapSurfaceTree`, replacing only the `drawSurfaceFitOnly`
   mode first. Validate against screenshot regression tests.
6. Extend to fallback cadence. Validate progressive loading.
7. Compare against old topdown mode for equivalent loaded data.
8. Validate multi-surface compositing at a surface boundary with
   erosion enabled. Tune the erosion margin against visible
   cracks on real multi-surface data.
9. Delete the old methods.

---

## 9. Open questions

**Erosion margin:** the radius k (in mask texels) used by the OR/blit
shader's min-filter is an empirical constant. It prevents cracks while
minimising the border zone where depth testing may produce incorrect
results for stacked surfaces. The same k applies to both the OR-into-
node-mask step and the child-to-parent blit; the geometric growth
property (§4.2) means a small k provides increasing geographic margin
at larger LOD differences. Tune against real multi-surface data,
particularly at surface boundaries where mesh density differs.

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

**Screen-space fallback threshold:** if the erosion margin proves
insufficient for a specific dataset or camera configuration, the
screen-space approach (§4.1) is the documented fallback. Before
that decision is made, define the empirical test: what crack
frequency or severity in specific multi-surface data warrants
switching to screen-space for that dataset.

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

4. The rollout still leaves the virtual-surface gate without an
   implementation handle.

   Section 7 names `vsurfaceCount` inside `generateSurfaceSequence` as
   the gate, but that value is currently local to the function. The RFC
   should say where the result is stored for the draw traversal to read,
   for example a `tree.usesVirtualSurfaces` boolean or equivalent. This
   is small, but without it the rollout rule is not actionable from
   `MapSurfaceTree`.
