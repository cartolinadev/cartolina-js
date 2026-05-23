# RFC: remove the OGC 3D Tiles / VTS octree pipeline

**Status:** Accepted
**Elevates:** "REFACTOR: remove OGC 3D Tiles streaming mechanism" and
"REFACTOR: delete legacy tile shader family" in
[backlog.md](backlog.md)

---

## 1. Background

### 1.1 History

Between April and September 2020, David Levinsky (Melown/Leica)
added an octree mesh streaming pipeline to what was then vts-browser-js.
Melown Technologies had merged into Leica Geosystems in 2019; their
core commercial product was dense photogrammetry datasets. The pipeline
was built to stream those datasets into the browser renderer.

The data model differed fundamentally from VTS's existing tile pyramid.
VTS surfaces are organised as a 2D geographic quad-tree: tiles are
selected by screen-projected texel density, and the tree structure
is defined by the VTS reference frame and metatile hierarchy. Dense
photogrammetry meshes and point clouds are organised as a 3D octree:
spatial cells partition all three dimensions, and traversal is driven
by 3D bounding-volume visibility rather than 2D tile coverage.

To describe the octree structure, the pipeline borrowed OGC 3D Tiles
`tileset.json`. The format already provided the necessary primitives:
bounding volumes, geometric error, child references, and content URIs.
Using it avoided inventing a new index format. Leaf content URIs
pointed to VTS `.mesh` files, which the existing mesh loader already
handled. The importer used non-standard `extras` fields
(`extras.ci` for octant index, `extras.extents`,
`extras.nominalResolution`, `extras.depth`) to carry VTS-specific
metadata. OGC payload formats (`b3dm`, `i3dm`, `pnts`) were never
implemented.

The pipeline went through three generations:

1. **`3dtiles.js`** (Apr 2020) — fetched `tileset.json` via XHR and
   built a node-shaped geodata tree through `MapGeodataBuilder.addNode`
   / `addMesh`. Surfaced as the `config.tiles3d` browser config key.
   This was a prototype.

2. **`3dtiles2.js`** (late 2020) — parsed the same JSON but produced
   a compact binary `bintree` + `pathTable` structure for the
   `GpuGroup` octree traversal renderer in `group.js`. Offloaded to
   a loader worker via the `direct-3dtiles` kind.

3. **`vts-tree.js`** (Mar 2021) — replaced the JSON wire format with a
   proprietary binary tree descriptor, eliminating JSON parse overhead.
   Produced the same `bintree` + `pathTable` output.

By the time `vts-tree.js` landed, the `3dtiles.js` prototype was
already superseded. The `config.tiles3d` entry point in `browser.js`
was never updated to use the newer pipeline.

### 1.2 Backend support

The Melown/Leica backend tools developed OGC 3D Tiles support in
parallel, but as an output format for external viewers, not as an
input pipeline aligned with the client-side importer.

`vts-vtsd` contains a `tdt2vts` delivery driver
(`vtsd/src/vtsd/delivery/vts/tdt2vts/`) that reads a VTS tileset and
serves it live as a conformant OGC 3D Tiles endpoint: `tileset.json`
with standard `.b3dm` leaf content. `vts-tools` contains two offline
batch converters: `vts23dtiles` and `3dtiles2vts`.

None of this backend work produces or consumes VTS `.mesh` files as
3D Tiles content. The backend targets the standard OGC payload format.
The client-side importer targets the proprietary VTS format. The two
were never aligned.

The vtsd `tdt2vts` driver was designed to serve data to Cesium-based
viewers. The cartolina-js client-side 3D Tiles path was an independent
prototype for a different workflow. The backend 3D Tiles support has
no bearing on the client-side removal.

`cartolina-tileserver`, the current backend for this project, has
Cesium-related code but no OGC 3D Tiles output. The surface generator
produces quantized-mesh terrain tiles (`{z}-{x}-{y}.terrain`,
`application/vnd.quantized-mesh`) and embeds a Cesium viewer as a
per-resource introspection UI. Both serve external Cesium consumers,
not cartolina-js. There is no `tileset.json` generation and no `b3dm`
output. The client-side removal has no effect on the tileserver. The
vtsd and vts-tools 3D Tiles work is legacy infrastructure from the
Melown/Leica era and is not part of the active cartolina stack.

