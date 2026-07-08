
import {vec3 as vec3_} from '../utils/matrix';
import GpuTexture_ from '../renderer/gpu/texture';
import * as math from '../utils/math';

//get rid of compiler mess
var vec3 = vec3_;
var GpuTexture = GpuTexture_;

 var tileBorderTable = [
    [-1, -1, 0, 0],
    [0, -1, 0.5, 1], //
    [1, -1, 1, 0],

    [-1, 0, 0, 0.5],
    [0, 0, 0.5, 0.5],
    [1, 0, 1, 0.5],

    [-1, 1, 0, 1],
    [0, 1, 0.5, 0], //
    [1, 1, 1, 1]
];

var tileCornerTable = [
    [0,1,3],
    [2,1,5],
    [6,3,7],
    [8,7,5]
];


var MapSurfaceTile = function(map, parent, id) {
    this.map = map;
    this.id = id;
    this.parent = parent;
    this.viewCounter = map.viewCounter;
    this.drawCounter = 0;
    this.childrenReadyCount = 0;
    //this.renderReady = false;
    this.geodataCounter = 0;
    this.gridRenderCounter = 0; //draw grid only once
    this.texelSize = 1;
    this.texelSize2 = 1;
    this.distance = 1;

    // A geometry-less node sets texelSize to Infinity to force descent;
    // that signal is not view-scale aware. This holds a finite,
    // fit-comparable descent estimate for those nodes (see
    // updateTexelSize).
    this.fallbackTexelSize = Number.POSITIVE_INFINITY;
    this.tiltAngle = 1;
    this.seCounter = 0;

    this.metanode = null;  //[metanode, cacheItem]
    this.lastMetanode = null;
    this.boundmetaresources = null; //link to bound layers metatile storage

    this.surface = null;
    this.surfaceMesh = null;
    this.surfaceGeodata = null;     //probably only used in free layers
    this.surfaceGeodataView = null; //probably only used in free layers
    this.surfaceTextures = [];
    this.resourceSurface = null; //surface directing to resources

    this.resetDrawCommands = false;
    this.drawCommands = [[], [], []];

    this.bounds = {};
    this.boundLayers = {};
    this.boundTextures = {};
    this.updateBounds = true;

    this.hmap = null;
    this.heightMap = null;
    this.drawCommands = [[], [], []];
    this.imageryCredits = {};
    this.mapdataCredits = {};
    
    this.resources = this.map.resourcesTree.findNode(id, true);   // link to resource tree
    this.metaresources = this.map.resourcesTree.findAgregatedNode(id, 5, true); //link to meta resource tree
    this.boundresources = this.map.resourcesTree.findAgregatedNode(id, 8, true); //link to meta resource tree
    
    this.children = [null, null, null, null];

    // temporary TileRenderRig (the new aproach to drawing mesh tiles) integration
    this.tileRenderRig = [];
    this.lastRenderRig = [];
};


MapSurfaceTile.prototype.kill = function() {

    //kill children
    for (var i = 0; i < 4; i++) {
        if (this.children[i] != null) {
            this.children[i].kill();
        }
    }
    this.resources = null;
    this.metaresources = null;
    this.metanode = null;

    this.surface = null;
    this.surfaceMesh = null;
    this.surfaceTextures = [];
    this.surfaceGeodata = null;
    this.surfaceGeodataView = null;
    this.resourceSurface = null;

    this.bounds = {};
    this.boundLayers = {};
    this.boundTextures = {};
    this.updateBounds = true;

    //this.renderReady = false;
    this.lastSurface = null;
    this.lastState = null;
        
    this.hmap = null;
    this.heightMap = null;
    this.drawCommands = [[], [], []];
    this.imageryCredits = {};
    this.mapdataCredits = {};

    this.verifyChildren = false;
    this.children = [null, null, null, null];

    this.tileRenderRig.forEach((rig) => rig.dispose());
    this.tileRenderRig = [];

    this.lastRenderRig.forEach((rig) => rig.dispose());
    this.lastRenderRig = [];

    var parent = this.parent;
    this.parent = null;

    if (parent != null) {
        parent.removeChild(this);
    }
};


