# Tile index

See [index.md](index.md) for the wiki table of contents.

This document describes what a VTS tile index carries, how
`mapproxy-tiling` produces one, and how the tileserver assembles the
index it actually serves from a resource definition plus the generated
tiling. It records only facts verifiable in the source.

For the surrounding generation pipeline (calipers, VRTWO, serve-time
warp) see
[tileserver-metatile-production.md](tileserver-metatile-production.md).
For reference-frame concepts see
[reference-frames.md](reference-frames.md).

Source paths below are relative to the `cartolina-tileserver`
repository.


## What a tile index carries

A tile index is not geometry. It is a per-tile classification map.

### Structure

`TileIndex` (`externals/vts-libs/vts-libs/vts/tileindex.hpp`) holds a
`std::vector<QTree> trees_`, one quadtree per LOD, anchored at
`minLod_`. It is therefore a stack of sparse rasters keyed by
`TileId = (lod, x, y)`. Each `QTree`
(`externals/vts-libs/vts-libs/vts/qtree.hpp`) stores one `uint32` value
per cell and collapses uniform regions into a single node, so empty or
uniformly-flagged areas cost almost nothing. Lookup is
`get(tileId) -> value`.

It stores no mesh, heights, textures, or file offsets — only, for each
tile position, a small bitmask describing what kind of tile, if any,
exists there.

### The per-tile value

The value is a flag bitfield, defined in `tileindex.hpp` (`Flag` enum,
lines 47-80). The stored single-bit flags:

| Bit | Name | Meaning |
|---|---|---|
| 0x01 | `mesh` | a mesh exists here; this is the existence test |
| 0x02 | `watertight` | the mesh has no holes |
| 0x04 | `atlas` | the tile has a texture atlas |
| 0x08 | `navtile` | the tile carries a navigation tile |
| 0x10 | — | unassigned |
| 0x20 | `alien` | shared its value with a reference tile in the past |
| 0x40 | `multimesh` | the mesh has more than one submesh |

A tile is "real" iff it has a mesh (`real = mesh`, line 56). Derived
masks built from the above: `content = mesh | atlas | navtile`,
`nonmeta = watertight | multimesh`, `any = 0xff`, `none = 0`. A meshless
alien tile is an `influenced` tile — a non-existent tile that inherits
its value from a coarser LOD (lines 70-73).

The `reference` value reported by `getReference` (line 106) is **not**
in this byte; it is stored as `flags >> 16`, in memory only, and is
never serialised.

### Serialisation constraint

Only the low byte of the value is serialised, and `0xff` is reserved
(`tileindex.hpp` lines 44-45). `0xff` is the quadtree's gray-node
marker, `GrayNode` in `externals/vts-libs/vts-libs/vts/qtree.cpp`
line 50: in the V1 node encoding (`loadV1`, line 577) a node byte of
`0xff` means "this node is subdivided, read its four children," as
opposed to a leaf carrying an actual value. Reserving it keeps a leaf
value from ever colliding with the marker, which is why the flag set is
capped at 7 usable persistent bits (bit `0x80` is held clear). Of those
seven, six are assigned and `0x10` is free. The current `save`/`load`
path (lines 317-348) marks an internal node with a 2-bit type field
instead, but the 7-bit reservation keeps both encodings unambiguous.

### Per-tile versus metatile-level flags

`nonmeta = watertight | multimesh` (line 62) names the flags that are
**not** present in the metatile-level index; they exist only in the full
per-tile index.


## Production: `mapproxy-tiling`

Source: `mapproxy/src/tiling/tiling.cpp`.

`mapproxy-tiling` reads the VRTWO and produces a `TileIndex`. The
`TreeWalker` class descends the tile tree depth-first. For each
candidate tile it warps a grid of `(tileSampling + 1)²` samples
(`tileSampling` defaults to 128, so 129 × 129 = 16 641 samples;
`tiling.hpp` line 44, `tiling.cpp` line 249) from the source into the
tile's own reference-frame-node SRS (`node.srsDef()`, lines 271-272),
inspects the coverage mask (`tileDs.cmask()`, line 308), and sets flags.
The output is a binary QTree saved alongside the resource definition.

### How coverage maps to flags

`checkMask` (lines 310-320) classifies the warped tile as `whole`,
`some`, or `none`:

- **`none`** (lines 364-371): empty, no children, descent stops.
- **`some`** (lines 352-360): partially covered. The tile is set to
  `mesh` only (no `watertight`); descent continues.
