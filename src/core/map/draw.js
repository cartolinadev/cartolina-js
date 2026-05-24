
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

    this.debug = {
        heightmapOnly : false,
        drawBBoxes : false,
        drawMeshBBox : false,
        drawLods : false,
        drawPositions : false,
        drawFaceCount : false,
        drawDistance : false,
        drawGeodataOnly : false,
        drawTextureSize : false,
        drawNodeInfo : false,
        drawSurfaces : false,
        drawCredits : false,
        drawLabelBoxes : false,
        drawAllLabels : false,
        drawHiddenLabels : false,
        drawEarth : true,
        drawGridCells : false,
        drawGPixelSize : false,
        debugTextSize : 2.0,
        maxZoom : false
    };

    this.gridFlat = false;
    this.gridGlues = false;
    this.gridSkipped = false;

    this.zFactor = 0;
    //this.zFactor2 = 0.000012;
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
    //this.drawBufferIndex = 0;

    var gpu = this.renderer.gpu;
    this.drawTileState = gpu.createState({});
    this.drawStardomeState = gpu.createState({zwrite:false, ztest:false});
    this.drawAuraState = gpu.createState({zwrite:false, blend:true});

    this.drawBlendedTileState = gpu.createState({zequal:true, blend:true});

    this.degradeHorizonFactor = 0;
    this.degradeHorizonTiltFactor = 0;

    this.drawTiles = new MapDrawTiles(map, this);

};


