
import * as math from '../utils/math';
import * as utils from '../utils/utils';
import InspectorInput from './input';
import InspectorStats from './stats';
import InspectorGraphs from './graphs';
import InspectorLayers from './layers';
import InspectorStylesheets from './stylesheets';
import {FreezeMode} from './freeze';


var Inspector = function(core) {
    this.core = core;
    this.enabled = false;
    this.input = new InspectorInput(this);
    this.stats = new InspectorStats(this);
    this.graphs = new InspectorGraphs(this);
    this.layers = new InspectorLayers(this);
    this.stylesheets = new InspectorStylesheets(this);
    this.freeze = new FreezeMode();

    if (this.core.config.inspector || __DEV__) {
        this.input.init();
    }

    this.shakeCamera = false; 
    this.drawRadar = false;
    this.radarLod = null;
    this.debugValue = 0;
    this.measureMode = false;
    this.measurePoints = [];

    if (__DEV__) {
        this.input.diagnosticMode = true;
        this.enableInspector();
    }
};


Inspector.prototype.enableInspector = function() {
    if (!this.enabled) {
        this.stats.init();
        this.graphs.init();
        this.layers.init();
        this.stylesheets.init();

        //load image    
        if (!this.circleImage) {
            this.circleImage = utils.loadImage(
                    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAABmJLR0QAAAAAAAD5Q7t/AAAACW9GRnMAAAAgAAAA4ACD+EAUAAAACXBIWXMAAAsTAAALEwEAmpwYAAAA/UlEQVRYw+2VPwqDMBTG3dz1Am56EnH2XLroETxGuwc3Z7cOdhY8QJpfSUBspUvStJAPPggvD973/uQligICAgL+DKViqygUV02hbaXLwJlio7gpyhNu2idzEXwwgfI8H+u6vnZdN/V9P3EuimLcCRlsiyArGcfxjWDLsmzyAGzc4aNFNDZ7/iw7AeQH4LNrh5WZYLgkJTaZCyHuVVVdkiSZ0zSdOWMzlaBFWkRrQ4A4Zk/A4wBie1MFYUMAz0wybCYAmR8FUAlzj6+2r18TgM2VAO8tOB1Cyk7mrofQ+zP0voheVjHtIBjDxjrmvCu7k1Xs/TP6ie84ICDAGR5uCYdPo0MWiAAAAABJRU5ErkJggg==',
                    //"http://maps.google.com/mapfiles/kml/shapes/placemarkcircle.png",
                    (function(){
                        this.circleTexture = this.core.renderer.createTexture({ 'source': this.circleImage });
                    }).bind(this)
                );
        }

        this.core.on('map-update', this.onMapUpdate.bind(this));
        this.enabled = true;
    }
};


Inspector.prototype.setParameter = function(key, value) {
    this.input.setParameter(key, value);
};

Inspector.prototype.addStyle = function(string) {
    var style = document.createElement('style');
    style.type = 'text/css';
    style.innerHTML = string;
    document.getElementsByTagName('head')[0].appendChild(style);
};


Inspector.prototype.showNotification = function(message) {
    if (!this.notificationEl) {
        this.notificationEl = document.createElement('div');
        this.notificationEl.id = 'vts-notification';
        document.body.appendChild(this.notificationEl);
    }
    this.notificationEl.textContent = message;
    this.notificationEl.style.opacity = '1';
    clearTimeout(this.notificationTimer);
    this.notificationTimer = setTimeout(function() {
        this.notificationEl.style.opacity = '0';
    }.bind(this), 2000);
};


//used to block mouse events
Inspector.prototype.doNothing = function(e) {
    e.stopPropagation();
    return false;
};


Inspector.prototype.preventDefault = function(e) {
    if (e.preventDefault) {
        e.preventDefault();
    } else {
        e.returnValue = false;
    }
};