- **`whole`** (lines 322-349): fully covered. There are two sub-cases,
  and the split is on **source resolution**, not LOD:
  - `!wri.overview && wri.truescale >= 1.0` (line 326): the warp
    consumed the original dataset with no downscaling, so deeper
    sampling cannot reveal new holes. `fullSubtree()` (lines 207-217)
    sets the whole subtree from this LOD down to `lodRange.max` to
    `mesh | watertight`, and descent stops.
  - otherwise (lines 342-343): the tile was filled from downsampled
    source. Only **this** tile is set `mesh | watertight`; descent
    continues, because finer source data could still resolve holes.

`navtile` is added to `baseFlags` when `!upscaling` (lines 302-305).

### Other flag sources

- `config_.forceWatertight` (lines 313-317) reclassifies `some` as
  `whole`, marking partially-covered tiles watertight. Default false
  (`tiling.hpp` line 44).
- Invalid reference-frame nodes get a deliberate fake-watertight subtree
  (lines 221-237; the comment states it is a lie that "will not hurt
  anyone").

### Cost

The per-tile GDAL warp dominates. Each productive tile at every LOD from
the analysis-range minimum down to the floor is warped, and tile count
grows roughly fourfold per level. The seal in the first `whole` sub-case
above only engages once the warp reaches native resolution, so a fully
covered but downsampled region is **not** sealed early and is warped at
every level down to that floor. OpenMP task-based recursion
(lines 178-183) parallelises across tiles but does not reduce the total
warp work. See
[tileserver-metatile-production.md](tileserver-metatile-production.md)
for the pipeline-level cost discussion.


## The served index: `prepareTileIndex`

Source: `mapproxy/src/mapproxy/support/tileindex.cpp`.

The index the tileserver serves is not the on-disk tiling file directly.
`prepareTileIndex` rebuilds an index from scratch (`ti = {}`, line 42)
each time the resource is loaded, from two inputs.

### Synthetic lod/tile-range index

The first block (lines 44-79) is built purely from the resource's
configuration — its `lodRange` and tile ranges. For every LOD in
`resource.lodRange` it stamps the configured tile rectangle, clipped to
productive reference-frame nodes, with default flags. Default flags
(lines 47-51) are `mesh`; `watertight` is added only when there is **no**
external tiling, and `navtile` is added at `lodRange.min` (lines 69-72).
This index knows where the resource declares coverage, not where data
exists.

### Combining with the tiling

If an external tiling is present, it is loaded (lines 85-86) and combined
with the synthetic index via `combine` (lines 102-115). The combiner is
an intersection: it returns 0 unless a tile is present in **both** inputs
(`if (!o || !n) return 0`), and otherwise unions the flag bits. The
combine is limited to `resource.lodRange`. A mask tree, if present, then
clips the result (lines 119-155).

Because the synthetic index carries `watertight` only when there is no
tiling, with a tiling present every `watertight` bit in the served index
comes from the tiling.

### LOD-range broadening

When `resource.lodRange.max` exceeds the tiling's maximum LOD
(lines 88-99), the tiling is "too shallow" and is enlarged before the
combine:

```cpp
datasetTiles
    .makeAvailable(vts::LodRange(0, resource.lodRange.max))
    .completeDownFromBottom();
```

- `makeAvailable` (`tileindex.cpp` line 979) force-creates empty
  quadtrees for every LOD from root to the new max.
- `completeDownFromBottom` (`tileindex.cpp` lines 577-606) finds the
  finest non-empty LOD and merges its tree downward into the new empty
  LODs, copying flag bits with `filter = value & Flag::any`.

So broadening the **max** replicates the tiling's deepest footprint
downward into the added LODs.

There is no equivalent enlargement on the **min** side. The tiling
output is populated only from its own configured minimum LOD: every
tile-setting path in `mapproxy-tiling` is gated by `Flag::analyze`,
which is set only for `lod >= lodRange.min` (`tiling.cpp` lines 147-149).
Because the combine is an intersection, at any LOD coarser than the
tiling's minimum the tiling side is empty and the result is empty there.
The code documents the assumption that this does not happen: `// NB:
tiling *should* be from root` (`support/tileindex.cpp` line 95).

### Known limitation: watertight under max-side broadening

`completeDownFromBottom` copies flag bits indiscriminately, including
`watertight`. At the tiling's bottom LOD, a `watertight` tile may have
been produced by either `whole` sub-case above. The second sub-case
(downsampled source, watertight set per-tile while descent continued)
occurs precisely when finer source data still exists below that tile —
the common situation when a tiling is deliberately shallower than the
source. The tile index records no provenance to distinguish the two
cases, so the copy carries `watertight` into the broadened LODs without
re-sampling the source there. This is described as a redesign motivation
in [backlog.md](backlog.md): **PERF/REDESIGN: coverage-mask
`mapproxy-tiling`**.
