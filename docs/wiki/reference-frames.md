# Reference frames

See `index.md` for the wiki table of contents.

A reference frame answers the foundational questions that any 3D mapping
engine must resolve before it can render a single tile:

- In which coordinate system are mesh geometries expressed?
- What does it mean to pan or orbit the camera?
- How are positions reported to the user?
- How is the world subdivided into a tile hierarchy?

Reference frame agnosticism is one of the stronger design features of
the system: the renderer, tile pipeline, camera, and navigation
machinery all operate on whatever frame is declared in the map
configuration. Earth, Mars, the Moon, or a fictional body are equally
valid as long as appropriate SRS definitions and a spatial division are
provided.

VTS-geospatial and cartolina-js inherit the same reference frame model.
The
authoritative definitions live in the
[vts-registry](https://github.com/melowntech/vts-registry) repository
(`registry/registry/referenceframes.json`) and the concepts are
documented in the
[melowntech/workshop](https://github.com/melowntech/workshop)
`reference/concepts.rst`.


## What a reference frame defines

Every reference frame specifies four things:

| Component | Role |
|---|---|
| **Physical SRS** | Coordinate system of all mesh and geometry vertices |
| **Navigation SRS** | XY plane defines pan (tangential motion) and orbit (rotation around the perpendicular axis); Z component feeds navigation tiles and position altitude |
| **Public SRS** | Coordinate system exposed to the user: position readouts, altitude display, user-input interpretation |
| **Spatial division** | Hierarchical tile tree: global extents, per-node SRS, per-LOD tile extents, and subdivision rules |

The nature of the physical SRS determines the fundamental character of
the map. A **geocentric** physical SRS (e.g. ECEF/WGS84) yields a
globe — mesh vertices are XYZ Cartesian, and the tile tree wraps the
whole planet. A **projected** physical SRS (e.g. UTM or Web Mercator)
yields a flat 3D map. The algorithmic processing is identical in both
cases; only the coordinate interpretation differs.

A reference frame is not a single SRS. It is a policy that assembles
several SRSes, each serving a different purpose, into a coherent whole.

**One reference frame per map.** All data layers in a single map must
share the same reference frame. In cartolina-js terminology:

- **surfaces** — terrain meshes; the primary data type consumed from the
  tileserver
- **bound layers** — tiled imagery (satellite, aerial, thematic maps)
  draped over a surface; served as standard web map tiles (TMS)
- **free layers** — independently positioned 3D data that does not
  depend on the active surface; in practice this is almost always
  *geodata*: tiled three-dimensional vector data used for map lettering,
  administrative boundaries, and similar cartographic overlays

Mixing frames across any of these types is not possible without data
conversion.


## The melown2015 reference frame

`melown2015` is the reference frame used by all current cartolina
terrain sources. Its dominant practical advantage is that its
pseudomerc subtree is tile-compatible with Web Mercator: any WMTS or
TMS imagery service using the Google Maps / OSM quadtree can be used
directly as a bound layer without reprojection, and any MVT or
OpenMapTiles-based vector service can be consumed directly as a free
layer geodata source for lettering and cartographic overlays. Given the
volume of global web-mapping data available in that tiling scheme, this
compatibility is the main practical reason to use `melown2015`.

Web Mercator has non-uniform scale: tiles near the poles represent far
smaller areas than equally-sized tiles at the equator. The polar caps
require separate stereographic subtrees rather than a uniform tiling.
For applications where scale uniformity matters — planetary science,
polar cartography, or mapping any body other than Earth — a QSC-family
frame is a better fit. `melown2015` is the practical choice when web
tile compatibility is the priority, not when it is not.


### Model (three-SRS triplet)

```json
"model": {
    "physicalSrs":    "geocentric-wgs84",
    "navigationSrs":  "geographic-wgs84",
    "publicSrs":      "geographic-wgs84-egm96"
}
```

| SRS | Proj4 | Role |
|---|---|---|
| `geocentric-wgs84` | `+proj=geocent +datum=WGS84 +units=m` | ECEF Cartesian; mesh vertex space |
| `geographic-wgs84` | `+proj=longlat +datum=WGS84` | Lon/lat ellipsoidal; navigation and positioning |
| `geographic-wgs84-egm96` | `+proj=longlat +datum=WGS84 +geoidgrids=egm96_15.gtx` | Lon/lat with EGM96 orthometric height; user-facing altitude |

The EGM96 geoid grid (4 MB) cannot be served raw to a browser.
The `geoidGrid` sub-object in the SRS definition provides a compressed,
lower-precision substitute:

```json
"geographic-wgs84-egm96": {
    "type": "geographic",
    "srsDef": "+proj=longlat +datum=WGS84 +geoidgrids=egm96_15.gtx ...",
    "geoidGrid": {
        "definition": "geographic-wgs84-egm96-geoidgrid.jpg",
        "extents": { "ll": [-180.0, -90.0], "ur": [180.0, 90.0] },
        "srsDefEllps": "+proj=longlat +datum=WGS84 +no_defs",
        "valueRange": [-107.0, 85.4]
    }
}
```

The jpeg grid is georeferenced by `extents` (grid registration, not
pixel) and the value range tells the client how to decode it. Precision
is adequate for visual rendering; synthesis-side operations use the
full grid.


### Spatial division

The division section defines the 3D working volume and the tile tree.

```json
"division": {
    "extents": {
        "ll": [-7500000, -7500000, -7500000],
        "ur": [ 7500000,  7500000,  7500000]
    },
    "heightRange": [-12000.0, 9500.0],
    "nodes": [...]
}
```

`extents` is a 15,000 km cube centred on the WGS84 origin, expressed in
the physical (geocentric) SRS. The renderer uses it to set up the
working-space transform. `heightRange` bounds the terrain surface in the
navigation SRS Z axis (metres above the ellipsoid); the renderer uses it
to set the near/far plane and the ocean floor plane.


### Division nodes and polar caps

`melown2015` has four division nodes. A simpler geocentric frame with
only one node would cover just ±85° latitude (the Web Mercator belt)
and leave the polar caps undefined. The four-node design closes that
gap.

```
LOD 0, pos [0,0]  — eqc-wgs84     (equidistant cylindrical, root)
LOD 1, pos [0,0]  — pseudomerc    (Web Mercator; bulk of Earth)
LOD 1, pos [0,1]  — steren-wgs84  (UPS north; north polar cap)
LOD 1, pos [1,0]  — steres-wgs84  (UPS south; south polar cap)
```

The LOD 0 node spans the full eqc extent and acts as a routing switch:
its `partitioning` is a manual map rather than `"bisection"`, directing
the three LOD 1 subtrees into the correct projections.

```json
"partitioning": {
    "00": { "ll": [-20037508.3428, -9467848.3472],
            "ur": [ 20037508.3428,  9467848.3472] },
    "01": { "ll": [-20037508.3428,  9467848.34716118],
            "ur": [ 20037508.3428, 10018754.1714] },
    "10": { "ll": [-20037508.3428, -10018754.1714],
            "ur": [ 20037508.3428, -9467848.34716118] }
}
```

Child `"00"` is the Web Mercator belt (≈ ±85°). Children `"01"` and
`"10"` are the north and south polar strips respectively, each handed
off to a UPS stereographic subtree.

From LOD 1 onward each subtree uses `"bisection"` partitioning — every
tile halves into four children in its local projected SRS, producing the
same quadtree structure as Google Maps / OSM (for the pseudomerc
subtree).

The `externalTexture: true` flag on LOD 1 nodes signals that the tiles
in those subtrees have no internal texture coordinates; imagery is
draped from bound layers instead.


### Parameters and extensions

```json
"parameters": { "metaBinaryOrder": 5 }
```

`metaBinaryOrder` controls the metatile grouping size: a value of 5
means each metatile covers a 32×32 block of tiles (2^5 = 32). The
client and server must agree on this value.

```json
"extensions": {
    "wmts": {
        "content": "pseudomerc",
        "projection": "urn:ogc:def:crs:EPSG::3857",
        "wellKnownScaleSet": "urn:ogc:def:wkss:OGC:1.0:GoogleMapsCompatible"
    }
}
```

The `wmts` extension declares that the pseudomerc subtree aligns with
the standard WMTS GoogleMapsCompatible scale set. This allows external
WMTS imagery sources to be used directly as bound layers on the
pseudomerc subtree without any retiling.


### Body

```json
"body": "Earth"
```

The body reference connects the reference frame to a planetary body
record. The `Earth` body definition (also in `mapConfig.json`) carries:

- `class`: `"planet"`
- `srs`: references to the geographic and geocentric WGS84 SRSes
- `atmosphere`: default atmosphere parameters (colours, thickness,
  visibility) used when no `atmosphere` block is provided in the style
- `defaultGeoidGrid`: `"egm96_15.gtx"` — the full-resolution geoid for
  server-side synthesis operations
- `parent`: `"Sun"` — body hierarchy used for illumination geometry

The `Sun` body (`class: "star"`) is the root of the body tree.


## Other reference frames in the registry

The vts-registry (the VTS-geospatial registry) defines several
reference frames beyond `melown2015`.
Understanding them illustrates the range of what the system supports.


### The QSC family: earth-qsc and mars-qsc

The Quadrilateralized Spherical Cube (QSC) is a fundamentally different
approach to sphere tiling. Rather than combining projections for
different latitude bands, QSC maps the sphere onto the six faces of a
cube, each face using a dedicated gnomonic-derived QSC projection. The
cube unfolds into a 4×3 tile grid.

The six cube faces (for `earth-qsc`) are expressed as division nodes
at LOD 2:

```
col: 0     1       2      3
row 0:       top
row 1: left  front  right  back
row 2:       bottom
```

| Position [x,y] | Face | Centre |
|---|---|---|
| [0,1] | west  | lon 90°W, lat 0° |
| [1,0] | north | lat 90°N |
| [1,1] | front | lon 0°, lat 0° |
| [1,2] | south | lat 90°S |
| [2,1] | east  | lon 90°E, lat 0° |
| [3,1] | back  | lon 180°, lat 0° |

All six nodes start at LOD 2 with `bisection` partitioning. LODs 0 and
1 in the global tree are implicitly empty routing levels; no tile data
exists there.

Key properties of QSC division:

- **No singularities.** Every point on the sphere belongs to exactly one
  face. There are no poles and no anti-meridian degenerate tiles.

- **Near-uniform area.** QSC distortion is much more uniform than any
  cylindrical or conic projection, making it well suited to datasets
  that must cover the whole body without scale bias.

- **Consistent LOD meaning.** In `melown2015` the pseudomerc and polar
  subtrees occupy the same LOD numbers but represent very different
  absolute areas. In QSC every face covers one-sixth of the body and
  bisection subdivides each face uniformly.

- **No Web Mercator tile reuse.** The QSC grid does not align with the
  standard web mapping quadtree, so WMTS bound layers cannot be used
  without reprojection.

`mars-qsc` uses the same six-face layout with the D_MARS_2000
ellipsoid (equatorial radius ≈ 3,396,190 m) in place of WGS84, and a
`Mars` body with appropriate geocentric and geographic SRSes. There is
no geoid equivalent for Mars at this precision level, so the public SRS
is the bare geographic SRS without vertical datum correction.

`mars-qsc` is the clearest demonstration of extra-terrestrial
capability: everything except the body definition and SRS strings is
identical to `earth-qsc`. The renderer, tile pipeline, camera, and
navigation code are unchanged.


### Projected reference frames

The registry includes projected frames — frames where the physical SRS
is a flat projection rather than geocentric. `webmerc-projected` (flat
Web Mercator slab) and `webmerc-unprojected` (single-node geocentric
with only the Web Mercator belt) exist mainly as didactic examples in
the VTS-geospatial workshop documentation and have little practical
use. They are
largely unused in cartolina and may be dropped at some point.

The same observation applies to projected regional frames. Projected
frames are not ruled out by the system design, but the cartographic use
cases for cartolina are better served by geocentric frames.


### Authoring a custom reference frame

Any cartolina user can define a reference frame that is not in the
registry. The minimum viable reference frame is a geocentric model with
a single bisection node:

```json
{
    "version": 1,
    "id": "my-body",
    "body": "MyBody",
    "model": {
        "physicalSrs":   "geocentric-mybody",
        "navigationSrs": "geographic-mybody",
        "publicSrs":     "geographic-mybody"
    },
    "division": {
        "extents": { "ll": [...], "ur": [...] },
        "heightRange": [...],
        "nodes": [
            {
                "id": { "lod": 0, "position": [0, 0] },
                "srs": "some-projected-srs",
                "extents": { "ll": [...], "ur": [...] },
                "partitioning": "bisection"
            }
        ]
    },
    "parameters": { "metaBinaryOrder": 5 }
}
```

The `bisection` rule recursively halves each tile into four children in
the same projected SRS. Combined with a body definition and matching
SRS Proj4 strings, this is sufficient to map any body for which a
reasonable projected SRS exists.


## Reference frame in mapConfig.json

The tileserver assembles a complete `mapConfig.json` per surface
resource. Reference frame information is embedded verbatim, so the
client never needs to contact a separate registry.

The top-level structure relevant to reference frames:

```
mapConfig.json
├── referenceFrame    ← full RF definition (id, model, division, ...)
├── srses             ← Proj4 definitions for all SRS IDs used in the RF
├── bodies            ← body definitions (Earth, Sun)
├── services          ← optional service URLs (atmdensity, etc.)
├── surfaces          ← surface tile URL templates
└── credits           ← attribution records
```

The `srses` dictionary contains every SRS referenced by the RF model
and division nodes. The client never looks up SRS definitions from a
separate registry; everything arrives in a single JSON document.

This is important for the style-based loading path: each surface source
has its own `mapConfig.json`, and the entire RF + SRS dictionary is
re-read from that file. The second and subsequent surfaces are only
checked for RF id consistency.


## How cartolina-js retrieves and uses reference frames

### Style-path loading (modern, canonical)

Reference frame loading is driven by `MapStyle.loadStyle()` in
[style.ts](../../src/core/map/style.ts), called from
`Map.createMapFromStyle()` in
[map.js](../../src/core/map/map.js:113).

The sequence for each `cartolina-surface` source in the style:

1. **Fetch `mapConfig.json`** — the source URL is the surface base URL;
   `MapStyle.slapResource()` appends `mapConfig.json` to it.

2. **First surface only** — extract the map-wide metadata:
   - `srses` → one `MapSrs` instance per entry, added to `map.srses`
   - `bodies` → one `MapBody` instance per entry, added to `map.bodies`
   - `referenceFrame` → one `MapRefFrame` instance, stored as
     `map.referenceFrame`
   - `services` → stored as `map.services`
   - If the style spec includes an `atmosphere` block, and the body
     carries atmosphere defaults, and `services.atmdensity` is present,
     an `Atmosphere` instance is constructed here.

3. **Subsequent surfaces** — only `mc.referenceFrame.id` is checked:
   ```ts
   console.assert(mc.referenceFrame.id === map.referenceFrame.id);
   ```
   The RF from the first surface is authoritative; later surfaces must
   match or the assertion fires.

4. **Surface record** — the `surfaces` array in the mapConfig must
   contain exactly one entry. That entry is wrapped in a `MapSurface`
   and stored in `map.surfaces`.

The mapConfig path (`Map.createMapFromMapConfig`) follows the same RF
extraction steps via `MapConfig` constructor in
[config.js](../../src/core/map/config.js), but that path is deprecated
— new code should only use the style path.


### MapRefFrame construction

`MapRefFrame` ([refframe.js](../../src/core/map/refframe.js)) parses
the `referenceFrame` JSON object from the mapConfig:

```js
var MapRefFrame = function(map, json) {
    this.id   = json['id'];
    this.body = json['body'] ? map.getBody(json['body']) : null;

    var model = json['model'];
    this.model = {
        physicalSrs:    map.getMapsSrs(model['physicalSrs']),
        navigationSrs:  map.getMapsSrs(model['navigationSrs']),
        publicSrs:      map.getMapsSrs(model['publicSrs'])
    };

    var division = json['division'];
    this.division = {
        rootLod:     division['rootLod'] || 0,
        heightRange: division['heightRange'],
        extents:     this.parseSpaceExtents(division['extents'])
    };

    // sets map.spaceExtentSize and map.spaceExtentOffset
    map.spaceExtentSize   = [ur[0]-ll[0], ur[1]-ll[1], ur[2]-ll[2]];
    map.spaceExtentOffset = extents.ll;

    // build node map keyed by "lod.x.y"
    for (let node of division.nodes)
        this.nodesMap['lod.x.y'] = new MapDivisionNode(...);
};
```

Side effects on `map` at construction time:
- `map.spaceExtentSize` — 3D dimensions of the working volume
- `map.spaceExtentOffset` — lower-left corner of the working volume

`this.hasPoles` is set to `true` when the node list has exactly four
entries, which is the `melown2015`-specific test for polar-cap support.

Each division node becomes a `MapDivisionNode` instance keyed by
`"lod.x.y"` in `this.nodesMap` for O(1) lookup during tile traversal.


### SRS readiness

`map.srsReady` (checked every frame in `Core.onUpdate`) reflects
whether all three SRS projections are initialised:

```js
Map.prototype.isSrsReady = function() {
    return this.referenceFrame.model.physicalSrs.isReady()
        && this.referenceFrame.model.publicSrs.isReady()
        && this.referenceFrame.model.navigationSrs.isReady();
};
```

`MapSrs` objects load their Proj4 projection asynchronously. The
`'map-loaded'` event and the `ready` Promise are not resolved until
`srsReady` first returns `true`.


### Coordinate conversion

`MapRefFrame.convertCoords()` is the single entry point for converting
between the three named spaces:

```js
MapRefFrame.prototype.convertCoords = function(coords, source, dest) {
    // resolve source/destination to MapSrs instances
    // delegate to sourceSrs.convertCoordsTo(coords, destinationSrs)
};
```

Callers use the string tokens `'public'`, `'physical'`, and
`'navigation'` rather than SRS IDs directly. Internally this resolves
to `MapSrs.convertCoordsTo()`, which drives Proj4 for the actual
transformation.

`MapConvert` and `MapMeasure` (created in `createMapFromStyle` after
the RF is ready) build higher-level conversion helpers on top of this.
`map.isGeocent` is set to `!map.getNavigationSrs().isProjected()` and
governs camera and navigation behaviour throughout the engine.


## How cartolina-tileserver produces reference frame information

The tileserver loads reference frame definitions from a registry of
JSON files at startup. Each surface resource is registered against a
reference frame by ID:

```json
"referenceFrames": {
    "melown2015": {
        "lodRange": [1, 15],
        "tileRange": [[0, 0], [1, 1]]
    }
}
```

The tileserver uses the reference frame internally to organise the tile
storage path, determine metatile structure, and compute tile extents
during generation.

For the browser client, the tileserver exposes two endpoints per
surface:

**`tileset.conf`** — a lightweight properties file containing only the
RF ID string and tile range metadata. Sufficient for server-to-server
communication but not for browser clients.

**`mapConfig.json`** — the full map configuration document. Contains
the complete RF definition, the full `srses` dictionary for every SRS
referenced by the RF, body definitions, surface tile URL templates, and
credit records. This is what `MapStyle.loadStyle()` fetches.

Every surface served by cartolina-tileserver exposes its own
`mapConfig.json`. The cartolina-js style loading path fetches one per
source URL. Because the full RF definition is embedded, the client
needs no separate registry access.
