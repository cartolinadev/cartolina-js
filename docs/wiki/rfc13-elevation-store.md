# RFC 13: the elevation store

**Status:** Draft
**Opened:** 2026-08-21
**Related:** [nav-tiles.md](nav-tiles.md),
[reference-frames.md](reference-frames.md),
[rendering-architecture.md](rendering-architecture.md),
[gpu-subsystem.md](gpu-subsystem.md),
[render-targets.md](render-targets.md),
[geodata-rendering.md](geodata-rendering.md)


## 1. Context

Cartolina needs terrain elevation whenever a two-dimensional position must
become a point on the three-dimensional map. The current consumers include
floating map positions, camera motion, coordinate conversion, public terrain
height queries, waypoints, and client-built geodata. They obtain terrain
height from navigation tiles.

A navigation tile is a second representation of elevation. It is produced
and delivered separately from the terrain mesh. Its available LOD can stop
above the mesh LOD, and the delivered format omits its coverage mask. The two
representations can therefore disagree at the same position. The Mount
Whitney case in [backlog.md](backlog.md) is measured: the navigation field
returns 3480 m where the rendered mesh is 3597 m. The resulting waypoint is
projected below the ridge and classified as occluded.

Tiled geodata has a separate elevation path. The tileserver heightcodes every
geographic coordinate before delivery. This requires the server to decode
the vector tile, sample its configured DEM, and emit three-dimensional
geodata. The result is tied to the server-side DEM and to the geodata free
layer format. A source of ordinary two-dimensional vector tiles cannot use
that path without server-side processing.

The project direction is to consume ordinary two-dimensional vector tiles,
including OpenMapTiles data, and add terrain height in the client. That
removes geodata free-layer metatiles and server-side heightcoding from vector
delivery. The client needs a batched elevation service before that change can
be designed.

The terrain model will also gain raster elevation sources. Such a source
already is a height field, while a `cartolina-surface` is an irregular mesh.
Consumers should not depend on either representation. They should see the
terrain produced by the current terrain-source stack.


## 2. Architectural decision

The map will own an elevation store: a bounded, temporal, GPU-backed cache of
the composed terrain height field.

The store is derived from the same ready terrain resources and the same
source-priority and partial-coverage rules as terrain rendering. It is not a
terrain source, does not participate in selection, and never requests a
metatile, mesh, or raster. The screen traversal remains the only source of
terrain demand. A store update can use a resource only after normal rendering
has made it available.

Meshes enter the store through texture-space rasterization. Existing external
mesh UVs map each triangle into its reference-frame tile. Raster elevation
sources will later write through a source-specific path into the same logical
field. Point lookup and coarser-level construction then operate on one
representation regardless of terrain source type.

The store is temporal. It retains regions visited by current and recent
views, subject to a memory budget. A query returns the best covered level that
is resident when the query runs. A later query can return a finer or newer
answer after another terrain frame has supplied better input.

Terrain-source mutations invalidate the complete store. They are rare, and a
complete invalidation has a clear correctness rule. The first implementation
will not maintain per-sample provenance across a changed source stack.

The canonical value is the value exposed to every store consumer. The first
implementation stores unfiltered terrain. A future VHR rasterization path may
apply morphological opening before committing its height field. In that case
the opened field becomes canonical. The store will not retain or expose the
unfiltered field.

This is a sound basis for the planned vector work because it places height
resolution at the only layer that knows the terrain currently available to
the client. It also removes a duplicated network elevation representation
once the remaining navigation-tile consumers have migrated.


## 3. Project outcomes and RFC scope

The elevation store is intended to enable four project outcomes:

- terrain-anchored points use the terrain field derived from rendered
  geometry;
- ordinary two-dimensional vector tiles are heightcoded in the client;
- navigation tiles and server-side vector heightcoding can be retired; and
- raster terrain sources can provide the same elevation service and later
  derive node height ranges.

RFC 13 implements the common prerequisite. Its deliverables are the
map-owned store, periodic render-fed population, batched asynchronous point
queries, refresh semantics, bounded memory, a flat `Viewer` API, waypoint
migration, and the validation described in section 13.

This RFC does not implement the vector-tile source, remove geodata free-layer
metatiles, remove tileserver heightcoding, add a raster terrain source, or
remove navigation tiles. Those are follow-on changes that consume the
validated store. It also does not implement node min/max summaries or VHR
morphological opening. Sections 11 and 12 fix the boundaries that those
changes must use so phase one does not obstruct them.


## 4. Elevation model

### 4.1 Coordinate and height semantics

The query position is XY in the reference frame's navigation SRS. The result
adds navigation Z.

The initial store supports a geocentric physical SRS and a geographic
navigation SRS using the same reference ellipsoid and ellipsoidal height. This
covers the Earth and planetary reference frames currently used by the
library. Store construction requires all of the following:

- the physical SRS reports `proj-name: geocent`;
- the navigation SRS reports `type: geographic`;
- the navigation SRS has no geoid grid or vertical-adjustment modifier; and
- the semi-major and semi-minor axes parsed from both SRS definitions are
  equal; and
- every bisection division-node SRS is projected, has one finite linear-unit
  conversion for both horizontal axes, and defines finite ellipsoid axes.

On an unsupported reference frame, `heightcode()` rejects with
`NotSupportedError`; rendering continues without a store. The checks are
semantic and do not depend on an SRS identifier. They do not inspect the
legacy `MapSrs.vdatum` label: current registry SRS entries omit that field and
the parser defaults it to `orthometric` even when the operative transform is
ellipsoidal.

The stored height is not vertically exaggerated. Vertical exaggeration is a
presentation transform and does not invalidate the store. A height function
already baked into a mesh is geometry and is therefore present in the stored
height.

For a mesh vertex, the elevation vertex shader reconstructs absolute physical
coordinates by adding `uFrame.physicalEyePos.xyz` to the camera-relative
position produced by `uModel`. It converts ECEF to geodetic height with the
reference ellipsoid axes already carried by the frame UBO.

