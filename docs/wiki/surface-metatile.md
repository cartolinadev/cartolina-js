# Surface metatile format

See [index.md](index.md) for the wiki table of contents.

A **metatile** is a binary resource that carries a compact grid of
**metanodes**, one per tile cell in a fixed-size block of the tile
hierarchy. The client fetches metatiles before geometry tiles: the
metanodes tell it which tiles have geometry, their spatial extents,
their height range, which children exist, and how large the tile
would appear on screen. All LOD selection, frustum culling, and
resource-loading decisions are driven by metatile data.

The client supports format versions **4–6**; the parser rejects
anything outside that range. cartolina-tileserver
(mapproxy) emits v6 with the watertight bitplane, generated fresh on
each request. vts-vtsd serves stored tilesets byte-for-byte, so a
stored v5 tileset stays v5 until it is re-encoded to v6; see
[vts-vtsd-archeology.md](vts-vtsd-archeology.md) for how vtsd delivers
metatiles and the re-encode process and commands.

The server-side format is defined in
`externals/vts-libs/vts-libs/vts/metatile.hpp` in the
`cartolina-tileserver` repository. The client parser is in
`src/map/metatile.js` (`MapMetatile.parseMetatatile`) and
`src/map/metanode.js` (`MapMetanode.parseMetanode`).


## Binary layout

All multi-byte integers are little-endian.

### File header

```
magic[2]       char     — always "MT"
version        uint16   — format version (4–6)
lod            uint8    — LOD of this metatile
metatileIdx    uint32   — tile X of the upper-left corner
metatileIdy    uint32   — tile Y of the upper-left corner
offsetX        uint16   — X offset of the valid sub-grid
offsetY        uint16   — Y offset of the valid sub-grid
sizeX          uint16   — width of the valid sub-grid
sizeY          uint16   — height of the valid sub-grid
```

The metatile nominally covers a power-of-two square of tiles, but
only the sub-grid `[offsetX, offsetY] + sizeX × sizeY` contains
valid metanodes.

After the fixed fields come `flags uint8` and `creditCount uint8`,
the two fields described below.

### Header flags

The `flags` byte in the header controls optional sections that
follow:

| Bit | Meaning |
|-----|---------|
| 0–5 | Flag bitplane present (one per bit) |
| 6   | Each metanode has a 1-byte `sourceReference` field |
| 7   | Each metanode has a 2-byte `sourceReference` field |

Bits 6 and 7 are mutually exclusive. When both are 0 the
`sourceReference` field is absent from metanodes (equivalent to
`BackingType::none` in the C++ encoder).

### Flag bitplanes

When header flag bit `i` (0–5) is set, a bitplane for flag `i`
follows in the stream. A bitplane is a byte array of size
`ceil(sizeX * sizeY / 8)`, one bit per tile cell, in row-major
order with each row byte-padded.

**Bitplane 0** carries the **alien flag** for each tile: a tile is
alien when its content was sourced from a foreign (non-primary) surface
during glue generation. See [glue-alien-flag.md](glue-alien-flag.md)
for context.

**Bitplane 1** is valid for v6+ metatiles and carries the
**watertight flag**. A watertight metanode has geometry whose mesh covers
the complete geographic cell allocated to that tile by the spatial
division, with no footprint holes. It describes two-dimensional cell
coverage, not a closed three-dimensional manifold, and implies
`geometryPresent`. It does not say that the mesh resource is loaded or has
drawn successfully.

The client writes the flag to `metanode.watertight` when parsing a v6
metatile. For v4–v5 metatiles the client may infer the same property from a
loaded mesh footprint or, for a parent that declares geometry, from four
existing watertight children. The latter assumes the ordinary coherence of
the terrain LOD pyramid: four complete child cells safely establish that the
declared parent mesh covers its cell. Child inference never marks a
geometry-less parent watertight. Recursive draw coverage remains separate:
four rendered child subtrees can cover a cell for the current frame without
changing the meaning of the parent's mesh flag.

