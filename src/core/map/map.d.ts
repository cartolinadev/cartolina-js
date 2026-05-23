import type Atmosphere from './atmosphere';
import type MapBody from './body';
import type MapBoundLayer from './bound-layer';
import type MapCredit from './credit';
import type MapCamera from './camera';
import type MapPosition from './position';
import type MapRefFrame from './refframe';
import type MapSrs from './srs';
import type MapStyle from './style';
import type MapSurface from './surface';
import type MapUrl from './url';
import type FreezeCameraState from './freeze-camera-state';
import type Renderer from '../renderer/renderer';
import type { CoreConfig, NodeInformation } from '../types';

type MapReferenceFrame = (MapRefFrame & {
    id: string;
    body?: MapBody & {
        atmosphere?: Partial<Atmosphere.Specification>;
    };
    division?: {
        rootLod?: unknown;
        arity?: unknown;
        heightRange?: unknown;
        extents?: {
            ll: [number, number, number];
            ur: [number, number, number];
        };
    };
}) | null;

type MapServices = {
    atmdensity?: {
        url: string;
    };
} & Record<string, unknown>;

type FreeLayer = MapSurface & {
    geodata?: unknown;
    surfaceSequence: MapSurface[];
    surfaceOnlySequence: MapSurface[];
    options: Record<string, unknown>;
    setStyle(style: unknown): void;
};

type SurfaceSequenceItem = [MapSurface, boolean];

/**
 * Legacy terrain engine object.
 *
 * The runtime implementation is in `map.js`. This declaration covers the
 * subset used by current TypeScript modules and should grow incrementally
 * as refactoring work touches more of the legacy surface.
 */
export default class Map {

    renderer: Renderer;
    url: MapUrl;
    config: CoreConfig;

    position: MapPosition;
    camera: MapCamera;
    atmosphere: Atmosphere | null;
    referenceFrame: MapReferenceFrame;
    services: MapServices;

    srses: Record<string, MapSrs>;
    bodies: Record<string, MapBody>;
    credits: Record<string, MapCredit>;
    surfaces: MapSurface[];
    virtualSurfaces: Record<string, unknown>;
    glues: Record<string, unknown>;
    freeLayers: Record<string, FreeLayer | null>;
    boundLayers: Record<string, MapBoundLayer | null>;
    stylesheets: Record<string, unknown>;

    initialView: unknown;
    currentView_: unknown;
    freeLayerSequence: FreeLayer[];
    freeLayersHaveGeodata: boolean;

    /** Credit name → weight accumulated this frame; reset each draw pass. */
    visibleCredits: {
        imagery: Record<string, number>;
        glueImagery: Record<string, number>;
        mapdata: Record<string, number>;
    };

    style: MapStyle | null;

    tree: {
        surfaceSequence: SurfaceSequenceItem[];
        surfaceOnlySequence: SurfaceSequenceItem[];
    };

    freeze: FreezeCameraState;

    draw: {
        drawChannel: number;
    };

    measure: {
        getNodeInformation(
            id: [number, number, number],
            height?: number,
        ): NodeInformation | null;
    };

    setConfigParam(key: string, value: unknown): void;

    setPosition(position: MapPosition | number[]): void;
    getPosition(): MapPosition;
    getNavigationPosition(): MapPosition;
    getSelectionPosition(): MapPosition;
    markDirty(): void;

    /**
     * Called before tile descent begins.
     *
     * If freeze mode is active, installs the frozen selection camera
     * so that culling and texel-size tile selection use the snapshot
     * position rather than the live navigation position.
     */
    beforeTileSelection(): void;

    /**
     * Called before the selected tile buffer is drawn to the screen.
     *
     * If freeze mode is active, switches to the live camera for final
     * rendering and returns the live camera position. Otherwise
     * returns `cameraPos` unchanged.
     *
     * @param cameraPos Camera position from the tile traversal.
     * @returns Camera position to use for tile rendering.
     */
    beforeSelectedTileDraw(cameraPos: [number, number, number]):
        [number, number, number];

    /**
     * Called after the selected tile buffer has been drawn.
     *
     * If freeze mode is active, restores the frozen selection camera
     * so that subsequent passes in the same frame see the selection
     * context.
     */
    afterSelectedTileDraw(): void;

    /**
     * Called at the end of a complete frame draw pass.
     *
     * If freeze mode is active, restores the live camera so that
     * navigation and UI updates for the next frame see the current
     * position.
     */
    afterFrameDraw(): void;

    /**
     * Runs `callback` with the live navigation camera installed.
     *
     * When freeze mode is active, the selection camera is normally in
     * place during the draw loop. Call this for code that must see
     * the live position even then, e.g. the freeze-frustum overlay.
     *
     * @param callback Code to run under the live camera.
     * @returns The value returned by `callback`.
     */
    withNavigationCamera<T>(callback: () => T): T;

    /**
     * Runs `callback` with the frozen selection camera installed.
     *
     * Use for code that must operate in the selection camera's
     * coordinate space, e.g. depth sampling at the selection
     * position. When freeze mode is inactive, runs `callback`
     * without any swap.
     *
     * @param callback Code to run under the selection camera.
     * @returns The value returned by `callback`.
     */
    withSelectionCamera<T>(callback: () => T): T;

    addSrs(id: string, srs: MapSrs): void;
    addBody(id: string, body: MapBody): void;
    addCredit(id: string, credit: MapCredit): void;
    addSurface(id: string, surface: MapSurface): void;
    addBoundLayer(id: string, layer: MapBoundLayer): void;
    addFreeLayer(id: string, layer: MapSurface): void;
    removeFreeLayer(id: string): void;

    /**
     * Creates a geodata builder for constructing vector overlays.
     * The return type is `unknown` pending a TypeScript declaration for
     * the geodata builder surface.
     */
    createGeodata(): unknown;

    getFreeLayer(id: string): FreeLayer | undefined;
    getBoundLayerById(id: string): MapBoundLayer | undefined;
    getPhysicalSrs(): MapSrs;
    /**
     * Returns terrain distance at a 2D position in the current screen view.
     *
     * Coordinates are interpreted according to `coordinateSpace`. Use the
     * default `layout` for mouse-event positions. Use `apparent` for
     * projected renderer positions such as label anchors returned by
     * `Renderer.project2()`.
     *
     * @param screenX Horizontal coordinate in the selected space.
     * @param screenY Vertical coordinate in the selected space.
     * @param dilate Depth-map dilation radius in hitmap pixels.
     * @param useGeometricIntersection Compute a geometric ray intersection
     * instead of sampling the depth hitmap. Geocentric maps intersect the
     * ellipsoid; projected maps intersect the base plane.
     * @param coordinateSpace Coordinate space of `screenX` and `screenY`.
     * @returns `[hit, distance]` — `distance` is the Euclidean distance
     * from the viewer to the terrain surface at the selected position.
     * `hit` is false when no terrain covers the position; `distance` is
     * then a sentinel value.
     */
    getScreenDepth(
        screenX: number,
        screenY: number,
        dilate?: number,
        useGeometricIntersection?: boolean,
        coordinateSpace?: Renderer.CoordinateSpace,
    ): [boolean, number];
    isAtmospheric(): boolean;

    gpuCache: {
        insert(destructor: () => void, cost: number): object;
        remove(item: object): void;
        updateItem(item: object): void;
    };
}
