import type MapMetatile from './metatile';

/**
 * Per-tile metadata used for traversal, culling, and resource selection.
 */
export default class MapMetanode {

    metatile: MapMetatile;

    /** Axis-aligned height bbox used by pre-v4 metatile formats. */
    bbox: unknown;

    /** Culling point set used by v4+ metatiles and precise tests. */
    bbox2: number[];

    /** Source texel size used to estimate screen-space tile error. */
    pixelSize: number;

    /** True when the tile mesh covers the whole tile cell. */
    watertight: boolean;

    hasChild(index: number): boolean;
    hasChildren(): boolean;
    hasGeometry(): boolean;
}
