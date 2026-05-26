import type MapResourceNode from './resource-node';
import type MapSurface from './surface';
import type MapMesh from './mesh';
import type MapTexture from './texture';
import type MapBoundLayer from './bound-layer';
import type Map from './map';

export type LegacyMetatile = {
    drawCounter: number;
    useVersion: number;
};

export type LegacyMetanode = {
    metatile: LegacyMetatile;
    bbox: unknown;
    bbox2: number[];
    pixelSize: number;
    hasChild(index: number): boolean;
    hasChildren(): boolean;
    hasGeometry(): boolean;
};

/**
 * A node in the terrain tile tree.
 *
 * The runtime implementation is in `surface-tile.js`. This declaration
 * covers the properties accessed by TypeScript modules.
 */
export class MapSurfaceTile {

    /** Tile address: [lod, x, y]. */
    id: [number, number, number];

    parent: MapSurfaceTile | null;

    map: Map;

    resources: MapResourceNode;

    /** The surface that owns the mesh and texture resources. */
    resourceSurface: MapSurface;

    /** Surface selected by the legacy metanode lookup. */
    surface: MapSurface | null;

    metanode: LegacyMetanode | null;

    surfaceMesh: MapMesh;

    splitMask: [number, number, number, number] | null;

    boundTextures: { [key: string]: MapTexture };

    boundLayers: { [key: string]: MapBoundLayer };

    children: [MapSurfaceTile | null, MapSurfaceTile | null,
        MapSurfaceTile | null, MapSurfaceTile | null];

    texelSize: number;
    distance: number;
    drawCounter: number;

    kill(): void;
    isMetanodeReady(tree: unknown, priority: number): boolean;
    bboxVisible(
        id: [number, number, number],
        bbox: unknown,
        cameraPos: [number, number, number],
        node: LegacyMetanode,
    ): boolean;
    updateTexelSize(): void;
}

export default MapSurfaceTile;
