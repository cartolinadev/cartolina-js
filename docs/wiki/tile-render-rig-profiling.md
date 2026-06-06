# TileRenderRig profiling

Settled-state per-frame GPU cost of the style-era terrain color shader,
measured on `simple.json` at a 2560×1353 viewport. The shader is the one
`TileRenderRig` drives through `tile.frag.glsl`: a runtime layer
interpreter that loops over the encoded layer stack and maintains a
color/normal stack per fragment.

This page records the method, the cost decomposition, two confirmed
optimization wins, and one candidate that measurement did not confirm.
It is diagnostic analysis, not a design; the design follow-ups live in
[backlog.md](backlog.md).

## Scene and method

- URL: `demos/map/?style=…/simple.json&pos=obj,12.385445,46.827905,fix,`
  `1.50,-0.09,-90.00,0.00,37987.15,30.00`. A near-nadir view of a single
  watertight DEM surface (`viewfinder-dem3`), default terrain styling
  (illumination, vertical-exaggeration, atmosphere, shadows; no color
  texture, so the result is a gray hillshade).
- Profiler: the frame profiler (see [gpu-subsystem.md](gpu-subsystem.md)),
  read from `window.__vtsPerf.frame` with `mapExposeFpsToWindow=1` and
  `mapProfileGpu=1`. A per-frame `requestAnimationFrame` redraw pump
  forces continuous drawing so the profiler measures real rendering.
- Harness: `tmp/perf/probe_2560.js` (headless Chromium with
  `--use-angle=gl --enable-gpu --ignore-gpu-blocklist`, fixed viewport,
  `deviceScaleFactor` argument for the pixel-count sweep). Feature flags
  and `rendererAntialiasing` are passed as URL parameters; shader
  variants were edited directly in `tile.frag.glsl` and reverted after
  each measurement.

### Hardware and the clock-drift caveat

All numbers are from one Intel Alder Lake iGPU
(`ANGLE (Intel, Mesa Intel(R) Graphics (ADL GT2), OpenGL 4.6)`). With
the harness GPU flags, headless Chromium uses this real GPU and exposes
`EXT_disjoint_timer_query_webgl2`; only default headless (no flags) falls
back to software SwiftShader with no timer query.

The absolute GPU-timer values drift with the iGPU dynamic clock: roughly
10–30% between runs, and up to ~2× when a light shader finishes fast
enough to let the clock drop mid-measurement (seen as bimodal samples).
Consequences:

- Directional findings are robust and reproducible.
- Absolute magnitudes are ranges, not point values. Where a small
  difference mattered, it was measured with a clock-matched A/B
  (alternating builds back-to-back) and the minimum of several runs,
  not a single reading.

Run-to-run variance also means the `deviceScaleFactor=1.5` sweep point
came back non-monotonic (AA-off slower than AA-on, which is impossible);
that point is discarded and only the `dpr=1` numbers are load-bearing.

### A note on stale bundles

The first measurement pass was invalid: the running `webpack serve`
process held a stale ts-loader cache and served an old bundle behind an
error overlay, while `npx tsc --noEmit` was clean. The browser console
showed the compile error; the drawn scene did not match current source.
Always check the browser console for a webpack/ts compile error before
trusting any measurement, and restart the dev server when the source
tree has changed under it.

## Settled state

85 draw calls, 85 render texture binds, 0 framebuffer switches — one draw
and one texture bind per drawn tile. CPU frame time is ~3 ms and barely
moves with resolution, so the 85 draws and binds are not the bottleneck;
batching them would not help.

## The cost is fill-bound

Holding the scene and LOD fixed and scaling only framebuffer pixels (LOD
is chosen from logical size, so the draw count stays 85):

| framebuffer | Mpix | GPU ms | CPU ms |
|---|---|---|---|
| 1280×676 | 0.87 | 9.4 | 1.2 |
| 2560×1353 | 3.46 | 17 | 2.8 |

GPU time tracks pixel count while CPU is flat: the frame is fragment/fill
bound. There is no occlusion to reject — the view is near-nadir over one
watertight surface, so depth complexity is ~1.

## Cost decomposition (dpr=1, 3.46 Mpix)

Measured on the no-discard base with MSAA off, to isolate per-pixel
shader work from the MSAA interaction described below:

| layer of cost | GPU ms |
|---|---|
| pure fill (constant output, no loop, no taps) | ~5.0 |
| one texture tap added | +0.5 |
| full layer-loop shader | ~10–11 |

So the frame splits roughly in half: ~5 ms irreducible fill (writing
3.46 M pixels once on this iGPU) and ~5–6 ms shader compute. Within the
shader compute, the optional shading features are individually cheap
(lighting, normals, atmosphere each under 1 ms on the clean base); the
bulk is the fixed per-fragment machinery — the layer loop, `decodeLayer`,
the color/normal stacks, and the normal sampling.

## Optimization findings

### WIN 1 — remove `discard` from the common tile shader (~4.5 ms)

The tile shader contains `discard` in two places: the coverage-mask test
in `tile.frag.glsl` and the quadrant clip `applyTileClip` in
`shaders/includes/tile-clip.inc.glsl`. Any reachable `discard` makes the
driver
defer the depth test, and on this stack it also defeats the MSAA
fast-clear / compression path. Crossing discard with MSAA at dpr=1:

