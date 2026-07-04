# RFC 10: the terrain-tile container — mesh and normal map in one file

**Status:** Draft
**Opened:** 2026-07-04
**Context:** subsumes two backlog items — **FORMAT: design the v4
terrain-tile container** and **REFACTOR: unify the duplicated mesh
parser (main thread + worker)** in [backlog.md](backlog.md).
Background in [normal-encoding.md](normal-encoding.md),
[tileserver-metatile-production.md](tileserver-metatile-production.md),
[surface-metatile.md](surface-metatile.md),
[rendering-architecture.md](rendering-architecture.md).

---

## 0. Orientation — which win matters

A terrain tile reaches the screen through two independent server
resources: the mesh (`{lod}-{x}-{y}.bin`) and the normal map
(`{lod}-{x}-{y}-{sub}.nm`). Every shaded terrain tile, on every client,
pays for that split three times:

1. **On the server**, mesh and normal map are produced by two separate
   GDAL warps of the same DEM over the same tile extents, dispatched as
   two independent HTTP requests.
2. **On the wire**, two requests and two responses per tile double the
   request count of terrain loading, and the second request cannot even
   start until the first has finished (see §1.3).
3. **On the client**, the normal map travels through the browser image
   pipeline (WebP decode, `createImageBitmap`, color management,
   GPU-backed `ImageBitmap` storage on WebKit) although the shader
   wants exactly the two raw bytes per texel that the tileserver
   computed in the first place.

This RFC merges the two resources into one *terrain-tile container*
served as a single file: the mesh encoded as today, followed by the
normal map as a KTX2 texture that the client uploads to the GPU
directly, with no image decode. One warp produces both payloads; one
fetch delivers them; rig readiness stops depending on a second,
serialized network round trip.

The change also closes out two standing client debts whose natural
moment is a mesh-format change: the multi-submesh data model (a glue
concept; glues are ignored since the recursive traversal, and the
tileserver emits exactly one submesh per tile) and the duplicated
mesh parser (main thread + worker copies of ~1800 lines).

Serving stays CDN-compatible: container URLs are keyed on tile ID and
stable, exactly like mesh URLs today, and the object count per tile
drops from two to one.


## 1. Current state

### 1.1 Server: two warps, two endpoints

Mesh generation (`SurfaceBase::generateMesh`,
`mapproxy/src/mapproxy/generator/surface.cpp`) calls
`generateMeshImpl`, which for a DEM surface
(`mapproxy/src/mapproxy/generator/surface-dem.cpp`) issues one GDAL
warp per request: `Operation::demOptimal` at up to 128×128 cells. The
warper (`warpDem` in `mapproxy/src/mapproxy/gdalsupport/operations.cpp`)
sizes the grid adaptively — `12 · circumference / 4` samples clipped to
`[2, 128]` — so coarse sources get small grids, and returns an
`(n+1)²` grid-registered height field (samples at cell corners,
including the tile edges). `meshFromNode` triangulates the grid,
`simplifyMesh` reduces it to the per-tile face budget, a skirt is
added, and `saveMeshProper` (`externals/vts-libs/vts-libs/vts/mesh.cpp`)
writes the wire stream gzipped; the sink serves it with
`Content-Encoding: gzip`.

Normal-map generation (`SurfaceBase::generateNormalMap`, same file)
issues a *second* warp of the same DEM for the same tile:
`Operation::dem` at a fixed 257×257 request over half-pixel-inflated
extents (yielding a 258² grid; the code comments call the double
inflation "trickery" to be replaced by a dedicated operation), plus an
optional third warp of the landcover dataset for the flat-water mask.
`geo::normalmap::demNormals` (Zevenbergen–Thorne, 3×3 window) computes
per-sample normals, `convertNormals` moves them into the ellipsoid
tangent frame, `encodeOct` packs them into two channels
([normal-encoding.md](normal-encoding.md)), and the result is encoded
as a **lossless WebP** (`encodeToWebP`,
`mapproxy/src/mapproxy/support/atlas.cpp`) and served as `image/webp`.

The two endpoints are dispatched from the same tile-file switch
(`surface.cpp`, `vts::TileFile::mesh` / `vts::TileFile::normals`); URL
templates come from `fileTemplate`
(`externals/vts-libs/vts-libs/vts/tileop.cpp`): `{lod}-{x}-{y}.bin`
and `{lod}-{x}-{y}-{sub}.nm`. The mapConfig advertises both
(`meshUrl`, `normalsUrl`; the latter gated on `hasNormalMaps`, set
unconditionally for DEM and spheroid surfaces).

