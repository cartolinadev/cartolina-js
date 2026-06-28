
import {mat4 as mat4_, vec3} from '../utils/matrix';
import MapSubmesh_ from './submesh';
import BBox_ from '../renderer/bbox';


//get rid of compiler mess
var mat4 = mat4_;
var BBox = BBox_;
var MapSubmesh = MapSubmesh_;

var MapMesh = function(map, url, tile) {
    this.generateLines = true;
    this.map = map;
    this.stats = map.stats;
    this.mapLoaderUrl  = url;
    this.tile = tile; // used only for stats
    this.use16bit = map.config.map16bitMeshes;
    this.inferPreV6Coverage = shouldInferPreV6Coverage(tile);

    this.bbox = new BBox();
    this.size = 0;
    this.gpuSize = 0;
    this.fileSize = 0;
    this.faces = 0;

    this.cacheItem = null;  //store killSubmeshes
    this.gpuCacheItem = null; //store killGpuSubmeshes

    this.loadState = 0;
    this.loadErrorTime = null;
    this.loadErrorCounter = 0;

    this.mBuffer = new Float32Array(16);
    this.mBuffer2 = new Float32Array(16);
    this.vBuffer = new Float32Array(4);

    this.submeshes = [];
    this.gpuSubmeshes = [];
    this.submeshesKilled = false;
};


MapMesh.prototype.kill = function() {
    this.bbox = null;
    this.killSubmeshes();
    this.killGpuSubmeshes();
};


MapMesh.prototype.killSubmeshes = function(killedByCache) {
    for (var i = 0, li = this.submeshes.length; i < li; i++) {
        this.submeshes[i].kill();
    }
    //this.submeshes = [];
    this.submeshesKilled = true;

    if (killedByCache !== true && this.cacheItem) {
        this.map.resourcesCache.remove(this.cacheItem);
        //this.tile.validate();
    }

    if (this.gpuSubmeshes.length == 0) {
        this.loadState = 0;
    }

    this.cacheItem = null;
};


MapMesh.prototype.killGpuSubmeshes = function(killedByCache) {
    var size = 0;
    for (var i = 0, li = this.gpuSubmeshes.length; i < li; i++) {
        this.gpuSubmeshes[i].kill();
        size += this.gpuSubmeshes[i].getSize();
    }

    if (li > 0) {
        this.stats.gpuMeshes -= size;
        this.stats.graphsFluxMesh[1][0]++;
        this.stats.graphsFluxMesh[1][1] += size;
    }

    this.gpuSubmeshes = [];

    if (killedByCache !== true && this.gpuCacheItem) {
        this.map.gpuCache.remove(this.gpuCacheItem);
        //this.tile.validate();
    }

    //console.log("kill: " + this.stats.counter + "   " + this.mapLoaderUrl);

//    if (this.submeshes.length == 0) {
    if (this.submeshesKilled) {
        this.loadState = 0;
    }

    this.gpuCacheItem = null;
};


MapMesh.prototype.isReady = function(doNotLoad, priority, doNotCheckGpu) {
    var doNotUseGpu = (this.map.stats.gpuRenderUsed >= this.map.draw.maxGpuUsed);
    doNotLoad = doNotLoad || doNotUseGpu;

    if (this.loadState == 2) { //loaded
        if (this.cacheItem) {
            this.map.resourcesCache.updateItem(this.cacheItem);
        }

        if (doNotCheckGpu) {
            return true;
        }

        if (this.gpuSubmeshes.length == 0) {
            if (this.map.stats.gpuRenderUsed >= this.map.draw.maxGpuUsed) {
                return false;
            }

            /*if (this.stats.renderBuild > this.map.config.mapMaxProcessingTime) {
                this.map.markDirty();
                return false;
            }*/

            if (doNotUseGpu) {
                return false;
            }

            var t = performance.now();
            this.buildGpuSubmeshes();
            this.stats.renderBuild += performance.now() - t;
        }

        if (!doNotLoad && this.gpuCacheItem) {
            this.map.gpuCache.updateItem(this.gpuCacheItem);
        }
        return true;
    } else {
        if (this.loadState == 0) {
            if (doNotLoad) {
                //remove from queue
                //if (this.mapLoaderUrl) {
                  //  this.map.loader.remove(this.mapLoaderUrl);
                //}
            } else {
                //not loaded
                //add to loading queue or top position in queue
                this.scheduleLoad(priority);
            }
        } else if (this.loadState == 3) { //loadError
            if (this.loadErrorCounter <= this.map.config.mapLoadErrorMaxRetryCount &&
                performance.now() > this.loadErrorTime + this.map.config.mapLoadErrorRetryTime) {

                this.scheduleLoad(priority);
            }
        } //else load in progress
    }

    return false;
};


