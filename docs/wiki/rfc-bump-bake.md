# RFC: bump-layer collapse inside `TileRenderRig`

**Status:** In review
**Context:** PERF: bake bump maps into normal map inside
`TileRenderRig` in [backlog.md](backlog.md)

---

## 1. Problem

### 1.1 Why the old pipeline collapsed bumps

The old rendering pipeline had no way to use bump-map textures directly
in the tile shader. The shader received a single normal map and no
mechanism to blend additional textures into it at draw time.
`DRAWCOMMAND_APPLY_BUMPS` in `draw.js` worked around this by running a
`TextureBlend` pass (`nmblender`) before the draw call: it blended each
ready bump texture into the normal map GPU texture in place, recorded
the applied bump IDs in `MapTexture.bumpsApplied`, and freed the bump
texture from CPU and GPU memory. The draw call then bound only the
resulting normal map, with no bump textures and no bump entries in the
draw command sequence.

### 1.2 What `TileRenderRig` does instead

`TileRenderRig` is not constrained by the old pipeline's shader
limitation. Each bump-map style layer sits as a separate entry in the
layer stack targeting `'normal'`, and the rig's shader blends them into
the normal accumulator at draw time. This is correct and does not
require collapsing.

### 1.3 Motivation for collapsing in the new pipeline

Rendering bump layers natively costs per-draw resources. Every active
bump layer consumes one texture unit, one UBO slot, and one fragment
shader loop iteration on every draw call, for every frame the tile is
visible. Collapsing eliminates all three costs for each layer folded
into the normal map, and frees the bump texture from CPU and GPU memory.
The saving per collapsed bump layer is larger than in the old pipeline
because the UBO and shader loop are new overheads that the old pipeline
never incurred at all.

Collapsing is therefore an optimization, not a requirement. The tile
renders correctly either way. Whether to collapse is a runtime config
decision (§2.6).

---

## 2. Design

### 2.1 When to collapse

The collapse belongs in `optimizeStack()`, which is called from
`isReady()` before the UBO is encoded (tile-render-rig.ts line 209).
This is the latest possible point — optimizations that run here are
guaranteed to complete before the UBO encoding step reads the layer
stack.

An earlier collapse (outside `isReady()`, as a dedicated pre-pass) is
not needed. There is no per-frame cost to deferring to `optimizeStack()`:
`isReady()` is called every frame until the rig is fully ready and the
UBO is created; once the UBO exists, the readiness check is bypassed and
the collapse never runs again. The collapse therefore runs at most once
per bump layer per rig lifetime.

The collapse for a given bump layer fires when:

1. The normal-map base layer has a ready GPU texture, and
2. The bump layer's `MapTexture` is GPU-ready.

Bump layers are `necessity: 'optional'`; the normal map is
`necessity: 'essential'`. Collapsing cannot proceed until the essential
resource is available, and it does not block rendering while the
optional resource is still loading.

Bump layers may become ready at different times. Collapsing is
incremental: each bump layer is collapsed as it arrives, in layer-stack
order. If bump layer N is ready but layer N−1 is not, N waits. The
underlying normal for layer N is the result of all blends through
layer N−1.

### 2.2 The collapsed result is rig-local

The old pipeline wrote the blended result back into the shared
`MapTexture` GPU texture via `TextureBlend.copyResult()`. That modifies
the object in `tile.resources.textures` — shared by every consumer that
holds a reference to the same normal map. A second `TileRenderRig`
constructed for the same tile, or any other code that reads the normal
map, would receive a texture already altered by a specific bump
sequence, with no reliable record of what sequence produced it.

The collapsed result shall not be written back into the shared
`MapTexture`. Instead, the rig holds the blend output as a rig-local
`WebGLTexture`. The shared `MapTexture` is left unmodified. At draw
time, `encodeLayer` substitutes the rig-local texture for the base
normal map.

### 2.3 Two rigs alive simultaneously

