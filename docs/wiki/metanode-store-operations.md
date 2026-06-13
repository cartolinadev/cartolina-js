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
- the configured resource `lodRange.max` does not exceed the LOD range
  covered by the paired `tiling.<rf>`/`metanodes.<rf>` artifacts;
- store format version (current: 2; older stores are rejected).

Store rejection and store-to-warp fallback are warning conditions
(`W3`). They are safe only for old three-pyramid datasets where
`dem.min` and `dem.max` are still present. Investigate them; they mean
the resource is not using the RFC 7 fast path.

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

Add `--gsd <meters>` to set the floor resolution (highest LOD)
explicitly instead of relying on the measured GSD. A *lower* (finer)
value than the dataset's native resolution deepens the floor to carry
a more detailed draped layer — e.g. `--gsd 10` on the ~90 m
`viewfinder-dem3` so it can carry the 10 m `esa-worldcover` overlay; a
*higher* (coarser) value caps the effective resolution. This works for
both DEM and imagery resources and replaces the deprecated, DEM-only
`demToOphotoScale` knob.

### Manual route

```
generatevrtwo <input> <dir>/vrtwo.cubicspline --resampling cubicspline
ln -s vrtwo.cubicspline/dataset <dir>/dem

mapproxy-calipers <dir>/dem --referenceFrame <rf>
   # gives lodRange + per-division-node tile ranges + resource ranges
   # add --gsd <meters> to set the floor resolution (highest LOD) explicitly

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

#### Reading calipers output into the command line

`mapproxy-calipers` prints one `range<SRS>:` line per spatial-division
node, then a final `range:` line. They feed two different places:

- each `range<SRS>:` line gives one `--tileRange` for `mapproxy-tiling`;
- the final `range:` line gives the resource definition's `lodRange`
  and `tileRange`, not the tiling command.

A `range<SRS>:` line reads `<lodRange> <lod>/<tileRange>`. Pass its
second token — the `<lod>/<tileRange>` part — verbatim as one
`--tileRange`. Do not copy the leading `<lodRange>` token: writing
`--tileRange 14 14/10979,2787:13596,5404` (the `2,14` line's `14`
included) makes the parser reject the argument, or, with the
two-positional form, treat the freed `14/...` as a stray third
positional ("too many positional options"). Each value is
`LOD/xmin,ymin:xmax,ymax`; the colon between the corners is required.
So this output:

```
gsd: 92.4552
gsdOverride: 10
range<pseudomerc>: 1,15 15/0,0:16383,16383
range<steres-wgs84>: 2,14 14/10979,2787:13596,5404
range<steren-wgs84>: 2,14 14/2787,10979:5404,13596
range: 1,15 0,0:1,1
```

translates to:

```
mapproxy-tiling <dir> <rf> \
    --lodRange 1,15 \
    --tileRange 15/0,0:16383,16383 \
    --tileRange 14/10979,2787:13596,5404 \
    --tileRange 14/2787,10979:5404,13596 \
    --geoidGrid <grid.gtx>
```

`--lodRange` is one value for the whole run: the union of the per-node
`<lodRange>` first tokens — here `min(1,2,2) = 1` and
`max(15,14,14) = 15`, giving `1,15`.

The `<lod>/` prefix on a `--tileRange` is an extent anchor, not a depth
limit. It is the LOD at which calipers measured that node's footprint;
the unified pass rescales the footprint to whatever LOD it is currently
descending. It does not cap how deep the node is tiled — every node
descends to the single `--lodRange.max`. In the example the polar
`steres`/`steren` nodes resolve to the 10 m floor GSD at LOD 14, but
with `--lodRange.max = 15` they are still tiled and stored one level
past their useful resolution. There is no per-node depth knob today;
the per-node `14` survives only as the footprint anchor. Trimming this
dead-resolution descent is tracked in the backlog (PERF: spatially
varying bottom lod).

Packaging: keep the defaults. Current cartolina-js clients require
effective `metaBinaryOrder = 5` (the reference-frame value) and
`metaDepth = 1`; mapproxy refuses to serve anything else, and
changing packaging on an existing dataset is deferred to the client
shallow-subtree milestone. The `--metaBinaryOrder`/`--metaDepth`
knobs exist for store validation work only.

Then write the resource definition as usual (ranges from the
calipers `range:` line) and let mapproxy pick it up.

LOD range changes are a re-tiling operation. The old server path could
expand a shallow flag tile index at runtime, but a metanode store also
owns height ranges and texel-size inputs, so mapproxy now refuses to
synthesise deeper LODs for store-backed datasets. If you need a deeper
`lodRange.max`, rerun `mapproxy-tiling` for the new range and publish a
new matched `tiling.<rf>` + `metanodes.<rf>` pair. To choose the floor
`lodRange.max` up front at setup time, pass `--gsd` to
`mapproxy-calipers`/`mapproxy-setup-resource` rather than re-tiling
later. On a live reload, a
bad expanded configuration fails to prepare and the previously ready
resource continues serving its old revision; on a fresh start, the
resource stays unavailable until the artifacts and configuration match.

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
   stays up — this is the safety net for the verification window.
   Deleting them gives up the warp fallback for good — that is what
   going normal-only means — so delete only after the store has been
   serving correctly **and** you have a tested store-only rollback: a
   retained known-good `tiling.<rf>`/`metanodes.<rf>` pair you can
   restore and re-prepare. The post-deletion safety net is that
   previous matched pair, not the warp path.

   **Defer deletion while any `W3` `falling back to warp` warnings are
   visible in the log.** They mean the store could not serve some
   metatiles and the warp path is still carrying them live; deleting
   the pyramids then turns those requests into failures. Resolve the
   fallback cause first (step 3) and confirm a clean log before
   removing the pyramids.

   After deletion, a resource whose store fails validation **fails to
   prepare**, and tiled-geodata freelayer metatiles that use the same
   DEM must also have a valid store-backed path. The old geodata
   metatile warp fallback needs `dem.min`/`dem.max` too (the §7.1
   matrix):

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
- *"configured max LOD ... exceeds paired tiling max LOD"* — the
  resource definition asks for runtime LOD expansion. This is not
  supported for metanode-store-backed datasets; rerun
  `mapproxy-tiling` for the deeper range and publish the new pair.
- *"falling back to warp"* — the store was present but could not serve
  a metatile. This is logged as `W3`. It is a temporary compatibility
  path only while `dem.min`/`dem.max` exist; normal-only datasets fail
  instead of falling back.
- Cache revision policy: re-tiling changes served metatile bytes
  (within the documented tolerances), so apply the deployment's
  usual public revision bump if a CDN caches metatiles.