Measured on the dev tileserver instance (viewfinder-dem3, melown2015,
warm process; the lod-11 pair fetched three times, ranges given, the
lod-14 pair once):

| file | size | latency |
|---|---|---|
| lod-11 mesh `.bin` | 11.4 KB | 0.52–0.60 s |
| lod-11 normal map `.nm` | 68.1 KB | 0.27–0.49 s |
| lod-14 mesh `.bin` | 11.1 KB | 0.53 s |
| lod-14 normal map `.nm` | 23.9 KB | 0.23 s |

Each of the two requests pays its own warp; the warp dominates the
serve cost (the same structural observation RFC 7 made for metatiles,
where removing the warp cut p50 from ~700 ms to ~25 ms).

### 1.2 Wire format: mesh versions 1–3, submeshes

The mesh stream (`externals/vts-libs/vts-libs/vts/meshio.cpp`) is
magic `ME`, a `uint16` version, `double meanUndulation`,
`uint16 numSubmeshes`, then per-submesh vertex/UV/face blocks.
Versions 1–3 differ in quantization and delta coding; the server's
default writer emits **version 2** (gzipped); the version-3 writer
exists but sits behind the `NO_MESH_COMPRESSION` environment switch
with an unresolved FIXME dating to 2017 — this tileserver never emits
it.

A producer survey (2026-07-04) found **no live producer of version-1
meshes**: this tileserver has always written v2, and the known
production deployment of the legacy stack plus the legacy vtsd test
datasets serve only v2 and v3 (v3 from historically encoded stored
tilesets, which remain in active use). The client therefore keeps
v2–v3 support and drops v1 (survey details in the private scratchpad
notes).

Submeshes exist to serve two legacy needs: glue meshes (multiple
surface fragments in one tile) and multi-atlas internal-texture
tilesets. The tileserver's own surfaces always emit exactly one
submesh per tile (`generateMesh` builds `vts::Mesh mesh(false)` and
adds the single `generateMeshImpl` result). Glues are dead: the
recursive traversal (RFC 3) ignores them, and the client-side glue
machinery was removed 2026-06-08.

### 1.3 Client: serialized fetches, duplicated parsers, image pipeline

The client fetches the mesh per tile (`MapMesh.scheduleLoad`,
`src/core/map/mesh.js`) and parses it either on the main thread
(`MapSubmesh` prototype methods, `src/core/map/submesh.js`) or in the
loader worker (`src/core/map/loader/worker-mesh.js`, selected by
`mapParseMeshInWorker`). The two parsers are near-identical copies of
the full byte-level pipeline — roughly 1800 lines that must be kept in
lockstep, already tracked as its own backlog entry.

The normal map is fetched only after the mesh has arrived and parsed:
`drawSurfaceTile` (`src/core/map/draw-tiles.js`) constructs a
`TileRenderRig` only once the mesh CPU data is ready, and the rig's
`buildLayerStack` (`src/core/map/tile-render-rig.ts`) is what creates
the normal-map `MapTexture` and schedules its load as an *essential*
layer. Shaded-tile readiness therefore costs two serialized round
trips: `t(mesh) + t(normal map)`, each carrying its own server-side
warp. Nothing else orders these two resources; the serialization is
purely an artifact of the two-file interface.

The normal map then runs through the browser image pipeline:
WebP decode via `createImageBitmap` (`src/core/map/subtexture.js`),
`texStorage2D(RG8)` + `texSubImage2D` from the bitmap
(`src/core/renderer/gpu/texture.ts`, `GpuTexture.Type.NormalMap`),
manual bilinear sampling in the shader (`sampleOctBilinear`,
[normal-encoding.md](normal-encoding.md)). Two costs ride along:

- **Color management.** Encoded normals are numbers, not colors. The
  atmosphere-density texture already had to abandon the browser image
  pipeline because iOS color-manages PNG pixels and corrupts encoded
  data (see the comment in `subtexture.js` above
  `onDensityBinaryLoaded`). The normal-map path sets
  `UNPACK_COLORSPACE_CONVERSION_WEBGL = NONE`, but per the WebGL
  specification that flag does not govern `ImageBitmap` sources —
  their color handling is fixed at `createImageBitmap` time, where the
  code passes no options. The path works today; it is one browser
  default away from silently shifting texel values.
- **WebKit ImageBitmap residency.** On WebKit an `ImageBitmap` holds
  GPU-backed pixel storage; the code closes bitmaps immediately after
  upload to avoid double residency (comments in
  `subtexture.js buildGpuTexture`). A raw upload path avoids the
  object entirely.


