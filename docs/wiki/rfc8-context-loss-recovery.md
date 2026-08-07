# RFC 8: recover from WebGL context loss

**Status:** Draft
**Opened:** 2026-06-11
**Context:** promotes "FEATURE: recover from WebGL context loss" in
[backlog.md](backlog.md); the 2026-06-10 session-log entry on the iOS
interaction crash describes the most common trigger and the resource
model this design builds on.


## 1. Problem

The browser can invalidate a WebGL context at any time: on iOS the
GPU process is killed under memory pressure, on desktops the GPU
driver can reset, and laptops can switch between integrated and
discrete GPUs. The page survives; the context and every GL object in
it do not.

What the library does today:

- `GpuDevice` listens for `webglcontextlost`, calls `preventDefault()`
  (which tells the browser the page intends to handle restoration),
  sets `core.contextLost`, and fires the public `gpu-context-lost`
  event ([device.ts](../../src/renderer/gpu/device.ts)).
- `Map.onUpdate_` stops scheduling animation frames while
  `core.contextLost` is set ([map.ts](../../src/map/map.ts)), and
  `MapLoader.update` stops issuing downloads
  ([loader.js](../../src/map/loader/loader.js)). The freeze is
  clean.
- On `webglcontextrestored`, `contextRestored()` fires the public
  `gpu-context-restored` event and does nothing else. No GL object is
  re-created, so the map stays blank until the page is reloaded.

The goal of this RFC: after the browser restores the context, the map
returns to rendering on its own, with no page reload and no embedder
intervention.


## 2. Why map-level recovery is cheap here

Two facts shape the design.

**The context object survives.** When `webglcontextlost` was answered
with `preventDefault()`, the browser restores the *same*
`WebGL2RenderingContext` object and signals `webglcontextrestored`.
Every `this.gl` reference held across the codebase stays valid; only
the GL objects created through it (textures, buffers, programs, VAOs,
framebuffers, renderbuffers) are invalid and must be re-created.
Extension objects (`anisoExt`) must be re-queried. Calling
`gl.deleteTexture` and friends on invalidated objects is specified as
a no-op, so existing cache destructors can run unchanged for
bookkeeping.

**Tile resources already rebuild themselves.** Every tile-shaped GPU
resource is registered in `Map.gpuCache` with a destructor: subtexture
GPU textures ([subtexture.js](../../src/map/subtexture.js)),
mesh GPU submeshes ([mesh.js](../../src/map/mesh.js)), geodata
views ([geodata-view.js](../../src/map/geodata-view.js)), and
collapsed rig normal textures
([tile-render-rig.ts](../../src/map/tile-render-rig.ts)). The
gpu-cache eviction path — destroy the GPU object, reset the load
state, re-download and re-upload on demand — runs in production every
time the cache budget is exceeded. Since the decoded-image release fix
(branch `bugfix/ios-imagebitmap-release`), the GPU object is the
single resident copy and re-download is the normal repopulation path.

Recovery therefore does not need a resource-restoration mechanism. It
needs a *flush* (run the destructors everywhere, for bookkeeping) and
a *static re-initialization* (re-create the GL objects that are built
once at startup), and the existing lazy machinery does the rest.


## 3. The invariant

Every GPU-resident object is in exactly one of two classes:

1. **cache-tracked** — registered in `Map.gpuCache` with a destructor
   that resets its owner to the not-loaded state; or
2. **static** — created by a re-runnable initialization entry point on
   `Renderer`, `GpuDevice`, or an owning object with an explicit
   re-create hook.

Recovery is then exactly: flush class 1, re-run class 2. Any GL object
outside both classes is a bug under this RFC, and the implementation
must move it into one of them. This is also the review rule for future
code that creates GL objects.

### 3.1 Inventory

Cache-tracked today (flushed by `gpuCache.clear()`):

| owner | objects |
|---|---|
| `MapSubtexture` | tile texture |
| `MapMesh` / `MapSubmesh` | vertex/uv/index buffers, per-program VAOs |
| `MapGeodataView` | job buffers from `gpu/group.js` |
| `TileRenderRig.collapsed` | collapsed normal texture |

Static today (created in constructors or `RenderInit`):

| owner | objects |
|---|---|
| `RenderInit` ([init.js](../../src/renderer/init.js)) | legacy `prog*` programs, heightmap/geo-hitmap/red/white/black/text textures, rect and bbox buffers |
| `Renderer` | lazy `programs{}`, hitmap texture + framebuffer, `uboFrame`, frustum VAO, `nmblender` (`TextureBlend` FBOs) |
| `GpuDevice` | cached fixed-function state, framebuffer-binding cache, extension objects |
| `Atmosphere` | `uboAtm`, quad VAO and buffers |
| `DrawTraversalMaskPool` | per-depth mask textures + framebuffers, scratch/consume masks, quad and rect VAOs |
| `GpuFont` ([font.js](../../src/renderer/gpu/font.js)) | glyph textures |
| `TileRenderRig` | `uboLayers` (per rig, created lazily, not cache-tracked) |