MapMesh.prototype.scheduleLoad = function(priority) {
    if (!this.mapLoaderUrl) {
        this.mapLoaderUrl = this.map.url.makeUrl(this.tile.resourceSurface.meshUrl, {lod:this.tile.id[0], ix:this.tile.id[1], iy:this.tile.id[2] });
    }

    this.map.loader.load(this.mapLoaderUrl, this.onLoad.bind(this), priority, this.tile, 'mesh');
};


MapMesh.prototype.onLoad = function(url, onLoaded, onError) {
    this.mapLoaderCallLoaded = onLoaded;
    this.mapLoaderCallError = onError;

    this.map.loader.processLoadBinary(
        url, this.onLoaded.bind(this), this.onLoadError.bind(this), null,
        'mesh', {
            inferPreV6Coverage: this.inferPreV6Coverage
        });
    this.loadState = 1;
};


MapMesh.prototype.onLoadError = function() {
    if (this.map.killed){
        return;
    }

    this.loadState = 3;
    this.loadErrorTime = performance.now();
    this.loadErrorCounter ++;

    //make sure we try to load it again
    if (this.loadErrorCounter <= this.map.config.mapLoadErrorMaxRetryCount) {
        setTimeout((function(){ if (!this.map.killed) { this.map.markDirty(); } }).bind(this), this.map.config.mapLoadErrorRetryTime);
    }

    this.mapLoaderCallError();
};


MapMesh.prototype.onLoaded = function(data, task, direct) {
    if (this.map.killed){
        return;
    }

    if (!task) {
        //this.map.stats.renderBuild > this.map.config.mapMaxProcessingTime) {
        this.map.markDirty();
        this.map.addProcessingTask(this.onLoaded.bind(this, data, true, direct));
        return;
    }

    var t = performance.now();

    if (direct) {
        this.parseWorkerData(data);
    } else {
        this.fileSize = data.byteLength;
        var stream = {data: new DataView(data), buffer:data, index:0};
        this.parseMapMesh(stream);
    }

    this.map.stats.renderBuild += performance.now() - t;

    this.submeshesKilled = false;

    this.cacheItem = this.map.resourcesCache.insert(this.killSubmeshes.bind(this, true), this.size);

    this.map.markDirty();
    this.loadState = 2;
    this.loadErrorTime = null;
    this.loadErrorCounter = 0;
    this.mapLoaderCallLoaded();
};


// Returns RAM usage in bytes.
//MapMesh.prototype.getSize = function () {
  //  return this.size;
//};

//MapMesh.prototype.fileSize = function () {
    //return this.fileSize;
//};


