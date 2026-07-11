/*
 * viewer-config.ts - the authoritative catalogue of runtime config keys
 */

import type MapPosition from './map/position';
import type MapStyle from './map/style';
import type { TransformRequestCallback } from './types';
import * as utils from './utils/utils';


/**
 * Every valid runtime configuration key, its type, and by extension
 * its normalized value shape. This interface is the authoritative
 * definition: no config key exists unless it is declared here
 * (rfc-config-store.md §4.2).
 *
 * The interface is flat. The comment blocks group keys by the
 * subsystem that consumes them; the grouping carries no structure.
 *
 * Values stored under these keys are already normalized (validated,
 * coerced, clamped). Watchers and readers may treat them as valid.
 * Defaults live in `defaultViewerConfig()` below.
 */
export interface ViewerConfig {

    // --- UI controls and navigation (browser layer) ---

    interactive: boolean;
    panAllowed: boolean;
    rotationAllowed: boolean;
    zoomAllowed: boolean;
    jumpAllowed: boolean;
    sensitivity: [number, number, number];
    inertia: [number, number, number];
    timeNormalizedInertia: boolean;
    legacyInertia: boolean;
    positionInUrl: boolean;
    positionUrlHistory: boolean;
    constrainCamera: boolean;
    navigationMode: string;
    controlCompass: boolean;
    controlZoom: boolean;
    controlSpace: boolean;
    controlSearch: boolean;
    controlSearchSrs: string | null;
    controlSearchUrl: string | null;
    controlSearchFilter: boolean;
    controlSearchElement: string | HTMLElement | null;
    controlSearchValue: string | null;
    controlMeasure: boolean;
    controlMeasureLite: boolean;
    controlLink: boolean;
    controlGithub: boolean;
    controlScale: boolean;
    controlLayers: boolean;
    controlCredits: boolean;
    controlFullscreen: boolean;
    controlLoading: boolean;
    controlLogo: boolean;
    walkMode: boolean;
    fixedHeight: number;
    geojson: string | Record<string, unknown> | null;
    geodata: string | Record<string, unknown> | null;
    geojsonStyle: Record<string, unknown> | null;
    tiltConstrainThreshold: [number, number];
    bigScreenMargins: boolean;
    minViewExtent: number;
    maxViewExtent: number;
    autoRotate: number;
    autoPan: [number, number];

    // --- Cross-cutting (map loading and shared services) ---

    style: string | MapStyle.StyleSpecification | null;
    map: string | null;
    position: MapPosition | number[] | string | null;
    view: string | Record<string, unknown> | null;
    transformRequest: TransformRequestCallback | null;
    inspector: boolean;

    // --- Renderer ---

    /** Construction-only: the anisotropic filtering level is baked
     * into each texture's sampling parameters at texture creation;
     * a later change reaches only textures created afterwards. */
    rendererAnisotropic: number;

    /** Construction-only: WebGL context creation flag. */
    rendererAntialiasing: boolean;

    /** Construction-only: sets `preserveDrawingBuffer` at WebGL
     * context creation. */
    rendererAllowScreenshots: boolean;

    /** Live: read per frame by the scale computations. */
    rendererCssDpi: number;

    // --- Inspector diagnostics (URL parameters) ---

    debugMode: string | boolean | null;
    debugBBox: string | boolean | null;
    debugLBox: string | boolean | null;
    debugNoEarth: string | boolean | null;
    debugGridCells: string | boolean | null;
    debugRadar: string | boolean | null;

    // --- Terrain engine (LegacyMap) ---

