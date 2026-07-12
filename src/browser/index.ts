// Browser-build CSS must be imported from the browser entry so webpack keeps
// the stylesheet in the dist output regardless of wrapper refactors.
import './browser.css';
import './presenter/css/main.css';
import './presenter/css/panel.css';
import './presenter/css/subtitles.css';

import Viewer from './viewer';
export type { default as Map } from './viewer';
import MapStyle from '../core/map/style';
import getVersion from '../core/version.js';

import proj4 from 'proj4';
import earcut from 'earcut';
import {vec2, vec3, vec4, mat3, mat4} from '../core/utils/matrix';
import * as utils from '../core/utils/utils';
import * as math from '../core/utils/math';
import {platform} from '../core/utils/platform';
import dom from './utility/dom';
import {
    configFromUrl as configFromUrl_,
    runtimeOptionsFromUrl as runtimeOptionsFromUrl_,
    UrlConfigOptions
} from './url-config';
import type {
    PositionInput,
    RequestResourceType,
    RequestTransformResult,
    TransformRequestCallback,
} from '../core/types';
import {
    assertCataloguedConfigKeys,
    type PublicConstructionConfig,
} from '../core/viewer-config';


export type {
    PositionInput,
    RequestResourceType,
    RequestTransformResult,
    TransformRequestCallback,
};

/**
 * `PublicRuntimeConfig` is the runtime configuration map accepted
 * and returned by `Viewer.setParam` and `Viewer.getParam`;
 * `PublicConstructionConfig` is the wider option bag accepted by
 * the factory functions. Both are also reachable through the
 * exported `Map` alias.
 */
export type {
    PublicRuntimeConfig,
    PublicConstructionConfig,
} from '../core/viewer-config';

/** The preferred style-based initialization options object. */

export type MapOptions = {

    /** the HTML Element in which cartolina will render the map */
    container: HTMLElement | string,

    /**
     * The map style, conforming to the style specification. Either a
     * parsed style object or a URL pointing to one.
     */
    style: string | MapStyle.StyleSpecification,

    /**
     * The 10-component vts-geospatial position, specifying the intial
     * vantage point. If not provided, cartolina will try to find a
     * suitable default.
     */
    position?: PositionInput,

    /**
     * Runtime and construction configuration values; the valid keys
     * and their types are defined by `PublicConstructionConfig`.
     */
    options?: PublicConstructionConfig,

    /** Optional hook for rewriting resource URLs or adding request headers. */
    transformRequest?: TransformRequestCallback,

    /**
     * When `false`, cartolina registers no mouse, keyboard, or touch
     * event listeners on the map element. The application is responsible
     * for all camera control. Mirrors the MapLibre GL JS convention.
     * Defaults to `true`.
     */
    interactive?: boolean,
}

// the modern factory's complete public shape; a top-level key
// outside this set throws so a JavaScript typo fails loudly
const mapOptionKeys = new Set([
    'container', 'style', 'position', 'options',
    'transformRequest', 'interactive',
]);

/**
 * The style based API for map initialization.
 *
 * @param options the options object
 * @return the browser interface
 */

export function map(options: MapOptions): Viewer {

    for (const key of Object.keys(options)) {

        if (!mapOptionKeys.has(key)) {
            throw new Error(`'${key}' is not a valid map() option.`);
        }
    }

    // reject typos and invented keys loudly; catalogued keys
    // outside the typed surface pass (query-string vocabulary)
    if (options.options) assertCataloguedConfigKeys(options.options);

    // all browser controls are disabled by default on the style api
    let dflts = {

        "controlMeasure": false
        , "jumpAllowed": true
        , "controlSearch": false
        , "controlZoom": false
        , "controlFalback": false
        , "controlSpace": false
        , "controlCompass": false
    }

    let vi = new Viewer(options.container, {
        style: options.style,
        ...dflts,
        ...options.options,
        position: options.position,
        transformRequest: options.transformRequest,
        interactive: options.interactive ?? true,
    });

    return vi;
}

/**
 * The legacy mapConfig-based initialization options object.
 *
 * Prefer the style-based `map` API for new code.
 */
export type BrowserConfig = PublicConstructionConfig & {

    /** The legacy vts-geospatial mapConfig, usually as a URL. */
    map: string | Record<string, unknown>,

    /**
     * The 10-component vts-geospatial position, specifying the initial
     * vantage point.
     */
    position?: PositionInput,

    /** The legacy view definition. */
    view?: string | Record<string, unknown>,

    /** Optional hook for rewriting resource URLs or adding request headers. */
    transformRequest?: TransformRequestCallback
};


/**
 * The legacy vts-geospatial mapConfig-based API for map
 * initialization.
 *
 * Prefer the style-based `map` API for new code.
 *
 * @param element the DOM element mean for the map
 * @param config the legacy map configuration, which includes the mapConfig,
 *      the JSON object containing the map configuration, optional
 *      position and various browser options.
 * @return the browser interface
 */

export function browser(
    element: HTMLElement | string,
    config: BrowserConfig
): Viewer {

    var vi = new Viewer(element, config);
    return vi;
}

/**
 * Returns the core library version.
 * @return the core library version
 */
function getCoreVersion(full?: boolean): string {
    return (full ? 'Core: ' : '') + getVersion();
}

/**
 * Returns the core library version.
 * @return the core library version
 */
export function getBrowserVersion(): string {
    return '' + getCoreVersion();
}

/**
 * Converts URL query parameters into runtime options for the preferred
 * style-based `map` API.
 *
 * This is mainly intended for simple demos and applications that want to
 * accept browser, core, renderer, or debug options from the query
 * string without maintaining their own parsing table.
 *
 * Unlike `configFromUrl`, this helper removes structural fields
 * such as `map`, `position`, `pos`, `view`, `style`, and `container`,
 * so the result can be passed as the `map()` factory's `options`.
 *
 * The URL vocabulary is wider than `PublicConstructionConfig`: the
 * query string is a permissive ingestion boundary, and parsed
 * internal or debug keys still apply at runtime even though the
 * returned type does not declare them.
 *
 * @param defaults initial runtime option values to merge with URL parameters
 * @param url the URL to parse, defaults to `window.location.href`
 * @param options parsing options such as map parameter requirements
 * @return runtime options parsed from the query string
 */
export function runtimeOptionsFromUrl(
    defaults?: PublicConstructionConfig,
    url?: string,
    options?: UrlConfigOptions
): PublicConstructionConfig {

    return runtimeOptionsFromUrl_(
        defaults as Record<string, unknown>, url, options
    ) as PublicConstructionConfig;
}

/**
 * Converts URL query parameters into cartolina configuration values for
 * the legacy `browser` API.
 *
 * This helper parses the same runtime option vocabulary as
 * `runtimeOptionsFromUrl`, but it also preserves legacy structural
 * fields such as `map`, `position`, and `view` when present in the URL
 * or defaults. The same permissive-boundary note applies: parsed
 * internal or debug keys still apply at runtime even though the
 * returned type does not declare them.
 *
 * @param defaults initial values to merge with URL parameters
 * @param url the URL to parse, defaults to `window.location.href`
 * @param options parsing options such as map parameter requirements
 * @return config object with parsed query parameter values
 */
export function configFromUrl(
    defaults?: Partial<BrowserConfig>,
    url?: string,
    options?: UrlConfigOptions
): Partial<BrowserConfig> {

    return configFromUrl_(
        defaults as Record<string, unknown>, url, options
    ) as Partial<BrowserConfig>;
}

export {vec2, vec3, vec4, mat3, mat4, math, utils, getCoreVersion,
    proj4, earcut, platform, dom};