The conversion uses Bowring's closed-form latitude estimate. With semi-major
axis `a`, semi-minor axis `b`, `p = length(xy)`, first eccentricity squared
`e2`, and second eccentricity squared `ep2`:

```text
lon = atan(y, x)
theta = atan(z * a, p * b)
lat = atan(z + ep2 * b * sin(theta)^3,
           p - e2 * a * cos(theta)^3)
N = a / sqrt(1 - e2 * sin(lat)^2)
q = [N * cos(lat) * cos(lon),
     N * cos(lat) * sin(lon),
     N * (1 - e2) * sin(lat)]
normal = [cos(lat) * cos(lon),
          cos(lat) * sin(lon),
          sin(lat)]
h = dot(ecef - q, normal)
```

On the geocentric axis, where `p == 0`, the shader uses `abs(z) - b` and does
not evaluate longitude. Away from that axis, computing height by projection
onto the geodetic normal avoids the less stable subtraction
`p / cos(lat) - N`. Section 13 validates the single-precision shader against
the current CPU SRS conversion before terrain data is accepted.

### 4.2 Composition

The terrain stack is ordered back-to-front by the style. The store applies
the current terrain traversal's front-to-back ownership rule: a
higher-priority surface owns its covered fragments, and a lower-priority
surface fills only gaps. The same UV-space coverage masks define partial
coverage and descendant fallback.

Within one mesh, the upper height wins when projected triangles overlap. For
the reference-frame range `[minHeight, maxHeight]`, the raster target uses
`(maxHeight - height) / (maxHeight - minHeight)` as depth. A transient depth
attachment cleared to one and tested with `LEQUAL` then keeps the highest
fragment. A height outside the declared range is discarded and increments a
diagnostic counter. Geometry with zero area in external UV space, including a
collapsed skirt wall, produces no stored coverage.

Every numeric sample has an associated validity state. Physical storage
encodes the state with a reserved NaN value, but the logical rule is still
height plus coverage. A NaN is never a terrain height and never answers a
query.

### 4.3 GSD

GSD is metres per logical elevation sample. A larger value is coarser. It is
derived from the reference-frame grid, not from a terrain source's metanode
`texelSize`.

A query interpolates one local projection factor, converts the requested
physical GSD to nominal division-grid GSD, and selects a resident LOD in the
nominal bisection hierarchy. It converts the selected nominal GSD back to
physical GSD for the result. It does not evaluate a Jacobian per query or per
candidate LOD.

#### Representation

Each bisection division node has one projection-factor grid. A grid has an odd
size `N` and contains `N * N` samples of `log2(arealScale)`. The first grid is
5 by 5. Its samples lie on the division-node boundary and divide the node into
4 by 4 interpolation cells:

```text
p(i, j) = [ll.x + i * W / (N - 1),
           ll.y + j * H / (N - 1)]
```

where `i` and `j` range from zero through `N - 1`. A query obtains its local
factor by bilinear interpolation of `log2(arealScale)`. Logarithmic
interpolation is used because projection scale is multiplicative and the GSD
calculation is linear in its logarithm.

For division-SRS linear unit size `u` metres and interpolated PROJ areal scale
`S(p)`, nominal and physical GSD are related by:

```text
physicalGsd = nominalGsd * u / sqrt(S(p))
nominalGsd = physicalGsd * sqrt(S(p)) / u
```

PROJ defines `S` as projected area divided by ellipsoidal ground area. The
division-SRS sample area is divided by `S`. This is the relationship used by
the [mapproxy-tiling spatial GSD prune][mapproxy-gsd-grid].

#### Grid construction

The browser's current `proj4` dependency does not expose projection factors.
The initial implementation therefore derives each factor from the Jacobian of
`F`, which converts division-SRS XY to height zero on that projection's base
ellipsoid, expressed in a geocentric SRS with the same axes:

```text
Jx(p) = dF(p) / dx
Jy(p) = dF(p) / dy
linearScale(p) = sqrt(length(cross(Jx(p), Jy(p))))
S(p) = (u / linearScale(p))^2
```

`Jx` and `Jy` are evaluated with centred differences. The step on each axis is
the standard double-precision derivative step:

```text
h = cbrt(Number.EPSILON) * max(abs(coordinate), axisExtent, 1)
```

At a projection boundary, the implementation uses the second-order inward
one-sided difference. The division SRS's own base ellipsoid matters here:
`melown2015` pseudomercator uses its auxiliary sphere, not the WGS84 ellipsoid
used by the navigation and physical SRSes.

The grid is refined only when its interpolation error requires it. To test an
`N` by `N` grid, construction evaluates the intervening samples of the next
`(2N - 1)` by `(2N - 1)` grid and compares their direct scale with the value
interpolated from the current grid. The current grid is accepted when the
relative physical-GSD error is at most one percent everywhere tested.
Otherwise the intervening samples are retained and construction repeats at
sizes 9, 17, 33, 65, 129, and 257. Failure at 257 makes the reference frame
unsupported. Section 13.3 independently checks the accepted grid against
PROJ factors.

#### Query and LOD selection

Let the selected bisection node have extent width `W`, height `H`, root LOD
`r`, and 256 samples per tile side. Its nominal GSD at LOD `l` is:

```text
rootNominalGsd = sqrt(abs(W * H)) / 256
nominalGsd(l) = rootNominalGsd / 2^(l - r)
```

For each query, the store performs these operations:

1. Route the navigation position to one bisection division node and
   interpolate `S(p)` from that node's factor grid.
2. Convert a positive requested physical GSD to
   `requestedNominalGsd = desiredGsd * sqrt(S(p)) / u`.
3. Rank resident units on the query's tile path. Units with
   `nominalGsd >= requestedNominalGsd` come first, finest first. If none of
   those covers the query, finer units follow, coarsest first.
4. After the GPU identifies the first covered unit, report
   `actualGsd = selectedNominalGsd * u / sqrt(S(p))`.

For `desiredGsd = 0`, step 2 is skipped and resident units are ranked finest
first. The public comparison rules in section 5 describe the same ordering in
physical units.

