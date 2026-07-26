/*
 * surface-tree.d.ts - typed surface for the legacy `MapSurfaceTree`
 * helper (`surface-tree.js`).
 *
 * The remaining users are per-surface helper trees for recursive
 * terrain queries and free-layer trees for geodata job collection.
 */

import type LegacyMap from './legacy-map';
import type MapSurface from './surface';
import type MapSurfaceTile from './surface-tile';
import type MapMetanode from './metanode';

export default class MapSurfaceTree {

    constructor(
        map: LegacyMap,
        freeLayer: boolean,
        freeLayerSurface?: MapSurface,
    );

    map: LegacyMap;
    surfaceTree: MapSurfaceTile;

    /**
     * The single surface every tile in this tree binds to. Set for the
     * per-surface helper trees of the recursive draw traversal and for
     * free layers.
     */
    freeLayerSurface: MapSurface | null;

    updateNodeHeightExtents(
        tile: MapSurfaceTile,
        node: MapMetanode,
    ): void;

    draw(stopOnFinish?: boolean): void;
}
