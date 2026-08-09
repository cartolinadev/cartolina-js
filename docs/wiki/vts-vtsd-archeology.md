# vts-vtsd archeology

See [index.md](index.md) for the wiki table of contents.

Notes on how `vts-vtsd` operates, gathered while rolling out the v6
watertight metatile format (RFC stage 5,
[rfc03-draw-traversal.md](rfc03-draw-traversal.md)). `vts-vtsd` is a
sunsetting component still used in some deployments; this page records
the reusable findings so the next person does not have to re-derive
them.

`vts-vtsd` and `cartolina-tileserver` share one vendored copy of
`vts-libs` each (`externals/vts-libs`); both are kept on the same
`vts-libs` branch and commit so a format change lands in both.

## Delivery only — vtsd does not transcode metatiles

vtsd serves **pre-stored** VTS tilesets from disk. For a metatile
request (`<lod>-<x>-<y>.meta`) it streams the **raw stored bytes**
verbatim. The path is:

- `VtsTileSet::handle` → `handleTile`
  (`vtsd/src/vtsd/delivery/vts/driver.cpp`)
- → `Delivery::input(tileId, TileFile::meta, …)`
  (`externals/vts-libs/vts-libs/vts/tileset/driver/delivery.cpp`),
  which for the non-debug flavor returns `driver.input(tileId,
  TileFile::meta)` — the raw stored stream
- → `tileFileStream` (`vtsd/src/vtsd/delivery/vts/support.cpp`), whose
  default case for `meta` is `sink.content(is, …)` — stream as-is.

There is no parse-and-re-save step. The consequence: the metatile
format version vtsd serves is whatever is on disk. Bumping the
`vts-libs` metatile `VERSION` and rebuilding vtsd does **not** change
the served version. The v6 vts-libs patch only lets vtsd *accept* a
v6-stored tileset instead of refusing it (load rejects
`version > VERSION`).

This is unlike `cartolina-tileserver` (mapproxy), which generates
metatiles fresh per request and therefore emits the new version
immediately after rebuild. See
[tileserver-metatile-production.md](tileserver-metatile-production.md).

### Deploy a vtsd built against the v6 vts-libs

"Delivery only" holds for the plain tile paths (meta/mesh/atlas/navtile
stream raw), but vtsd **does parse** metatiles on two endpoints: credit
collection (`creditsFromMetatiles` → `loadCreditsFromMetaTile` in
`vts-libs .../tileset/driver/delivery.cpp`) and 3D-Tiles conversion
(`MetaBuilder` → `loadMetaTile` in
`vtsd/src/vtsd/delivery/vts/tdt2vts/metabuilder.cpp`). The metatile
loader rejects `version > VERSION` (`metatile.cpp`), so a vtsd binary
linked against the old v5 `vts-libs` throws "unsupported version" on
those endpoints for a v6 tileset — raw tile delivery would still work,
credits / 2D / 3D-Tiles would not.

vtsd needs no source change, but it links `vts-libs` statically (the
`VERSION` constant and the metatile parser live there). So the binary
must be **rebuilt against the v6 `vts-libs` and deployed** in lockstep
with v6 tilesets. This is the §4.5 requirement that vtsd "must be able
to parse the v6 metatile binary or it will refuse to serve it".

## Where the watertight information lives

A tile is watertight when its mesh has no holes (fully covers its
geographic cell). That fact is stored in the tileset's **tile index**
(`tileset.index`) as `TileIndex::Flag::watertight`, set from the mesh
at tiling time (`externals/vts-libs/vts-libs/vts/mesh.cpp`) and read by
glue generation (`externals/vts-libs/vts-libs/vts/tileset/glue.cpp`).
`TileSet::fullyCovered(tileId)` is exactly `tileIndex.get(tileId) &
TileIndex::Flag::watertight`. See [tile-index.md](tile-index.md).

v5 metatiles never carried a watertight bit, so legacy tilesets have
the watertight data only in their tile index, not in the metanodes the
client reads. The v6 metatile adds header bitplane 1 for it
(see [surface-metatile.md](surface-metatile.md)).

