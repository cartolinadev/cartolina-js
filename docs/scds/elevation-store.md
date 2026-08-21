# Elevation store

## Context

In multiple contexts, cartolina needs to translate 2D geographic coordinates (navigation SRS coordinates in reference frame terminology) to 3D by filling in the missing third coordinate. Examples include:

i)      resolving floating map positions to their fixed counterparts
ii)     resolving 3D coordinates of waypoints
iii)    resolving 3D coordinates of vector features for the purpose of
        rasterization and rendering

Different techniques are used to address these needs: for i) and ii) cartolina-js currently uses navtiles—leading to documented issues for the latter, where a low-resolution navtile places the waypoint marker below terrain, iii) is now handled exclusively via a tileserver-side enrichment method dubbed heightcoding—an unwieldy costly process which is now one of the key performance bottlenecks in map configurations which use tiled OSM data.

In view of the library development, there are other use cases for elevation sampling:

- the library needs to support different types of terrain sources then cartolina-surface. It should support terrain encodings such as terrarium. For these to meaningfuly participate in the draw traversal, the library needs to infer information provided by metanodes - tile existence, watertightness, texel size, and crucially for us, height ranges.

- the current "geodata free layer" model will be completely retired, so that the library can support label and line sources using the openmaptiles schema and its derivatives. Not only that the features defined by these tiles lack three-dimensionality, they also do not carry metatile information - so their very selection also needs metanode inference.

For this reason we need a new, purely client-side, and unified approach to elevation sampling. We call it elevation store.


## Goals

- elevation store will provide a general mechanism for elevation sampling—adding the missing third coordinate (geodetic height) to reference frame (RF)'s nav system coordinates.

- the store will be produced based on available terrain data, as a side effect
of terrain rendering—more accurately, the available terrain data is basis both for rendering and the elevation store, thought only the former drives their fetching from the network

- consumers may state desired GSD for every heightcoding query, the store responds with the closest lowest or equal gsd (in this way, the consumer may deliberately call for spatially filtered—smoothed-data)

- because the store is temporal, consumers may use it to refresh existing values (to make them more acurate once the store has more accurate data). If the store holds data which better match the query, it refreshes them. If it does not, it leaves them alone

- consumers may batch heightcoding queries

- store maintenance will not introduce a noticable performance penalty on the library. Ideally, the penalty should be negligible and further diminishable by system configuration. Ideally, it should facilite performance improvements

- the store will manage it's CPU and GPU memory requirements and remove cold content to keep its footprint within bounds


## API shape

The consumer calls something like heightCode and passes on a Vec2, or an array of Vec2's, an optional desired gsd (defaults 0, meaning highest available resolution data). The call returns a set of Vec3's - and also information on the actual gsd used to heightcode (which might be different for each of the array members), that the client can store for future refresh.

There is also a refresh call, where the client basically passes the output of a previous call - including the used gsds, and the desired gsd again, and gets a fresh, updated heighcoding output.

The two can be the same call for simplicity (no set of known gsd supplied if the third coordinate is missing), that's a technical design decision.

Whether the hightcoding API is synchronous or asynchronous is also left to the technical design. Synchronous might be more practical for use cases such as waypoint resolution. However, since refresh calls might be needed for many heightcoding queries, an asynchronous design might provide performance benefits at little added consumer complexity.

Another API the store provides is the minmax API. In this case, the query is not for a location, but for a tile id - the elevation store returns minimum and maxium elevation values for a tile. The minmax API should be ideally near synchronous, because it's important that the tree descent happens fast.

From the standpoint of the API (and the store itself) it's irrelevant what the origin of the elevation information was (which terrain source provided the data). From the standpoint of the map there is only one terrain, various sources represent the same thing, at different locations and resolution.

The first version of the implementation can (and probvably should) skip the minmax functionality, we will add it once we are happy with the elevation queries.

The store exists as an object owned by Map.


## Internal representation