### 1.3 State found during investigation (May 2026)

The `config.tiles3d` path was live but broken. The import of
`MapGeodataImport3DTiles` had been commented out in September 2025
during the `utils.js` → `utils.ts` migration (commit `6e578488`),
so `load3DTiles` threw `ReferenceError: MapGeodataImport3DTiles is
not defined` at runtime.

Restoring the import and fixing two additional bugs (CORS not handled
on the sample server, a null renderer dereference in `MapView.getInfo`
when `getView()` is called before the first render tick) brought the
pipeline to the point where `tileset.json` loads without error and the
free layer is registered. No geometry renders, because the OGC sample
tilesets use `b3dm` leaf content, which the importer ignores. With a
VTS-format tileset (`region` bounding volumes, `.mesh` leaf URIs) the
geometry path would be exercised, but no such tileset exists in the
current cartolina infrastructure.

---

## 2. Problem

The OGC 3D Tiles / VTS octree pipeline is the wrong thing in the wrong
place.

**It is not OGC 3D Tiles.** The pipeline reads `tileset.json` structure
but renders nothing defined by the OGC spec. It only handles `region`
bounding volumes (not `box` or `sphere`), and it only renders VTS
`.mesh` leaf content. A conformant OGC 3D Tiles dataset is consumed
structurally and then silently drops every leaf tile. The OGC format
was borrowed as a convenience index format, not adopted as a standard.

**It is not cartolina-js's problem to solve.** Cartolina-js is a
geographic tile renderer: it renders terrain, imagery, and vector geodata
from a style-driven pipeline. Streaming dense photogrammetry meshes and
point clouds organized as a 3D octree is a different problem, served by
a different class of software. The octree pipeline was a Leica Geosystems
product requirement from 2020; it has no role in a cartographic library.

**It is dead weight.** The `config.tiles3d` entry point has been broken
at runtime since September 2025. The `vts-tree.js` / `3dtiles2.js` path
in `GpuGroup` has no callers in the current deployment. No VTS-format
octree tileset is served by any infrastructure this project connects to.

**It blocks removal of the legacy tile shader family.** The only
remaining callers of `MapMesh.drawSubmesh()` with `MATERIAL_INTERNAL`
are in `GpuGroup.drawMesh()`, which is part of the octree mesh rendering
path. Deleting the octree pipeline makes most of the legacy tile shader
family removable as a follow-on step: `progTile`, `progTile2`,
`progTile3`, `progDepthTile`, `progFogTile`, `progFlatShadeTile`,
`progWireFrameBasic`, `MapMesh.drawSubmesh`, and
`MapMesh.generateTileShader`. `progCFlatShadeTile` and the shared
`tileVertexShader`/`tileFragmentShader` strings survive until the
geodata polygon flat-shading path is migrated.

---

## 3. Proposed removal

### 3.1 Files to delete entirely

- `src/core/map/geodata-import/3dtiles.js`
- `src/core/map/geodata-import/3dtiles2.js`
- `src/core/map/geodata-import/vts-tree.js`
- `src/core/map/pointcloud.js`
- `src/core/renderer/gpu/pointcloud.js`

### 3.2 Code blocks to remove from existing files

**`src/browser/browser.js`**

- The `config.tiles3d` branch in `onMapLoaded` (~line 148–151)
- `Browser.prototype.on3DTilesLoaded`
- The `'tiles3d'` case in `setConfigParam`

**`src/browser/url-config.ts`**

- `'tiles3d'` from `STRING_KEYS`

**`src/core/map/geodata-builder.js`**

- The restored import of `MapGeodataImport3DTiles_` (re-comment or
  delete)
- `MapGeodataBuilder.prototype.addNode`
- `MapGeodataBuilder.prototype.addMesh`
- `MapGeodataBuilder.prototype.addLoadNode`
- `MapGeodataBuilder.prototype.import3DTiles`
- `MapGeodataBuilder.prototype.load3DTiles`
- `MapGeodataBuilder.prototype.load3DTiles2`

