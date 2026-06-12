# Metanode store — operator guide

How to set up, migrate, validate, publish and roll back DEM surface
resources backed by the metanode store (RFC 7,
[rfc-metanode-store.md](rfc-metanode-store.md)). This is a HOWTO
organized by operator task; the design rationale lives in the RFC.
All command names and paths below are the implemented ones.

## The artifacts and the pairing rule

A metanode-store DEM resource keeps, inside its dataset directory:

| Artifact | Role |
|---|---|
| `dem` (vrtwo) | normal overview pyramid; meshes, navtiles |
| `tiling.<referenceFrame>` | flag tile index (existence, watertight, navtile) |
| `metanodes.<referenceFrame>` | metanode store: per-tile height range + flags |
| `dem.min`, `dem.max` (vrtwo) | legacy warp path only; optional with a valid store |

`tiling.<rf>` and `metanodes.<rf>` are **one artifact pair**: a single
`mapproxy-tiling` run writes both, staged under temporary names,
fsynced and renamed into place, and binds them with a pairing digest
(the md5 of the flag-index file, recorded in the store header — the
tooling computes it, never the operator). At resource load mapproxy
uses the store only when *all* of the following match; otherwise it
logs a warning and serves metatiles by the legacy warp:

- store reference frame, `metaBinaryOrder`/`metaDepth` packaging,
  `geoidGrid` and `heightFunction` against the resource definition;
