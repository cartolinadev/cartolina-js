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

    /**
     * Plain (non-glue, non-virtual) surfaces visible in the current
     * view, sorted alphabetically by id. Front surface at the last
     * index, matching `surfaceSequence` ordering. Written by
     * `surface-sequence.ts`; read by the new draw traversal.
     */
    plainSurfaceList: MapSurface[];

    /**
     * True when the surface sequence generator found a matching
     * `mapConfig.virtualSurfaces` entry. The legacy path collapses
     * `surfaceSequence` to a single `MapVirtualSurface`; the new
     * traversal keeps `plainSurfaceList` populated and emits a
     * one-off warning when this flag is set.
     */
    hasVirtualSurfaces: boolean;

    /**
     * If set, every tile in this tree auto-selects this single
     * surface. Used by free layers and by the new draw traversal's
     * per-surface helper trees.
     */
    freeLayerSurface: MapSurface | null;

    updateNodeHeightExtents(
        tile: MapSurfaceTile,
        node: LegacyMetanode,
    ): void;

    draw(stopOnFinish?: boolean): void;
}