Reduction supplies fields through the division root. A request is coarser than
every available level only when its requested nominal GSD exceeds the root's
nominal GSD; the covered root is then the best available result.


## 5. Public API

`Viewer` exposes one flat asynchronous method:

```ts
heightcode(
    requests: readonly Viewer.HeightcodeRequest[],
    options?: Viewer.HeightcodeOptions,
): Promise<Viewer.HeightcodeResult[]>;
```

Its public type aliases are defined in the same-name `Viewer` namespace and
expand to:

```ts
type HeightcodeRequest = {
    position: readonly [number, number];
    desiredGsd?: number;
    previous?: HeightcodeSample;
};

type HeightcodeOptions = {
    signal?: AbortSignal;
};

type HeightcodeSample = {
    position: [number, number, number];
    actualGsd: number;
    revision: string;
};

type HeightcodeResult =
    | {
        status: 'resolved';
        sample: HeightcodeSample;
        changed: boolean;
    }
    | { status: 'unavailable' };
```

`position` is navigation-SRS XY. `desiredGsd` defaults to zero. Results
preserve request order, and the method does not mutate either array.
`sample.position` is `[requestX, requestY, decodedHeight]` in the same
navigation SRS. `actualGsd` is finite and positive.

`revision` is opaque. It identifies the map-store instance, store generation,
selected physical unit, and unit revision. Consumers must only pass the sample
back as `previous`; they must not parse the string.

A first lookup omits `previous`. A refresh supplies the previous sample and
the same XY position. The store returns the current candidate only when it is
better for the requested GSD or is a newer value at the same logical level.
Otherwise it returns the previous sample with `changed: false`. An answer
from an invalidated store generation is not retained.

The quality comparison is exact:

1. A candidate meeting `actualGsd >= desiredGsd` outranks one that does not.
2. Among candidates that meet it, the smaller actual GSD wins.
3. If none meet it, the larger actual GSD wins.
4. At the same logical level, the newer unit revision wins.

For `desiredGsd = 0`, the finer logical level wins. A current-generation
previous sample remains usable when the relevant GPU unit has been evicted
and no better resident answer exists. Complete store invalidation makes it
ineligible.

For an initial resolved lookup, `changed` is `true`. For a refresh it is
`true` exactly when the returned revision differs from `previous.revision`.
If there is no resident candidate and `previous` remains eligible, the result
is the previous sample with `changed: false`. If neither exists, the result is
`{ status: 'unavailable' }`.

A finite position outside every spatial-division constraint is unavailable;
it is not an input error.

An empty request array resolves immediately. A non-finite coordinate, a
negative or non-finite desired GSD, or a previous sample for different XY
coordinates rejects the complete call with `TypeError`. A structurally
invalid previous sample or revision does the same. A map without a supported
reference frame rejects with `NotSupportedError`. Map destruction, map
replacement, context loss, or terrain invalidation rejects pending calls with
`AbortError`. A call that would raise the combined queued and submitted
request count above 65,536 rejects with `QuotaExceededError`; it is not
partially queued.

`signal` cancels the complete call. A signal already aborted rejects a
non-empty call with `AbortError` before activation or queueing. Later abort
rejects the promise immediately and removes queued chunks. A submitted GPU
transfer runs to its fence because WebGL cannot cancel it, but its result is
discarded.

The method is asynchronous even when every unit is resident. This keeps one
contract for singleton and large vector batches and permits non-blocking GPU
readback. A single marker uses the same method; the waypoint demo combines all
two-dimensional markers due on the same refresh into one batch.

### 5.1 Internal boundary

`Map` is the only owner and caller of `ElevationStore`. The class has four
lifecycle operations:

```ts
updateAfterTerrainFrame(frameId: number, now: number): void;
heightcode(
    requests: readonly ElevationStore.HeightcodeRequest[],
    options?: ElevationStore.HeightcodeOptions,
): Promise<ElevationStore.HeightcodeResult[]>;
invalidate(reason: string): void;
dispose(reason: string): void;
```

The canonical request, options, sample, and result types are declared in the
same-name `ElevationStore` namespace after the default-export class. The `Map`
and `Viewer` namespaces forward type aliases to them. This keeps `Map`
independent of `Viewer`, which already depends on `Map`, and creates no named
type export beside a default-export class.

`updateAfterTerrainFrame()` ignores a frame ID already consumed by the current
generation. It is synchronous command submission: it may rebuild units but
never waits for readback or loads a resource. `heightcode()` copies the request
records into its bounded queue before returning. `invalidate()` advances the
generation, releases all units, and aborts queued and submitted calls.
`dispose()` performs the same cancellation and makes every later call reject
with `AbortError`.

Renderer-facing operations remain internal to the store and renderer. They
create and rebuild a unit, reduce children into a parent, submit one compact
query chunk, and poll submitted chunks. Neither `Viewer` nor another map
subsystem receives a texture, unit key, fence, or traversal sink.

### 5.2 Consumer refresh protocol

The store publishes no update event and performs no consumer-owned refresh.
A consumer retains `HeightcodeSample` and resubmits it on a cadence suited to
that consumer. It keeps at most one call in flight for a logical batch. An
`unavailable` initial result remains unresolved; the consumer may retry. An
`AbortError` clears retained samples and permits a new call against the new
generation.

The waypoint demo applies this protocol once per second:

1. Convert each two-dimensional public marker coordinate to navigation XY
   with fixed input height zero and discard the converted Z.
2. Batch all such markers with `desiredGsd: 0`, supplying each retained
   sample as `previous`.
3. Keep the marker hidden until its first resolved result.
4. Project a resolved navigation position as fixed height. Reproject it only
   when `changed` is `true` or the camera changes.

Explicit three-dimensional markers retain their current fixed-height path.
The demo does not fall back to navigation-tile height for an unresolved
two-dimensional marker. It aborts its in-flight batch when the demo is
destroyed or its marker configuration is replaced.


## 6. Logical and physical representation

### 6.1 Addressing

A physical unit is one reference-frame tile at one LOD. Its key is:

