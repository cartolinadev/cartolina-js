import type Atmosphere from './atmosphere';
import type MapBody from './body';
import type MapBoundLayer from './bound-layer';
import type MapCredit from './credit';
import type MapPosition from './position';
import type MapRefFrame from './refframe';
import type MapSrs from './srs';
import type MapStyle from './style';
import type MapSurface from './surface';
import type MapUrl from './url';
import type Renderer from '../renderer/renderer';
import type { NodeInformation } from '../types';

type MapReferenceFrame = (MapRefFrame & {
    id: string;
    body?: MapBody & {
        atmosphere?: Partial<Atmosphere.Specification>;
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
    config: {
        mapDMapDilatePx?: number;
    };

    position: MapPosition;
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

    style: MapStyle | null;

    tree: {
        surfaceSequence: SurfaceSequenceItem[];
        surfaceOnlySequence: SurfaceSequenceItem[];
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
    markDirty(): void;

    addSrs(id: string, srs: MapSrs): void;
    addBody(id: string, body: MapBody): void;
    addCredit(id: string, credit: MapCredit): void;
    addSurface(id: string, surface: MapSurface): void;
    addBoundLayer(id: string, layer: MapBoundLayer): void;
    addFreeLayer(id: string, layer: MapSurface): void;

    getFreeLayer(id: string): FreeLayer | undefined;
    getBoundLayerById(id: string): MapBoundLayer | undefined;
    getPhysicalSrs(): MapSrs;
    /**
     * Samples terrain depth at a 2D position in the current screen view.
     *
     * Coordinates are interpreted according to `coordinateSpace`. Use the
     * default `layout` for mouse-event positions. Use `apparent` for
     * projected renderer positions such as label anchors returned by
     * `Renderer.project2()`.
     *
     * @param screenX Horizontal coordinate in the selected space.
     * @param screenY Vertical coordinate in the selected space.
     * @param dilate Depth-map dilation radius in hitmap pixels.
     * @param useFallback Use mathematical ray intersection instead of the
     * depth hitmap.
     * @param coordinateSpace Coordinate space of `screenX` and `screenY`.
     * @returns Whether a surface was hit, and its depth along the screen ray.
     */
    getScreenDepth(
        screenX: number,
        screenY: number,
        dilate?: number,
        useFallback?: boolean,
        coordinateSpace?: Renderer.CoordinateSpace,
    ): [boolean, number];
    isAtmospheric(): boolean;
}