`drawSurfaceTile` keeps two rigs per tile submesh: `tileRenderRig[i]`
(the current rig) and `lastRenderRig[i]` (the previous rig, drawn as
fallback while the new rig loads). When a style change, bound-layer
fallback, or view switch triggers rig replacement, the old rig is moved
to `lastRenderRig[i]` and a new rig is created for `tileRenderRig[i]`.
Both rigs reference the same `MapTexture` objects from
`tile.resources.textures`.

Two consequences follow.

**Style change.** The new rig may have a different bump sequence:
fewer layers, different layers, or none. If the old rig had written its
collapsed result back into the shared `MapTexture` GPU texture, the new
rig would start from a normal map with bumps already collapsed in,
which does not match its
own layer stack. The rig-local approach (§2.2) avoids this: the shared
`MapTexture` is never modified, so the new rig always starts from the
original clean texture regardless of what the old rig did.

**Concurrent readiness calls.** `isReady()` is called on both rigs in
the same frame when `lastRig` is still fallback-ready and `curRig` is
loading. Both may reach `optimizeStack()` in the same frame and attempt
to use `nmblender`. `nmblender` is a singleton on `MapDrawTiles` and is
not reentrant. The two `isReady()` calls are sequential within one frame,
so the blender is used by one rig at a time. To make this safe without
relying on call order, the collapse step checks a busy flag on
`nmblender` before using it. If the blender is already in use (by the
other rig's `isReady()` earlier in the same frame), the collapse is
deferred to the next frame.

Because the collapsed result is rig-local and the shared `MapTexture` is
never modified, each rig collapses independently into its own
`bakedNormalGpu`. No further coordination between rigs is needed.

### 2.4 Incremental collapse across frames

Bump layers may become GPU-ready at different times. When only some of
the bump layers are ready, `optimizeStack()` collapses the ready ones
and leaves the rest for later frames.

`bakedNormalGpu` is the accumulator. On first collapse, the rig
allocates a 256×256 `WebGLTexture` for `bakedNormalGpu`. The collapse
sequence each frame:

1. `nmblender.init()` — clear the FBO.
2. `blend(base, 1.0)` — where `base` is the raw normal map if this is
   the first collapse, or `bakedNormalGpu` if prior bumps have already
   been blended in.
3. For each bump layer that is GPU-ready and not yet `optimizedOut` (in
   layer-stack order, stopping at the first non-ready layer): blend the
   bump texture at its configured alpha and mark the layer `optimizedOut`.
4. `nmblender.copyResult(bakedNormalGpu)` — copy the FBO into the
   rig's own texture.

On each subsequent frame where another bump layer arrives, the same
sequence runs: clear, blend from `bakedNormalGpu` (which holds all
prior collapsed bumps), blend the new bump layer, copy back into
`bakedNormalGpu`. After all bump layers are collapsed, the UBO encoding
step uses `bakedNormalGpu` as the normal map and no further collapse
runs.

Because `bakedNormalGpu` is a rig-owned `WebGLTexture` separate from the
blender's internal FBO texture, calling `init()` for any future collapse
does not corrupt the previously stored result.

### 2.5 The collapsed result is not added to the resource cache

A collapsed normal map is the blend of a specific normal map texture and
a specific ordered bump sequence. In principle, a second rig with the
same sequence could reuse the result. The first implementation does not
add the collapsed result to the resource tree or any other shared cache.

Rebuilding the collapsed texture from the clean source costs one
full-screen quad draw per bump layer at the moment each texture arrives;
it does not recur per frame. Per the codebase principle of simple
function first: add caching only if profiling identifies this as a
measured cost.

### 2.6 `Shift+F B` diagnostic guard

`FlagBumpMaps` (Shift+F B) toggles bump-map rendering off. When a bump
layer has been collapsed, the flag has no layer to act on: the bump data
is already blended into the rig-local normal texture and the bump layer
is
marked `optimizedOut`.

Guard the collapse path with the config option `mapBakeBumps` (default
`true`). When `false`, collapsing is skipped entirely: bump layers
remain in the layer stack and `FlagBumpMaps` continues to toggle them
via `optimizedOut` at draw time. When `mapBakeBumps` is `true` and the
user presses Shift+F B, emit a console warning that the toggle has no
effect because collapsing is active.

### 2.7 Reusing `nmblender`

`nmblender` is a `TextureBlend` instance on `MapDrawTiles`, constructed
at 256×256 (`draw.js:154`). The first implementation reuses it as-is.
The rig borrows it synchronously within one `isReady()` call.

`nmblender` is a singleton. Two rigs at the same tile may both reach
`optimizeStack()` in the same frame (§2.3). To guard against this, add
a boolean `busy` flag to `nmblender` (or to `TextureBlend`). The
collapse step sets it on entry and clears it after `copyResult`; any
rig that finds it set defers its collapse to the next frame. Because
one frame's collapse is at most a handful of full-screen quad draws,
deferring one rig by a frame has no visible effect.

A follow-up can move `nmblender` into `TileRenderRig`, migrate it to a
`GpuDevice.RenderTarget`, and adopt the current GLSL shader conventions.
The backlog already notes this; it is not in scope here.

---

## 3. Implementation steps

1. Add `private bakedNormalGpu: WebGLTexture | null = null` to
   `TileRenderRig`.

2. Add a `busy: boolean = false` field to `TextureBlend` for the
   blender-reentrance guard described in §2.7.

3. In `optimizeStack()`, after the mask and watertight checks, add a
   collapse pass:

   a. Scan for the next un-collapsed bump layer (target `'normal'`,
      source `'texture'`, operation `'blend'`, not `optimizedOut`) in
      layer-stack order. If none, skip the collapse pass entirely.

   b. If `nmblender.busy`, skip the collapse pass this frame (§2.7).

   c. Check that the first un-collapsed bump layer is GPU-ready. If
      not, skip. (Collapsing must stay in layer-stack order.)

   d. Set `nmblender.busy = true`.

   e. Call `nmblender.init()` to clear the FBO.

   f. Blend the source into the FBO at alpha 1.0: if `bakedNormalGpu`
      is non-null, blend `bakedNormalGpu`; otherwise blend the base
      normal map texture.

   g. For each bump layer starting from the first un-collapsed, while the
      layer is GPU-ready: blend the bump texture at its configured
      alpha, then mark the layer `optimizedOut` and free its
      `MapTexture` CPU and GPU memory
      (`bumpTexture.killImage()`, `bumpTexture.mainTexture
      .killGpuTexture()`). Stop at the first non-ready layer.

   h. If `bakedNormalGpu` is null: allocate a `WebGLTexture` at
      256×256 with `gl.createTexture` and `gl.texImage2D`, and assign
      it to `bakedNormalGpu`.

   i. Call `nmblender.copyResult(bakedNormalGpu)` to copy the FBO into
      the rig's texture.

   j. Clear `nmblender.busy = false`.

4. In `encodeLayer()`, when binding the texture for the base normal-map
   push layer: if `bakedNormalGpu` is non-null, bind `bakedNormalGpu`
   instead of `normalMap.mainTexture.getGpuTexture()`.

5. Add `mapBakeBumps: boolean = true` to the config schema and default
   values. Gate step 3 on this flag. Wire the Shift+F B warning when
   the flag is on.

6. In `TileRenderRig.dispose()`: if `bakedNormalGpu` is non-null, call
   `gl.deleteTexture(bakedNormalGpu)`.

7. Verify with screenshot regression tests (`simple-terrain`,
   `complex-terrain`, `full-terrain`).

---

## 4. Open questions

**Blend resolution.** `nmblender` is 256×256. Normal maps served by the
tileserver may be larger. The old pipeline blended at 256×256
unconditionally; the same policy is acceptable here. If the normal map
is larger, the collapsed result is a downsampled blend. This is a known
trade-off from the old pipeline and can be addressed in a follow-up
when `nmblender` is modernised.

**`nmblender` ownership.** The backlog entry for deleting the legacy
mesh tile rendering pipeline schedules `nmblender` removal from
`MapDrawTiles`. That deletion must not happen until this collapse path
is in place and `nmblender` has been moved to `TileRenderRig`. The
sequencing is already stated in the backlog; this question is a
reminder to verify it before proceeding with the legacy deletion.

## Review round 1

1. Blocker: §2.2 and §2.3 make the collapsed normal rig-local, but
   §2.4 and implementation step 3.g still free the source bump
   `MapTexture` after one rig collapses it. The bump texture object is
   shared through `tile.resources.textures`, while each rig has its own
   `bakedNormalGpu`. If one rig kills the bump texture, another rig for
   the same tile may still need the source texture to build its own
   rig-local bake or to draw the unbaked layer. The old pipeline could
   free the bump texture because it wrote the result into the shared
   normal-map texture and recorded the applied bump on that shared
   normal map. This RFC removes that shared result, so the old lifetime
   rule no longer follows. Either do not free bump textures in this
   first implementation, or define a shared baked-normal cache with
   ownership and reuse rules.

2. Blocker: the RFC does not define how collapse interacts with
   `mapFlagBumpMaps` when the flag is already false before the first
   bake. `buildLayerStack` gives bump layers
   `Renderer.RenderFlags.FlagBumpMaps`, and `encodeLayer` writes that
   flag into the UBO so the shader can skip those layers when the flag
   is off. The proposed `optimizeStack()` pass scans layers by target,
   source, operation, and `optimizedOut`, not by the current render
   flags. If `mapBakeBumps` is true and bump rendering is disabled
   before a bump texture becomes ready, the pass can still bake a layer
   that the renderer would not have drawn. Decide whether baking makes
   Shift+F B a no-op from startup, or whether disabled bump layers must
   be excluded from baking until the flag is re-enabled. Then state the
   rule and the code path that provides the current flag state to
   `TileRenderRig`.

3. Blocker: §2.6 says Shift+F B should emit a warning when baking is
   active, but the implementation steps do not specify the call site.
   The current toggle is in `src/core/inspector/input.js`, while
   `mapFlagBumpMaps` also flows through config setters in
   `src/core/map/map.js` and URL config in `src/browser/url-config.ts`.
   A warning only in the keyboard handler misses programmatic and URL
   changes; a warning in a lower-level setter may repeat during normal
   config synchronization. The RFC should name the chosen call site and
   state whether the warning is keyboard-only or applies to every
   attempt to disable bump rendering while `mapBakeBumps` is true.

4. Non-blocking: the `nmblender.busy` guard in §2.3 and §2.7 does not
   match the synchronous code path described in the RFC. The two
   `isReady()` calls run sequentially on the same JavaScript thread, and
   `TextureBlend.init()`, `blend()`, and `copyResult()` do not yield.
   A second rig cannot observe `busy === true` unless collapse is made
   asynchronous later or an exception leaves the flag set. If the guard
   stays, the implementation steps should require `try/finally` around
   the whole blend sequence so an exception cannot disable baking for
   the rest of the session. The simpler first implementation can omit
   the guard and document that `TextureBlend` is borrowed synchronously.

5. Non-blocking: step 3.h says to allocate `bakedNormalGpu` with
   `gl.createTexture` and `gl.texImage2D`, but it does not list sampler
   parameters. `TextureBlend` creates its FBO texture with
   `LINEAR` filtering and `CLAMP_TO_EDGE`; a rig-owned destination
   texture should get explicit parameters before `copyTexSubImage2D`
   writes into it. Otherwise the result depends on WebGL defaults,
   including mipmap-dependent minification state for a texture that has
   no generated mipmaps.
