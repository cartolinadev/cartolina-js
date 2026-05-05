# Virtual surfaces

See `index.md` for the wiki table of contents.

The word "virtual" appears in two distinct, unrelated contexts inside
the surface-rendering code. Both are explained here. The first requires
understanding how the renderer normally selects a data source for each
tile, so that section comes first.


## Background: surfaces, glues, and per-tile source selection

A **surface** is a terrain dataset with a defined tile range and LOD
range. When a view activates more than one surface, their tile ranges
often overlap. VTS handled overlap by precomputing **glues** — special
composite datasets that cover exactly the seam area between two or more
surfaces and carry the stitched geometry for it. Glues are identified
by the sorted set of surface IDs they stitch. In `mapConfig.json` the
glue `id` field is a JSON array (e.g. `["terrain-czech", "viewfinder"]`);
internally in cartolina-js the same set is joined with semicolons to
form a dictionary key (e.g. `"terrain-czech;viewfinder"`).

All surfaces and glues active in the current view are assembled into an
ordered list called `tree.surfaceSequence` (populated by
`generateSurfaceSequence` in `surface-sequence.ts`). Each entry is a
pair `[surface_or_glue, isAlien]` (see
[glue-alien-flag.md](glue-alien-flag.md) for what `isAlien` means).

When the renderer needs to draw a tile at address `[lod, x, y]`, it
must decide which entry in that list owns the tile. `checkSurface`
(`surface-tile.js:378`) walks the sequence and calls `hasTile2(id)` on
each entry to collect all that cover this address. Results go into
`tile.virtualSurfaces` — a temporary working list, not a persistent
concept. Then:

- **One match**: `tile.surface` is set to that entry. Normal path.
- **More than one match**: the tile sits at a seam. See the next
  section.


## The per-tile `virtual` flag: client-side seam stitching

When `tile.virtualSurfaces` has more than one entry, the tile straddles
a boundary between surfaces. The renderer cannot commit to a single
data source until it knows which one actually has geometry at this
address:

```js
// surface-tile.js:442
if (this.virtualSurfaces.length > 1) {
    this.virtual = true;
```

A tile with `virtual === true` enters `createVirtualMetanode`
(`surface-tile.js:520`), which waits for the metatile from every
overlapping entry to load, then:

1. Picks the first entry that has geometry as the primary source and
   sets `tile.surface` to that entry.
2. Merges the child-presence flags from all entries so the quadtree
   expands correctly at the seam.

The result is a single synthetic metanode built at runtime. The tile
then proceeds through the normal rendering path.

This is a purely client-side, per-frame operation. It fires at any tile
address covered by more than one entry in the current surface sequence.


## `mapConfig.json` `virtualSurfaces`: a precomputed alternative

The per-tile stitching above is expensive: the client must load
metatiles from every overlapping surface and glue, synthesize a merged
view, and repeat this at every LOD at every seam. VTS provided a
server-side optimisation that moves this work offline.

A `virtualSurfaces` entry in `mapConfig.json` declares a
server-precomputed composite that covers a specific set of surfaces.
After it is parsed, the object is represented by an instance of the
`MapVirtualSurface` class (`virtual-surface.js`).

A typical entry:

```json
{
  "id": ["terrain-czech", "viewfinder", "viewfinder1"],
  "lodRange": [4, 21],
  "tileRange": [[0, 0], [13, 13]],
  "metaUrl": ".../{lod}-{x}-{y}.meta",
  "mapping": ".../tileset.map"
}
```

| Field | Meaning |
|---|---|
| `id` | Ordered list of surface IDs that this composite covers. |
| `lodRange` | LOD interval over which the composite applies. |
| `tileRange` | Tile extent at the minimum LOD. |
| `metaUrl` | Template URL for the precomputed metatiles. |
| `mapping` | URL of the binary tile-mapping file. |

Note that the individual surfaces named in `id` still appear separately
in `mapConfig.surfaces` and their glues in `mapConfig.glue`. The
virtualSurface does not replace those declarations; it coexists with
them. The mapy.com `mapConfig.json` illustrates this: it lists 7
surfaces, 26 glues, and 2 virtual surfaces all at once.


### The tile-mapping file

The server builds the virtual surface by aggregating the constituent
tilesets (and their glues) into a single "aggregated driver". It records
the list of constituent drivers in the order they were added:

```
slot 0 → surface "viewfinder"         (1 tileset reference)
slot 1 → surface "viewfinder1"        (1 tileset reference)
slot 2 → surface "terrain-czech"      (1 tileset reference)
slot 3 → glue "terrain-czech;viewfinder"  (2 tileset references)
slot 4 → glue "terrain-czech;viewfinder1" (2 tileset references)
...
```