    mapCache: number;
    mapGPUCache: number;
    mapMetatileCache: number;
    mapTexelSizeFit: number;
    mapMaxHiresLodLevels: number;
    mapDownloadThreads: number;
    mapMaxProcessingTime: number;
    mapMaxGeodataProcessingTime: number;
    mapMobileMode: boolean;
    mapMobileModeAutodect: boolean;
    mapMobileDetailDegradation: number;
    mapNavSamplesPerViewExtent: number;
    mapIgnoreNavtiles: boolean;
    mapAllowHires: boolean;
    mapAllowLowres: boolean;
    mapAllowSmartSwitching: boolean;
    mapDisableCulling: boolean;
    mapPreciseCulling: boolean;
    mapHeightLodBlend: boolean;
    mapHeightNodeBlend: boolean;
    mapBasicTileSequence: boolean;
    mapPreciseBBoxTest: boolean;
    mapPreciseDistanceTest: boolean;
    mapForceMetatileV3: boolean;
    mapSmartNodeParsing: boolean;
    mapLoadErrorRetryTime: number;
    mapLoadErrorMaxRetryCount: number;
    mapSplitMargin: number;
    mapTraversalMaskResolution: number;
    mapTraversalMaskThreshold: number;
    mapTraversalMaskErosion: number;
    mapFallbackCadence: number;
    mapStructuralDescentBrake: number;
    mapSplitSpace: unknown;
    mapGridMode: string;
    mapGridSurrogatez: boolean;
    mapGridTextureLevel: number;
    mapGridTextureLayer: string | null;
    mapXhrImageLoad: boolean;
    mapRefreshCycles: number;
    mapSoftViewSwitch: boolean;
    mapSortHysteresis: boolean;
    mapHysteresisWait: number;
    mapSeparateLoader: boolean;
    mapGeodataBinaryLoad: boolean;
    mapPackLoaderEvents: boolean;
    mapParseMeshInWorker: boolean;
    mapPackGeodataEvents: boolean;
    mapCheckTextureSize: boolean;
    mapNormalizeOctantTexelSize: boolean;
    mapFeatureStickMode: [number, number];
    map16bitMeshes: boolean;
    mapIndexBuffers: boolean;
    mapAsyncImageDecode: boolean;
    mapFeatureGridCells: number;
    mapFeaturesPerSquareInch: number;
    mapFeaturesSortByTop: boolean;
    mapFeaturesReduceMode: string;
    mapFeaturesReduceParams: number[];
    mapFeaturesReduceFactor: number;
    mapFeaturesReduceFactor2: number;
    mapExposeFpsToWindow: boolean;
    mapProfileGpu: boolean;
    mapDMapSize: number;
    mapDMapMode: number;
    mapDMapCopyIntervalMs: number;
    mapDMapDilatePx: number;
    mapDegradeHorizon: boolean;
    mapDegradeHorizonParams: [number, number, number, number];
    mapDefaultFont: string;
    mapNoTextures: boolean;
    mapNoNormalMaps: boolean;
    mapCollapseBumps: boolean;
    mapMetricUnits: boolean;
    mapLanguage: string;
    mapForceFrameTime: number;
    mapLogGeodataStyles: boolean;
    mapBenevolentMargins: boolean;
    mapLabelFreeMargins: [number, number, number, number];
    mapShadingLambertian: boolean;
    mapShadingSlope: boolean;
    mapShadingAspect: boolean;
    mapFlagLighting: boolean;
    mapFlagNormalMaps: boolean;
    mapFlagDiffuseMaps: boolean;
    mapFlagSpecularMaps: boolean;
    mapFlagBumpMaps: boolean;
    mapFlagAtmosphere: boolean;
    mapFlagShadows: boolean;
    mapFlagLabels: boolean;
}


/**
 * Builds the initial, fully populated `ViewerConfig` value set.
 *
 * A function rather than a constant because two defaults depend on
 * the browser language at startup (`mapMetricUnits`, `mapLanguage`)
 * and one on `createImageBitmap` availability
 * (`mapAsyncImageDecode`).
 */