```text
division-node id + tile id [lod, x, y]
```

The division-node component prevents two spatial-division subtrees from
sharing an address accidentally. The tile extent comes from the current
reference-frame division, not from surface metadata.

Navigation XY is routed to a division subtree as follows:

1. A routing root is a division node whose parent tile ID is absent from the
   division-node list. Visit routing roots in ascending `[lod, x, y]` order.
2. At each visited node, convert navigation `[x, y, 0]` to that node's SRS and
   reject the branch when the result lies outside the closed node extent.
3. At a node with manual partitioning, test the converted point against the
   child constraints stored in that node's SRS. A constraint includes its
   left and upper edges and excludes its right and lower edges; an outer edge
   of the routing root is included.
4. If rounding places a point in two constraints, the lexicographically
   smaller child key owns it. If no constraint contains it, that branch
   supplies no candidate. Continue with the named child division node.
5. A reached node whose partitioning is `bisection` is a candidate division
   subtree. If separate routing roots produce candidates at a shared face
   edge, the smaller division-node ID owns the point.
6. Convert the point to the selected bisection node's SRS. Its extent and root
   tile ID define the tile path at every deeper LOD.

`ElevationStore` implements this operation from the parsed division nodes and
uses it for addressing and GSD. It does not use division-node physical extents
to choose among subtrees because those extents overlap at polar caps. The new
code remains in TypeScript and does not add behavior to legacy `refframe.js`.

Each unit is a 256 x 256 cell-centred grid. Texel `(i, j)` represents the
centre of the corresponding `1/256` by `1/256` part of the tile. Query
addressing uses top-left tile Y orientation, matching tile IDs. Tile
ownership is half-open on the right and bottom; the outer boundary of a
division node is clamped into its last tile.

The first implementation clamps bilinear sampling at a unit edge. It does not
allocate halos or read a neighbouring unit. The boundary rule is deterministic
and keeps each allocation independent. The public boundary checks in section
13 must pass before this representation is accepted.

### 6.2 Texture format

Each unit owns one 256 x 256 `RGBA8UI` texture with nearest filtering. A
finite IEEE 754 float is packed little-endian into the four channels. The
`0xFFFFFFFF` bit pattern is the invalid NaN sentinel.

This is the format already used by the depth hitmap. It is renderable and
readable in core WebGL2 and does not require `EXT_color_buffer_float`.
Integer textures cannot filter packed floats, so the query and reduction
shaders decode texels and perform filtering explicitly.

There is no persistent physical mask texture. Finite versus NaN supplies the
logical validity bit. Traversal coverage masks remain transient inputs to
population; they are not retained by the store.

The first implementation uses one WebGL texture per unit and no atlas. The
unit is already the eviction and reduction boundary. Atlas allocation would
add relocation and fragmentation policy before a measured need exists.

### 6.3 CPU metadata

Each resident unit has a CPU record containing its key, texture, byte cost,
store generation, monotonically increasing revision, last population time,
last successful query time, input signature, and pinned state. It does not
retain elevation pixels on the CPU.

Each bisection division root also owns the immutable projection-factor grid
specified in section 4.3. The first query routed to a root constructs its grid
before candidate selection. Other queries for that root share the same
construction promise.

A terrain generation change retains completed factor grids because source
order and terrain readiness cannot change the reference-frame projection.
Reference-frame replacement and store disposal release them.

The input signature is the ordered sequence of source ID, tile ID, and
generation-scoped immutable mesh-resource ID for every ready rig submitted
directly to the unit, followed by the keys and revisions of child units used
as reduction inputs. It does not use the transient rig object identity. Mesh
resources are immutable after becoming ready, and terrain-source order changes
the store generation, so element-wise equality is sufficient; no probabilistic
hash is used.

The root unit of each bisection division subtree becomes pinned after it has
coverage. Manual partitioning nodes are routing nodes and are not pinned as
height fields. A pinned root remains until complete invalidation, map unload,
or context loss.


## 7. Store population

### 7.1 Scheduling

Four settings define phase-one operation:

| Setting | Default | Scope |
|---|---:|---|
| `mapElevationStoreEnabled` | `true` | internal, runtime |
| `mapElevationStoreUpdateIntervalMs` | `1000` | internal, runtime |
| `mapElevationStoreGpuCache` | `64` MiB | runtime |
| `debugElevationStoreGeodataShadow` | `false` | diagnostic |

The interval is a minimum between update starts. The GPU-cache value budgets
persistent unit textures and accepts values of at least 4 MiB. Setting
`mapElevationStoreEnabled` to `false` disposes the store; enabling it creates a
new, empty, dormant store. The geodata-shadow switch performs section 13.5
accounting and does not alter delivered geometry.

A reduced GPU budget evicts unpinned units before the next update or query
submission; completed samples remain eligible. An interval change schedules
the next start from the last completed update. Enabling the geodata-shadow
switch activates the store when the first shadow batch is submitted.

An enabled store remains dormant until the first non-empty `heightcode()`
call. That call activates population for the rest of the store generation and
makes the first update due immediately. The update consumes the most recent
completed color frame ID and reruns selection with the no-load sink; it does
not mark the map dirty. If no color traversal has completed, the call remains
queued until the first one.
Invalidation returns the new generation to the dormant state. This avoids
traversal and allocation on maps with no elevation consumer without adding a
subscription or idle-timeout protocol.

An update uses only a completed color terrain traversal. If no frame has drawn
since the previous update, no new terrain input exists and the update is
skipped. When a color traversal and update occur on the same tick, the update
executes after the traversal and before queued elevation queries. A first
query submitted after a completed frame consumes that frame on the next tick
before query submission.

The update reuses the recursive terrain selector through an explicit
elevation sink. It does not implement a second source-composition algorithm.
The selector receives these store-pass options:

- all metanode and mesh readiness checks use `doNotLoad: true`;
- missing child objects and resources are unavailable, not requested;
- imagery, credits, debug draws, and terrain statistics are not processed;
- off-screen children stop detailed descent but remain gaps for an available
  ancestor to fill; and
