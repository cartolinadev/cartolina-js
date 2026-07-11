/*
 * viewer-config.ts - the authoritative catalogue of runtime config keys
 */

import type MapPosition from './map/position';
import type MapStyle from './map/style';
import type { TransformRequestCallback } from './types';


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

    rendererAnisotropic: number;
    rendererAntialiasing: boolean;
    rendererAllowScreenshots: boolean;
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