## 2. What the split actually costs

Putting §1 together, per shaded terrain tile:

| cost | today | with container |
|---|---|---|
| GDAL warp requests (DEM) | 2 | 1 |
| HTTP requests | 2 | 1 |
| serialized round trips before shading | 2 | 1 |
| CDN objects | 2 | 1 |
| WebP decode + ImageBitmap | 1 | 0 |
| mesh parsers maintained | 2 | 1 |
| client normal-map texel path | image pipeline | raw bytes → GPU |

A settled `simple-terrain` view draws ~170 tiles; a cold load issues
~340 tile-payload requests where ~170 would do. On the dev
measurements above, a cold shaded tile costs ~0.8–1.1 s of serialized
server time; the container brings that to one request that does
roughly the work of today's normal-map request alone (§4.1).

The container also removes the last per-tile consumer of the `{sub}`
URL slot outside internal-texture atlases, and it is the natural
carrier for the v4 goals recorded in the backlog: one geometry object
per tile, versioned geometry encoding, length-delimited optional
payloads.


## 3. Design

### 3.1 Container format — mesh format version 4

The container is the next version of the existing mesh wire format,
not a new file family. Magic stays `ME`; version becomes 4; the body
becomes a payload table instead of a submesh list. All integers are
little-endian, as today.

```
struct TerrainTile {                     // mesh format version 4
    char     magic[2];                   // "ME"
    uint16   version;                    // 4
    uint16   payloadCount;               // number of table entries
    struct {
        uint8    type;                   // payload type, see below
        uint8    reserved;               // 0
        uint16   reserved2;              // 0
        uint32   offset;                 // from file start
        uint32   size;                   // bytes
    } payloads[payloadCount];
    ...payload bytes...
}
```

Payload types:

| type | content |
|---|---|
| 1 | geometry: a complete mesh stream as served today (`ME` v2–v3, uncompressed), carrying exactly one submesh |
| 2 | normal map: KTX2, `VK_FORMAT_R8G8_UNORM`, octahedral-encoded, one level, no supercompression |
| 3 | normal map: lossless WebP (defined, not implemented; see §6.2) |

Rules:

- Payload 1 is mandatory and first. Exactly one geometry payload.
- At most one normal-map payload (type 2 or 3). Its presence replaces
  the separate `.nm` fetch; absence means the tile has no normal map.
- Unknown payload types are skipped by length — the table is the
  extension point for future per-tile products, and for future
  geometry encodings (a new geometry payload type, not a container
  bump).
- The whole response is gzip-compressed on the server and served with
  `Content-Encoding: gzip`, the same mechanism meshes use today. The
  embedded geometry stream is therefore *not* nested-gzipped; the
  KTX2 level data is raw and rides the same transport compression.

Keeping the geometry payload as a verbatim `ME` v2 stream is
deliberate: both the server writer (`saveMeshProper` with
`compress = false`) and the client parser are reused unchanged, byte
for byte. The v4 geometry *encoding* redesign the backlog sketches
(one GPU-ready index domain, optimized DEM encodings, explicit cell
UV) is out of scope here and slots in later as a new payload type.

The nested `ME` magic inside an `ME` v4 file is accepted redundancy:
payload boundaries are explicit in the table, and reusing the existing
stream keeps this RFC's new parsing surface to the 20-byte header plus
a KTX2 level index.

### 3.2 Normal-map payload: why KTX2/RG8, and its exact shape

The KTX2 payload is the container's point: the client slices the level
data out of the ArrayBuffer it already holds and calls
`texSubImage2D` — no image decode, no `ImageBitmap`, no color
management, no second copy. The two stored channels are exactly
today's octahedral encoding; the shader is untouched.

Shape: `VK_FORMAT_R8G8_UNORM`, `pixelWidth = pixelHeight = 256`,
`levelCount = 1`, `supercompressionScheme = 0`. The client validates
the identifier, `vkFormat`, dimensions, and level count, and rejects
anything else. Writing the fixed 80-byte header + level index on the
server is ~30 lines; parsing it on the client is of the same order.

KTX2 rather than a bare `{width, height, bytes}` blob because it is
the standard container for GPU-ready textures: inspectable with stock
tooling, self-describing, and — through `vkFormat` — already the
negotiation point if GPU-compressed variants (BC5/RGTC on desktop,
EAC RG11 on mobile) are ever added, with no container change. Those
variants are explicitly out of scope now: neither is universally
available in WebGL2, so they would need capability negotiation and
dual server encodes (§6.3).

