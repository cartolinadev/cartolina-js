import type MapDivisionNode from './division-node';

/**
 * Parsed reference frame: the model SRSs, the celestial body, and the
 * spatial division nodes the tile hierarchy hangs from.
 *
 * Declared here for the TypeScript consumers of the node and tile
 * lookups; the implementation stays in `refframe.js`.
 */
export class MapRefFrame {

    constructor(map: unknown, json: unknown);

    /** Reference-frame id from the style, or null when it declares none. */
    id: string | null;

    valid: boolean;

    /** Height range declared for the whole reference frame. */
    getGlobalHeightRange(): [number, number];

    /** Every spatial division node, in the order the style declares them. */
    getSpatialDivisionNodes(): MapDivisionNode[];

    /** Deepest spatial division node containing a tile id. */
    getSpatialDivisionNodeForTile(
        tileId: readonly number[],
    ): MapDivisionNode | null;

    /** Nominal side of one sample at a node tile LOD. */
    getNodeGsd(
        node: MapDivisionNode,
        lod: number,
        sampleCount: number,
    ): number;

    /**
     * Resolves a navigation-SRS position to the spatial division nodes
     * that own it, finest first. Node extents overlap; the partitioning
     * ranges they inherit do not, and bound the result.
     *
     * @returns owners by descending node LOD; empty outside every node
     */
    resolveSpatialDivisionNodes(
        coords: readonly number[],
    ): MapRefFrame.NodeOwner[];

    /**
     * Locates a position inside the tile grid of one node.
     *
     * @param coords position in that node's own SRS
     * @param lod tile LOD, at or below the node's own LOD
     * @param uv receives the position within the tile, u east, v south
     * @returns the tile id containing the position
     */
    getNodeTileAt(
        node: MapDivisionNode,
        coords: readonly number[],
        lod: number,
        uv: number[],
    ): [number, number, number];

    convertCoords(
        coords: number[],
        source: 'public' | 'physical' | 'navigation',
        destination: 'public' | 'physical' | 'navigation',
    ): number[];
}

export namespace MapRefFrame {

    /** One node owning a position, with the position in its own SRS. */
    export type NodeOwner = {
        node: MapDivisionNode;
        coords: number[];
    };
}

export default MapRefFrame;