- a current or last render rig can contribute only when its mesh is already
  GPU-ready.

The off-screen rule lets a loaded coarse tile populate its complete logical
unit while fine units remain limited to the current view. It does not fetch
off-screen terrain.

### 7.2 Traversal sink

`drawTerrainTraversal()` gains a sink parameter. The existing screen sink
retains current behavior. The elevation sink receives node entry, each ready
rig selected for drawing, the depth-local prior-coverage mask, child coverage,
and node completion.

The refactor keeps selection and source ordering in one function. All current
early returns pass through node completion so the elevation sink can derive a
parent from watertight children even when the screen sink has no fallback to
draw.

The elevation sink lazily allocates a unit only when a direct rig or a valid
child can contribute. If nothing contributes, the existing unit is left
unchanged. At node completion, the sink compares the collected input signature
with the resident unit. Equality updates its population time but performs no
GPU work and does not advance its revision. A changed unit is cleared to NaN
and rebuilt completely in a replacement texture before its revision advances.

### 7.3 Direct mesh rasterization

`TileRenderRig` gains `drawElevation()`. It requires positions and external
UVs only. It binds no imagery, normal map, illumination, atmosphere, or
vertical-exaggeration program.

The elevation vertex shader:

1. converts the normalized mesh position with `uModel`;
2. reconstructs absolute physical coordinates;
3. computes unexaggerated geodetic height as specified in section 4.1;
4. places XY from external UV in the texture-space target; and
5. maps height to inverse depth using the reference-frame height range.

The fragment shader samples the traversal coverage mask when one is present.
A covered fragment is discarded. A surviving fragment writes the packed
height. The shared transient depth attachment keeps the upper fragment within
the rig.

Surfaces are submitted front-to-back. After a surface draws, its footprint is
added to the same traversal mask used by the screen path. Lower-priority
surfaces therefore cannot replace its values even when their geometric height
is larger.

### 7.4 Missing LOD reconstruction

Child nodes finish before their parent. At parent completion, a reduction
shader maps each valid child unit into its quadrant of the parent unit. Each
parent texel averages the valid values from the corresponding 2 x 2 region of
the four-child mosaic. Reduction writes only when the parent texel is invalid.

The exact precedence is:

1. clear the rebuilt parent to invalid;
2. rasterize direct parent and source fallback values;
3. fill remaining invalid parent texels from valid child values; and
4. commit the complete parent unit and advance its revision.

Direct parent data therefore remains the canonical value at that LOD. Child
data reconstructs only coverage that fallback cadence or partial source
coverage left missing. Every traversed ancestor is completed, so fallback
cadence cannot leave missing intermediate store LODs.

Reduction happens after any future VHR opening. A reduced value is derived
from the canonical child field; it never exposes an unfiltered staging field.


## 8. Query execution and readback

### 8.1 Candidate construction

The CPU converts each navigation XY to its spatial-division node and tile path.
It interpolates the node's projection factor, converts the requested physical
GSD to nominal division-grid GSD, and enumerates resident units on that path.
Nominal GSD and LOD have the fixed relationship in section 4.3, so candidate
ranking needs no further SRS conversion. The best candidate receives rank
zero.

Candidates are grouped by source unit. Each group becomes an instanced draw;
one source texture is bound for the group. The instance data contains source
UV, destination result index, logical LOD, and candidate rank.

### 8.2 Sampling

The query shader decodes the four texels around the requested position. It
uses ordinary bilinear weights, removes invalid texels, and renormalizes the
remaining weights. If all four are invalid, the instance discards and does
not answer the request.

The compact result target is `2 * requestCount` by one pixel in `RGBA8UI`:

- the even pixel stores packed float height;
- the odd pixel stores the selected logical LOD as a 32-bit unsigned value.

An attached depth buffer is cleared to one. Candidate rank maps to depth, with
a better rank producing a smaller value. `LESS` depth testing means draw order
does not affect selection. The two pixels of an invalid candidate are both
discarded.

The selected LOD lets the CPU identify the submitted unit revision and
calculate `actualGsd`. No provenance channel is added to persistent unit
textures.

### 8.3 Asynchronous transfer

Readback uses WebGL2 pixel-pack buffers and fences:

1. `readPixels()` transfers the compact target into a bound
   `PIXEL_PACK_BUFFER`;
2. `fenceSync()` marks completion of the transfer;
3. later animation ticks poll with zero-timeout `clientWaitSync()`; and
4. after the fence signals, `getBufferSubData()` copies only the compact
   results to JavaScript and resolves the promises.

Two readback slots permit one transfer to wait while the next batch is
submitted. When both are occupied, requests remain in the CPU queue. No tick
waits for a fence.

One result row is limited to
`min(8192, floor(MAX_TEXTURE_SIZE / 2))` requests. A larger API call is split
into chunks at that bound and resolves after every chunk completes. Together
with the 65,536-request global queue limit, this bounds both transient GPU
allocation and CPU request storage independently of caller behavior.

The batch records the store generation and candidate unit revisions at
submission. A later unit replacement does not relabel an older GPU result.
Invalidation aborts the whole pending call.


## 9. Ownership and lifecycle

`Map` owns `ElevationStore`, query semantics, update scheduling, generation,
and memory policy. `Renderer` and `GpuDevice` own shader programs, texture and
framebuffer operations, instanced query draws, pixel-pack buffers, and fences.

Tick order is:

1. apply queued runtime configuration;
2. draw the color frame when the map is dirty;
3. run a due elevation update when a newer completed color frame exists;
4. submit queued elevation query batches; and
5. poll prior readback fences without waiting.

The store starts after the reference frame is ready and is disposed before
the renderer. Map unload destroys it. A WebGL context loss discards every
unit and readback slot and aborts pending calls. Context recovery creates an
empty, dormant terrain-unit store; completed CPU factor grids remain because
the reference frame did not change. The next non-empty query reactivates
population.

These changes invalidate the complete store and advance its generation:

