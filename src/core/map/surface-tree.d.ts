/*
 * surface-tree.d.ts - typed surface for the legacy `MapSurfaceTree`
 * helper (`surface-tree.js`).
 *
 * Phase-1 validation contract introduced by rfc-draw-traversal so the
 * typed recursive traversal and `Map.draw()` can drive the tree.
 * Removal target in phase 8 once the legacy tree is gone.
 */

import type LegacyMap from './map';
import type MapSurface from './surface';
import type MapSurfaceTile from './surface-tile';
import type { LegacyMetanode } from './surface-tile';

export default class MapSurfaceTree {

    constructor(
        map: LegacyMap,
        freeLayer: boolean,
        freeLayerSurface?: MapSurface,
    );

    map: LegacyMap;
    surfaceTree: MapSurfaceTile;
    surfaceSequence: [MapSurface, boolean][];
    surfaceOnlySequence: [MapSurface, boolean][];

    updateNodeHeightExtents(
        tile: MapSurfaceTile,
        node: LegacyMetanode,
    ): void;

    draw(stopOnFinish?: boolean): void;
}
