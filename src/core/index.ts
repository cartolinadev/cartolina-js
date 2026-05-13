/**
 * Core build entry point.
 *
 * Exports the `core()` factory and all utility symbols consumed by the
 * core build consumer. This is the public surface of the core (headless)
 * build — do not add browser-layer symbols here.
 */

import proj4 from 'proj4';
import earcut from 'earcut';
import { getCoreVersion, checkSupport } from './core';
import { vec2, vec3, vec4, mat3, mat4 } from './utils/matrix';
import * as utils from './utils/utils';
import * as math from './utils/math';
import { platform } from './utils/platform';
import Map from './map';

import type { CoreConfig } from './types';


/**
 * Create a core map instance for the given canvas element.
 *
 * @param element canvas element or its DOM id
 * @param config engine configuration
 * @returns Map instance, or null if WebGL is not supported
 */
function core(
    element: HTMLElement | string,
    config?: Partial<CoreConfig>,
): Map | null {

    const el = typeof element === 'string'
        ? document.getElementById(element)
        : element;

    if (!el || !checkSupport()) return null;
    return new Map(el, config ?? {});
}


export {
    vec2, vec3, vec4, mat3, mat4,
    math, utils,
    getCoreVersion, checkSupport,
    core,
    proj4, earcut, platform,
};
