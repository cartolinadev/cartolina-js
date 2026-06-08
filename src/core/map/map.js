
import {vec3} from '../utils/matrix';
import * as utils from '../utils/utils';
import {platform} from '../utils/platform';
import MapView from './view';
import MapSurfaceTree from './surface-tree';
import MapResourceTree from './resource-tree';
import MapSrs from './srs';
import MapCache from './cache';
import MapCamera from './camera';
import MapConfig from './config';
import MapConvert from './convert';
import MapMeasure from './measure';
import MapDraw from './draw';
import MapLoader from './loader/loader';
import MapPosition from './position';
import MapStats from './stats';
import MapSurfaceSequence from './surface-sequence';
import MapUrl from './url';
import * as Illumination from './illumination';
import Atmosphere from './atmosphere';
import MapStyle from './style';
import MapTrajectory from './trajectory';
import MapSurface from './surface';
import MapGeodataBuilder from './geodata-builder';


var Map = function(core, path, config, configStorage) {

    this.config = config || {};
    this.setConfigParams(config);
    this.core = core;
    this.coreConfig = core.coreConfig;
    this.killed = false;
    this.config = config || {};
    this.loaderSuspended = false;

    this.url = new MapUrl(this, path);

    this.position = new MapPosition(['obj', 0, 0, 'fix', 0,  0, 0, 0,  0, 0]);
    this.lastPosition = this.position.clone();

    this.srses = {};
    this.bodies = {};
    this.atmosphere = null;
    this.referenceFrame = {};
    this.services = {};
    this.credits = {};
    this.creditsByNumber = {};
    this.surfaces = [];
    this.virtualSurfaces = {};
    this.glues = {};
    this.freeLayers = {};
    this.boundLayers = {};
    this.stylesheets = {};
    this.processingTasks = [];
    this.processingTasks2 = [];
    this.geodataProcessors = [];

    this.surfaceSequence = new MapSurfaceSequence(this);

    this.style = null;

    this.initialView = null;
    this.currentView_ = null; // new MapView(this, {});
    this.currentViewString = '';
    this.namedViews = {};
    this.viewCounter = 0;
    this.srsReady = false;
    this.surfaceCounter = 0;

    this.tree = null;

    this.freeLayerSequence = [];

    this.freeLayersHaveGeodata = false;

    this.visibleCredits = {
        imagery : {},
        glueImagery : {},
        mapdata : {}
    };
    
    this.mobile = false;
    this.metanodeBuffer = new Uint8Array(1024);
   
    this.gpuCache = new MapCache(this.config.mapGPUCache*1024*1024);
    this.resourcesCache = new MapCache(this.config.mapCache*1024*1024);
    this.metatileCache = new MapCache(this.config.mapMetatileCache*1024*1024);

    this.setupMobileMode(this.config.mapMobileMode);
    this.setupCache();

    this.loader = new MapLoader(this, this.config.mapDownloadThreads);

    this.renderer = this.core.renderer;
    this.camera = new MapCamera(this);

    this.stats = new MapStats(this);
    this.resourcesTree = new MapResourceTree(this);

    this.clickEvent = null;
    this.hoverEvent = null;
    this.hoverFeature = null;
    this.hoverFeatureId = null;
    this.lastHoverFeature = null;
    this.lastHoverFeatureId = null;
    this.hoverFeatureCounter = 0;
    this.hoverFeatureList = [];

    this.measure = null;
}

Map.prototype.kill = function() {
    this.killed = true;

    if (this.tree) {
        this.tree.kill();
    }

    for (var key in this.freeLayers) {
        var layer = this.freeLayers[key];
        if (layer && layer.tree) {
            layer.tree.kill();
        }
    }

    this.gpuCache.clear();
    this.resourcesCache.clear();
    this.metatileCache.clear();

    if (this.atmosphere != null) {
        this.atmosphere[Symbol.dispose]();
        this.atmosphere = null;
    }

    this.renderer = null;
};


Map.prototype.setupMobileMode = function() {
    this.mobile = this.config.mapMobileMode;

    if (!this.mobile && this.config.mapMobileModeAutodect) {
        this.mobile = platform.isMobile();        
    }

    this.setupCache();
};


Map.prototype.setupCache = function() {
    if (!this.resourcesCache) {
        return;
    }

    var factor = 1 / (this.mobile ? Math.pow(2, Math.max(0,this.config.mapMobileDetailDegradation-1)) : 1);
    var factor2 = 1 / (this.mobile ? Math.pow(2, this.config.mapMobileDetailDegradation) : 1);
    factor = (factor + factor2) * 0.5;
    this.resourcesCache.setMaxCost(this.config.mapCache*1024*1024*factor);
    this.gpuCache.setMaxCost(this.config.mapGPUCache*1024*1024*factor);
    this.metatileCache.setMaxCost(this.config.mapMetatileCache*1024*1024*(factor < 0.8 ? 0.5 : 1));
};


Map.prototype.getCoreInterface = function() {
    return this.core.interface;
};


Map.prototype.getRendererInterface = function() {
    return this.core.interface.getRendererInterface();
};


Map.prototype.setOption = function(/*key, value*/) {
};


Map.prototype.getOption = function(/*key*/) {
};


Map.prototype.addSrs = function(id, srs) {
    this.srses[id] = srs;
};


Map.prototype.getSrs = function(srsId) {
    return this.srses[srsId];
};


Map.prototype.getSrses = function() {
    return this.getMapKeys(this.srses);
};


Map.prototype.getSrsInfo = function(srsId) {
    var srs = this.getSrs(srsId);
    return srs ? srs.getInfo() : {};
};


Map.prototype.addBody = function(id, body) {
    this.bodies[id] = body;
};


Map.prototype.getBody = function(id) {
    return this.bodies[id];
};


Map.prototype.getBodies = function() {
    return this.getMapKeys(this.bodies);
};


Map.prototype.setReferenceFrame = function(referenceFrame) {
    this.referenceFrame = referenceFrame;
};


Map.prototype.getReferenceFrame = function() {
    return this.referenceFrame.getInfo();
};


Map.prototype.addCredit = function(id, credit) {
    this.credits[id] = credit;
    this.creditsByNumber[credit.id] = credit;
    credit.key = id;
};


Map.prototype.getCreditByNumber = function(id) {
    return this.creditsByNumber[id];
};


Map.prototype.getCreditById = function(id) {
    return this.credits[id];
};


Map.prototype.getCredits = function() {
    return this.getMapKeys(this.credits);
};


Map.prototype.getVisibleCredits = function() {
    var imagery = this.visibleCredits.imagery;
    var glueImagery = this.visibleCredits.glueImagery;
    var imageryArray = []; 
    var imagerySpecificity = [];
    var i, li, t, sorted;

    for (var key in glueImagery) {
        if (!imagery[key]) {
            imagery[key] = glueImagery[key];
        }
    }
    
    this.visibleCredits.glueImagery = {};
    
    for (key in imagery) {
        imageryArray.push(key);
        imagerySpecificity.push(imagery[key]); 
    }

    //sort imagery
    do {
        sorted = true;
        
        for (i = 0, li = imagerySpecificity.length - 1; i < li; i++) {
            if (imagerySpecificity[i] < imagerySpecificity[i+1]) {
                t = imagerySpecificity[i];
                imagerySpecificity[i] = imagerySpecificity[i+1];
                imagerySpecificity[i+1] = t;
                t = imageryArray[i];
                imageryArray[i] = imageryArray[i+1];
                imageryArray[i+1] = t;
                sorted = false;
            } 
        }
        
    } while(!sorted);

    var mapdata = this.visibleCredits.mapdata;
    var mapdataArray = []; 
    var mapdataSpecificity = []; 

    for (key in mapdata) {
        mapdataArray.push(key);
        mapdataSpecificity.push(mapdata[key]); 
    }
    
    //sort imagery
    do {
        sorted = true;
        
        for (i = 0, li = mapdataSpecificity.length - 1; i < li; i++) {
            if (mapdataSpecificity[i] < mapdataSpecificity[i+1]) {
                t = mapdataSpecificity[i];
                mapdataSpecificity[i] = mapdataSpecificity[i+1];
                mapdataSpecificity[i+1] = t;
                t = mapdataArray[i];
                mapdataArray[i] = mapdataArray[i+1];
                mapdataArray[i+1] = t;
                sorted = false;
            } 
        }
        
    } while(!sorted);

    return {
        '3D' : [], 
        'imagery' : imageryArray, 
        'mapdata' : mapdataArray 
    };
};


