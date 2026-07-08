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
 * Map from event name to its payload type.
 *
 * Payloads from the legacy JS core are typed as `unknown` until the
 * underlying JS is migrated to TypeScript.
 */
export interface CoreEventMap {
    'map-mapconfig-loaded': unknown;
    'map-loaded': unknown;
    'map-unloaded': unknown;
    'map-update': unknown;
    'map-position-changed': unknown;
    'map-position-fixed-height-changed': unknown;
    'tick': unknown;
    'gpu-context-lost': unknown;
    'gpu-context-restored': unknown;
    'geo-feature-enter': unknown;
    'geo-feature-leave': unknown;
    'geo-feature-hover': unknown;
    'geo-feature-click': unknown;
}
