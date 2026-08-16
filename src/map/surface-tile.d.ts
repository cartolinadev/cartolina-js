import type MapResourceNode from './resource-node';
import type TerrainSource from './terrain-source';
import type MapFreeLayer from './free-layer';
import type MapMesh from './mesh';
import type MapTexture from './texture';
import type RasterSource from './raster-source';
import type Map from './legacy-map';
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

    /** The source this tile binds to: a terrain source for the
     * per-surface helper trees, a free layer for geodata trees. */
    surface: TerrainSource | MapFreeLayer;

    /** The terrain source that owns the mesh and texture resources.
     * Only the terrain draw path reads it. */
    resourceSurface: TerrainSource;

    /** Metanode selected for this tile address, or null until loaded. */
    metanode: MapMetanode | null;

    surfaceMesh: MapMesh;

    rasterTextures: { [key: string]: MapTexture };

    rasterSources: { [key: string]: RasterSource };

    /** Children in NW, NE, SW, SE quadrant order. */
    children: [MapSurfaceTile | null, MapSurfaceTile | null,
        MapSurfaceTile | null, MapSurfaceTile | null];

    /** Current screen-space texel error used by LOD traversal. */
    texelSize: number;

    /**
     * Finite, fit-comparable descent estimate for a geometry-less node,
     * used in place of the Infinity `texelSize` so descent stays
     * view-scale aware. Infinity for nodes that carry geometry or whose
     * physical span cannot be derived.
     */
    fallbackTexelSize: number;

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
     * @param cameraPos Camera position in map coordinates.
     * @param node Metanode whose culling data is tested.
     * @returns True when the tile should remain in traversal.
     */
    bboxVisible(
        id: [number, number, number],
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