Map.prototype.addSurface = function(id, surface) {
    this.surfaces.push(surface);
    surface.index = this.surfaces.length - 1; 
};


Map.prototype.getSurface = function(id) {
    return this.searchArrayById(this.surfaces, id);
};


Map.prototype.getSurfaces = function() {
    var keys = [];
    for (var i = 0, li = this.surfaces.length; i < li; i++) {
        keys.push(this.surfaces[i].id);
    }
    return keys;
};


Map.prototype.addGlue = function(id, glue) {
    this.glues[id] = glue;
};


Map.prototype.getGlue = function(id) {
    return this.glues[id];
};


Map.prototype.addBoundLayer = function(id, layer) {
    this.boundLayers[id] = layer;
};


Map.prototype.setBoundLayerOptions = function(id, options) {
    if (this.boundLayers[id]) {
        this.boundLayers[id].setOptions(options);
    }
};


Map.prototype.getBoundLayerOptions = function(id) {
    if (this.boundLayers[id]) {
        return this.boundLayers[id].getOptions();
    }
    
    return null;
};


Map.prototype.removeBoundLayer = function(id) {
    if (this.boundLayers[id]) {
        this.boundLayers[id].kill();
        this.boundLayers[id] = null;
    }
};


Map.prototype.getBoundLayerByNumber = function(number) {
    var layers = this.boundLayers;
    for (var key in layers) {
        if (layers[key].numberId == number) {
            return layers[key];
        }
    }

    return null;
};


Map.prototype.getBoundLayerById = function(id) {
    return this.boundLayers[id];
};


Map.prototype.getBoundLayers = function() {
    return this.getMapKeys(this.boundLayers);
};


Map.prototype.addFreeLayer = function(id, layer) {

    if (layer == null) return;
    if (!(layer instanceof MapSurface))
        layer = new MapSurface(this, layer, 'free');

    this.freeLayers[id] = layer;
    //this.setView(this.getView());
    this.markDirty();
};


Map.prototype.removeFreeLayer = function(id) {
    if (this.freeLayers[id]) {
        this.freeLayers[id].kill();
        this.freeLayers[id] = null;
        //this.setView(this.getView());
        this.markDirty();
    }
};


Map.prototype.setFreeLayerOptions = function(id, options) {
    if (this.freeLayers[id]) {
        this.freeLayers[id].setOptions(options);
    }
};


Map.prototype.getFreeLayerOptions = function(id) {
    if (this.freeLayers[id]) {
        return this.freeLayers[id].getOptions();
    }
    
    return null;
};


Map.prototype.getFreeLayer = function(id) {
    return this.freeLayers[id];
    //return this.searchArrayById(this.freeLayers, id);
};


Map.prototype.getFreeLayers = function() {
    var keys = [];
    for (var key in this.freeLayers) {
        keys.push(key);
    }
    return keys;    
};


Map.prototype.getMapsSrs = function(srs) {
    if (srs == null) {
        return null;
    }

    //is it proj4 string?
    if (srs.indexOf('+proj') != -1) {
        return new MapSrs(this, {'srsDef':srs});
    }

    //search existing srs
    return this.srses[srs];
};


Map.prototype.addNamedView = function(id, view) {
    this.namedViews[id] = view;
};


Map.prototype.getNamedView = function(id) {
    return this.namedViews[id];
};


Map.prototype.getNamedViews = function() {
    return this.getMapKeys(this.namedViews);
};


Map.prototype.setView = function(view, forceRefresh, posToFixed) {

    if (view == null) {
        return;
    }

    if (this.style)
        throw Error(`setView may not be used when the map `
            + `is initialized via style.`);

    if (posToFixed && this.convert) {
        var p = this.getPosition();
        p = this.convert.convertPositionHeightMode(p, 'fix', true);
        this.setPosition(p);
    }
    
    if (typeof view === 'string') {
        view = view.trim();
        
        if (view.charAt(0) == '{') {
            try {
                view = JSON.parse(view);
            } catch(e){
                return;            
            }
        } else {
            view = this.getNamedView(view);

            if (!view) {
                return;
            }
            
            //view = JSON.parse(JSON.stringify(view));
            view = view.getInfo();
        }
    }

    //construct view string without options
    var string = {};

    if (view.surfaces) {
        string.surfaces = view.surfaces;
    }

    if (view.freeLayers) {
        string.freeLayers = view.freeLayers;
    }

    string = JSON.stringify(string);

    var renderer = this.renderer;

    //process options
    if (view.options) {

        //console.log(view.options);

        if (view.options.superelevation) {

            renderer.setSuperElevationState(true);
            renderer.setSuperElevation(view.options.superelevation);
        } else {
            renderer.setSuperElevationState(false);
        }

        if (view.options.illumination) {
            renderer.setIllumination(view.options.illumination);
        }
    }

    if (string != this.currentViewString || forceRefresh) {
        this.currentView_.parse(view);
        this.currentViewString = string;
        this.viewCounter++;  //this also cause rest of geodata
        renderer.draw.clearJobHBuffer(); //hotfix - reset hysteresis buffer
    }

    this.surfaceSequence.generateSurfaceSequence();
    this.surfaceSequence.generateBoundLayerSequence();

    this.refreshFreelayesInView();

    this.markDirty();
};


Map.prototype.addStylesheet = function(id, style) {
    this.stylesheets[id] = style;
};


Map.prototype.getStylesheet = function(id) {
    return this.stylesheets[id];
    //return this.searchArrayById(this.stylesheets, id);
};


Map.prototype.getStylesheets = function() {
    var keys = [];

    for (var key in this.stylesheets) {
        keys.push(key);
    }
    return keys;
};


Map.prototype.getStylesheetData = function(id) {
    var stylesheet = this.getStylesheet(id);

    if (stylesheet) {
        return {'url':stylesheet.url, 'data': stylesheet.data};
    }
    
    return {'url':null, 'data':{}};
};


Map.prototype.setStylesheetData = function(id, data) {
    var stylesheet = this.getStylesheet(id);
    
    //if (stylesheet) {
      //  stylesheet.data = data;
    //}

    this.renderer.draw.clearJobHBuffer();

    if (stylesheet) {
        if (data) {
            stylesheet.setData(data);
        }

        for (var key in this.freeLayers) {
            var freeLayer = this.getFreeLayer(key);
            if (freeLayer && freeLayer.geodata && freeLayer.stylesheet == stylesheet) {
                
                if (freeLayer.geodataProcessor) {
                    freeLayer.geodataProcessor.setStylesheet(freeLayer.stylesheet);
                }

                freeLayer.geodataCounter++;
            }
        }
    }

    this.markDirty();
        
    //TODO: reset geodatview in free layers
};

