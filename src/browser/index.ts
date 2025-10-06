
import BrowserInterface from './interface';
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


/**
 * The {@link map} options object
 */

export type MapOptions = {

    /**
     * the HTML Element in which cartolina will render the map
     */
    container: HTMLElement | string,

    /**
     * The map style, conforming to the style specification. Either a JSON or
     * a URL pointing to such an object.
     */
    style: MapStyle.StyleSpecification,

    /**
     * The 10-component vts-geospatial position, specifying the intial vantage point.
     * If not provided, cartolina will try to find a suitable default.
     */
    position: MapPosition,

    /**
     * Any of the valid options controling the various rendering components
     * (browser, core, renderer, etc.)
     */
    options?: { string: number | number[] | string | boolean }
}


/**
 * The style based API for map initialization.
 *
 * @param options the options object
 * @return the browser interface
 */

export function map(options: MapOptions): BrowserInterface {

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

    let bi = new BrowserInterface(
        options.container, {
            style: options.style, ...dflts, ...options.options, position: options.position});

    // return
    return bi.core ? bi: null;
}


/**
 * The traditional vts-geospatial mapConfig-based API for map
 * initialization.
 *
 * @param element the DOM element mean for the map
 * @param config the map configuration, which includes the mapConfig, the
 *      JSON object containing the map configuration, optional position
 *      and various browser options.
 * @return the browser interface
 */

export function browser (element: HTMLElement | string, config: {
    map: unknown, position?: MapPosition, string: any }): BrowserInterface {

    var browserInterface = new BrowserInterface(element, config);
    return browserInterface.core ? browserInterface : null;
}

export function getBrowserVersion() {
//    return "Browser: 2.0.0, Core: " + getCoreVersion();
    return '' + getCoreVersion();
}

export {vec2, vec3, vec4, mat3, mat4, math, utils, getCoreVersion, checkSupport,
    proj4, earcut, platform, dom};