MapSurfaceTile.prototype.validate = function() {
    //is tile empty?
    if (this.metaresources == null || !this.metaresources.getMetatile(this.surface, null, this)) {
        //this.kill();
    }
};


MapSurfaceTile.prototype.viewSwitched = function() {
    //store last state for view switching
    this.lastSurface = this.surface;
    this.lastState = {
        surfaceMesh : this.surfaceMesh,
        surfaceTextures : this.surfaceTextures,
        boundTextures : this.boundTextures,
        surfaceGeodata : this.surfaceGeodata,
        surfaceGeodataView : this.surfaceGeodataView,
        resourceSurface : this.resourceSurface 
    };    

    //zero surface related data    
    this.verifyChildren = true;
    //this.renderReady = false;
    this.lastMetanode = this.metanode;
    this.metanode = null; //keep old value for smart view switching

    if (!this.map.config.mapSoftViewSwitch) {

        if (this.metanode) {
            this.metanode.border = null;
            this.metanode.borderNodes = null;
            this.metanode.borderReady = null;
        }

        this.lastState = null;
        this.lastMetanode = null;
        this.metanode = null;
        this.gridPoints = null;
    }

    //this.lastMetanode = null;
    //this.metanode = null;

    for (var key in this.bounds) {
        this.bounds[key] = {
            sequence : [],
            alpha : [],
            transparent : false,
            viewCoutner : 0
        };
    }

    this.boundLayers = {};
    this.boundTextures = {};
    this.updateBounds = true;
    this.transparentBounds = false;

    this.surface = null;
    this.surfaceMesh = null;
    this.surfaceTextures = [];
    this.surfaceGeodata = null;
    this.surfaceGeodataView = null;
    this.resourceSurface = null;

    this.drawCommands = [[], [], []];
    this.imageryCredits = {};
    this.mapdataCredits = {};
};


MapSurfaceTile.prototype.restoreLastState = function() {
    if (!this.lastState) {
        return;
    }
    this.surfaceMesh = this.lastState.surfaceMesh;
    this.surfaceTextures = this.lastState.surfaceTextures; 
    this.boundTextures = this.lastState.boundTextures;
    this.surfaceGeodata = this.lastState.surfaceGeodata;
    this.surfaceGeodataView = this.lastState.surfaceGeodataView;
    this.resourceSurface = this.lastState.resourceSurface; 
    this.lastSurface = null;
    this.lastState = null;
    this.lastResourceSurface = null;
};


MapSurfaceTile.prototype.addChild = function(index) {
    if (this.children[index]) {
        return;
    }
    
    var id = this.id;
    var childId = [id[0] + 1, id[1] << 1, id[2] << 1];

    switch (index) {
    case 1: childId[1]++; break;
    case 2: childId[2]++; break;
    case 3: childId[1]++; childId[2]++; break;
    }

    this.children[index] = new MapSurfaceTile(this.map, this, childId);
};


MapSurfaceTile.prototype.removeChildByIndex = function(index) {
    if (this.children[index] != null) {
        this.children[index].kill();
        this.children[index] = null;
    }
    
    //remove resrource node?
};


MapSurfaceTile.prototype.removeChild = function(tile) {
    for (var i = 0; i < 4; i++) {
        if (this.children[i] == tile) {
            this.children[i].kill();
            this.children[i] = null;
        }
    }
};