Map.prototype.getCurrentView = function() {

    if (this.style)
        return this.style.legacyView();

    return this.currentView_;
}

Map.prototype.getView = function() {
    return this.getCurrentView().getInfo();
};


Map.prototype.refreshFreelayesInView = function() {
    var freeLayers = this.getCurrentView().freeLayers;
    this.freeLayerSequence = [];

    for (var key in freeLayers) {
        var freeLayer = this.getFreeLayer(key);
        
        if (freeLayer) {
            
            freeLayer.zFactor = freeLayers[key]['depthOffset'];
            freeLayer.maxLod = freeLayers[key]['maxLod'];
            
            this.freeLayerSequence.push(freeLayer);
            
            if (freeLayers[key]['style']) {
                freeLayer.setStyle(freeLayers[key]['style']);
            } else {
                freeLayer.setStyle(freeLayer.originalStyle);
            }
            
            //TODO: generate bound layer seqence for      
        }
    }
};

Map.prototype.refreshView = function() {
    this.viewCounter++;

    // style-based map
    if (this.style) this.style.refreshSequences();

    // mapconfig-based map, use the legacy methods
    if (!this.style && this.currentView_) {

        this.surfaceSequence.generateSurfaceSequence();
        this.surfaceSequence.generateBoundLayerSequence();
        this.refreshFreelayesInView();
    }

    this.markDirty();
};


Map.prototype.searchArrayIndexById = function(array, id) {
    for (var i = 0, li = array.length; i < li; i++) {
        if (array[i].id == id) {
            return i;
        }
    }

    return -1;
};


Map.prototype.searchArrayById = function(array, id) {
    for (var i = 0, li = array.length; i < li; i++) {
        if (array[i].id == id) {
            return array[i];
        }
    }

    return null;
};


Map.prototype.searchMapByInnerId = function(map, id) {
    for (var key in map) {
        if (map[key].id == id) {
            return map[key];
        }
    }

    return null;
};


Map.prototype.getMapKeys = function(map) {
    var keys = [];
    for (var key in map) {
        keys.push(key);
    }

    return keys;
};


Map.prototype.getMapIds = function(map) {
    var keys = [];
    for (var key in map) {
        keys.push(key.id);
    }

    return keys;
};


Map.prototype.setPosition = function(pos) {
    this.position = new MapPosition(pos);
    this.markDirty();
};


Map.prototype.isReferenceFrameReady = function() {
    return this.referenceFrame.model.physicalSrs.isReady() &&
           this.referenceFrame.model.publicSrs.isReady() &&
           this.referenceFrame.model.navigationSrs.isReady();
};


Map.prototype.getPhysicalSrs = function() {
    return this.referenceFrame.model.physicalSrs;
};


Map.prototype.getPublicSrs = function() {
    return this.referenceFrame.model.publicSrs;
};


Map.prototype.getNavigationSrs = function() {
    return this.referenceFrame.model.navigationSrs;
};


Map.prototype.getPosition = function() {
    return this.position.clone();
};


Map.prototype.getCurrentCredits = function() {

    return this.getVisibleCredits();
};


Map.prototype.getCreditInfo = function(creditId) {

    var credit = this.getCreditById(creditId);
    return credit ? credit.getInfo() : {};
};


Map.prototype.convertPositionViewMode = function(position, mode) {

    return this.convert.convertPositionViewMode(
        new MapPosition(position), mode);
};


Map.prototype.convertPositionHeightMode = function(
    position, mode, noPrecisionCheck) {

    return this.convert.convertPositionHeightMode(
        new MapPosition(position), mode, noPrecisionCheck);
};


Map.prototype.convertCoords = function(sourceSrs, destinationSrs, coords) {

    var srs = this.getSrs(sourceSrs);
    var srs2 = this.getSrs(destinationSrs);
    if (!srs || !srs2) return null;

    return srs2.convertCoordsFrom(coords, srs);
};


Map.prototype.convertCoordsFromNavToPublic = function(pos, mode, lod) {

    var p = ['obj', pos[0], pos[1], mode, pos[2], 0, 0, 0, 10, 45];
    return this.convert.getPositionPublicCoords(new MapPosition(p), lod);
};


Map.prototype.convertCoordsFromPublicToNav = function(pos, mode, lod) {

    var p = ['obj', pos[0], pos[1], mode, pos[2], 0, 0, 0, 10, 45];
    return this.convert.getPositionNavCoordsFromPublic(
        new MapPosition(p), lod);
};


Map.prototype.convertCoordsFromPhysToPublic = function(pos, containsSE) {

    if (containsSE && this.renderer.useSuperElevation) {

        var p = this.renderer.transformPointBySE(pos);
        return this.convert.convertCoords(p, 'physical', 'public');
    }

    return this.convert.convertCoords(pos, 'physical', 'public');
};


Map.prototype.convertCoordsFromNavToPhys = function(
    pos, mode, lod, includeSE) {

    var p = ['obj', pos[0], pos[1], mode, pos[2], 0, 0, 0, 10, 45];
    return this.convert.getPositionPhysCoords(
        new MapPosition(p), lod, includeSE);
};


Map.prototype.convertCoordsFromPhysToNav = function(
    pos, mode, lod, containsSE) {

    return this.convert.convertCoordsFromPhysToNav(
        pos, mode, lod, containsSE);
};


Map.prototype.convertCoordsFromNavToCanvas = function(pos, mode, lod) {

    var p = ['obj', pos[0], pos[1], mode, pos[2], 0, 0, 0, 10, 45];
    return this.convert.getPositionCanvasCoords(new MapPosition(p), lod);
};


Map.prototype.convertCoordsFromPhysToCanvas = function(pos, containsSE) {

    var p = ['obj', pos[0], pos[1], 'fix', pos[2], 0, 0, 0, 10, 45];
    return this.convert.getPositionCanvasCoords(
        new MapPosition(p), null, true, containsSE);
};


Map.prototype.convertCoordsFromNavToCameraSpace = function(pos, mode, lod) {

    var p = ['obj', pos[0], pos[1], mode, pos[2], 0, 0, 0, 10, 45];
    return this.convert.getPositionCameraSpaceCoords(
        new MapPosition(p), lod);
};


Map.prototype.convertCoordsFromPhysToCameraSpace = function(pos) {

    var p = this.camera.position;
    return [pos[0] - p[0], pos[1] - p[1], pos[2] - p[2]];
};


Map.prototype.transformPhysCoordsBySE = function(pos) {

    return this.convert.transformPhysCoordsBySE(pos);
};


Map.prototype.getPositionCanvasCoords = function(position, lod) {

    return this.convert.getPositionCanvasCoords(
        new MapPosition(position), lod);
};


Map.prototype.getPositionCameraCoords = function(position, mode) {

    return this.convert.getPositionCameraCoords(
        new MapPosition(position), mode);
};


Map.prototype.movePositionCoordsTo = function(
    position, azimuth, distance, skipOrientation) {

    return this.convert.movePositionCoordsTo(
        new MapPosition(position), azimuth, distance, skipOrientation);
};


Map.prototype.getGeodesicLinePoints = function(
    coords, coords2, height, density) {

    return this.convert.getGeodesicLinePoints(
        coords, coords2, height, density);
};


Map.prototype.getSurfaceHeight = function(coords, precision) {

    return this.measure.getSurfaceHeight(
        coords,
        this.measure.getOptimalHeightLodBySampleSize(coords, precision));
};


