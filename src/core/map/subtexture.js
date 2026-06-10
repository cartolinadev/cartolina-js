
import * as utils from '../utils/utils';
import GpuTexture from '../renderer/gpu/texture';
import Atmosphere from './atmosphere';

import {
    decodeGrayPng, grayPngDecodeAvailable
} from '../utils/gray-png';

import * as vts from '../constants';

var MapSubtexture = function(map, path, type, tile, internal) {
    this.map = map;
    this.stats = map.stats;
    this.tile = tile; // used only for stats
    this.internal = internal; // used only for stats
    this.image = null; // image bitmap (browser-native image container)
    this.imageData = null; // raw RGBA byte array (height, metatile)
    this.imageExtents = null;
    this.gpuTexture = null;
    this.loadState = 0;
    this.loadErrorTime = null;
    this.loadErrorCounter = 0;
    this.neverReady = false;
    this.mapLoaderUrl = path;
    this.type = Number(type) || vts.TEXTURETYPE_COLOR; // necessary normalization, due to faulty callers using true instead of vts.TEXTURETYPE_HEIGHT etc.
    this.statsCounter = 0;
    this.checkStatus = 0;
    this.checkType = null;
    this.checkValue = null;
    this.fastHeaderCheck = false;
    this.gpuSize = 0;
    this.fileSize = 0;
    this.cacheItem = null; //store killImage
    this.gpuCacheItem = null; //store killGpuTexture
};


MapSubtexture.prototype.kill = function() {

    console.log("MapSubtexture.kill called for: ", this.mapLoaderUrl);

    this.killImage();
    this.killGpuTexture();
    
    if (this.mask) {
        this.mask.killImage(); 
        this.mask.killGpuTexture(); 
    }
    
    //this.tile.validate();
};


MapSubtexture.prototype.killImage = function(killedByCache) {

    // close() releases ImageBitmap pixel storage at once instead of
    // leaving it to garbage collection (on WebKit it is gpu memory)
    if (this.image && typeof this.image.close === 'function')
        this.image.close();

    this.image = null;
    this.imageData = null;

    if (killedByCache !== true && this.cacheItem) {
        this.map.resourcesCache.remove(this.cacheItem);
        //this.tile.validate();
    }

    if (this.mask) {
        this.mask.killImage(); 
    }

    if (!this.gpuTexture) {
        this.loadState = 0;
    } //else {
        //this.loadState = this.loadState;
    //}

    this.cacheItem = null;
};


MapSubtexture.prototype.killGpuTexture = function(killedByCache) {

    if (this.gpuTexture != null) {
        this.stats.gpuTextures -= this.gpuTexture.getSize();
        this.gpuTexture.kill();

        this.stats.graphsFluxTexture[1][0]++;
        this.stats.graphsFluxTexture[1][1] += this.gpuTexture.getSize();

        if (this.mask) {
            this.mask.killGpuTexture(); 
        }
    }

    this.gpuTexture = null;

    if (killedByCache !== true && this.gpuCacheItem) {
        this.map.gpuCache.remove(this.gpuCacheItem);
        //this.tile.validate();
    }

    if (!this.image && !this.imageData) {
        this.loadState = 0;
    }

    this.gpuCacheItem = null;
};