- replacing the loaded map or reference frame;
- changing the active terrain source list or its order; and
- a future change to terrain rasterization or VHR-opening configuration; and
- disabling the store at runtime.

These changes do not invalidate it:

- vertical exaggeration;
- illumination or atmosphere;
- raster imagery and lettering visibility; and
- layer-to-terrain applicability that does not change the terrain stack.

A resource becoming ready within the same active terrain generation causes
the affected units to be rebuilt on a later update. Their unit revision
changes; the store generation does not.


## 10. Memory and eviction

One persistent unit costs 262,144 bytes of texture storage. The configured
budget covers the sum of all such textures, including pinned roots and a
replacement unit while it is being rebuilt.

Store-owned transient GPU allocation is separately fixed: one 256 x 256
population depth attachment, one query color and depth target for at most
8192 requests or the device texture limit, and two pixel-pack buffers of the
same result size. These allocations are reused. Diagnostics report persistent
and transient bytes separately.

CPU storage is bounded by one metadata record per resident unit, at most one
direct signature entry per active terrain source plus four child entries per
unit, one factor grid per bisection division root, and 65,536 pending request
records. An `N` by `N` grid uses `4 * N * N` bytes and is bounded by 264,196
bytes at `N = 257`. During refinement, the current and candidate grids coexist.
Completed result arrays are owned by the caller.

Before allocating a unit, the store evicts unpinned units in least-recently
used order. The heat time is the later of the unit's last successful query and
last population. This retains areas that are being queried or are still in
the active rendering region.

Pinned division-root units are excluded from eviction. If pinned storage and
a replacement texture consume the complete persistent budget, the store skips
the rebuild or new unit; it does not exceed the budget and does not evict a
root. Queries can still use the retained coarse field. A root is pinned only
after its texture has been admitted within the budget, so a configuration too
small for every division root produces unavailable regions rather than an
over-budget allocation.

An evicted unit invalidates no completed `HeightcodeSample`. A consumer can
retain that current-generation value and pass it to refresh. Complete store
invalidation is the boundary that makes all prior values stale.


## 11. Future node height ranges

The first implementation allocates no min/max textures, CPU node-range map,
or min/max API.

A later vector traversal remains correct without them. It uses the reference
frame's global minimum and maximum elevation for every vector node. The broad
range weakens culling but cannot reject valid heightcoded geometry.

The chosen store layout supports a later optimization. A reduction can read
finite canonical samples in a tile-aligned unit, compute minimum and maximum,
and publish the result into a CPU map keyed by the same division-node and tile
ID. A missing entry falls back to the global range. The point store remains
the authority; the CPU map is derived summary data.

If VHR opening is enabled, the summary bounds the opened field and is
conservative for vector geometry heightcoded from that field. It is not a
bound for the unfiltered render mesh. Terrain rendering continues to use its
own metanode or source bounds.


## 12. Future VHR morphological opening

Morphological opening is an optional VHR rasterization step, not a store query
mode. A future raster-source configuration designates the sources for which
narrow buildings and vegetation should not become the terrain height used for
vector placement. RFC 13 defines no GSD threshold for that designation.

The future path is:

```text
VHR source rasterization
    -> staging height field and validity
    -> erosion
    -> dilation
    -> canonical elevation-store unit
```

Only the opened result is committed. The unfiltered staging field is released
and is never retained alongside the store.

The current VTS navtile generator is the implementation precedent. Its
[height-map code][vts-heightmap] applies separable erosion and dilation to a
masked field before coarser levels are generated, and its
[navtile generator][vts-ntgenerator] converts the configured physical radius
to pixels. A future GPU implementation must preserve those applicable
semantics: invalid centres remain invalid, invalid neighbours do not enter the
extremum, opening precedes reduction, and the radius is defined in physical
units.

RFC 13 adds no opening configuration, staging allocation, shader, stored raw
field, or conditional branch. The public `legacy-benatky` map is the initial
candidate for the separate VHR validation.


## 13. Validation plan

Validation is staged because later gates depend on earlier mechanisms. A
failed gate is resolved before the next implementation phase. Routine checks
use the current public repository and public test data.

### 13.1 GPU format and geodetic conversion

A WebGL diagnostic renders deterministic positions through the elevation
shader and reads the packed values through the same decoder as production.
It covers:

- WGS84 longitude every 15 degrees, latitude every 5 degrees, both poles,
  and heights -12,000, 0, 10,000, and 100,000 m;
- the current Mars ellipsoid at the same angular grid and heights; and
- NaN clear, finite packing, upper-fragment depth selection, and negative
  heights.

CPU `MapSrs` conversion supplies the reference. The gate is maximum absolute
height error at most 2 m, no non-finite covered result, and exact NaN
preservation for uncovered pixels. Failure changes the conversion algorithm
or encoding before terrain integration; it does not relax the bound.

### 13.2 Composition and reduction

A procedural two-surface fixture uses constant-height quads and explicit
coverage shapes. It verifies:

- the front surface wins in its coverage even when the back surface is
  higher;
- the back surface fills every front-surface gap;
- overlapping triangles within one surface retain the upper height;
- four constant-height children fill invalid parent quadrants without
  replacing valid direct-parent samples;
- partial child validity averages only valid samples; and
- rebuilding one unit changes its revision without changing the store
  generation; and
- repeating an update with the same rig IDs and child revisions performs no
  rebuild and retains the unit revision.

Every expected texel value and validity state is deterministic. This is a
GPU-pipeline invariant that real-map screenshots do not isolate, so the
fixture remains as a focused browser test.

### 13.3 Address, GSD, and boundary checks

A committed fixture contains the model SRS and spatial divisions for
`melown2015`, `earth-qsc`, and `mars-qsc` described in
[reference-frames.md](reference-frames.md). Keeping the exact inputs in the
test isolates routing behavior from registry changes. The routing test covers
the centre and every edge and corner of each division subtree. It requires one
deterministic owner for every geographic test point and no owner for a point
outside a frame's domain.