Map.prototype.getSurfaceAreaGeometry = function(
    coords, radius, mode, limit, callback, loadTextures) {

    var res = this.measure.getSurfaceAreaGeometry(
        coords, radius, mode, limit, true, loadTextures);

    if (!res[0]) {

        return this.core.once(
            'map-update',
            this.getSurfaceAreaGeometry.bind(
                this, coords, radius, mode, limit, callback, loadTextures),
            1);
    }

    var buffer = res[1], ret = [];

    if (this.tree) {

        this.storedTilesRes = [];
        this.tree.storeGeometry(buffer, buffer.length);
        ret = this.storedTilesRes;
        this.storedTilesRes = [];
    }

    callback(ret);
    return function() {};
};


Map.prototype.getDistance = function(
    coords, coords2, includingHeights, usePublic) {

    return this.measure.getDistance(
        coords, coords2, includingHeights, usePublic);
};


Map.prototype.getAzimuthCorrection = function(coords, coords2) {

    return this.measure.getAzimuthCorrection(coords, coords2);
};


Map.prototype.getNED = function(coords, onlyMatrix) {

    return this.measure.getNewNED(
        coords, (onlyMatrix === false) ? false : true);
};


Map.prototype.getCameraInfo = function() {

    var camera = this.camera;
    return {
        'projectionMatrix' : camera.camera.projection.slice(),
        'viewMatrix' : camera.camera.modelview.slice(),
        'viewProjectionMatrix' : camera.camera.mvp.slice(),
        'rotationMatrix' : camera.camera.rotationview.slice(),
        'position' : this.camera.position.slice(),
        'vector' : this.camera.vector.slice(),
        'distance' : this.camera.distance,
        'height' : this.camera.height
    };
};


Map.prototype.isPointInsideCameraFrustum = function(point) {

    return this.camera.camera.pointVisible(point, this.camera.position);
};


Map.prototype.isBBoxInsideCameraFrustum = function(bbox) {

    return this.camera.camera.bboxVisible(
        { min:bbox[0], max:bbox[1] }, this.camera.position);
};


Map.prototype.generateTrajectory = function(p1, p2, options) {

    p1 = new MapPosition(p1);
    p2 = new MapPosition(p2);
    return (new MapTrajectory(this, p1, p2, options)).generate();
};


Map.prototype.generatePIHTrajectory = function(
    position, azimuth, distance, options) {

    options = options || {};
    var p = new MapPosition(position);
    options['distance'] = distance;
    options['azimuth'] = azimuth;
    options['distanceAzimuth'] = true;
    return (new MapTrajectory(this, p, p, options)).generate();
};


Map.prototype.redraw = function() {

    this.markDirty();
    return this;
};


Map.prototype.setLoaderSuspended = function(state) {

    this.loaderSuspended = state;
    return this;
};


Map.prototype.getLoaderSuspended = function() {

    return this.loaderSuspended;
};


Map.prototype.getGpuCache = function() {

    return this.gpuCache;
};


Map.prototype.getStats = function(switches) {

    if (switches) {

        return {
            'maxZoom' : this.outerMap.overrides.maxZoom
        };
    }

    var busyWorkers = 0;
    for (var i = 0, li = this.geodataProcessors.length; i < li; i++) {

        if (this.geodataProcessors[i].busy) busyWorkers++;
    }

    return {
        'bestMeshTexelSize' : this.bestMeshTexelSize,
        'bestGeodataTexelSize' : this.bestGeodataTexelSize,
        'downloading' : this.loader.downloading.length,
        'lastDownload' : this.loader.lastDownloadTime,
        'surfaces' : this.tree.surfaceSequence.length,
        'freeLayers' : this.freeLayerSequence.length,
        'texelSizeFit' : this.texelSizeFit,
        'processingTasks' : this.processingTasks.length,
        'busyWorkers' : busyWorkers,
        'dirty' : this.dirty,
        'drawnTiles' : this.stats.drawnTiles,
        'drawnGeodataTiles' : this.stats.drawnGeodataTiles,
        'renderTime' : this.stats.rendererTime,
        'frameTime' : this.stats.frameTime
    };
};


Map.prototype.createGeodata = function() {

    return new MapGeodataBuilder(this);
};


Map.prototype.getGeodataGeometry = function(id) {

    return this.renderer.geometries[id];
};


Map.prototype.setGeodataSelection = function(selection) {

    this.renderer.geodataSelection = selection;
    this.markDirty();
    return this;
};


Map.prototype.getGeodataSelection = function() {

    return this.renderer.geodataSelection;
};


Map.prototype.setLoaderParams = function(mapConfig, configStorage) {
    var sources = [];

    if (mapConfig && mapConfig['browserOptions']) {
        sources.push(mapConfig['browserOptions']);
    }

    if (configStorage) {
        sources.push(configStorage);
    }

    for (var i = 0, li = sources.length; i < li; i++) {
        var source = sources[i];
        for (var key in source) {
            switch(key) {
                case 'mapSeparateLoader':
                case 'mapGeodataBinaryLoad':
                case 'mapPackLoaderEvents':
                case 'mapParseMeshInWorker':
                case 'mapPackGeodataEvents':
                    this.setConfigParam(key, source[key]);
                    break;
            }
        }
    }
};


Map.prototype.setConfigParams = function(params) {
    if (typeof params === 'object' && params !== null) {
        for (var key in params) {
            this.setConfigParam(key, params[key]);
        }
    }
};


