import Inspector from './inspector/inspector';
import Renderer from './renderer/renderer';

import { normalizeConfigPatch } from './viewer-config';
import * as utils from './utils/utils';
import {utilsUrl} from './utils/url';
import {platform} from './utils/platform';
import getVersion from './version.js';

var Core = function(element, config, bus, configStore) {
    this.killed = false;

    /* Event bus owned by the typed `Map`. Temporary wiring: `Core`
     * publishes only `map-mapconfig-loaded` and `map-unloaded` through
     * it; the field disappears when those emit sites move out of
     * `Core`.
     *
     * @type {import('./event-bus').default<
     *     import('./types').ViewerEventMap>}
     */
    this.bus = bus;

    /* Runtime config store owned by the browser layer, already seeded
     * with the caller's normalized options. `this.config` aliases its
     * live value map; the legacy readers across core, map, and
     * renderer code share that one object.
     *
     * @type {import('./config-store').default<
     *     import('./viewer-config').ViewerConfig>}
     */
    this.configStore = configStore;
    this.config = configStore.values;

    // the caller's raw options; consulted so mapConfig browserOptions
    // never override explicit user configuration
    this.initialConfig = config || {};

    /* Back-pointer to the typed `Map` wrapper. Set by the `Map`
     * constructor immediately after `new Core(...)`, so it is non-null
     * from the first animation frame onwards (rAF runs after the Map
     * constructor returns). `Core.onUpdate` uses it to call `Map.tick`
     * even when `Core.map` is null (async style loading, post-destroy).
     *
     * @type {import('./map').default | null}
     */
    this.outerMap = /** @type {import('./map').default | null} */ (null);

    // ready Promise: resolves once when the map becomes ready ('map-loaded')
    this._readyResolved = false;
    var self = this;
    this.ready = new Promise(function(resolve) { self._resolveReady = resolve; });

    this.element = element;
    this.xhrParams = {};
    this.inspector = (Inspector != null) ? (new Inspector(this)) : null;

    this.map = null;
    this.renderer = new Renderer(this, this.element, this.config);
    this.contextLost = false;

    //platform detection
    platform.init();
    this.requestAnimFrame = (
               window.requestAnimationFrame ||
               window.webkitRequestAnimationFrame ||
               window.mozRequestAnimationFrame ||
               window.oRequestAnimationFrame ||
               window.msRequestAnimationFrame ||
               function(callback) {
                   window.setTimeout(callback, 1000/60);
               });

    window.performance = window.performance || {};
    performance.now = (function() {
        return performance.now       ||
               performance.mozNow    ||
               performance.msNow     ||
               performance.oNow      ||
               performance.webkitNow ||
               function() { return new Date().getTime(); };
    })();

    if (this.config.style) {

        this.loadMapFromStyle(this.config.style);
    }

    if (!this.config.style && this.config.map) {

        this.loadMap(this.config.map);
    }

    this.requestAnimFrame.call(window, this.onUpdate.bind(this));
};

Core.prototype.loadMapFromStyle = async function(style) {

    let style_ = style;
    let path = window.location.href;

    if (typeof(style) === 'string') {

        path = utilsUrl.getProcessUrl(style, path);
        style_ = await utils.loadJson(
            path, this.config.transformRequest, 'Style');

    } else {

        // style is already a parsed object; yield so the Core constructor
        // finishes and outerMap is set before we call createMapFromStyle
        await Promise.resolve();
    }

    // create map
    await this.outerMap.createMapFromStyle(style_, path);

    if (this.config.position) {
        this.map.setPosition(this.config.position);
        this.configStore.set({ position: null });
    }

    // initialize ubos
    this.renderer.createBuffers();
}

Core.prototype.loadMap = function(path) {
    if (this.map != null) {
        this.destroyMap();
    }

    if (path == null) {
        return;
    }

    path = utilsUrl.getProcessUrl(path, window.location.href);

    this.mapConfigData = null;
    this.mapRunnig = false;

    var onLoaded = (function() {
        if (!this.mapConfigData || this.mapRunnig) {
            return;
        }

        this.mapRunnig = true;
        var data = this.mapConfigData;

        this.bus.emit('map-mapconfig-loaded', data);

        this.outerMap.createMapFromMapConfig(data, path);
        this.applyBrowserOptions(this.map.browserOptions);

        if (this.config.position) {
            this.map.setPosition(this.config.position);
            this.configStore.set({ position: null });
        }

        if (this.config.view) {
            this.map.setView(this.config.view);
            this.configStore.set({ view: null });
        }

        this.renderer.createBuffers();

    }).bind(this);

    var onMapConfigLoaded = (function(data) {
        this.mapConfigData = data;
        onLoaded();
    }).bind(this);

    var onMapConfigError = (function() {
    }).bind(this);

    var onLoadMapconfig = (function(path) {
        utils.loadJSON(
            path, onMapConfigLoaded, onMapConfigError, null,
            utils.useCredentials, null, this.config.transformRequest,
            'MapConfig');
    }).bind(this);

    onLoadMapconfig(path);
};


/* Writes the loaded mapConfig's browserOptions to the config store.
 * Keys the caller configured explicitly are skipped, so mapConfig
 * options never override user settings. Position and view flow into
 * the store and are consumed by the load path right after this call. */
Core.prototype.applyBrowserOptions = function(options) {
    if (typeof options !== 'object' || options === null) {
        return;
    }

    for (var key in options) {
        if (typeof this.initialConfig[key] !== 'undefined') {
            continue;
        }

        var patch = normalizeConfigPatch(key, options[key]);
        if (patch) {
            this.configStore.set(patch);
        }
    }
};


Core.prototype.destroy = function() {
    if (this.killed) {
        return;
    }

    this.destroyMap();
    if (this.renderer) {
        this.renderer.kill();
    }
    this.element = null;
    this.killed = true;
};


Core.prototype.destroyMap = function() {
    if (this.map) {
        this.map.kill();
        this.map = null;
        if (this.outerMap) this.outerMap.freeze = null;
        this.bus.emit('map-unloaded', {});
    }
};


Core.prototype.getMap = function() {
    return this.map;
};


Core.prototype.getRenderer = function() {
    return this.renderer;
};


Core.prototype.markDirty = function() {
    if (this.map != null) {
        this.map.markDirty();
    }
};

Core.prototype.onUpdate = function() {

    if (this.killed || this.contextLost) {
        return;
    }

    this.outerMap.tick();
    this.requestAnimFrame.call(window, this.onUpdate.bind(this));
};


/* Resolves the `Map.ready` Promise. Called once per map load by
 * `Map.tick` when the reference frame first becomes ready. Owns only
 * the Promise plumbing — the gate decision lives on `Map`. */
Core.prototype.markReady_ = function(payload) {

    if (this._readyResolved) return;
    this._readyResolved = true;
    if (this._resolveReady) this._resolveReady(payload);
};


/*
string getCoreVersion()

    Returns string with VTS version
*/

function getCoreVersion(full) {

    return (full ? 'Core: ' : '') + getVersion();
}


export {Core,getCoreVersion};