When a v6 bitplane marks a geometry-less metanode watertight, the client
warns once with the first offending surface and tile ID, then clears
`metanode.watertight`. This sanitizes legacy warp metatiles that violate the
invariant while leaving valid store-backed and stored-tileset metadata
unchanged.

Bitplanes for bits 2–5 are reserved.

### Credit blocks

`creditCount` credit blocks follow, each structured as:

```
creditId      uint16   — numeric attribution ID
creditMask    byte[]   — ceil(sizeX * sizeY / 8) bytes,
                         one bit per tile cell (row-major,
                         byte-padded per row)
```

A set bit indicates the tile at that position carries this
attribution. The client resolves `creditId` to a string key via
the credits registry received in `mapConfig.json`.

Credit blocks follow the flag bitplanes directly.

### Metanode array

`sizeX * sizeY` metanodes follow in row-major order (X-major,
Y-minor). Each metanode corresponds to tile
`(lod, metatileIdx + offsetX + x, metatileIdy + offsetY + y)`.

The client records the stream offset after the credit section as
`metanodesIndex` and computes `metanodeSize` once. Individual
metanodes are parsed on demand when `getNode()` is first called
for a given tile.


## Metanode layout

```
flags          uint8    — content and child flags (see below)
```

**v4 — quantized physical extents:**

```
geomExtents    variable — packed bit array of 6 × (lod+2) bits:
                         [minX, maxX, minY, maxY, minZ, maxZ]
                         Each value is a (lod+2)-bit unsigned integer
                         normalized to [0..1], then mapped to the
                         reference frame physical extent.
```

All-zero extents signal an empty tile (no geometry). The client
maps these to ±Infinity so they are culled immediately.

The client parser reads them for `version < 5` and uses them for the
horizontal bounding box. They are superseded in v5 by explicit SDS
horizontal extents.

**Explicit SDS height:**

```
minZ           float32  — min height in SDS (surface coordinate space)
maxZ           float32  — max height in SDS
surrogate      float32  — representative tile height used for disk
                          position computation; −∞ when not set
```

**v5+ — SDS horizontal extents:**

```
llX            float32  — lower-left X of tile in SDS
llY            float32  — lower-left Y of tile in SDS
urX            float32  — upper-right X of tile in SDS
urY            float32  — upper-right Y of tile in SDS
```

SDS is the coordinate system of the spatial division node. A
tile's theoretical cell extent in SDS follows directly from its
tile ID and the division node definition without any SRS
transform. What the stored values add is the **geometry
coverage extent**: the tileserver samples the DEM on a fixed
grid within the tile and accumulates only valid (in-dataset)
points into the horizontal extents. At coastlines or dataset
edges some sample points are invalid and excluded, so the
stored extents can be tighter than the full cell.

The cartolina-js client skips these fields (`metanode.js:187`)
and uses full-cell bounds derived from the division node in
`generateCullingHelpers()`, which is sufficient for frustum
culling. Using the stored extents instead would give tighter
bounds at partial-coverage tiles and avoid the division node
computation for the horizontal component — a straightforward
improvement that has not been implemented.

**Common suffix:**

```
internalTextureCount   uint8    — number of internal textures;
                                  repurposed in glue nodes (see below)
texelSize              uint16   — half-precision float (texel size in
                                  SRS units; valid only when flag bit 2
                                  is set)
displaySize            uint16   — desired display size in pixels;
                                  valid only when flag bit 3 is set
minHeight              int16    — navtile height range min (navSRS units)
maxHeight              int16    — navtile height range max
```

**Optional source reference:**

```
sourceReference        uint8 or uint16
```

Present when header flag bit 6 (uint8) or bit 7 (uint16) is set.

A stored glue or virtual surface can use `sourceReference` to identify the
component surface that owns a tile without stitched geometry. The value is a
1-based slot in the aggregated surface table; zero means no reference.
cartolina-js parses the field to keep the stream aligned but no longer reads
it because terrain traversal ignores glues and virtual surfaces.