Map.prototype.setConfigParam = function(key, value) {
    switch (key) {
    case 'map':                           this.config.map = utils.validateString(value, null); break;
    case 'mapCache':                      this.config.mapCache = utils.validateNumber(value, 10, Number.MAXINTEGER, 900); this.setupCache(); break;
    case 'mapGPUCache':                   this.config.mapGPUCache = utils.validateNumber(value, 10, Number.MAXINTEGER, 360); this.setupCache(); break;
    case 'mapMetatileCache':              this.config.mapMetatileCache = utils.validateNumber(value, 10, Number.MAXINTEGER, 60); this.setupCache(); break;
    case 'mapTexelSizeFit':               this.config.mapTexelSizeFit = utils.validateNumber(value, 0.0001, Number.MAXINTEGER, 1.1); break;
    case 'mapDownloadThreads':            this.config.mapDownloadThreads = utils.validateNumber(value, 1, Number.MAXINTEGER, 6); break;
    case 'mapMaxProcessingTime':          this.config.mapMaxProcessingTime = utils.validateNumber(value, 1, Number.MAXINTEGER, 1000/20); break;
    case 'mapMaxGeodataProcessingTime':   this.config.mapMaxGeodataProcessingTime = utils.validateNumber(value, 1, Number.MAXINTEGER, 10); break;
    case 'mapMobileMode':                 this.config.mapMobileMode = utils.validateBool(value, false); this.setupMobileMode(); break;
    case 'mapMobileModeAutodect':         this.config.mapMobileModeAutodect = utils.validateBool(value, false); break;
    case 'mapMobileDetailDegradation':    this.config.mapMobileDetailDegradation = utils.validateNumber(value, 0, Number.MAXINTEGER, 2); break;
    case 'mapNavSamplesPerViewExtent':    this.config.mapNavSamplesPerViewExtent = utils.validateNumber(value, 0.00000000001, Number.MAXINTEGER, 4); break;
    case 'mapIgnoreNavtiles':             this.config.mapIgnoreNavtiles = utils.validateBool(value, false); break;
    case 'mapAllowHires':                 this.config.mapAllowHires = utils.validateBool(value, true); break;
    case 'mapAllowLowres':                this.config.mapAllowLowres = utils.validateBool(value, true); break;
    case 'mapAllowSmartSwitching':        this.config.mapAllowSmartSwitching = utils.validateBool(value, true); break;
    case 'mapDisableCulling':             this.config.mapDisableCulling = utils.validateBool(value, false); break;
    case 'mapPreciseCulling':             this.config.mapPreciseCulling = utils.validateBool(value, false); break;
    case 'mapHeightLodBlend':             this.config.mapHeightLodBlend = utils.validateBool(value, true); break;
    case 'mapHeightNodeBlend':            this.config.mapHeightNodeBlend = utils.validateBool(value, true); break;
    case 'mapBasicTileSequence':          this.config.mapBasicTileSequence = utils.validateBool(value, true); break;
    case 'mapSmartNodeParsing':           this.config.mapSmartNodeParsing = utils.validateBool(value, true); break;
    case 'mapXhrImageLoad':               this.config.mapXhrImageLoad = utils.validateBool(value, false); break;
    case 'mapTraversalMaskResolution': {

        // Mask textures must be power-of-two; fall back to the default
        // when the supplied value would otherwise need silent rounding.
        var resolution = utils.validateNumber(value, 16, 4096, 256);
        var isPowerOfTwo = (resolution & (resolution - 1)) === 0;
        this.config.mapTraversalMaskResolution =
            isPowerOfTwo ? resolution : 256;
        break;
    }
    case 'mapTraversalMaskThreshold':
        this.config.mapTraversalMaskThreshold =
            utils.validateNumber(value, 0, 1, 0.5);
        this.markDirty();
        break;
    case 'mapTraversalMaskErosion':
        this.config.mapTraversalMaskErosion =
            utils.validateNumber(value, 0, 1, 1);
        this.markDirty();
        break;
    case 'mapFallbackCadence':            this.config.mapFallbackCadence = utils.validateNumber(value, 1, Number.MAXINTEGER, 3); break;
    case 'mapGridMode':                   this.config.mapGridMode = utils.validateString(value, 'linear'); break;
    case 'mapGridSurrogatez':             this.config.mapGridSurrogatez = utils.validateBool(value, false); break;
    case 'mapGridTextureLevel':           this.config.mapGridTextureLevel = utils.validateNumber(value, -Number.MAXINTEGER, Number.MAXINTEGER, -1); break;
    case 'mapGridTextureLayer':           this.config.mapGridTextureLayer = utils.validateString(value, ''); break;
    case 'mapPreciseBBoxTest':            this.config.mapPreciseBBoxTest = utils.validateBool(value, true); break;
    case 'mapPreciseDistanceTest':        this.config.mapPreciseDistanceTest = utils.validateBool(value, false); break;
    case 'mapForceMetatileV3':            this.config.mapForceMetatileV3 = utils.validateBool(value, false); break;
    case 'mapVirtualSurfaces':            this.config.mapVirtualSurfaces = utils.validateBool(value, true); break;
    case 'mapDegradeHorizon':             this.config.mapDegradeHorizon = utils.validateBool(value, true); break;
    case 'mapDegradeHorizonParams':       this.config.mapDegradeHorizonParams = utils.validateNumberArray(value, 4, [0,1,1,1], [Number.MAX_VALUE, Number.MAX_VALUE, Number.MAX_VALUE], [1, 3000, 15000, 7000]); break;
    case 'mapRefreshCycles':              this.config.mapRefreshCycles = utils.validateNumber(value, 0, Number.MAXINTEGER, 3); break;
    case 'mapDefaultFont':                this.config.mapDefaultFont = utils.validateString(value, ''); break;
    case 'mapMetricUnits':                this.config.mapMetricUnits = utils.validateBool(value, true); break;
    case 'mapShadingLambertian':         this.config.mapShadingLambertian = utils.validateBool(value, true); this.markDirty(); break;
    case 'mapShadingSlope':              this.config.mapShadingSlope = utils.validateBool(value, false); this.markDirty(); break;
    case 'mapShadingAspect':             this.config.mapShadingAspect = utils.validateBool(value, false); this.markDirty(); break;
    case 'mapFlagLighting':              this.config.mapFlagLighting = utils.validateBool(value, true); this.markDirty(); break;
    case 'mapFlagNormalMaps':            this.config.mapFlagNormalMaps = utils.validateBool(value, true); this.markDirty(); break;
    case 'mapFlagDiffuseMaps':           this.config.mapFlagDiffuseMaps = utils.validateBool(value, true); this.markDirty(); break;
    case 'mapFlagSpecularMaps':          this.config.mapFlagSpecularMaps = utils.validateBool(value, true); this.markDirty(); break;
    case 'mapFlagBumpMaps':              this.config.mapFlagBumpMaps = utils.validateBool(value, true); this.markDirty(); break;
    case 'mapFlagAtmosphere':            this.config.mapFlagAtmosphere = utils.validateBool(value, true); this.markDirty(); break;
    case 'mapFlagShadows':               this.config.mapFlagShadows = utils.validateBool(value, true); this.markDirty(); break;
    case 'mapFlagLabels':                this.config.mapFlagLabels = utils.validateBool(value, true); this.markDirty(); break;
    case 'mapCollapseBumps':             this.config.mapCollapseBumps = utils.validateBool(value, true); break;
    case 'mapLanguage':                   this.config.mapLanguage = utils.validateString(value, 'en'); break;
    case 'mapNoTextures':                 this.config.mapNoTextures = this.config.mapDisableCulling = utils.validateBool(value, false); break;
    case 'mapForceFrameTime':             this.config.mapForceFrameTime = utils.validateNumber(value, -1, Number.MAXINTEGER, 0); break;
    case 'mapFeatureGridCells':           this.config.mapFeatureGridCells = utils.validateNumber(value, -Number.MAXINTEGER, Number.MAXINTEGER, 0); break;
    case 'mapFeaturesPerSquareInch':      this.config.mapFeaturesPerSquareInch = utils.validateNumber(value, 0.000001, Number.MAXINTEGER, 0); break;
    case 'mapFeaturesSortByTop':          this.config.mapFeaturesSortByTop = utils.validateBool(value, false); break;
    case 'mapFeaturesReduceParams':       this.config.mapFeaturesReduceParams = value; break;
    case 'mapLogGeodataStyles':           this.config.mapLogGeodataStyles = utils.validateBool(value, true); break;
    case 'map16bitMeshes':                this.config.map16bitMeshes = utils.validateBool(value, false); break;
    case 'mapOnlyOneUVs':                 this.config.mapOnlyOneUVs = utils.validateBool(value, false); break;
    case 'mapIndexBuffers':               this.config.mapIndexBuffers = utils.validateBool(value, false); break;
    case 'mapSoftViewSwitch':             this.config.mapSoftViewSwitch = utils.validateBool(value, true); break;
    case 'mapAsyncImageDecode':           this.config.mapAsyncImageDecode = (utils.validateBool(value, false) && (typeof createImageBitmap !== 'undefined')) ? true : false; break;
    case 'mapFeatureStickMode':           this.config.mapFeatureStickMode = utils.validateNumberArray(value, 2, [0,1], [Number.MAX_VALUE, Number.MAX_VALUE], [0, 1]); break;
    case 'mapSeparateLoader':             this.config.mapSeparateLoader = utils.validateBool(value, true); break;
    case 'mapGeodataBinaryLoad':          this.config.mapGeodataBinaryLoad = utils.validateBool(value, true); break;
    case 'mapPackLoaderEvents':           this.config.mapPackLoaderEvents = utils.validateBool(value, true); break;
    case 'mapParseMeshInWorker':          this.config.mapParseMeshInWorker = utils.validateBool(value, true); break;
    case 'mapPackGeodataEvents':          this.config.mapPackGeodataEvents = utils.validateBool(value, true); break;
    case 'mapSortHysteresis':             this.config.mapSortHysteresis = utils.validateBool(value, false); break;
    case 'mapHysteresisWait':             this.config.mapHysteresisWait = utils.validateNumber(value, 0, Number.MAXINTEGER, 0); break;
    case 'mapBenevolentMargins':          this.config.mapBenevolentMargins = utils.validateBool(value, false); break;
    case 'mapCheckTextureSize':           this.config.mapCheckTextureSize = utils.validateBool(value, false); break;
    case 'mapNormalizeOctantTexelSize':   this.config.mapNormalizeOctantTexelSize = utils.validateBool(value, true); break;
    case 'mapDMapSize':                   this.config.mapDMapSize = utils.validateNumber(value, 16, Number.MAXINTEGER, 512); break; 
    case 'mapDMapMode':                   this.config.mapDMapMode = utils.validateNumber(value, 1, Number.MAXINTEGER, 1); break;
    case 'mapExposeFpsToWindow':          this.config.mapExposeFpsToWindow = utils.validateBool(value, false); break;
    case 'mapProfileGpu':                 this.config.mapProfileGpu = utils.validateBool(value, false); break;
    case 'mapSplitSpace':                 this.config.mapSplitSpace = value; break;
    case 'mario':                         this.config.mario = utils.validateBool(value, true); break;
    case 'mapFeaturesReduceMode':         
        value = utils.validateString(value, 'scr-count4');
        if (value == 'auto') value = 'scr-count2';
        if (value == 'legacy') value = 'scr-count2';
        if (value == 'gridcells') value = 'scr-count4';
        if (value == 'singlepass') value = 'scr-count5';
        if (value == 'margin') value = 'scr-count6';
        //if (value == 'margin') value = 'scr-count7';
        this.config.mapFeaturesReduceMode = value;
        break;

    }
};


