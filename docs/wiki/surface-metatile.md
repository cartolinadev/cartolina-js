# Surface metatile format

See [index.md](index.md) for the wiki table of contents.

A **metatile** is a binary resource that carries a compact grid of
**metanodes**, one per tile cell in a fixed-size block of the tile
hierarchy. The client fetches metatiles before geometry tiles: the
metanodes tell it which tiles have geometry, their spatial extents,
their height range, which children exist, and how large the tile
would appear on screen. All LOD selection, frustum culling, and
resource-loading decisions are driven by metatile data.

The current format version is **5**. Versions 1–4 are still parsed
by the client.

The server-side format is defined in
`externals/vts-libs/vts-libs/vts/metatile.hpp` in the
`cartolina-tileserver` repository. The client parser is in
`src/core/map/metatile.js` (`MapMetatile.parseMetatatile`) and
`src/core/map/metanode.js` (`MapMetanode.parseMetanode`).


## Binary layout

All multi-byte integers are little-endian.

### File header

```
magic[2]       char     — always "MT"
version        uint16   — format version (1–5)
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

After the fixed fields, one version-dependent byte follows:

- **v1:** `nodeSize uint8` — byte size of a single metanode (used
  by v1 code to skip nodes it cannot parse).
- **v2+:** `flags uint8`, `creditCount uint8` — the two fields
  described below.

### Header flags (v2+)

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

### Flag bitplanes (v2+)

When header flag bit `i` (0–5) is set, a bitplane for flag `i`
follows in the stream. A bitplane is a byte array of size
`ceil(sizeX * sizeY / 8)`, one bit per tile cell, in row-major
order with each row byte-padded.

Currently only **bitplane 0** is used. It carries the **alien
flag** for each tile: a tile is alien when its content was
sourced from a foreign (non-primary) surface during glue
generation. See [glue-alien-flag.md](glue-alien-flag.md) for context.

Bitplanes for bits 1–5 are reserved and not produced by the
current tileserver.

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

In v1, the credits section is preceded by `creditCount uint8`
and `creditSize uint16` (the total size of all credit blocks in
bytes). In v2+ those fields moved to the file header and credit
blocks follow the flag bitplanes directly.

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

**v1–v4 — quantized physical extents:**

```
geomExtents    variable — packed bit array of 6 × (lod+2) bits:
                         [minX, maxX, minY, maxY, minZ, maxZ]
                         Each value is a (lod+2)-bit unsigned integer
                         normalized to [0..1], then mapped to the
                         reference frame physical extent.
```

All-zero extents signal an empty tile (no geometry). The client
maps these to ±Infinity so they are culled immediately.

v4 tiles carry these bytes at the same position as v1–v3. The client
parser reads them for all `version < 5` and uses them for the
horizontal bounding box. They are superseded in v5 by explicit SDS
horizontal extents.

**v4+ — explicit SDS height:**

```
minZ           float32  — min height in SDS (surface coordinate space)
maxZ           float32  — max height in SDS
surrogate      float32  — representative tile height used for disk
                          position computation; −∞ when not set