Mip levels stay out: the current pipeline samples normal maps with
manual bilinear filtering at a single level (`nearest` GPU filter);
nothing consumes mips.

### 3.3 Fused generation: one warp for both payloads

Requirement: one DEM warp whose output feeds both the mesh sampler and
the normal-map kernel, with no change to the served normal-map
semantics and no loss of mesh-grid adaptivity.

The two consumers want different lattices today: the mesh wants an
`(n+1)²` grid-registered height field (samples at cell corners,
`n ≤ 128` chosen adaptively), the normal kernel wants a ~258²
center-registered field (a sample per output texel plus a one-sample
border). The fused warp serves both from one grid-registered request:

1. **Warp once**: 259×259, grid-registered over the tile extents plus
   a one-grid-step border on each side (the border replaces today's
   half-pixel "trickery" and gives the gradient kernel its context).
   The interior 257×257 samples sit exactly on the tile's corner
   lattice at 1/256 spacing.
2. **Mesh grid**: take every `2^j`-th interior sample, choosing the
   smallest `2^j` stride whose grid still meets the `demOptimal`
   target (`n` rounded up to the power-of-two ladder
   {2, 4, …, 128}). Coarse-source tiles keep small grids; the
   existing `meshFromNode` → `simplifyMesh` → skirt pipeline runs
   unchanged on the subsampled grid.
3. **Normal lattice**: average each 2×2 quad of the 259² corner
   samples. The quad midpoints of a corner lattice at 1/256 spacing
   *are* the texel centers of a 256² center-registered texture (plus
   the border row), so this produces a 258² center-registered height
   field by exact bilinear interpolation — the same registration
   today's warp approximates with its double half-pixel inflation.
   `demNormals`, `convertNormals`, `encodeOct` then run unchanged and
   emit the interior 256².
4. The optional landcover warp for the flat-water mask is unchanged
   (it reads a different dataset and cannot be fused into the DEM
   warp).

Two characterized deviations from today's outputs, both to be verified
visually and numerically before rollout (§8):

- **Mesh grids snap to the power-of-two ladder.** A tile whose optimal
  `n` is, say, 93 is sampled at 128 instead. The simplifier budget
  (`TileFacesCalculator`) governs the output face count either way, so
  the served mesh has the same density and at-least-equal geometric
  fidelity; the cost is simplifier input size on the affected tiles.
- **Normal-map heights come from midpoint-averaged corner samples**
  rather than a direct center-registered warp — half-texel bilinear
  smoothing on the height input. Today's input is itself a resampled
  (and slightly mis-registered) grid, so the expectation is visual
  equivalence; the verification plan includes a decoded-normal diff
  and hillshade screenshot comparison.

The existing single-purpose endpoints keep their existing code paths
verbatim (§3.5), so this fusion carries no risk for old clients.

For non-DEM surfaces, `SurfaceBase` gets a default fused
implementation that simply calls the existing mesh and normal-map
impls in sequence (two warps, one response) — correct everywhere,
fused where it pays (`surface-dem` override). The spheroid surface's
normals are trivial and can adopt the fused path at leisure.

### 3.4 URL, file type, mapConfig, configuration

- New tile file type `TileFile::tile` in the vts-libs fork
  (`storage/filetypes.hpp`, extension mapping in `vts/tileop.cpp`):
  extension **`tile`**, template `{lod}-{x}-{y}.tile`, content type
  `application/octet-stream`. No `{sub}` slot.
- The surface mapConfig fragment
  (`externals/vts-libs/vts-libs/vts/mapconfig.cpp`, `asJson`) gains
  `"tileUrl"`, emitted only when the resource enables the container.
  `meshUrl` and `normalsUrl` remain advertised regardless — they are
  the compatibility interface (§3.5).
- The mapproxy surface resource definition
  (`mapproxy/src/mapproxy/definition/surface.cpp`) gains a boolean
  **`tileContainer`** (default `false` for rollout; the default flips
  once the client support ships and soaks). The option gates only the
  mapConfig advertisement; the endpoint itself is always routed, which
  keeps diagnostics uniform and costs nothing.
- The generator dispatch (`surface.cpp`, `SurfaceFileInfo`) routes the
  new tile type to `generateTile`, the fused producer.

### 3.5 Backward compatibility and diagnostics

Server first, clients later — the interface is additive:

- **Old client + new server**: mapConfig still carries `meshUrl` and
  `normalsUrl`; both endpoints serve exactly today's bytes through
  today's code paths. No behavior change.
