# Tileserver tools

Inventory of the executables built from the cartolina-tileserver
tree: what each is for and where it ships. Usage details live in each
tool's `--help` and, for the metanode-store workflow, in
[metanode-store-operations.md](metanode-store-operations.md).

## Server (`cartolina-tileserver` package)

| Tool | Purpose |
|---|---|
| `mapproxy` | the tile server itself: serves surfaces, bound layers and free layers defined by the resource configuration |

## Operator tools (`cartolina-tileserver-tools` package)

Dataset preparation and resource setup:

| Tool | Purpose |
|---|---|
| `generatevrtwo` | builds a virtual GDAL dataset with overview pyramids (vrtwo) from an input raster; one resampling per run |
| `mapproxy-calipers` | measures a dataset in a reference frame: GSD, lod range, per-division-node tile ranges, suggested position — feeds `mapproxy-tiling` and the resource definition; `--gsd <meters>` sets the floor resolution (highest LOD) explicitly for DEM or imagery |
| `mapproxy-tiling` | the unified tiling pass (RFC 7): analyzes a DEM and atomically publishes the paired flag tile index + metanode store; `--legacy` runs the old per-tile analysis (tile index only) |
| `mapproxy-setup-resource` | end-to-end resource setup from a raw raster: vrtwo, tiling/store, resource definition, mapproxy registration; metanode-store mode by default for DEMs (`--legacyTiling` for the three-pyramid path); accepts `--gsd <meters>` to set the floor resolution (forwarded to calipers) |
| `mapproxy-rf-mask` | builds reference-frame mask trees (resource `mask` setting) |

Metanode-store diagnostics (RFC 7):

| Tool | Purpose |
|---|---|
| `mapproxy-mnstore` | metanode store inspection: `info` (header, packaging, pairing), `dump` (page contents), `selftest` (format round-trip incl. non-default packaging) |
| `mapproxy-tidiff` | per-tile diff of two vts tile indexes over a lod/tile range; the tiling parity gate |
| `mapproxy-texel-spike` | harvests per-node texelSize/height/planar-analytic CSV from v6 metatile files (plus child-metatile ids for tree crawling); built for the RFC 7 phase-1 calibration, useful for re-calibration on other bodies and for serve-parity value diffs |

Semantic/mesh utilities:

| Tool | Purpose |
|---|---|
| `gpkg2semantic`, `semantic2gpkg`, `semantic2semantic` | conversions between GeoPackage and the semantic world format |
| `semantic2obj` | exports a semantic world to OBJ meshes |

## In-tree only (built in `mapproxy/build/bin`, not packaged)

| Tool | Purpose |
|---|---|
| `mapproxy-querymmti` | prints the flag byte of one tile from a (mmapped or vts) tile index |
| `mapproxy-ti2mmti` | converts a vts tile index to the mmapped delivery format |
| `mapproxy-sub-tiling` | derives tiling for a sub-area of an existing tiling |
| `mapproxy-generate-tileindex` | tile index generation helper |
| `mapproxy-tests-demtin` | DEM TIN meshing test bed |
| `vts`, `vts2vts` | vts-libs storage/tileset multitool (incl. `--dump-metatile-file`) and tileset reencoder |
| `qmf-convert`, `rmesh2ply` | quantized-mesh and mesh format converters |
