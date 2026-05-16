# RFC: unified recursive draw traversal

**Status:** Draft — design open question on mask space unresolved
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

Multi-surface rendering relies on server-side glues and virtual
surfaces. A glue is a pre-baked tileset covering the seam between two
surfaces; it carries stitched geometry for seam tiles and a
`sourceReference` for non-seam tiles that redirects to a component
surface. The alien-flag mechanism in `createVirtualMetanode` was
designed to select the correct copy of each glue entry but is
permanently dead: the server never writes the alien bit into metatile
output (`glue-alien-flag.md`).

The goals of this RFC:

- Replace the four traversal methods with one recursive function.
- Replace server-side seam stitching with client-side compositing via
  mask textures, removing the need for glues as a correctness mechanism.
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
3. If the SSE test passes (`texelSize <= texelSizeFit`) or the node has
   no children, this node is a **leaf**: render it and return its mask
   (see §2.2).
4. Otherwise attempt to descend into each of the up to four children
   by calling the function recursively. Collect the returned masks.
5. OR the up to four child masks together into a single combined mask.
   Because child tiles occupy non-overlapping quadrants of the parent's
   geographic UV space, their masks occupy non-overlapping sub-rectangles
   of the parent mask texture. The OR is a no-op write: each child writes
   only into its quadrant.
6. If this node is a **fallback LOD** (see §2.4), render it using the
   combined child mask as input, then OR the rendered coverage into the
   mask. Return the combined mask.
7. Otherwise return the combined child mask without rendering.

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

The surface ordering contract: a surface earlier in the sequence
(higher stacking priority) claims its fragments first. A later surface
can render only into pixels not yet claimed. Depth testing still
operates normally within each surface's geometry; the mask handles
cross-surface ordering at the same node.

If a surface is watertight at this tile position (its geometry
covers the full tile cell), it claims all remaining UV area. All
subsequent surfaces in the sequence can be skipped — no rendering,
no data requests. See §4 for how watertight status is detected and
how each mask approach uses it differently.

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
its finer children exactly as a lower-priority surface reads the mask
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
lower-priority surface — both of which are edge conditions that are
unlikely to be visible.

**Infrastructure:** the mask texture is a screen-resolution RGBA8 or
R8 framebuffer texture, one per draw frame (not pooled by recursion
depth). The fragment shader writes to it via a second color attachment
(MRT — multiple render targets, available in WebGL2), or via a
separate pass that blits `gl_FragCoord` positions after the main draw.
The single-pass MRT approach is simpler if the tile shader can write to
a second output; the two-pass approach separates concerns more cleanly.

Backtrack propagation: the child's mask is already in screen space, so
no UV transform is needed. The parent simply reads the same texture at
its fragments' screen positions.

**Summary of tradeoffs:**

- Advantage: no cracks, simpler mask propagation (no UV transform,
  no pool of textures at different LOD levels).
- Risk: incorrect blocking at large LOD differences under oblique
  camera angles. Severity is bounded by the fallback cadence.
- Non-watertight boundary handling: partially degrades to depth
  testing, which is acceptable for edge tiles.

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
- When the topmost (highest-priority) watertight surface renders at
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

### 4.3 Assessment and prototype order

**Which approach is technically stronger**

Geographic. Its compositing correctness is unconditional: no camera
angle, no LOD difference, no fallback configuration can produce the
incorrect-blocking artifact that screen-space is structurally prone to.
The watertight optimization removes the footprint pass for the majority
of tiles (all interior tiles in a well-formed surface), which brings
the per-frame cost close to the screen-space approach for typical
terrain datasets. The crack problem is real, but so is the screen-space
oblique-angle artifact; both require empirical validation. The
geographic approach is the more principled replacement for what server
glues computed offline.

The screen-space approach avoids cracks, which are a known visible
artifact — the exact reason splitting is disabled in cartolina today.
But "bounded by fallback cadence" is not the same as "absent." Whether
the oblique-angle artifact is visible in practice is unknown; accepting
the risk is not a neutral choice.

**Which to prototype first**

Screen-space, for implementation simplicity. It requires no footprint
program, no blit program, no mask texture pool at multiple LOD levels,
and no UV transform on backtrack. This is a real difference in
implementation surface area, and validating the simpler approach first
is sound engineering practice — if the oblique-angle artifact turns out
to be imperceptible in real multi-surface data, the simpler
implementation suffices.

The two approaches share the traversal structure completely. They differ
only in the mask texture layout, the backtrack propagation step, and the
footprint/blit programs. Switching from screen-space to geographic is a
localised change once the traversal is validated.

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

### 5.1 Offscreen rendering: what is needed

The geographic mask requires rendering into an offscreen R8 texture
(the footprint pass) and blitting child masks into parent mask textures
(the backtrack OR pass). Both operations need a framebuffer object
targeting a texture that is not the screen framebuffer.

`GpuDevice` already supports this via `setAuxiliaryRenderTarget()`,
which binds a framebuffer-attached texture as the render target. The
footprint pass and the mask blit both qualify as auxiliary operations:
they describe geometry in the current map view (or a sub-region of it)
and do not require an independent camera. No new `GpuDevice` API is
needed.