**`src/core/map/geodata-view.js`**

- `MapGeodataView.prototype.directParseNode`
- `MapGeodataView.prototype.directParse`
- The `geodata['binPath']` check and `directBinParse` call
  (~lines 252–256, 273–274)
- The `group.rootNode` and `group.binPath` checks in the draw loop
  (~line 340, 345)

**`src/core/map/geodata-processor/worker-main.js`**

- The `nodes[].meshes[]` dispatch block (~lines 445–452)
- All dispatch on `WORKER_TYPE_NODE_BEGIN`, `WORKER_TYPE_NODE_END`,
  `WORKER_TYPE_MESH`, and `WORKER_TYPE_LOAD_NODE`

**`src/core/map/loader/loader.js`**

- The `'direct-3dtiles'` case in the kind switch (~line 189)
- The `'pointcloud'` case (~line 185) if no other caller remains

**`src/core/map/loader/worker-main.js`**

- The `import` of `MapGeodataImport3DTiles2_`
- The `'direct-3dtiles'` branch in `loadBinary`
- The `parse3DTile` function

**`src/core/renderer/gpu/group.js`**

- `GpuGroup.prototype.addMeshJob`
- `GpuGroup.prototype.drawMesh`
- `GpuGroup.prototype.onBinFileLoaded`
- All handling of `WORKER_TYPE_NODE_BEGIN`, `WORKER_TYPE_NODE_END`,
  `WORKER_TYPE_MESH`, and `WORKER_TYPE_LOAD_NODE` (the `rootNode`
  tree and its traversal)
- The `binFiles` / `binPath` streaming and traversal machinery
  (~lines 1380–1853)
- The `import` of `MapGeodataImportVTSTree_` and its local alias
- The `import` of `MapResourceNode_` and its local alias — all four
  call sites in the file (`addMeshJob`, `drawMesh` ×2,
  `onBinFileLoaded`) are in the octree path
- The `direct-3dtiles` loader call
- Constructor fields: `this.loadMode`, `this.binFiles`
- Instance fields set by `onBinFileLoaded`: `rootPath`, `rootPoints`,
  `rootCenter`, `rootRadius`, `rootTexelSize`
- The hardcoded `this.map.config.mapTraverseToMeshNode = false` debug
  override (~line 1403) and the `mapTraverseToMeshNode` guard
  (~line 1412) inside the traversal
- The `mapSplitLods` config read (~line 1432)
- The `debug.drawNBBoxes` and `debug.drawOctants` branches (~lines
  1032, 1091, 1164) inside `drawMesh`

**`src/core/map/resource-node.js`**

- `getPointCloud()` — no remaining callers after the above
- `getMesh()` stays: `draw-tiles.js` calls `tile.resources.getMesh()`
  for surface tile meshes; that path is unrelated to this removal

**`src/core/map/geodata.js`**

- The commented-out `load3DTiles` branch inside the block comment
  (~lines 76–84). The comment contains a broken double-dot reference
  (`this..mapLoaderUrl`) and calls a method that will no longer exist.

**`src/core/core.js`**

- The `mapSplitLods: false` entry in the default config object
- The `mapTraverseToMeshNode` entry if one exists in the default config

**`src/core/map/map.js`**

- The `'mapTraverseToMeshNode'` case in `setConfigParam`

**`src/browser/url-config.ts`**

(existing `'tiles3d'` entry already listed above)

- `'mapTraverseToMeshNode'` from `STRING_KEYS` or equivalent set

**`src/core/map/draw.js`**

- The `drawNBBoxes: false` field in the debug object defaults
- The `drawOctants: false` field in the debug object defaults

**`src/core/inspector/input.js`**

- The `mapSplitLods` toggle (key handler and inverse)
- The `drawNBBoxes` assignment sites (initialization and tileBBox
  handler) — `drawBBoxes` (terrain bounding boxes) is unrelated and
  stays
- The `drawOctants` assignment sites (key `U`/`u` handler and
  URL-param handler)

**`src/core/renderer/renderer.ts`**