Map.prototype.getConfigParam = function(key) {
    switch (key) {
    case 'map':                           return this.config.map;
    case 'mapCache':                      return this.config.mapCache;
    case 'mapGPUCache':                   return this.config.mapGPUCache;
    case 'mapMetatileCache':              return this.config.mapMetatileCache;
    case 'mapTexelSizeFit':               return this.config.mapTexelSizeFit;
    case 'mapDownloadThreads':            return this.config.mapDownloadThreads;
    case 'mapMaxProcessingTime':          return this.config.mapMaxProcessingTime;
    case 'mapMaxGeodataProcessingTime':   return this.config.mapMaxGeodataProcessingTime;
    case 'mapMobileMode':                 return this.config.mapMobileMode;
    case 'mapMobileModeAutodect':         return this.config.mapMobileModeAutodect;
    case 'mapMobileDetailDegradation':    return this.config.mapMobileDetailDegradation;
    case 'mapNavSamplesPerViewExtent':    return this.config.mapNavSamplesPerViewExtent;
    case 'mapIgnoreNavtiles':             return this.config.mapIgnoreNavtiles;
    case 'mapAllowHires':                 return this.config.mapAllowHires;
    case 'mapAllowLowres':                return this.config.mapAllowLowres;
    case 'mapAllowSmartSwitching':        return this.config.mapAllowSmartSwitching;
    case 'mapDisableCulling':             return this.config.mapDisableCulling;
    case 'mapPreciseCulling':             return this.config.mapPreciseCulling;
    case 'mapHeightLodBlend':             return this.config.mapHeightLodBlend;
    case 'mapHeightNodeBlend':            return this.config.mapHeightNodeBlend;
    case 'mapBasicTileSequence':          return this.config.mapBasicTileSequence;
    case 'mapSmartNodeParsing':           return this.config.mapSmartNodeParsing;
    case 'mapXhrImageLoad':               return this.config.mapXhrImageLoad;
    case 'mapTraversalMaskResolution':    return this.config.mapTraversalMaskResolution;
    case 'mapTraversalMaskThreshold':     return this.config.mapTraversalMaskThreshold;
    case 'mapTraversalMaskErosion':
        return this.config.mapTraversalMaskErosion;
    case 'mapFallbackCadence':            return this.config.mapFallbackCadence;
    case 'mapGridMode':                   return this.config.mapGridMode;
    case 'mapGridSurrogatez':             return this.config.mapGridSurrogatez;
    case 'mapGridTextureLevel':           return this.config.mapGridTextureLevel;
    case 'mapGridTextureLayer':           return this.config.mapGridTextureLayer;
    case 'mapPreciseBBoxTest':            return this.config.mapPreciseBBoxTest;
    case 'mapPreciseDistanceTest':        return this.config.mapPreciseDistanceTest;
    case 'mapForceMetatileV3':            return this.config.mapForceMetatileV3;
    case 'mapVirtualSurfaces':            return this.config.mapVirtualSurfaces;
    case 'mapDegradeHorizon':             return this.config.mapDegradeHorizon;
    case 'mapDegradeHorizonParams':       return this.config.mapDegradeHorizonParams;
    case 'mapRefreshCycles':              return this.config.mapRefreshCycles;
    case 'mapDefaultFont':                return this.config.mapDefaultFont;
    case 'mapMetricUnits':                return this.config.mapMetricUnits;
    case 'mapShadingLambertian':         return this.config.mapShadingLambertian;
    case 'mapShadingSlope':              return this.config.mapShadingSlope;
    case 'mapShadingAspect':             return this.config.mapShadingAspect;
    case 'mapFlagLighting':              return this.config.mapFlagLighting;
    case 'mapFlagNormalMaps':            return this.config.mapFlagNormalMaps;
    case 'mapFlagDiffuseMaps':           return this.config.mapFlagDiffuseMaps;
    case 'mapFlagSpecularMaps':          return this.config.mapFlagSpecularMaps;
    case 'mapFlagBumpMaps':              return this.config.mapFlagBumpMaps;
    case 'mapFlagAtmosphere':            return this.config.mapFlagAtmosphere;
    case 'mapFlagShadows':               return this.config.mapFlagShadows;
    case 'mapFlagLabels':                return this.config.mapFlagLabels;
    case 'mapLanguage':                   return this.config.mapLanguage;
    case 'mapNoTextures':                 return this.config.mapNoTextures;
    case 'mapForceFrameTime':             return this.config.mapForceFrameTime;
    case 'mapFeatureGridCells':           return this.config.mapFeatureGridCells;
    case 'mapFeaturesPerSquareInch':      return this.config.mapFeaturesPerSquareInch;
    case 'mapFeaturesSortByTop':          return this.config.mapFeaturesSortByTop;
    case 'mapFeaturesReduceMode':         return this.config.mapFeaturesReduceMode;
    case 'mapFeaturesReduceParams':       return this.config.mapFeaturesReduceParams;
    case 'mapLogGeodataStyles':           return this.config.mapLogGeodataStyles;
    case 'map16bitMeshes':                return this.config.map16bitMeshes;
    case 'mapOnlyOneUVs':                 return this.config.mapOnlyOneUVs;
    case 'mapIndexBuffers':               return this.config.mapIndexBuffers;
    case 'mapSoftViewSwitch':             return this.config.mapSoftViewSwitch;
    case 'mapAsyncImageDecode':           return this.config.mapAsyncImageDecode;
    case 'mapFeatureStickMode':           return this.config.mapFeatureStickMode;
    case 'mapSeparateLoader':             return this.config.mapSeparateLoader;
    case 'mapGeodataBinaryLoad':          return this.config.mapGeodataBinaryLoad;
    case 'mapPackLoaderEvents':           return this.config.mapPackLoaderEvents;
    case 'mapParseMeshInWorker':          return this.config.mapParseMeshInWorker;
    case 'mapPackGeodataEvents':          return this.config.mapPackGeodataEvents;
    case 'mapSortHysteresis':             return this.config.mapSortHysteresis;
    case 'mapHysteresisWait':             return this.config.mapHysteresisWait;
    case 'mapBenevolentMargins':          return this.config.mapBenevolentMargins;
    case 'mapDMapSize':                   return this.config.mapDMapSize; 
    case 'mapDMapMode':                   return this.config.mapDMapMode;
    case 'mario':                         return this.config.mario;
    }
};


