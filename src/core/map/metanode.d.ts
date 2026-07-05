import type MapMetatile from './metatile';

/**
 * Per-tile metadata used for traversal, culling, and resource selection.
 */
export default class MapMetanode {

    metatile: MapMetatile;

    /** Tile address: [lod, x, y]. */
    id: [number, number, number];

    /** Spatial division node (reference frame subtree root) governing
     *  this tile; the runtime object is the untyped MapDivisionNode. */
    divisionNode: unknown;

    /** Lazily computed mask (bit per quadrant) of children lying
     *  completely outside the reference frame's valid (partitioned)
     *  area; see pre-v6-watertight.ts. */
    preV6InvalidChildMask?: number;

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