The mask textures are `TEXTURE_2D` with internal format `R8`, created
once at startup into the pool. Each is attached to a dedicated FBO.

At the start of each mask pass:

```js
gpu.setAuxiliaryRenderTarget(maskTexture, maskSize);
gl.clearColor(0, 0, 0, 0);
gl.clear(gl.COLOR_BUFFER_BIT);
```

After the pass:

```js
gpu.setCanvasRenderTarget(); // or restore previous target
```

The `R8` format is guaranteed by WebGL2 (`RGBA8` would also work if
single-channel is not convenient; R8 is preferred for bandwidth).

### 5.2 Framebuffer ordering guarantee

Within a single WebGL2 context, a draw call that writes to texture T
via an FBO is complete before a subsequent draw call that samples T
as a uniform sampler, provided that T is not simultaneously attached
as both FBO attachment and sampler. This is a WebGL2 correctness
guarantee, not a race condition. The constraint is: before sampling
the mask texture, unbind its FBO. Concretely:

1. Footprint pass: bind FBO → draw mesh in UV space → unbind FBO
   (restore render target).
2. Screen-space pass: bind mask texture as sampler → draw mesh in
   screen space.

Step 1 must complete before step 2. The unbind between them is a
one-line call, not a synchronization primitive.

### 5.3 Mask blit pass

Writing a child mask into the parent mask texture is a full-screen quad
draw where:

- The render target is the parent mask FBO.
- The viewport is set to the child's sub-rectangle within the parent
  mask texture (e.g., `[0,0]–[128,128]` for a 256×256 mask and the
  upper-left child quadrant).
- The source is the child mask texture bound as a sampler.
- The fragment shader writes `texture(childMask, uv).r`.

No depth testing, no blending required. This is a trivial blit program
that can be shared across all mask blit passes.

### 5.4 Render target lifecycle during traversal

The traversal alternates between offscreen (mask) and onscreen
(color+depth) render targets. The call stack carries the current target
implicitly. At each node, the sequence is:

1. Set offscreen render target (mask texture for this depth level).
2. Run footprint pass (UV-space draw).
3. Set onscreen render target (canvas or depth hitmap, depending on
   draw channel).
4. Run screen-space draw with mask sampler.
5. Restore render target before returning (either parent's mask or
   canvas).

This is safe because the recursive calls for children complete before
the parent renders. By the time the parent's footprint pass runs, no
child mask FBO is active.

### 5.5 `TileRenderRig` changes

`TileRenderRig` currently does not support offscreen or mask-aware
rendering. The following changes are required:

**Footprint pass method:**

```ts
drawFootprint(program: GpuProgram): void
```

Draws the tile mesh with UV coordinates as vertex position. Does not
set any texture uniforms. Requires a program with a vertex shader that
uses `aTexCoords2` as `gl_Position`. The mesh must carry external UV
attributes (`rt.externalUVs` must be true).

**Mask-aware draw method:**

```ts
draw(program: GpuProgram, cameraPos: vec3,
     maskTexture?: GpuTexture): void
```

The existing `draw()` method gains an optional `maskTexture` parameter.
When present, the tile shader samples the mask at `aTexCoords2` and
discards the fragment if the mask value exceeds a threshold (e.g., 0.5
for R8). When absent, no mask discard occurs (existing behavior).

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
this with:

```glsl
uniform sampler2D uMask;   // R8 geographic mask texture

// in fragment shader:
if (uMaskEnabled) {
    float covered = texture(uMask, vExternalUV).r;
    if (covered > 0.5) discard;
}
```

Where `vExternalUV` is the interpolated `aTexCoords2` value, already
available in the existing rig shader as `aTexCoords2`.

The footprint program is a new, minimal program:

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

The blit program is a new, minimal program for writing child masks into
parent mask textures.

---

## 6. Performance analysis

### 6.1 Draw call count

For a typical scene with N visible tiles at the fit LOD:

- **Current fitonly:** N draw calls (one per tile, per surface, batched
  into draw commands).
- **New traversal, fitonly mode (cadence = ∞):** N footprint draws +
  N screen draws + (N − 1) mask blit draws ≈ 3N draw calls.
- **New traversal, fallback cadence 3:** approximately N + N/8 tiles
  render (fit tiles plus every-third-LOD fallback tiles). Footprint and
  blit passes add a similar factor: roughly 6N/4 total. This is still
  comparable to the current topdown mode for the same rendered tile
  count, with far fewer data requests.

The footprint and blit passes are cheap: no texture sampling, no UBO
updates, simple shaders. Their GPU time is negligible relative to the
screen-space passes.

### 6.2 Mask texture bandwidth

Each mask texture is 256×256 × 1 byte = 64 KB. Reading and writing
64 KB per active LOD level per frame is not a bottleneck on current
GPU hardware.

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

Virtual surfaces are also ignored in this implementation. If a server
provides a virtual surface metatile, the traversal treats the surface
as a plain surface entry and ignores the `sourceReference` field. A
future version may use virtual surfaces as an optional server-side
acceleration for metatile retrieval — they can reduce the number of
HTTP requests for large datasets where multiple surfaces share common
ancestry. That is a later optimisation, not a first-version
requirement.

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
