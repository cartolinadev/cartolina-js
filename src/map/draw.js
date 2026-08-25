
import * as math from '../utils/math';
import MapGeodata from './geodata';
import MapGeodataView from './geodata-view';
import MapDrawTiles from './draw-tiles';
import * as vts from '../constants';


var MapDraw = function(map) {
    this.map = map;
    this.config = map.config;
    this.isGeocent = map.isGeocent;

    this.renderer = map.renderer;
    this.camera = map.camera;

    this.ndcToScreenPixel = 1.0;

    this.drawCounter = 0;

    this.planetRadius = this.isGeocent ? map.getNavigationSrs().getSrsInfo()['a'] : 100;
    this.processBuffer = new Array(60000);
    this.processBuffer2 = new Array(60000);
    this.drawBuffer = new Array(60000);
    this.tmpVec3 = new Array(3);
    this.tmpVec5 = new Array(5);
    this.bboxBuffer = new Float32Array(8*3);

    var gpu = this.renderer.gpu;
    this.drawTileState = gpu.createState({});

    this.degradeHorizonFactor = 0;
    this.degradeHorizonTiltFactor = 0;

    this.drawTiles = new MapDrawTiles(map, this);

};


/**
 * Reset draw-owned state at the start of a render pass.
 */
MapDraw.prototype.initFrame = function() {

    this.degradeHorizonFactor =
        200.0 * this.config.mapDegradeHorizonParams[0];
    this.degradeHorizonTiltFactor = 0.5 * (
        1.0 + Math.cos(math.radians(Math.min(
            180,
            Math.abs(this.renderer.cameraOrientation[1] * 2 * 3)
        )))
    );
    this.setupDetailDegradation();

    // Tile resolution is driven by the apparent (CSS) size of the map.
    // Using apparent size also keeps the color pass and the auxiliary
    // depth pass consistent, since the auxiliary target inherits the
    // canvas apparent size while keeping its own storage resolution.
    this.ndcToScreenPixel =
        this.renderer.gpu.currentRenderTarget.apparentSize[0] * 0.5;
    this.maxGpuUsed = Math.max(
        32 * 102 * 1204,
        this.map.gpuCache.getMaxCost() - 32 * 102 * 1204
    );
    this.drawTileCounter = 0;
};


MapDraw.prototype.drawGeodataHitmap = function() {
    this.map.outerMap.withSelectionCamera(function() {

        this.renderer.gpu.setState(this.drawTileState);
        this.renderer.beginPass('geo');
        this.renderer.draw.drawGpuJobs(
            this.map.outerMap.getSelectionPosition());

        if (this.renderer.advancedPassNeeded) {
            this.renderer.beginPass('geo2');
            this.renderer.draw.drawGpuJobs(
                this.map.outerMap.getSelectionPosition());
        }

        this.renderer.beginPass('base');
        this.map.geoHitMapDirty = false;
    }.bind(this));
};

MapDraw.prototype.areDrawCommandsReady = function(commands, priority, doNotLoad, doNotCheckGpu) {
    var ready = true;
    var checkGpu = doNotCheckGpu ? true : false;

    for (var i = 0, li = commands.length; i < li; i++) {
        var command = commands[i];

        if (command.type === vts.DRAWCOMMAND_GEODATA) {
            var geodataView = command.geodataView;

            if (!(geodataView && geodataView.isReady(
                doNotLoad, priority, checkGpu))) {

                ready = false;
            }
        }
    }

    return ready;
};


MapDraw.prototype.processDrawCommands = function(cameraPos, commands, priority, doNotLoad, tile) {
    if (commands.length > 0) {
        this.drawTileCounter++;
    }

    for (var i = 0, li = commands.length; i < li; i++) {
        var command = commands[i];

        if (command.type === vts.DRAWCOMMAND_GEODATA) {
            var geodataView = command.geodataView;

            if (geodataView && geodataView.isReady(
                doNotLoad, priority, true)) {

                geodataView.draw(cameraPos);
            }
        }
    }
};


MapDraw.prototype.drawMonoliticGeodata = function(surface) {
    if (!surface) {
        return;
    }

    if (!this.camera.camera.bboxVisible(surface.extents, this.camera.position)) {
        return;
    }

    var path;

    if (surface.monoGeodata == null) {
        if (typeof surface.geodataUrl === 'object') {
            path = surface.geodataUrl;
        } else {
            path = surface.getMonoGeodataUrl(surface.id);
        }

        surface.monoGeodata = new MapGeodata(this.map, path, {tile:null, surface:surface});
    }

    if (surface.monoGeodataCounter != surface.geodataCounter) {
        surface.monoGeodataView = null;
        surface.monoGeodataCounter = surface.geodataCounter;
    }

    if (surface.monoGeodata.isReady(null, null, null)) {

        if (!surface.monoGeodataView) {
            surface.monoGeodataView = new MapGeodataView(this.map, surface.monoGeodata, {tile:null, surface:surface});
        }
        
        if (surface.monoGeodataView.isReady()) {
            var mapdataCredits = this.map.visibleCredits.mapdata

            for (var i = 0, li = surface.credits.length; i < li; i++) {
                var key = surface.credits[i]
                var value = 1; //fixed specificity
                var value2 = mapdataCredits[key];

                if (value2) {
                    mapdataCredits[key] = value > value2 ? value : value2;
                } else {
                    mapdataCredits[key] = value;
                }
            }

            this.map.outerMap.withNavigationCamera(function() {
                surface.monoGeodataView.draw(this.camera.position);
            }.bind(this));
        }
    }
};


MapDraw.prototype.setupDetailDegradation = function(degradeMore) {
    var factor = 0;
    
    if (this.map.mobile) {
        //factor = this.config.mapMobileDetailDegradation;
        //console.log(factor);
    }

    if (degradeMore) {
        factor += degradeMore;
    }

    this.texelSizeFit = this.config.mapTexelSizeFit * Math.pow(2,factor);

    //console.log("TexelSizeFit: %f", this.texelSizeFit);
};


export default MapDraw;
