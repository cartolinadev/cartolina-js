import type MapSrs from './map/srs';
import type Renderer from './renderer/renderer';

/**
 * Resource category passed to `transformRequest`.
 *
 * `Source` covers style source and legacy surface or bound-layer JSON.
 * `Tile` covers terrain, metadata, texture, and geodata tile payloads.
 * `Glyph` covers binary font metadata and font atlas pages.
 */
export type RequestResourceType =
    | 'MapConfig'
    | 'Style'
    | 'Source'
    | 'Tile'
    | 'Image'
    | 'Glyph'
    | 'Other';

/** Request override returned by `TransformRequestCallback`. */
export type RequestTransformResult = {
    url: string;
    headers?: Record<string, string>;
    credentials?: 'include' | 'same-origin' | 'omit';
};

/**
 * Callback invoked before cartolina-js loads an external resource.
 *
 * @param url original absolute or resolved resource URL
 * @param resourceType category of the requested resource
 * @returns URL, optional headers, and optional credentials mode
 */
export type TransformRequestCallback = (
    url: string,
    resourceType: RequestResourceType,
) => RequestTransformResult;

/**
 * Shared configuration object owned by the legacy core and passed to the
 * map and renderer layers.
 *
 * The full runtime object has many legacy keys. This type records the
 * fields used by current TypeScript modules and should grow only when
 * typed code touches another key.
 */
export interface CoreConfig {
    [key: string]:
        | boolean
        | number
        | string
        | number[]
        | TransformRequestCallback
        | undefined;
    rendererAllowScreenshots?: boolean;
    rendererAntialiasing?: boolean;
    rendererAnisotropic?: number;
    rendererCssDpi?: number;
    mapShadingLambertian?: boolean;
    mapShadingSlope?: boolean;
    mapShadingAspect?: boolean;
    mapFlagLighting?: boolean;
    mapFlagNormalMaps?: boolean;
    mapFlagDiffuseMaps?: boolean;
    mapFlagSpecularMaps?: boolean;
    mapFlagBumpMaps?: boolean;
    mapFlagAtmosphere?: boolean;
    mapNoNormalMaps?: boolean;
    mapCollapseBumps?: boolean;
    mapFlagShadows?: boolean;
    mapFlagLabels?: boolean;
    mapDMapSize?: number;
    mapDMapMode?: number;
    mapDMapCopyIntervalMs?: number;
    mapDMapDilatePx?: number;
    mapBenevolentMargins?: boolean;
    mapForceFrameTime?: number;
    mapSplitMargin?: number;
    mapTraversalMaskResolution?: number;
    mapTraversalMaskThreshold?: number;
    mapTraversalMaskErosion?: number;
    mapFallbackCadence?: number;
    mapStructuralDescentBrake?: number;
    mapLabelFreeMargins?: [number, number, number, number];
    mapRefreshCycles?: number;
    transformRequest?: TransformRequestCallback;
}

/** Height mode for coordinate conversions and hit-testing. */
export type HeightMode = 'fix' | 'float';

/**
 * Level-of-detail hint for coordinate conversions and height sampling.
 * A higher value requests a finer terrain mesh.
 */
export type Lod = number;

export type Vec2 = [number, number];
export type Vec3 = [number, number, number];

/** Result of `MapMeasure.getNodeInformation()` for one spatial division node. */
export type NodeInformation = {
    id: Vec3;
    height: number;
    srs: MapSrs;
    extents: {
        ll: Vec2;
        ur: Vec2;
    };
    physicalCorners: {
        ul: Vec3;
        ur: Vec3;
        lr: Vec3;
        ll: Vec3;
    };
    divisionNode: unknown;
    upVector: Vec3;
};

/**
 * Per-frame context passed to overlay lifecycle callbacks.
 *
 * Overlays run as the explicit last step of the canvas-target frame,
 * after the engine has finished drawing terrain, free layers, and
 * label/icon jobs. Forward-compatible: new context fields may be
 * added; existing callbacks need no change.
 */
export type OverlayContext = {
    /**
     * The renderer for issuing draw helpers
     * (`drawImage`, `drawLineString`, `createTexture`, `getCanvasSize`).
     */
    readonly renderer: Renderer;
};

/**
 * Lifecycle hooks for a custom overlay registered through
 * `viewer.addOverlay(name, spec)`.
 *
 * - `onAdd` fires once when the engine is ready to accept draw calls
 *   from the overlay (after `map-loaded`). Overlays registered before
 *   the engine is ready have `onAdd` deferred to that moment.
 * - `render` fires every frame, as the last step against the canvas
 *   target, after engine draws have completed.
 * - `onRemove` fires when the overlay is removed via
 *   `viewer.removeOverlay(name)` or when the viewer is disposed.
 */
export type OverlaySpec = {
    onAdd?: (ctx: OverlayContext) => void;
    render: (ctx: OverlayContext) => void;
    onRemove?: (ctx: OverlayContext) => void;
};

/**
 * Map from event name to its payload type. All events are public and
 * reachable through `Viewer.on()`.
 *
 * Known payload fields carry concrete types; `unknown` remains only
 * where the source is still untyped ES5 and the shape cannot be
 * verified without migrating that file.
 */
export interface ViewerEventMap {
    'map-mapconfig-loaded': Record<string, unknown>;
    'map-loaded': { browserOptions: Record<string, unknown> };
    'map-unloaded': Record<string, never>;
    'map-update': Record<string, never>;
    'map-position-changed': {
        position: number[];
        'last-position': number[];
    };
    'map-position-fixed-height-changed': {
        height: number;
        'last-height': number;
    };
    'map-position-panned': Record<string, never>;
    'map-position-rotated': Record<string, never>;
    'map-position-zoomed': Record<string, never>;
    'tick': Record<string, never>;
    'gpu-context-lost': Record<string, never>;
    'gpu-context-restored': Record<string, never>;
    'geo-feature-enter': GeoFeatureEvent;
    'geo-feature-leave': GeoFeatureEvent;
    'geo-feature-hover': GeoFeatureEvent;
    'geo-feature-click': GeoFeatureEvent;
    'autorotate-changed': { autorotate: number };
    'fly-start': {
        startPosition: unknown;
        endPosition: unknown;
        options: unknown;
    };
    'fly-final-phase': { position: unknown };
    'fly-progress': { position: unknown; progress: number };
    'fly-end': { position: unknown };
    'loading-screen-hidden': Record<string, never>;
}

/**
 * Payload of the `geo-feature-*` pointer events emitted by
 * `LegacyMap` (`src/core/map/map.js`).
 */
export interface GeoFeatureEvent {
    feature: unknown;           // typed once LegacyMap migrates to TS
    'canvas-coords': number[];
    'physical-coords': number[];
    state: unknown;
    element: unknown;
}