- **New client + old server**: no `tileUrl` in mapConfig; the client
  uses the two-file path. Legacy vtsd-served surfaces are unaffected
  (vtsd never serves containers; those surfaces carry no `normalsUrl`
  either).
- **New client + new server**: the client prefers `tileUrl` when
  advertised. A URL kill switch (`mapNoTileContainer=1`) forces the
  two-file path for A/B diagnosis.

The `.nm` endpoint doubles as the human-facing diagnostic view: it is
a lossless WebP that browsers render directly, so an operator can look
at any tile's normal map by URL, container or not. A dedicated PNG
debug flavor was considered and dropped — it would duplicate an
endpoint that is already viewable and already lossless. The two-file
interface therefore remains fully operational ("the old way"), and
the container is the optimized path, exactly the both-ways shape the
requirements allowed.

### 3.6 Client: single-geometry model, one parser, direct upload

**Terrain-tile parser (new, TypeScript, shared).** One module parses
the container *and* the legacy v2–v3 stream into the same neutral
result: `{ geometry, normalMap? }`, where `geometry` is the parsed
single-submesh payload (vertices, external/internal UVs, faces, bbox,
undulation) and `normalMap` is `{ width, height, bytes }` sliced from
the KTX2 payload. The module runs identically in the loader worker
(transferables: the typed arrays and the normal-map bytes) and on the
main thread, replacing both `submesh.js` parsing and
`worker-mesh.js` — the duplicated-parser backlog entry closes here.

**Version-1 retirement.** The unified parser reads versions 2 and 3
only; the v1 branches (no `surfaceReference` field, v1-specific
decoding) are dropped on the strength of the producer survey in §1.2.

**Submesh retirement.** The data model drops the submesh dimension:
`MapMesh` holds one geometry and at most one GPU mesh;
`tile.tileRenderRig[i]` / `lastRenderRig[i]` arrays collapse to single
slots; `drawSurfaceTile`'s per-submesh loop disappears; the rig's
`submeshIndex` and the `{sub}` argument of `getNormalsUrl` go. The
legacy parser keeps reading v2–v3 files but adopts their **first**
submesh only, gated by the audit in §8 (legacy vtsd tilesets must be
confirmed single-submesh before this lands; if the audit finds
multi-submesh tiles in supported datasets, the fallback is to keep a
minimal multi-geometry list inside the parser result while the render
path still goes single-rig — decided then, not designed now).

**Normal map from the container.** When the tile's terrain payload
carries a normal map, `TileRenderRig.buildLayerStack` uses it as the
normal layer's source instead of constructing a `.nm` `MapTexture`:
a `GpuTexture` built through a new raw-data path
(`createFromData` grows an `RG8` branch beside the existing `R8`/
`RGBA8` ones, `UNPACK_ALIGNMENT = 1`, `nearest`, no flip). The layer
remains *essential*; readiness now has nothing left to wait for once
the tile payload is parsed. The `.nm` `MapTexture` path stays intact
for two-file surfaces.

**Fetch selection.** `MapSurface` parses `tileUrl`;
`MapMesh.scheduleLoad` requests it when present (and not disabled),
falling back to `meshUrl` otherwise. Cache keying is by URL, as today.


## 4. Why this is the right shape — analysis of alternatives

### 4.1 Where the server win comes from

The warp is the dominant serve cost, but "one warp instead of two" is
worth stating precisely. The mesh warp resamples at most 129² ≈ 17 k
samples; the normal warp 258² ≈ 67 k. Fusing them removes the smaller
resample, one warper round trip (the warps run in a separate GDAL
process pool — each request is an IPC round trip with shared-memory
transfer), one source-window read, and the entire HTTP/dispatch
overhead of one of the two requests. The fused request does ~80 % of
the resampling work of today's normal-map request alone; the pair's
serve cost approaches half.

The deeper fix — precomputing tile payloads offline, as RFC 7 did for
metatiles — is *not* attempted here: meshes and normal maps are two to
three orders of magnitude larger than metanodes, and CDN caching
already absorbs repeat traffic. The container halves the cold-miss
cost and the object count without a storage design.

### 4.2 Bandwidth: the honest trade-off

Raw RG8 does not compress as well as lossless WebP's 2-D prediction.
Measured on the three sample tiles (gzip -9 / brotli -11 on the raw
256² RG8 planes, against the served lossless WebP):

| tile | WebP today | RG8 + gzip | RG8 + brotli |
|---|---|---|---|
| lod 8 (smooth) | 36.8 KB | 57.4 KB | 50.3 KB |
| lod 11 (rugged) | 68.1 KB | 104.3 KB | 93.9 KB |
| lod 14 (fine) | 23.9 KB | 77.5 KB | 63.5 KB |