Outside both classes today, to be resolved during implementation:

- `TileRenderRig.uboLayers` is per-rig and lazy. `isReady` re-creates
  it when absent, so the flush must walk live rigs and null it (or the
  rig must compare a context generation counter, section 4.4).
- `GpuMesh` caches VAOs keyed by `GpuProgram` instance. Re-created
  programs are new instances, so stale keys cannot collide; the cache
  is destroyed with the mesh in the gpu-cache flush.
- The inspector and debug overlays hold GL objects; audit during
  implementation.


## 4. Design

### 4.1 Ownership

`GpuDevice` detects loss and restoration and resets its own state.
`Renderer` re-creates renderer-owned statics. `Map` flushes its caches
and resumes the frame machinery. `Core` re-kicks the animation-frame
chain, which it owns. Each class recovers what it owns; nothing
reaches across.

### 4.2 Restore sequence

On `webglcontextrestored`:

1. **`GpuDevice`** — re-query extensions, reset the framebuffer-binding
   cache and profiling counters, re-apply the cached fixed-function
   state with `setState(currentState, true)`, and re-install the
   canvas render target.
2. **`Renderer`** — drop and re-create statics: re-run `RenderInit`,
   clear `programs{}` (the lazy accessors recompile on demand),
   re-create the hitmap texture and framebuffer, `uboFrame`, the
   frustum VAO, `nmblender`, and the draw-traversal mask pool.
3. **`Map`** — `gpuCache.clear()`, reset `stats.gpuTextures` and
   related counters, null `uboLayers` on live rigs, re-create the
   atmosphere GPU objects, `markDirty()`.
4. **`Core`** — clear `contextLost` and call `onUpdate()` to restart
   the animation-frame chain (it stopped scheduling itself when the
   flag was set).

The loader resumes by itself once `core.contextLost` is false; the
first frames then schedule re-downloads exactly as after a cache
eviction storm.

### 4.3 Failure modes

- **Restore never fires.** Safari does not guarantee a prompt
  `webglcontextrestored`. The library stays suspended, exactly as
  today; the public `gpu-context-lost` event lets the embedder decide
  to rebuild the viewer. Documenting that fallback is part of this
  RFC.
- **Loss during recovery.** The sequence runs from the restore event
  of the most recent loss; a new loss sets `contextLost` again and the
  sequence simply runs again on the next restore. Steps must therefore
  be re-runnable.
- **Repeated loss/restore cycles.** Same property: each cycle is a
  full flush + re-init.

### 4.4 Open question — generation counter

An alternative to explicit flush walks (e.g. for `uboLayers`): a
context generation integer on `GpuDevice`, incremented on each
restore, with lazy creators comparing their stored generation before
reusing a GL object. This trades walk code for a check on hot paths.
The walk is preferred where an owner list already exists; the counter
is the fallback for owners that are hard to enumerate. To be settled
during implementation.

### 4.5 TypeScript alignment

The recovery entry points live in TypeScript: `GpuDevice` and
`Renderer` are TS, and `Map` (map.ts) coordinates the map-level step.
Legacy JS modules are reached through the smallest hooks:

- `RenderInit` (init.js) is already a re-runnable constructor-style
  function; recovery re-runs it rather than migrating it first. When
  feature work later touches a resource it creates, that resource
  moves to a TS `Renderer` method, shrinking init.js — the standard
  feature-driven migration path.
- `GpuFont` and `gpu/group.js` objects are reached through their
  owners (renderer text rendering, geodata views); the geodata views
  are already cache-tracked, and fonts get a re-create hook.

No new JS modules; any new file this RFC introduces is TS.


## 5. Testing

`WEBGL_lose_context` makes the whole feature testable on desktop
Chromium: `gl.getExtension('WEBGL_lose_context').loseContext()` and
`.restoreContext()` drive the real event sequence. A Playwright test
on the dev server:

1. Load a regression URL, wait for settle, screenshot (reference).
2. Trigger `loseContext()`, assert the map suspends without console
   errors and the `gpu-context-lost` event fires.
3. Trigger `restoreContext()`, wait for settle, screenshot.
4. Assert the post-restore screenshot matches the reference and no
   console or page errors occurred.
5. Repeat the cycle at least twice in one session.

Run this for `simple-terrain`, `complex-terrain`, and `full-terrain`.
Manual verification on an iOS device (where loss happens naturally
under memory pressure) is a secondary, non-blocking check.


## 6. Implementation steps

1. Complete the GL-object inventory (section 3.1), including the
   inspector and debug overlays, and classify every holder.
2. `GpuDevice`: restore handler with device-state reset; decide the
   generation-counter question (4.4).
3. `Renderer`: static re-initialization entry point covering the
   section 3.1 static table.
4. `Map`: gpu-cache flush, stats reset, rig walk, atmosphere
   re-creation; `Core`: loop restart.
5. Playwright loss/restore test under `test/`, wired to the three
   regression URLs.
6. Documentation: gpu-subsystem.md section on the recovery contract
   and the section 3 invariant; embedder-facing note on the
   no-restore fallback.
