# Geodata and label rendering profiling

Where the CPU frame goes on a label-heavy, high-oblique view. The
terrain color stage was profiled and specialized separately (see
[terrain-shader-performance.md](terrain-shader-performance.md)); once
that stage stopped being the limiter, the frame turned out to be bound
by the legacy geodata and label draw path, not by terrain shading.

This page records that finding, why the cost has the shape it does, and
the design changes that would move it.

## Scene and method

A high-oblique, label-dense view of the `complex` test style at
2560×1353, looking across terrain toward the horizon so that lettering
and other vector features fill the frame from near to far. Frame timing
comes from the frame profiler; the CPU breakdown comes from a sampling
CPU profile taken over several seconds of continuous redraw, aggregated
by the operation each sample falls in.

Measured on one Intel Alder Lake integrated GPU. As with the terrain
measurements, absolute magnitudes carry the usual dynamic-clock
uncertainty and the CPU shares drift by a few points between runs, but
the shape is stable and reproduces across runs.

## The frame is CPU-bound

At this view the frame settles near 25 fps. The CPU frame is roughly
40 ms; the GPU frame is roughly 15 ms. The GPU has ample headroom — a
free GPU would still leave the frame at the CPU ceiling. Whatever is
spent on terrain shading, including the specialized color shader, is
off the critical path here.

## Where the CPU time goes

About seven tenths of the CPU frame is the legacy geodata and label
renderer. It divides into three per-frame operations, each scaling with
the number of visible features:

- **Ordering the visible features.** Every frame the whole visible
  feature set is sorted by importance so that the most significant
  labels win placement. This single sort is about a fifth of the CPU
  frame.
- **Anti-overlap placement.** The renderer then walks the ordered
  features and tests each candidate against the labels already placed,
  rejecting those that would collide. The collision test and the
  rectangle bookkeeping behind it are about a tenth of the frame.
- **Per-feature draw dispatch.** Each surviving label and vector
  feature is drawn as its own small job, and each job sets up its own
  transform, uniforms, and buffer bindings before it draws. This
  dispatch, together with the group draw and draw-command assembly that
  feed it, is over a third of the frame — the largest single block.

The remainder is per-feature projection and placement math, and garbage
collection of the intermediate state the pipeline allocates and discards
each frame.

## Why the cost has this shape

Two design properties make the pipeline expensive on this class of view.

**It rebuilds from scratch every frame.** The ordering, the collision
placement, and the job dispatch all run in full on each frame. On a
static camera the inputs are identical from frame to frame, so the
sorted order and the placement result are identical too, yet both are
recomputed. The pipeline keeps no memory of the previous frame's
decision to reuse when nothing has changed.

**High obliqueness inflates the feature count.** A near-nadir view sees
a bounded patch of ground; a high-oblique view sees all the way to the
horizon, packing a large and increasing number of features into a thin
band of far-field pixels. The ordering and the collision placement pay
for every one of those features even though most are immediately culled
by collision or fall below the on-screen density limit. The cost scales
with what is in view, and obliqueness maximizes what is in view.

**Dispatch is per feature, not batched.** Hundreds of features each
incur a full state setup before a small draw. This fixed per-job
overhead dominates the actual drawing; it is a property of treating
every feature as an independent draw rather than a consequence of pixel
or geometry volume.

This is the vts-browser-derived draw path. It is the same legacy path
that the rig-execution split and the vector-layer work target for line
and polygon features; see backlog entries
[36](backlog.md#backlog-36) and [61](backlog.md#backlog-61).

## Directions

Ordered by leverage on this view:

- **Reuse across unchanged frames.** The ordering and placement produce
  the same result whenever the camera and the visible feature set have
  not changed. Detecting that and reusing the previous frame's placement
  removes the largest recurring block of work on a still or slowly
  moving view. This is contained to the legacy renderer.
- **Cull the far field before ordering.** Most horizon-band features are
  discarded after being sorted and collision-tested. Culling by distance
  or on-screen density ahead of the sort shrinks the count that both the
  sort and the placement pay for.
- **Batch the dispatch.** Grouping features that share draw state, and
  sorting by that state, removes the bulk of the per-job setup. This is
  the largest single block and the one most tied to a structural change.

The terrain color stage needs no further attention on this view; it is
already off the critical path.

## Related

- [geodata-rendering.md](geodata-rendering.md) — the current geodata
  render path this profile measures.
- [terrain-shader-performance.md](terrain-shader-performance.md) — the
  terrain color stage, profiled and specialized separately.
- [backlog.md](backlog.md) — the geodata-pipeline entry (61) and the
  rig-execution split (36).