On a logical level, the elevation store is basically a set of per-lod georeferenced bitmaps for each RF leafs, with masks. The bitmaps are in the corresponding RF-leaf's spatial division srs. The resolution of the bitmap is dictated by the lod, size of one pixel (gsd) follows the same logic as the gsd as used on the tileserver, it's a 1/256 of a tile size (a constant, not necessarily configurable).

It's natural for different store LODs to cover differtent geographic areas: typically, the lower LODS will have broader coverage, which corresponds to the way map generally behaves.

Up to three versions of the bitmap exists: the elevation map used for elevation queries, and the minimum and maxiumum maps used for minmax queries. Because the minmax queries need to be processed fast and, ideally, synchronously, it provbably makes sense to store the tile id (node) minmax values in a specialized derived CPU structure.

The logical representation provides a natural lookup structure for heightcoding queries: a ceiling for a gsd is taken, a corresponding lod is selected, and a sample, or a set of a samples, is taken from the corresponding bitmap at a corresponding pixel location.

For a minmax query, the processing is analogical, but ths time the query identifies the specific node id that is being queried.

On a physical level, the bitmaps need to strike the balance between data origin (rendering of individual tiles) and logical structure (a single bitmap). The single logical bitmap probably need to be broken down into contagious blocks, because it's possible (though not typical) that current coverage for a single lod is sparse - just doing a bounding box for these tiles could potentially include vast empty areas, putting unnecessary constraints on memory consumption. The detail are left to technical design.

The unit bitmaps and masks exist as GPU textures. These textures are populated by specialized tile shaders - more on that below.


## Lifecycle

The store is populated synchronously in a dedicated run of draw-traversal, analogously to the way hitmaps are produced today. It needs specialized shaders that are more complex than depth shaders, because the bitmaps are written in RF node's srs. This is analogous to the way tile footprints are rasterized - mesh external UVs are used for rasterization. Tile rendering operates on a specific square subregion of one of the elevation store's bitmaps for the given LOD. Same goes for the mask.

Current draw traversal is controlled by fallback cadence. Elevation store needs to supply elevation infromation even for lods which are not subject to rendering, for this reason, we need to recreate missing heightfield information by averaging from lower lods in a separate pass - this may be skipped for a cadence of 1. Also, the mising infomration sohould be filled only in places where it's missing.

Elevation store update is carried out at configurable intervals, simmilarly to hit maps (one second would be a good starting setting).

By definition, elevation store is temporal structure - once a coverage section for a given lod "cools off", it can be evicted from the store. Two possible criterions for cooling: recent queries (cleaner), recent rasterization update (possibly easier). Both work, choice is left to tehcnical design. One challenge is that bitmap units of the store include multiple tiles, specific values may result from downsampling averaging, etc. eviction might include resizing, etc. The design should be as clean and simple as possible. Conversely, rasterization in previously uncovered areas expands coverage.

Because any elevation query should produce at least a coarse result (unless coverage is completely missing), elevation store values at reference frame node's root never expire.

The existing GPU cache might not be a good way to implement the store's lifecycle, so it might need a completely independent memory management, though that decision is left to technical design.


## Constraints and other design considerations

- premature optimization is root of all evil (Knuth) - its better to have a non-optimized, working prototype first then an optimized and functionally disappointing implementation.

- performance is key—this need to be a springboard for its enhacement, not deterioration

- usual design principles and project north star apply


# Proof of concept and validation

At stage 1, two code changes will be used for PoC and validation:

- the waypoint API will use the elevation store to resolve 2D waypoints to 3D, adressing a well-documented invisible waypoint problem. In this case, the query GSD is 0.

- with a new config option set, geodata free layers will reproject the 3D cordinates to 2D and heightcode them using the elevation store, accumulating differences for a summary report (stdev and percentiles). In this case, the query GSD corresponds to the tile size divided by its pixelSize - and it needs to be refreshed until we get a sufficiently accurate reading.

At stage 2

- float positions will be resolved to fixed using elevation store rather than navtiles (with gsd corresponding to desired smoothing if applicable)
- pan motion will be carried out using the elevation store rather than navtiles (with gsd corresponding to desired smoothing)