- The `drawNBBoxes` field in the debug type/interface

**`src/core/constants.ts`**

- `JOB_MESH`
- `JOB_POINTCLOUD`
- `WORKER_TYPE_MESH`
- `WORKER_TYPE_LOAD_NODE`
- `WORKER_TYPE_NODE_BEGIN`
- `WORKER_TYPE_NODE_END`

### 3.3 Follow-on: legacy tile shader family

Once the octree mesh path is gone, verify with `rg` that no callers
of `MapMesh.drawSubmesh()` remain outside `mesh.js` itself. If none
remain, delete:

- `MapMesh.prototype.drawSubmesh`
- `MapMesh.prototype.generateTileShader`
- `progTile`, `progTile2`, `progTile3`, `progDepthTile`,
  `progFogTile`, `progFlatShadeTile`, `progFlatShadeTileSE`,
  `progWireFrameBasic`, `progWireFrameBasicSE`, and their variant
  arrays from `renderer.ts` and `init.js`
- `GpuShaders.tileWireFrameBasicShader`
- `MATERIAL_INTERNAL` from `constants.ts`
- The `drawPolyWires` debug branch in `src/core/renderer/draw.js`
  (~lines 1311–1332) together with its `progWireFrameBasic[SE]`
  references
- `drawPolyWires: false` from the debug object defaults in
  `src/core/map/draw.js`
- The `W/w` `drawPolyWires` toggle in `src/core/inspector/input.js`

`progWireFrameBasic[SE]` can be deleted here because the only working
caller is `mesh.js:drawSubmesh` (the octree path being removed). The
`draw.js` debug branch at line 1315 references these programs but is
already broken: `progWireFrameBasic` is initialized as a variant array
and used there as a direct `GpuProgram`, and `progWireFrameBasicSE`
is never initialized. The branch is guarded by `drawPolyWires`, which
defaults to false.

**Not removable in this pass:**
`progCFlatShadeTile` and `progCFlatShadeTileSE` are still used by
`src/core/renderer/draw.js` for geodata polygon flat-shading (the
working, non-debug path at ~line 1258). Because those programs compile
against `GpuShaders.tileVertexShader` and `GpuShaders.tileFragmentShader`,
those shared shader strings survive until the geodata polygon rendering
path is migrated to a dedicated shader.

The remaining terrain renderer must be `TileRenderRig`. Run the full
test suite and screenshot regression tests after this pass.

---

## 4. Verification

Scope all checks to `src/`, `test/`, and `demos/` — the RFC itself,
backlog, and session log retain historical references by design and
are not subject to these checks.

After the main deletion pass, confirm no references remain to the
following terms by running one `rg` call per group:

```sh
rg -n "tiles3d|3DTiles|direct-3dtiles|vts-tree" src test demos
rg -n "JOB_MESH|JOB_POINTCLOUD" src test demos
rg -n "WORKER_TYPE_MESH|WORKER_TYPE_LOAD_NODE|\
WORKER_TYPE_NODE_BEGIN|WORKER_TYPE_NODE_END" src test demos
rg -n "mapTraverseToMeshNode|mapSplitLods" src test demos
rg -n "drawNBBoxes|drawOctants" src test demos
```

(`pointcloud` is a common English word; search the compound forms
`getPointCloud\|JOB_POINTCLOUD` rather than the bare token.)

After the shader family pass (§3.3), confirm no references remain:

```sh
rg -n "drawSubmesh|generateTileShader" src test demos
rg -n "progTile|progDepthTile|progFogTile|progFlatShadeTile|\
progWireFrameBasic" src test demos
rg -n "MATERIAL_INTERNAL|drawPolyWires" src test demos
```

(`tileVertexShader` and `tileFragmentShader` are expected to survive
in `src/` because `progCFlatShadeTile` still uses them — see §3.3.)

Then run `npx tsc --noEmit` and the canonical screenshot checks
`simple-terrain`, `complex-terrain`, and `full-terrain`.

---

## 5. Migration plan

