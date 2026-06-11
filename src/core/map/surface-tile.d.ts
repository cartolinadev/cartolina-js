import type MapResourceNode from './resource-node';
import type MapSurface from './surface';
import type MapMesh from './mesh';
import type MapTexture from './texture';
import type MapBoundLayer from './bound-layer';
import type Map from './map';
import type MapSurfaceTree from './surface-tree';
import type MapMetanode from './metanode';

/**
 * Surface-tree node carrying metanode, resource, and LOD state for one
 * terrain tile address.
 */
export class MapSurfaceTile {

    /** Tile address: [lod, x, y]. */
    id: [number, number, number];

    parent: MapSurfaceTile | null;

    map: Map;

    resources: MapResourceNode;

    /** The surface that owns the mesh and texture resources. */
    resourceSurface: MapSurface;

    /** Metanode selected for this tile address, or null until loaded. */
    metanode: MapMetanode | null;

    surfaceMesh: MapMesh;

    boundTextures: { [key: string]: MapTexture };

    boundLayers: { [key: string]: MapBoundLayer };

    /** Children in NW, NE, SW, SE quadrant order. */
    children: [MapSurfaceTile | null, MapSurfaceTile | null,
        MapSurfaceTile | null, MapSurfaceTile | null];

    /** Current screen-space texel error used by LOD traversal. */
    texelSize: number;

    /** Camera-to-tile distance used for resource priority. */
    distance: number;

    /** Last draw traversal generation in which this tile rendered. */
    drawCounter: number;

    kill(): void;

    /**
     * Ensures that this tile has a usable metanode for `tree`.
     *
     * @param tree Surface tree that supplies the tile surface.
     * @param priority Loader priority, normally the tile LOD.
     * @param preventLoad When true, only already-loaded data may pass.
     * @returns True when `metanode` is available and height state is valid.
     */
    isMetanodeReady(
        tree: MapSurfaceTree,
        priority: number,
        preventLoad?: boolean,
    ): boolean;

    /**
     * Tests whether this tile's metanode volume intersects the camera
     * frustum, including the geocentric horizon test when enabled.
     *
     * @param id Tile address used for depth and culling thresholds.
     * @param bbox Axis-aligned bbox used by pre-v4 metatile formats.
     * @param cameraPos Camera position in map coordinates.
     * @param node Metanode whose culling data is tested.
     * @returns True when the tile should remain in traversal.
     */
    bboxVisible(
        id: [number, number, number],
        bbox: unknown,
        cameraPos: [number, number, number],
        node: MapMetanode,
    ): boolean;

    /**
     * Updates `texelSize` and `distance` from the current camera and
     * metanode state.
     */
    updateTexelSize(): void;
}

export default MapSurfaceTile;