MapSubtexture.prototype.isReady = function(doNotLoad, priority, doNotCheckGpu, texture) {
    var doNotUseGpu = (this.map.stats.gpuRenderUsed >= this.map.draw.maxGpuUsed);
    doNotLoad = doNotLoad || doNotUseGpu;
    
    if (this.neverReady) {
        return false;
    }

    switch (texture.checkType) {
    case vts.TEXTURECHECK_TYPE:
    case vts.TEXTURECHECK_CODE:
    case vts.TEXTURECHECK_SIZE:
        
        if (this.checkStatus != 2) {
            this.checkType = texture.checkType;
            this.checkValue = texture.checkValue;

            if (this.checkStatus == 0) {
                this.scheduleHeadRequest(priority, (this.checkType == vts.TEXTURECHECK_SIZE));
            } else if (this.checkStatus == 3) { //loadError
                if (this.loadErrorCounter <= this.map.config.mapLoadErrorMaxRetryCount &&
                        performance.now() > this.loadErrorTime + this.map.config.mapLoadErrorRetryTime) {
                    this.scheduleHeadRequest(priority, (this.checkType == vts.TEXTURECHECK_SIZE));
                }
            } else if (this.checkStatus == -1) {
            
                if (texture.extraInfo) { //find at least texture with lower resolution
                    if (!texture.extraBound) {
                        texture.extraBound = { tile: texture.extraInfo.tile, layer: texture.extraInfo.layer};
                        texture.setBoundTexture(texture.extraBound.tile.parent, texture.extraBound.layer);        
                    }
        
                    while (texture.extraBound.texture.extraBound || texture.extraBound.texture.checkStatus == -1) {
                        //while (texture.extraBound.texture.checkStatus == -1) {
                        texture.setBoundTexture(texture.extraBound.sourceTile.parent, texture.extraBound.layer);        
                    }
                }
            }
    
            return false;
        }
            
        break;
    }

    if (this.loadState == 2) { //loaded
        var t;

        // keep the item warm in resource cache
        if (!doNotLoad && this.cacheItem) {

            this.map.resourcesCache.updateItem(this.cacheItem);
        }

        switch(this.type) {

            case vts.TEXTURETYPE_HEIGHT:

                if (!this.imageData) {

                    // build heightmap
                    t = performance.now();
                    this.buildHeightMap();
                    this.stats.renderBuild += performance.now() - t;
                }

                return true;

            case vts.TEXTURETYPE_ATMDENSITY:

                if (!this.decoded) {

                    t = performance.now();

                    this.buildHeightMap(); let extents = this.imageExtents;

                    this.decoded = Atmosphere.decodeAtmosphereDensity({
                        width: extents[0], height: extents[1], data:
                        this.imageData });

                    this.imageExtents = [this.decoded.width, this.decoded.height];

                    this.stats.renderBuild += performance.now() - t;
                }

                if (doNotCheckGpu) return true;

                if (!this.gpuTexture) {

                    t = performance.now();
                    this.buildGpuTexture();
                    this.stats.renderBuild += performance.now() - t;
                }

                if (!doNotLoad && this.gpuCacheItem)
                    this.map.gpuCache.updateItem(this.gpuCacheItem);

                return true;

            default:
                if (doNotCheckGpu) return true;

                if (!this.gpuTexture) {
                    if (this.map.stats.gpuRenderUsed >= this.map.draw.maxGpuUsed)
                        return false;
                
                    if (doNotUseGpu) return false;

                    t = performance.now();
                    this.buildGpuTexture();
                    this.stats.renderBuild += performance.now() - t;
                }

                if (!doNotLoad && this.gpuCacheItem)
                    this.map.gpuCache.updateItem(this.gpuCacheItem);

                return true;

        } // switch(this.type)

    } else { // if (this.loadState != 2)
        if (this.loadState == 0) { 
            if (doNotLoad) {
                //remove from queue
                //if (this.mapLoaderUrl) {
                    //this.map.loader.remove(this.mapLoaderUrl);
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


MapSubtexture.prototype.scheduleLoad = function(priority, header) {
    this.map.loader.load(this.mapLoaderUrl, this.onLoad.bind(this, header), priority, this.tile, this.internal ? 'texture-in' : 'texture-ex');
};


MapSubtexture.prototype.onLoad = function(header, url, onLoaded, onError) {
    this.mapLoaderCallLoaded = onLoaded;
    this.mapLoaderCallError = onError;

    var onerror = this.onLoadError.bind(this);
    var onload = this.onLoaded.bind(this);

    if (header) {
        this.checkStatus = 1;
    } else {
        this.loadState = 1;
    }

    // the atmosphere density texture carries encoded numbers, not
    // colors. The browser image pipeline color-manages PNG pixels (on
    // iOS this changes the bytes and corrupts the encoding), so the
    // PNG is fetched raw and decoded by the gray-png module instead.
    if (this.type == vts.TEXTURETYPE_ATMDENSITY
        && grayPngDecodeAvailable()) {

        this.map.loader.processLoadBinary(url,
            this.onDensityBinaryLoaded.bind(this), onerror, null,
            'atmdensity');

        return;
    }

    if (this.map.config.mapXhrImageLoad) {
        //utils.loadBinary(url, this.onBinaryLoaded.bind(this), onerror, (utils.useCredentials ? (this.mapLoaderUrl.indexOf(this.map.url.baseUrl) != -1) : false), this.map.core.xhrParams, 'blob');
        this.map.loader.processLoadBinary(url, this.onBinaryLoaded.bind(this), onerror, null, 'texture');
    } else {
        this.image = utils.loadImage(url, onload, onerror, (this.map.core.tokenCookieHost ? (url.indexOf(this.map.core.tokenCookieHost) != -1) : false));
    }
    //mapXhrImageLoad
};


MapSubtexture.prototype.onLoadError = function(killBlob) {
    if (this.map.killed){
        return;
    }

    if (killBlob) {
        window.URL.revokeObjectURL(this.image.src);
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


MapSubtexture.prototype.onBinaryLoaded = function(data, direct, filesize) {

    if (this.fastHeaderCheck && this.checkType && this.checkType != vts.TEXTURECHECK_METATILE) {
        this.onHeadLoaded(null, data, null /*status*/);
        
        if (this.checkStatus == -1) {
            this.mapLoaderCallLoaded();
            return;
        }
    }


    if (direct) {
        // worker decoded image (mapAsynbcImageDecode), data is image bitmap
        this.onLoaded(false, data)
        this.fileSize = filesize;
        return;
    }

    // main thread decoding, data is blob
    this.fileSize = data.size;

    createImageBitmap(data)
        .then(this.onLoaded.bind(this,false))
        .catch(this.onLoadError.bind(this, false));
};


/**
 * Atmosphere density download handler. Receives the raw PNG bytes and
 * hands them to the gray-png decoder, keeping the browser image
 * pipeline (and its color management) out of the loop.
 *
 * @param data the PNG file as an ArrayBuffer
 */
MapSubtexture.prototype.onDensityBinaryLoaded = function(data) {

    this.fileSize = data.byteLength;

    decodeGrayPng(data)
        .then(this.onDensityDecoded.bind(this))
        .catch(this.onLoadError.bind(this, false));
};


/**
 * Atmosphere density decode handler. Repacks the verbatim grayscale
 * planes into the interleaved rgb layout that the gpu texture upload
 * expects, then finishes the load like onLoaded does.
 *
 * @param img decoded image: width, height, one byte per pixel
 */
MapSubtexture.prototype.onDensityDecoded = function(img) {

    if (this.map.killed) {
        return;
    }

    this.decoded = Atmosphere.decodeAtmosphereDensityGray(img);
    this.imageExtents = [this.decoded.width, this.decoded.height];

    this.cacheItem = this.map.resourcesCache.insert(
        this.killImage.bind(this, true), this.decoded.data.length);

    this.map.markDirty();
    this.loadState = 2;
    this.loadErrorTime = null;
    this.loadErrorCounter = 0;
    this.mapLoaderCallLoaded();
};


MapSubtexture.prototype.onLoaded = function(killBlob, bitmap) {

    if (this.map.killed){
        return;
    }

    if (killBlob) {
        window.URL.revokeObjectURL(this.image.src);
    }

    if (bitmap) {
        this.image = bitmap;
        this.image.naturalWidth = bitmap.width;
        this.image.naturalHeight = bitmap.height;
    }

    var size = this.image.naturalWidth * this.image.naturalHeight * (this.heightMap ? 3 : 3);
    this.gpuSize = this.image.naturalWidth * this.image.naturalHeight * 4;  //aproximate size 

    //if (!this.image.complete) {
       // size = size;
    //}
    
    //console.log(size);

    this.cacheItem = this.map.resourcesCache.insert(this.killImage.bind(this, true), size);

    this.map.markDirty();
    this.loadState = 2;
    this.loadErrorTime = null;
    this.loadErrorCounter = 0;
    this.mapLoaderCallLoaded();
};


MapSubtexture.prototype.scheduleHeadRequest = function(priority, downloadAll) {
    if (this.map.config.mapXhrImageLoad && this.fastHeaderCheck) {
        this.scheduleLoad(priority, true);
    } else {
        this.map.loader.load(this.mapLoaderUrl, this.onLoadHead.bind(this, downloadAll), priority, this.tile, this.internal, this.internal ? 'texture-in' : 'texture-ex');
    }
};


MapSubtexture.prototype.onLoadHead = function(downloadAll, url, onLoaded, onError) {
    this.mapLoaderCallLoaded = onLoaded;
    this.mapLoaderCallError = onError;

    var onerror = this.onLoadHeadError.bind(this, downloadAll);
    var onload = this.onHeadLoaded.bind(this, downloadAll);

    this.checkStatus = 1;

    if (downloadAll) {
        //utils.loadBinary(url, onload, onerror, (utils.useCredentials ? (this.mapLoaderUrl.indexOf(this.map.url.baseUrl) != -1) : false), this.map.core.xhrParams, 'blob');
        this.map.loader.processLoadBinary(url, onLoad, onerror, null, 'texture');
    } else {
        utils.headRequest(url, onload, onerror, (utils.useCredentials ? (this.mapLoaderUrl.indexOf(this.map.url.baseUrl) != -1) : false), this.map.core.xhrParams, 'blob');
    }
};


MapSubtexture.prototype.onLoadHeadError = function() {
    if (this.map.killed){
        return;
    }

    this.checkStatus = 3;
    this.loadErrorTime = performance.now();
    this.loadErrorCounter ++;
    
    //make sure we try to load it again
    if (this.loadErrorCounter <= this.map.config.mapLoadErrorMaxRetryCount) { 
        setTimeout((function(){ if (!this.map.killed) { this.map.markDirty(); } }).bind(this), this.map.config.mapLoadErrorRetryTime);
    }    
    
    this.mapLoaderCallError();
};


MapSubtexture.prototype.onHeadLoaded = function(downloadAll, data, status) {
    if (this.map.killed){
        return;
    }

    this.checkStatus = 2;
    this.loadErrorTime = null;
    this.loadErrorCounter = 0;

    if (this.map.config.mapXhrImageLoad && this.fastHeaderCheck) {

        switch (this.checkType) {
        case vts.TEXTURECHECK_SIZE:
            if (data) {
                if (data.size == this.checkValue) {
                    this.checkStatus = -1;
                }
            }
            break;
                
        case vts.TEXTURECHECK_TYPE:
            if (data) {
                if (data.type == this.checkValue) {
                    this.checkStatus = -1;
                }
            }
            break;
                
        case vts.TEXTURECHECK_CODE:
            if (status) {
                if (this.checkValue.indexOf(status) != -1) {
                    this.checkStatus = -1;
                }
            }
            break;
        }

    } else {

        switch (this.checkType) {
        case vts.TEXTURECHECK_SIZE:
            if (data) {
                if (data.byteLength == this.checkValue) {
                    this.checkStatus = -1;
                }
            }
            break;
                
        case vts.TEXTURECHECK_TYPE:
            if (data) {
                //if (!data.indexOf) {
                  //  data = data;
                //}
                    
                if (data.indexOf(this.checkValue) != -1) {
                    this.checkStatus = -1;
                }
            }
            break;
                
        case vts.TEXTURECHECK_CODE:
            if (status) {
                if (this.checkValue.indexOf(status) != -1) {
                    this.checkStatus = -1;
                }
            }
            break;
        }
        
        this.mapLoaderCallLoaded();
    }
};


MapSubtexture.prototype.buildGpuTexture = function () {
    /*if (this.map.config.mapCheckTextureSize && (this.image.naturalWidth > 1024 || this.image.naturalHeight > 1024)) {
        console.log('very large texture: ' + this.image.naturalWidth + 'x' + this.image.naturalHeight + ' ' + this.mapLoaderUrl);

        var size = 16;
        var data = new Uint8Array( size * size * 4 );

        for (var i = 0; i < size; i++) {
            for (var j = 0; j < size; j++) {
                var index = (i*size+j)*4;
                data[index] = 0;
                data[index + 1] = 0;
                data[index + 2] = 0;
                data[index + 3] = 255;
            }
        }

        this.gpuTexture = new GpuTexture(this.map.renderer.gpu);
        this.gpuTexture.createFromData(size, size, data);
        this.gpuTexture.width = this.image.naturalWidth;
        this.gpuTexture.height = this.image.naturalHeight;
        //this.gpuTexture = this.map.renderer.blackTexture; 
        this.gpuSize = 0; //this.image.naturalWidth * this.image.naturalHeight * 4;
        return;
    }*/

    this.gpuTexture = new GpuTexture(this.map.renderer.gpu, null, this.map.core);

    switch (this.type) {

        case vts.TEXTURETYPE_NORMALMAP:
        case vts.TEXTURETYPE_CLASS:
            this.gpuTexture.createFromImage(
                this.image, this.type, 'nearest', false);
            break;

        case vts.TEXTURETYPE_ATMDENSITY:

            //console.log('creating atmdensity gpu texture');

            this.gpuTexture.createFromData(
                this.decoded.width, this.decoded.height,
                this.decoded.data, this.type, 'nearest', false);
            break;

        default:
            this.gpuTexture.createFromImage(
                this.image, this.type, 'linear', false);
    }

    // The gpu texture is now the resident copy of an image-backed
    // texture: release the decoded image and its cache entry at once.
    // An ImageBitmap holds gpu-backed pixel storage on WebKit, so a
    // retained image doubles the texture's gpu footprint there. After
    // gpu-cache eviction the texture is downloaded again on demand.
    // (The atmosphere density path keeps its cpu-decoded data and has
    // no image here.)
    if (this.image) {

        if (typeof this.image.close === 'function') this.image.close();
        this.image = null;

        if (this.cacheItem) {
            this.map.resourcesCache.remove(this.cacheItem);
            this.cacheItem = null;
        }
    }

    this.gpuSize = this.gpuTexture.getSize();

    this.stats.gpuTextures += this.gpuSize;

    this.stats.graphsFluxTexture[0][0]++;
    this.stats.graphsFluxTexture[0][1] += this.gpuSize;

    this.gpuCacheItem = this.map.gpuCache.insert(this.killGpuTexture.bind(this, true), this.gpuSize);
};


MapSubtexture.prototype.buildHeightMap = function () {
    var canvas = document.createElement('canvas');
    canvas.width = this.image.naturalWidth;
    canvas.height = this.image.naturalHeight;
    var ctx = canvas.getContext('2d');
    ctx.drawImage(this.image, 0, 0);
    this.imageData = ctx.getImageData(0, 0, this.image.naturalWidth, this.image.naturalHeight).data;
    this.imageExtents = [this.image.naturalWidth, this.image.naturalHeight];

    // close() releases ImageBitmap pixel storage at once instead of
    // leaving it to garbage collection (on WebKit it is gpu memory)
    if (typeof this.image.close === 'function') this.image.close();
    this.image = null;

    // release the canvas backing store at once; browsers keep it
    // allocated until garbage collection otherwise
    canvas.width = 0;
    canvas.height = 0;
};


MapSubtexture.prototype.getGpuTexture = function() {
    return this.gpuTexture;
};


MapSubtexture.prototype.getHeightMapValue = function(x, y) {
    if (this.imageData) {
        return this.imageData[(y * this.imageExtents[0] + x)*4];
    }
    
    return 0;
};

export default MapSubtexture;