MapMesh.prototype.parseWorkerData = function (data) {
    this.faces = data['faces'];
    this.gpuSize = data['gpuSize'];
    this.meanUndulation = data['meanUndulation'];
    this.numSubmeshes = data['numSubmeshes'];
    this.size = data['size'];
    this.version = data['version'];
    this.submeshes = [];

    var submeshes = data['submeshes'];

    for (var i = 0, li = submeshes.length; i < li; i++) {
        var submesh = new MapSubmesh(this);
        var submeshData = submeshes[i];

        submesh.bbox.min = submeshData['bboxMin'];
        submesh.bbox.max = submeshData['bboxMax'];
        submesh.externalUVs = submeshData['externalUVs'];
        submesh.faces = submeshData['faces'];
        submesh.flags = submeshData['flags'];
        submesh.gpuSize = submeshData['gpuSize'];
        submesh.inferredFullCoverage =
            submeshData['inferredFullCoverage'];
        submesh.indices = submeshData['indices'];
        submesh.internalUVs = submeshData['internalUVs'];
        submesh.size = submeshData['size'];
        submesh.surfaceReference = submeshData['surfaceReference'];
        submesh.textureLayer = submeshData['textureLayer'];
        submesh.textureLayer2 = submeshData['textureLayer2'];
        submesh.vertices = submeshData['vertices'];

        this.submeshes.push(submesh);
    }

    this.bbox.updateMaxSize();
};

/**
 * @param stream = {data: new DataView(data), buffer:data, index:0};
 */

MapMesh.prototype.parseMapMesh = function (stream) {
/*
    struct MapMesh {
        struct MapMeshHeader {
            char magic[2];                // letters "ME"
            ushort version;               // currently 1
            double meanUndulation;        // read more about undulation below
            ushort numSubmeshes;          // number of submeshes
        } header;
        struct Submesh submeshes [];      // array of submeshes, size of array is defined by numSubmeshes property
    };
*/
    this.killSubmeshes(); //just in case

    //parase header
    var streamData = stream.data;
    var magic = '';

    if (streamData.length < 2) {
        return false;
    }

    magic += String.fromCharCode(streamData.getUint8(stream.index, true)); stream.index += 1;
    magic += String.fromCharCode(streamData.getUint8(stream.index, true)); stream.index += 1;

    if (magic != 'ME') {
        return false;
    }

    this.version = streamData.getUint16(stream.index, true); stream.index += 2;

    if (this.version > 3) {
        return false;
    }

    //if (this.version >= 3) {
    stream.uint8Data = new Uint8Array(stream.buffer);
    //}

    this.meanUndulation = streamData.getFloat64(stream.index, true); stream.index += 8;
    this.numSubmeshes = streamData.getUint16(stream.index, true); stream.index += 2;

    this.submeshes = [];
    this.gpuSize = 0;
    this.faces = 0;

    for (var i = 0, li = this.numSubmeshes; i < li; i++) {
        var submesh = new MapSubmesh(this, stream);
        if (submesh.valid) {
            this.submeshes.push(submesh);
            this.size += submesh.getSize();
            this.faces += submesh.faces;

            //aproximate size
            this.gpuSize += submesh.getSize();
        }
    }

    this.numSubmeshes = this.submeshes.length;
};


MapMesh.prototype.addSubmesh = function(submesh) {
    this.submeshes.push(submesh);
    this.size += submesh.size;
    this.faces += submesh.faces;
};


MapMesh.prototype.buildGpuSubmeshes = function() {
    var size = 0;
    this.gpuSubmeshes = new Array(this.submeshes.length);

    for (var i = 0, li = this.submeshes.length; i < li; i++) {
        this.gpuSubmeshes[i] = this.submeshes[i].buildGpuMesh();
        size += this.gpuSubmeshes[i].getSize();
    }

    this.stats.gpuMeshes += size;
    this.stats.graphsFluxMesh[0][0]++;
    this.stats.graphsFluxMesh[0][1] += size;

    this.gpuCacheItem = this.map.gpuCache.insert(this.killGpuSubmeshes.bind(this, true), size);
    this.gpuSize = size;

    //console.log("build: " + this.stats.counter + "   " + this.mapLoaderUrl);
};


export default MapMesh;


function shouldInferPreV6Coverage(tile) {
    var version = tile && tile.metanode && tile.metanode.metatile
        ? tile.metanode.metatile.version
        : null;

    return typeof version == 'number' && version < 6;
}
