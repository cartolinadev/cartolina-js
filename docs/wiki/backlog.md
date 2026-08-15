# Task backlog

Work confined to `cartolina-tileserver` is tracked in the
[tileserver backlog](https://github.com/cartolinadev/cartolina-tileserver/blob/main/docs/backlog.md).

Entries are numbered in the heading (`## N. ...`) in the order they
were opened; the number is permanent and is never reused or
renumbered. When closing an entry (resolved, implemented, or
superseded by another change), move it to
[backlog-archive.md](backlog-archive.md) — keep its number.

Promotion to an RFC is not closure. An entry promoted, elevated, or
subsumed into an RFC stays here, with its status noting the RFC,
until that RFC reaches `Implemented` — only then does it move to the
archive. See "Backlog hygiene" in [AGENTS.md](../../AGENTS.md).

**New entries go directly below this line, newest first — never below an
existing entry, even one added earlier in the same session. Assign the
next entry the number one higher than the highest number used so far
across this file and [backlog-archive.md](backlog-archive.md).**

## 52. Stale vertical-exaggeration state in the legacy modules

**Opened:** 2026-08-16
**Status:** open
**Related:** `src/map/surface-tile.js`, `src/renderer/draw.js`

Two leftovers found while making `VerticalExaggeration.enabled()` a
derived predicate. Neither was in scope for that change.

`gridPoints` in `MapSurfaceTile` is assigned at two sites — once in the
constructor area and once when the exaggeration bake goes stale — and
read nowhere. Either it lost its reader or it never had one.

The label jobs in `draw.js` bake `job.center2` when
`job.seCounter != renderer.seCounter`. `seCounter` advances on
configuration change and never on zoom, while the scale ramp's factor
is a function of the view extent. With a scale ramp installed the label
anchors would then be baked at whatever zoom the job first drew at. That
is the staleness backlog-archive #33 fixed for the debug bboxes by
comparing the baked factor alongside the counter. Not confirmed
visually — labels have not been seen to drift, so establish whether the
defect is real before fixing it.

## 51. Credit ownership still sits on the legacy map

`MapStyle` now holds the typed `Map` and reaches the legacy map through
`Map.legacyMap`, but `MapStyle.registerCreditDefinitions` still takes a
`LegacyMap` because `addCredit` and the credit table live there.
`Map.credits` does not exist yet, so the parameter cannot simply change
type.

Moving credits into `Map` is the remaining piece of that inversion. It
touches `credit.ts`, the legacy credit table, and the credit-rendering
call sites in the UI, which is why it is separate from the style-owner
change rather than part of it.

## 50. The VTS stylesheet linker's collision paths are unexercised

**Opened:** 2026-08-07
**Related:** [rfc11-mapconfig-to-style.md](rfc11-mapconfig-to-style.md),
`src/compat/vts-stylesheet-linker.ts`

`linkStylesheets` only renames, coalesces, or rewrites references when
two resolved stylesheets define the same constant, font, bitmap, or
layer name differently. No entry in [urls.json](../../test/urls.json)
and no demo produces that collision, so `planRenames`,
`rewriteAliasRefs`, and `rewriteLayerRefs` never run their interesting
branches during any current check. The evidence for them was the
converter unit suite, removed under the current test policy.

This is a note, not a request for a unit test: nothing has demonstrated
a failure, and a test with no observed defect behind it would not meet
the policy. Record it so that whoever next changes the linker knows the
existing gates will not catch a regression there, and arranges evidence
as part of that change.

## 49. Converter source fetches are serial

**Opened:** 2026-08-07
**Related:** `src/compat/mapconfig-to-style.ts`

`convertBoundLayers`, `convertFreeLayers`, and
`collectResolvedStylesheets` each `await` inside a `for` loop, so a
mapConfig with several bound layers pays one round trip per layer
before `map()` is called. The style loader it feeds does the opposite
deliberately: `MapStyle.loadStyle` starts every source request together
and settles them with `Promise.allSettled`.

No measurement has shown this to matter, which is why it is here rather
than in the code. If it is taken up: the emitted `sources` key order is
the runtime's source declaration order, and rounds 10 and 11 made that
order load-bearing for shared metadata and credit precedence. So the
fetches may overlap but the assignments into `this.sources` must stay
in declaration order.

## 48. TOOLING: withdraw the global/UMD library build

**Opened:** 2026-08-06
**Blocked on:** deployment of the ESM-converted consumers
**Related:** [architecture.md](architecture.md), README.md

`cartolina.js` / `cartolina.min.js` is a second full compilation of
`src/viewer/index.ts` that exists only to define `window.cartolina`. No
consumer in this repository loads it any more: every demo imports the ES
module, as do the cartolina.dev site and the tileserver introspection
pages.

It cannot be deleted yet because the published artifact is what already
deployed pages fetch — the tileserver introspection templates in
particular are compiled into mapproxy and vtsd binaries, so a deployment
has to reach every running server before the URL can stop resolving.

When those are deployed: delete `globalConfig` from
[webpack.config.js](../../webpack.config.js) and its entry in the
exported array, and drop the paragraph in README.md that describes the
global build as still published. The dev build then compiles the library
ESM, two workers and the compatibility entry — four outputs, plus the
dev-only sandbox.

## 47. Switch class modules from default to named exports

**Opened:** 2026-07-24
**Related:** AGENTS.md, "Declaration merging for exported types"

Class modules default-export their class and merge a same-name
namespace for associated types (`export default Viewer`, plus
`namespace Viewer`). At least eleven modules follow this — `Map`,
`Renderer`, `Atmosphere`, `GpuDevice`, `MapStyle`, `MapBody`,
`FrameProfiler`, `FreezeCameraState`, `GpuMesh`, `GpuTexture`,
`Viewer`.

The default export forces `export { default as Map } from './viewer'`
at the barrel and lets each import site pick its own name for the
class, and current TypeScript guidance generally favors named exports.
Declaration merging does not need the default: a class and its
same-name namespace merge by identifier in module scope, so
`export { Viewer }` keeps `Map.PositionInput` and the rest working.

The switch is mechanical and tsc-verifiable but codebase-wide: each
module's `export default Foo` becomes `export { Foo }`, each importer's
`import Foo` becomes `import { Foo }`, and the AGENTS.md convention plus
its example change to match. Do it as one deliberate commit, not by
making any single module a lone exception.

## 46. BUG: altitude jitter while panning over high terrain (multi-surface)

**Opened:** 2026-07-10
**Status:** fixed 2026-07-10, pending interactive validation
**Related:** [nav-tiles.md](nav-tiles.md), the coverage-aware point
terrain queries entry below, the tileserver backlog entry "Navtiles on
partial-coverage tiles are served without coverage"

Panning converts the position to `float` (`map-observer.js`), so the
camera altitude re-samples `getSurfaceHeight` every frame. Any
discontinuity in the height series along the pan path shows as a
jump. Observed jumps ranged from tens to hundreds of metres.

### Causes

Both defects were in the front-to-back claim order of
`MapMeasure.getSurfaceHeight`: the first tree with a navtile, or with
geometry on the traced path, answered — regardless of sample quality.

1. **Coverage filler.** A navtile pane spans the whole tile. A front
   surface covering only part of the tile still answered queries far
   from its coverage, where the pane holds filler. The node-only
   fallback failed the same way through that node's bbox centre.
2. **Resolution flips.** A front surface without a navtile at the
   requested lod answered with one many lods finer, while a back
   surface had one at the requested lod. Which tree answered depended
   on helper-tree depth, which follows the camera — so panning
   flipped between resolutions that legitimately differ by tens of
   metres.

### Fix

`getSurfaceHeight` consults every tree and ranks navtile answers:

1. sample lod closest to the requested lod; ties prefer the coarser
   sample (coarser is smoother, finer jitters);
2. answer inside the claiming node's geometry bbox, inflated by a
   quarter of its size (`isHeightWithinNodeBounds_`) — the only
   coverage signal in pre-v6 data; failing answers are a last resort
   so single-surface maps always resolve;
3. stack order, front-most first.

Geometry-only claims go to the node-only fallback only when no tree
has a navtile answer; that path applies the same bbox test.

Verified on both probed pan paths: the series is identical from both
endpoint cameras, sampled from one navtile at the requested lod,
steps under 0.3 m. Terrain screenshots and earlier height cases
reproduce.

### Known limits

- The bbox test cannot reject filler when sparse geometry spans the
  tile (a diagonal strip, a ring): the bbox covers the tile while the
  coverage does not. Rejections are reliable; acceptances are not.
  The real signal is coverage data — see the coverage-aware entry
  below and the tileserver backlog entry.
- Surfaces model the same terrain and agree at equal lods; where a
  dataset's coarse navtiles are biased against its own finer lods,
  the query returns that bias.

## 45. FEATURE: make the atmosphere shell track vertical exaggeration

**Opened:** 2026-07-07
**Status:** deferred — no clean fix with the current density texture.
**Related:** `src/map/atmosphere.ts`,
`src/renderer/shaders/includes/atmosphere.inc.glsl`,
`externals/vts-libs/.../vts/atmospheredensitytexture.cpp` (tileserver).

The atmosphere shell is anchored to the datum with a fixed thickness.
On bodies rendered with strong vertical exaggeration the exaggerated
terrain can stand taller than the shell, so peaks stick out of the
atmosphere. The reported artifact — a dark band between a sunken limb
and the atmosphere edge — is now handled separately by the per-frame
`solidBodyRadius` (the sky-ray hole-fill sphere follows the
exaggerated `heightRange[0]`); this entry is only about the shell
thickness not growing with exaggeration.

Two inflation attempts were tried and rejected (session log
2026-07-07):

- A constant factor at construction time (thickness and visibility
  scaled by the exaggeration at body-diameter extent). Because the
  factor is fixed, it applies at every view: at planet scale Earth
  became a uniform blue ball. A constant cannot track a
  view-dependent ramp, and even where the shell was thick enough the
  visible glow is only ~2-3 density scale heights, so peaks still
  poked out.
- A per-frame stretch of the shell geometry against the unchanged
  texture. The density texture stores path integrals parameterized by
  relative altitude and near-saturated over the lower shell, so
  stretching the uv mapping stretches the saturated core: the planet
  gained a fat opaque ring.

The static density texture is the fundamental blocker. Two viable
routes if this is picked up:

- refetch the density texture per quantized exaggeration bucket (the
  `def` query already parameterizes thickness; the tileserver
  generates on demand; swap the gpu texture when the new one loads),
  or
- replace the texture with an in-shader analytic integral
  (Chapman-function style), making thickness a free per-frame
  uniform.

Until then the dead constructor inflation lines are removed and the
atmosphere stays datum-anchored and static.

## 44. FORMAT: design the v4 terrain-tile container

**Opened:** 2026-06-29
**Status:** promoted to
[RFC 10](rfc10-terrain-tile-container.md) on 2026-07-04. The container,
the bundled KTX2 normal map, and the single-geometry model are designed
there; the geometry re-encoding goals below (one GPU-ready index
domain, optimized DEM encodings, explicit cell UV) remain future work,
carried by a new payload type inside the RFC 10 container. RFC 10 is
still active (not implemented), so this entry stays open until it is.
**Related:** `src/core/map/mesh.js`, `src/core/map/submesh.js`,
`src/core/map/loader/worker-mesh.js`.

The next terrain format revision has several known reasons to be a clean
break rather than another adjustment to the v1-v3 vertex layout:

- each tile will contain one geometry object instead of a submesh list;
- a tile may bundle a KTX-encoded normal map;
- geometry will use one GPU-ready index domain;
- cell UV must remain available to coverage-mask rendering, either stored
  explicitly or derived exactly by an optimized DEM encoding;
- optimized DEM encodings may coexist with conventional quantized TINs.

Treat v4 as a terrain-tile container with a versioned geometry encoding and
length-delimited optional payloads, not only as a new face-index layout. The
design must cover client-first rollout, URL/cache revision changes, and the
scope of readers outside the browser.

Current source findings reduce the encoder risk. The tileserver's in-memory
mesh already carries per-vertex cell UV and a separate internal-UV face
domain. Its cleanup step makes folding onto the internal-UV domain
deterministic. Terrain generation, clipping, masks, and metatiles therefore
do not need to change merely to emit one index domain. The current v3 writer
is not the default and remains behind a legacy compression switch with an
unresolved FIXME; validate it before reusing its delta codec in v4.

Promote this entry to an RFC when v4 becomes scheduled. Until then v1-v3
decoding retains all cell UVs and performs the required indexing in the
client.

## 43. REFACTOR: unify the duplicated mesh parser (main thread + worker)

**Opened:** 2026-06-23
**Status:** subsumed by
[RFC 10](rfc10-terrain-tile-container.md) on 2026-07-04 — its client
milestone replaces both parsers with one shared TypeScript terrain-tile
parser used from the worker and the main thread. RFC 10 is still
active (not implemented), so this entry stays open until it is.
**Related:** `src/core/map/submesh.js`, `src/core/map/loader/worker-mesh.js`,
`src/core/map/mesh.js`.

The mesh binary is decoded by two near-identical parsers. `submesh.js`
parses on the main thread as `MapSubmesh` prototype methods; `worker-mesh.js`
parses in the worker as standalone functions on plain objects (data crosses
the worker boundary as transferable buffers). `MapMesh.onLoaded` selects one
per load: `parseWorkerData` deserializes a worker result, `parseMapMesh`
parses on the main thread. Each file carries the full pipeline — header,
`parseVerticesAndFaces` (format < 3), `parseVerticesAndFaces2` (format 3),
and the `parseWord`/`parseDelta` varint helpers — so the byte layout, the
varint decode, and the index/de-index logic are duplicated (~1800 lines
total, ~identical apart from idioms: methods vs functions, `this.map.config`
vs `globals.config`, `this.flags` vs `submesh.flags`, instance fields vs
plain-object fields).

Cost: any parse change must be applied four times (two format versions ×
two implementations), and the two can drift so the worker path and the main
path behave differently under one config — a bug that hides per config. The
2026-06-29 indexed-layout correction had to update all four loops in
lockstep.

Direction: extract the pure parse logic to operate on a neutral
submesh-shaped object plus an explicit config, and have both `MapSubmesh`
and the worker wrap that single core. Blocker today: the main-thread version
writes straight into `this` and reads `this.map.config`, so unifying means
threading config explicitly and parsing into a plain struct the `MapSubmesh`
then adopts. Sizable hot-path refactor — land a parser unit test first (it
also catches worker/main drift), and verify with the screenshot tests.

## 42. TOOLING: ship TypeScript types (.d.ts emit + type-only npm package)

**Opened:** 2026-06-18
**Status:** deferred — explored and intentionally not built; premature
until there are multiple external TS consumers. Findings recorded below.
**Related:** [architecture.md](architecture.md) (Map/Core/LegacyMap
absorption), [api-and-lifecycle.md](api-and-lifecycle.md).

The published ESM bundle (`cartolina.min.esm.js`) ships no type
declarations, so URL/dynamic-import consumers get `any` and must hand-write
their own interface. Cesium
ships a JSDoc-generated `Cesium.d.ts` in its npm package; three.js outsources
types to the community `@types/three`. cartolina is TS-authored, so an
accurate `.d.ts` for the public API is a near-free artifact — the entry
already type-checks cleanly with full JSDoc.

Why this is deferred rather than done: a prototype confirmed the public type
graph can be emitted self-contained, but only by giving every legacy ES5
`.js` module a nameable type. Declaration emit fails on ~86 such modules
(TS9005/TS9006 "requires using private name"); ~17 are reachable from the
public surface (the `Map`/`Core`/`LegacyMap` halves slated for TS
absorption — see architecture.md, plus `position`, `srs`, `surface*`,
`texture`, `camera`, `credit`, `refframe`, `url`,
`division-node`, `inspector`). The project already types some of these with
co-located hand-written `.d.ts` sidecars. Completing the set means either
*faithful* sidecars (petrifies legacy code we want gone) or *opaque* `any`
placeholders (carry no real type info). Either way `tsc` will not copy
source `.d.ts` to the emit outDir, so a copy step is also required.

Net: the only genuinely useful output is the public-API `.d.ts`, which
already exists in source; the rest is `any` plumbing. Not worth it until
the JS→TS migration reduces the sidecar surface and/or there are real
external consumers. Do not rewrite the runtime `.js` files solely for emit
— they are validated only by the screenshot tests.

Distribution note for when this is taken up: types must ship as a package,
because TypeScript resolves types from `node_modules`/disk, never from a
runtime `import()` URL — shipping a `.d.ts` next to the CDN bundle alone
does not give consumers types. Options: (a) a full npm package (bundle +
types), or (b) a type-only package consumed as a devDependency while the
runtime bundle still loads from the CDN ESM URL by profile. Prefer (b) for
the URL-loaded-ESM model the project already uses.

---

## 41. CLIENT/FOLLOW-UP: replace hardcoded metatile aggregation order

**Opened:** 2026-06-12
**Status:** open — depends on RFC 7 implementation and client
surface-packaging support
**Related:** [rfc07-metanode-store.md](rfc07-metanode-store.md),
[surface-metatile.md](surface-metatile.md)

Current cartolina-js does not consume configured metatile packaging
values. Terrain metatile fetches use a literal aggregation order 5 in
`src/map/surface-tile.js`; raster-source texture metatiles use a
literal order 8 in `src/map/texture.js`. Parsed reference-frame
and surface `metaBinaryOrder` values are currently dead.

This item has no standalone meaning before RFC 7 is implemented: the
server must first advertise effective surface packaging values in
mapConfig, validate them against metanode-store artifacts, and keep
current datasets on effective `(metaBinaryOrder = 5, metaDepth = 1)`.
After that exists, the later client packaging milestone must replace the
literals with effective per-surface values from mapConfig, add
compatibility checks, and ship the operator rebrick tool used to migrate
existing metanode-store datasets to new `metaBinaryOrder`/`metaDepth`
values.

---

## 40. CLIENT/REDESIGN: shallow-subtree metatile delivery (awaits RFC promotion)

**Opened:** 2026-06-12
**Status:** open — awaiting promotion to its own RFC, per RFC 7 §8
phase 9 and the round-2 review disposition.
**Related:** [rfc07-metanode-store.md](rfc07-metanode-store.md);
"replace hardcoded metatile aggregation order" above (one ingredient
of this milestone).

The deferred client milestone of RFC 7: replace single-LOD metatile
blocks with shallow-subtree delivery to cut the metatile descent
ping-pong (a LOD-15 descent: ~16 fetch phases to ~4 at
`metaDepth = 4`). Scope when taken up: teach cartolina-js to read the
mapConfig `metaBinaryOrder`/`metaDepth` (advertised by the server
since RFC 7), replace the hardcoded terrain and raster-source orders,
define the multi-LOD metatile binary (a v7 break), trim the dead v6
fields, ship the operator packaging-rebrick tool, and choose the
default `metaDepth` from measurements. The decision inputs RFC 7
promised now exist: the phase-7 planetary numbers (store sizes, page
counts, serve latency, RSS) are in the RFC implementation notes, and
the store payload is proven rebrickable across packaging shapes by
the `mapproxy-mnstore` selftest. The v7 wire format should also
settle the vertical-datum question recorded in the RFC's orthometric
addendum: orthometric heights plus per-metatile corner undulations
(~16 bytes) would let the client do the bilinear shift for free,
versus keeping the wire ellipsoidal at zero client cost.

---

## 39. FEATURE: recover from WebGL context loss

**Opened:** 2026-06-10
**Status:** promoted to
[RFC 8](rfc08-context-loss-recovery.md) on 2026-06-11. RFC 8 is still
active (not implemented), so this entry stays open until it is.

After a context loss the map stays blank permanently;
`contextRestored()` only fires an event. Design and implementation
plan live in the RFC.

## 37. BUG/DESIGN: coverage-aware point terrain queries

**Opened:** 2026-06-08
**Status:** ownership rule implemented 2026-07-10; lod-ranked claim
with geometry-bbox bounds test added 2026-07-10 (see the pan jitter
entry above) — the exact coverage-aware rule remains open
**Related:** [rfc03-draw-traversal.md](rfc03-draw-traversal.md),
[nav-tiles.md](nav-tiles.md),
[surface-metatile.md](surface-metatile.md)

### Symptom

`MapMeasure.getSurfaceHeight()` and `getSurfaceHeightNodeOnly()` query
the recursive path's per-surface helper trees front-to-back and used to
return the first tree that yields a navtile or metanode. That is safe
when the front surface fully owns the coordinate, but fails in two
ways:

- A sparse front surface whose tree dead-ends on structural
  (geometry-less) nodes toward the coordinate claimed the
  answer with no terrain data at all. The node-only fallback then
  produced a bbox-centre or query-coordinate height, so camera
  float-height navigation and `float`/`fix` conversion landed on
  arbitrary values (fixed 0 in the worst case).
- Partial front-surface tiles can carry data while not covering every
  point in the tile. A point query can stop on a partial front surface
  where rendering would use a lower-priority back surface for the
  visible terrain.

Affected callers include camera float-height navigation, `fix`/`float`
coordinate conversion, public terrain-height queries, hit-coordinate
conversion to `float`, and geodata draping through
`geodata.processHeights()`.

### Implemented 2026-07-10 — structural-path ownership rule

The first failure mode is fixed on
`feature/height-query-ownership`. A tree now claims the answer only
with terrain evidence at the coordinate: a usable navtile, or geometry
on the traced path (`params.sawGeometry`, set by the trace functions in
[surface-tree.js](../../src/map/surface-tree.js)). A tree whose
trace ends on structural nodes falls through to the next
surface back. A consulted tree that could not answer conclusively
(metanode or navtile texture still loading) marks the result
provisional (`res[2] = false`) so callers query again.

Two supporting changes landed with it:

- `traceHeightTile` sets `waitingForNode` only when a metanode is
  genuinely missing, so the provisional flag carries signal.
- `traceHeightTileByMap` treats a navtile as absent when its metanode
  height range is inverted or lies outside the reference frame's
  global height range; descent continues to finer valid navtiles.
  This lets the client recover when a coarse navtile's stored height
  range is corrupt, instead of returning its poisoned answer.

The failure mode is
data-independent: whenever the front surface reaches a coordinate only
through structural nodes, the old rule returned that node's bbox
centre — or, for a pre-v5 metanode whose bbox exceeds the 8000 m
sanity limit, the query coordinate's own height, landing a
zero-height float position at fixed 0.

### Implemented 2026-07-10 — lod-ranked claim with bbox test

The second failure mode (partial front-surface tiles) is mitigated by
the ranked claim in `getSurfaceHeight`: sample-lod distance to the
requested lod, then the geometry-bbox test
(`isHeightWithinNodeBounds_`), then stack order; failing answers are
a last resort. See the pan jitter entry above for causes,
verification, and the diagonal-coverage limit that keeps this entry
open.

### Direction (remaining)

The bbox test approximates a coverage signal the data should carry: a
covered-subtree flag — like watertight, but tracking coverage instead
of mesh availability — stating that the node's existing subtree
completely covers its pane. It can be stamped by the tileserver (v6
metatiles) or partly inferred client-side while the surface tree
builds: a missing child flag decides "not covered" within a level or
two, but "covered" cannot be confirmed in v4 data, which has no
watertight bit.

Point terrain queries should use a coverage-aware ownership rule that
matches the recursive terrain traversal closely enough for navigation
and draping. A likely rule is to prefer the first front-to-back surface
with a watertight owner along the coordinate path, treating
non-watertight hits as provisional. This may choose a coarser back
surface at dataset fringes, but avoids treating a partial front tile as
complete terrain.

The rule cannot require a watertight flag unconditionally. Before
metatile v6 the watertight bitplane is absent, so all client-visible
watertight checks are generally false. A v6-only rule would make point
queries fail or always fall through on older configurations. The
implementation must define fallback semantics for pre-v6 data, for
single-surface maps, and for datasets that do not yet encode watertight
coverage.

### Open questions

- Whether an ancestor watertight claim is enough to stop lower-priority
  surfaces for the coordinate, mirroring traversal deactivation.
- Whether a non-watertight front hit should be returned when no
  watertight surface exists, or only for APIs that prefer availability
  over strict ownership.
- How to distinguish "watertight information unavailable" from "known
  non-watertight" in query code without regressing pre-v6 maps.
- Whether point-query diagnostics should report the selected surface id,
  tile id, and ownership reason during regression tests.

---

## 36. REFACTOR/PERF: split tile rendering execution out of `TileRenderRig`

**Opened:** 2026-06-06
**Status:** deferred
**Related:** [rendering-architecture.md](rendering-architecture.md)

### Motivation

`src/map/tile-render-rig.ts` is built around the style layer model.
That model should stay: it is the style-era terrain composition model,
and the rig already does useful tile-local work. It owns the tile and
submesh resource references, builds the prepared layer stack, tracks
essential vs optional readiness, supports fallback readiness, collapses
normal/bump layers when possible, and reports active layer IDs for
credits.

The problem is narrower: the rig also owns backend execution. Its
`draw()`, `drawDepth()`, `footprint()`, layer UBO encoding, texture-unit
binding, mask binding, and GLSL program selection make the tile resource
object the WebGL renderer for terrain. That couples the map/style data
model to the current WebGL execution strategy.

The current color path renders the prepared layer stack through one
large tile shader. That shader behaves like a small layer interpreter:
it loops over encoded layer records, branches on source/target/operation
types, reads sampler indices from the UBO, maintains shader-side stacks,
and applies shading, masks, atmosphere, and render flags in one pass.

This may be a performance problem. The working hypothesis is that the
"one pass is always better than many passes" assumption does not hold
for this terrain workload once the single pass becomes a large dynamic
shader. The old terrain path used simpler draw calls per layer and was
faster in comparable scenes, but that is not yet proof that pass count
is the cause: the old path also used simpler shaders, compile-time
variants, and different material logic. A dedicated A/B measurement is
needed.

This is not part of the legacy map draw-path replacement, which is
already underway as a separate cleanup track. It is a later renderer
architecture task for the terrain path after the current traversal and
draw-path work has settled.

The extensibility problem is clearer. Future terrain layer types will
not all fit naturally inside one tile fragment shader:

- vector layers may rasterize waterways or other features before a
  later specular or compositing pass reads the result;
- land-cover layers may classify texture values into styled RGB or masks;
- future analytical or generated layers may produce intermediate scalar,
  color, normal, or mask textures before they affect final terrain color.

Adding each layer type to the monolithic tile shader would grow the
shader into a renderer-specific layer VM. It would also make a later
WebGPU backend harder, because the style model and the WebGL execution
model would remain fused.

### Goals

- Keep `TileRenderRig` as the tile/submesh resource holder and readiness
  planner.
- Move backend execution out of the rig into renderer-owned terrain tile
  rendering code.
- Treat multipass rendering as the baseline execution model to test:
  a style layer or layer operation may emit one or more render passes.
- Preserve `TileRenderRig`'s existing layer/resource optimization role:
  skipping covered layers, collapsing normal/bump work, and deciding
  which prepared layers belong in the render plan remain rig work.
- Let the renderer execute that prepared plan with backend-specific draw
  code and specialized shaders.
- Make intermediate render products explicit: color, normal, scalar,
  mask, or tile-local textures can be produced and consumed by later
  passes.
- Separate the prepared map/style model from WebGL-specific details so a
  future backend can map the same render plan to a different execution
  API.

### Suggested API shape

Do not expose the rig's mutable internal layer array directly. Add a
narrow read API that returns a prepared render description for the
requested readiness level, e.g.:

```ts
rig.layersForRender(readiness): readonly TileRenderRig.PreparedLayer[]
```

The returned data should describe what is ready to draw, not how WebGL
binds it. It can include the prepared layer records, resource handles,
texture transforms, active render flags, watertight/opacity facts, and
the submesh resource needed by the backend. The shape should be narrow
enough that the renderer cannot mutate rig state by accident.

Renderer-owned code then consumes the rig:

```ts
renderer.terrainTiles.drawRig(rig, {
    cameraPos,
    target,
    maskTexture,
    pass: 'color' | 'depth' | 'footprint',
});
```

The exact class names are open. Possible layers of ownership:

- `TileRenderRig`: tile/submesh resources, prepared stack, readiness,
  rig-local preprocessing such as normal collapse.
- `TileRenderer`: turns a ready rig or render plan into terrain passes for 
  color, depth, mask, and footprint.
- WebGL backend helpers: own GLSL programs, framebuffer/render-target
  operations, blend state, texture units, UBO/uniform packing, and draw
  calls.

During migration, `TileRenderRig.draw()` can remain as a compatibility
shim that delegates to the renderer. The traversal can later call the
renderer directly once the new boundary is stable.

### Suggested execution direction

The candidate rendering model is multipass-first:

- `blend` operations use fixed-function blending where possible;
- `push` operations can render into an independent intermediate target;
- `pop` sources can bind a prior intermediate texture;
- layer-specific renderers can produce tile-local textures for later
  layers;
- depth and footprint passes remain specialized paths rather than
  variants of the full color shader;
- optimization may fuse adjacent compatible passes or substitute a
  specialized fast path for common simple stacks.

This is not yet an RFC-level design. Open questions include target
allocation, tile-local texture lifetime, pass sorting constraints,
interaction with traversal masks, interaction with atmosphere/shadows,
where normal collapse belongs after the executor split, and how much
state should be represented as an explicit pass graph.

### Measurement plan

Start with a flag-gated experimental path for a small current subset,
for example constants, diffuse texture layers, and simple shading.
Compare it with the current monolithic rig on the canonical terrain
URLs:

- `simple-terrain`
- `complex-terrain`
- `full-terrain`

Measure visual parity, draw calls, program switches, framebuffer
switches, texture binds, CPU frame cost, and GPU frame cost when
`mapProfileGpu=1` is enabled. The useful result is not only "faster" or
"slower": if the multipass path loses, the counters should show whether
the cost comes from framebuffer bandwidth, draw-call CPU overhead,
texture binds, or pass setup. If it wins, expand the experiment to
bump, specular, atmosphere, shadows, and traversal-mask cases.

**Update 2026-06-06:** a first A/B measurement is done — see
[tile-render-rig-profiling.md](tile-render-rig-profiling.md). On
`simple.json` at 2560×1353 the settled frame is fragment/fill bound
(~85 draws, but CPU ~3 ms and flat with resolution; GPU tracks pixel
count). Hand-specializing the layer loop into a straight-line shader for
that stack is pixel-equivalent and ~1.0–1.9 ms cheaper (clock-matched,
~15% of the no-discard frame), with the cost shape pointing at layer-VM
register pressure rather than shading math. That straight-line shader is
exactly the "specialized fast path for common simple stacks" this entry
proposes: the executor split, done for a simple stack, produces it. The
profiling doc also isolates a larger, separate win — removing the
shader's `discard` (see
[35. PERF: discard-free tile color shader for watertight tiles](backlog-archive.md#35-perf-discard-free-tile-color-shader-for-watertight-tiles)) — which the executor split
should preserve by keeping depth and footprint as specialized,
discard-free passes.

---

## 31. REFACTOR: audit draw-readiness policy flags after traversal rollout

**Opened:** 2026-05-30
**Status:** open

### Goal

Audit the legacy negative readiness flags from their resource-layer
roots upward, then replace them with a clearer policy abstraction if the
inventory supports it.

### Rationale

Flags such as `preventRedener`, `preventLoad`, and `doNotCheckGpu` are
used by surface rendering, geodata free-layer rendering, legacy draw
traversal, recursive draw traversal, and resource classes such as mesh
and texture. Their names are negative and partly misleading.
`doNotCheckGpu`, for example, can mean "do not require or create GPU
residency" rather than "verify that GPU resources are ready". The
off-cadence fallback probe added during the draw-traversal rollout uses
these flags because that is the smallest compatible change, not because
the abstraction is good.

### Suggested direction

After the legacy traversal is removed:

1. Start at resource classes such as mesh, texture, subtexture, geodata,
   and geodata view. Record what each readiness flag controls: network
   fetch, retry scheduling, cache warming, CPU decode, GPU upload, and
   GPU-cache accounting.
2. Trace those meanings upward through `drawSurfaceTile`, geodata
   callers, legacy traversal, recursive traversal, and `TileRenderRig`.
3. Decide the replacement level only after the inventory. The fix may
   belong in resource readiness, draw orchestration, traversal callers,
   or a small policy object shared across those boundaries.
4. Prefer positive policy terms if the inventory supports them, such as
   `render`, `fetch`, `upload`, and `construct`.

---

## 32. PERF/UX: screen-space terrain-error map

**Opened:** 2026-05-31
**Status:** deferred
**Related:** [rfc03-draw-traversal.md](rfc03-draw-traversal.md)

### Goal

Build a screen-space map of terrain error or uncertainty during terrain
rendering, then use it as shared frame state.

### Rationale

The current loading state is judged from resource readiness and coarse
distance-based priority. That answers whether data exists, but it does
not say how much the current frame would improve if a pending tile
loaded. A screen-space terrain-error map can measure where rendered
fallback geometry contributes most to visible map inaccuracy.

The same map can support three uses:

- loading polish: drive a small terrain-only blur around high-error
  regions, hiding coarse fallback artifacts and spilling over cracks
  between tiles of different coarseness;
- loaded-state reporting: aggregate the map to decide when the visible
  terrain is accurate enough for the splash screen or loading indicator
  to disappear;
- resource priority: prioritize pending resources by their contribution
  to visible frame error, replacing the current crude closest-first
  heuristic with a view-dependent accuracy signal.

### Suggested direction

Keep this separate from the traversal mask. The traversal mask remains
the coverage/occlusion mechanism; the terrain-error map is a
screen-space estimate of visual inaccuracy and loading quality.

---

## 29. REFACTOR: drop metatile format versions 1–3

**Opened:** 2026-05-27
**Status:** open

### Goal

Remove all client-side code paths that exist only to handle metatile
format versions 1, 2, and 3.

### Rationale

The mapy.com production deployment serves version 4, confirmed by
inspecting live responses (2026-05). No known live data source produces
versions 1–3. The v1–v3 code paths carry meaningful complexity:

- Quantized physical extent decoding in
  `MapMetanode.prototype.parseMetanode()` —
  [src/map/metanode.js](../../src/map/metanode.js)
- Aliasing `minZ`/`maxZ` to the int16 navSRS `minHeight`/`maxHeight`
  instead of reading explicit float32 SDS values
- `MapSurfaceTree.prototype.updateNodeHeightExtents()` in
  [src/map/surface-tree.js](../../src/map/surface-tree.js)
  — propagates the height range from navtile-flagged ancestors to
  children for culling box construction; guarded by
  `node.metatile.useVersion < 4` and never fires against v4+ data
- The `mapForceMetatileV3` config flag, which forces `useVersion = 3`
  as an escape hatch for debugging the v4/v5 culling path; no longer
  needed once v3 is gone
- Credit-block parsing differences between v1 and v2+ (separate
  `creditCount`/`creditSize` fields in v1)
- `nodeSize` header field in v1 (used to skip unknown node formats)

### What to delete

- The `if (version < 4)` alias in `parseMetanode()` that sets
  `this.minZ = this.minHeight` (v1–v3 had no explicit float32 SDS
  heights, so `minZ`/`maxZ` were aliased from the navSRS int16 range;
  v4+ stores them separately) —
  [src/map/metanode.js:211](../../src/map/metanode.js)
- `MapSurfaceTree.prototype.updateNodeHeightExtents()` and all its
  call sites in the legacy and typed traversals — this propagation
  exists only because the alias above produces unreliable height ranges
  for pre-v4 tiles and children need to inherit from the nearest
  navtile-flagged ancestor —
  [src/map/surface-tree.js:157](../../src/map/surface-tree.js)
- The `mapForceMetatileV3` config key, its setter/getter in `map.js`,
  and the `useVersion` override logic in `MapMetatile`
- The v1-specific credit-block parsing path (`creditCount`/`creditSize`
  pre-header fields)
- The v1 `nodeSize` header field handler

**Do not delete** the `if (version < 5)` quantized-extents branch in
`parseMetanode()`. Despite the name, that branch fires for v1 through
v4: v4 tiles still carry the packed `geomExtents` bytes in the stream;
v5 is the format version that removes them. The bbox decoded from those
bytes is still used for culling on v4 tiles. Deleting that branch would
misalign the stream reader and corrupt all subsequent field reads for
v4 metatiles.

### Precondition

Verify that no style or mapConfig consumed in the test suite or by
active deployments points at a tileserver that produces v1–v3 metatiles.
The metatile version is readable from the first two bytes after the
`MT` magic: `uint16 LE` at offset 2.

---

## 38. BUG: TileRenderRig soft view switching has early-exit gaps

**Opened:** 2026-06-10
**Status:** open — `lastRenderRig` covers the normal same-surface view
switch, but `drawSurfaceTile` can return before reaching the fallback
rig path
**Related:** [rendering-architecture.md](rendering-architecture.md)

### Confirmed behavior

`MapSurfaceTile.viewSwitched()` keeps the current `tileRenderRig` alive
and sets `tile.updateBounds = true`. On the next terrain draw,
`drawSurfaceTile` moves the old current rig to `lastRenderRig[i]`,
constructs a new `TileRenderRig`, and draws `lastRenderRig[i]` when the
new rig is not ready. This is the modern terrain equivalent of the old
`lastRenderState` soft view-switch replay.

The old command replay and the new rig fallback do not have identical
failure surfaces. `lastRenderState` could replay commands while new tile
state was being rebuilt. The `lastRenderRig` fallback only runs after
`drawSurfaceTile` reaches the per-submesh rig loop.

### Caveats

- If the new view points at a different surface and the new mesh has not
  parsed submesh metadata yet, `drawSurfaceTile` returns before the
  per-submesh loop, so the old rig is not drawn for that tile.
- If CPU mesh data has been evicted (`surfaceMesh.submeshesKilled`) at
  the moment a rig rebuild is needed, the rebuild is deferred until CPU
  data reloads. Existing GPU-resident rigs can keep drawing when no
  rebuild is needed, but a required rebuild does not currently fall back
  to the old rig inside the same branch.

### Follow-up

If visible holes appear during surface or style switches, instrument
`drawSurfaceTile` around the early returns and the CPU-residence guard.
The desired property is that a GPU-resident previous rig can draw
whenever the tile position is still valid and the replacement rig cannot
yet be constructed or made ready. Any fix must avoid constructing a new
rig from killed CPU submesh fields; that guard prevents the drab-tile
race documented in
[30. BUG: TileRenderRig — internal texture missing from layer stack](backlog-archive.md#30-bug-tilerenderrig--internal-texture-missing-from-layer-stack).

---

## 19. BUG: depth hitmap dead zone near geometric horizon

**Opened:** 2026-05-20
**Status:** open — cause not yet identified

The starting view of `demos/depth-test/` has a strip near the terrain
horizon where `getScreenDepth` returns no reading. In that view it is
about 8 px wide at the viewport centre and about 4 px wide at the edges.
The dead zone is largely undetectable in many other views, and its
existence seems independent of hitmap resolution.

The bug persists after the depth hitmap changed from RGBA8 base-255
packing to RGBA8UI float bit-pattern storage. This rules out the old
RGBA8 carry-error path as the cause of the horizon dead strip.

---

## 22. REFACTOR: pass explicit draw contexts

**Opened:** 2026-05-24
**Status:** open

### Goal

Replace the freeze-mode `withSelectionCamera` and
`withNavigationCamera` bridge with explicit draw context parameters once
legacy camera and position reads are removed from the draw code.

### Target shape

Draw code should receive the context it needs instead of installing it
by mutating `map.position`, `MapCamera`, `Renderer.camera`, and renderer
camera mirrors. A frame should make the two roles explicit:

- `view`: the camera and position used to render the final image.
- `selection`: the camera and position used for tile selection, culling,
  depth sampling, and scale-dependent vertical exaggeration.

Freeze mode then becomes a context choice:

```ts
const view = map.navigationContext();
const selection = freeze.active ? freeze.selectionContext() : view;

drawFrame({ view, selection });
```

Final terrain and geodata rendering must preserve the existing hybrid
semantics: draw from `view`, but derive vertical exaggeration from
`selection`.

---

## 16. REFACTOR: replace `gpu.setState` with per-method GL state push/pop

**Opened:** 2026-05-18
**Status:** deferred

This is a possible renderer redesign, not the current coding rule.
The current rule is documented in
[gpu-subsystem.md](gpu-subsystem.md): draw sites may leave GL state active,
while pass setup and clear helpers establish the state they require.

Each draw method would save the GL flags it needs on entry, apply them
with direct `gl.*` calls, and restore on exit. No shared state objects,
no caller/callee coordination, no implicit assumptions about prior
state. The current `setState`/`currentState` delta tracking is an
optimisation for the coordination problem that disappears once each
method owns its state window.

---

## 8. REFACTOR: continue absorbing legacy objects into `Map`

**Opened:** 2026-05-04
**Status:** in progress — `Map` shell done; absorption continues

### Done

`Map` (`src/map/map.ts`) exists and replaces `CoreInterface`. `Viewer`
constructs and holds `Map` directly. `CoreInterface`, `Core`, and their
declarations are deleted.

### Remaining

`Viewer` still accesses `LegacyMap` and `Renderer` via the `Map.core`
escape hatch (`this._core.core.map`, `this._core.core.renderer`, etc.).
Each method promotion must route through a proper `Map` public method
instead, allowing the `core` shim to be deleted.

| Object | Status |
|---|---|
| `CoreInterface` | **Deleted** — replaced by `Map` |
| `Core` | Private in `Map.core_`; pending absorption |
| `MapInterface` | **Deleted** — wrapper methods moved to `Map` / `LegacyMap` |
| `RendererInterface` | Pending — second set |
| `LegacyMap` (JS half of `Map`) | Pending — long-term absorption |
| `Renderer` | Pending — private implementation of `Map` |

### Next steps

- Once all `Viewer` callers go through `Map`, delete the `core` getter.

---

## 13. REFACTOR: remove legacy nullable construction paths

**Opened:** 2026-05-14
**Status:** in progress

### Goal

Construction of `Viewer`, `Map`, and `Renderer` should either complete
or throw. An instance with no engine object is not a valid object.

### Done

`GpuDevice.checkSupport()` throws when WebGL2 support is absent. `map()`
returns `Viewer`, not `Viewer | null`. Non-legacy demos no longer check
the factory result for falsiness.

`GpuDevice` now throws when canvas or WebGL2 context creation fails.
`Map` keeps its `Core` reference non-null; after disposal, public
methods throw instead of returning `null`.

`GpuDevice.checkSupport()` is the canonical throwing pre-flight probe.
`Viewer` calls it before config validation or DOM insertion and does
not interpret or replace its device-specific error. The legacy
`checkSupport` function in `core.js` and its re-export from the public
namespace are removed.

Constructor-time config is stored before `Map` construction. `Viewer`
rolls back a constructed map and UI wrapper if a later child constructor
throws.

### Remaining

The first audit found no remaining path where a public constructor can
return an object without its construction-owned engine object. Remaining
nullable returns mostly describe runtime states:

- `Map.legacyMap` is `null` before asynchronous style loading finishes.
- `Map` and `Viewer` coordinate conversion and hit/depth methods return
  `null` when the loaded map cannot answer the query.
- Atmosphere access returns `null` when the loaded map cannot render
  an atmosphere (the body declares no atmosphere parameters or the
  density service is missing).
- `Viewer.assertAlive()` handles calls after viewer disposal. This is
  lifecycle behavior, not construction failure.

Keep this item open until one more focused audit confirms that nullable
checks in `Viewer`, `Map`, `Renderer`, and `GpuDevice` fall into the
runtime-state categories above. Remove a check
only if it exists solely to tolerate a failed constructor after an object
has already been returned.

### Next audit targets

- `src/map/map.ts`: document which `core_.map?.` calls mean
  unloaded-map state.
- `src/renderer/renderer.ts`: keep `core.map?.markDirty()` checks
  that allow renderer settings before a map has loaded.

---

## 12. REFACTOR: promote ui/autopilot/presenter to flat Viewer methods

**Opened:** 2026-05-14
**Status:** deferred

### Motivation

`Viewer.ui`, `Viewer.autopilot`, and `Viewer.presenter` hand the caller
entire legacy JS sub-objects whose method surfaces are untyped.
A caller using `viewer.autopilot.flyTo(...)` works directly in the legacy
object graph, bypassing the typed `Viewer` surface. This is inconsistent
with the goal of a flat, typed public API and the AGENTS.md rule against
restoring browser-level sub-object access on `Viewer`.

### Plan

For each getter, identify every call site (demos and any consumer code).
Promote the needed operations as typed, flat methods on `Viewer`
(e.g. `flyTo()`, `stopFlight()`, `setAutorotate()` for autopilot).
Remove the getter once all call sites use the flat method.

Priority order: `autopilot` (one call site in waypoint demo), then `ui`
and `presenter` (no current typed call sites outside legacy demos).

---

## 11. BUG: runtime free layers do not render on style-based maps

**Opened:** 2026-05-14
**Status:** deferred

### Symptom

`demos/core/index.html` calls `viewer.createGeodata()` and
`viewer.addFreeLayer('route', geo.makeFreeLayer(style))` from its
`map-loaded` listener. The function fires and the geodata builder is
created, but the route is not visible.

### Root Cause

Style-based maps do not use the legacy `view.freeLayers` activation path.
`MapStyle.refreshSequences()` builds `map.freeLayerSequence` from
`style.layers`. A runtime call to `LegacyMap.addFreeLayer()` only adds
the free layer object to `map.freeLayers`; it does not add a style layer
entry, so the renderer never sees it in `map.freeLayerSequence`.

Legacy demos add a free layer in two steps:

```js
map.addFreeLayer('geodatatest', freeLayer);
const view = map.getView();
view.freeLayers.geodatatest = {};
map.setView(view);
```

That is not the right model for style-based maps, where the style is the
composition contract.

### Suggested Fix

Design a style-era runtime overlay API. It should register the geodata source
and the style layer or stylesheet needed to render it, then refresh the
style-driven sequences. Do not revive legacy `view.freeLayers` as a hidden
side effect of `Viewer.addFreeLayer()`.

### Relevant Files

| File | Note |
|---|---|
| `demos/core/index.html` | Demonstrates the missing runtime overlay path |
| `src/viewer/viewer.ts` | `createGeodata` / `addFreeLayer` public methods |
| `src/map/style.ts` | Builds `freeLayerSequence` from `style.layers` |
| `src/map/legacy-map.js` | Legacy `addFreeLayer` registers only the object |

---

## 4. BUG: control-mode listens for `mousewheel` instead of `wheel`

**Opened:** 2026-04-19
**Status:** deferred

### Symptom

In an embed where reveal.js sits above the cartolina container in the DOM, scroll-wheel zoom does not work when events are forwarded synthetically via `dispatchEvent`. Synthetic `WheelEvent('wheel', …)` dispatched to the map container has no effect.

### Root cause

`src/viewer/control-mode/control-mode.js` line 26 registers:
```js
this.mapElement.on('mousewheel', this.onWheel.bind(this));
```

`mousewheel` is a deprecated, non-standard event. Modern browsers fire `wheel` (W3C standard) and additionally still fire `mousewheel` for legacy code when a real user scrolls — but a synthetically constructed `new WheelEvent('wheel', …)` does NOT also fire `mousewheel`. So the forwarding never reaches `onWheel`.

### Fix

Replace `mousewheel` with `wheel` in `control-mode.js`. The `wheel` event provides `deltaX`, `deltaY`, `deltaMode` (all that `onWheel` uses). If `wheelDelta` (deprecated) is referenced anywhere downstream, replace with `-deltaY * 120 / 3` (the conventional scaling).

### Relevant files

| File | Note |
|---|---|
| `src/viewer/control-mode/control-mode.js:26` | the `mousewheel` listener to replace |

---

Bugs and deferred work that are not yet scheduled.

---

## 23. FEATURE: MapLibre-style `type: 'custom'` style layer

**Opened:** 2026-05-25
**Status:** deferred — depends on style-era runtime overlay API

### Motivation

`Viewer.addOverlay(name, spec)` (added 2026-05-25, replacing the
deleted render-slot machinery) runs once per frame as the explicit
last step of the canvas-target frame. The single placement is
deliberate: pass sequencing inside the engine is in flux, and naming
internal placements on the public surface would lock the engine out
of reordering.

A MapLibre-style `type: 'custom'` style layer is the next step up.
The host registers a custom layer through `addLayer` with a render
callback; the layer takes its position in the style's layer array
and the engine guarantees order relative to other visible layers.
This expresses "draw between the bridges and the labels" through the
same vocabulary already used for declarative layers.

### Preconditions

- Pass sequencing has settled enough to make layer-relative
  placement honest. Currently terrain, label, and geodata-job
  phases are still being moved around (see the draw refactor and
  the geodata RFC).
- The style-era runtime overlay API question is resolved (see
  "BUG: runtime free layers do not render on style-based maps" in
  this file). That entry tracks the closely related question of
  how style layers are added at runtime; a custom-layer mechanism
  should land alongside it, not separately.

### Sketch

```ts
viewer.addLayer({
    id: 'my-overlay',
    type: 'custom',
    renderingMode: '2d' | '3d',
    onAdd?:  (ctx) => void,
    render:  (ctx) => void,
    onRemove?: (ctx) => void,
}, beforeId?);
```

`addOverlay` does not go away — it remains the right tool for
content that genuinely belongs on top of the whole map (debug HUDs,
host-owned post-effects) where layer-relative placement would
require inventing a sentinel layer to anchor against. The two APIs
coexist; the custom-layer API is for content that is logically part
of the map.

---

## 7. FEATURE: explicit offscreen render-pass API

**Opened:** 2026-05-03
**Status:** deferred

### Motivation

The `GpuDevice.RenderTarget` abstraction is the right low-level direction
for multipass rendering: it separates framebuffer binding and viewport
state from the canvas element. The next layer above it must make camera
and logical-size intent explicit.

Upcoming renderer work will need offscreen rendering for:

- shadow maps
- selective blur and postprocessing ping-pong buffers
- zenith rendering for direct processing of OpenMapTiles data instead of
  server-side translations
- masks, object IDs, and G-buffer-like data for the current view
- generated lookup, normal, atmosphere, or compositing textures

The render-target regression showed why this distinction matters:
`updateLogicalSize()` silently mixed framebuffer size, camera aspect, and
screen-space matrix updates. Routing a square hitmap through it changed
the screen camera aspect to `1`, so auxiliary depth data diverged from
screen-coordinate label placement and hit testing.

### Suggested direction

Keep `GpuDevice.setRenderTarget()` as the low-level GPU operation. It
should bind the framebuffer, store the active target, and call
`gl.viewport()`. Higher-level render-pass setup should name the intended
projection policy.

Two useful categories:

- **Auxiliary target:** stores extra data for the current onscreen map
  view. It may have its own framebuffer size, but it uses the same
  camera/projection as the canvas pass. Examples: depth hitmaps, geodata
  hitmaps, object IDs, masks, and G-buffer data for the current view.
- **Independent target:** renders something whose projection is defined
  by the offscreen target itself, not by the current screen view. It may
  use a special camera, a target-aspect projection, or no scene camera at
  all. Examples: shadow maps, environment maps, postprocessing buffers,
  blur passes, lookup textures, generated normal maps, atmosphere
  textures, and compositing buffers.

The API could express this as an explicit pass target:

```ts
type RenderPassTarget = {
    texture: GpuTexture;
    viewportSize: Size2;
    logicalSize: Size2;
    projectionPolicy: 'auxiliary' | 'independent' | 'none';
};
```

Alternatively, split setup into named paths:

```ts
setAuxiliaryTarget(target);
setIndependentTarget(target);
```

The policy names mean:

- `auxiliary`: preserve the current canvas camera/projection even when
  the framebuffer has a different aspect or resolution.
- `independent`: update or choose a projection that belongs to the
  offscreen target, such as a light-space projection for a shadow map.
- `none`: the pass has no scene camera, such as a blur, lookup-table
  generation, or compositing pass.

The important rule is that multipass code must not infer projection
behavior from framebuffer dimensions. Target binding, camera aspect, and
screen-space matrices are separate decisions.

### Related notes

See [render-targets.md](render-targets.md) for the current
auxiliary-buffer policy and
[rendering-sizes.md](rendering-sizes.md) for the size vocabulary
used by render targets.

---

## 2. FEATURE: pitch / horizon-based line dissipation

**Opened:** 2026-04-15
**Status:** deferred

### Motivation

Lines such as boundaries that follow ridge lines become noisy and
unnatural-looking when rendered at high oblique viewing angles or close
to the horizon.

The desired behavior is a dissipation mechanism that increases line
transparency as the camera approaches that state, either as a built-in
renderer behavior or as a style-configurable feature.

### Current limitation

The current style system does not expose camera pitch as a normal style
expression input for line color, and geodata line color is currently
resolved in worker-generated render jobs rather than evaluated per
frame.

### Suggested direction

Possible implementation directions:

- add a built-in line dissipation behavior tied to camera pitch,
  horizon angle, or a related renderer-space measure
- expose a camera-dependent style input so line opacity or color can be
  driven from style
- prefer transparency / dissipation over a hard visibility cutoff so
  ridgeline boundaries fade out naturally instead of popping

### Notes

There is already tilt-aware runtime behavior in geodata reduction, so
the renderer does have camera-angle information available. The missing
piece is a render-time color / opacity path for geodata lines.

## 1. BUG: `checkVisibility()` misjudges terrain-anchored points near silhouettes

**Opened:** 2026-04-14
**Status:** partly fixed 2026-07-28. The depth comparison itself is
fixed and measured. Terrain-anchored (`'float'`) points remain wrong, so
no caller performs the check; `demos/waypoint/waypoint.js` deliberately
does not.
**Related:** the navtile ranking entries above, [nav-tiles.md](nav-tiles.md)

### What was wrong, and is now fixed

Three defects made the comparison meaningless. All three are fixed.

1. **Wrong depth domain.** The depth pass writes the distance to the
   surface as drawn, which carries vertical exaggeration. The point's
   distance was computed without it, a systematic bias of up to +2.7% of
   the view distance. `checkVisibility` now passes
   `applyVerticalExaggeration`.

2. **Exaggeration factor from the wrong position.**
   `getPositionPhysCoords` and `getPositionCameraSpaceCoords` took the
   view-extent progression factor from the throwaway per-point
   `MapPosition`, whose view extent is hardcoded to 10. At a 500 km view
   that gave 1.0 where the renderer had baked 3.16. Both now source it
   from `this.map.position`, as `surface-tile.js` and `camera.js` do.

3. **Ramp inverse composed in the wrong order.**
   `getUnsuperElevatedHeight` inverted the height ramp and then divided
   out the progression factor. The forward transform is ramp first,
   factor second, and the ramp is not linear, so the two did not compose
   to the identity — up to 154 m of round-trip error. Now exact at every
   extent measured.

Scored against ground truth generated along the view ray (a point nearer
than the terrain hit is visible, one beyond it is occluded), at view
extents 33 km, 80 km and 500 km, for points given explicit heights:

| | surface | in front | behind |
|---|---|---|---|
| before | 46-49 / 49 | 97 / 98 | 55-93 / 98 |
| after | 49 / 49 | 98 / 98 | 95-98 / 98 |

Dilation was also dropped from the sample (it takes the nearest terrain
over a neighbourhood, which label placement wants but which biases a
point query toward occlusion by up to 9%), and the tolerance tightened
from 3% to 1%, sized just above the 0.4% residual left by depth-map
quantisation.

### What is still wrong

A `'float'` point's height comes from the navigation height field, which
is a coarser sampling of the terrain than the mesh on screen. At the
waypoint demo's Mount Whitney marker the field returns 3480 m where the
mesh draws 3597 m, and no lod hint closes the gap — `getSurfaceHeight`
saturates from lod 7 upward, because that is the finest navtile there is.

117 m of height error is enough. At that view the anchor projects 3.8 px
below where its ground is drawn, which puts it just across a silhouette
edge onto a ridge 1.5 km nearer, and the depth test reports occlusion.
A dense sweep of the depth map confirms the ground is visible: it is
drawn at pixel (600, 392), 86 m from the requested position, less than
one depth-map texel.

The failure is therefore not a tolerance that needs tuning. Near a
silhouette the depth test is ill-conditioned in the anchor height, and
the anchor height is exactly what is uncertain.

### Mitigations measured and rejected

Ground truth for these came from sweeping every fifth pixel and
collecting the surface point drawn there — those points are exactly the
terrain the camera can see, so a position is visible when one lands on
it and hidden when none comes close.

**Horizontal separation** between the anchor and the ground drawn at
its pixel. The two populations overlap completely: visible ground has
median 209 m and p90 999 m, hidden ground median 475 m and p10 110 m.
No threshold divides them.

**Iterate the anchor** onto the drawn surface, adopting the height found
at each step. Oscillates on the demo marker: 1443, 888, 362, 1286 m.

**Allow any height within a window** above the anchor. Destroys
occlusion detection: hidden ground correctly rejected falls from 53/162
to 0/162 as the window grows wide enough to show the marker.

**Search a pixel neighbourhood** for the requested ground. Recovers
about 92% of visible ground at a radius of 3-4 texels and holds
occlusion at about 85%, but costs roughly 50 `getHitCoords` calls per
point per frame, and its verdict on the demo marker flips between runs
as terrain streams in.

### Suggested fix direction

The instrument this needs is an anchor height that agrees with the mesh
being drawn. A per-lod height map generated from the terrain itself,
rather than from stored navtiles, would give one; the check then reduces
to the depth comparison that already works for explicit heights. Revisit
when that exists.

### Relevant files

| File | Note |
|---|---|
| `src/viewer/viewer.ts` | `checkVisibility()` |
| `src/map/convert.js` | exaggeration factor source |
| `src/renderer/renderer.ts` | the two exaggeration height functions |
| `src/map/measure.js` | `getSurfaceHeight`, the navtile field |
| `src/map/legacy-map.js` | `getHitCoords`, `getScreenDepth` |
| `demos/waypoint/waypoint.js` | marker loop; does not call the check |

### Latent, not reached by any caller — closed

The three call sites that passed too few arguments now pass the current
map position, so the `containsSE` paths no longer throw when a caller
reaches them.
---
