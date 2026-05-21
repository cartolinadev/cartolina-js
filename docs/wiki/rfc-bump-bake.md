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
into the normal map. The saving per collapsed bump layer is larger than
in the old pipeline because the UBO and shader loop are new overheads
that the old pipeline never incurred at all.

Source bump textures are not explicitly freed after collapse. Their GPU
payloads remain managed by their existing `MapSubtexture` `map.gpuCache`
entries — the same mechanism used for all other tile textures. The
collapsed normal GPU texture has its own `map.gpuCache` entry and is
evicted independently. The resource tree is a lookup and ownership
graph for resource objects, not the GPU memory eviction mechanism.

Collapsing is therefore an optimization, not a requirement. The tile
renders correctly either way. Whether to collapse is a runtime config
decision (§2.6).

---

## 2. Design

### 2.1 When to collapse

The collapse belongs in `optimizeStack()`, which is called from
`isReady()` before the UBO is encoded. The method already contains a
`TODO: merge of subsequent static blends (bump maps)` at line 987 —
that comment is the intended hook for this implementation.

The collapse runs as a separate pass after the existing watertight
loop, operating only on the innermost normal stack level. It does not
cross `push` or `pop` boundaries on the `'normal'` target; bump layers
on other stack levels are left in the stack. Current style layers
produce no nested push/pop on the `'normal'` target.

An earlier collapse (outside `isReady()`, as a dedicated pre-pass) is
not needed. There is no per-frame cost to deferring to `optimizeStack()`:
`isReady()` is called every frame until the rig is fully ready and the
UBO is created; once the UBO exists, the readiness check is bypassed and
the collapse never runs again. The collapse therefore runs at most once
per bump layer per rig lifetime.

A bump layer is eligible for collapse when its `MapTexture` is
GPU-ready and the normal it would blend into is ready to receive it.
For the first bump layer that is the base normal map GPU texture; for
each subsequent one it is `collapsed.normalGpu`, which already holds
all prior collapsed layers.

Collapsing is incremental and in layer-stack order. If bump layer N is
ready but layer N−1 is not yet collapsed, N waits: the underlying
normal for layer N is the result of all blends through layer N−1.

### 2.2 The collapsed result is rig-local

The old pipeline wrote the blended result back into the shared
`MapTexture` GPU texture via `TextureBlend.copyResult()`. That modifies
the object in `tile.resources.textures` — shared by every consumer that
holds a reference to the same normal map. A second `TileRenderRig`
constructed for the same tile, or any other code that reads the normal
map, would receive a texture already altered by a specific bump
sequence, with no reliable record of what sequence produced it.

The collapsed result shall not be written back into the shared
`MapTexture`. Instead, the rig holds the blend output in a private
`collapsed` object (see §2.5) whose `normalGpu` field is a `GpuTexture`
registered with `map.gpuCache`, following the same pattern as
`MapSubtexture`. The shared `MapTexture` is left unmodified. At draw
time, `encodeLayer` substitutes `collapsed.normalGpu` for the base
normal map and calls `map.gpuCache.updateItem(collapsed.cacheItem)` to
mark it as recently used.

When the cache evicts the baked texture, the destructor clears
`collapsed` (setting it to null), resets `optimizedOut` to false on
every layer that was collapsed into it, deletes the existing UBO with
`gl.deleteBuffer` and sets `uboLayers` to null. On the next frame,
`isReady()` calls `optimizeStack()`, which finds the un-collapsed layers
and re-runs the collapse. Because the bump `MapTexture` objects are not
freed post-collapse, re-collapse proceeds as soon as their GPU textures
are resident again.

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
which does not match its own layer stack. The rig-local approach
(§2.2) avoids this: the shared
`MapTexture` is never modified, so the new rig always starts from the
original clean texture regardless of what the old rig did.

**Concurrent readiness calls.** `isReady()` is called on both rigs in
the same frame when `lastRig` is still fallback-ready and `curRig` is
loading. Both may reach `optimizeStack()` in the same frame and attempt
to use `nmblender`. `nmblender` is a singleton on `Renderer` and is
not reentrant. The two `isReady()` calls are sequential within one frame,
so the blender is used by one rig at a time. No guard is needed: the
calls are sequential and synchronous (see §2.7).

Because the collapsed result is rig-local and the shared `MapTexture` is
never modified, each rig collapses independently into its own
`collapsed.normalGpu`. No further coordination between rigs is needed.

### 2.4 Incremental collapse across frames

Bump layers may become GPU-ready at different times. When only some of
the bump layers are ready, `optimizeStack()` collapses the ready ones
and leaves the rest for later frames.

`collapsed.normalGpu` is the accumulator. On first collapse, the rig
allocates a 256×256 `GpuTexture` for `collapsed.normalGpu`. The
collapse sequence each frame:

1. `nmblender.init()` — clear the FBO.
2. `blend(base, 1.0)` — where `base` is the raw normal map if this is
   the first collapse, or `collapsed.normalGpu` if prior bumps have
   already been blended in.
3. For each bump layer that is GPU-ready and not yet `optimizedOut` (in
   layer-stack order, stopping at the first non-ready layer): blend the
   bump texture at its configured alpha and mark the layer `optimizedOut`.
4. `nmblender.copyResult(collapsed.normalGpu)` — copy the FBO into the
   rig's own texture.

On each subsequent frame where another bump layer arrives, the same
sequence runs: clear, blend from `collapsed.normalGpu` (which holds all
prior collapsed bumps), blend the new bump layer, copy back into
`collapsed.normalGpu`. After all bump layers are collapsed, the UBO
encoding step uses `collapsed.normalGpu` as the normal map and no
further collapse runs.

Because `collapsed.normalGpu` is a rig-owned `GpuTexture` separate from
the blender's internal FBO texture, calling `init()` for any future
collapse does not corrupt the previously stored result.

### 2.5 Ownership of the collapsed texture

The rig holds collapse state in a private `collapsed` object with three
fields: `normalGpu` (the baked `GpuTexture`), `cacheItem` (the opaque
token returned by `map.gpuCache.insert()`), and `layerIndices` (indices
of bump layers collapsed into `normalGpu`, used by the eviction
destructor). When `collapsed` is null, no collapse is active. The three
fields are allocated and freed together, eliminating any partial-state
window.

`collapsed.normalGpu` is registered with `map.gpuCache` for memory
accounting and LRU eviction. It is not added to the resource tree and
is not shareable by key between rigs in this implementation —
`map.gpuCache` is a keyless LRU pool with no lookup mechanism (see open
questions).

A second rig with the same normal map and bump sequence cannot reuse the
result. Rebuilding the collapsed texture costs one full-screen quad draw
per bump layer at the moment each texture arrives; it does not recur per
frame. Per the codebase principle of simple function first: key-based
sharing is added only if profiling identifies rebuilding as a measured
cost.

### 2.6 Config guard and render-flag semantics

Guard the collapse path with the config option `mapCollapseBumps`
(default `true`). When `false`, collapsing is skipped entirely. Bump
layers remain in the layer stack with their `flagMask` set to
`FlagBumpMaps`; the shader reads that flag from the UBO on each draw
call and skips the layer when bump rendering is off.

Collapse is a data-preprocessing step driven by layer stack and texture
residency. `useBumpMaps` does not govern when collapse runs.
`useNormalMaps` does: collapse requires normal maps to be on, because
the baked result is bound through the normal-map push layer. When
`useNormalMaps` is false before collapse, bump layers remain in the
stack and can still render into the shader's flat-normal accumulator.

