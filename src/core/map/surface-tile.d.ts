import type MapResourceNode from './resource-node';
import type MapSurface from './surface';
import type MapMesh from './mesh';
import type MapTexture from './texture';
import type MapBoundLayer from './bound-layer';
import type Map from './map';

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

    surfaceMesh: MapMesh;

    splitMask: [number, number, number, number] | null;

    boundTextures: { [key: string]: MapTexture };

    boundLayers: { [key: string]: MapBoundLayer };

    kill(): void;
}

export default MapSurfaceTile;