Read the stored counts without changing anything:

```
vts --tileindex-info <tileset>/tileset.index     # mesh / watertight / alien counts
vts --metatile-version <tileset> --tileId 18-70912-44256   # stored metatile version
vts --dump-metatile    <tileset> --tileId 18-70912-44256   # per-node flags
```

`--tileId` uses dash form (`<lod>-<x>-<y>`).

## Upgrading a legacy v5 tileset to v6 with watertight

**What path to pass.** `vts --reencode` detects the dataset type of the
path (`vts::datasetType`) and acts accordingly:

- a **storage** — the reference-frame directory holding `storage.conf`,
  `tilesets/` and `glues/` (e.g. `<store>/earth.melown2015`) — is
  re-encoded **recursively**: every member tileset and glue. A remote
  member (no local tiles) is not cloned — `RemoteDriver::reencode` only
  bumps its revision. This is the store-level usage.
- a single **tileset** or **glue** directory (e.g.
  `<store>/earth.melown2015/tilesets/benatky-nad-jizerou2015`) re-encodes
  only that one.

The top-level serving root (vtsd's `root`) may hold several storages
side by side (`earth.melown2015`, `mars`, …) and is **not** itself a
storage; point `--reencode` at a specific storage directory or a tileset
directory, not at that parent. Already-re-encoded datasets carry a
`<tag>.marker` and are skipped on a repeat run, so a storage-level pass
is safe after individual ones.

`vts --reencode` rewrites a stored tileset's metatiles at the current
`vts-libs` `VERSION`. The mechanism (in
`externals/vts-libs/vts-libs/vts/tileset/tileset.cpp`,
`TileSet::Factory::reencode`):

1. clone the tileset to `<tileset>.<tag>` with the requested encode
   flags (meshes/atlases are byte-copied; only metatiles are
   re-encoded for `--encode meta`);
2. swap directories: the live path becomes the new tileset and
   `<tileset>.<tag>` is left holding the **old** data as a backup;
3. drop a `<tag>.marker` file so a repeat run is a no-op.

`vts --reencode-cleanup … --tag <tag>` removes the `<tag>` backup.

Plain reencode alone does **not** set watertight: it re-saves the v5
metanode unchanged and v5 metanodes have no watertight bit. The
`vts-libs` reencode/clone path was extended so that, with `--encode
meta`, each metanode's watertight flag is taken from the source tile
index (`copyMetanode().watertight(mask & TileIndex::Flag::watertight)`
in the clone loop). The introspection flag table
(`vts-libs/vts/metaflags.cpp`) also gained `watertight` so
`vts --dump-metatile` reports it.

Commands (run with the v6-built `vts`; leaves a `.v6` rollback backup
per tileset):

```
# whole storage, recursive (remote members: revision bump, no clone):
vts --reencode <store>/earth.melown2015 --encode meta --tag v6
# or one tileset / glue:
vts --reencode <store>/earth.melown2015/tilesets/<id> --encode meta --tag v6
# verify, then optionally drop the backup(s):
vts --reencode-cleanup <store>/earth.melown2015 --tag v6
```

Verify non-destructively before touching the store by cloning to a
throwaway path and dumping it:

```
vts --clone <tileset> --tileset /tmp/check --encode meta
vts --metatile-version /tmp/check --tileId 18-70912-44256   # -> 6
vts --dump-metatile    /tmp/check --tileId 18-70912-44256 | grep watertight
```

After an in-place reencode, a running vtsd keeps serving the old data
from its open file handles; **restart vtsd** so it re-opens the swapped
tileset.

**Which tilesets to re-encode.** Only **plain** local tilesets (and
local glues, which are plain) hold metatiles on disk and need
re-encoding. A storage may also contain **remote**-driver tilesets
(`"type": "remote"` with a `"url"` in `tileset.conf`): these hold no
local tiles — vtsd only copies the remote URL into the storage
mapConfig, and the referenced server (e.g. mapproxy) serves and versions
those tiles. They are neither re-encoded nor served by vtsd, so check a
tileset's `driver.type` before assuming it needs work. In the reference
storage `benatky-nad-jizerou2015` and the glue are plain and were
re-encoded; `topoearth-viewfinder-dem3` is remote → mapproxy and was
left alone.

## Reencode bumps the tileset revision — caches bust on deploy

The clone/create inside `reencode` increments the tileset `revision`
(visible in `tileset.conf`; e.g. 0 → 1 after the first reencode). vtsd
embeds `surface.revision` into every mapConfig tile URL template
(`externals/vts-libs/vts-libs/vts/mapconfig.cpp` via `fileTemplate` in
`vts/tileop.cpp`). For a plain tileset with no generator revision the
suffix renders the revision twice, `?<rev><rev>`:

- revision 0 → `…​.meta?00`
- revision 1 → `…​.meta?11`

So a reencode changes every tile URL in the regenerated mapConfig,
which busts any URL-keyed downstream cache (CDN, reverse proxy) on
deploy. Each further reencode increments the revision again.

### Remote surfaces are versioned by vtsd, not by their source

vtsd writes the URL templates for **every** surface in a storage
mapConfig, including remote ones, and stamps them with its **own** local
revision. A remote member's served template is the remote URL plus
vtsd's suffix — e.g. the live storage mapConfig shows

```
topoearth-viewfinder-dem3  //…/mapproxy/…/viewfinder-dem3/{lod}-{x}-{y}.meta?0gr=<storeGr>&r=0
benatky-nad-jizerou2015    tilesets/benatky-nad-jizerou2015/{lod}-{x}-{y}.meta?1gr=<storeGr>&r=1
```

where `r=` is vtsd's local stub `revision` (from the remote tileset's
`tileset.conf`) and `gr=` is a storage-side generatorRevision shared by
all surfaces — neither is the backend's own `gr`. Consequences:

- A data/revision change at the **source** (mapproxy regenerating the
  remote surface) has no effect on what the client fetches or caches:
  the client only uses vtsd's templates, and vtsd does not refresh its
  stub revision from the remote.
- To bust caches for a remote surface you must bump the revision **at
  vtsd** (its local stub). A storage-level `vts --reencode` does this —
  `RemoteDriver::reencode` clones nothing but bumps the stub revision,
  which is the only cache-bust lever vtsd has for a remote surface.

## Running the dev server

Build target `vtsd` in the vtsd build tree; the binary is
`vtsd/build/bin/vtsd`. Run it with the dev config:

```
cd vtsd/build
./bin/vtsd -f <path-to>/vtsd.conf
```

- The listen port comes from the config's `[http] listen`. On the
  reference dev box the from-source dev instance listens on **3061**;
  the packaged system service (`/usr/bin/vts-backend-vtsd`) is a
  separate long-running daemon on **3060** — do not kill it when
  iterating. Always read the conf for the real ports and the storage
  `root`.
- vtsd runs in the **foreground** by default; `-d` / `--daemonize`
  forks it into the background (the packaged system service uses that).
  Stop a foreground instance with Ctrl-C, a daemonized one with
  `-s stop`. Match the dev instance by `bin/vtsd -f` and exclude
  `vts-backend`.
- The `vts` tool from the vtsd build links the same `vts-libs`; for
  reencodes either build is fine as long as it is the v6 line.

## Pointers

- Backend interface and the metatile binary:
  [surface-metatile.md](surface-metatile.md),
  [tile-index.md](tile-index.md).
- Storage layout, aggregated driver, virtual surfaces and the alien
  flag history:
  [vts-storage-and-virtual-surfaces.md](vts-storage-and-virtual-surfaces.md),
  [glue-alien-flag.md](glue-alien-flag.md).
- The v6 rollout that produced these notes:
  [rfc03-draw-traversal.md](rfc03-draw-traversal.md) §4.5 and stage 5.