Once a bump layer is collapsed, it is marked `optimizedOut` until the
collapsed texture is evicted or the rig is disposed. Runtime flag
changes do not uncollapse layers. At draw time, `encodeLayer` binds
`collapsed.normalGpu` for the base normal-map push layer when
`useBumpMaps` is on and `collapsed` exists; otherwise it binds the base
normal map. `useNormalMaps` is not checked in `encodeLayer` because the
normal-map push layer already carries `FlagNormalMaps`, and the shader
skips the layer when that flag is off.

Two diagnostic combinations follow from that rule. Turning `useBumpMaps`
off after collapse falls back to the base normal map; the collapsed
data remains available for later use. Turning `useNormalMaps` off after
collapse hides the collapsed bump data because the shader skips the
normal-map push layer. This is accepted diagnostic-mode behavior. The
data remains in `collapsed.normalGpu`; turning `useNormalMaps` back on
restores the collapsed bump shading, and cache eviction or disposal
restores the original bump layers.

### 2.7 Reusing `nmblender`

`nmblender` is a `TextureBlend` instance on `Renderer`, constructed at
256×256 in `Renderer`'s init path. `MapDraw` accesses it via
`this.renderer.nmblender` for the legacy collapse path. `TileRenderRig`
accesses it the same way from `this.renderer.nmblender`.

The rig borrows `nmblender` synchronously within a single `isReady()`
call. The two `isReady()` calls per frame (for `tileRenderRig[i]` and
`lastRenderRig[i]`) run sequentially on the JS thread; `init()`,
`blend()`, and `copyResult()` do not yield. No guard is needed.

A follow-up can move `nmblender` into `TileRenderRig`, migrate it to a
`GpuDevice.RenderTarget`, and adopt the current GLSL shader conventions.
The backlog already notes this; it is not in scope here.

---

## 3. Implementation steps

1. Add `nmblender: TextureBlend` to `Renderer`
   (`src/core/renderer/renderer.ts`). Construct it at 256×256 in
   `Renderer`'s init path (alongside the existing texture allocations).
   Update `MapDraw` (`draw.js`) to access it as `this.renderer.nmblender`
   instead of `this.nmblender`. Remove the `nmblender` field and
   constructor call from `MapDraw`.

2. Add one private field to `TileRenderRig`:

   ```typescript
   private collapsed: {
       normalGpu: GpuTexture;
       cacheItem: object;
       layerIndices: number[];
   } | null = null;
   ```

   The three sub-fields are always valid together or not at all. When
   `collapsed` is null, no collapse is active.