MapSurfaceTile.prototype.isMetanodeReady = function(tree, priority, preventLoad) {

    //has map view changed?
    if (this.map.viewCounter != this.viewCoutner) {
        this.viewSwitched();
        this.viewCoutner = this.map.viewCounter;
        this.map.markDirty(); 
    }
        
    if (!preventLoad) {

        //provide surface for tile - each tree renders one surface
        if (this.surface == null) {
            this.surface = tree.freeLayerSurface;
        }

        //provide metanode for tile
        if (this.metanode == null || this.lastMetanode) {

            var ret = this.checkMetanode(tree, priority);

            if (!ret && !(this.metanode != null && this.lastMetanode)) {
                //metanode is not ready yet
                return false;
            }
        }
    }

    if (this.metanode == null) { // || processFlag3) { //only for wrong data
        return false;
    }

    this.metanode.metatile.used();

    if (this.lastSurface && this.lastSurface == this.surface) {
        this.lastSurface = null;
        this.restoreLastState();
        //return;
    }

    if (this.surface) {
        this.resourceSurface = this.surface;
    }

    var renderer = this.map.renderer;
    var node = this.metanode;

    // The vertical-exaggeration scale factor depends on the view extent
    // (zoom), so the superelevated height baked into the node goes stale
    // as the camera zooms even when the configuration has not changed.
    // seCounter only tracks configuration changes, not zoom, so on its
    // own it bakes a node once and never refreshes it. Compare the factor
    // at the current bake position against the one last baked into this
    // node and rebake when it differs.
    var seFactor = renderer.useSuperElevation
        ? renderer.getVeScaleFactor(this.map.position) : 1;

    if (this.seCounter != renderer.seCounter
            || node.veBakedFactor !== seFactor) {

        this.seCounter = renderer.seCounter;

        if (renderer.useSuperElevation) {
            node.minZ = renderer.getSuperElevatedHeight(node.minZ2,
                                                        this.map.position);
            node.maxZ = renderer.getSuperElevatedHeight(node.maxZ2,
                                                        this.map.position);
        } else {
            node.minZ = node.minZ2;
            node.maxZ = node.maxZ2;
        }

        node.veBakedFactor = seFactor;

        if (renderer.seCounter > 0) {
            this.gridPoints = null;
            node.border = null;
            node.borderReady = false;
     
            node.generateCullingHelpers();
        }
    }

    return true;
};


MapSurfaceTile.prototype.checkMetanode = function(tree, priority) {
    var surface = this.surface;

    if (surface == null) {
        return false;
    }

    var metatile = this.metaresources.getMetatile(surface, true, this);

    if (metatile.isReady(priority)) {

        this.metanode = metatile.getNode(this.id);
        this.lastMetanode = null;
        this.map.markDirty();

        if (this.metanode != null) {
            this.metanode.tile = this; //used only for validate
            this.lastMetanode = null;
            this.map.markDirty();

            for (var i = 0; i < 4; i++) {
                if (this.metanode.hasChild(i)) {
                    this.addChild(i);
                } else {
                    this.removeChildByIndex(i);
                }
            }
        }

    } else {
        return false;
    }

    return true;
};


MapSurfaceTile.prototype.bboxVisible = function(id, bbox, cameraPos, node) {
    var map = this.map;
    var camera = map.camera;
    if (id[0] < map.measure.minDivisionNodeDepth) {
        return true;
    }
    
    var skipGeoTest = map.config.mapDisableCulling;
    if (!skipGeoTest && map.isGeocent) {
        if (node) {
            //if (true) {  //version with perspektive
            var p2 = node.diskPos;
            var p1 = camera.position;
            var rayVec = [p2[0] - p1[0], p2[1] - p1[1], p2[2] - p1[2]];
            var distance = vec3.normalize4(rayVec) * camera.distanceFactor;
                //vec3.normalize(camVec);
                
            var a = vec3.dot(rayVec, node.diskNormal);
            //} else { //version without perspektive
            //    var a = vec3.dot(camera.vector, node.diskNormal);
            //}
            this.tiltAngle = a;
            
            if (distance > 150000 && a > node.diskAngle) {
                return false;
            }
        }
    }

    if (node.metatile.useVersion >= 4) {
        return camera.camera.pointsVisible(node.bbox2, cameraPos);
    } else {
        if (!(map.isGeocent && (map.config.mapPreciseBBoxTest)) || id[0] < 4) {
            return camera.camera.bboxVisible(bbox, cameraPos);
        } else {
            return camera.camera.pointsVisible(node.bbox2, cameraPos);
        }
    }
};