See "Glue surface resolution" in the client usage section below.

### Metanode flag bits

| Bit | Symbol | Meaning |
|-----|--------|---------|
| 0 | `geometryPresent` | tile has a renderable mesh |
| 1 | `navtilePresent` | tile has a navtile (heightmap for navigation) |
| 2 | `applyTexelSize` | `texelSize` field is valid and should be used |
| 3 | `applyDisplaySize` | `displaySize` field is valid and should be used |
| 4 | `ulChild` | upper-left child tile exists |
| 5 | `urChild` | upper-right child tile exists |
| 6 | `llChild` | lower-left child tile exists |
| 7 | `lrChild` | lower-right child tile exists |

`watertight` is a separate bitplane flag rather than a bit in this byte.
Its invariant is `watertight => geometryPresent`: the declared mesh for
this metanode covers the complete tile cell. Child existence describes the
available subtree and does not change that field's meaning.

The client enforces the implication when applying the watertight bitplane:
invalid `watertight && !geometryPresent` input emits a one-time warning with
the first surface and tile ID, and is normalized to non-watertight.

The alien and watertight flags are **not** in this byte. Alien lives in
header bitplane 0. Watertight lives in header bitplane 1 for v6+
metatiles. `applyMetatanodeBitplanes()` writes them to
`metanode.alien` and `metanode.watertight`.

### Structural metanodes

A metanode whose `geometryPresent` bit is clear is a **structural**
metanode: it carries no renderable mesh of its own and exists to
advertise children on the way to deeper geometry. Older notes in this
wiki call the same thing a *routing* node — the two terms are
equivalent. **Structural** is the preferred term and the only one the
[tileserver documentation][ts-tile-index] uses.

The client's operational test is the geometry bit alone
(`MapMetanode.hasGeometry()`): the recursive draw traversal classifies
a geometry-less node as `'structural'` coverage and renders nothing
for it, and terrain height queries do not let a surface claim a
coordinate through a purely structural path (see
[nav-tiles.md](nav-tiles.md)). A structural metanode served by the
tileserver additionally carries no navtile and no watertight flag —
only child bits and a stored height range that bounds every descendant
mesh, so client-side culling can decide the descent. The format itself
does not forbid a navtile on a geometry-less node; where one exists,
height queries use it.

Unrelated sense: [reference-frames.md](reference-frames.md) speaks of
the LOD 0 division node as a "routing switch" and of "empty routing
levels". That usage is about the reference frame dispatching subtrees
into projections, not about metanodes.

[ts-tile-index]: https://github.com/cartolinadev/cartolina-tileserver/blob/main/docs/tile-index.md


## Version history

Versions 1–3 are not listed: the client no longer parses them.

| Version | Changes |
|---------|---------|
| 4 | `minZ`, `maxZ`, `surrogate` (float32 each) added after the quantized extents inherited from v3. Quantized extents remain in the stream and are still read by the client for the horizontal bbox. |
| 5 | Quantized physical extents removed; SDS horizontal extents (`llX`, `llY`, `urX`, `urY`) added in their place. cartolina-js skips the SDS horizontal extents and continues to use full-cell bounds derived from the division node, which is sufficient for frustum culling. |
| 6 | Header bitplane 1 added for the watertight tile flag. The per-node byte layout is unchanged from v5. |


## Client usage

### Fetching and caching

`MapResourceNode.getMetatile()` in `src/map/resource-node.js`
is the entry point. On the first call for a given tile ID it
constructs a `MapMetatile` and schedules an HTTP load. On
subsequent calls for the same ID but a different surface it
returns a **clone**: the binary data and parsed node offsets are
shared; only surface-specific state differs. Each metatile
(original and clone) is registered with the LRU
`map.metatileCache`, sized in bytes by
`map.config.mapMetatileCache`.