No migration. The `config.tiles3d` option has been broken at runtime
since September 2025 and there are no known users. The `vts-tree.js`
/ `3dtiles2.js` pipeline in `GpuGroup` has no callers in the current
cartolina infrastructure.

The null renderer guard added to `MapView.getInfo` during the
investigation (`renderer &&` before `renderer.getSuperElevationState()`)
is a legitimate defensive fix unrelated to this removal and should be
kept.

---

## 6. Alternatives considered

**Restore and complete the OGC 3D Tiles integration.** This would
require implementing `b3dm`/glTF parsing, `box` and `sphere` bounding
volume support, and a general material pipeline for arbitrary glTF
content. That is a substantial project and produces something that
serves a different purpose than cartolina-js. Not recommended.

**Restore and maintain the VTS-format octree pipeline.** There is no
VTS-format octree tileset in the current infrastructure. The Leica
Geosystems use case that motivated the pipeline is outside the scope
of this project. Not recommended.

---

## Review round 1

1. Blocker: define the removal boundary for node-shaped geodata. The
   proposal removes `nodes[].meshes[]` dispatch in
   `src/core/map/geodata-processor/worker-main.js`, but
   `src/core/map/geodata-view.js` still has `directParseNode()`,
   `directParse()`, `nodes`, `loadNodes`, and direct emission of
   `WORKER_TYPE_NODE_BEGIN`, `WORKER_TYPE_MESH`,
   `WORKER_TYPE_LOAD_NODE`, and `WORKER_TYPE_NODE_END`. `GpuGroup`
   still handles those worker types and stores `rootNode`. If this
   format exists only for the 3D Tiles prototype, delete the whole
   node-shaped geodata path and the related constants. If it is still a
   supported geodata format, state that and keep the minimal non-octree
   parts. The current text leaves implementers with a half-removed
   path.

   *Implemented.* The node-shaped geodata path (`directParseNode`,
   `directParse`, `WORKER_TYPE_NODE_BEGIN/END/MESH/LOAD_NODE`,
   `rootNode` in `GpuGroup`, `JOB_MESH`, `JOB_POINTCLOUD`) exists
   solely for this pipeline. No other code produces or consumes the
   node-shaped builder output. §3.2 now lists all of these for
   deletion, including the `geodata-view.js` methods and the
   `GpuGroup` dispatch blocks, along with the constants in §3.2
   (`constants.ts`).

2. Blocker: include the job and worker constants in the deletion plan.
   Removing mesh and point-cloud node rendering should also remove
   `JOB_MESH`, `JOB_POINTCLOUD`, `WORKER_TYPE_MESH`, and
   `WORKER_TYPE_LOAD_NODE` from `src/core/constants.ts` once no caller
   remains. If the full node-shaped geodata path is deleted, also remove
   `WORKER_TYPE_NODE_BEGIN` and `WORKER_TYPE_NODE_END`. Leaving these
   constants behind preserves names for a protocol the RFC says should
   disappear.

   *Implemented.* All six constants are now listed for removal in
   §3.2 (`constants.ts`).

3. Blocker: the point-cloud deletion needs its loader and resource-node
   edges listed. Deleting `src/core/map/pointcloud.js` and
   `src/core/renderer/gpu/pointcloud.js` also requires deleting the
   `MapPointCloud` import and `getPointCloud()` from
   `src/core/map/resource-node.js`, and the `'pointcloud'` kind in
   `src/core/map/loader/loader.js` if no other caller remains.

   *Implemented.* `getPointCloud()` is now listed explicitly under
   `resource-node.js` in §3.2. The `'pointcloud'` kind is listed
   under `loader.js` with the conditional note.

4. Non-blocking: change the `getMesh` bullet to say it stays unless a
   separate terrain change removes it. `src/core/map/draw-tiles.js`
   still calls `tile.resources.getMesh()` for surface meshes. The RFC's
   conditional wording is technically safe, but an explicit note would
   prevent the octree deletion from accidentally reaching into terrain
   mesh loading.

   *Implemented.* The `getMesh` bullet now explicitly states it stays
   and names `draw-tiles.js` as the remaining caller.

