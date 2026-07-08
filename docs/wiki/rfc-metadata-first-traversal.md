# RFC 9: metadata-first terrain traversal

**Status:** Largely salvaged; implementation incomplete

## Context

RFC 3 introduced the combined recursive terrain traversal. The traversal
walks one tile-position tree shared by all active terrain surfaces and
renders front-to-back on backtrack.

The current implementation treats a surface as active at a child node
only when that child metanode is ready in the current frame. A missing
child metanode removes the surface from the child active set for that
frame. This makes traversal decisions depend on metatile arrival order.

## Motivation

The traversal currently assumes that fitted watertight surfaces are close
enough substitutes for each other. Under disciplined data this holds: if
several surfaces fit the same screen-space error at a node, any fitted
watertight one should produce a perceptually equivalent terrain result.

Real data can violate that assumption. Two surfaces may have comparable
screen-space error estimates while representing different source
geometry. If the lower-priority surface metadata arrives first, it can
render or stop descent before the higher-priority surface is known at
that node. The result then depends on which metatiles arrived first, not
on the authored surface stack.

The same partial-active-set rule can also cause excessive descent for
geometry-less surfaces. A geometry-less node reports `texelSize =
Infinity`, so it forces descent. If other surfaces that would cover or
stop that descent are missing from the child active set because their
metanodes are not ready yet, the traversal can chase deep geometry
before the metadata frontier has established whether that work is
needed.

The current branch contains a configurable brake for that storm:
`MapSurfaceTile.fallbackTexelSize` gives geometry-less nodes a synthetic,
finite descent estimate, and `draw-traversal.ts` uses that value only in
the descent test. This stops coarse views from chasing deep
geometry-less branches. It also changes the meaning of a fitted
geometry-less node: traversal can stop at a node that cannot render
coverage. That is correct only when another surface covers the cell. If
the geometry-less subtree is the only provider for that region, the
workaround can leave missing terrain. The synthetic estimate also leaves
`texelSize` carrying one meaning for most traversal decisions and
`fallbackTexelSize` carrying another for descent, which makes the
selection rule harder to reason about.

The question the workaround tries to answer is local: if a geometry-less
node stops descending, is there another surface that can provide geometry
for this tile position. A partial active set cannot answer that question.
Once all candidate metanodes for the node are classified, the answer is
known: some ready or fitted candidate provides geometry, or no candidate
does and descent must continue if the data says children exist.

Both failures share one cause: the traversal processes a node before it
has classified the candidate surfaces for that node.

## Design

Traversal becomes metadata-first. A child quadrant is processed only
after every candidate surface for that quadrant has been classified.

A candidate surface at a parent node has one of these outcomes for a
child quadrant:

- **absent:** the parent metanode proves the surface has no child there;
- **pending:** the parent has the child, but the child metanode is not
  ready yet;
- **culled:** the child metanode is ready and the child is off-screen;
- **ready:** the child metanode is ready, visible, and can participate in
  the child traversal.

Only the ready children form the child active set. A pending surface
blocks descent into that child quadrant for this frame. It does not count
as absent.

A surface leaves the candidate set only when the parent metanode proves
no child exists, or when the loaded child is culled for the current view.

Under full candidate classification, a fitted watertight surface stops
lower-priority work at a node only after the entire candidate set for that
node has been classified. That set includes every higher-priority
candidate, so the authored priority order is always respected. It also
means a pending lower-priority candidate blocks the quadrant even when a
higher-priority watertight surface already fits: one slow metanode can
delay a fit the rest of the stack already proves. The first implementation
accepts that cost; the prefix-completeness optimization below is the route
to avoiding it.

**Root rule.** The traversal root obeys the same invariant. All configured
terrain surfaces are candidates at the root, and a surface whose root
metanode is not ready is pending, not absent. The root is processed only
after every configured surface root has been classified. Until then the
traversal makes no LOD-0 decision, so first terrain paint waits for the
configured roots. Roots are coarse and few, so this is a short, bounded
delay, and it removes the last place where partial activation could
reorder surface priority.

