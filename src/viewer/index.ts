// The browser entry owns the full build's CSS side effects.
import './viewer.css';
import './presenter/css/main.css';
import './presenter/css/panel.css';
import './presenter/css/subtitles.css';

import Viewer from './viewer';


/** The public map object: the `Viewer` class, exported as `Map`. */
export type { default as Map } from './viewer';

/**
 * Creates a map from a style.
 *
 * @param config complete viewer construction configuration
 * @returns the map viewer
 */
export function map(config: Viewer.Config): Viewer {

    return new Viewer(config);
}

export { runtimeOptionsFromUrl } from './url-config';