MapSurfaceTile.prototype.getPixelSize = function(bbox, screenPixelSize, cameraPos, worldPos, returnDistance) {
    var min = bbox.min;
    var max = bbox.max;
    var tilePos1x = min[0] - cameraPos[0];
    var tilePos1y = min[1] - cameraPos[1];
    var tilePos2x = max[0] - cameraPos[0];
    var tilePos2y = min[1] - cameraPos[1];
    var tilePos3x = max[0] - cameraPos[0];
    var tilePos3y = max[1] - cameraPos[1];
    var tilePos4x = min[0] - cameraPos[0];
    var tilePos4y = max[1] - cameraPos[1];
    var h1 = min[2] - cameraPos[2];
    var h2 = max[2] - cameraPos[2];
    
    //camera inside bbox
    if (cameraPos[0] > min[0] && cameraPos[0] < max[0] &&
        cameraPos[1] > min[1] && cameraPos[1] < max[1] &&
        cameraPos[2] > min[2] && cameraPos[2] < max[2]) {

        if (returnDistance) {
            return [Number.POSITIVE_INFINITY, 0.1];
        }
    
        return Number.POSITIVE_INFINITY;
    }

    var factor = 0;
    var camera = this.map.camera.camera;

    //find bbox sector
    if (0 < tilePos1y) { //top row - zero means camera position in y
        if (0 < tilePos1x) { // left top corner
            if (0 > h2) { // hi
                factor = camera.scaleFactor([tilePos1x, tilePos1y, h2], returnDistance);
            } else if (0 < h1) { // low
                factor = camera.scaleFactor([tilePos1x, tilePos1y, h1], returnDistance);
            } else { // middle
                factor = camera.scaleFactor([tilePos1x, tilePos1y, (h1 + h2)*0.5], returnDistance);
            }
        } else if (0 > tilePos2x) { // right top corner
            if (0 > h2) { // hi
                factor = camera.scaleFactor([tilePos2x, tilePos2y, h2], returnDistance);
            } else if (0 < h1) { // low
                factor = camera.scaleFactor([tilePos2x, tilePos2y, h1], returnDistance);
            } else { // middle
                factor = camera.scaleFactor([tilePos2x, tilePos2y, (h1 + h2)*0.5], returnDistance);
            }
        } else { //top side
            if (0 > h2) { // hi
                factor = camera.scaleFactor([(tilePos1x + tilePos2x)*0.5, tilePos2y, h2], returnDistance);
            } else if (0 < h1) { // low
                factor = camera.scaleFactor([(tilePos1x + tilePos2x)*0.5, tilePos2y, h1], returnDistance);
            } else { // middle
                factor = camera.scaleFactor([(tilePos1x + tilePos2x)*0.5, tilePos2y, (h1 + h2)*0.5], returnDistance);
            }
        }
    } else if (0 > tilePos4y) { //bottom row
        if (0 < tilePos4x) { // left bottom corner
            if (0 > h2) { // hi
                factor = camera.scaleFactor([tilePos4x, tilePos4y, h2], returnDistance);
            } else if (0 < h1) { // low
                factor = camera.scaleFactor([tilePos4x, tilePos4y, h1], returnDistance);
            } else { // middle
                factor = camera.scaleFactor([tilePos4x, tilePos4y, (h1 + h2)*0.5], returnDistance);
            }
        } else if (0 > tilePos3x) { // right bottom corner
            if (0 > h2) { // hi
                factor = camera.scaleFactor([tilePos3x, tilePos3y, h2], returnDistance);
            } else if (0 < h1) { // low
                factor = camera.scaleFactor([tilePos3x, tilePos3y, h1], returnDistance);
            } else { // middle
                factor = camera.scaleFactor([tilePos3x, tilePos3y, (h1 + h2)*0.5], returnDistance);
            }
        } else { //bottom side
            if (0 > h2) { // hi
                factor = camera.scaleFactor([(tilePos4x + tilePos3x)*0.5, tilePos3y, h2], returnDistance);
            } else if (0 < h1) { // low
                factor = camera.scaleFactor([(tilePos4x + tilePos3x)*0.5, tilePos3y, h1], returnDistance);
            } else { // middle
                factor = camera.scaleFactor([(tilePos4x + tilePos3x)*0.5, tilePos3y, (h1 + h2)*0.5], returnDistance);
            }
        }
    } else { //middle row
        if (0 < tilePos4x) { // left side
            if (0 > h2) { // hi
                factor = camera.scaleFactor([tilePos1x, (tilePos2y + tilePos3y)*0.5, h2], returnDistance);
            } else if (0 < h1) { // low
                factor = camera.scaleFactor([tilePos1x, (tilePos2y + tilePos3y)*0.5, h1], returnDistance);
            } else { // middle
                factor = camera.scaleFactor([tilePos1x, (tilePos2y + tilePos3y)*0.5, (h1 + h2)*0.5], returnDistance);
            }
        } else if (0 > tilePos3x) { // right side
            if (0 > h2) { // hi
                factor = camera.scaleFactor([tilePos2x, (tilePos2y + tilePos3y)*0.5, h2], returnDistance);
            } else if (0 < h1) { // low
                factor = camera.scaleFactor([tilePos2x, (tilePos2y + tilePos3y)*0.5, h1], returnDistance);
            } else { // middle
                factor = camera.scaleFactor([tilePos2x, (tilePos2y + tilePos3y)*0.5, (h1 + h2)*0.5], returnDistance);
            }
        } else { //center
            if (0 > h2) { // hi
                factor = camera.scaleFactor([(tilePos1x + tilePos2x)*0.5, (tilePos2y + tilePos3y)*0.5, h2], returnDistance);
            } else if (0 < h1) { // low
                factor = camera.scaleFactor([(tilePos1x + tilePos2x)*0.5, (tilePos2y + tilePos3y)*0.5, h1], returnDistance);
            } else { // middle
                factor = camera.scaleFactor([(tilePos1x + tilePos2x)*0.5, (tilePos2y + tilePos3y)*0.5, (h1 + h2)*0.5], returnDistance);
            }
        }
    }

    //console.log("new: " + (factor * screenPixelSize) + " old:" + this.tilePixelSize2(node) );

    if (returnDistance) {
        return [(factor[0] * screenPixelSize), factor[1]];
    }

    return (factor * screenPixelSize);
};