The normal-map component grows by roughly 1.4–3.2× depending on
terrain and transport compression; against the ~11 KB mesh riding in
the same file, a shaded tile's total payload grows by roughly
1.5–2.5×. That is the price of decode-free, image-pipeline-free
delivery, and it is a real regression on metered or slow links.

Why accept it (for now):

- The wins the container exists for — one warp, one request, no
  serialized round trip, no decode — are independent of the payload
  *encoding*. The encoding is a dial, and the container's payload
  table keeps the dial: payload type 3 (lossless WebP bytes inside
  the container) is specified and can be implemented server- and
  client-side cheaply if a deployment's bandwidth economics demand
  it, since the client's WebP decode path already exists.
- Transport compression is the floor, not the ceiling: brotli at the
  CDN edge recovers 10–20 % over gzip; a PNG-style delta filter
  recovers more but was rejected as a bespoke encoding the standard
  KTX2 tooling would not read.
- GPU-compressed formats (BC5, EAC RG11) would beat WebP outright at
  32–64 KB fixed with zero decode, but are not universal in WebGL2
  and are deferred (§6.3); `vkFormat` is the ready extension point.

The default remains KTX2/RG8: robustness (no image pipeline touching
encoded numbers) and latency win by default; deployments that must
minimize bytes get a specified fallback rather than a fork.

### 4.3 Presumptions questioned

Per the task brief, the design challenges its own inputs; results:

- *"The client does not have to wait for the mesh to initialize the
  rig."* Not quite — the rig still needs parsed geometry to be
  constructed. What the container actually removes is the second
  network round trip that rig readiness currently waits on: the
  normal map arrives in the same response as the mesh. The stated
  benefit is real but is a fetch-graph property, not a rig-lifecycle
  property. §1.3 states the mechanism precisely.
- *"KTX normal map for direct GPU upload."* Upheld, with the caveat
  that the bandwidth cost is material (§4.2) and therefore the format
  keeps a compact-encoding escape hatch rather than betting the
  interface on raw texels.
- *"Submeshes may be completely retired."* Upheld for everything the
  tileserver serves (verified single-submesh by construction in
  `generateMesh`). For legacy vtsd datasets the claim is plausible —
  glues are the submesh use case, and the client ignores them — but
  photogrammetric tilesets with internal textures *can* in principle
  carry several submeshes per tile. Retirement is therefore gated on
  an empirical audit of the supported legacy test datasets (§8)
  rather than asserted.
- *"A single optimized container is not strictly necessary if
  inelegant."* The dual interface survives scrutiny in inverted
  form: the two-file interface must stay anyway for old clients and
  for diagnostics, so the container is purely additive and the
  elegance question dissolves — there is nothing to retire on the
  server, only something to stop advertising eventually.
- *PNG diagnostics.* Rejected as redundant: the retained `.nm`
  endpoint is lossless and browser-viewable as-is (§3.5).


### 4.4 Prior art in comparable engines

A reviewer will reasonably ask how the usual suspects package terrain.
Surveyed from public specifications and source (knowledge current as
of this draft; the closed products marked as such):

- **Cesium (quantized-mesh-1.0)** is the closest prior art and
  independently validates both core choices. A quantized-mesh terrain
  tile is a *single file* bundling geometry with optional
  length-delimited extensions, and the first standardized extension is
  **octahedral-encoded per-vertex normals** — the same two-channel oct
  encoding this project already uses. The structural difference: per
  vertex, normal resolution is coupled to mesh density, so shading
  detail dies with mesh simplification. Cartolina stores normals in
  texture space, deliberately mesh-independent
  ([normal-encoding.md](normal-encoding.md)); the container keeps that
  property while adopting the same single-file transport shape.
  Quantized-mesh negotiates extensions per request via the HTTP
  `Accept` header; this design advertises capability per surface in
  mapConfig instead, keeping each URL's response byte-stable — the
  CDN-friendlier variant of the same idea.
- **MapLibre / Mapbox GL JS** serve no normal maps at all: terrain and
  hillshade derive in the fragment shader from raster-DEM tiles
  (heights packed into PNG/WebP color channels), and no GPU texture
  compression is used anywhere in the pipeline. Shading resolution is
  whatever the DEM tile gives, and every terrain input rides the
  browser image pipeline — the two couplings this RFC's payload
  design steps away from.
