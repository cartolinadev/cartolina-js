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
import type MapDraw from './draw';
import type Renderer from '../renderer/renderer';
import type TypedMap from '../map';
import type {
    CoreConfig,
    HeightMode,
    Lod,
    NodeInformation,
} from '../types';
import type { vec3 } from '../utils/math';

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

    ready?: boolean;
    tree?: { draw(): void } | null;
    stylesheet?: { isReady(): boolean } | null;
    type?: string;
    zFactor?: number | null;
};

type SurfaceSequenceItem = [MapSurface, boolean];

/**
 * Legacy map data model — the JavaScript half of `Map` being absorbed
 * into the typed class in `src/core/map.ts`. Runtime implementation
 * is in `map.js`. This declaration covers the subset used by current
 * TypeScript modules and grows incrementally as refactoring work
 * touches more of the legacy surface.
 */
export default class Map {

    constructor(
        core: unknown,
        path: string,
        config: CoreConfig,
        configStorage: unknown,
    );

    /**
     * Back-pointer to the typed `Map` wrapper. Migration scaffolding so
     * the legacy auxiliary classes (`MapDraw`, `MapDrawTiles`,
     * `MapSurfaceTree`, `Renderer`, ...) can reach typed-`Map` state
     * (`drawChannel`, overlays, per-frame entry points) while they still
     * hold a `this.map = LegacyMap` reference. Disappears when those
     * classes absorb into typed `Map`.
     *
     * Set by `Core` when the `LegacyMap` instance is created.
     */
    outerMap: TypedMap;

    renderer: Renderer;
    url: MapUrl;
    config: CoreConfig;
    stats: {
        frameTime: number;
        drawnGeodataTilesPerLayer: number;
        drawnGeodataTilesFactor: number;
        renderBuild: number;
        begin(dirty: boolean): void;
        end(dirty: boolean): void;
    } & Record<string, unknown>;

    position: MapPosition;
    lastPosition: MapPosition;
    camera: MapCamera;
    atmosphere: Atmosphere | null;
    referenceFrame: MapReferenceFrame;
    services: MapServices;

    /** Set when the runtime decides the next frame must redraw. */
    dirty: boolean;
    /** Remaining frames to keep drawing after `dirty` flips false; lets
     * the scene reach a stable state across the configured refresh
     * cycles (`mapRefreshCycles`). */
    dirtyCountdown: number;

    /** Best texel-size achieved by the last drawn mesh tile; reset
     * before each dirty draw and read by load prioritisation. */
    bestMeshTexelSize: number;
    /** Best texel-size achieved by the last drawn geodata tile;
     * companion to `bestMeshTexelSize`. */
    bestGeodataTexelSize: number;

    /** Initial `browserOptions` payload from the loaded mapConfig;
     * forwarded with the `map-loaded` event and the ready Promise. */
    browserOptions: unknown;
    /** Becomes true once the reference frame and any geoid grids have
     * finished loading. Gates the ready path inside `Map.tick`. */
    srsReady: boolean;

    /** Loader for tile / geodata download promotion. The runtime
     * shape has more methods than declared here; declarations grow on
     * demand. */
    loader: {
        update(): void;
        setChannel(channel: number): void;
    };

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
        draw(stopOnFinish: boolean): void;
    };

    draw: MapDraw;

    hoverFeature: unknown;
    hoverFeatureList: unknown[];

    measure: {
        getNodeInformation(
            id: [number, number, number],
            height?: number,
        ): NodeInformation | null;
    };

    setConfigParam(key: string, value: unknown): void;

    setPosition(position: MapPosition | number[]): void;
    getPosition(): MapPosition;

    markDirty(): void;
    isReferenceFrameReady(): boolean;

    /**
     * Pre-draw residual work owned by `LegacyMap`. Called by `Map.tick`
     * on the ready path after `stats.begin` and before the dirty-gated
     * draw. Drives the loader and worker-callback processing.
     */
    tickBefore(): void;

    /**
     * Post-draw residual work owned by `LegacyMap`. Called by `Map.tick`
     * every frame after the dirty-gated draw block. Runs hit tests for
     * queued hover and click events against the canvas that was just
     * drawn; no-op when no event is queued.
     */
    tickDeferredEvents(): void;

    setLoaderParams(mapConfig: unknown, configStorage: unknown): void;

    /** True when the navigation SRS is geocentric (non-projected). */
    isGeocent: boolean;

    /** Set when the hitmap needs to be redrawn. */
    hitMapDirty: boolean;

    /** Set when the geodata hitmap needs to be redrawn. */
    geoHitMapDirty: boolean;

    /** Frame counter used by camera smoothing. Typo preserved from JS. */
    updateCoutner: number;

    /** The parsed mapConfig object. Shape is fully owned by map.js. */
    mapConfig: unknown;

    /** The coordinate-conversion helper attached after construction. */
    convert: unknown;

    /** Regenerates the free-layer and surface sequences from the view. */
    refreshView(): void;

    addSrs(id: string, srs: MapSrs): void;
    addBody(id: string, body: MapBody): void;
    addCredit(id: string, credit: MapCredit): void;
    addSurface(id: string, surface: MapSurface): void;
    addBoundLayer(id: string, layer: MapBoundLayer): void;
    addFreeLayer(id: string, layer: unknown): void;
    removeFreeLayer(id: string): void;

    /**
     * Creates a geodata builder for constructing vector overlays.
     * The return type is `unknown` pending a TypeScript declaration for
     * the geodata builder surface.
     */
    createGeodata(): unknown;

    convertPositionHeightMode(
        position: MapPosition | number[],
        mode: HeightMode,
        noPrecisionCheck?: boolean,
    ): MapPosition;
    convertCoordsFromPublicToNav(
        pos: vec3,
        mode: HeightMode,
        lod?: Lod,
    ): vec3 | null;
    convertCoordsFromNavToCanvas(
        pos: vec3,
        mode: HeightMode,
        lod?: Lod,
    ): vec3 | null;
    convertCoordsFromNavToPublic(
        pos: vec3,
        mode: HeightMode,
        lod?: Lod,
    ): vec3 | null;
    convertCoordsFromNavToPhys(
        pos: vec3,
        mode: HeightMode,
        lod?: Lod,
        includeSE?: boolean,
    ): vec3 | null;
    convertCoordsFromPhysToCameraSpace(pos: vec3): vec3;
    getHitCoords(
        screenX: number,
        screenY: number,
        mode: HeightMode,
        lod?: Lod,
    ): vec3 | null;

    getFreeLayer(id: string): FreeLayer | undefined;
    getBoundLayerById(id: string): MapBoundLayer | undefined;
    getNavigationSrs(): MapSrs;
    getPhysicalSrs(): MapSrs;
    getSrsInfo(srsId: string): Record<string, unknown>;
    getReferenceFrame(): {
        id: string;
        physicalSrs: string;
        navigationSrs: string;
        publicSrs: string;
    };
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
        skipCostCheck: boolean;
        insert(destructor: () => void, cost: number): object;
        remove(item: object): void;
        updateItem(item: object): void;
        checkCost(): void;
    };
}
