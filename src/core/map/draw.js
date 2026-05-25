
import * as math from '../utils/math';
import MapGeodata from './geodata';
import MapGeodataView from './geodata-view';
import MapDrawTiles from './draw-tiles';
import * as vts from '../constants';


var MapDraw = function(map) {
    this.map = map;
    this.config = map.config;
    this.isProjected = map.getNavigationSrs().isProjected();
    this.isGeocent = map.isGeocent;

    this.renderer = map.renderer;
    this.stats = map.stats;
    this.camera = map.camera;
    this.tree = map.tree;

    this.ndcToScreenPixel = 1.0;


    this.gridFlat = false;
    this.gridGlues = false;
    this.gridSkipped = false;

    this.zFactor = 0;
    this.zFactor2 = 0.003;
    this.zbufferOffset = null;    
    this.zShift = 0;
    this.zLastShift = 0;
    this.bestMeshTexelSize = 1;
    this.bestGeodataTexelSize = 1;
    this.log8 = Math.log(8);
    this.log2 = Math.log(2);

    this.geodataTilesPerLayer = 0;

    this.drawCounter = 0;
    this.drawChannel = 0;
    this.drawChannelNames = ['base', 'hit'];

    this.planetRadius = this.isGeocent ? map.getNavigationSrs().getSrsInfo()['a'] : 100;
    this.tileBuffer = new Array(500);
    this.processBuffer = new Array(60000);
    this.processBuffer2 = new Array(60000);
    this.drawBuffer = new Array(60000);
    this.drawBuffer2 = new Array(60000);
    this.tmpVec3 = new Array(3);
    this.tmpVec5 = new Array(5);
    this.bboxBuffer = new Float32Array(8*3);
    this.planeBuffer = new Float32Array(9*3);

    var gpu = this.renderer.gpu;
    this.drawTileState = gpu.createState({});
    this.drawStardomeState = gpu.createState({zwrite:false, ztest:false});
    this.drawAuraState = gpu.createState({zwrite:false, blend:true});

    this.drawBlendedTileState = gpu.createState({zequal:true, blend:true});

    this.degradeHorizonFactor = 0;
    this.degradeHorizonTiltFactor = 0;

    this.drawTiles = new MapDrawTiles(map, this);

};


/**
 * Reset draw-owned state at the start of a render pass.
 */
MapDraw.prototype.initFrame = function() {

    var gridMode = this.config.mapGridMode;
    this.gridSkipped = gridMode == 'none';
    this.gridFlat = gridMode == 'flat';
    this.gridGlues = gridMode == 'linear';

    this.degradeHorizonFactor =
        200.0 * this.config.mapDegradeHorizonParams[0];
    this.degradeHorizonTiltFactor = 0.5 * (
        1.0 + Math.cos(math.radians(Math.min(
            180,
            Math.abs(this.renderer.cameraOrientation[1] * 2 * 3)
        )))
    );
    this.setupDetailDegradation();

    this.zFactor = 0;
    this.ndcToScreenPixel =
        this.renderer.gpu.currentRenderTarget.viewportSize[0] * 0.5;
    this.updateGridFactors();
    this.maxGpuUsed = Math.max(
        32 * 102 * 1204,
        this.map.gpuCache.getMaxCost() - 32 * 102 * 1204
    );
    this.drawTileCounter = 0;
};