## Algorithm

The algorithm stays the RFC 3 recursive traversal. The major change is
the child-quadrant readiness rule: descent waits for every still-candidate
surface to be classified instead of building the child active set from
the surfaces whose metanodes happened to be ready.

The root is classified before any LOD-0 decision: all configured terrain
surfaces are candidates and a not-ready root metanode counts as pending,
so the traversal starts only once every root is classified.

At each node:

1. Record the current active surfaces.
2. Decide whether any active surface would require finer detail under
   the existing screen-space error rule.
3. If descent is not needed, render natural leaves and fallbacks as
   today.
4. If descent is needed, classify each child quadrant across the full
   active set.
5. For a child quadrant with any pending candidate, do not recurse this
   frame. Leave the current node to render its available natural leaves
   or fallback coverage.
6. For a child quadrant with a non-empty ready set and no pending
   candidates, recurse with that ready set.
7. On backtrack, render natural leaves and fallbacks as in RFC 3.

Missing metanodes must request loading through the existing
`isMetanodeReady()` path. Pending quadrants keep the map dirty so the
traversal retries when metadata arrives.

## Consequences

The traversal becomes less speculative. It fetches metadata before
issuing deeper geometry and layer requests that depend on that metadata.
This can serialize some first refinement, but it avoids requests for
descendants that a complete metadata frontier would not select.

Surface priority becomes stable with respect to the authored stack. A
lower-priority surface cannot claim a node merely because a
higher-priority surface's metanode has not arrived yet.

The pre-v6 geometry-less descent workaround based on
`MapSurfaceTile.fallbackTexelSize` is expected to become unnecessary.
Geometry-less nodes may continue to report `texelSize = Infinity`;
metadata-first traversal should prevent them from outrunning surfaces
whose metadata has not yet been classified. The intent is that RFC 9
supersedes the workaround rather than refines it.

Removal is gated on validation, not on metadata-first landing. The
fallback is today the only confirmed brake on the pre-v6 storm, while
metadata-first without it is still an unvalidated hypothesis for that
data. The safe sequence is: land metadata-first with the fallback
retained; add a temporary switch that disables the fallback; validate the
standard views, the private legacy pre-v6 cases, and the polar coverage
case with the fallback off; then remove `fallbackTexelSize` and the
descent-gate substitution only if metadata-first alone both prevents the
storm and fills the coverage hole. If the hypothesis fails, keep the
fallback and adopt the additional rule below.

This is not, by itself, proof that the pre-v6 geometry-less storm is
fixed. The pre-v6 descent barrier still depends on inferred watertight
flags, and those flags are written only after mesh analysis has loaded
and classified the covering meshes. The working hypothesis is that
metadata-first traversal slows speculative descent enough for that
healing to occur before deep geometry-less branches dominate the frame.
Validation must confirm this. If it does not, the algorithm needs one
more rule: geometry-less descent must stop below nodes that are natural
leaves for some still-candidate surface until those natural-leaf meshes
have had a chance to load and write inferred watertight coverage.

A single-surface dataset that provides geometry only at deep LODs remains
a data-production problem. The traversal will follow the metadata if it
says children exist. Avoiding that class of trap requires data discipline
or a separate defensive policy, not a combined-traversal coordination
rule.

## Deferred Optimization: Prefix Completeness

A later implementation may process a node once a frontmost continuous
prefix of surfaces is classified and that prefix proves the visible
coverage outcome. This is valid only when the classified prefix contains
a fitted watertight surface that stops lower-priority work at that node.

The first implementation does not use this optimization. Full candidate
classification is easier to reason about and avoids reintroducing
arrival-order-dependent priority behavior.

## Implementation Notes

