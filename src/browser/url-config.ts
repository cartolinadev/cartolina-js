import * as utils from '../core/utils/utils';


export type UrlConfigOptions = {
    mapParam?: string;
    mapConfigSuffix?: string;
    requireMap?: boolean;
};

type ParsedConfigValue = boolean | number | number[] | string | string[] | null | unknown;
type ParsedConfig = Record<string, ParsedConfigValue>;

const STRUCTURAL_KEYS = new Set([
    'map',
    'position',
    'pos',
    'view',
    'style',
    'container'
]);


const BOOLEAN_KEYS = new Set([
    'panAllowed',
    'rotationAllowed',
    'zoomAllowed',
    'jumpAllowed',
    'constrainCamera',
    'positionInUrl',
    'positionUrlHistory',
    'controlCompass',
    'controlZoom',
    'controlMeasure',
    'controlScale',
    'controlLayers',
    'controlSpace',
    'controlSearch',
    'controlSearchFilter',
    'controlLink',
    'controlGithub',
    'controlMeasureLite',
    'controlLogo',
    'controlFullscreen',
    'controlCredits',
    'controlLoading',
    'screenshot',
    'legacyInertia',
    'timeNormalizedInertia',
    'bigScreenMargins',
    'walkMode',
    'mapVirtualSurfaces',
    'map16bitMeshes',
    'inspector',
    'mapMobileMode',
    'mapMobileModeAutodect',
    'mapFog',
    'mapFlatshade',
    'mapIgnoreNavtiles',
    'mapAllowHires',
    'mapAllowLowres',
    'mapAllowSmartSwitching',
    'mapDisableCulling',
    'mapPreciseCulling',
    'mapHeightLodBlend',
    'mapHeightNodeBlend',
    'mapBasicTileSequence',
    'mapStoreLoadStats',
    'mapXhrImageLoad',
    'mapGridSurrogatez',
    'mapPreciseBBoxTest',
    'mapPreciseDistanceTest',
    'mapHeightfiledWhenUnloaded',
    'mapForceMetatileV3',
    'mapDegradeHorizon',
    'mapMetricUnits',
    'mapFeaturesSortByTop',
    'mapLogGeodataStyles',
    'mapOnlyOneUVs',
    'mapIndexBuffers',
    'mapCombinedShading',
    'mapSoftViewSwitch',
    'mapAsyncImageDecode',
    'mapSplitMeshes',
    'mapSeparateLoader',
    'mapGeodataBinaryLoad',
    'mapPackLoaderEvents',
    'mapParseMeshInWorker',
    'mapPackGeodataEvents',
    'mapSortHysteresis',
    'mapBenevolentMargins',
    'mapCheckTextureSize',
    'mapTraverseToMeshNode',
    'mapNormalizeOctantTexelSize',
    'mapExposeFpsToWindow',
    'mario',
    'rendererAntialiasing',
    'rendererAllowScreenshots'
]);

const NUMBER_KEYS = new Set([
    'rotate',
    'fixedHeight',
    'minViewExtent',
    'maxViewExtent',
    'mapForcePipeline',
    'mapDMapSize',
    'mapDMapMode',
    'mapDMapCopyIntervalMs',
    'mapDMapDilatePx',
    'mapCache',
    'mapGPUCache',
    'mapMetatileCache',
    'mapTexelSizeFit',
    'mapDownloadThreads',
    'mapMaxProcessingTime',
    'mapMaxGeodataProcessingTime',
    'mapMobileDetailDegradation',
    'mapNavSamplesPerViewExtent',
    'mapGridUnderSurface',
    'mapGridTextureLevel',
    'mapRefreshCycles',
    'mapForceFrameTime',
    'mapFeatureGridCells',
    'mapFeaturesPerSquareInch',
    'mapHysteresisWait',
    'rendererAnisotropic'
]);

const NUMBER_ARRAY_KEYS = new Set([
    'pan',
    'sensitivity',
    'inertia',
    'tiltConstrainThreshold',
    'mapLabelFreeMargins',
    'mapDegradeHorizonParams',
    'mapFeaturesReduceParams',
    'mapFeatureStickMode',
    'mapSplitSpace'
]);