- store pairing digest against the current `tiling.<rf>` content;
- store pairing digest against the digest recorded when the
  resource's cached delivery index was derived
  (`delivery.index.src` in the resource's store directory) — this is
  what forces a re-prepare after re-tiling (see below);
- the resource has no `mask` (masked resources always use the warp
  path);
- store format version (current: 2; older stores are rejected).

Check a store with:

```
mapproxy-mnstore info  <dataset>/metanodes.<rf>
mapproxy-mnstore dump  <dataset>/metanodes.<rf> --page <lod>-<x>-<y>
mapproxy-mnstore selftest
```

## Task: process a new DEM dataset

### Easy route — mapproxy-setup-resource

Metanode-store mode is the default for DEM (TIN) datasets:

```
mapproxy-setup-resource --dataset dem.tif \
    --referenceFrame melown2015 --resourceType TIN \
    --group <group> --id <id> --attribution "{copy}..." \
    --tin.geoidGrid egm96_15.gtx \
    --mapproxy.dataRoot <datasets root> \
    --mapproxy.definitionDir <definitions dir> \
    --mapproxy.ctrl <mapproxy ctrl socket>
```

This builds the **normal** `dem` vrtwo only (no `dem.min`/`dem.max`),
runs the unified tiling pass, publishes the paired artifacts
atomically, writes the resource definition and waits until mapproxy
serves it. `--legacyTiling` restores the old three-pyramid + legacy
analysis behavior.

### Manual route

```
generatevrtwo <input> <dir>/vrtwo.cubicspline --resampling cubicspline
ln -s vrtwo.cubicspline/dataset <dir>/dem

mapproxy-calipers <dir>/dem --referenceFrame <rf>
   # gives lodRange + per-division-node tile ranges + resource ranges

mapproxy-tiling <dir> <rf> --lodRange <l0,l1> \
    --tileRange <lod>/<range> [--tileRange ...] \
    --geoidGrid <grid.gtx>
```

`mapproxy-tiling` runs the unified pass by default and publishes
`<dir>/tiling.<rf>` + `<dir>/metanodes.<rf>` atomically (`--output`
and `--store` override the paths; `--legacy` runs the old per-tile
analysis and produces no store). Pass the resource's `--geoidGrid`
and, if configured, `--heightFunction <file.json>` — the store bakes
both and the server refuses a store whose values disagree with the
resource definition. The four filter passes log per-decile progress
and the run ends with an `I4 Done.` line.

Packaging: keep the defaults. Current cartolina-js clients require
effective `metaBinaryOrder = 5` (the reference-frame value) and
`metaDepth = 1`; mapproxy refuses to serve anything else, and
changing packaging on an existing dataset is deferred to the client
shallow-subtree milestone. The `--metaBinaryOrder`/`--metaDepth`
knobs exist for store validation work only.

Then write the resource definition as usual (ranges from the
calipers `range:` line) and let mapproxy pick it up.

### Shared datasets — independent artifact directory

When the source dataset lives in a shared location you must not
write to, create a local dataset directory that symlinks the vrtwo
*directories* (not the `dem` link itself — GDAL resolves the VRT's
relative references against the opened path) and point the resource
at it; the tiling/store artifacts then land locally:

```
mkdir local-dataset && cd local-dataset
ln -s /shared/.../vrtwo.cubicspline vrtwo.cubicspline
ln -s vrtwo.cubicspline/dataset dem
```

## Task: migrate an existing three-pyramid DEM dataset

1. Run the new tiling against the existing dataset directory (same
   ranges as the original run; they are usually recorded in the
   dataset's README or calipers output):

   ```
   mapproxy-tiling <dir> <rf> --lodRange ... --tileRange ... \
       --geoidGrid <grid>
   ```

   This *replaces* `tiling.<rf>` and adds `metanodes.<rf>` in one
   atomic publish. Optionally diff the new flag index against a copy
   of the old one first:

   ```
   mapproxy-tidiff old-tiling new-tiling \
       --lodRange ... --tileRange ... --tileRangeLod ...
   ```

   Expect the characterized residual classes (boundary tiles whose
   only data is an edge-shared sample; watertight decided by the full
   footprint; navtile-band moves at extreme latitudes) — see the RFC
   implementation notes.

2. **Force a re-prepare**: bump the resource `revision` (or clear the
   resource's cache directory under the mapproxy store) and reload
   mapproxy. The delivery index is a cached artifact derived from the
   flag index at prepare time; without a re-prepare the store is
   rejected with *"delivery index is not derived from the paired flag
   tile index"* and the resource keeps serving by warp — consistent,
   but not what you migrated for.

3. Verify in the mapproxy log:

   ```
   Generator for <rf/group/id>: serving metatiles from metanode store
       "...metanodes.<rf>" (N pages, pairing <digest>).
   ```

   and watch for per-request `falling back to warp` warnings (there
   should be none).

4. **Keep `dem.min`/`dem.max` until verified.** With them present,
   any store rejection degrades to the warp path and the resource
   stays up. Only after the store has been serving correctly and the
   rollback path is tested may the min/max pyramids be deleted —
   after that, a resource whose store fails validation **fails to
   prepare** (the §7.1 matrix):

   | Dataset artifacts | Server behavior |
   |---|---|
   | three pyramids, no store | warp path |
   | matched flag index + store | store path |
   | mismatched store (any check) | warning + warp path |
   | normal-only vrtwo, no valid store | resource prepare failure |

## Rollback

The pair is the unit of rollback. To roll back a migration, restore
the previous `tiling.<rf>` (and remove or keep the now-mismatched
store — it will be rejected by the pairing check either way), bump
the revision, reload. For a normal-only dataset, roll back to a
previous *matched* pair. Always re-prepare after swapping artifacts.

## Failure modes worth knowing

- *"pairing mismatch with flag tile index"* — the store and
  `tiling.<rf>` come from different runs; re-run the tiling (one run
  writes both).
- *"delivery index is not derived from the paired flag tile index"* —
  artifacts are fine, the resource cache is stale; bump revision /
  clear cache and reload.
- *"unsupported version"* — store from an older format; re-run the
  tiling.
- *"geoid grid mismatch" / "height function mismatch"* — the resource
  definition changed after the store was built; re-run the tiling
  with the current settings.
- Cache revision policy: re-tiling changes served metatile bytes
  (within the documented tolerances), so apply the deployment's
  usual public revision bump if a CDN caches metatiles.