5. Non-blocking: list the leftover commented `load3DTiles()` branch in
   `src/core/map/geodata.js`. It is inside a block comment and has no
   runtime effect, but leaving a broken `this..mapLoaderUrl` example
   and a call to a removed API makes the file misleading after the RFC
   is implemented.

   *Implemented.* `geodata.js` is now listed in §3.2 with a note
   about the broken double-dot reference.

6. Non-blocking: make the verification gates concrete. At minimum,
   require `rg` checks for `tiles3d`, `3DTiles`, `direct-3dtiles`,
   `vts-tree`, `pointcloud`, `JOB_MESH`, `JOB_POINTCLOUD`,
   `WORKER_TYPE_MESH`, `WORKER_TYPE_LOAD_NODE`, and `drawSubmesh`,
   plus `npx tsc --noEmit` and the canonical screenshot checks for
   `simple-terrain`, `complex-terrain`, and `full-terrain`.

   *Implemented.* §4 (Verification) now lists both grep term sets
   and the required test commands.

---

## Review round 2

1. Blocker: narrow the legacy shader follow-on. `progCFlatShadeTile`
   and `progWireFrameBasic` are not proven removable by deleting
   `MapMesh.drawSubmesh()`. `src/core/renderer/draw.js` still uses
   `renderer.progCFlatShadeTile` for flat-shaded geodata polygons and
   `renderer.progWireFrameBasic` for polygon debug wire drawing. Both
   are created in `src/core/renderer/init.js` from
   `GpuShaders.tileVertexShader`; `progCFlatShadeTile` also uses
   `GpuShaders.tileFragmentShader`. The RFC must either keep those
   programs and shared shader strings until geodata polygon drawing is
   migrated, or add that migration/removal as an explicit prerequisite
   of the shader-family pass.

   *Implemented.* §3.3 is narrowed. `progCFlatShadeTile[SE]` and
   `progWireFrameBasic[SE]` are removed from the deletion list with
   an explicit note that they survive because `draw.js` uses them for
   geodata polygon flat-shading and debug wire drawing. Because both
   programs compile against `GpuShaders.tileVertexShader` and
   `GpuShaders.tileFragmentShader`, those strings are also removed
   from the deletion list and kept until a geodata polygon migration
   replaces them. The programs and shader strings are not removed from
   §4's post-deletion grep checks (they are expected to remain).

2. Blocker: make the verification grep scope executable. Section 4 says
   to confirm with `grep -r` that terms such as `tiles3d`, `3DTiles`,
   `pointcloud`, and `drawSubmesh` have no references remaining, but the
   RFC itself, backlog entries, and session logs are expected to keep
   historical references. Scope the command to code-bearing paths such
   as `src`, `test`, and `demos`, or state which documentation references
   are allowed to remain.

   *Implemented.* §4 now scopes all grep checks to `src/`, `test/`,
   and `demos/`. A note explicitly states that the RFC, backlog, and
   session log retain historical references and are not subject to these
   checks.

3. Non-blocking: list the `GpuGroup` imports and constructor fields that
   disappear with the octree/node path. The current bullets cover the
   main methods, but implementation will also need to remove the
   `MapResourceNode` import if no geodata path uses it, `binFiles`,
   `loadMode`, and octree-only fields created by `onBinFileLoaded()` such
   as `rootPath`, `rootPoints`, `rootCenter`, `rootRadius`, and
   `rootTexelSize`.

   *Implemented.* §3.2 (`group.js`) now lists `onBinFileLoaded`,
   the `MapResourceNode` import and alias (all four call sites in
   `group.js` — in `addMeshJob`, `drawMesh`, and `onBinFileLoaded`
   — are in the octree path), the `loadMode` and `binFiles`
   constructor fields, and the five `root*` instance fields.