Map.prototype.click = function(screenX, screenY, state) {
    this.clickEvent = [screenX, screenY, state];
};


Map.prototype.hover = function(screenX, screenY, persistent, state) {
    this.hoverEvent = [screenX, screenY, persistent, state];
};


Map.prototype.markDirty = function() {
    this.dirty = true;
    this.hitMapDirty = true;
    this.geoHitMapDirty = true;
};


Map.prototype.getScreenRay = function(screenX, screenY) {
    return this.renderer.getScreenRay(screenX, screenY);
};


Map.prototype.getScreenDepth = function(
    screenX, screenY, dilate = 0, useGeometricIntersection = false,
    coordinateSpace = 'layout') {

    if (useGeometricIntersection) {

        var cameraPos = this.camera.position;
        var ray = this.renderer.getScreenRay(
            screenX, screenY, coordinateSpace), a, d;

        if (this.getNavigationSrs().isProjected()) { //plane fallback
            var planePos = [0,0,Math.min(-1000,this.referenceFrame.getGlobalHeightRange()[0])];
            var planeNormal = [0,0,1];

            d = vec3.dot(planeNormal, ray); //minification is wrong there
            a = [planePos[0] - cameraPos[0], planePos[1] - cameraPos[1], planePos[2] - cameraPos[2]];
            t = vec3.dot(a, planeNormal) / d;

            if (t >= 0) {
                return [true, t];
            } else {
                return [false, 1];
            }

        } else { //elipsoid fallback
            var navigationSrsInfo = this.getNavigationSrs().getSrsInfo();
            var planetRadius = navigationSrsInfo['b'] + this.referenceFrame.getGlobalHeightRange()[0];
        
            var offset = [cameraPos[0], cameraPos[1], cameraPos[2]];
            a = vec3.dot(ray, ray); //minification is wrong there
            var b = 2 * vec3.dot(ray, offset);
            var c = vec3.dot(offset, offset) - planetRadius * planetRadius;
            d = b * b - 4 * a * c;
            
            if (d > 0) {
                d = Math.sqrt(d);
                var t1 = (-b - d) / (2*a);
                var t2 = (-b + d) / (2*a);
                var t = (t1 < t2) ? t1 : t2;

                return [true, t];
            } else {
                return [false, 1];
            }
        }

    } else {

        if (this.hitMapDirty) {
            this.draw.drawHitmap();
            this.renderer.camera.update();
        }

        var res = this.renderer.getDepth(
            screenX, screenY, dilate, coordinateSpace);
    }

    return res;
};


Map.prototype.getHitCoords = function(screenX, screenY, mode, lod) {
    if (this.hitMapDirty) {
        this.draw.drawHitmap();
    }

    var cameraSpaceCoords = this.renderer.hitTest(screenX, screenY);
    
    var fallbackUsed = false; 
    var cameraPos = this.camera.position;
    var worldPos;

    var ray = cameraSpaceCoords[4], a, d;

    if (this.getNavigationSrs().isProjected()) { //plane fallback
        var planePos = [0,0,Math.min(-1000,this.referenceFrame.getGlobalHeightRange()[0])];
        var planeNormal = [0,0,1];

        d = vec3.dot(planeNormal, ray); //minification is wrong there
        //if (d > 1e-6) {
        a = [planePos[0] - cameraPos[0], planePos[1] - cameraPos[1], planePos[2] - cameraPos[2]];
        t = vec3.dot(a, planeNormal) / d;
            
            //var t = (vec3.dot(cameraPos, planeNormal) + (-500)) / d;            
        if (t >= 0) {
            if (!cameraSpaceCoords[3] || t < cameraSpaceCoords[5]) {
                worldPos = [ (ray[0] * t) + cameraPos[0],
                    (ray[1] * t) + cameraPos[1],
                    (ray[2] * t) + cameraPos[2] ];
    
                fallbackUsed = true;
            }
        }
        //}

    } else /*if (false)*/ { //elipsoid fallback
        var navigationSrsInfo = this.getNavigationSrs().getSrsInfo();
        var planetRadius = navigationSrsInfo['b'] + this.referenceFrame.getGlobalHeightRange()[0];
    
        var offset = [cameraPos[0], cameraPos[1], cameraPos[2]];
        a = vec3.dot(ray, ray); //minification is wrong there
        var b = 2 * vec3.dot(ray, offset);
        var c = vec3.dot(offset, offset) - planetRadius * planetRadius;
        d = b * b - 4 * a * c;
        
        if (d > 0) {
            d = Math.sqrt(d);
            var t1 = (-b - d) / (2*a);
            var t2 = (-b + d) / (2*a);
            var t = (t1 < t2) ? t1 : t2;

            //console.log("hit: " + t + ",   " + cameraSpaceCoords[5]);
            
            if (!cameraSpaceCoords[3] || t < cameraSpaceCoords[5]) {
                worldPos = [ (ray[0] * t) + cameraPos[0],
                    (ray[1] * t) + cameraPos[1],
                    (ray[2] * t) + cameraPos[2] ];

                fallbackUsed = true;
            }
        }   
    }
    
    if (!cameraSpaceCoords[3] && !fallbackUsed) {
        return null;
    }
    
    if (!fallbackUsed) {
        worldPos = [ cameraSpaceCoords[0] + cameraPos[0],
            cameraSpaceCoords[1] + cameraPos[1],
            cameraSpaceCoords[2] + cameraPos[2] ];
    }

    var navCoords = this.convert.convertCoords(worldPos, 'physical', 'navigation');

    if (this.renderer.useSuperElevation) {
        navCoords[2] = this.renderer.getUnsuperElevatedHeight(
            navCoords[2], this.position);
    }

    if (mode == 'float') {
        lod =  (lod != null) ? lod : this.measure.getOptimalHeightLod(navCoords, 100, this.config.mapNavSamplesPerViewExtent);
        var surfaceHeight = this.measure.getSurfaceHeight(navCoords, lod);
        navCoords[2] -= surfaceHeight[0]; 
    }

    return navCoords;
};


