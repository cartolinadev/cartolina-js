import type MapResourceNode from './resource-node';
import type MapSurface from './surface';
import type MapMesh from './mesh';
import type MapTexture from './texture';
import type MapBoundLayer from './bound-layer';
import type Map from './map';

/*
 * `LegacyMetatile` and `LegacyMetanode` are phase-1 validation
 * contracts for the recursive terrain traversal. Removal target in
 * phase 8 alongside the legacy tile tree.
 */
export type LegacyMetatile = {
    drawCounter: number;
    useVersion: number;
};

export type LegacyMetanode = {
    metatile: LegacyMetatile;
    bbox: unknown;
    bbox2: number[];
    pixelSize: number;
    watertight: boolean;
    hasChild(index: number): boolean;
    hasChildren(): boolean;
    hasGeometry(): boolean;
};

/**
 * A node in the terrain tile tree.
 *
 * The runtime implementation is in `surface-tile.js`. This declaration
 * covers the properties accessed by TypeScript modules. The fields
 * tagged "phase-1" below are reads from the recursive terrain
 * traversal and disappear with the legacy tree in phase 8.
 */
export class MapSurfaceTile {

    /** Tile address: [lod, x, y]. */
    id: [number, number, number];

    parent: MapSurfaceTile | null;

    map: Map;

    resources: MapResourceNode;

    /** The surface that owns the mesh and texture resources. */
    resourceSurface: MapSurface;

    /** phase-1: metanode selected by the legacy lookup. */
    metanode: LegacyMetanode | null;

    surfaceMesh: MapMesh;

    splitMask: [number, number, number, number] | null;

    boundTextures: { [key: string]: MapTexture };

    boundLayers: { [key: string]: MapBoundLayer };

    /** phase-1: child tiles in quadrant order. */
    children: [MapSurfaceTile | null, MapSurfaceTile | null,
        MapSurfaceTile | null, MapSurfaceTile | null];

    /** phase-1 */
    texelSize: number;
    /** phase-1 */
    distance: number;
    /** phase-1 */
    drawCounter: number;

    kill(): void;

    /** phase-1 */
    isMetanodeReady(tree: unknown, priority: number): boolean;
    /** phase-1 */
    bboxVisible(
        id: [number, number, number],
        bbox: unknown,
        cameraPos: [number, number, number],
        node: LegacyMetanode,
    ): boolean;
    /** phase-1 */
    updateTexelSize(): void;
}

export default MapSurfaceTile;