MapDraw.prototype.drawMap = function(skipFreeLayers) {
    var map = this.map;
    var renderer = this.renderer;
    var camera = this.camera;
    var gpu = renderer.gpu;
    var debug = this.debug;

    if (this.drawChannel != 1) {
        map.visibleCredits = {
            imagery : {},
            glueImagery : {},
            mapdata : {}
        };
    }

    var projected = this.isProjected;

    //console.log(this.renderer);

    //console.log(map.resourcesTree);
    //console.log(map.tree);

    switch (this.config.mapGridMode) {
        case 'none':       this.gridSkipped = true; this.gridFlat = false; this.gridGlues = false;  break;
        case 'flat':       this.gridSkipped = false; this.gridFlat = true; this.gridGlues = false;  break;
        case 'linear':     this.gridSkipped = false; this.gridFlat = false; this.gridGlues = true;  break;
        case 'fastlinear': this.gridSkipped = false; this.gridFlat = false; this.gridGlues = false; break;
    }

    var camInfo = camera.update();
    var renderer = this.renderer;

    renderer.debugStr = 'AsyncImageDecode: ' + this.config.mapAsyncImageDecode;
    //renderer.dirty = true;  // no reader found
    renderer.debug = this.debug;
    renderer.mapHack = map;
    renderer.benevolentMargins = this.config.mapBenevolentMargins;

    if (this.config.mapForceFrameTime) {
        if (this.config.mapForceFrameTime != -1) {
            renderer.frameTime = this.config.mapForceFrameTime;
        } else {
            renderer.frameTime = 0;
        }
    } else {
        renderer.frameTime = this.stats.frameTime;        
    }

    renderer.hoverFeatureCounter = 0;
    renderer.hoverFeatureList = map.hoverFeatureList;
    renderer.hoverFeature = map.hoverFeature;

    renderer.cameraPosition = camera.position;
    renderer.cameraOrientation = map.position.getOrientation();
    renderer.cameraTiltFator = Math.cos(math.radians(renderer.cameraOrientation[1]));
    //renderer.cameraVector = camera.vector;  // no reader found
    renderer.cameraViewExtent = map.position.getViewExtent();
    renderer.cameraViewExtent2 = Math.pow(2.0, Math.max(1.0, Math.floor(Math.log(map.position.getViewExtent()) / Math.log(2))));
    renderer.drawLabelBoxes = this.debug.drawLabelBoxes;
    renderer.drawGridCells = this.debug.drawGridCells;
    renderer.drawAllLabels = this.debug.drawAllLabels;
    renderer.drawHiddenLabels = this.debug.drawHiddenLabels;
    renderer.fmaxDist = Number.NEGATIVE_INFINITY;
    renderer.fminDist = Number.POSITIVE_INFINITY;


    if (projected) {
        var yaw = math.radians(renderer.cameraOrientation[0]);
        renderer.labelVector = [-Math.sin(yaw), Math.cos(yaw), 0, 0, 0];
    } else {
        var v = camInfo.vector;
        renderer.labelVector = [v[0], v[1], v[2], 0]; 
    }

    renderer.distanceFactor = 1 / Math.max(1,Math.log(camera.distance) / Math.log(1.04));
    renderer.tiltFactor = (Math.abs(renderer.cameraOrientation[1]/-90));
    renderer.localViewExtentFactor = 2 * Math.tan(math.radians(map.position.getFov()*0.5));

    // update renderer illumination information
    renderer.updateIllumination(map.position);

    // update per frame UBOs
    renderer.updateBuffers();

    this.degradeHorizonFactor = 200.0 * this.config.mapDegradeHorizonParams[0];
    this.degradeHorizonTiltFactor = 0.5*(1.0+Math.cos(math.radians(Math.min(180,Math.abs(renderer.cameraOrientation[1]*2*3)))));
   
    if (this.drawChannel != 1) {
        gpu.clearColorAndDepth([0,0,0,255]);
    } else { //render depth map
        gpu.clearDepth();
    }

    this.setupDetailDegradation();

    map.loader.setChannel(0); //0 = hires channel
    this.zFactor = 0;

    this.ndcToScreenPixel =
        this.renderer.gpu.currentRenderTarget.viewportSize[0] * 0.5;

    this.updateGridFactors();
    this.maxGpuUsed = Math.max(32*102*1204, map.gpuCache.getMaxCost() - 32*102*1204); 
    //this.cameraCenter = this.position.getCoords();
    this.stats.renderBuild = 0;
    this.drawTileCounter = 0;
    var cameraPos = camera.position;
    var i, li, layer;
    var labelsEnabled = renderer.debug.flagLabels
        ?? map.config.mapFlagLabels;

    if (map.freeLayersHaveGeodata && this.drawChannel == 0) {
        renderer.draw.clearJobBuffer();
    }

    // draw background (skydome)
    if (this.drawChannel === 0 && map.isAtmospheric())
        this.renderer.drawBackground();

    gpu.setState(this.drawTileState);

    if (this.debug.drawEarth) { // debug.drawEarth? :-)

        //console.log('debug.drawEarth');

        map.withSelectionCamera(function() {

            //todo remove this
            for (i = 0, li = this.tileBuffer.length; i < li; i++) {
                this.tileBuffer[i] = null;    
            }
        
            // the hot path - draw mesh tiles
            if (this.tree.surfaceSequence.length > 0) {
                //console.log("here7");
                this.tree.draw(false);
            }

            //draw free layers
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
                        // monolitic geodata hot path
                        this.drawMonoliticGeodata(layer);
                    } else {
                        // geodata-tiles hot path
                        //console.log('geodata layer tree draw');
                        layer.tree.draw();
                    }

                    this.zbufferOffset = null;
                }
            }
        }.bind(this));
    } // if (debug.drawEarth)

    var body = map.referenceFrame.body;

    // drawGPUJobs needs these
    var navigationSrsInfo = map.getNavigationSrs().getSrsInfo();
    renderer.earthRadius =  navigationSrsInfo['a'];
    renderer.earthRadius2 =  navigationSrsInfo['b'];
    renderer.earthERatio = renderer.earthRadius / renderer.earthRadius2;

    if (this.drawChannel == 0
            && map.core.inspector
            && map.core.inspector.hasFreezeFrustum()) {
        map.withNavigationCamera(function() {
            map.core.inspector.drawFreezeFrustum();
        });
    }

    // geodata hot path
    if (debug.drawEarth) {
        if (!skipFreeLayers) {
            if (labelsEnabled
                && map.freeLayersHaveGeodata
                && this.drawChannel == 0) {
                renderer.drawnGeodataTiles = this.stats.drawnGeodataTilesPerLayer; //drawnGeodataTiles;
                renderer.drawnGeodataTilesFactor = this.stats.drawnGeodataTilesFactor;
                // geodata hot path
                //console.log('drawGpuJob');
                map.withNavigationCamera(function() {
                    renderer.draw.drawGpuJobs(this.map.getSelectionPosition());
                }.bind(this));
            }
        }
    }

    if (this.config.mapForceFrameTime) {
        if (this.config.mapForceFrameTime != -1) {
            renderer.frameTime = 0;
            this.config.mapForceFrameTime = -1;
        }
    }

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