```

**v5 only — SDS horizontal extents:**

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

**Common suffix (all versions):**

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

**v3+ optional source reference:**

```
sourceReference        uint8 or uint16
```

Present when header flag bit 6 (uint8) or bit 7 (uint16) is set.

A glue is a pre-baked tileset that covers the seam between a set
of overlapping surfaces. Its metatile is a fixed-size
power-of-two grid, so it necessarily covers tile positions that
fall outside the actual seam — positions where only one component
surface is present. For those positions the glue does not carry
stitched geometry (`!hasGeometry()`). The client still needs to
render something there, so `sourceReference` names which
component surface to fetch the mesh and textures from. It is a
0-based index into the array of surface IDs that make up the
glue. The tile is then rendered as if it belonged to that surface
directly, with the glue metatile acting only as the scheduling
record.

For tiles at the actual seam the glue has its own stitched
geometry (`hasGeometry() == true`) and `sourceReference` is
ignored.

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

The alien flag is **not** in this byte. It lives in bitplane 0
of the metatile header and is written into `metanode.alien` by
`applyMetatanodeBitplanes()`.


## Version history

| Version | Changes |
|---------|---------|
| 1 | Initial format. `nodeSize` in header; quantized physical extents per metanode; credits preceded by `creditCount` and `creditSize` fields. |
| 2 | `flags` and `creditCount` moved to header; `creditSize` dropped; flag bitplanes added; alien bitplane (plane 0) introduced. |
| 3 | `sourceReference` field added to each metanode; header flag bits 6/7 control whether it is uint8 or uint16. |
| 4 | `minZ`, `maxZ`, `surrogate` (float32 each) added after the existing quantized extents. Quantized extents remain in the stream and are still read by the client for the horizontal bbox. |
| 5 | Quantized physical extents removed; SDS horizontal extents (`llX`, `llY`, `urX`, `urY`) added in their place. cartolina-js skips the SDS horizontal extents and continues to use full-cell bounds derived from the division node, which is sufficient for frustum culling. |


## Client usage

### Fetching and caching

`MapResourceNode.getMetatile()` in `src/core/map/resource-node.js`
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

`MapSurfaceTile.validate()` in `src/core/map/surface-tile.js`
drives the tile tree traversal. For each surface in the sequence
it calls `metaresources.getMetatile()` and then
`metatile.getNode(id)` to retrieve the metanode for the current
tile. The metanode is parsed from raw bytes on first access and
cached in `metatile.nodes[]`.

`tile.metanode` holds the resolved node after `validate()`
completes. The `used()` call on the metatile updates the LRU
order.

### LOD selection

`MapSurfaceTile.updateTexelSize()` in `src/core/map/surface-tile.js`
computes `tile.texelSize` from the metanode:

- If `applyTexelSize` is set, the texel size is read from
  `node.pixelSize`. This is the half-float physical length per
  nominal tile sample decoded at parse time.
- If `applyDisplaySize` is set (v5+), `node.bboxMaxSize /
  node.displaySize` is used instead, where `bboxMaxSize` is
  computed in `generateCullingHelpers()` from the physical bbox
  corner distances.
- `hasChildren()` (flag bits 4–7) controls whether the traversal
  descends further or renders the current tile.

`updateTexelSize()` projects the length to physical viewport pixels
for the current camera. The normal descent test is
`tile.texelSize > draw.texelSizeFit`; `mapTexelSizeFit` defaults to
`1.1`. See [lod-selection.md](lod-selection.md) for the full calculation
and traversal rules.

### Frustum culling and disk distance

`MapMetanode.generateCullingHelpers()` in
`src/core/map/metanode.js` computes the culling disc:

- **v4+**: `minZ` and the division-node coordinate transform
  give `diskPos` (3D physical center), `diskNormal` (surface
  normal at center), and `diskAngle`/`diskAngle2` (cosines of
  the half-angle of the tile as seen from the camera).
- **v1–v3** (and the `mapForceMetatileV3` fallback): the
  quantized extent bytes are decoded and the bbox is derived
  from the reference frame's `spaceExtentSize` /
  `spaceExtentOffset`.

`tile.isVisible()` uses `diskAngle2` and `diskAngle2A` against
the camera direction; `tile.getDistance()` uses `diskDistance`
and `diskAngle2` to compute the physical distance to the nearest
tile boundary.

For geocentric projections at low LODs (≤ 3), the client expands
the physical bbox to account for globe curvature before culling.

The `mapForceMetatileV3` config flag forces `useVersion = 3` for
any metatile with version < 5, keeping the older quantized-extent
bbox path active. It exists as an escape hatch for debugging
regressions in the v4/v5 culling path.

### Navtile height range

`node.minHeight` and `node.maxHeight` (int16, in navSRS units)
bound the elevation range of the navtile. The draw system in
`src/core/map/draw-tiles.js` passes these to the mesh shader as
`uHeights.x` and `uHeights.y`. They are also used when
constructing navtile cache keys.

For v1–v3, `minZ` and `maxZ` are aliased to `minHeight` /
`maxHeight` (both are in navSRS coordinates). For v4+, `minZ`
and `maxZ` are in SDS and may differ from the int16 navSRS
values.

### Glue surface resolution

A glue's metatile grid covers a rectangular region that includes
both the true seam tiles and surrounding tiles that fall within
only one component surface. For surrounding tiles the glue has no
geometry of its own; it records which component surface should be
rendered there instead.

In v3+, that record is `sourceReference`: a 0-based index into the
glue's surface-ID array. `MapSurfaceTile.validate()` in
`surface-tile.js:339` reads it and calls
`surface.getSurface(metanode.sourceReference)` to set
`tile.resourceSurface`. From that point on the tile loads its mesh,
textures, and navtile from that component surface, not from the
glue.

Before v3, the same information was packed into `internalTextureCount`:
a non-zero value in a no-geometry glue node was interpreted as a
1-based surface index (`internalTextureCount - 1`). This repurposing
of the field made it impossible to distinguish "no internal textures"
from "redirect to surface 0", which is why the dedicated
`sourceReference` field was added. The client handles both paths; see
`surface-tile.js:540–584`.

### Credits

`MapMetatile.applyMetanodeCredits(x, y)` in `metatile.js` scans
the credit bitmask array for the node at grid position (x, y) and
pushes matching credit IDs into `metanode.credits[]`. This is
called every time a metanode is first parsed.

Terrain imagery credits now come from active `TileRenderRig` layer IDs:
`MapDrawTiles.drawSurfaceTile()` records layer credits during the color
pass, then `map.applyCredits(tile)` merges them into the visible-credit
set. Geodata tiles still read `node.credits` in `drawGeodataTile()`.
