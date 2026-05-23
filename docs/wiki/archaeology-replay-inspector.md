# VTS archaeology: the replay inspector

This document records what the replay inspector was, how it worked, and
why it was deleted after freeze mode replaced it. Written in May 2026
after a diagnostic session that found it broken and partially fixed it.

## What it was for

The replay inspector was a diagnostic tool for the tile selection
algorithm. During VTS development (2016–2017) the tile descent logic was
complex and actively evolving: several load modes, glue tiles, free
layers, grid modes. The inspector gave the developer a way to freeze a
frame and examine exactly what happened: which nodes the descent visited,
which tiles were ultimately drawn, in what order assets loaded.

The tool was built entirely for one person debugging one algorithm. Once
that algorithm stabilised it had no further purpose.

## History

| Date | Event |
|---|---|
| 2016–2017 | Built and actively used during VTS tree-descent development |
| 2017-06-23 | Last substantive commit (`bcaf2ac0`, "fixed freelayers in the inspector") |
| 2019-01-24 | Silently broken by `processDrawBuffer` refactor (`4e0d557d`) — see below |
| 2026-05-13 | Documented (`2b4dde32`, "old inspector replay documented") |
| 2026-05-18 | Diagnosed, Drawn Tiles bug fixed, Globe crash fixed, debug logs removed |
| 2026-05-23 | Deleted after freeze mode shipped |

The tool was functional for roughly two years of the VTS development
cycle, which itself continued for at least two to three years after the
last inspector commit. Nobody noticed it was broken.

## The bug that killed it

The `processDrawBuffer` refactor (January 2019) extracted per-surface
draw loops into a shared function with a `noGrid` parameter. When
`noGrid=true`, `drawBuffer` entries are bare tile objects. When
`noGrid=false` (the older call sites), they are `[tile, isGrid]` tuples.

The snapshot path in `processDrawBuffer` pushed entries into `tileBuffer`
unconditionally — a mix of bare objects and tuples. The replay read path
in `drawMap` always read `tiles[i][0]`, expecting tuples. Bare tile
objects have no `[0]` property, so `tiles[i][0]` is `undefined` for
every main-surface tile, and `drawSurfaceTile` was never called. The
screen went black.

The fix (2026-05-18): `tile = Array.isArray(tiles[i]) ? tiles[i][0] : tiles[i]`.

One line. The tool worked immediately after.

## Architecture

The machinery was spread across five files with no clean boundary.

### `src/core/inspector/replay.js`

The UI panel (~920 lines). HTML construction, CSS, slider and checkbox
wiring, the load-sequence bar graphs, camera frustum geometry generation.
Opened by pressing Shift+T (after Shift+D activates the inspector).

### `src/core/map/draw.js`

The central integration point.

- `this.replay` object at line 125: the shared flag store (`storeTiles`,
  `drawTiles`, `lod`, `drawnTiles`, `loaded`, etc.)
- Lines 295–390: the replay display block. When any draw flag is set,
  this block runs `drawSurfaceTile` or `drawTileInfo` on the snapshotted
  data, then **returns early**, completely replacing the normal hot path
  for that frame.
- Lines 404–517: the snapshot capture blocks, each guarded by a store
  flag, each running once after the corresponding draw function returns.

### `src/core/map/surface-tree.js`

Two hooks per draw function (five draw functions total):

- At the top of each: `var storeNodes = replay.storeNodes || replay.storeFreeNodes`
  — a local bool read once, then checked inside the per-node descent loop.
  This was the hottest replay touch: one branch per visited node, every
  frame.
- In `processDrawBuffer` at line 1592: the `storeTiles || storeFreeTiles`
  guard that pushes entries into `tileBuffer`. Only fires the one frame
  after S is clicked.

### `src/core/map/loader/loader.js`

Two recording hooks at lines 273 and 310 (`onLoaded` and `onLoadError`).
A local variable reads `replay.storeLoaded` on every completed network
response. This was the only hook that ran during normal operation even
when the tool was idle, though its cost was one boolean read per download.

### `src/core/inspector/inspector.js`