4. Non-blocking: decide whether octree-only debug/config names should be
   deleted with the same pass. `mapTraverseToMeshNode` and
   `mapSplitLods` are only used by the `GpuGroup` octree traversal, so
   removing that traversal leaves stale config keys in `core.js`,
   `map.js`, and `url-config.ts`. `drawNBBoxes`, `drawOctants`, and
   related inspector toggles may still be useful for terrain or geodata,
   but the RFC should call out which debug controls survive and which
   are octree-only.

   *Implemented.* All four are octree-only. `mapTraverseToMeshNode`
   is consumed only by `group.js`'s traversal function; its only
   outside presence is the `map.js` case and the `url-config.ts`
   entry. `mapSplitLods` is likewise consumed only by
   `group.js`; it has no `map.js` case and is set only via the
   inspector toggle and the `core.js` default. `drawNBBoxes` and
   `drawOctants` are declared in `draw.js` and read exclusively
   inside `group.js`'s octree draw path; `drawBBoxes` (terrain
   bounding boxes) is unrelated and stays. §3.2 now lists all of
   these across `group.js`, `map.js`, `url-config.ts`, `core.js`,
   `draw.js`, `inspector/input.js`, and `renderer.ts`.

---

## Review round 3

1. Blocker: define how polygon debug wire drawing survives after
   `MapMesh.generateTileShader()` is deleted. Section 3.3 says
   `progWireFrameBasic` and `progWireFrameBasicSE` stay because
   `src/core/renderer/draw.js` uses them. The current initialization in
   `src/core/renderer/init.js` creates `progWireFrameBasic` as a variant
   array, not as the direct `GpuProgram` that `draw.js` expects.
   `progWireFrameBasicSE` is not initialized there at all. The
   super-elevation variant is currently tied to the same dynamic variant
   mechanism that `generateTileShader()` owns. The RFC should either
   replace polygon debug wire drawing with dedicated non-tile programs,
   remove that debug branch with this pass, or state the exact program
   initialization that remains after `generateTileShader()` is gone.

   *Implemented.* The previous `§3.3` note about `progWireFrameBasic[SE]`
   surviving was wrong. Tracing the call sites:
   `mesh.js:drawSubmesh` (~line 867) uses `progWireFrameBasic[v]`
   with `generateTileShader` — this is inside the octree code and
   disappears with `drawSubmesh`. The `draw.js` branch at line 1315
   is the only other call site, and it is already broken: `init.js`
   creates `progWireFrameBasic` as a variant array but `draw.js`
   passes it to `gpu.useProgram` as a direct `GpuProgram`, and
   `progWireFrameBasicSE` is never initialized at all. The branch is
   guarded by `drawPolyWires`, which defaults to false.
   `§3.3` now deletes `progWireFrameBasic`, `progWireFrameBasicSE`,
   `GpuShaders.tileWireFrameBasicShader`, and the `drawPolyWires`
   debug branch in `draw.js` together with the wireframe programs.
   `progCFlatShadeTile[SE]` and the shared tile shader strings still
   survive to a later pass (legitimate, non-broken use by the geodata
   polygon flat-shading path).

2. Blocker: make the verification command syntactically executable.
   Section 4 says `grep -r src/ test/ demos/`, but `grep -r` expects the
   pattern before the paths. Use `rg -n "<pattern>" src test demos`, or
   give one combined alternation command per check set. If generated
   performance results under `test/perf/results/` are not part of the
   source-bearing surface, exclude that directory.

   *Implemented.* §4 now gives one `rg -n PATTERN src test demos`
   call per check group with alternation syntax. The note about
   `pointcloud` being a bare English word is addressed by searching
   `getPointCloud\|JOB_POINTCLOUD` instead.

3. Non-blocking: restore the status line to one lifecycle value. The
   project RFC lifecycle defines `Draft`, `In review`, `Accepted`, and
   `Implemented`. `**Status:** In review (round 2 responded)` is clear
   to a human, but it no longer matches the table in `AGENTS.md`.
   Keep the status as `In review` and let the latest review section show
   which round is open.

   *Implemented.* Status restored to `In review`.

---

## Review round 4 — sign-off

Accepted. The design now identifies the octree, point-cloud,
node-shaped geodata, debug/config, and shader cleanup boundaries. The
remaining legacy shader dependency through `progCFlatShadeTile[SE]` is
documented as a separate geodata polygon migration. The verification
commands are scoped to source-bearing paths and distinguish expected
historical documentation references from code references.