export function defaultViewerConfig(): ViewerConfig {

    const lang = navigator.languages
        ? navigator.languages[0]
        : (navigator.language
            || (navigator as { userLanguage?: string }).userLanguage
            || 'en');

    return {

        // --- UI controls and navigation (browser layer) ---

        interactive: true,
        panAllowed: true,
        rotationAllowed: true,
        zoomAllowed: true,
        jumpAllowed: false,
        sensitivity: [1, 0.06, 0.05],
        inertia: [0.81, 0.9, 0.7],
        timeNormalizedInertia: false,
        legacyInertia: false,
        positionInUrl: false,
        positionUrlHistory: false,
        constrainCamera: true,
        navigationMode: 'azimuthal',
        controlCompass: true,
        controlZoom: true,
        controlSpace: true,
        controlSearch: true,
        controlSearchSrs: null,
        controlSearchUrl: null,
        controlSearchFilter: false,
        controlSearchElement: null,
        controlSearchValue: null,
        controlMeasure: false,
        controlMeasureLite: false,
        controlLink: false,
        controlGithub: false,
        controlScale: true,
        controlLayers: false,
        controlCredits: true,
        controlFullscreen: false,
        controlLoading: true,
        controlLogo: false,
        walkMode: false,
        fixedHeight: 0,
        geojson: null,
        geodata: null,
        geojsonStyle: null,
        tiltConstrainThreshold: [0.5, 1],
        bigScreenMargins: false,
        minViewExtent: 20,
        maxViewExtent: Number.MAX_SAFE_INTEGER,
        autoRotate: 0,
        autoPan: [0, 0],

        // --- Cross-cutting (map loading and shared services) ---

        style: null,
        map: null,
        position: null,
        view: null,
        transformRequest: null,
        inspector: true,

        // --- Renderer ---

        rendererAnisotropic: 0,
        rendererAntialiasing: true,
        rendererAllowScreenshots: false,
        rendererCssDpi: 96,

        // --- Inspector diagnostics (URL parameters) ---

        debugMode: null,
        debugBBox: null,
        debugLBox: null,
        debugNoEarth: null,
        debugGridCells: null,
        debugRadar: null,

        // --- Terrain engine (LegacyMap) ---

        mapCache: 1100,
        mapGPUCache: 600,
        mapMetatileCache: 60,
        mapTexelSizeFit: 1.1,
        mapMaxHiresLodLevels: 2,
        mapDownloadThreads: 20,
        mapMaxProcessingTime: 10,
        mapMaxGeodataProcessingTime: 10,
        mapMobileMode: false,
        mapMobileModeAutodect: true,
        mapMobileDetailDegradation: 0,
        mapNavSamplesPerViewExtent: 4,
        mapIgnoreNavtiles: false,
        mapAllowHires: true,
        mapAllowLowres: true,
        mapAllowSmartSwitching: true,
        mapDisableCulling: false,
        mapPreciseCulling: true,
        mapHeightLodBlend: true,
        mapHeightNodeBlend: true,
        mapBasicTileSequence: false,
        mapPreciseBBoxTest: false,
        mapPreciseDistanceTest: false,
        mapForceMetatileV3: false,
        mapSmartNodeParsing: true,
        mapLoadErrorRetryTime: 3000,
        mapLoadErrorMaxRetryCount: 3,
        mapSplitMargin: 0.0025,
        mapTraversalMaskResolution: 256,
        mapTraversalMaskThreshold: 0.5,
        mapTraversalMaskErosion: 1,
        mapFallbackCadence: 3,
        mapStructuralDescentBrake: 0.25,
        mapSplitSpace: null,
        mapGridMode: 'linear',
        mapGridSurrogatez: false,
        mapGridTextureLevel: -1,
        mapGridTextureLayer: null,
        mapXhrImageLoad: true,
        mapRefreshCycles: 3,
        mapSoftViewSwitch: true,
        mapSortHysteresis: true,
        mapHysteresisWait: 0,
        mapSeparateLoader: true,
        mapGeodataBinaryLoad: true,
        mapPackLoaderEvents: true,
        mapParseMeshInWorker: true,
        mapPackGeodataEvents: true,
        mapCheckTextureSize: false,
        mapNormalizeOctantTexelSize: true,
        mapFeatureStickMode: [1, 1],
        map16bitMeshes: true,
        mapIndexBuffers: true,
        mapAsyncImageDecode: typeof createImageBitmap !== 'undefined',
        mapFeatureGridCells: 31,
        mapFeaturesPerSquareInch: 0.25,
        mapFeaturesSortByTop: false,
        mapFeaturesReduceMode: 'scr-count7',
        mapFeaturesReduceParams: [0.05, 0.17, 11, 1, 1000],
        mapFeaturesReduceFactor: 1,
        mapFeaturesReduceFactor2: 1,
        mapExposeFpsToWindow: false,
        mapProfileGpu: false,
        mapDMapSize: 512,
        mapDMapMode: 3,
        mapDMapCopyIntervalMs: 1500,
        mapDMapDilatePx: 2,
        mapDegradeHorizon: false,
        mapDegradeHorizonParams: [1, 1500, 97500, 3500],
        mapDefaultFont:
            'https://cdn.tspl.re/libs/vtsjs/fonts/noto-extended/'
            + '1.0.0/noto.fnt',
        mapNoTextures: false,
        mapNoNormalMaps: false,
        mapCollapseBumps: true,
        mapMetricUnits: !(lang == 'en' || lang.indexOf('en-') == 0),
        mapLanguage: lang,
        mapForceFrameTime: 0,
        mapLogGeodataStyles: true,
        mapBenevolentMargins: false,
        mapLabelFreeMargins: [30, 30, 30, 30],
        mapShadingLambertian: true,
        mapShadingSlope: false,
        mapShadingAspect: false,
        mapFlagLighting: true,
        mapFlagNormalMaps: true,
        mapFlagDiffuseMaps: true,
        mapFlagSpecularMaps: true,
        mapFlagBumpMaps: true,
        mapFlagAtmosphere: true,
        mapFlagShadows: true,
        mapFlagLabels: true,
    };
}