The `onMapUpdate` callback (line 114) drew the globe and camera frustum
overlays. These ran on every map-update event whenever their flags were
set — they did not go through the `drawMap` display block and did not
cause an early return.

### `src/core/inspector/input.js`

Shift+T at line 461 toggled the replay panel. The `replay` parameter
keys wired inspector parameters to the `replay` object flags.

## The S buttons

Each item in the panel had its own S button setting a different store
flag:

| Button | Flag set | Captured from |
|---|---|---|
| Drawn Tiles S | `storeTiles` | `tileBuffer` after `tree.draw()` |
| Drawn Tiles Free Layers S | `storeFreeTiles` | `tileBuffer` filtered by `tile.surface.free` |
| Traced Nodes S | `storeNodes` | `replay.nodeBuffer`, populated per-node during descent |
| Traced Nodes Free Layers S | `storeFreeNodes` | same, filtered for free layer surfaces |
| Load Sequence S | `storeLoaded` | loader callbacks, continuous recording |
| Camera S | (no flag) | camera state captured immediately in the click handler |

The Drawn vs Traced distinction was the tool's core diagnostic value:
Drawn shows the final render selection; Traced shows everything the
descent visited, including fallbacks to coarser tiles when finer ones
were not ready. Comparing the two revealed where the algorithm was
doing unnecessary work or falling back unexpectedly.

Load Sequence had completely different semantics: it recorded a timeline
of asset downloads (URL, kind, duration, interval, thread count) that
could be scrubbed after the fact to see what loaded when and where.

## What worked and what did not (as of May 2026)

| Feature | Status |
|---|---|
| Drawn Tiles | Broken 2019–2026 (bare-tile bug); fixed May 2026 |
| Drawn Tiles - Free Layers | Works for mesh free layers; geodata free layers bypass the capture path (`drawMonoliticGeodata`) and yield an empty snapshot |
| Traced Nodes | Always worked — uses CPU-side metanode data, no GPU dependency |
| Traced Nodes - Free Layers | Same scope as Drawn Tiles - Free Layers |
| Load Sequence recording | Worked, but requires starting the recording during active tile loading; a fully-loaded scene records nothing |
| Load Sequence display | Broken for the same reason as Drawn Tiles (bare-tile bug) |
| Camera frustum | Always worked; must rotate the camera after snapping to see the frustum from a different angle |
| Globe overlay | Crashed on first use: `drawTBall` called before the base64 texture finished loading; fixed May 2026 with a `loaded` guard |

## Pipeline pollution

The replay machinery added to every rendered frame even when idle:

- Five `if (storeNodes)` branches inside the descent loops
- One `if (replay.storeTiles || storeFreeTiles)` check per `processDrawBuffer` call
- One `var recordStats = this.map.draw.replay.storeLoaded` read per network response
- The large display block in `drawMap` (lines 295–390) checked on every frame

When no replay flags were set, all of these were no-ops. The practical
cost was the branch checks, not significant. But the code weight in
`drawMap` was considerable: roughly 230 lines of replay machinery inside
the normal draw function, plus the capture blocks after each draw call.

## Deletion

Freeze mode shipped before the full draw traversal rewrite. The replay
panel was then deleted directly instead of waiting for the broader draw
cleanup. The deletion removed `src/core/inspector/replay.js`,
`map.draw.replay`, replay branches in `draw.js`, node/tile capture in
`surface-tree.js`, load-sequence capture in `loader.js`, and the
`mapStoreLoadStats` config flag.

The same cleanup removed the legacy custom-mesh demos that used
`Renderer.createMesh()` and `Renderer.drawMesh()`. Those methods had no
remaining source caller after replay was removed. The 3D Tiles/geodata
mesh path is separate and still uses `GpuGroup.drawMesh()`.

## Replacement: freeze mode

See `backlog.md` for the freeze mode feature. Freeze locks the camera
state used for tile selection, culling, and depth sampling while the live
camera still drives navigation and final rendering. The tile descent
continues running every frame against the frozen viewpoint, so the scene
stays live and tiles that finish loading appear. The finite frustum
overlay can be viewed after navigating away from the frozen position.
This covers the primary diagnostic purpose of the replay tool without
snapshot machinery, store flags, or replay-specific draw hooks.
