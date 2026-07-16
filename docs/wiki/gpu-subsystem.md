# GPU subsystem

This page records low-level WebGL/GPU subsystem rules. It is the entry
point for details that are too specific for
[architecture.md](architecture.md) but affect renderer correctness
across features.

Related pages cover focused parts of the subsystem:

- [render-targets.md](render-targets.md) — render-target ownership
  and auxiliary framebuffer policy.
- [rendering-sizes.md](rendering-sizes.md) — canvas, framebuffer,
  logical, physical, and visual-scale size relationships.
- [renderer-coordinate-spaces.md](renderer-coordinate-spaces.md) —
  projection and target-local 2D coordinate conventions.
- [normal-encoding.md](normal-encoding.md) — normal-map encoding and
  texture-space filtering rules.
- [rfc4-bump-bake.md](rfc4-bump-bake.md) — historical design notes for
  GPU texture preprocessing and cache ownership.

## Ownership

`Renderer` owns shader programs, draw calls, and public draw helpers.
`GpuDevice` owns the WebGL2 context, current render target,
framebuffer/viewport binding, texture binding helpers, program binding,
and cached fixed-function state.

Map code decides what should be drawn. Renderer/GPU code issues the GL
work and owns GL invariants.

## Frame Profiling

`src/core/map/frame-profiler.ts` measures frames that actually draw. It
brackets `Map.draw()` and overlay rendering from `src/core/map.ts`, so
loader promotion and event dispatch are outside the measured render
section.

CPU render time, realized wall-clock cadence of drawn frames, draw-call
count, render texture-bind count, and framebuffer-switch count are always
sampled. `GpuDevice` supplies the GL counters: draw calls are counted by
wrapping WebGL draw entry points, render texture binds are counted by the
`GpuDevice.bindTexture()` wrapper, and framebuffer switches are counted
by the device framebuffer binding helper.

GPU timer-query sampling is separate. It is enabled by `mapProfileGpu`
and uses `EXT_disjoint_timer_query_webgl2`. The default map runtime keeps
it off. Diagnostic entry points may enable it explicitly: the stats panel
turns it on while visible and restores the previous setting on close, and
the performance runner adds `mapProfileGpu=1`.

GPU timer queries measure elapsed work on the GPU timeline, not
JavaScript wall-clock time. Local probes on `complex2` and `simple`
showed GPU-derived FPS limits matching independent RAF cadence on
representative views, so GPU timing is the preferred bottleneck metric
when enabled. With GPU timing disabled, `renderMs` and
`limitFps` are CPU-frame metrics. With GPU timing enabled and valid
samples available, `renderMs` and `limitFps` report the CPU/GPU
bottleneck while `cpuMs` and `gpuMs` expose the two components.

## Fixed-Function State

`GpuDevice.setState()` owns cached WebGL fixed-function state:
`blend`, `stencil`, `zwrite`, `ztest`, `zequal`, and `culling`.

The cached `currentState` must match actual GL state after context
initialization and after every direct GL state call. A direct
`gl.depthMask`, `gl.enable`, or `gl.disable` that does not keep the
cache aligned can make later `setState()` calls skip required GL work.
Context initialization sets `currentState` to the renderer baseline,
then calls `setState(currentState, true)` so the state cache remains the
single source of truth and `setState()` remains the only translator from
state fields to raw GL calls.

### Current Contract

Draw sites in the legacy renderer normally leave their state active.
This is the current performance-oriented convention: a terrain draw,
background draw, label draw, or debug draw may leave blend, depth test,
depth write, stencil, or culling state changed. The next draw or pass
setup is responsible for applying the state it requires.

Pass boundaries must be defensive. Binding a render target, clearing a
target, switching to a hitmap pass, and returning to the canvas cannot
assume that the previous draw left GL in a friendly state.

Any helper that clears depth must enable depth writes for the clear and
then restore the cached `zwrite` state. WebGL depth clears respect
`gl.depthMask(false)`, so a depth clear with depth writes disabled does
not update the depth buffer.

Small public helper draws may save and restore `gpu.currentState` when
they are meant to be non-invasive. This is local politeness, not the
general frame-draw contract.

### Deferred Alternative

The backlog entry
`REFACTOR: replace gpu.setState with per-method GL state push/pop`
describes a possible renderer redesign. In that model, each draw method
would save the GL flags it needs on entry, apply them, and restore them
on exit. That is not the current rule.

Do not add a renderer-wide state stack or blanket push/pop policy
without a renderer redesign. It would change the current ownership
model and add per-draw overhead.