Inspector.prototype.onMapUpdate = function() {
    var map = this.core.getMapInterface();
    if (!map) {
        return;
    }

    if (this.shakeCamera) {
        map.redraw();
    } 

    /*if (this.measureMode) {
        var renderer = this.core.getRenderer();
        var p = map.convertCoordsFromPhysToNav(this.measurePoints[0]);
        map.convertCoordsFromPhysToCanvas(this.measurePoints[0]);
    }*/

    var renderer = this.core.renderer, i, li, j, lj, p;
    
    if (this.drawRadar && this.circleTexture) {
        //var renderer = this.core.getRendererInterface();
        var pos = map.getPosition();
        var count = 16;
        var step = pos.getViewExtent() / (count * 4);

        var cbuffer = new Array(count * count);

/*        
        var coords = pos.getCoords();

        for (var j = 0; j < count; j++) {
            for (var i = 0; i < count; i++) {
                var screenCoords = map.convertCoordsFromNavToCanvas([coords[0] + i*step - count*0.5*step,
                                                                       coords[1] + j*step - count*0.5*step, 0], "float", this.radarLod);
        
                cbuffer[j * count + i] = screenCoords;
            }            
        }
*/


        for (j = 0; j < count; j++) {
            for (i = 0; i < count; i++) {
                var dx =  i*step - count*0.5*step;
                var dy =  j*step - count*0.5*step;
                var a = Math.atan2(dy, dx);
                var l = Math.sqrt(dx*dx + dy*dy);

                var pos2 = map.movePositionCoordsTo(pos, math.degrees(a), l);
                var coords = pos2.getCoords();
                
                var screenCoords = map.convertCoordsFromNavToCanvas([coords[0], coords[1], 0], 'float', this.radarLod);

                cbuffer[j * count + i] = screenCoords;
            }            
        }


        var lbuffer = new Array(count);

        for (j = 0; j < count; j++) {
            for (i = 0; i < count; i++) {
                lbuffer[i] =  cbuffer[j * count + i];
            }
            
            renderer.drawLineString({
                points : lbuffer,
                size : 2.0,
                screenSpace : true,
                color : [0,255,255,255],
                depthTest : false,
                blend : false
            });            
        }


        for (i = 0; i < count; i++) {
            for (j = 0; j < count; j++) {
                lbuffer[j] =  cbuffer[j * count + i];
            }
            
            renderer.drawLineString({
                points : lbuffer,
                size : 2.0,
                screenSpace : true,
                color : [0,255,255,255],
                depthTest : false,
                blend : false
            });            
        }

        for (i = 0, li = cbuffer.length; i < li; i++) {
            p = cbuffer[i];
            renderer.drawImage({
                rect : [p[0]-10, p[1]-10, 20, 20],
                texture : this.circleTexture,
                color : [255,0,255,255],
                depth : p[2],
                depthTest : false,
                blend : true
            });
        }
    }

};


Inspector.prototype.hasFreezeFrustum = function() {
    return this.freeze.active
            && this.freeze.drawFrustum
            && this.freeze.frustumApex
            && this.freeze.frustumBase;
};


Inspector.prototype.drawFreezeFrustum = function() {
    if (this.hasFreezeFrustum()) {
        var legacyMap = this.core.getMap();
        if (legacyMap) {
            this.core.renderer.drawFrustumPyramid(
                this.freeze.frustumApex,
                this.freeze.frustumBase,
                legacyMap.camera.position);
        }
    }
};


Inspector.prototype.toggleFreeze = function() {
    this.freeze.toggleFrozen(this.core.getMap());
};


Inspector.prototype.resetFreezeView = function() {
    this.freeze.resetView(this.core.getMap());
};


Inspector.prototype.setFreezeControlsActive = function(active) {
    this.freeze.setControlsActive(this.core.getMap(), active);
};


Inspector.prototype.toggleFreezeFrustum = function() {
    this.freeze.toggleFrustum(this.core.getMap(), this.core.renderer);
};


export default Inspector;
