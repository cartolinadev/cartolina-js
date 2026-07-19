
import Map from '../core/map';
import ConfigStore from '../core/config-store';
import * as viewerConfig from '../core/viewer-config';
import {GpuDevice} from '../core/renderer/gpu/device';
import * as utils from '../core/utils/utils';
import UI_ from './ui/ui';
import Autopilot_ from './autopilot/autopilot';
import ControlMode_ from './control-mode/control-mode';
import Presenter_ from './presenter/presenter';
import Rois_ from './rois/rois';

//get rid of compiler mess
var UI = UI_;
var Autopilot = Autopilot_;
var ControlMode = ControlMode_;
var Presenter = Presenter_;
var Rois = Rois_;

var Browser = function(element, config) {
    this.killed = false;

    // the single normalized config store; `this.config` aliases its
    // live value map so legacy readers share one object
    this.configStore = new ConfigStore(viewerConfig.defaultViewerConfig());
    this.config = this.configStore.values;

    this.element = (typeof element === 'string') ? document.getElementById(element) : element;

    // Ensure the container establishes a positioning context for .vts-browser (absolute)
    if (this.element && window.getComputedStyle(this.element).position === 'static') {
        // Do not clobber an explicit author choice
        this.element.style.position = 'relative';
    }

    this.applyConfigParams(config);

    if (!GpuDevice.checkSupport()) {
        throw new Error('cartolina-js requires WebGL2.');
    }

    this.ui = new UI(this, this.element);

    element = (typeof element !== 'string') ? element : document.getElementById(element);

    this.map = new Map(this.ui.getMapControl().getMapElement().getElement(), this.configStore);

    this.updatePosInUrl = false;
    this.lastUrlUpdateTime = false;
    this.mapLoaded = false;
    this.mapInteracted = false;

    this.autopilot = new Autopilot(this);
    this.rois = new Rois(this);
    this.controlMode = new ControlMode(this, this.ui);
    this.presenter = new Presenter(this, config);

    // unsubscribe closures for every listener registered below;
    // drained in kill()
    this.unsubscribes = [
        this.on('map-loaded', this.onMapLoaded.bind(this)),
        this.on('map-unloaded', this.onMapUnloaded.bind(this)),
        this.on('map-update', this.onMapUpdate.bind(this)),
        this.on('map-position-changed', this.onMapPositionChanged.bind(this)),
        this.on('map-position-fixed-height-changed', this.onMapPositionFixedHeightChanged.bind(this)),
        this.on('map-position-panned', this.onMapPositionPanned.bind(this)),
        this.on('map-position-rotated', this.onMapPositionRotated.bind(this)),
        this.on('map-position-zoomed', this.onMapPositionZoomed.bind(this)),
        this.on('tick', this.onTick.bind(this))
    ];

    this.watchConfig();
};


// UI control visibility keys; each change refreshes its panel
// through the matching `UI.setParam` case
var uiControlKeys = [
    'controlCompass', 'controlZoom', 'controlMeasure', 'controlScale',
    'controlLayers', 'controlSpace', 'controlSearch', 'controlLink',
    'controlLogo', 'controlFullscreen', 'controlCredits'
];


/* Registers the browser-layer config watchers: UI panel refreshes for
 * the control* keys and autopilot updates for autoRotate / autoPan.
 * Unsubscribe closures join `this.unsubscribes`. */
Browser.prototype.watchConfig = function() {
    var self = this;

    uiControlKeys.forEach(function(key) {
        self.unsubscribes.push(self.configStore.watch([key], function() {
            self.updateUI(key);
        }));
    });

    this.unsubscribes.push(this.configStore.watch(
        ['autoRotate', 'autoPan'],
        function(values) {
            if (self.getMap() && self.autopilot) {
                self.autopilot.setAutorotate(values.autoRotate);
                self.autopilot.setAutopan(
                    values.autoPan[0], values.autoPan[1]);
            }
        }));
};


Browser.prototype.kill = function() {
    for (var i = 0; i < this.unsubscribes.length; i++) {
        this.unsubscribes[i]();
    }
    this.unsubscribes = [];
    this.ui.kill();
    this.killed = true;
};


/** @returns {import('../core/map').default} */
Browser.prototype.getCore = function() {
    return this.map;
};


/** @returns {import('../core/map/map').default | null} */
Browser.prototype.getMap = function() {
    return this.map.legacyMap;
};


Browser.prototype.getRenderer = function() {
    return this.map.renderer;
};



Browser.prototype.getUI = function() {
    return this.ui;
};


Browser.prototype.setControlMode = function(mode) {
    this.controlMode = mode;
};


Browser.prototype.getControlMode = function() {
    return this.controlMode;
};