- **CesiumJS (3D Tiles) and three.js** are where the web ecosystem
  does use KTX2 at scale, and both pair it with Basis Universal
  supercompression plus a WASM transcoder to bridge fragmented GPU
  formats. That is exactly the §6.3 road: appropriate for
  general-purpose photographic assets, oversized for a two-channel
  normal payload where raw RG8 is universal and decode-free.
- **Google Earth / Google Maps** is closed source, but its public
  traces all point the same way. The Earth web client is the native
  C++ engine compiled to the browser (NaCl 2017, then WebAssembly —
  ["How we're bringing Google Earth to the
  web"](https://web.dev/case-studies/earth-webassembly)), i.e. a
  native tile pipeline carried over wholesale rather than one built on
  the browser image pipeline. On textures specifically, Google
  co-funded and open-sourced [Basis
  Universal](https://opensource.googleblog.com/2019/05/google-and-binomial-partner-to-open.html)
  (2019, with maps named among the target use cases; "6–8× smaller
  than JPEG on the GPU") and contributed it to Khronos glTF — which
  became exactly the KTX2 supercompression that CesiumJS and three.js
  ship transcoders for. Its photorealistic 3-D tiles stream mesh and
  texture together in glTF-based [3D
  Tiles](https://developers.google.com/maps/documentation/tile/3d-tiles);
  the public documentation specifies only the container standard and
  renderer requirements, not the payload internals (verified against
  the Tile API docs, 2026-07-04). Net: the one closed vendor whose
  direction is visible bet on single-container tiles plus
  transcoder-based universal GPU textures — the same road §6.3 keeps
  open and defers.

Net: bundling shading data with the terrain tile in one response is
the established shape for engines that serve shading data at all; the
oct encoding is the established encoding; and this design's only
unusual element — texture-space normals rather than per-vertex — is a
deliberate, documented property of the existing pipeline, not an
invention of this RFC.

## 5. What this RFC does not do

- No geometry re-encoding: vertex quantization, index domains, and
  cell-UV storage are exactly today's v2 stream. The backlog's v4
  geometry goals become a future payload type.
- No metatile or tile-index change: existence and flags are untouched
  ([surface-metatile.md](surface-metatile.md)); a container exists
  exactly where a mesh exists.
- No atlas/internal-texture change: `{sub}`-addressed atlases are
  orthogonal and unaffected.
- No offline tile store; serving stays generate-on-request behind a
  CDN (§4.1).
- No change to navtiles, geodata, or bound layers.


## 6. Deferred design notes

### 6.1 Nested transport compression

Compressing payloads individually inside the container (leaving the
HTTP layer uncompressed) was considered and rejected: it would
duplicate what `Content-Encoding` already does, cost a second
implementation on both ends, and interact badly with CDN edge
recompression. One transport-level gzip/brotli over the whole file is
simpler and measurably close.

### 6.2 WebP payload (type 3)

Specified so the container never forces the bandwidth regression:
the payload is byte-identical to today's `.nm` body. Implementing it
means one server branch (reuse `encodeToWebP`) and one client branch
(reuse the existing `createImageBitmap` upload path against a Blob
slice). Not scheduled; implemented when a deployment needs it.

### 6.3 GPU-compressed normal maps

BC5/RGTC (desktop) and EAC RG11 (mobile) halve-to-quarter the raw
size with zero decode, but WebGL2 exposes neither universally, so
they require client capability negotiation (a mapConfig or query-flag
handshake) and dual server encodes. The KTX2 `vkFormat` field and the
payload table make this a payload-level addition later; nothing in
the container format changes.

### 6.4 Beyond normal maps

The payload table deliberately admits future per-tile products
(specular masks, land-cover classes) if they ever move from bound
layers to tile-coupled payloads. No such payload is designed here;
the table simply does not preclude them.

### 6.5 Broader KTX2 use — diffuse and bound-layer textures

This RFC gives the client its first KTX2 path, which invites the
question of whether diffuse imagery follows. Out of scope, and the
economics differ in every relevant dimension: JPEG/WebP compress
photographic imagery far below raw or GPU-compressed sizes, browsers
decode them natively off the critical path, and color management is
wanted there rather than harmful. The realistic prize would be GPU
memory and upload cost — RGBA8 imagery dominates the GPU cache
budget, and BC/ETC2/ASTC-class formats cut that 4–8× — but in WebGL2
those formats require per-GPU negotiation or a Basis transcoder
(§6.3, and the CesiumJS/three.js precedent in §4.4). If that trade
ever becomes worth taking, the payload table and the KTX2 choice mean
it arrives as a new payload or bound-layer content type, not a format
break. Nothing further is designed here.


## 7. Implementation plan

Tileserver (`feature/terrain-tile-container`):

1. vts-libs fork: `TileFile::tile` — enum, `tile` extension,
   `{lod}-{x}-{y}.tile` template, `application/octet-stream`,
   `urls3d.tile` + `tileUrl` mapConfig emission behind a
   `hasTileContainer`-style surface property.
2. mapproxy: `tileContainer` bool in the surface resource definition;
   `SurfaceFileInfo`/dispatch routing to `generateTile`.
3. gdalsupport: fused warp operation (grid-registered, one-step
   border, `demOptimal`-style adaptive floor for the mesh stride).
4. `SurfaceBase::generateTile`: default two-impl fusion; container
   assembly (payload table, `saveMeshProper(compress=false)`, KTX2
   writer), gzip, `Content-Encoding: gzip`.
5. `SurfaceDem` fused override per §3.3 (mesh subsample + midpoint
   average + existing normal pipeline).
6. Rebuild, deploy to the dev instance, enable `tileContainer` on a
   test resource.

Client (`feature/terrain-tile-container`):

7. Terrain-tile parser module (TS): container v4 + legacy v2–v3
   (v1 dropped per §1.2), worker- and main-thread capable; delete
   `worker-mesh.js` parse duplication and `submesh.js` parse methods
   as call sites move.
8. Single-geometry data model: `MapMesh`, `drawSurfaceTile`,
   `TileRenderRig` (drop `submeshIndex`), `pre-v6-watertight.ts`,
   measure/hit paths.
9. `GpuTexture.createFromData` RG8 branch; rig normal layer sourced
   from the tile payload; `.nm` path retained for two-file surfaces.
10. `MapSurface.tileUrl` parsing, fetch selection, `mapNoTileContainer`
    kill switch.
11. Docs: update [normal-encoding.md](normal-encoding.md),
    [rendering-architecture.md](rendering-architecture.md), the
    tileserver production doc, and close the two subsumed backlog
    entries.

Order: server first (1–6), verified with `curl` and a container
dump tool; then client (7–10) against the dev instance; docs (11)
with the closing commit of each half.


## 8. Verification plan

Prerequisite audit (gates the submesh retirement):

- Instrument the legacy parser (or a one-off probe script) to log
  `numSubmeshes > 1` and sweep the supported legacy test datasets —
  the benatky vtsd tilesets and the pre-v6 integration surfaces from
  `test/urls.json` reproduction entries. Expected: none. Any hit
  triggers the fallback decision in §3.6.

Server:

- Byte-level: container parses; geometry payload decodes with the
  unchanged client parser; KTX2 header fields exact.
- Mesh parity: for a tile sample across LODs, fused-path meshes match
  today's within the characterized power-of-two-ladder deviation
  (face counts and screenshot parity, not byte identity).
- Normal parity: decode fused-path KTX2 and today's `.nm` for the
  same tiles; compare decoded 3-D normals (angular error histogram)
  and hillshaded screenshots. Expected: sub-perceptual differences
  from the midpoint-averaged input (§3.3).
- Latency: repeat the §1.1 measurement; expect container latency ≈
  today's `.nm` latency, i.e. roughly half the serialized pair.
- Old-client compatibility: `.bin`/`.nm` responses byte-identical
  before/after (same code paths — verify with checksums).

Client (dev server, per the testing workflow in AGENTS.md):

- `npx tsc --noEmit`; dev-server restart; screenshot tests
  `simple-terrain`, `complex-terrain`, `full-terrain` — pixel parity
  against prod, no console/network errors, both with the container
  enabled and with `mapNoTileContainer=1`.
- Legacy datasets (benatky, pre-v6): unchanged rendering through the
  two-file path.
- Perf run (`npm run test:perf:headed`) on the canonical URLs;
  expect load-time improvement on cold dev-server loads, no FPS
  regression.
- iOS/WebKit spot check once available: normal maps no longer create
  `ImageBitmap`s.


## 9. Open questions

- **Default flip.** When does `tileContainer` default to `true` —
  after one production soak, or per-resource forever? Suggestion:
  flip the default together with the first client release that
  consumes `tileUrl`, keeping the option as an opt-out.
- **Client cache accounting.** The container is one cache entry where
  mesh and normal map were two; the resource-cache cost model
  (`MapMesh.size`, GPU cache inserts) needs a decision on whether the
  normal payload counts against texture or mesh budgets.
- **Spheroid fusion.** Whether `surface-spheroid` adopts the fused
  warp or stays on the default sequential path (its normals are
  near-constant; the win is small).
