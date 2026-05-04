# Label Regression Diagnostics

This page describes the diagnostic workflow used for point-label
regressions in the NACIS presentation. The same structure applies to
other label bugs where a named feature appears in one build but not
another.

## Capture Script

Use `test/diagnostics/label-pipeline.js` to capture the last
`LABEL_PIPELINE` console payload from a page:

```bash
node test/diagnostics/label-pipeline.js \
  tmp/labels.json \
  http://localhost:3000/#/30 \
  Brennkogel \
  1200x800
```

Arguments:

- output JSON path
- URL, default `http://localhost:3000/#/30`
- optional label substring
- viewport, default `1200x800`
- wait time in milliseconds, default `35000`

The script always reports the URL, viewport, wait time, frame, apparent
size, stage counts, first console/page/request errors, and matching
labels per stage when a label substring is provided.

Record the viewport with every run. A visual regression reported at one
viewport may not reproduce at another, especially when CSS transforms are
involved.

## Branch Setup

Use one reusable diagnostics branch for the known-good commit. Reuse it
as long as the known-good commit has not changed.

Use the current feature branch as the regression side when possible. If
diagnostic edits need isolation, create a clearly named branch from the
feature branch, for example `diag/nacis-fix-brennkogel`.

Apply equivalent instrumentation on both sides. Do not compare a branch
with extra checks against a branch without those checks.

## Label Pipeline Stages

The useful pipeline stages are:

- `drawGpuJob`: renderer received the job for the frame.
- `noOverlapInput`: `processNoOverlap` started for the job.
- `noOverlapExit`: `processNoOverlap` returned before queueing the job.
- `gmapInput`: job entered the label-reduction queue.
- `gmapSorted`: job was sorted by label importance.
- `gmapPlaced`: `gmap` tried to place the job into `rmap`.
- `rmapDepth`: depth test was evaluated for the label.
- `rmapRejected`: `rmap.addRectangle()` rejected the label.
- `rmapStored`: label rectangle was stored in `rmap`.
- `rmapFlushed`: stored rectangle was flushed into the draw buffer.
- `hbuffer`: label entered hysteresis buffering.
- `hysteresisDecision`: hysteresis decided whether to draw it.
- `hsortInput`: label entered final hysteresis sorting.
- `hsortOutput`: label left final hysteresis sorting.
- `output`: label reached final draw output.

## Reading Divergence

Find the first stage where the known-good and regression outputs differ.
Do not start with the final missing label and reason backward.

Common interpretations:

- Present in `drawGpuJob`, absent in `noOverlapInput`: job readiness,
  job type, or early draw-job filtering.
- Present in `noOverlapInput`, absent in `gmapInput`: projection, depth
  range, label-free margins, `rmap.checkRectangle()`, or
  `processNoOverlap` bounds.
- Present in `gmapInput`, absent in `gmapPlaced`: label-reduction budget
  or sort order.
- Present in `gmapPlaced` with `placed: false`: `rmap.addRectangle()`
  rejected it. Inspect `rmapRejected`.
- `rmapRejected` with `reason: depth`: hitmap/depth sampling or genuine
  terrain occlusion.
- Present in `rmapStored`, absent in `rmapFlushed`: rectangle flush or
  buffer state.
- Present in `rmapFlushed`, absent in `output`: hysteresis, final sort,
  or final draw path.

## Coordinate-Space Checks

For CSS-transformed presentations, always log:

- projected anchor and label rectangle
- `renderer.apparentSize`
- `currentRenderTarget.cssLayoutSize`
- `rmap` bounds
- hitmap sample coordinate
- coordinate space passed to depth or hit APIs

Known failure patterns:

- Apparent projected labels checked against layout `rmap` bounds clip a
  right/bottom band before `gmap`.
- Apparent projected labels sampled as layout coordinates in `getDepth`
  read the wrong hitmap pixel and may be rejected as terrain-occluded.

## Temporary Instrumentation

Renderer instrumentation should be temporary unless a debugging flag is
deliberately designed. Add targeted `console.log` output, capture both
branches, and remove or stash the instrumentation before committing the
fix.

Do not leave a trial fix in place if it does not explain the measured
divergence. Revert failed trials before adding the next hypothesis.