Browser.prototype.on = function(name, listener) {
    return this.map.on(name, listener);
};


Browser.prototype.onMapLoaded = function() {
    this.mapLoaded = true;

    if (this.autopilot) {
        this.autopilot.setAutorotate(this.config.autoRotate);
        this.autopilot.setAutopan(this.config.autoPan[0], this.config.autoPan[1]);
    }
};


Browser.prototype.getLinkWithCurrentPos = function() {
    var map = this.getMap();
    if (!map) {
        return '';
    }

    //get url params
    var params = utils.getParamsFromUrl(window.location.href);
    
    //get position string
    var p = map.getPosition();
    p = map.convertPositionHeightMode(p, 'fix', true);
    
    var s = '';
    s += p.getViewMode() + ',';
    var c = p.getCoords();
    s += c[0].toFixed(6) + ',' + c[1].toFixed(6) + ',' + p.getHeightMode() + ',' + c[2].toFixed(2) + ',';
    var o = p.getOrientation();
    s += o[0].toFixed(2) + ',' + o[1].toFixed(2) + ',' + o[2].toFixed(2) + ',';
    s += p.getViewExtent().toFixed(2) + ',' + p.getFov().toFixed(2);

    //replace old value with new one    
    params['pos'] = s;

    if (this.mapInteracted) {
        if (params['rotate'] || this.configStore.get('autoRotate')) {
            params['rotate'] = '0';
        }
        
        var pan = this.configStore.get('autoPan');
        if (params['pan'] || (pan && (pan[0] || pan[1]))) {
            params['pan'] = '0,0';
        }
    }
    
    //convert prameters to url parameters string
    s = '';
    for (var key in params) {
        s += ((s.length > 0) ? '&' : '') + key + '=' + params[key];
    }

    //separete base url and url params
    var urlParts = window.location.href.split('?');
    
    if (urlParts.length > 1) {
        var extraParts = urlParts[1].split('#'); //is there anchor?
        return urlParts[0] + '?' + s + (extraParts[1] || ''); 
    } else {
        return urlParts[0] + '?' + s; 
    }
};


Browser.prototype.onMapPositionChanged = function() {
    if (this.config.positionInUrl) {
        this.updatePosInUrl = true;
    }
};


Browser.prototype.onMapPositionPanned = function() {
    this.mapInteracted = true;
};


Browser.prototype.onMapPositionRotated = function() {
    this.mapInteracted = true;
};


Browser.prototype.onMapPositionZoomed = function() {
    this.mapInteracted = true;
};


Browser.prototype.onMapPositionFixedHeightChanged = function() {
    if (this.config.positionInUrl) {
        this.updatePosInUrl = true;
    }
};


Browser.prototype.onMapUnloaded = function() {
};


Browser.prototype.onMapUpdate = function() {
    this.dirty = true;
};


Browser.prototype.onTick = function() {
    if (this.killed) {
        return;
    }

    this.autopilot.tick();
    this.ui.tick(this.dirty);
    this.dirty = false;
    
    if (this.updatePosInUrl) {
        var timer = performance.now(); 
        if ((timer - this.lastUrlUpdateTime) > 1000) {
            if (window.history.replaceState) {
                window.history.replaceState({}, null, this.getLinkWithCurrentPos());
            }        
            this.updatePosInUrl = false;
            this.lastUrlUpdateTime = timer;
        }
    }
};


/**
 * Applies a bag of raw caller config inputs through
 * applyConfigParam.
 */
Browser.prototype.applyConfigParams = function(params) {
    if (typeof params === 'object' && params !== null) {
        for (var key in params) {
            this.applyConfigParam(key, params[key]);
        }
    }
};


Browser.prototype.updateUI = function(key) {
    if (this.ui == null) {
        return;
    }

    this.ui.setParam(key);
};


/**
 * Applies one raw config input: alias resolution, normalization,
 * the store write, and the position command.
 */
Browser.prototype.applyConfigParam = function(key, value) {
    var patch = viewerConfig.normalizeConfigPatch(key, value);
    if (!patch) {
        // a dropped key carrying a config prefix is probably a
        // misspelling; unrelated bag entries stay silent
        if (viewerConfig.looksLikeConfigKey(key)) {
            console.warn('Unknown configuration key \'' + key
                + '\'; ignored.');
        }
        return;
    }

    this.configStore.set(patch);

    // position is a command: it acts on the loaded map immediately
    // instead of waiting for a watcher flush
    var legacyMap = this.map ? this.getMap() : null;
    if (legacyMap) {
        if ('position' in patch && patch.position != null) {
            legacyMap.setPosition(patch.position);
        }
    }
};



export default Browser;