This ordering is serialised into the binary tile-mapping file
(`tileset.map`). The format:

```
2 bytes:  magic 'T', 'M'
2 bytes:  number of slots (uint16, little-endian)
per slot:
  1 byte: number of tileset references (n)
  n × 2 bytes: tileset references (uint16, little-endian)
               each is an index into the virtual surface's id[] array
```

A slot with one reference identifies a surface (look up `id[ref]`).
A slot with multiple references identifies a glue (look up each
`id[ref]`, join them to form the glue key).

`parseMappingFile` (`virtual-surface.js:66`) decodes this and fills
`MapVirtualSurface.surfaces[]` — an array of the resolved `MapSurface`
or glue objects, one per slot, in slot order. The resolution calls
`map.getSurface(id)` and `map.getGlue(id)`, which is why the
constituent surfaces and glues must exist in `map.surfaces` /
`map.glues` (loaded earlier from `mapConfig.surfaces` and
`mapConfig.glue`).

When the server writes metatile data for the virtual surface, each
MetaNode carries a `sourceReference` field — a 1-based slot index from
the table above. It encodes "this tile's geometry and resources come
from slot N". The client uses this directly:

```js
// surface-tile.js:338
if (this.surface.virtual) {
    this.resourceSurface =
        this.surface.getSurface(this.metanode.sourceReference);
}
```

`MapVirtualSurface.getSurface(index)` returns `this.surfaces[index - 1]`
— the surface or glue at that slot — which then provides the mesh and
texture URLs for resource fetching.

Concretely: the server ran the seam-stitching logic offline, wrote the
winning source into each metatile's `sourceReference` field, and
published the slot-to-surface mapping in `tileset.map`. The client reads
back the answer instead of computing it.


### How `map.virtualSurfaces` is populated

`config.js parseVirtualSurfaces` (`config.js:145`) runs once during map
load. It creates one `MapVirtualSurface` instance per entry in
`mapConfig['virtualSurfaces']` and stores them in a dictionary keyed by
the sorted, semicolon-joined surface IDs:

```js
// virtual-surface.js:32
var tmp = this.id.slice();
tmp.sort();
this.strId = tmp.join(';');

// config.js:159
this.map.virtualSurfaces[surface.strId] = surface;
```

So `map.virtualSurfaces["terrain-czech;viewfinder;viewfinder1"]` would
hold the `MapVirtualSurface` instance for that three-surface composite.


### When the composite activates

`generateSurfaceSequence` (`surface-sequence.ts:29`) first collects the
IDs of all surfaces that the current view lists as active. It sorts
them, joins them with semicolons, and looks up the result:

```ts
// surface-sequence.ts:46
surface = this.map.virtualSurfaces[strId_];
if (surface) {
    list = [ [[(surface.index + 1)], surface, true, false] ];
    vsurfaceCount = 1;
}
```

If the lookup succeeds — meaning the exact set of surfaces active in
the view matches a declared composite — the entire surface+glue list is
replaced by a single entry pointing to the `MapVirtualSurface`. Because
`vsurfaceCount` drops to 1, no glue assembly happens. `checkSurface`
then finds exactly one candidate for every tile address, so the per-tile
`virtual` flag is never set.

If the lookup fails (no matching composite, or the feature flag
`config.mapVirtualSurfaces` is `false`), the view falls through to the
normal surface+glue sequence assembly and the per-tile stitching
described in the first section runs as usual.


## The two concepts compared

| | Per-tile `virtual` flag | `mapConfig.json` `virtualSurfaces` |
|---|---|---|
| What it is | Transient tile state | A `MapVirtualSurface` instance |
| Set by | Client at runtime, in `checkSurface` | Map load, from `mapConfig` |
| Trigger condition | ≥ 2 entries in surface sequence cover the tile address | View's active surface IDs match a declared composite |
| Seam stitching done by | Client (`createVirtualMetanode`) | Server (mapping file + unified metaURL) |
| Active in cartolina | Yes | No — not produced by cartolina-tileserver |


## Obsolescence note

`mapConfig.json` `virtualSurfaces` is a VTS-geospatial era feature,
intended for deployments where the server manages large storage with
many surfaces and pre-bakes the composites. The only known live user is
an older mapy.com deployment running the upstream vts-browser-js.
Cartolina-tileserver does not produce this field; cartolina-js parses
and executes it correctly but it is never activated in practice.

The feature flag is `mapVirtualSurfaces` (default `true`). Setting it
to `false` skips `parseVirtualSurfaces` entirely. The guard is in
[config.js:149](../../src/core/map/config.js#L149).