const STRING_KEYS = new Set([
    'map',
    'style',
    'navigationMode',
    'controlSearchUrl',
    'controlSearchSrs',
    'controlSearchElement',
    'controlSearchValue',
    'geodata',
    'tiles3d',
    'geojson',
    'mapLoadMode',
    'mapGeodataLoadMode',
    'mapGridMode',
    'mapGridTextureLayer',
    'mapLanguage',
    'mapDefaultFont',
    'mapFeaturesReduceMode',
    'authorization',
    'sync',
    'syncServer',
    'syncId',
    'debugBBox',
    'debugLBox',
    'debugNoEarth',
    'debugShader',
    'debugHeightmap',
    'debugRadar',
    'view'
]);

const JSON_KEYS = new Set([
    'geojsonStyle'
]);

const KEY_ALIASES: Record<string, string> = {
    zoomAlowed: 'zoomAllowed',
    mapMobileDeatailDegradation: 'mapMobileDetailDegradation'
};


function parseBoolean(value: unknown): boolean {
    return value === true || value === 'true' || value === '1';
}


function parseNumber(value: unknown): number | unknown {
    const parsed = parseFloat(String(value));
    return Number.isFinite(parsed) ? parsed : value;
}


function parseNumberArray(value: unknown): Array<number | unknown> {
    if (Array.isArray(value)) {
        return value.map(parseNumber);
    }

    return decodeURIComponent(String(value)).split(',').map(parseNumber);
}


function parsePosition(value: unknown): Array<number | string | unknown> {
    const items: Array<number | string | unknown> =
        decodeURIComponent(String(value)).split(',');

    for (let i = 1; i < items.length; i++) {
        if (i !== 3) {
            items[i] = parseNumber(items[i]);
        }
    }

    return items;
}


function parseString(value: unknown): string | null {
    const parsed = decodeURIComponent(String(value));
    return parsed === 'null' ? null : parsed;
}


function parseJson(value: unknown): unknown {
    return JSON.parse(decodeURIComponent(String(value)));
}


export function parseConfigParamValue(key: string, value: unknown): ParsedConfigValue {
    if (Array.isArray(value)) {
        return value.map((item) => parseConfigParamValue(key, item));
    }

    if (key === 'pos' || key === 'position') {
        return parsePosition(value);
    }

    if (BOOLEAN_KEYS.has(key)) {
        return parseBoolean(value);
    }

    if (NUMBER_KEYS.has(key)) {
        return parseNumber(value);
    }

    if (NUMBER_ARRAY_KEYS.has(key)) {
        return parseNumberArray(value);
    }

    if (JSON_KEYS.has(key)) {
        return parseJson(value);
    }

    if (STRING_KEYS.has(key) || key.indexOf('debug') === 0) {
        return parseString(value);
    }

    return value;
}


export function configFromUrl(
    defaults?: ParsedConfig,
    url?: string,
    options?: UrlConfigOptions
): ParsedConfig {
    const initialConfig: ParsedConfig = Object.assign({}, defaults || {});
    const sourceUrl = url || window.location.href;
    const params = utils.getParamsFromUrl(sourceUrl) as Record<string, unknown>;
    const settings = Object.assign({
        mapParam: 'map',
        mapConfigSuffix: '/mapConfig.json',
        requireMap: false
    }, options || {});

    for (const rawKey in params) {
        const key = KEY_ALIASES[rawKey] || rawKey;
        initialConfig[key] = parseConfigParamValue(key, params[rawKey]);
    }

    if (settings.requireMap && !initialConfig[settings.mapParam]) {
        throw new Error(`Use query parameter "${settings.mapParam}" to specify the mapConfig location`);
    }

    const map = initialConfig[settings.mapParam];
    if (typeof map === 'string'
            && map !== ''
            && !map.endsWith('mapConfig.json')) {
        initialConfig[settings.mapParam] = map + settings.mapConfigSuffix;
    }

    return initialConfig;
}


export function runtimeOptionsFromUrl(
    defaults?: ParsedConfig,
    url?: string,
    options?: UrlConfigOptions
): ParsedConfig {
    const config = configFromUrl(defaults, url, options);
    const runtimeOptions: ParsedConfig = {};

    for (const key in config) {
        if (!STRUCTURAL_KEYS.has(key)) {
            runtimeOptions[key] = config[key];
        }
    }

    return runtimeOptions;
}