`drawTerrainTraversal()` should build `rootActive` from all configured
terrain surfaces, treating a not-ready root metanode as pending rather
than skipping it, and should defer the LOD-0 decision until every root is
classified. This brings the root under the same metadata-first invariant
as child quadrants.

`collectChildActive()` should stop treating an unloaded child metanode as
absence. It should return a child state that distinguishes ready,
pending, and empty/culled quadrants.

`traverseNode()` should recurse only into ready child quadrants. Pending
quadrants should leave coverage unresolved for this frame and rely on
current-node rendering or ancestor fallback, as existing loading behavior
already does.

The implementation should keep `fallbackTexelSize` and the descent-gate
substitution until the validation gate in Consequences is met, behind a
temporary switch so validation can compare metadata-first with the
fallback on and off. Remove them only once metadata-first alone passes
that gate.

The documentation in [lod-selection.md](lod-selection.md) should describe
metadata-first traversal, and should drop the synthetic geometry-less
descent estimate once the fallback is removed.

## Validation

Validate against:

- the standard terrain screenshot set: `simple-terrain`,
  `complex-terrain`, and `full-terrain`;
- a wide multi-surface legacy view that previously caused excessive
  geometry-less descent;
- a polar or edge-coverage view where stopping at synthetic fitted
  geometry-less nodes previously left missing terrain;
- a close view that still needs deep descendant geometry;
- an arrival-order diagnostic that withholds or delays a higher-priority
  surface's metanode for one or more frames while a comparable
  lower-priority surface is ready, confirming the lower-priority surface
  can neither render nor stop descent at that node until the
  higher-priority candidate is classified, and that the settled result is
  identical regardless of arrival order.

The expected result is stable surface priority, no missing coverage
caused by synthetic geometry-less fit, and no return to unbounded descent
caused by partial metanode arrival.

## Review round 1

1. The metadata-first rule starts at child quadrants, leaving root
   activation arrival-order dependent.

   The context and motivation describe the failure as a surface-priority
   problem: a lower-priority surface can render or stop descent before a
   higher-priority surface is known at the same tile position. The design
   fixes that only after there is a parent node: "a child quadrant is
   processed only after every candidate surface for that quadrant has
   been classified." Current `drawTerrainTraversal()` builds `rootActive`
   by skipping any surface whose root metanode is not ready. If a back
   surface root is ready before a front surface root, the traversal can
   still run with a partial root active set and make the same
   arrival-order-dependent decision at LOD 0.

   Specify the root rule. Either all configured terrain-surface roots are
   candidates and missing roots are pending, or the RFC needs to explain
   why root-level partial activation cannot produce the same class of
   priority bug. As written, the first node in the traversal is outside
   the new invariant.

   *Implemented.* The root is now inside the invariant. A **Root rule**
   paragraph in Design makes all configured terrain surfaces candidates at
   the root and treats a not-ready root metanode as pending, not absent;
   the root is processed only after every configured root is classified.
   The Algorithm intro and an Implementation Notes bullet on
   `drawTerrainTraversal()`/`rootActive` state the same rule. The named
   cost is that first terrain paint waits for the configured roots, which
   are coarse and few.

2. The text conflicts on whether lower-priority pending metadata can
   block a higher-priority watertight fit.

   The design says a child quadrant is processed only after every
   candidate surface has been classified. That implies a pending
   lower-priority child blocks recursion and also blocks any
   higher-priority fitted watertight surface from stopping the
   lower-priority work for that quadrant. Two sections then describe a
   weaker, priority-aware rule: "A fitted watertight surface may stop
   lower-priority work only when higher-priority candidate surfaces for
   the node have been classified," and the prefix-completeness
   optimization says a frontmost classified prefix can prove the outcome.

   Pick one rule for the first implementation. If full classification is
   intentional, say that lower-priority pending surfaces also block a
   higher-priority watertight fit and name the cost. If the priority-aware
   rule is intended, the first implementation needs enough prefix logic
   to let a classified fitted watertight surface stop lower-priority
   pending candidates after all higher-priority candidates are known. The
   current text states both behaviours.

   *Implemented.* Full candidate classification is the rule for the first
   implementation, as the Design and the Deferred Optimization section
   already stated. The conflicting sentence is reworded so the watertight
   stop reads as a consequence of full classification rather than a
   separate weaker rule: because the classified set includes every
   higher-priority candidate, priority is always respected, and a pending
   lower-priority candidate does block a higher-priority watertight fit
   for that quadrant this frame. That cost is now named explicitly. The
   priority-aware partial behaviour stays in the deferred
   prefix-completeness section as the route to avoiding the cost later.