3. In `optimizeStack()`, after the mask and watertight checks, add a
   collapse pass:

   a. Check `this.renderer.getRenderingOptions().useNormalMaps`. If
      false, skip the collapse pass this frame. The baked result is
      bound through the normal-map push layer; collapse without that
      path available would leave bump data inaccessible (see §2.6).

   b. After the existing watertight loop, find the first layer in the
      stack with `target === 'normal'` and `operation === 'push'`. If
      none, skip the collapse pass — there is no normal-map base to
      blend into. From that push layer's index, scan forward for the
      first un-collapsed bump candidate: `target === 'normal'`,
      `source === 'texture'`, `operation === 'blend'`, not
      `optimizedOut`. Stop at the next layer with `target === 'normal'`
      and `operation === 'push'` or `source === 'pop'`, or at end of
      stack. If no eligible bump layer is found, skip the collapse pass.

   c. Branch on whether `this.collapsed` is already non-null:
      - If null (first collapse or post-eviction restart): check that
        `this.normalMap` is non-null and its GPU texture is resident
        using a read-only test. If not, skip. The base normal-map
        texture is the blend source for the first layer and must be
        resident before the pass begins.
      - If non-null (incremental pass): the base normal-map texture is
        not needed — `this.collapsed.normalGpu` already holds the prior
        result. Call
        `map.gpuCache.updateItem(this.collapsed.cacheItem)` immediately
        to protect it from any eviction that can happen in the steps
        below. Do not test `this.normalMap` residency.

   d. Check that the first un-collapsed bump layer's GPU texture is
      non-null using a read-only test (do not trigger GPU texture
      upload). If not ready, skip. (Collapsing must stay in order.)

   e. Extract `WebGLTexture` handles for the blend source:
      - If `this.collapsed` is non-null: `srcHandle =
        this.collapsed.normalGpu.texture`. If null, abort.
      - If `this.collapsed` is null: `srcHandle =
        this.normalMap.getGpuTexture()?.texture`. If null, abort.
      These handles are passed to `TextureBlend.blend()` and
      `copyResult()`, which require `WebGLTexture` not `GpuTexture`.

   f. Call `this.renderer.nmblender.init()` to clear the FBO.
      (`nmblender` is borrowed synchronously; no guard is needed —
      see §2.7.)

   g. Blend `srcHandle` into the FBO at alpha 1.0.

   h. For each bump layer starting from the first un-collapsed, while
      the layer's GPU texture is non-null: extract `const bumpHandle =
      bumpGpu.texture`; if null, stop the loop. Otherwise blend
      `bumpHandle` at its configured alpha and record its index in
      `rt.layerStack` in a local array `collectedIndices`. Do not mark
      layers `optimizedOut` here — that is deferred to step 3k after
      cache registration survives, so that any abort between here and
      step 3k leaves the layer stack unmodified. Stop also at any
      `operation === 'push'` or `source === 'pop'` layer on the
      `'normal'` target (same boundary rule as step 3b).

   i. If `this.collapsed` is null: allocate a `GpuTexture` via
      `new GpuTexture(this.renderer.gpu, null, this.renderer.core)`
      and call `createFromData(256, 256, emptyData,
      GpuTexture.Type.Color, 'linear')` where `emptyData` is a zeroed
      256×256×4 `Uint8Array`. Store the result in a local
      `normalGpu`.

   j. Extract `const dstHandle` from the `normalGpu` (local, if just
      allocated) or `this.collapsed.normalGpu.texture` (incremental).
      If null, abort the pass. Call
      `this.renderer.nmblender.copyResult(dstHandle)`.

   k. Update cache registration and commit the collapse:
      - If `this.collapsed` is null (first allocation): set
        `this.collapsed = { normalGpu, cacheItem: null!, layerIndices:
        collectedIndices }`. Populating `layerIndices` before `insert()`
        ensures the eviction destructor can restore the layers if the
        cache evicts immediately. Then call `const cacheItem =
        map.gpuCache.insert(evictCollapsed.bind(this),
        normalGpu.getSize())`. After `insert()` returns, check whether
        `this.collapsed` is still non-null: if null, the cache
        immediately evicted the entry and `evictCollapsed()` has
        already run (restoring the layers); abort the pass. If
        `this.collapsed` is still non-null, assign
        `this.collapsed.cacheItem = cacheItem`.
      - If `this.collapsed` is already set (incremental pass): append
        `collectedIndices` to `this.collapsed.layerIndices`. Call
        `map.gpuCache.updateItem(this.collapsed.cacheItem)`.

      After cache registration succeeds, mark `optimizedOut = true` on
      every index in `collectedIndices`. This is the earliest point at
      which the collapse is fully committed: the texture exists,
      registration survived, and `this.collapsed.layerIndices` is
      already populated for the destructor to reverse the marking if
      eviction occurs later.

      The destructor `evictCollapsed()` is a private method that:
      - calls `this.collapsed.normalGpu.kill()`
      - sets `optimizedOut = false` on each index in
        `this.collapsed.layerIndices`
      - calls `gl.deleteBuffer(uboLayers)` then sets `uboLayers = null`
        (the explicit delete prevents a GPU buffer leak, since
        `dispose()` also deletes `uboLayers`)
      - sets `this.collapsed = null`

4. In `isReady()`, read the current flags once via
   `this.renderer.getRenderingOptions()` and apply the same rules as
   §2.6:

   - If `useNormalMaps` is on, require the base normal-map GPU texture
     unless `this.collapsed` is non-null and `useBumpMaps` is on, in
     which case require `this.collapsed.normalGpu` instead.
   - If `useNormalMaps` is off, do not require the base normal-map GPU
     texture.
   - If `useBumpMaps` is on, evaluate uncollapsed bump layers for
     residency subject to their existing necessity and readiness-level
     rules.
   - If `useBumpMaps` is off, do not evaluate bump layers for
     residency.
   - Collapsed bump layers are already `optimizedOut`; flag toggles do
     not make them readiness candidates again. Eviction or disposal
     restores them.

5. In `encodeLayer()`, when binding the texture for the base
   normal-map push layer: if `this.collapsed` is non-null and
   `useBumpMaps` is true, bind `this.collapsed.normalGpu` instead of
   `normalMap.mainTexture.getGpuTexture()`, and call
   `map.gpuCache.updateItem(this.collapsed.cacheItem)`. Otherwise bind
   the base normal map as before.

6. Add `mapCollapseBumps: boolean = true` to the config schema and
   default values. Gate step 3 on this flag.

7. In `TileRenderRig.dispose()`: if `this.collapsed` is non-null, call
   `map.gpuCache.remove(this.collapsed.cacheItem)`, which triggers
   `evictCollapsed` and frees the `GpuTexture`.

8. Verify with screenshot regression tests (`simple-terrain`,
   `complex-terrain`, `full-terrain`).

---

## 4. Open questions

**Blend resolution.** `nmblender` is 256×256. Normal maps served by the
tileserver may be larger. The old pipeline blended at 256×256
unconditionally; the same policy is acceptable here. If the normal map
is larger, the collapsed result is a downsampled blend. This is a known
trade-off from the old pipeline and can be addressed in a follow-up
when `nmblender` is modernised.

**Collapsed normal cache key.** `map.gpuCache` (`MapCache`) is a
keyless LRU eviction pool: `insert()` accepts a destructor and a byte
cost and returns an opaque token; there is no key lookup. The collapsed
normal is therefore rig-local and cannot be shared between rigs even
when two rigs target the same normal map with the same bump sequence.
Cross-rig reuse would require a separate key-based cache entry, keyed
on the normal map URL plus the ordered bump sequence (layer IDs and
alphas). That is a valid follow-up optimization but is out of scope
here.

**`nmblender` ownership.** `nmblender` now lives on `Renderer`
(implementation step 1). `MapDraw` accesses it via
`this.renderer.nmblender`. The backlog entry for deleting the legacy
mesh tile rendering pipeline must not remove `nmblender` from
`Renderer` until the follow-up that moves it into `TileRenderRig` is
complete. The sequencing is already stated in the backlog; this
question is a reminder to verify it before proceeding with the legacy
deletion.

## Review round 1

1. Blocker: §2.2 and §2.3 make the collapsed normal rig-local, but
   §2.4 and implementation step 3.g still free the source bump
   `MapTexture` after one rig collapses it. The bump texture object is
   shared through `tile.resources.textures`, while each rig has its own
   `collapsedNormalGpu`. If one rig kills the bump texture, another rig for
   the same tile may still need the source texture to build its own
   rig-local bake or to draw the unbaked layer. The old pipeline could
   free the bump texture because it wrote the result into the shared
   normal-map texture and recorded the applied bump on that shared
   normal map. This RFC removes that shared result, so the old lifetime
   rule no longer follows. Either do not free bump textures in this
   first implementation, or define a shared baked-normal cache with
   ownership and reuse rules.

   *Implemented. Step 3.g removed. The bump `MapTexture` is not freed
   after collapse in this implementation. CPU and GPU memory for the bump
   texture is reclaimed when the tile is evicted from the resource tree
   via the normal cache eviction path. The primary savings — one texture
   unit, one UBO slot, one shader loop iteration per draw call — are
   preserved; the memory saving is deferred to a follow-up that defines
   shared result ownership.*

2. Blocker: the RFC does not define how collapse interacts with
   `mapFlagBumpMaps` when the flag is already false before the first
   bake. `buildLayerStack` gives bump layers
   `Renderer.RenderFlags.FlagBumpMaps`, and `encodeLayer` writes that
   flag into the UBO so the shader can skip those layers when the flag
   is off. The proposed `optimizeStack()` pass scans layers by target,
   source, operation, and `optimizedOut`, not by the current render
   flags. If `mapCollapseBumps` is true and bump rendering is disabled
   before a bump texture becomes ready, the pass can still bake a layer
   that the renderer would not have drawn. Decide whether baking makes
   Shift+F B a no-op from startup, or whether disabled bump layers must
   be excluded from baking until the flag is re-enabled. Then state the
   rule and the code path that provides the current flag state to
   `TileRenderRig`.

   *Implemented. §2.6 updated: the collapse pass checks the current
   render flags and skips any bump layer whose `flagMask` bits are not
   set (i.e., `FlagBumpMaps` is off). Collapsing is therefore deferred
   for a layer as long as bump rendering is disabled. Once the flag is
   re-enabled, the layer becomes eligible and is collapsed on the next
   frame. Layers already collapsed before the flag was turned off remain
   collapsed; the warning in §2.6 is scoped to that case.*

3. Blocker: §2.6 says Shift+F B should emit a warning when baking is
   active, but the implementation steps do not specify the call site.
   The current toggle is in `src/core/inspector/input.js`, while
   `mapFlagBumpMaps` also flows through config setters in
   `src/core/map/map.js` and URL config in `src/browser/url-config.ts`.
   A warning only in the keyboard handler misses programmatic and URL
   changes; a warning in a lower-level setter may repeat during normal
   config synchronization. The RFC should name the chosen call site and
   state whether the warning is keyboard-only or applies to every
   attempt to disable bump rendering while `mapCollapseBumps` is true.

   *Implemented. §2.6 updated with a named call site. URL-configured
   flags are applied before any tile loads and before any collapse can
   occur, so the flag is already false when the first bump texture
   arrives; the render-flag check above defers collapse correctly and
   no warning is needed. The warning applies only to interactive
   Shift+F B presses: it is emitted in the keyboard handler in
   `input.js`, which is the only path where the user actively toggles
   the flag after tiles have loaded. Programmatic post-load changes to
   `mapFlagBumpMaps` are not warned; they are out of scope for the
   first implementation.*

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

   *Implemented. The `busy` flag removed from §2.3, §2.7, and the
   implementation steps. §2.7 updated to document that `nmblender` is
   borrowed synchronously within one `isReady()` call, and that no guard
   is needed because the two `isReady()` calls per frame are sequential
   on the JS thread.*

5. Non-blocking: step 3.h says to allocate `collapsedNormalGpu` with
   `gl.createTexture` and `gl.texImage2D`, but it does not list sampler
   parameters. `TextureBlend` creates its FBO texture with
   `LINEAR` filtering and `CLAMP_TO_EDGE`; a rig-owned destination
   texture should get explicit parameters before `copyTexSubImage2D`
   writes into it. Otherwise the result depends on WebGL defaults,
   including mipmap-dependent minification state for a texture that has
   no generated mipmaps.

   *Implemented. Step 3.h updated with explicit sampler parameters:
   `LINEAR` for min and mag filters, `CLAMP_TO_EDGE` for both wrap
   modes, matching the `TextureBlend` FBO texture.*

## Review round 2

1. Blocker: §2.6 and implementation step 2.b require
   `optimizeStack()` to check the current render flags, but the RFC does
   not define how `TileRenderRig` obtains those flags. Today
   `optimizeStack()` is called from `isReady()` before `draw()`, while
   `updateBuffer()` receives only the tile program and writes each
   layer's `flagMask` into the layer UBO. The active frame flags are
   computed in `Renderer.updateBuffer()` from `renderer.debug` and
   `map.config`, and `TileRenderRig` does not store or receive the
   encoded or unencoded result. `Renderer.getRenderingOptions()` exposes
   `useBumpMaps`, so the design can likely use that, but the RFC should
   name the exact API or argument that `optimizeStack()` uses. Without
   that, the implementation step cannot be coded from the design.

   *Implemented. §2.6 and step 2b updated to name the API:
   `this.renderer.getRenderingOptions().useBumpMaps`. The rig already
   holds `this.renderer`; no new argument or field is needed.
   `getRenderingOptions()` applies the debug override before the config
   value, matching what `Renderer.updateBuffer()` does when encoding
   frame flags.*

2. Blocker: §1.3 still says collapsing frees the bump texture from CPU
   and GPU memory. Review round 1 removed that behavior because the
   baked result is rig-local and the bump `MapTexture` is shared. This
   sentence is now false and leaves two incompatible goals in the RFC:
   the design says not to free bump textures, while the motivation says
   the optimization includes freeing them. Update §1.3 to state the
   first implementation saves texture units, UBO slots, and shader loop
   iterations, and that memory reclamation is deferred until a shared
   baked result or ownership rule exists.

   *Implemented. §1.3 rewritten: the saving is now described as
   eliminating per-draw texture units, UBO slots, and shader iterations.
   A separate paragraph states that memory reclamation is deferred and
   explains why (rig-local result, multiple rigs may hold the same bump
   `MapTexture`).*

3. Non-blocking: §2.6 says that when `mapCollapseBumps` is false,
   `FlagBumpMaps` continues to toggle bump layers via `optimizedOut` at
   draw time. In the current rig path, `optimizedOut` is a CPU-side skip
   used before UBO encoding; render flags are encoded into the UBO and
   evaluated by the shader. Rewrite this sentence so it does not imply
   that Shift+F B mutates `optimizedOut` during drawing.

   *Implemented. §2.6 opening rewritten: bump layers remain in the
   layer stack with `flagMask = FlagBumpMaps`; the shader reads that
   flag from the UBO on each draw call and skips the layer when bump
   rendering is off.*

## Review round 3

1. Blocker: §2.1 says collapse fires only after the normal-map base
   layer has a ready GPU texture, but the implementation steps do not
   encode that guard. Step 2.c checks only the first un-collapsed bump
   layer. `optimizeStack()` runs before `isReady()` performs the normal
   map readiness check, and `buildLayerStack()` can add bump layers even
   when no normal-map push layer exists (`rt.normals` can be false; the
   shader then starts from `flatNormal`). The RFC must state what the
   collapse pass does when `this.normalMap` is absent or when
   `this.normalMap.getGpuTexture()` is not ready. The simplest rule is
   to skip collapse unless a base normal-map layer exists and its GPU
   texture is ready.

   *Implemented. Step 2c added: skip collapse if `this.normalMap` is
   null or its GPU texture is not ready. The old step 2c is now 2d,
   and subsequent sub-steps are relabeled.*

2. Blocker: the design changes `FlagNormalMaps` behavior after a bump
   layer is collapsed. Before collapse, the shader pre-pushes
   `flatNormal`; if `FlagNormalMaps` is off and `FlagBumpMaps` is on,
   the normal-map push layer is skipped but bump layers still blend into
   the flat normal. After collapse, the bump data is stored in
   `collapsedNormalGpu` and bound through the base normal-map push layer,
   whose `flagMask` is `FlagNormalMaps`. Turning normal maps off would
   therefore also hide already-collapsed bump data, even while
   `FlagBumpMaps` remains on. The RFC should either accept and document
   that diagnostic behavior change, or define how encoded layers and
   flag masks preserve the old `FlagNormalMaps` / `FlagBumpMaps`
   separation after collapse.

   *Implemented. §2.6 updated. The render-flag guard (step 2b) now
   requires both `useBumpMaps` and `useNormalMaps` to be true. This
   prevents collapsing in any configuration where the post-collapse
   `FlagNormalMaps` behavior change would be immediately visible.
   The behavior change is accepted for the case where normal maps are
   turned off after collapse: this is a diagnostic-mode combination not
   expected in production. §2.6 documents the accepted change
   explicitly.*

3. Non-blocking: line 119 is over the wiki line-length limit. Rewrap
   the style-change paragraph when responding to this review round.

   *Implemented. Line rewrapped.*

## Review round 4

1. Blocker: §2.6 says the Shift+F B warning is emitted only when any
   bump layer has already been collapsed, but the RFC does not define
   how `src/core/inspector/input.js` can know that. Collapsed state is
   currently rig-local (`collapsedNormalGpu` and per-layer `optimizedOut`
   state inside `TileRenderRig`), while the keyboard handler only has
   the map, renderer, and inspector objects. Add a minimal observable
   path, or change the warning rule to one that can be implemented from
   existing state. For example, a conservative keyboard-only warning
   whenever `mapCollapseBumps` is true would be implementable without
   exposing rig internals.

   *Implemented. §2.6 updated to use the conservative rule: warn
   whenever `mapCollapseBumps` is true, without checking actual collapse
   state. If `mapCollapseBumps` is true, any tile resident long enough to
   have completed its collapse pass is already affected, so the warning
   is accurate for the meaningful case. No new observable path or rig
   introspection is needed.*

## Review round 5 — sign-off

The design is accepted. The remaining behavior changes are documented:
the first implementation does not reclaim bump texture memory, collapsed
bump data follows the normal-map push layer after baking, and the
Shift+F B warning uses a conservative keyboard-only rule when
`mapCollapseBumps` is true.

## Review round 6 requested, document back in review

Requesting additional review. The following changes were made to the
accepted design.

§2.1 revised:

- The `necessity` paragraph removed; those fields control rig-level
  draw readiness, not the collapse decision.
- Collapse precondition rewritten in terms of GPU texture readiness.
- Reference added to the `TODO` at tile-render-rig.ts line 987 as the
  implementation hook.
- Push/pop scoping added: the collapse operates only on the innermost
  normal stack level and does not cross `push` or `pop` boundaries.

Implementation steps 2a and 2g updated to reflect the push/pop
boundary rule.

## Review round 6

1. Blocker: implementation step 2a says to reset `normalCleanSlate` on
   every normal-target layer whose operation is `'push'` or `'pop'`.
   The current `Layer` type has `operation: 'push'` for pushes, but pop
   layers are represented as `source: 'pop'` with `operation: 'blend'`
   (`PopLayer` in `tile-render-rig.ts`). Step 2g has the same shorthand
   when it says to stop at intervening `push`/`pop` on the `'normal'`
   target. Rewrite the rule in terms of the actual layer fields:
   normal-target `operation === 'push'` or normal-target
   `source === 'pop'`.

   *Implemented. Steps 2a and 2g updated to use `operation === 'push'`
   and `source === 'pop'` as the boundary discriminants.*

2. Non-blocking: the old sign-off section still says the first
   implementation does not reclaim bump texture memory. The revised
   §1.3 now says memory is reclaimed through normal tile eviction. That
   is compatible with the original point if read as "no explicit
   post-collapse free", but the wording is easy to misread. Consider
   changing the new §1.3 sentence to say "No explicit post-collapse
   free is performed; memory is reclaimed later through tile resource
   eviction." That keeps the accepted review history and current design
   language aligned.

   *Implemented. §1.3 updated to the suggested wording.*

## Review round 7 — sign-off

The revised design is accepted. The push/pop boundary rule now matches
the current `Layer` representation: normal-target pushes use
`operation === 'push'`, and normal-target pops use `source === 'pop'`.
The memory-reclamation wording also matches the implementation rule:
there is no explicit post-collapse free; memory is reclaimed later
through tile resource eviction.

## Review round 8

1. Blocker: the accepted design still makes the baked normal a raw
   rig-local `WebGLTexture`, but surface-tile lifetime is not the normal
   map-browsing lifetime. During ordinary browsing, `MapSurfaceTile`
   objects are created as traversal descends into the metatile tree and
   are kept for reuse. `MapSurfaceTile.kill()` is not called as part of
   normal cache pressure or normal camera movement; it is reached only
   through child removal, explicit subtree kill, or whole-map teardown.
   `MapSurfaceTree.kill()` only drops `surfaceTree`; it does not walk
   the tile tree and call `MapSurfaceTile.kill()` on the root.
   `MapSurfaceTile.validate()` has `this.kill()` commented out. In
   practice, surface tiles created while a user browses around the map
   can live for the rest of the map session. A rig-local baked texture
   would therefore also live for the rest of the session unless the rig
   is replaced by style/view changes.

   This is a GPU memory leak under interactive use. A session that
   visits thousands of tiles can create thousands of 256x256 baked
   normal textures. At RGBA8 that is about 256 KiB per rig, before
   counting current/last rig duplication or multiple submeshes. Because
   the textures are not registered in `map.gpuCache`, the cache cannot
   count them, evict them, or slow further GPU allocation in response to
   them. The memory is untracked and can grow with browsing history, not
   with the currently visible working set.

   Existing GPU resources such as `MapSubtexture` insert a destructor
   into `map.gpuCache` and call `map.gpuCache.updateItem()` when the GPU
   texture is used. The baked normal needs equivalent accounting and
   warming. The RFC should not allocate an unmanaged rig-local
   `WebGLTexture`. It should either:

   - make the baked normal a `gpuCache` item with a destructor, a known
     byte cost, and an update call whenever `encodeLayer()` binds it; or
   - defer the feature until a cache-owned baked-normal object exists.

   If the baked normal can be evicted while the rig survives, eviction
   must be behaviorally reversible. The design must state how the rig
   clears `collapsedNormalGpu` and makes the baked bump layers renderable
   again, or it must avoid marking those source bump layers permanently
   `optimizedOut`.

   *Implemented. §2.2 updated: the baked texture is registered with
   `map.gpuCache` following the `MapSubtexture` pattern. The eviction
   destructor clears `collapsedNormalGpu`, resets `optimizedOut` on all
   collapsed layers, and invalidates the UBO so `optimizeStack()` re-
   runs the collapse on the next frame. `encodeLayer()` calls
   `updateItem()` when binding. Implementation steps 1, 3, and 5
   updated accordingly. Access to `map.gpuCache` follows the existing
   pattern at tile-render-rig.ts line 276.*

## Review round 9

1. Blocker: step 2h says `evictBakedNormal()` invalidates the UBO by
   setting `uboLayers = null`, but the existing `uboLayers` value is a
   live `WebGLBuffer`. `TileRenderRig.dispose()` currently deletes that
   buffer. If cache eviction sets the field to null without first
   calling `gl.deleteBuffer(uboLayers)`, the eviction path leaks one UBO
   per evicted baked normal. The eviction method must delete the old UBO
   before clearing the field, or call a shared helper that does so.

   *Implemented. The destructor now calls `gl.deleteBuffer(uboLayers)`
   before setting `uboLayers = null`. Step 2j updated accordingly.*

2. Blocker: step 2h registers the newly allocated baked texture with
   `map.gpuCache` before step 2i copies the blend result into it.
   `MapCache.insert()` calls `checkCost()` synchronously. The inserted
   baked texture is first in the LRU list, so it will usually survive
   while older items are evicted, but it can still be evicted before
   `insert()` returns if the cache budget is smaller than the baked
   texture cost or if removing older items cannot bring the cache under
   budget. In that case `evictBakedNormal()` clears `collapsedNormalGpu`,
   and the following `copyResult(collapsedNormalGpu)` has no destination.
   Register the baked texture after `copyResult()`, or state the
   post-insert check that aborts the collapse if the cache immediately
   evicted the new texture.

   *Implemented. `gpuCache.insert()` moved to step 2j, after
   `copyResult()`. The texture is populated before the cache can
   evict it.*

3. Non-blocking: step 2h resets `optimizedOut` on every normal-target
   texture blend layer that is currently optimized out. Today those are
   the collapsed bump layers, but the RFC already discusses stack-level
   optimizations. Track the exact collapsed layer indices if this path
   may coexist with any other future normal-target optimization.

   *Implemented. Added `collapsedLayerIndices: number[]` field (step 1).
   Step 2g pushes each collapsed layer's index to it. The eviction
   destructor resets only those indices. The broad scan is removed.*

## Review round 10

1. Blocker: the revised cache design still allows `collapsedNormalGpu`
   to be evicted in the middle of `optimizeStack()`. Step 2d checks
   whether the first un-collapsed bump layer is GPU-ready; that check
   can call `MapTexture.isReady()`, which can create GPU textures and
   insert them into `map.gpuCache`. `MapCache.insert()` can evict older
   items synchronously. If it evicts this rig's `collapsedNormalGpu`,
   `evictCollapsedNormal()` resets `optimizedOut` on the already
   collapsed layers and clears `collapsedNormalGpu`, but the current
   collapse pass continues with the first un-collapsed layer chosen
   before that eviction. The pass can then rebuild from the raw normal
   while skipping earlier layers that were just restored. The design
   must either warm `collapsedNormalGpuCacheItem` before any readiness
   checks that can touch `gpuCache`, or abort and restart the collapse
   pass whenever `collapsedNormalGpu` is evicted during the pass.

   *Implemented. Step 2d changed to a read-only GPU texture check that
   does not trigger upload. New step 2e calls `updateItem()` on the
   existing cache item (if any) before the blend begins, protecting it
   from eviction by any `insert()` calls later in the same pass.*

2. Blocker: step 2j registers `collapsedNormalGpu` with `map.gpuCache`
   after every collapse pass. Incremental collapse means the same
   `collapsedNormalGpu` may be reused on later frames when more bump
   layers arrive. Registering it again would create multiple cache
   items for one WebGL texture and multiple destructors for the same
   rig state. The RFC should say registration happens only when a new
   collapsed texture is allocated, or when `collapsedNormalGpuCacheItem`
   is null after a direct allocation path. Subsequent incremental
   updates should call `map.gpuCache.updateItem()` for the existing
   cache item after `copyResult()`.

   *Implemented. Step 2k (formerly 2j) now branches: `insert()` only
   when `collapsedNormalGpuCacheItem` is null (first allocation);
   `updateItem()` on all subsequent incremental passes.*

3. Non-blocking: step 2j says registering after `copyResult()` ensures
   the texture is populated before the cache can evict it. That is true,
   but insertion can still evict the newly registered texture before
   `insert()` returns if the GPU cache budget is too small for a
   256x256 RGBA8 texture. The design should state that this leaves the
   rig in the uncollapsed state because `evictCollapsedNormal()` has
   restored the collapsed layer indices, and the current collapse pass
   must then stop without assuming `collapsedNormalGpu` still exists.

   *Implemented. Step 2k states: after `insert()`, check if
   `collapsedNormalGpu` is still non-null; if it was immediately
   evicted, abort the collapse pass for this frame.*

## Review round 11

1. Blocker: step 2c still unconditionally requires `this.normalMap` to
   have a ready GPU texture before any collapse pass. That matches the
   first collapse, but not incremental collapse. After the first bump is
   collapsed, later passes use `collapsedNormalGpu` as the source
   accumulator; the original normal-map GPU texture may have been
   evicted from `map.gpuCache`, and reloading it is not needed for the
   next bump. This also reopens the mid-pass eviction hazard: if step 2c
   calls `this.normalMap.isReady()` to reload the normal texture before
   step 2e warms `collapsedNormalGpuCacheItem`, that upload can insert
   into `gpuCache` and evict the existing collapsed normal. Change the
   guard to:

   - when `collapsedNormalGpu` is null, require the base normal-map GPU
     texture to be resident using a read-only check; do not upload it in
     this pass;
   - when `collapsedNormalGpu` is non-null, skip the base normal-map
     residency check and warm `collapsedNormalGpuCacheItem` before any
     operation that can touch `gpuCache`.

   *Implemented. Step 2c now branches on `collapsedNormalGpu`. When
   null: read-only check of the base normal-map GPU texture; when
   non-null: skip the normal-map check and call `updateItem()`
   immediately. The standalone warm step 2e is removed; the warm is
   now part of step 2c. Remaining steps relabeled e–j.*

2. Non-blocking: §2.2 still says the eviction destructor invalidates the
   UBO "by setting `uboLayers` to null." Step 2k now correctly deletes
   the old `WebGLBuffer` before clearing the field. Update §2.2 so the
   design body does not preserve the earlier leaking wording.

   *Implemented. §2.2 updated: destructor now described as deleting
   the UBO with `gl.deleteBuffer` before setting `uboLayers` to null.*

## Review round 12

1. Blocker: step 2j still has an assignment-order hazard in the
   immediate-eviction case. It says to call
   `map.gpuCache.insert(evictCollapsedNormal.bind(this), ...)` and store
   the result, then check whether `collapsedNormalGpu` is null. In
   JavaScript, the right-hand side of an assignment runs before the
   field is assigned. If `insert()` synchronously evicts the newly
   inserted item, `evictCollapsedNormal()` runs while
   `collapsedNormalGpuCacheItem` still has its old value (`null` on
   first allocation). After `insert()` returns, a direct assignment would
   then store the returned cache item even though the cache has already
   removed it and the texture has already been deleted. The rig would
   hold a stale non-null cache item.

   Specify this sequence instead:

   - store the return value in a local `const cacheItem`;
   - if `collapsedNormalGpu` is null after `insert()` returns, leave
     `collapsedNormalGpuCacheItem` null and abort the pass;
   - only assign `collapsedNormalGpuCacheItem = cacheItem` after the
     post-insert survival check passes.

   The same rule should be used for any other cache insertion whose
   destructor can mutate the object receiving the cache item.

   *Implemented. Step 2j updated: `insert()` result stored in a local
   `const cacheItem`; `collapsedNormalGpuCacheItem` assigned only after
   the post-insert `collapsedNormalGpu` null check passes.*

## Review round 13

1. Blocker: the cache-owned design now contradicts §1.3 and §2.5.
   Section 1.3 still says memory is reclaimed through normal tile
   resource eviction, but the revised design reclaims the baked normal
   through `map.gpuCache` eviction or rig disposal. Section 2.5 says
   the collapsed result is not added to the resource tree "or any other
   shared cache"; the revised design explicitly registers it in the
   shared `map.gpuCache` LRU. Update both sections so the accepted
   design has one ownership model:

   - no explicit post-collapse free of source bump textures;
   - the collapsed normal GPU texture is accounted and evicted through
     `map.gpuCache`;
   - the collapsed normal is not added to the resource tree and is not
     key-shareable across rigs in this implementation.

   *Implemented. §1.3 updated: source bump textures are reclaimed via
   tile eviction; the collapsed normal GPU texture is managed by
   `map.gpuCache` and is not tied to tile lifetime. §2.5 rewritten
   with a new heading "Ownership of the collapsed texture": registered
   with `map.gpuCache`, not in the resource tree, not key-shareable.*

## Review round 14

1. Blocker: §1.3 now says source bump texture GPU memory is reclaimed
   when "the tile is evicted from the resource tree." That is not how
   this codebase manages tile or texture lifetime. `MapSurfaceTile`
   objects are kept for reuse during normal browsing and are not evicted
   under cache pressure. `tile.resources` points to a `MapResourceNode`,
   but `MapResourceNode.kill()` does not free the resources stored in
   its `textures`, `subtextures`, `meshes`, or other dictionaries; it
   only recurses children and detaches the node, with a `//kill
   resources?` comment left in the method. Existing texture GPU memory
   is reclaimed by `MapSubtexture.killGpuTexture()` through
   `map.gpuCache`; CPU image memory is reclaimed through
   `map.resourcesCache`. The persistent `MapTexture` / `MapSubtexture`
   objects can remain reachable from the resource tree after their GPU
   payload has been evicted.

   Rewrite §1.3 so it does not mention tile or resource-tree eviction.
   The ownership model should say:

   - source bump textures are not explicitly freed after collapse;
   - source bump texture GPU payloads remain managed by their existing
     `MapSubtexture` `map.gpuCache` entries;
   - the collapsed normal has its own `map.gpuCache` entry and is
     evicted independently from source textures;
   - the resource tree is a lookup/ownership graph for resource objects,
     not the GPU memory eviction mechanism.

   *Implemented. §1.3 rewritten: source bump texture GPU payloads remain
   managed by their existing `MapSubtexture` `map.gpuCache` entries; the
   collapsed normal has its own entry and is evicted independently; the
   resource tree is described accurately as a lookup/ownership graph.*

## Review round 15 — sign-off

The revised design is accepted. The ownership model now matches the
codebase: source texture GPU payloads remain under their existing
`MapSubtexture` cache entries, the collapsed normal has its own
`map.gpuCache` entry, and the resource tree is not described as a GPU
memory eviction mechanism.

## Review round 16 requested

Requesting additional review. The collapsed normal was specified as
`WebGLTexture` throughout the design and implementation steps, but the
codebase type for GPU textures is `GpuTexture`. `gpu.bindTexture()`
takes `GpuTexture`; using a raw `WebGLTexture` would fail at the
`encodeLayer()` binding call.

The following changes were made:

- §2.2, §2.4, §2.5 and all implementation steps: `WebGLTexture` →
  `GpuTexture` for the `collapsedNormalGpu` field and related text.
- Step 2f: `nmblender.blend()` receives `collapsedNormalGpu.texture`
  (the raw handle), since `TextureBlend.blend()` takes `WebGLTexture`.
- Step 2h: allocation uses `new GpuTexture(this.renderer.gpu)` +
  `createFromData(256, 256, emptyData, GpuTexture.Type.Color, 'linear')`
  instead of raw `gl.createTexture` + `gl.texImage2D`.
- Step 2i: `nmblender.copyResult()` receives `collapsedNormalGpu.texture`.
- Step 2j: cache size uses `collapsedNormalGpu.getSize()` instead of
  the hardcoded `256 * 256 * 4`.
- Destructor and `dispose()`: `collapsedNormalGpu.kill()` instead of
  `gl.deleteTexture(collapsedNormalGpu)`.

No logic changes. The `gpuCache` registration, eviction recovery, and
all other design decisions from rounds 8–14 are unchanged.

## Review round 16

1. Blocker: step 2h says to allocate with
   `new GpuTexture(this.renderer.gpu)`, but `GpuTexture` is a
   TypeScript class whose constructor currently requires `gpu`, `path`,
   and `core` arguments. JavaScript callers can omit the latter two
   arguments, but `TileRenderRig` is TypeScript and this call will not
   type-check. Use the existing TypeScript pattern from `renderer.ts`:
   `new GpuTexture(this.renderer.gpu, null as any, this.renderer.core)`,
   or change the `GpuTexture` constructor signature so `path` and `core`
   are optional before this RFC asks `TileRenderRig` to call it with one
   argument.

   *Implemented. Step 2i updated to use the existing TypeScript pattern:
   `new GpuTexture(this.renderer.gpu, null as any, this.renderer.core)`.
   No constructor change required.*

2. Blocker: steps 2f and 2i now pass `collapsedNormalGpu.texture` to
   `TextureBlend.blend()` and `TextureBlend.copyResult()`, but
   `GpuTexture.texture` is typed as `WebGLTexture | null`. The RFC
   should state the null-handling rule at those call sites. A local
   guard after allocation and before each blend/copy is enough:
   `const handle = collapsedNormalGpu.texture; if (!handle) abort`.
   The same applies to the base normal-map handle returned by
   `this.normalMap.getGpuTexture().texture` in the first-collapse path.
   Without this, the planned TypeScript implementation either fails
   strict checking or relies on unchecked non-null assertions in the
   code that calls `TextureBlend`.

   *Implemented. New step 2e extracts `srcHandle: WebGLTexture` for
   the blend source before the blend sequence, aborting if null.
   Step 2j uses `collapsedNormalGpu.texture!` with a documented
   non-null assertion (safe because `createFromData` always sets
   `.texture`). Bump layer handles in step 2h are accessed via
   `.texture` on each layer's GPU texture, which is already guarded
   by the non-null check in the loop condition.*

## Review round 17

1. Blocker: step 2h still does not define a non-null `WebGLTexture`
   handle for each bump layer before calling `TextureBlend.blend()`.
   The current loop condition only says the bump layer's GPU texture is
   non-null. That proves the `GpuTexture` object exists, but
   `GpuTexture.texture` is still typed as `WebGLTexture | null`, and
   `TextureBlend.blend()` requires `WebGLTexture`. Add the same guard
   used for `srcHandle`: extract `const bumpHandle =
   bumpGpu.texture`; stop the loop if it is null; otherwise pass
   `bumpHandle` to `nmblender.blend()`. This keeps the design
   consistent with the strict TypeScript boundary introduced in round
   16.

   *Implemented. Step 2h updated: extract `const bumpHandle =
   bumpGpu.texture`; stop the loop if null; pass `bumpHandle` to
   `nmblender.blend()`.*

2. Non-blocking: step 2j says the non-null assertion on
   `collapsedNormalGpu.texture!` is safe because `createFromData`
   always populates `.texture`. That explains the first collapse, but
   incremental passes do not call `createFromData`; they rely on step
   2e proving the existing `collapsedNormalGpu.texture` handle is
   non-null. Reword the explanation so it covers both cases, or extract
   a `dstHandle` after step 2i and pass that to `copyResult()` without a
   non-null assertion.

   *Implemented. Step 2j replaced with a `dstHandle` extraction plus
   null guard, no assertion needed. Covers both first-collapse and
   incremental passes uniformly.*

## Review round 18 — sign-off

The revised design is accepted. The `GpuTexture` conversion now matches
the current TypeScript API boundaries: `TileRenderRig` constructs the
texture with the existing `renderer.ts` constructor pattern, uses
`GpuTexture` for renderer binding and cache accounting, and extracts
guarded `WebGLTexture` handles only when calling `TextureBlend`.

## Review round 19 requested

Requesting additional review. The following changes were made to the
accepted design.

**Config rename.** `mapBakeBumps` renamed to `mapCollapseBumps`
throughout §2.6 and implementation steps. The term "collapse" is
already used consistently in the RFC; "bake" is not.

**`nmblender` moved to `Renderer`.** §2.7 updated: `nmblender` is now
a `TextureBlend` instance on `Renderer`, constructed in `Renderer`'s
init path. `MapDraw` (`draw.js`) accesses it via
`this.renderer.nmblender`. `TileRenderRig` accesses it the same way.
A new implementation step 1 covers this migration; the old steps are
renumbered 2–7. The `MapDrawTiles` reference in §2.3 corrected to
`Renderer`.

**Collapse fields grouped into `collapsed` object.** §2.2, §2.4, §2.5,
and implementation steps updated. The three fields
(`collapsedNormalGpu`, `collapsedNormalGpuCacheItem`,
`collapsedLayerIndices`) are replaced by a single
`collapsed: { normalGpu, cacheItem, layerIndices } | null` field. Null
means no collapse is active; the three sub-fields are always valid
together. The eviction destructor sets `this.collapsed = null`
atomically. Implementation step 3j describes the two-phase
initialization: `this.collapsed` is set with a `null!` placeholder for
`cacheItem` before `insert()` so the eviction destructor can access
`normalGpu` if immediate eviction occurs; `cacheItem` is assigned only
after the post-insert survival check passes.

**normalCleanSlate logic simplified.** Step 3a rewritten: find the
first `operation === 'push'` layer with `target === 'normal'`; scan
forward from there for bump candidates; stop at the next push/pop
boundary or end of stack. The reset-loop scan is removed. The
single-accumulator constraint is now explicit.

**Render-flag guard removed from collapse pass.** §2.6 rewritten:
collapse is a data-preprocessing step that runs regardless of
`useBumpMaps` / `useNormalMaps`. Flags govern readiness requirements
and what `encodeLayer` binds at draw time. Step 3 (old step 2b) that
checked `getRenderingOptions()` is removed. A new implementation step 4
covers the flag-based readiness changes in `isReady()`. Step 5
(`encodeLayer`) makes a flag-based binding decision: bind
`collapsed.normalGpu` when `useNormalMaps && useBumpMaps`, base normal
map otherwise. The `Shift+F B` interactive warning is removed: toggling
`useBumpMaps` off after collapse now falls back cleanly to the base
normal map without data loss.

## Review round 19

1. Blocker: step 3j initializes `this.collapsed` with
   `layerIndices: []` before calling `map.gpuCache.insert()`, but step
   3g has already marked the newly collapsed bump layers
   `optimizedOut` and stored their indices in `collectedIndices`. If
   `insert()` immediately evicts the new cache item, `evictCollapsed()`
   sees an empty `layerIndices` array and does not restore those layers.
   The rig is then left with no collapsed texture and with source bump
   layers still optimized out. Store `collectedIndices` in
   `this.collapsed.layerIndices` before `insert()`, or delay marking
   layers `optimizedOut` until after cache registration survives. The
   same rollback rule should cover any later abort after step 3g.

   *Implemented. Step 3g updated: layers are not marked `optimizedOut`
   during the blend loop; only `collectedIndices` is collected. Step 3j
   updated: `this.collapsed` is set with `layerIndices: collectedIndices`
   before `insert()`, so the eviction destructor can restore layers if
   immediate eviction occurs. `optimizedOut` is marked only after cache
   registration survives — at that point the collapse is fully
   committed and the destructor already holds the indices to reverse
   the marking if eviction occurs later.*

2. Blocker: the new §2.6 rule for `!useNormalMaps && useBumpMaps`
   says bump GPU textures remain required and no normal map is
   required, but collapsed bump layers have already been marked
   `optimizedOut`. In that flag combination, `encodeLayer()` will not
   bind `collapsed.normalGpu` because normal maps are off, and it will
   not encode the collapsed source bump layers because they are
   optimized out. The result is flat normals with no bump shading,
   contrary to the stated readiness and draw semantics. Either restore
   the earlier accepted behavior change for `useNormalMaps` toggles, or
   define how collapsed layers are made renderable again when
   `useNormalMaps` is false and `useBumpMaps` is true.

   *Implemented. §2.6 updated: `useNormalMaps` is restored as a
   collapse precondition. The baked result is bound through the
   normal-map push layer, so collapse without `useNormalMaps` on would
   make bump data inaccessible. When `useNormalMaps` is false, bump
   layers remain uncollapsed in the stack and are rendered
   individually. `useBumpMaps` remains decoupled from the collapse
   decision. A new step 3a checks `useNormalMaps` before the scan.
   The `!useNormalMaps && useBumpMaps` readiness case in §2.6 and
   implementation step 4 updated to reflect that collapse never runs
   in that state.*

3. Non-blocking: the status line was still `Accepted` after the body was
   edited and review round 19 was requested. I changed it to
   `In review` for this round. When the author reopens an accepted RFC,
   the status must stay `In review` until a reviewer signs off again.

   *Noted. Status line retained as `In review`.*

4. Non-blocking: the open question **`nmblender` ownership** still
   describes the backlog sequence as "removal from `MapDrawTiles`" and
   "moved to `TileRenderRig`". The revised design now moves `nmblender`
   to `Renderer` and keeps `MapDraw` using it via
   `this.renderer.nmblender`. Update that open question so it matches
   §2.7 and implementation step 1.

   *Implemented. Open question updated.*

## Review round 20

1. Blocker: the response to round 19 restores `useNormalMaps` as a
   collapse precondition, but it does not define what happens when
   `useNormalMaps` is turned off after a rig has already collapsed bump
   layers. In that case the collapsed layers are still `optimizedOut`;
   `encodeLayer()` will not bind `collapsed.normalGpu` because normal
   maps are off, and the original bump layers will not be encoded. The
   current §2.6 text says that when `!useNormalMaps && useBumpMaps`,
   "bump layers are always in the stack", which is only true if the
   flag was off before collapse. Either document the accepted diagnostic
   behavior change for post-collapse `useNormalMaps` toggles, or define
   an explicit recovery path that evicts/uncollapses the rig when
   normal maps are disabled after collapse.

   *Implemented. §2.6 `!useNormalMaps && useBumpMaps` split into two
   sub-cases. Before collapse: bump layers are in the stack and visible
   via flatNormal. After collapse with `useNormalMaps` subsequently
   toggled off: bump layers are `optimizedOut` and `collapsed.normalGpu`
   is not bound; bump shading is not visible. Documented as an accepted
   diagnostic-mode behavior change. The data is preserved in
   `collapsed.normalGpu`; turning `useNormalMaps` back on restores bump
   shading via the normal map path. No recovery path is defined.*

2. Non-blocking: implementation step 3 has two substeps labelled `b`.
   The later reference "same rule as step 3b" is therefore ambiguous:
   it could mean the normal-stack boundary scan or the
   `this.collapsed` branch. Renumber the substeps after adding the
   `useNormalMaps` precondition.

3. Non-blocking: §2.1 and §2.3 still use the old
   `collapsedNormalGpu` field name in the current design body. Update
   them to `collapsed.normalGpu` so the accepted text does not preserve
   two names for the same state.

   *Implemented. §2.1 and §2.3 updated.*

   *Implemented. Step 3 substeps renumbered a–k; cross-reference in
   step 3h updated to "same boundary rule as step 3b".*

   *Implemented. §2.6 `!useNormalMaps && useBumpMaps` case split into
   two sub-cases: before collapse (bump layers in stack, visible via
   flatNormal) and after collapse with `useNormalMaps` subsequently
   toggled off (bump layers `optimizedOut`, shading not visible,
   accepted diagnostic-mode limitation; data preserved in
   `collapsed.normalGpu`, restored when `useNormalMaps` turns back on).*

## Review round 21

1. Blocker: §2.6 now correctly splits the
   `!useNormalMaps && useBumpMaps` case into pre-collapse and
   post-collapse-toggle behavior, but implementation step 4 still says
   "collapse never runs in this state, so bump layers are always in the
   stack." That is the old overclaim from round 20. Step 4 must mirror
   §2.6: before collapse, evaluate bump-layer residency; after a rig
   has already collapsed and `useNormalMaps` is later off, collapsed
   bump layers are `optimizedOut`, bump shading is not visible, and no
   recovery path is defined.

   *Implemented. Implementation step 4 `!useNormalMaps && useBumpMaps`
   bullet updated to match §2.6: two sub-cases, mirroring the design.*

## Review round 22 — sign-off

The revised design is accepted. The collapse state, `nmblender`
ownership, and render-flag behavior now match across the design body
and implementation steps. The accepted diagnostic limitation is stated:
if `useNormalMaps` is turned off after collapse, collapsed bump shading
is hidden until normal maps are turned back on or the collapsed texture
is evicted and the layers are restored.

## Review round 23 requested

Requesting additional review after an editorial simplification. The
accepted behavior from round 22 is unchanged.

§2.6 was rewritten around the core invariants instead of enumerating a
four-case flag matrix:

- `mapCollapseBumps` gates the optimization.
- Collapse requires `useNormalMaps`, because the result is bound through
  the normal-map push layer.
- `useBumpMaps` does not decide whether collapse runs; it decides
  whether `encodeLayer` binds the collapsed normal or the base normal.
- Once a bump layer is collapsed, flag toggles do not uncollapse it.
- Turning `useNormalMaps` off after collapse hides collapsed bump
  shading as accepted diagnostic-mode behavior.

Implementation step 4 was shortened to the corresponding readiness
rules: require textures that can affect the current draw, treat
collapsed bump layers as no longer being readiness candidates, and rely
on eviction or disposal to restore them.

## Review round 23

1. Blocker: §2.4 step 3 says "blend the bump texture at its configured
   alpha and mark the layer `optimizedOut`." Implementation step 3g says
   the opposite: do not mark `optimizedOut` here — defer it to step 3k
   after cache registration survives, so that any abort between blending
   and registration leaves the layer stack unmodified. The design body
   and the implementation steps contradict each other on when
   `optimizedOut` is set. Step 3g is correct per the round 19 decision.
   Update §2.4 step 3 to say each ready bump layer is blended and its
   stack index collected in `collectedIndices`; `optimizedOut` is not
   mentioned at this stage.

2. Non-blocking: the editorial shortening of step 4 removes the explicit
   `!useNormalMaps && useBumpMaps` two-sub-case wording that round 21
   required as a blocker and round 22 accepted. The shortened text covers
   the case implicitly — collapsed layers are `optimizedOut` and not
   re-evaluated regardless of flag state — but the connection to the
   accepted diagnostic limitation is no longer stated in step 4.
   Consider adding one sentence to the final bullet: "When
   `useNormalMaps` is off and the rig has already collapsed, this means
   bump shading is not visible — the accepted diagnostic-mode limitation
   stated in §2.6."
