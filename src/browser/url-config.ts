import * as utils from '../core/utils/utils';
import * as viewerConfig from '../core/viewer-config';


type ParsedConfigValue =
    boolean | number | number[] | string | string[] | null | unknown;
type ParsedConfig = Record<string, ParsedConfigValue>;

// keys the runtime-options filter excludes: structural inputs with
// dedicated factory options, plus `mapConfig`, the query parameter
// the demo applications read themselves
const STRUCTURAL_KEYS = new Set([
    'map',
    'mapConfig',
    'position',
    'pos',
    'view',
    'style',
    'container'
]);


// URL-layer aliases for historic query-parameter misspellings; the
// canonical `pos` / `rotate` / `pan` aliases resolve in
// `canonicalConfigKey`
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


/**
 * Parses one query-string value by the URL parse kind of its
 * catalogue spec. Uncatalogued keys pass through unparsed; they
 * are filtered later by the catalogue guards.
 */
export function parseConfigParamValue(
    key: string,
    value: unknown,
): ParsedConfigValue {

    if (Array.isArray(value)) {
        return value.map((item) => parseConfigParamValue(key, item));
    }

    switch (viewerConfig.urlParseKind(key)) {
        case 'position': return parsePosition(value);
        case 'boolean': return parseBoolean(value);
        case 'number': return parseNumber(value);
        case 'numberArray': return parseNumberArray(value);
        case 'string': return parseString(value);
        default: return value;
    }
}


export function runtimeOptionsFromUrl(
    defaults?: ParsedConfig,
    url?: string,
): ParsedConfig {
    const config: ParsedConfig = Object.assign({}, defaults || {});
    const sourceUrl = url || window.location.href;
    const params =
        utils.getParamsFromUrl(sourceUrl) as Record<string, unknown>;

    for (const rawKey in params) {
        // own-property lookup: a query key such as `toString` must
        // not resolve to an inherited Object.prototype member
        const key =
            Object.prototype.hasOwnProperty.call(KEY_ALIASES, rawKey)
                ? KEY_ALIASES[rawKey] : rawKey;

        const parsed = parseConfigParamValue(key, params[rawKey]);
        if (parsed !== undefined) config[key] = parsed;
    }

    const runtimeOptions: ParsedConfig = {};

    // keep catalogued keys only: query strings carry arbitrary
    // parameters, and the result feeds the strict `map()` factory
    for (const key in config) {

        if (STRUCTURAL_KEYS.has(key)) continue;

        if (viewerConfig.canonicalConfigKey(key) !== null) {
            runtimeOptions[key] = config[key];
        } else if (viewerConfig.looksLikeConfigKey(key)) {
            console.warn(
                `Unknown configuration key '${key}' in the URL; `
                + 'ignored.');
        }
    }

    return runtimeOptions;
}