MapSurfaceTile.prototype.getPixelSize3Old = function(node, screenPixelSize, factor) {
    var camera = this.map.camera;
    var d = (camera.geocentDistance*factor) - node.diskDistance;
    if (d < 0) {
        d = -d;
        //return [Number.POSITIVE_INFINITY, 0.1];
    } 

    var a = vec3.dot(camera.geocentNormal, node.diskNormal);
    
    if (a < node.diskAngle2) {
        var a2 = Math.acos(a); 
        var a3 = Math.acos(node.diskAngle2);
        a2 = a2 - a3; 

        var l1 = Math.tan(a2) * node.diskDistance;
        d = Math.sqrt(l1*l1 + d*d);
    }

    factor = camera.camera.scaleFactor2(d);
    return [factor * screenPixelSize, d];
};


MapSurfaceTile.prototype.getPixelSize3 = function(node, screenPixelSize) {
    //if (this.map.drawIndices) {
      //  return this.getPixelSize3Old(node, screenPixelSize, factor);
    //}
    var camera = this.map.camera;
    var cameraDistance = camera.geocentDistance;// * factor;

    var a = vec3.dot(camera.geocentNormal, node.diskNormal); //get angle between tile normal and cameraGeocentNormal
    var d = cameraDistance - (node.diskDistance + (node.maxZ - node.minZ)), d2; //vertical distance from top bbox level

    if (a < node.diskAngle2) { //is camera inside tile conus?
        
        //get horizontal distance
        var a2 = Math.acos(a); 
        var a3 = node.diskAngle2A;
        a2 = a2 - a3; 
        var l1 = Math.tan(a2) * node.diskDistance;// * factor;

        if (d < 0) { //is camera is belown top bbox level?
            d2 = cameraDistance - node.diskDistance;
            if (d2 < 0) { //is camera is belown bottom bbox level?
                d = -d2;
                d = Math.sqrt(l1*l1 + d*d);
            } else { //is camera inside bbox
                d = l1;
            }
        } else {
            d = Math.sqrt(l1*l1 + d*d);
        }

    } else {
        if (d < 0) { //is camera is belown top bbox level?
            d2 = cameraDistance - node.diskDistance;
            if (d2 < 0) { //is camera is belown bottom bbox level?
                d = -d2;
            } else { //is camera inside bbox
                return [Number.POSITIVE_INFINITY, 0.1];
            }
        } 
    }

    return [camera.camera.scaleFactor2(d) * screenPixelSize, d];
};


