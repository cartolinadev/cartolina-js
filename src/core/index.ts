/**
 * Core build entry point.
 *
 * Exports the `map()` factory and all utility symbols consumed by
 * core build consumers. This is the public surface of the headless
 * build — do not add browser-layer symbols here.
 */

import proj4 from 'proj4';
import earcut from 'earcut';
import { getCoreVersion, checkSupport } from './core';
import { vec2, vec3, vec4, mat3, mat4 } from './utils/matrix';
import * as utils from './utils/utils';
import * as math from './utils/math';
import { platform } from './utils/platform';
import MapClass from './map';
import { warnOnce } from './utils/utils';

import type { CoreConfig } from './types';

export type { default as Map } from './map';


/**
 * Create a `Map` instance for the given canvas element.
 *
 * @param element canvas element or its DOM id
 * @param config engine configuration
 * @returns `Map` instance, or null if WebGL is not supported
 */
export function map(
    element: HTMLElement | string,
    config?: Partial<CoreConfig>,
): MapClass | null {

    const el = typeof element === 'string'
        ? document.getElementById(element)
        : element;

    if (!el || !checkSupport()) return null;
    return new MapClass(el, config ?? {});
}


/**
 * @deprecated Use `map()` instead.
 */
export function core(
    element: HTMLElement | string,
    config?: Partial<CoreConfig>,
): MapClass | null {

    __DEV__ && warnOnce(
        '[core] core() is deprecated. Use map() instead.',
    );
    return map(element, config);
}


export {
    vec2, vec3, vec4, mat3, mat4,
    math, utils,
    getCoreVersion, checkSupport,
    proj4, earcut, platform,
};
