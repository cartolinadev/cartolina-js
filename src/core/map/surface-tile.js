
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
    this.tiltAngle = 1;
    this.seCounter = 0;

    this.metanode = null;  //[metanode, cacheItem]
    this.lastMetanode = null;
    this.boundmetaresources = null; //link to bound layers metatile storage

    this.surface = null; //surface or glue
    this.surfaceMesh = null;
    this.surfaceGeodata = null;     //probably only used in free layers
    this.surfaceGeodataView = null; //probably only used in free layers
    this.surfaceTextures = [];
    this.resourceSurface = null; //surface directing to resources

    this.virtual = false;
    this.virtualReady = false;
    this.virtualSurfaces = [];
    
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
    this.glueImageryCredits = {};
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

    this.virtual = false;
    this.virtualReady = false;
    this.virtualSurfaces = [];

    //this.renderReady = false;
    this.lastSurface = null;
    this.lastState = null;
        
    this.hmap = null;
    this.heightMap = null;
    this.drawCommands = [[], [], []];
    this.imageryCredits = {};
    this.glueImageryCredits = {};
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
    this.metanode = null; //quick hack for switching virtual surfaeces //keep old value for smart switching

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
    
    this.virtual = false;
    this.virtualReady = false;
    this.virtualSurfaces = [];
    this.virtualSurfacesUncomplete = false;
    
    this.drawCommands = [[], [], []];
    this.imageryCredits = {};
    this.glueImageryCredits = {};
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
   
        //provide surface for tile
        if (this.virtualSurfacesUncomplete || (this.surface == null && this.virtualSurfaces.length == 0) ) { //|| this.virtualSurfacesUncomplete) {
            this.checkSurface(tree, priority);
        }
   
        //provide metanode for tile
        if (this.metanode == null || this.lastMetanode) {
            
            if (!this.virtualSurfacesUncomplete) {
                var ret = this.checkMetanode(tree, priority);
                
                if (!ret && !(this.metanode != null && this.lastMetanode)) { //metanode is not ready yet
                    return false;
                }
            }
            
            /*if (this.lastMetanode) {
                processFlag2 = true;
            }*/
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
        if (this.surface.virtual) {
            this.resourceSurface = this.surface.getSurface(this.metanode.sourceReference);
            if (!this.resourceSurface) {
                console.warn('Virtual surface sourceReference %d not found'
                    + ' in mapping for surface %s — tile %s will be'
                    + ' skipped.',
                    this.metanode.sourceReference,
                    this.surface.id, this.id);
                this.resourceSurface = this.surface;
            }
        } else {
            this.resourceSurface = this.surface;
        }
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


MapSurfaceTile.prototype.checkSurface = function(tree, priority) {
    this.surface = null;
    this.virtual = false;
    this.virtualReady = false;
    this.virtualSurfaces = [];
    this.virtualSurfacesUncomplete = false;
    
    if (tree.freeLayerSurface) {  //free layer has only one surface
        this.surface = tree.freeLayerSurface;
        return; 
    }

    var sequence = tree.surfaceSequence;

    //multiple surfaces
    //build virtual surfaces array
    //find surfaces with content
    for (var i = 0, li = sequence.length; i < li; i++) {
        var surface = sequence[i][0];
        var alien = sequence[i][1];

        var res = surface.hasTile2(this.id);
        if (res[0]) {
            
            //check if tile exist
            if (this.id[0] > 0) { //surface.lodRange[0]) {
                // removed for debug !!!!!
                // ????????
                var parent = this.parent;
                if (parent) { 
                    
                    if (parent.virtualSurfacesUncomplete) {
                        this.virtualSurfacesUncomplete = true;
                        this.virtualSurfaces = [];
                        return;
                    }
                    
                    var metatile = parent.metaresources.getMetatile(surface, null, this);
                    if (metatile) {
                        
                        if (!metatile.isReady(priority)) {
                            this.virtualSurfacesUncomplete = true;
                            continue;
                        }
                        
                        var node = metatile.getNode(parent.id);
                        if (node) {
                            if (!node.hasChildById(this.id)) {
                                continue;
                            }
                        } else {
                            continue;
                        }
                    } else {
                        continue;
                    }
                }
            }
    
            //store surface
            this.virtualSurfaces.push([surface, alien]);        
        }
    }

    if (this.virtualSurfaces.length > 1) {
        this.virtual = true;
    } else {
        this.surface = (this.virtualSurfaces[0]) ? this.virtualSurfaces[0][0] : null;
    }
};


MapSurfaceTile.prototype.checkMetanode = function(tree, priority) {
    if (this.virtual) {
        if (this.isVirtualMetanodeReady(tree, priority)) {
            this.metanode = this.createVirtualMetanode(tree, priority);
            this.lastMetanode = null;
            this.map.markDirty();
        } else {
            return false;
        }
    }

    var surface = this.surface;

    if (surface == null) {
        return false;
    }

    var metatile = this.metaresources.getMetatile(surface, true, this);

    if (metatile.isReady(priority)) {

        if (!this.virtual) {
            this.metanode = metatile.getNode(this.id);
            this.lastMetanode = null;
            this.map.markDirty(); 
        }

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


MapSurfaceTile.prototype.isVirtualMetanodeReady = function(tree, priority) {
    var surfaces = this.virtualSurfaces;
    var readyCount = 0;

    for (var i = 0, li = surfaces.length; i < li; i++) {
        var surface = surfaces[i][0];
        var metatile = this.metaresources.getMetatile(surface, true, this);

        if (metatile.isReady(priority)) {
            readyCount++;
        }
    }
    
    if (readyCount == li) {
        return true;        
    } else {
        return false;
    }
};


MapSurfaceTile.prototype.createVirtualMetanode = function(tree, priority) {
    var surfaces = this.virtualSurfaces;
    var node = null, i, li, surface, metatile, metanode;

    //get top most existing surface
    for (i = 0, li = surfaces.length; i < li; i++) {
        surface = surfaces[i][0];
        var alien = surfaces[i][1];
        metatile = this.metaresources.getMetatile(surface, null, this);

        if (metatile.isReady(priority)) {
            metanode = metatile.getNode(this.id);

            if (metanode != null) {
                if (alien != metanode.alien) {
                    continue;
                }

                //does metanode have surface reference?
                //internalTextureCount is reference to surface
                if (!alien && surface.glue && !metanode.hasGeometry() &&
                    metanode.internalTextureCount > 0) {
                    
                    var desiredSurfaceIndex = metanode.internalTextureCount - 1;
                    desiredSurfaceIndex = this.map.getSurface(surface.id[desiredSurfaceIndex]).viewSurfaceIndex;
                    
                    var jump = false; 
                        
                    for (var j = i; j < li; j++) {
                        if (surfaces[j].viewSurfaceIndex <= desiredSurfaceIndex) {
                            jump = (j > i);
                            i = j - 1;
                            break;
                        }
                    }
                    
                    if (jump) {
                        continue;
                    }                         
                }
                
                if (metanode.hasGeometry()) {
                    node = metanode.clone();
                    this.surface = surface;
                    break;
                }
            }
        }
    }

    //extend bbox, credits and children flags by other surfaces
    for (i = 0, li = surfaces.length; i < li; i++) {
        surface = surfaces[i][0];
        metatile = this.metaresources.getMetatile(surface, null, this);

        if (metatile.isReady(priority)) {
            metanode = metatile.getNode(this.id);

            if (metanode != null) {
                //does metanode have surface reference?
                //internalTextureCount is reference to surface
                /*
                if (surface.glue && !metanode.hasGeometry() &&
                    metanode.internalTextureCount > 0) {
                    i = this.map.surfaceSequenceIndices[metanode.internalTextureCount - 1] - 1;
                    continue;
                }*/

                if (!node) { //just in case all surfaces are without geometry
                    node = metanode.clone();
                    this.surface = surface;
                } else {
                    node.flags |= metanode.flags & ((15)<<4); 

                    /*
                    for (var j = 0, lj = metanode.credits.length; j <lj; j++) {
                        if (node.credits.indexOf(metanode.credits[j]) == -1) {
                            node.credits.push(metanode.credits[j]);
                        } 
                    }*/
                   
                    if (metatile.useVersion < 4) {
                        // removed for debug !!!!!
                        node.bbox.min[0] = Math.min(node.bbox.min[0], metanode.bbox.min[0]); 
                        node.bbox.min[1] = Math.min(node.bbox.min[1], metanode.bbox.min[1]); 
                        node.bbox.min[2] = Math.min(node.bbox.min[2], metanode.bbox.min[2]); 
                        node.bbox.max[0] = Math.max(node.bbox.max[0], metanode.bbox.max[0]); 
                        node.bbox.max[1] = Math.max(node.bbox.max[1], metanode.bbox.max[1]); 
                        node.bbox.max[2] = Math.max(node.bbox.max[2], metanode.bbox.max[2]);
                    }
                }
            }
        }
    }
    
    if (node) {
        node.generateCullingHelpers(true);
    }
    
    return node;
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

MapSurfaceTile.prototype.insideCone = function(coneVec, angle, node) {

    if (this.map.isGeocent) { // && node.diskPos && node.diskNormal) {
        var a = Math.acos(vec3.dot(coneVec, node.diskNormal));

        return (a < angle + node.diskAngle2A);
    }

    return false;
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

        //pixelSize = this.getPixelSize(node.bbox, 1, cameraPos, cameraPos, true);
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
 * Extract credits for a tile submesh and add them to tile.[glueI|i]mageryCredits.
 * The submeshes are presumed too follow the same order as the components of
 * the glue id.
 */

MapSurfaceTile.prototype.addSubmeshCredits = function(index, activeLayers = null) {

    // process surface credits
    if (this.surface.glue) {

        let specificity
            = this.map.getSurface(this.surface.id[index]).specificity;

        //set credits
        for (let k = 0, lk = this.metanode.credits.length; k < lk; k++)
            this.glueImageryCredits[this.metanode.credits[k]] = specificity;

    } else  {

        let specificity = this.surface.specificity;

        //set credits
        for (let k = 0, lk = this.metanode.credits.length; k < lk; k++)
            this.imageryCredits[this.metanode.credits[k]] = specificity;
    }

    // process bound layers
    if (!activeLayers) activeLayers = this.boundLayers;
    if (!Array.isArray(activeLayers)) activeLayers = [ activeLayers ];

    activeLayers.forEach((id) => {

        let layer = this.boundLayers[id];
        let credits = layer.credits;
        for (let k = 0; k < credits.length; k++)
            this.imageryCredits[credits[k]] = layer.specificity;
    });
}


export default MapSurfaceTile;