`MapMetatile.scheduleLoad()` enqueues the URL produced by
`surface.getMetaUrl(id)` through the map loader. On completion
`onLoaded()` calls `parseMetatatile()`, records the byte offset
of the metanode array, and marks the tile ready.

### LOD traversal

`MapSurfaceTile.validate()` in `src/map/surface-tile.js`
drives the tile tree traversal. For each surface in the sequence
it calls `metaresources.getMetatile()` and then
`metatile.getNode(id)` to retrieve the metanode for the current
tile. The metanode is parsed from raw bytes on first access and
cached in `metatile.nodes[]`.

`tile.metanode` holds the resolved node after `validate()`
completes. The `used()` call on the metatile updates the LRU
order.

### LOD selection

`MapSurfaceTile.updateTexelSize()` in `src/map/surface-tile.js`
computes `tile.texelSize` from the metanode:

- If `applyTexelSize` is set, the texel size is read from
  `node.pixelSize`. This is the half-float physical length per
  nominal tile sample decoded at parse time.
- If `applyDisplaySize` is set, version 4 uses `node.bbox.maxSize /
  node.displaySize`; versions 5 and 6 use `node.bboxMaxSize /
  node.displaySize`, where `bboxMaxSize` is computed in
  `generateCullingHelpers()` from the physical bbox corner distances.
- `hasChildren()` (flag bits 4–7) controls whether the traversal
  descends further or renders the current tile.

`updateTexelSize()` projects the length to physical viewport pixels
for the current camera. The normal descent test is
`tile.texelSize > draw.texelSizeFit`; `mapTexelSizeFit` defaults to
`1.1`. See [lod-selection.md](lod-selection.md) for the full calculation
and traversal rules.

### Frustum culling and disk distance

`MapMetanode.generateCullingHelpers()` in
`src/map/metanode.js` computes the culling disc: `minZ` and the
division-node coordinate transform give `diskPos` (3D physical
center), `diskNormal` (surface normal at center), and
`diskAngle`/`diskAngle2` (cosines of the half-angle of the tile as
seen from the camera).

`tile.isVisible()` uses `diskAngle2` and `diskAngle2A` against
the camera direction; `tile.getDistance()` uses `diskDistance`
and `diskAngle2` to compute the physical distance to the nearest
tile boundary.

For geocentric projections at low LODs (≤ 3), the client expands
the physical bbox to account for globe curvature before culling.

### Navtile height range

`node.minHeight` and `node.maxHeight` (int16, in navSRS units)
bound the elevation range of the navtile. The draw system in
`src/map/draw-tiles.js` passes these to the mesh shader as
`uHeights.x` and `uHeights.y`. They are also used when
constructing navtile cache keys.

`minZ` and `maxZ` are in SDS and may differ from the int16 navSRS
values.

### Glue surface resolution

A glue's metatile grid covers a rectangular region that includes
both the true seam tiles and surrounding tiles that fall within
only one component surface. For surrounding tiles the glue has no
geometry of its own; it records which component surface should be
rendered there instead.

That record is `sourceReference`: a 1-based slot in the aggregated surface
table, with zero meaning no reference. `MapMetanode.parseMetanode()` stores
it, but no client code reads it. The glue and alien handling that consumed it
was removed with the multi-surface client code; see
[glue-alien-flag.md](glue-alien-flag.md).

### Credits

`MapMetatile.applyMetanodeCredits(x, y)` in `metatile.js` scans
the credit bitmask array for the node at grid position (x, y) and
pushes matching credit IDs into `metanode.credits[]`. This is
called every time a metanode is first parsed.

Terrain imagery credits now come from active `TileRenderRig` layer IDs:
`MapDrawTiles.drawSurfaceTile()` records layer credits during the color
pass, then `map.applyCredits(tile)` merges them into the visible-credit
set. Geodata tiles still read `node.credits` in `drawGeodataTile()`.