MapSurfaceTile.prototype.updateTexelSize = function() {
    var pixelSize, factor, v, p;
    var map = this.map;
    var draw = map.draw;
    var camera = map.camera;
    var texelSizeFit = draw.texelSizeFit;
    var node = this.metanode;
    var cameraPos = map.camera.position;
    var preciseDistance = (map.isGeocent && (map.config.mapPreciseDistanceTest || node.metatile.useVersion >= 4));  

    if (node.hasGeometry()) {
        var screenPixelSize = Number.POSITIVE_INFINITY;

        if (node.usedTexelSize()) {
            // hot path
            screenPixelSize = draw.ndcToScreenPixel * node.pixelSize;
        } else if (node.usedDisplaySize()) {
            screenPixelSize = draw.ndcToScreenPixel * ((node.bbox ? node.bbox.maxSize : node.bboxMaxSize) / node.displaySize);
        }

        if (camera.camera.ortho) {
            var height = camera.camera.getViewHeight();
            pixelSize = [(screenPixelSize*2.0) / height, height];
        } else {
            
            if (node.usedDisplaySize()) { 
               
                if (!preciseDistance) {
                    screenPixelSize = draw.ndcToScreenPixel * ((node.bbox ? node.bbox.maxSize : node.bboxMaxSize) / 256);

                    factor = (node.displaySize / 256) * camera.distance;
                    
                    v = camera.vector; //move camera away hack
                    p = [cameraPos[0] - v[0] * factor, cameraPos[1] - v[1] * factor, cameraPos[2] - v[2] * factor];

                    pixelSize = this.getPixelSize(node.bbox, screenPixelSize, p, p, true);
                } else {
                    if (draw.isGeocent) {
                        screenPixelSize = draw.ndcToScreenPixel * ((node.diskAngle2A * draw.planetRadius * 1.41421356236) / node.displaySize);
                    } else {
                        screenPixelSize = draw.ndcToScreenPixel * ((node.bbox ? node.bbox.maxSize : node.bboxMaxSize) / node.displaySize);
                    }

                    pixelSize = this.getPixelSize3(node, screenPixelSize);
                }
            } else {
                
                if (!preciseDistance && texelSizeFit > 1.1) {
                    screenPixelSize = draw.ndcToScreenPixel * node.pixelSize * (texelSizeFit / 1.1);
                    factor = (texelSizeFit / 1.1) * camera.distance;
                    
                    v = camera.vector; //move camera away hack
                    p = [cameraPos[0] - v[0] * factor, cameraPos[1] - v[1] * factor, cameraPos[2] - v[2] * factor];
                    
                    pixelSize = this.getPixelSize(node.bbox, screenPixelSize, p, p, true);
                } else {
                    if (preciseDistance) {
                        pixelSize = this.getPixelSize3(node, screenPixelSize);
                    } else {
                        pixelSize = this.getPixelSize(node.bbox, screenPixelSize, cameraPos, cameraPos, true);
                    }
                }
            }
        }
    } else { // if( !node.hasGeometry())
        if (preciseDistance) {
            pixelSize = this.getPixelSize3(node, 1, 1);
        } else {
            pixelSize = this.getPixelSize(node.bbox, 1, cameraPos, cameraPos, true);
        }

        // A geometry-less node reports texelSize Infinity below, which
        // forces descent regardless of view scale. Compute a finite,
        // fit-comparable estimate instead: model the cell at a 256-sample
        // density and project one sample through the distance factor just
        // computed. Versions 1-4 carry a quantized physical bbox. Versions
        // 5-6 removed it, so derive the corresponding maximum cell span
        // from the physical bbox corners generated for culling.
        var fallbackMaxSize;

        if (node.metatile.version < 5) {
            fallbackMaxSize = node.bbox.maxSize;
        } else {

            var fallbackBbox = node.bbox2;
            fallbackMaxSize = Math.max(
                vec3.distance2(fallbackBbox, 0, fallbackBbox, 3),
                vec3.distance2(fallbackBbox, 3, fallbackBbox, 6),
                vec3.distance2(fallbackBbox, 0, fallbackBbox, 12)
            );
        }

        var fallbackEstimate = pixelSize[0]
            * draw.ndcToScreenPixel * (fallbackMaxSize / 256);

        this.fallbackTexelSize = Number.isFinite(fallbackEstimate)
            ? fallbackEstimate : Number.POSITIVE_INFINITY;

        pixelSize[0] = Number.POSITIVE_INFINITY;
    }

    this.texelSize = pixelSize[0];
    this.distance = pixelSize[1];

    //degrade horizont
    if (!map.config.mapDegradeHorizon || draw.degradeHorizonFactor < 1.0) {
        // hot path
        return;
    }

    var degradeHorizon = map.config.mapDegradeHorizonParams;
    var degradeFadeStart = degradeHorizon[1];
    var degradeFadeEnd = degradeHorizon[2];

    //reduce degrade factor by tilt
    var degradeFactor = draw.degradeHorizonFactor * draw.degradeHorizonTiltFactor; 
    var distance = this.distance * camera.distanceFactor;

    //apply degrade factor smoothly from specified tile distance
    if (distance < degradeFadeStart) {
        degradeFactor = 1.0;
    } else if (distance > degradeFadeStart && distance < degradeFadeEnd) {
        degradeFactor = 1.0 + (degradeFactor-1.0) * ((distance - degradeFadeStart) / (degradeFadeEnd - degradeFadeStart));
    }

    degradeFactor = Math.max(degradeFactor, 1.0);

    //reduce degrade factor by observed distance
    var observerDistance = camera.perceivedDistance;
    var distanceFade = degradeHorizon[3];

    if (observerDistance > distanceFade) {
        degradeFactor = 1.0;
    } else if (observerDistance < distanceFade && degradeFactor > 1.0) {
        degradeFactor = 1.0 + ((degradeFactor - 1.0) * (1.0-(observerDistance / distanceFade)));
    }

    this.texelSize /= degradeFactor;
};



/**
 * Extract credits for a tile submesh and add them to tile.imageryCredits.
 */

MapSurfaceTile.prototype.addSubmeshCredits = function(index, activeLayers = null) {

    // process surface credits
    let specificity = this.surface.specificity;

    for (let k = 0, lk = this.metanode.credits.length; k < lk; k++)
        this.imageryCredits[this.metanode.credits[k]] = specificity;

    // process bound layers
    if (!activeLayers) activeLayers = this.boundLayers;
    if (!Array.isArray(activeLayers)) activeLayers = [ activeLayers ];

    activeLayers.forEach((id) => {

        let layer = this.boundLayers[id];
        if (!layer) return;

        let credits = layer.credits;
        for (let k = 0; k < credits.length; k++)
            this.imageryCredits[credits[k]] = layer.specificity;
    });
}


export default MapSurfaceTile;