| | MSAA on | MSAA off |
|---|---|---|
| discard on (baseline) | 15.6 | 10.5 |
| discard off | 11.05 | ~10.0 |

The single effects are small (MSAA alone ~0.9 ms, discard alone ~0.3 ms)
but together they cost ~5.4 ms over the floor — a ~4.2 ms interaction
term. Removing `discard` recovers it: 15.6 → 11.05 ms at dpr=1 (~29%),
and as a side effect makes MSAA nearly free again. The win is not from
early-Z rejecting overdraw (there is none here); it is the discard×MSAA
interaction.

This is visually lossless on watertight, unclipped, maskless tiles —
exactly the traversal's watertight fast-path set. Those tiles need
neither the coverage mask nor the quadrant clip, so a discard-free tile
color shader produces identical output. Confirmed pixel-equivalent
(`tmp/perf/probe-no-discard`
`.png` vs the baseline: full terrain, no holes).

The ~4.5 ms / 29% figure comes from the 2×2 matrix above, assembled from
separate builds rather than a single clock-matched A/B, so it carries the
clock-drift uncertainty noted earlier. The win is large and the
interaction pattern is clear, but a clock-matched A/B (as done for the
layer-VM split) should firm the exact number before it is quoted as a
target; the backlog entry's acceptance criteria require that.

### WIN 2 — split the layer VM into a specialized straight-line shader (~1.5 ms)

Replacing `simple.json`'s runtime layer loop with the unrolled
equivalent — same per-fragment work (same 4-tap normal sample, same
`diffuseCoef` / `tangentialFrame2Wc` / `atmColor` / shadow math), but no
`for` loop, no `decodeLayer`, no push/pop stack, no layer-UBO reads —
is pixel-equivalent (max per-channel diff 1 LSB, 0% of pixels differ by
more than 4).

Clock-matched A/B (alternating builds, MSAA off, dpr=1): the layer-VM
machinery costs **~1.0–1.9 ms** (paired deltas of 1.34/1.73 ms on minima,
1.05/1.88 ms on medians), about 15% of the no-discard frame. The data
shape — each shading feature under 1 ms, yet the assembled loop adds
~1.5 ms — is consistent with register pressure and branch divergence from
the stack arrays and the per-iteration layer record, rather than raw ALU
or texture volume.

The raw speed win is modest. The stronger case for specialization is
elsewhere: it is the same outcome the
`REFACTOR/PERF: split tile rendering execution` backlog entry pursues for
extensibility and a future WebGPU backend, with a "specialized fast path
for common simple stacks." For a simple stack the executor split produces
essentially this straight-line shader, and the ~1.5 ms is a bonus rather
than the motivation.

### Not confirmed — drop octahedral normal re-encoding (4-tap → 1-tap)

`sampleNormal` does manual bilinear filtering of octahedral normals: 4
texture taps plus 4 `decodeOct` per fragment, because the octahedral
encoding is discontinuous across the hemisphere fold and cannot use
hardware bilinear ([normal-encoding.md](normal-encoding.md)). The fold
exists only to represent `z < 0` normals (overhangs); DEM-derived normals
always have `z > 0` — a height field cannot overhang — so for the
heightfield driver the fold is dead weight, and within the upper
hemisphere the encoding is continuous, so a single hardware-filtered tap
is visually clean (verified, max diff ~1 LSB).

The collapse to a single tap is therefore valid for the heightfield case,
but a clock-matched A/B on the specialized base (4-tap vs 1-tap, 8 reps
per build, two cycles) found **no GPU win above the clock-noise floor**.
Both variants fell into the same clock clusters (~7 ms and ~9.2 ms) with
matching minima (6.99 vs 6.92 ms), and one 4-tap run produced a 4.42 ms
sample — faster than every 1-tap sample, which is only possible if the
tap-count difference is below the measurement floor. The likely reason is
that the normal map is small (256²) and texture-cache-resident, so the
three extra taps are nearly free and overlap the surrounding ALU.

An earlier reading suggested a ~1.5 ms win; that was an artifact of
comparing samples taken at different iGPU clock states, the exact error
the clock-drift caveat warns against. So: dropping the octahedral fold is
defensible for format and shader simplicity, but it is **not** a measured
performance win at this resolution on this iGPU. It could still matter on
a bandwidth-starved GPU or with larger normal textures, and it carries
tileserver blast radius (normal-map encoding is produced server-side), so
it should not be pursued for performance without first measuring a gain
on target hardware.

## Stacked potential

Both confirmed wins are visually lossless and independent; together they
take the AA-on canvas from ~15.6 ms (64 fps limit) toward ~8 ms (~125 fps
limit) at dpr=1, landing near the ~5–7 ms fill floor. Past that floor
there is nothing to win at this resolution without reducing pixels. The
octahedral-tap change adds nothing measurable on top here.

## Related

- [gpu-subsystem.md](gpu-subsystem.md) — frame profiler and GPU
  ownership.
- [normal-encoding.md](normal-encoding.md) — octahedral encoding and the
  overhang rationale behind the unconfirmed normal-tap change.
- [backlog.md](backlog.md) — the discard fast-path entry and the
  `split tile rendering execution` entry.
- [rendering-architecture.md](rendering-architecture.md) —
  `TileRenderRig` ownership.