3. Removing `fallbackTexelSize` is specified before the replacement has
   been validated.

   The consequences section says metadata-first traversal makes
   `MapSurfaceTile.fallbackTexelSize` unnecessary and that the
   implementation should remove it when metadata-first traversal lands.
   The next paragraph says this is not proof that the pre-v6
   geometry-less storm is fixed, and that validation must confirm the
   working hypothesis. Those statements make the implementation order
   unsafe: the current fallback is the only confirmed storm brake, while
   metadata-first without it is still an unvalidated hypothesis for
   pre-v6 data.

   Make removal conditional. One safe sequence is: implement
   metadata-first while retaining the fallback, add a temporary switch or
   diagnostic path that disables the fallback, validate the standard
   views plus the private legacy pre-v6 cases, then remove the fallback
   only if metadata-first alone prevents the storm and fixes the missing
   coverage case. If the fallback must be removed in the same patch, the
   RFC should state the validation gate and the fallback plan when the
   hypothesis fails.

   *Implemented.* Removal is now gated on validation, not on
   metadata-first landing. Consequences specifies the safe sequence: land
   metadata-first with the fallback retained, add a temporary switch that
   disables it, validate the standard views plus the private legacy pre-v6
   and polar coverage cases with the fallback off, then remove
   `fallbackTexelSize` and the descent-gate substitution only if
   metadata-first alone both prevents the storm and fills the coverage
   hole. The fallback plan when the hypothesis fails is stated: keep the
   fallback and adopt the natural-leaf descent-pause rule. Implementation
   Notes are updated to retain the fallback behind the switch until the
   gate is met.

4. The validation plan needs one direct priority-stability check.

   The listed views cover normal rendering, the geometry-less storm, the
   synthetic-fit hole, and deep geometry. They do not explicitly test the
   stated priority bug: a lower-priority surface whose metanode arrives
   before a comparable higher-priority surface. Add a diagnostic that
   delays or withholds the higher-priority metanode for one frame, then
   verifies that the lower-priority surface cannot render or stop descent
   until the higher-priority candidate has been classified. The expected
   output should be the same once all metadata is available, regardless
   of arrival order.

   *Implemented.* Added that diagnostic to the Validation section: it
   withholds or delays a higher-priority surface's metanode for one or
   more frames while a comparable lower-priority surface is ready, and
   checks that the lower-priority surface can neither render nor stop
   descent at that node until the higher-priority candidate is classified,
   with an identical settled result regardless of arrival order.

## Review round 2 — sign-off

Round 1 is addressed. The root is now inside the metadata-first
invariant, full candidate classification is the stated first
implementation rule, fallback removal is gated on validation, and the
validation plan includes a direct arrival-order priority diagnostic.

No specification-level findings remain. One editorial clarification can
be folded in during implementation: "configured terrain surfaces" in the
root rule should mean the current traversal input surface stack, i.e. the
surfaces returned by `surfaceList()` for the active style or mapConfig
view, not every surface declared anywhere in the map configuration. That
does not change the design.

## Addendum — 2026-06-22 — implementation attempt failed (`b5869add`)

The first implementation landed the metadata-first structure:

- `drawTerrainTraversal()` waited for every configured root metanode before
  making an LOD-0 decision;
- `collectChildActive()` classified each candidate child as absent,
  pending, culled, or ready;
