# Tileserver metatile production

See [index.md](index.md) for the wiki table of contents.

This document describes how the cartolina-tileserver generates
metatiles, where the computational cost lies, and the structural
problem that makes per-request generation expensive relative to the
information it delivers.

For the binary format and client-side usage of metatiles, see
[surface-metatile.md](surface-metatile.md).


## Generation pipeline

Resource setup runs three tools in sequence. Each depends on the
previous output.

### 1. Calipers

`mapproxy-calipers` reads the source raster dataset and measures
its geographic extent. It produces a `Measurement` object carrying
the optimal LOD range for the dataset, the tile ranges at each LOD,
and x-overlap information for datasets that wrap the antimeridian.
This step is fast; it does not read raster data values.

### 2. VRTWO generation — `generatevrtwo`

Source: `mapproxy/src/generatevrtwo/generatevrtwo.cpp`.

`generatevrtwo` builds a virtual GDAL dataset with pre-computed
overview levels. The output directory contains:

- `dataset` — a VRT file that is the entry point for all
  subsequent reads.
- `original` — symlink to the original input dataset.
- One subdirectory per overview level, each containing tiled
  GeoTIFF files (`x-y.tif`) and a level-local VRT.

For DEMs the tool generates **three** overview pyramids in
parallel: one with the default resampling algorithm, one
min-filtered, and one max-filtered. The min and max pyramids are
the source of height-range data at coarse LODs.

**Why this step exists.** GDAL cannot efficiently sample a raw
large-scale DEM at arbitrary LOD levels without pre-computed
overviews. The VRTWO provides overview tiles in a layout that
allows fast random access for any LOD and geographic region,
avoiding full-resolution reads for coarse tiles.

**Cost.** For each overview level, every tile is warped from the
level above using GDAL `warpInto()`. The work is parallelised by
tile using OpenMP. For a planet-scale DEM this step takes multiple
hours: the dominant cost is GDAL warping and writing compressed
GeoTIFF files to disk. The three-pyramid structure triples the
work relative to a single-band overview.

### 3. Tile index generation — `mapproxy-tiling`

Source: `mapproxy/src/tiling/tiling.cpp`.

`mapproxy-tiling` reads the VRTWO and produces a `TileIndex` — a
quadtree structure recording which tiles have data, which tiles are
fully covered (watertight), and which have navtile data. The
`TreeWalker` class does a depth-first descent of the tile tree.
For each tile in the analysis range it warps a small grid of
`(tileSampling + 1)²` samples from the VRTWO (default: 129 × 129
= 16 641 samples per tile), inspects the coverage mask, and sets
the appropriate flags. A fully-covered tile seals its whole subtree
as watertight without further warping only when the warp reached
native resolution (no overview, no downscaling); a fully-covered but
downsampled tile is marked watertight per-tile and descent continues,
because finer source data could still resolve holes. See
[tile-index.md](tile-index.md) for the exact flag rules.

The output is a compact binary QTree file saved alongside the
resource definition.

**Cost.** For large datasets the tile index takes days to generate.
The bottleneck is the per-tile GDAL warp: even sampling from the
VRTWO (which is already at the right overview level), warp setup
and I/O dominate at scale. Millions of tiles at fine LODs must be
touched. Parallelisation via OpenMP task-based recursion helps but
does not eliminate the fundamental per-tile warp overhead.

**Note.** The tile index records tile existence and watertight
status, but not height ranges. Height range data is available in
the VRTWO but is not extracted at this stage.


## Metatile serving — the serve-time warp

Source: `mapproxy/src/mapproxy/generator/metatile.cpp`,
function `metatileFromDemImpl()`.

When a client requests a metatile URL, the server:

1. Queries the tile index (`index_->meta(tileId)`) to check
   the metatile exists.
2. Calls `metatileFromDem()`, which decomposes the metatile into
   blocks via `metatileBlocks()`.
3. For each block, warps the VRTWO into a sample grid covering the
   block's geographic extent (`arsenal.warper.warp()`). This
   samples all three pyramids (normal, min, max) to compute height
   ranges and spatial extents.
4. Computes per-node fields: height range min/max, texel size,
   child flags, SDS horizontal extents.
5. Serialises the result to binary and returns it as the HTTP
   response.

**The GDAL warp in step 3 is the dominant cost.** On a warm server
with the VRTWO resident in OS page cache, individual metatile
requests complete in 100–500 ms depending on the metatile size and
dataset resolution. On a cold cache (e.g., after a CDN miss hits
the origin) they can be substantially slower.

The current model is CDN-compatible: metatile URLs are keyed on
tile ID and are stable, so CDN caches absorb repeated requests
efficiently. Cold misses are expensive but infrequent once a
tile is cached.


## The structural problem

By the time the server handles a metatile request, the VRTWO and
the tile index are already built. Together they contain all the
information a metatile carries:

| Metatile field | Source |
|---|---|
| Tile existence, child flags | Tile index (QTree) |
| Watertight flag | Tile index (QTree) |
| Height range min/max | VRTWO min/max pyramids |
| Texel size | Computable analytically from LOD |
| SDS horizontal extents | Computable from tile ID and reference frame |

The per-request warp re-derives this information from the VRTWO at
serve time rather than reading it from a pre-built store. Because
the VRTWO is already a result of the expensive overview-generation
step, the warp at serve time is redundant: it repeats a sub-problem
of a computation already completed during resource setup.

The result is that a fast, cacheable, content-addressed HTTP
response is produced by an operation whose cost belongs in the
offline generation phase.


## Client-side impact — ping-pong

The client fetches metatiles in a sequential descent: it fetches
the root metatile, reads the child flags, fetches those children's
metatiles, and so on until the visible tiles at the target LOD are
known. Each step is a network round-trip. For a surface at LOD 15,
the descent from the root to the visible tiles can require up to 15
sequential metatile requests before geometry loading starts.

Serve-time warp cost is not the only problem here — even if each
metatile were served from a pre-built store in milliseconds, the
round-trip count itself delays initial rendering. This is a
separate, complementary problem addressed in the backlog item
below.

See [backlog.md](backlog.md): **PERF: pre-built metatile index**.