/**
 * Resolves a public config key to its canonical `ViewerConfig` key.
 *
 * Handles the legacy aliases (`pos` for `position`, `rotate` for
 * `autoRotate`, `pan` for `autoPan`) and returns `null` for keys
 * that are not catalogued, so untyped callers can be filtered at
 * runtime.
 */
export function canonicalConfigKey(
    key: string,
): keyof ViewerConfig | null {

    if (key in keyAliases) return keyAliases[key];
    return key in normalizers ? key as keyof ViewerConfig : null;
}


/**
 * Normalizes a raw authored value for one config key: type
 * coercion, range clamping, and JSON parsing, mirroring the
 * validation the legacy `setConfigParam` switches applied. The
 * returned value satisfies the `ViewerConfig` type of the key and
 * is safe to write to the store.
 */
export function normalizeConfigValue<K extends keyof ViewerConfig>(
    key: K,
    value: unknown,
): ViewerConfig[K] {

    return normalizers[key](value) as ViewerConfig[K];
}


/**
 * Builds the store patch for one public config key: alias
 * resolution, value normalization, and the coupled-key expansion
 * (`mapNoTextures` also drives `mapDisableCulling`).
 *
 * @returns the patch to pass to `ConfigStore.set`, or `null` when
 *   the key is not catalogued
 */
export function normalizeConfigPatch(
    key: string,
    value: unknown,
): Partial<ViewerConfig> | null {

    const canonical = canonicalConfigKey(key);
    if (!canonical) return null;

    const patch: Partial<ViewerConfig> = {
        [canonical]: normalizeConfigValue(canonical, value),
    };

    // legacy coupling: disabling textures also disables culling
    if (canonical === 'mapNoTextures')
        patch.mapDisableCulling = patch.mapNoTextures;

    return patch;
}


// Local helpers for the normalizer table below.

const MAX = Number.MAX_SAFE_INTEGER;

const bool = (dflt: boolean) =>
    (v: unknown) => utils.validateBool(v, dflt);

const num = (min: number, max: number, dflt: number) =>
    (v: unknown) => utils.validateNumber(v, min, max, dflt);

const str = (dflt: string) =>
    (v: unknown) => utils.validateString(v, dflt);

const strOrNull = (v: unknown) => typeof v === 'string' ? v : null;

const pair = (min: number[], max: number[], dflt: number[]) =>
    (v: unknown) => utils.validateNumberArray(v, 2, min, max, dflt) as
        [number, number];

const triple = (min: number[], max: number[], dflt: number[]) =>
    (v: unknown) => utils.validateNumberArray(v, 3, min, max, dflt) as
        [number, number, number];

const quad = (min: number[], max: number[], dflt: number[]) =>
    (v: unknown) => utils.validateNumberArray(v, 4, min, max, dflt) as
        [number, number, number, number];

const raw = <T>() => (v: unknown) => v as T;

const debugValue = (v: unknown) =>
    typeof v === 'string' || typeof v === 'boolean' ? v : null;

const keyAliases: Record<string, keyof ViewerConfig> = {
    pos: 'position',
    rotate: 'autoRotate',
    pan: 'autoPan',
};

/**
 * Per-key normalization, total over `ViewerConfig`. Bounds and
 * fallback values mirror the legacy `setConfigParam` switches;
 * constructor-only keys that had no switch case use bounds implied
 * by their type and their catalogue default as the fallback.
 */