The live test samples both sides and the exact shared edge of adjacent tiles
in the pseudomercator, north-polar, and south-polar division subtrees. It
checks that every position maps to one unit and that edge samples remain
finite where the composed terrain is watertight.

GSD validation uses the same `melown2015`, `earth-qsc`, and `mars-qsc`
reference-frame definitions. A retained tileserver test utility evaluates
`geo::SrsFactors` for JSON input points. The browser test sends it every point
used to construct a factor grid and a four-times-finer regular validation
lattice over the accepted grid.

For each bisection node, the check requires:

1. every numerical-Jacobian grid sample to agree with PROJ `areal_scale`
   within one percent;
2. physical GSD calculated from the interpolated grid to agree with PROJ at
   every finer validation point within one percent;
3. the accepted grid to be the first size in `5, 9, 17, ..., 257` that meets
   the construction criterion in section 4.3;
4. reported GSD at the root and next four LODs to equal
   `nominalGsd * u / sqrt(areal_scale)` within one percent; and
5. five synthetic covered units to follow section 4.3 when requested GSD is
   immediately below, equal to, and immediately above each unit's GSD.

The pseudomercator result must also decrease from the equator towards the
partition latitude at a fixed LOD. A non-finite factor, an error outside the
bound, or different candidate selection fails this gate.

The pseudomercator case uses the public `simple-terrain` style. The polar cases
use the same style with camera and query positions centred at longitude zero
and latitudes 89 and -89 degrees. These are explicit variants of public input,
not additions to the canonical screenshot set.

For each watertight edge, the diagnostic reads both units at the edge
(`e0`, `e1`) and half a texel inside each unit (`i0`, `i1`). Edge clamping is
accepted when:

```text
abs(e0 - e1) <= max(abs(e0 - i0), abs(e1 - i1)) + 2 m
```

A failure requires a halo design before the API ships. This is the only
physical-layout decision conditional on measured terrain behavior.

### 13.4 Mount Whitney waypoint

The primary behavior case is `a-3d-mountain-map` at
`[-118.302348, 36.560197]`, the coordinate recorded in the public backlog.
The waypoint requests desired GSD zero, retains its last result, and refreshes
after store updates.

The gate requires:

- a coarse result before fine terrain has settled;
- one or more revisions as finer resident units become available;
- a final actual GSD equal to the finest resident covered level;
- `checkVisibility()` to report the resolved waypoint visible; and
- no return to the measured 3480 m navigation-tile result after the store has
  captured the mesh that renders the summit.

The waypoint demo then uses `Viewer.heightcode()` by default. It keeps no
internal store access or diagnostic fallback.

### 13.5 Heightcoded geodata shadow comparison

`complex-terrain` supplies public heightcoded geodata and a composed terrain
view. With an internal diagnostic switch, the client:

1. takes every delivered three-dimensional geographic coordinate;
2. converts it to navigation XY and discards its delivered height;
3. requests store height with desired GSD equal to geodata tile size divided
   by its `pixelSize`;
4. refreshes until the selected store unit stops changing; and
5. records coverage, actual GSD, revision count, latency, and the difference
   from the delivered height.

This is a shadow computation and cannot alter rendering. Server heightcoding
samples the configured server DEM; the store samples composed rendered
terrain, so equality is not the gate. The gate is complete store coverage for
coordinates whose terrain tiles are ready, stable revisions after terrain
settles, and no non-finite results. The error distribution is an input to the
follow-on two-dimensional vector RFC and is recorded as p50, p90, p99,
maximum, mean, and standard deviation.

### 13.6 Render and network invariance

Matched store-disabled and store-enabled runs use `simple-terrain`,
`complex-terrain`, and `full-terrain`.

The enabled run submits one centre-point query after the initial settled color
frame to activate the store. The disabled run follows the same camera and
timing sequence without that call.

The color output must be pixel-identical after network settling. The enabled
run must issue the same terrain metadata and mesh requests as the disabled
run. Store traversal that adds a terrain request fails this gate.

With no update due and no query queued, profiler counters must show no store
draw, texture bind, framebuffer switch, or readback work.

### 13.7 Performance and scheduling gate

Matched performance runs use a 1200 x 800 viewport and a warm browser cache.
After activation, a scripted 30-second orbit advances azimuth by 12 degrees
per second while holding map centre, distance, tilt, and field of view. The
same orbit is run once to warm its terrain resources before measurement. Runs
record CPU and GPU frame time for every update frame, not only averages. They
also record populated units, bytes, factor-grid construction time, cold-query
latency, query batch size, submission time, fence latency in animation ticks,
and result-copy time. The validation record names the browser, GPU,
device-pixel ratio, and store-disabled baseline commit.

A cold query is submitted separately in the pseudomercator, north-polar,
south-polar, and one QSC root. No factor-grid construction frame may exceed the
store-disabled p99 frame time by more than 4 ms, and each node grid must become
ready within two seconds. Failure blocks store integration.

The initial implementation runs one complete update at the 1000 ms interval.
It is accepted when, on all three canonical maps, no update frame exceeds the
store-disabled p99 frame time by more than 4 ms during the 30-second capture.

If that gate fails, the implementation switches to the defined bounded mode:
the no-load traversal records an update job at the interval, and subsequent
drawn frames process at most eight unit builds. A two-millisecond soft CPU
budget is checked between builds; once elapsed time reaches it, processing
stops for that frame. A newer interval replaces an unfinished job for units
not yet started. Queries continue to use committed old units. The bounded
mode must pass the same 4 ms gate before waypoint migration.

This scheduling branch is decided by the measured full-pass cost. No other
design question is deferred to validation.

### 13.8 Memory and lifecycle

A scripted pan traverses enough disjoint regions to exceed the 64 MiB budget.
The reported persistent texture bytes must remain within budget, excluding
the documented shared scratch allocation. Cold non-root units must disappear,
covered division roots must remain, and a retained sample must survive
eviction through refresh with `changed: false`.

Terrain-stack reordering must abort pending queries, clear all units, advance
the generation, and prevent an old `previous` sample from being returned.
Context loss must do the same and recover with an empty, usable store. Caller
abort is tested once while queued and once after PBO submission; both promises
must reject with `AbortError`, and later calls must remain usable.


