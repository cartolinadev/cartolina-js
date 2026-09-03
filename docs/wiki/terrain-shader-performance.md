# Terrain color shader performance

Why the terrain color stage was specialized. This is the design record
of the problem that specialization solved: the shape of the cost, why a
general per-fragment interpreter was the wrong tool for the hot path,
and the reasoning that led to baking the layer stack into straight-line
code.

It supersedes the earlier raw profiling notes in
[tile-render-rig-profiling.md](tile-render-rig-profiling.md), which
measured the pre-specialization shader and is kept only as the original
diagnostic record.

## The terrain color stage

The final color of a terrain pixel is a composition of styled
contributions: a base color, one or more textures, illumination from
the surface normal, bump and normal-map detail, atmosphere, and shadow.
The style decides which contributions apply and how they combine. That
description is fixed for a given style and is handed to the renderer per
draw, carrying the dynamic values a draw needs — texture transforms,
blend strengths, constant colors.

## The original approach and its cost

The first implementation executed that description at the wrong time.
One fragment shader read the encoded composition and carried it out per
fragment: it walked the list of contributions, branched on each one's
role, selected textures by a runtime index, and held intermediate
results on a small stack inside the shader. In effect the shader was a
general interpreter for the style's layer stack, running once per pixel.

The trouble is that this generality has a cost the shading math does
not. The shader pays for being able to run any stack, on every fragment,
no matter how simple the actual stack is. Three parts of that generality
are particularly expensive on a GPU:

- **The in-shader stack.** The hardware cannot address its registers by
  a value computed at runtime. A stack indexed by a running depth
  therefore cannot live in registers; it is emulated by a chain of
  comparisons on every read and every write, and it spills the working
  set out of the register file.
- **Texture selection by runtime index.** Choosing which bound texture
  to sample from a runtime index is the same emulation — a comparison
  chain over all the bound textures on every sample.
- **The per-fragment interpretation itself.** The branch on each
  contribution's role, and the re-reading of the encoded description,
  are repeated for every pixel.

Measurement bore this out. On a plain single-surface view the frame is
fill-bound: roughly half of it is the irreducible cost of writing the
pixels once, and the rest is shading. Within the shading, each
individual feature — lighting, normals, atmosphere — is cheap on its
own. The interpreter machinery is a separate slice on top of that,
about a sixth of the shading frame, and its cost profile points at the
register pressure from the emulated stack rather than at heavy
arithmetic. A separate and larger finding sat alongside it: a reachable
discard in the shader defeated the depth and multisample fast paths and
cost far more than the small test it guarded, on the order of a third of
that view's frame.

## The reasoning to specialization

The key observation is that the composition is chosen per style, not per
fragment. Every pixel of a given draw runs the same stack in the same
order. Interpreting that stack anew for each pixel repeats a decision
that was already settled before the draw began.

So the interpretation belongs at the moment the shader is built, not
inside the fragment loop. Bake the fixed structure — which
contributions, in which order, combined how — into straight-line code,
and keep only the genuinely per-draw values in the uniform buffer. The
shader stops being a general machine and becomes the specific program
the style actually needs.

Once the structure is constant, the expensive parts of the generality
disappear on their own. The stack depth is known at each step, so the
in-shader stack becomes ordinary named values in registers and its
emulated indexing vanishes. The texture index is known, so its selection
collapses to a direct sample. The role branches fold away, leaving only
the path each contribution actually takes. None of this changes the
shading math or the per-draw dynamic values; it removes the cost of
deciding, per pixel, what was already fixed per style.

## Outcome

Specialization was implemented on this basis: the renderer builds a
straight-line shader for the structural shape of a style's layer stack
and caches it, while the uniform buffer continues to carry the dynamic
values. On heavily composited views this removed the interpreter cost
described above.

It also clarified the ceiling. On label-heavy, high-oblique views the
terrain color stage is no longer the frame's limiter; the cost there
sits in the geodata and label pipeline instead. That analysis lives in
[geodata-rendering-profiling.md](geodata-rendering-profiling.md).

## Related

- [rendering-architecture.md](rendering-architecture.md) — the
  map/renderer boundary and where terrain composition sits.
- [geodata-rendering-profiling.md](geodata-rendering-profiling.md) —
  the pipeline that limits label-heavy views.
- [tile-render-rig-profiling.md](tile-render-rig-profiling.md) — the
  original pre-specialization profiling record, superseded by this page.
- [backlog.md](backlog.md) — the rig-execution split (36) that carries
  specialization toward a general executor.