const normalizers: {
    [K in keyof ViewerConfig]: (value: unknown) => ViewerConfig[K];
} = {

    // --- UI controls and navigation (browser layer) ---

    interactive: bool(true),
    panAllowed: bool(true),
    rotationAllowed: bool(true),
    zoomAllowed: bool(true),
    jumpAllowed: bool(false),
    sensitivity: triple([0, 0, 0], [10, 10, 10], [1, 0.12, 0.05]),
    inertia: triple(
        [0, 0, 0], [0.99, 0.99, 0.99], [0.85, 0.9, 0.7]),
    timeNormalizedInertia: bool(false),
    legacyInertia: bool(false),
    positionInUrl: bool(false),
    positionUrlHistory: bool(false),
    constrainCamera: bool(true),
    navigationMode: str('azimuthal'),
    controlCompass: bool(true),
    controlZoom: bool(true),
    controlSpace: bool(false),
    controlSearch: bool(false),
    controlSearchSrs: strOrNull,
    controlSearchUrl: strOrNull,
    controlSearchFilter: bool(true),
    controlSearchElement:
        raw<string | HTMLElement | null>(),
    controlSearchValue: strOrNull,
    controlMeasure: bool(false),
    controlMeasureLite: bool(false),
    controlLink: bool(false),
    controlGithub: bool(false),
    controlScale: bool(true),
    controlLayers: bool(false),
    controlCredits: bool(true),
    controlFullscreen: bool(true),
    controlLoading: bool(true),
    controlLogo: bool(false),
    walkMode: bool(false),
    fixedHeight: num(-MAX, MAX, 0),
    geojson: raw<string | Record<string, unknown> | null>(),
    geodata: raw<string | Record<string, unknown> | null>(),
    geojsonStyle: (v) => {

        if (typeof v === 'string')
            return JSON.parse(v) as Record<string, unknown>;
        if (v && typeof v === 'object')
            return v as Record<string, unknown>;
        return null;
    },
    tiltConstrainThreshold:
        pair([0.5, 1], [Infinity, Infinity], [0.5, 1]),
    bigScreenMargins: bool(false),
    minViewExtent: num(0.01, MAX, 100),
    maxViewExtent: num(0.01, MAX, MAX),
    autoRotate: num(-Infinity, Infinity, 0),
    autoPan: (v) => {

        if (Array.isArray(v) && v.length == 2) {

            return [
                utils.validateNumber(v[0], -Infinity, Infinity, 0),
                utils.validateNumber(v[1], -360, 360, 0),
            ];
        }
        return [0, 0];
    },

    // --- Cross-cutting (map loading and shared services) ---

    style: raw<string | MapStyle.StyleSpecification | null>(),
    map: strOrNull,
    position: raw<MapPosition | number[] | string | null>(),
    view: raw<string | Record<string, unknown> | null>(),
    transformRequest: (v) =>
        typeof v === 'function' ? v as TransformRequestCallback : null,
    inspector: bool(true),

    // --- Renderer ---

    rendererAnisotropic: num(-1, 2048, 0),
    rendererAntialiasing: bool(true),
    rendererAllowScreenshots: bool(false),
    rendererCssDpi: num(1, 1200, 96),

    // --- Inspector diagnostics (URL parameters) ---

    debugMode: debugValue,
    debugBBox: debugValue,
    debugLBox: debugValue,
    debugNoEarth: debugValue,
    debugGridCells: debugValue,
    debugRadar: debugValue,

    // --- Terrain engine (LegacyMap) ---

    mapCache: num(10, MAX, 900),
    mapGPUCache: num(10, MAX, 360),
    mapMetatileCache: num(10, MAX, 60),
    mapTexelSizeFit: num(0.0001, MAX, 1.1),
    mapMaxHiresLodLevels: num(0, MAX, 2),
    mapDownloadThreads: num(1, MAX, 6),
    mapMaxProcessingTime: num(1, MAX, 1000 / 20),
    mapMaxGeodataProcessingTime: num(1, MAX, 10),
    mapMobileMode: bool(false),
    mapMobileModeAutodect: bool(false),
    mapMobileDetailDegradation: num(0, MAX, 2),
    mapNavSamplesPerViewExtent: num(0.00000000001, MAX, 4),
    mapIgnoreNavtiles: bool(false),
    mapAllowHires: bool(true),
    mapAllowLowres: bool(true),
    mapAllowSmartSwitching: bool(true),
    mapDisableCulling: bool(false),
    mapPreciseCulling: bool(false),
    mapHeightLodBlend: bool(true),
    mapHeightNodeBlend: bool(true),
    mapBasicTileSequence: bool(true),
    mapPreciseBBoxTest: bool(true),
    mapPreciseDistanceTest: bool(false),
    mapForceMetatileV3: bool(false),
    mapSmartNodeParsing: bool(true),
    mapLoadErrorRetryTime: num(0, MAX, 3000),
    mapLoadErrorMaxRetryCount: num(0, MAX, 3),
    mapSplitMargin: num(-MAX, MAX, 0.0025),
    mapTraversalMaskResolution: (v) => {

        // Mask textures must be power-of-two; fall back to the
        // default when the supplied value would need silent rounding.
        const resolution = utils.validateNumber(v, 16, 4096, 256);
        const isPowerOfTwo = (resolution & (resolution - 1)) === 0;
        return isPowerOfTwo ? resolution : 256;
    },
    mapTraversalMaskThreshold: num(0, 1, 0.5),
    mapTraversalMaskErosion: num(0, 1, 1),
    mapFallbackCadence: num(1, MAX, 3),
    mapStructuralDescentBrake: num(0, 1, 0.25),
    mapSplitSpace: raw<unknown>(),
    mapGridMode: str('linear'),
    mapGridSurrogatez: bool(false),
    mapGridTextureLevel: num(-MAX, MAX, -1),
    mapGridTextureLayer: strOrNull,
    mapXhrImageLoad: bool(false),
    mapRefreshCycles: num(0, MAX, 3),
    mapSoftViewSwitch: bool(true),
    mapSortHysteresis: bool(false),
    mapHysteresisWait: num(0, MAX, 0),
    mapSeparateLoader: bool(true),
    mapGeodataBinaryLoad: bool(true),
    mapPackLoaderEvents: bool(true),
    mapParseMeshInWorker: bool(true),
    mapPackGeodataEvents: bool(true),
    mapCheckTextureSize: bool(false),
    mapNormalizeOctantTexelSize: bool(true),
    mapFeatureStickMode:
        pair([0, 1], [Infinity, Infinity], [0, 1]),
    map16bitMeshes: bool(false),
    mapIndexBuffers: bool(false),
    mapAsyncImageDecode: (v) =>
        utils.validateBool(v, false)
            && typeof createImageBitmap !== 'undefined',
    mapFeatureGridCells: num(-MAX, MAX, 0),
    mapFeaturesPerSquareInch: num(0.000001, MAX, 0),
    mapFeaturesSortByTop: bool(false),
    mapFeaturesReduceMode: (v) => {

        let mode = utils.validateString(v, 'scr-count4');
        if (mode == 'auto') mode = 'scr-count2';
        if (mode == 'legacy') mode = 'scr-count2';
        if (mode == 'gridcells') mode = 'scr-count4';
        if (mode == 'singlepass') mode = 'scr-count5';
        if (mode == 'margin') mode = 'scr-count6';
        return mode;
    },
    mapFeaturesReduceParams: raw<number[]>(),
    mapFeaturesReduceFactor: num(0, MAX, 1),
    mapFeaturesReduceFactor2: num(0, MAX, 1),
    mapExposeFpsToWindow: bool(false),
    mapProfileGpu: bool(false),
    mapDMapSize: num(16, MAX, 512),
    mapDMapMode: num(1, MAX, 1),
    mapDMapCopyIntervalMs: num(0, MAX, 1500),
    mapDMapDilatePx: num(0, 8, 2),
    mapDegradeHorizon: bool(true),
    mapDegradeHorizonParams: quad(
        [0, 1, 1, 1],
        [Infinity, Infinity, Infinity, Infinity],
        [1, 3000, 15000, 7000]),
    mapDefaultFont: str(''),
    mapNoTextures: bool(false),
    mapNoNormalMaps: bool(false),
    mapCollapseBumps: bool(true),
    mapMetricUnits: bool(true),
    mapLanguage: str('en'),
    mapForceFrameTime: num(-1, MAX, 0),
    mapLogGeodataStyles: bool(true),
    mapBenevolentMargins: bool(false),
    mapLabelFreeMargins: quad(
        [0, 0, 0, 0],
        [Infinity, Infinity, Infinity, Infinity],
        [0, 0, 0, 0]),
    mapShadingLambertian: bool(true),
    mapShadingSlope: bool(false),
    mapShadingAspect: bool(false),
    mapFlagLighting: bool(true),
    mapFlagNormalMaps: bool(true),
    mapFlagDiffuseMaps: bool(true),
    mapFlagSpecularMaps: bool(true),
    mapFlagBumpMaps: bool(true),
    mapFlagAtmosphere: bool(true),
    mapFlagShadows: bool(true),
    mapFlagLabels: bool(true),
};
