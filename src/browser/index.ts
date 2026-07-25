// Browser-build CSS must be imported from the browser entry so webpack keeps
// the stylesheet in the dist output regardless of wrapper refactors.
import './browser.css';
import './presenter/css/main.css';
import './presenter/css/panel.css';
import './presenter/css/subtitles.css';

import Viewer from './viewer';

import * as viewerConfig from '../core/viewer-config';


/** The public map object: the `Viewer` class, exported as `Map`. */
export type { default as Map } from './viewer';

/**
 * The legacy mapConfig-to-style converter lives at the `cartolina/compat`
 * entry point (`src/compat/index.ts`), not here, so applications that
 * only construct maps from styles do not pay for it at build time.
 */

/*
 * The barrel exports no bare type names. The named public type
 * vocabulary is reached through the `Map` namespace — `Map.Options`,
 * `Map.PositionInput`, `Map.OverlaySpec`, `Map.ViewerEventMap`,
 * `Map.PublicRuntimeConfig`. See AGENTS.md, "Declaration merging for
 * exported types".
 */

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

export function map(options: Viewer.Options): Viewer {

    for (const key of Object.keys(options)) {

        if (!mapOptionKeys.has(key)) {
            throw new Error(`'${key}' is not a valid map() option.`);
        }
    }

    // reject typos and invented keys loudly; catalogued keys
    // outside the typed surface pass (query-string vocabulary)
    if (options.options)
        viewerConfig.assertCataloguedConfigKeys(options.options);

    // all browser controls are disabled by default on the style api
    let dflts = {

        "controlMeasure": false
        , "jumpAllowed": true
        , "controlSearch": false
        , "controlZoom": false
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

// Defined in url-config; re-exported here as public API.
export { runtimeOptionsFromUrl } from './url-config';