- `traverseNode()` skipped a quadrant while any candidate child was
  pending.

Targeted traces confirmed that the pending rule engaged and that the
combined traversal was the only terrain traversal path. The implementation
nevertheless failed both objectives:

1. **Stable surface priority failed.** A lower-priority surface occupied
   the settled view while higher-priority surfaces appeared only as
   transient loading artifacts.
2. **The geometry-less tile storm remained.** Disabling
   `PreV6DescentFallback` returned the deep-descent storm.

The higher-priority surfaces issued no data request for the stopped tile.
This located the failure inside traversal rather than loading or the server,
but the reason for the missing requests was not yet established.

## Addendum — 2026-06-22 — partial salvage (`4b3dbb65`)

A follow-up single-tile trace found that the higher-priority surfaces
remained active and reached the render loop first. They were non-natural
leaves at a node where a lower-priority fitted watertight surface had stopped
descent. The off-cadence fallback rule therefore tried them with
`preventLoad = true`; with no resident mesh, they produced no rig and issued
no data request.

The fix retained the metadata-first root and child-pending rules and kept
the fitted-watertight descent stop. It changed only the render gate at such a
stop: off-cadence fallback candidates may load while `hasWatertightFit` is
true, until the first watertight surface stops lower-priority rendering.
Higher-priority fallback content can therefore load without pulling descent
deeper.

The failing close-view trace then requested and rendered the
higher-priority fallback surfaces. TypeScript and the standard
`simple-terrain`, `complex-terrain`, and `full-terrain` screenshots passed.
Metadata-first traversal still did not supersede the pre-v6
`fallbackTexelSize` brake. Load growth around the fallback-load exception
remained the main validation risk.

## Addendum — 2026-07-08 — empty-quadrant culling (`43167db1`)

RFC 9 requires absent and culled children to remain distinct outcomes.
`collectChildActive()` had treated an all-absent child set as culled because
its aggregate culling flag started true. That could fold a visible quadrant
into `empty` and suppress required parent fallback coverage. The correction
requires an actual loaded child to fail frustum culling before a quadrant is
classified as culled. All-absent and pending child sets remain gaps for
parent fallback. This restores the child-classification invariant; it does
not change surface-priority stability or the geometry-less tile-storm brake.

## Addendum — 2026-07-08 — configurable structural descent brake

The geometry-less fallback was described as pre-v6 but its physical-span
calculation used the quantized bbox available only in metatile versions 1-4.
Versions 5-6 now derive the span from the physical `bbox2` corners generated
for culling.

`mapStructuralDescentBrake` replaces the module-level fallback switch. It is
clamped to 0-1 and defaults to 0.25. Geometry-less nodes descend while:

```text
fallbackTexelSize > texelSizeFit * mapStructuralDescentBrake
```

Zero is transparent and leaves structural descent unbounded. Positive values
let the brake act only after the structural estimate fits more finely than
normal measured geometry. A targeted sparse-v6 trace, runtime option checks,
TypeScript, and the three standard screenshots passed.

Manual validation against a complex legacy pre-v6 surface stack showed that
the structural brake bounds the initial geometry-less descent spike. The
traversal may briefly visit thousands of tiles, but remains manageable until
mesh loading supplies enough inferred watertight coverage to take over.

The same policy is required for v6 surfaces whose production settings omit
partial ancestors and leave a deep geometry-less child chain before the first
mesh. Those chains can create a smaller version of the same request storm
despite otherwise valid v6 metadata.

The brake is therefore a cross-version structural safety policy rather than
a temporary pre-v6 compatibility bridge. The default value of 0.25 preserves
more descent before intervening; 0.5 is a more conservative setting for
applications that prefer a lower transient tile count.

This addendum does not complete RFC 9. During loading, lower-priority
surfaces can still appear transiently before higher-priority coverage becomes
renderable. Stable surface priority throughout loading remains unresolved.
