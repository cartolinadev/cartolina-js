// Browser-build CSS must be imported from the browser entry so webpack keeps
// the stylesheet in the dist output regardless of wrapper refactors.
import './browser.css';
import './presenter/css/main.css';
import './presenter/css/panel.css';
import './presenter/css/subtitles.css';

import Viewer from './viewer';
export type { default as Map } from './viewer';
import MapStyle from '../core/map/style';
import MapPosition from '../core/map/position';
import {getCoreVersion, checkSupport} from '../core/core';

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


/** The canonical shared option value type used for cartolina runtime options. */
export type MapRuntimeOptionValue =
    boolean | number | number[] | string | string[] | null;

/**
 * The canonical shared options object for browser, core, renderer, and
 * debug runtime settings.
 *
 * This type intentionally excludes structural initialization fields such as
 * `container`, `style`, `map`, `position`, and `view`, which belong to
 * the entrypoint-specific wrappers.
 */
export type MapRuntimeOptions = Record<string, MapRuntimeOptionValue>;

/** The preferred style-based initialization options object. */

export type MapOptions = {

    /** the HTML Element in which cartolina will render the map */
    container: HTMLElement | string,

    /**
     * The map style, conforming to the style specification. Either a JSON
     * or a URL pointing to such an object.
     */
    style: MapStyle.StyleSpecification,

    /**
     * The 10-component vts-geospatial position, specifying the intial
     * vantage point. If not provided, cartolina will try to find a
     * suitable default.
     */
    position: MapPosition,

    /**
     * Any of the valid options controling the various rendering
     * components (browser, core, renderer, etc.)
     */
    options?: MapRuntimeOptions
}

/**
 * The style based API for map initialization.
 *
 * @param options the options object
 * @return the browser interface
 */

export function map(options: MapOptions): Viewer | null {

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
        position: options.position
    });

    // return
    return (vi as any)._core ? vi : null;
}

/**
 * The legacy mapConfig-based initialization options object.
 *
 * Prefer the style-based `map` API for new code.
 */
export type BrowserConfig = MapRuntimeOptions & {

    /** The legacy vts-geospatial mapConfig, usually as a URL. */
    map: string | Record<string, unknown>,

    /**
     * The 10-component vts-geospatial position, specifying the initial
     * vantage point.
     */
    position?: MapPosition,

    /** The legacy view definition. */
    view?: Record<string, unknown>
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
): Viewer | null {

    var vi = new Viewer(element, config);
    return (vi as any)._core ? vi : null;
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
 * so the result can be explicitly typed as `MapRuntimeOptions`.
 *
 * @param defaults initial runtime option values to merge with URL parameters
 * @param url the URL to parse, defaults to `window.location.href`
 * @param options parsing options such as map parameter requirements
 * @return runtime options parsed from the query string
 */
export function runtimeOptionsFromUrl(
    defaults?: MapRuntimeOptions,
    url?: string,
    options?: UrlConfigOptions
): MapRuntimeOptions {
    return runtimeOptionsFromUrl_(defaults, url, options) as MapRuntimeOptions;
}

/**
 * Converts URL query parameters into cartolina configuration values for
 * the legacy `browser` API.
 *
 * This helper parses the same runtime option vocabulary as
 * `runtimeOptionsFromUrl`, but it also preserves legacy structural
 * fields such as `map`, `position`, and `view` when present in the URL
 * or defaults.
 *
 * @param defaults initial values to merge with URL parameters
 * @param url the URL to parse, defaults to `window.location.href`
 * @param options parsing options such as map parameter requirements
 * @return config object with parsed query parameter values
 */
export function configFromUrl(
    defaults?: MapRuntimeOptions & Partial<BrowserConfig>,
    url?: string,
    options?: UrlConfigOptions
): MapRuntimeOptions & Partial<BrowserConfig> {
    return configFromUrl_(defaults, url, options) as
        MapRuntimeOptions & Partial<BrowserConfig>;
}

export {vec2, vec3, vec4, mat3, mat4, math, utils, getCoreVersion, checkSupport,
    proj4, earcut, platform, dom};