MapDraw.prototype.drawMap = function() {
    
    var map = this.map;
    var renderer = this.renderer;
    var gpu = renderer.gpu;

    // Reset owner-specific frame state before issuing draw work.
    map.initFrame();
    renderer.initFrame();
    this.initFrame();

    /*
     * Channel 1 color was cleared to the white "no hit" sentinel in
     * `switchToFramebuffer('depth')`; only depth is reset here.
     */
    if (this.drawChannel != 1) 
        gpu.clearColorAndDepth();
    else 
        gpu.clearDepth();

    // draw background (skydome)
    if (this.drawChannel === 0 && map.isAtmospheric())
        this.renderer.drawBackground();

    // runtime label override falls back to the map configuration.
    var labelsEnabled = map.overrides.flagLabels
        ?? map.config.mapFlagLabels;

    // clear queued geodata jobs 
    if (labelsEnabled
        && map.freeLayersHaveGeodata
        && this.drawChannel == 0) {

        renderer.draw.clearJobBuffer();
    }

    // draw surfaces and free layers
    gpu.setState(this.drawTileState);

    if (map.overrides.drawEarth) {

        var i, li, layer;
        
        map.withSelectionCamera(function() {

            //todo remove this
            for (i = 0, li = this.tileBuffer.length; i < li; i++) {
                this.tileBuffer[i] = null;    
            }
        
            // draw mesh tiles
            if (this.tree.surfaceSequence.length > 0) {
                //console.log("here7");
                this.tree.draw(false);
            }

            // draw free layers
            for (i = 0, li = map.freeLayerSequence.length; i < li; i++) {

                layer = map.freeLayerSequence[i];

                if (!labelsEnabled
                    && (layer.type == 'geodata' || layer.geodata)) {
                    continue;
                }


                if (layer.ready && layer.tree
                    && (!layer.geodata
                        || (layer.stylesheet && layer.stylesheet.isReady()))
                    && this.drawChannel == 0) {
                    
                    if (layer.zFactor) {
                        this.zbufferOffset = layer.zFactor;
                    }

                    if (layer.type == 'geodata') {
                        // monolithic geodata job collection
                        this.drawMonoliticGeodata(layer);

                    } else {
                        /*
                         * Tiled free-layer traversal. Surface tiles draw
                         * directly; geodata-tiles merely collect jobs.
                         */
                        layer.tree.draw();
                    }

                    this.zbufferOffset = null;
                }
            }
        }.bind(this));

    } // if (map.overrides.drawEarth)

    // draw freeze frustum, if applicable
    if (this.drawChannel == 0
            && map.core.inspector
            && map.core.inspector.hasFreezeFrustum()) {

        map.withNavigationCamera(function() {
            map.core.inspector.drawFreezeFrustum();
        });
    }

    // draw queued geodata labels and icons
    if (map.overrides.drawEarth) {
        if (labelsEnabled
            && map.freeLayersHaveGeodata
            && this.drawChannel == 0) {

            renderer.drawnGeodataTiles = this.stats.drawnGeodataTilesPerLayer; 
            renderer.drawnGeodataTilesFactor = this.stats.drawnGeodataTilesFactor;

            map.withNavigationCamera(function() {
                renderer.draw.drawGpuJobs(this.map.getSelectionPosition());
            }.bind(this));
        }
    }

    // done
};

/**
 * Triggered by map.getScreenDepth and map.getHitcoords
 */

MapDraw.prototype.drawHitmap = function() {

    // throtle hitmap drawing (and copying) to 1 / hitmapCopyIntervalMs
    // per frame
    var interval = this.renderer.hitmapCopyIntervalMs;
    if (interval > 0) {
        var now = Date.now();
        if (((this.renderer.lastHitmapCopyTime|0) !== 0)
            && ((now - this.renderer.lastHitmapCopyTime) < interval)) {
            return; // reuse previous CPU buffer this frame
        }
        this.renderer.lastHitmapCopyTime = now;
    }

    this.drawChannel = 1;
    this.renderer.switchToFramebuffer('depth');
    this.map.renderSlots.processRenderSlots();
    this.renderer.switchToFramebuffer('base');

    if (this.renderer.hitmapMode > 2) {
        this.renderer.copyHitmap();
    }

    this.drawChannel = 0;
    this.map.hitMapDirty = false;
};


MapDraw.prototype.drawGeodataHitmap = function() {
    this.map.withSelectionCamera(function() {

        this.renderer.gpu.setState(this.drawTileState);
        this.renderer.switchToFramebuffer('geo');
        this.renderer.draw.drawGpuJobs(this.map.getSelectionPosition());

        if (this.renderer.advancedPassNeeded) {
            this.renderer.switchToFramebuffer('geo2');
            this.renderer.draw.drawGpuJobs(this.map.getSelectionPosition());
        }

        this.renderer.switchToFramebuffer('base');
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
    if (!surface || this.drawChannel != 0) {
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

    if (surface.monoGeodata.isReady(null, null, null, surface.options.fastParse)) {

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

            this.map.withNavigationCamera(function() {
                surface.monoGeodataView.draw(this.camera.position);
            }.bind(this));
        }
    }
};


MapDraw.prototype.updateGridFactors = function() {
    var nodes = this.map.referenceFrame.getSpatialDivisionNodes();

    for (var i = 0, li = nodes.length; i < li; i++) {
        var node = nodes[i]; 
        var embed = 8;

        var altitude = Math.max(10, this.camera.distance + 20);
        //var altitude = Math.max(1.1, this.cameraDistance);
        var maxDistance = (node.extents.ur[0] - node.extents.ll[0])*2;
        var gridSelect = Math.log(Math.min(maxDistance,altitude)) / this.log8;
        var gridMax = Math.log(maxDistance) / this.log8;
    
        gridSelect = gridMax - gridSelect;
    
        node.gridBlend = (gridSelect - Math.floor(gridSelect));
        
        gridSelect = Math.floor(Math.floor(gridSelect))+1;
        node.gridStep1 = Math.pow(embed, gridSelect);
        node.gridStep2 = node.gridStep1 * 8; 
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

    var dpiRatio =
        this.renderer.gpu.currentRenderTarget.devicePixelRatio ?? 1;

    this.texelSizeFit = this.config.mapTexelSizeFit * Math.pow(2,factor) * dpiRatio;

    //console.log("TexelSizeFit: %f", this.texelSizeFit);
};


export default MapDraw;