## 14. Implementation sequence

The source boundaries are:

| File | Responsibility |
|---|---|
| `src/map/elevation-store.ts` | addressing, units, update policy, candidates, refresh, generation, and eviction |
| `src/map/elevation-metric.ts` | projection-factor grids, Jacobian fallback, and GSD calculation |
| `src/map/map.ts` | ownership, tick scheduling, terrain invalidation, and internal map method |
| `src/viewer/viewer.ts` | flat public method and same-name namespace types |
| `src/viewer-config.ts` | the four settings in section 7.1 |
| `src/map/draw-traversal.ts` | common selector and screen/elevation sink calls |
| `src/map/tile-render-rig.ts` | elevation draw entry point using an existing ready rig |
| `src/renderer/gpu/device.ts` | framebuffer, PBO, fence, submission, and polling primitives |
| `src/renderer/gpu/texture.ts` | packed unit texture creation and byte accounting |
| `src/renderer/shaders/elevation-*.glsl` | rasterization, reduction, and batched lookup |
| `demos/waypoint/waypoint.js` | first public consumer and refresh protocol |
| `test/elevation-store.js` | deterministic GPU, addressing, lifecycle, and live-map gates |
| `test/fixtures/elevation-reference-frames.json` | pinned routing fixture for three supported reference frames |

### Phase 1: GPU primitives

1. Add packed elevation texture creation and decoding to `GpuTexture` and
   `GpuDevice`, reusing the current `RGBA8UI` rules.
2. Add the geodetic-height, elevation-raster, reduction, and query shaders.
3. Add pixel-pack-buffer and fence ownership to `GpuDevice`.
4. Pass section 13.1 and the standalone raster and reduction cases from
   section 13.2 before integrating the terrain traversal.

The new format remains elevation-specific. The existing depth hitmap API and
encoding do not change.

### Phase 2: store and traversal integration

1. Add `src/map/elevation-store.ts`, default-exporting `ElevationStore` with
   associated types in its same-name namespace.
2. Add the public tileserver factor utility, add the division projection-factor
   grids, and pass the section 13.3 comparison before using grid values for
   candidate selection.
3. Give `Map` one store instance after reference-frame readiness and dispose
   it during map unload and map destruction.
4. Refactor `drawTerrainTraversal()` to accept the screen or elevation sink;
   preserve one selection and composition implementation.
5. Add `TileRenderRig.drawElevation()` and node-completion reduction.
6. Implement candidate construction, compact instanced lookup, PBO readback,
   refresh comparison, and cancellation behind `Map.heightcode()`.
7. Add the four settings in section 7.1, diagnostics, complete invalidation,
   pinned roots, and LRU eviction.
8. Pass the complete section 13.2 and sections 13.3, 13.6, 13.7, and 13.8.

### Phase 3: query API and waypoint

1. Add the flat `Viewer.heightcode()` wrapper over `Map.heightcode()`.
2. Forward the request, options, sample, and result aliases through the `Map`
   and `Viewer` namespaces and package declarations.
3. Move the waypoint demo to the public method and pass section 13.4.
4. Run the public geodata shadow comparison in section 13.5.

RFC 13 is implemented when these three phases and their gates are complete.
Navigation-tile consumers remain in place until their asynchronous behavior
and compatibility changes are designed from the validated API.

### Follow-on vector RFC

The next RFC can define an ordinary two-dimensional vector source, selection
without geodata metatiles, batched client heightcoding, worker handoff, and
removal of server heightcoding. Its first implementation uses the reference
frame's global height range. Store-derived node ranges are a later culling
optimization, not a prerequisite.


## 15. Alternatives

### Continue using navigation tiles

Rejected as the common elevation service. They duplicate terrain elevation,
can stop at a coarser LOD than the mesh, and omit delivered coverage. They do
not describe future raster terrain or the client's composed terrain stack.

### Continue server-side vector heightcoding

Rejected as the vector architecture. It requires server work for every
geographic coordinate, binds the result to one server DEM, and preserves the
geodata free-layer format and metatiles that the vector redesign removes.

### Query mesh triangles on the CPU

Rejected. It requires a CPU spatial index over retained irregular geometry,
duplicates GPU mesh residency, and supplies no filtered hierarchy for GSD
selection or later ranges.

### Build the height field on the CPU

Rejected. Mesh conversion is rasterization, and the GPU already owns the
geometry. A CPU field would add transfer and memory cost before lookup.

### Let elevation queries load terrain

Rejected. It would create a second demand, priority, and cancellation system
and could return terrain that rendering did not select. Queries observe the
render-fed temporal cache.

### Use renderable float textures

Rejected for phase one. `RGBA32F` rendering requires
`EXT_color_buffer_float`, outside the current WebGL2 baseline. Packed
`RGBA8UI` preserves float bits with core WebGL2.

### Store a separate validity texture

Rejected for phase one. A reserved NaN represents absence without doubling
persistent texture count or binding cost. The logical validity rule is
unchanged.

### Pack units into atlases

Deferred until texture-object or framebuffer-switch measurements justify it.
One tile per unit gives direct addressing, replacement, reduction, and
eviction with no allocator.

### Retain raw and opened VHR fields

Rejected. No consumer requires the raw field. When opening is configured, the
opened result is the canonical elevation service and only that result is
retained.


[vts-heightmap]:
https://github.com/cartolinadev/vts-libs/blob/7fac644a1fbeaf3ef04888412442a63c36de8187/vts-libs/vts/heightmap.cpp
[vts-ntgenerator]:
https://github.com/cartolinadev/vts-libs/blob/7fac644a1fbeaf3ef04888412442a63c36de8187/vts-libs/vts/ntgenerator.cpp
[mapproxy-gsd-grid]:
https://github.com/cartolinadev/cartolina-tileserver/blob/d45071b3fcb35f30091a837510b6d356ac780656/mapproxy/src/tiling/unified.cpp#L409-L533