Map.prototype.hitTestGeoLayers = function(screenX, screenY, mode) {
    var labelsEnabled = this.outerMap.overrides.flagLabels
        ?? this.config.mapFlagLabels;

    if (!labelsEnabled) {
        this.lastHoverFeature = null;
        this.lastHoverFeatureId = null;
        this.hoverFeature = null;
        this.hoverFeatureId = null;

        return [null, false, []];
    }

    if (this.geoHitMapDirty) {
        if (this.freeLayersHaveGeodata) {
            this.draw.drawGeodataHitmap();
        }
    }

    if (!this.freeLayersHaveGeodata) {
        this.lastHoverFeature = null;
        this.lastHoverFeatureId = null;
        this.hoverFeature = null;
        this.hoverFeatureId = null;

        return [null, false, []];
    }

    var res = this.renderer.hitTestGeoLayers(screenX, screenY);
    var relatedEvents, elementIndex;

    if (res[0]) { //do we hit something?
        //console.log(JSON.stringify([id, JSON.stringify(this.hoverFeatureList[id])]));
       
        var id = (res[1]) + (res[2]<<8);
		
        var feature = this.hoverFeatureList[id];

        if (!feature) {
            return [null, false, [], elementIndex];
        }

        if (feature[6]) { //advanced hit feature?
            res = this.renderer.hitTestGeoLayers(screenX, screenY, true);
        
            if (res[0]) { //do we hit something?
                elementIndex = (res[1]) + (res[2]<<8);
            }
        }

        if (mode == 'hover') {
            this.lastHoverFeature = this.hoverFeature;
            this.lastHoverFeatureId = this.hoverFeatureId;
            
            if (feature && feature[3]) {
                this.hoverFeature = feature;
                this.hoverFeatureId = (feature != null) ? feature[0]['#id'] : null;
            } else {
                this.hoverFeature = null;
                this.hoverFeatureId = null;
            }

            relatedEvents = [];

            if (this.hoverFeatureId != this.lastHoverFeatureId) {
                if (this.lastHoverFeatureId != null) {
                    relatedEvents.push(['leave', this.lastHoverFeature, this.lastHoverFeatureId]);
                }

                if (this.hoverFeatureId != null) {
                    relatedEvents.push(['enter', this.hoverFeature, this.hoverFeatureId]);
                }

                this.dirty = true;
            }

            if (this.hoverFeature != null && this.hoverFeature[3]) {
                return [this.hoverFeature, true, relatedEvents, elementIndex];
            } else {
                return [null, false, relatedEvents, elementIndex];
            }
        }

        if (mode == 'click') {
            if (feature != null && feature[2]) {
                return [feature, true, [], elementIndex];
            } else {
                return [null, false, [], elementIndex];
            }
        }
    } else {
        relatedEvents = [];

        if (mode == 'hover') {
            this.lastHoverFeature = this.hoverFeature;
            this.lastHoverFeatureId = this.hoverFeatureId;
            this.hoverFeature = null;
            this.hoverFeatureId = null;

            if (this.lastHoverFeatureId != null) {
                if (this.lastHoverFeatureId != null) {
                    relatedEvents.push(['leave', this.lastHoverFeature, this.lastHoverFeatureId]);
                }

                this.dirty = true;
            }
        }

        return [null, false, relatedEvents, elementIndex];
    }
};

Map.prototype.applyCredits = function(tile) {
    var value, value2;
    for (var key in tile.imageryCredits) {
        value = tile.imageryCredits[key];
        value2 = this.visibleCredits.imagery[key];

        if (value2) {
            this.visibleCredits.imagery[key] = value > value2 ? value : value2;
        } else {
            this.visibleCredits.imagery[key] = value;
        }
    }
    for (key in tile.glueImageryCredits) {
        value = tile.glueImageryCredits[key];
        value2 = this.visibleCredits.imagery[key];

        if (value2) {
            this.visibleCredits.glueImagery[key] = value > value2 ? value : value2;
        } else {
            this.visibleCredits.glueImagery[key] = value;
        }
    }
    for (key in tile.mapdataCredits) {
        value = tile.mapdataCredits[key];
        value2 = this.visibleCredits.mapdata[key];

        if (value2) {
            this.visibleCredits.mapdata[key] = value > value2 ? value : value2;
        } else {
            this.visibleCredits.mapdata[key] = value;
        }
    }    
};


/* Loader workers post completed tile data back to the main thread via
 * onmessage. Those handlers push onLoaded callbacks here instead of
 * running them directly, so that tile-tree mutations and GPU uploads
 * always happen at a known point inside the render loop rather than
 * in a raw message handler that could fire between any two statements. */
Map.prototype.processProcessingTasks = function() {
    while (this.processingTasks.length > 0) {
        if (this.stats.renderBuild > this.config.mapMaxProcessingTime) {
            this.markDirty();
            return;
        }

        this.processingTasks[0]();
        this.processingTasks.shift();
    }

    while (this.processingTasks2.length > 0) {
        if (this.processingTasks2[0]() != -123) {
            this.processingTasks2.shift();
        } else {
            break;
        }
    }

};


Map.prototype.addProcessingTask = function(task) {
    this.processingTasks.push(task);
};

Map.prototype.addProcessingTask2 = function(task) {
    this.processingTasks2.push(task);
};


/* Residual pre-draw JS work owned by `LegacyMap`. Called from
 * `Map.tick` on the ready path, after `stats.begin` and before the
 * dirty-gated draw. */
Map.prototype.tickBefore = function() {

    // the obsolete token expiration check
    if (this.core.tokenExpiration) {

        if (Date.now() > (this.core.tokenExpiration - (1000 * 60))) {
            this.core.tokenExpirationCallback();
        }
    }

    // promote pending requests to downloads
    this.loader.update();

    // process callbacks from workers
    this.processProcessingTasks();
};


/* Residual post-draw JS work owned by `LegacyMap`. Runs every frame
 * after the dirty-gated draw block; the queued hover/click hit-tests
 * use the canvas that was just drawn. No-op when neither event is
 * queued. */
Map.prototype.tickDeferredEvents = function() {

    if (this.clickEvent == null && this.hoverEvent == null) return;

    var renderer = this.renderer;
    var camPos = renderer.cameraPosition;
    var p, result;

    if (this.hoverEvent != null) {

        result = this.hitTestGeoLayers(
            this.hoverEvent[0], this.hoverEvent[1], 'hover');

        var relatedEvents = result[2];

        if (relatedEvents != null) {

            for (var i = 0, li = relatedEvents.length; i < li; i++) {

                var event = relatedEvents[i];
                p = event[1][1];

                var payload = {
                    'feature': event[1][0],
                    'canvas-coords': renderer.project2(
                        event[1][1], renderer.camera.mvp, camPos),
                    'physical-coords': [
                        p[0] + camPos[0],
                        p[1] + camPos[1],
                        p[2] + camPos[2],
                    ],
                    'state': this.hoverEvent[3],
                    'element': result[3],
                };

                if (event[0] === 'enter')
                    this.core.callListener('geo-feature-enter', payload);

                if (event[0] === 'leave')
                    this.core.callListener('geo-feature-leave', payload);
            }
        }

        if (result[1] && result[0] != null) {

            p = result[0][1];
            this.core.callListener('geo-feature-hover', {
                'feature': result[0][0],
                'canvas-coords': renderer.project2(
                    result[0][1], renderer.camera.mvp, camPos),
                'physical-coords': [
                    p[0] + camPos[0],
                    p[1] + camPos[1],
                    p[2] + camPos[2],
                ],
                'state': this.hoverEvent[3],
                'element': result[3],
            });
        }

        // is it persistent event?
        if (this.hoverEvent[2] !== true) {
            this.hoverEvent = null;
        }
    }

    if (this.clickEvent != null) {

        result = this.hitTestGeoLayers(
            this.clickEvent[0], this.clickEvent[1], 'click');

        if (result[1] && result[0] != null) {

            p = result[0][1];
            this.core.callListener('geo-feature-click', {
                'feature': result[0][0],
                'canvas-coords': renderer.project2(
                    result[0][1], renderer.camera.mvp, camPos),
                'physical-coords': [
                    p[0] + camPos[0],
                    p[1] + camPos[1],
                    p[2] + camPos[2],
                ],
                'state': this.clickEvent[2],
                'element': result[3],
            });
        }

        this.clickEvent = null;
    }
};


Map.prototype.isAtmospheric = function() {

    // until the ios alignment bug is fixed...
    if (utils.isIos()) return false;

    // style based map - explicit atmosphere needed
    if (this.style) {

        if  (this.style.styleSpec.atmosphere && this.atmosphere)
            return true;
        else
            return false;
    }

    // mapconfig based map - atmosphere rendered whenever available
    if (this.atmosphere) return true;

    // default
    return false;
}

export default Map;
