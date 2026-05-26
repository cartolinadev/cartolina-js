import type LegacyMap from './map';
import type MapSurface from './surface';
import type MapSurfaceTile from './surface-tile';
import type DrawTraversalMaskPool from './draw-traversal-mask';
import type { LegacyMetanode } from './surface-tile';

/**
 * Type surface for the legacy `MapSurfaceTree` helper
 * (`surface-tree.js`).
 */
export default class MapSurfaceTree {

    constructor(
        map: LegacyMap,
        freeLayer: boolean,
        freeLayerSurface?: MapSurface,
    );

    map: LegacyMap;
    freeLayer: boolean;
    freeLayerSurface?: MapSurface;
    surfaceTree: MapSurfaceTile;
    terrainMaskPool: DrawTraversalMaskPool | null;
    surfaceSequence: [MapSurface, boolean][];
    surfaceOnlySequence: [MapSurface, boolean][];

    updateNodeHeightExtents(
        tile: MapSurfaceTile,
        node: LegacyMetanode,
    ): void;

    drawSurface(shift: [number, number, number]): void;
    drawSurfaceFit(shift: [number, number, number]): void;
    draw(stopOnFinish?: boolean): void;
}
