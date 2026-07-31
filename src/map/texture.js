
import MapSubtexture from './subtexture';
import GpuTexture from '../renderer/gpu/texture';

var MapTexture = function(
    map, path, type, ancestorFallback, textureContext, tile, internal
) {

    this.map = map;
    this.stats = map.stats;
    this.tile = tile; // used only for stats
    this.internal = internal; // used only for stats

    if (tile) {
        this.mainTexture = tile.resources.getSubtexture(this, path, type, null, null, tile, internal);
    } else {
        this.mainTexture = new MapSubtexture(map, path, type, tile, internal); 
    }

    this.maskTexture = null; 

    this.loadState = 0; //  0=not loaded, 1=loading, 2=loaded, 3=error),
    this.loadErrorTime = null;
    this.loadErrorCounter = 0;
    this.neverReady = false;
    this.maskTexture = null;
    this.mapLoaderUrl = path;
    this.type = type ?? GpuTexture.Type.Color;
    this.ancestorFallback = ancestorFallback;
    this.textureContext = textureContext;
    this.statsCounter = 0;
    this.coverageStatus = 'unchecked';
    this.hasCoverage = !!textureContext?.source?.coverage;
    this.ancestorMaskPending = false;
    this.fileSize = 0;
    this.bumpsApplied = [];
    this.missingParentWarned = false;
};


MapTexture.prototype.kill = function() {
    this.mainTexture.killImage();
    this.mainTexture.killGpuTexture();
    this.mainTexture = null;
    
    if (this.maskTexture) {
        this.maskTexture.killImage(); 
        this.maskTexture.killGpuTexture(); 
    }
};


MapTexture.prototype.killImage = function() {
    this.mainTexture.killImage();

    if (this.maskTexture) {
        this.maskTexture.killImage(); 
    }
};

MapTexture.prototype.noteBump = function(layerId) {
    this.bumpsApplied.push(layerId);
}

/**
 * Log a tile whose parent link is missing, once per texture.
 * The raster fallback walk cannot continue past such a
 * tile; callers report the texture as not ready.
 */
MapTexture.prototype.warnMissingParent = function(tile) {
    if (this.missingParentWarned) {
        return;
    }

    this.missingParentWarned = true;

    console.log('WARN: no parent link for tile '
        + tile.id.join('-') + ' while checking raster texture '
        + this.mapLoaderUrl);
};

MapTexture.prototype.killGpuTexture = function() {
    this.mainTexture.killGpuTexture();

    if (this.maskTexture) {
        this.maskTexture.killGpuTexture(); 
    }
};


MapTexture.prototype.setAncestorTexture = function(tile, source) {
    if (tile) {
        if (source) {
            this.ancestorFallback.sourceTile = tile;
            this.ancestorFallback.source = source;
            
            if (!tile.rasterTextures[source.id]) {
                tile.rasterSources[source.id] = source;
                var path = source.getUrl(tile.id);
                tile.rasterTextures[source.id] = tile.resources.getTexture(
                    path, null, null, {tile: tile, source: source},
                    this.tile, this.internal);
            }

            this.ancestorFallback.texture = tile.rasterTextures[source.id];
        }
        
        this.ancestorFallback.transform =
            this.map.draw.drawTiles.getTileTextureTransform(
                tile, this.ancestorFallback.tile);
        this.map.markDirty();
    }
};


MapTexture.prototype.isReady = function(doNotLoad, priority, doNotCheckGpu) {
    var doNotUseGpu = (this.map.stats.gpuRenderUsed >= this.map.draw.maxGpuUsed);
    doNotLoad = doNotLoad || doNotUseGpu;

    if (this.neverReady) {
        return false;
    }

    var parent;
   
    if (this.ancestorFallback) {
        if (this.ancestorFallback.texture) {

            // Start at the highest tile inside the source LOD range.
            while (this.ancestorFallback.texture.ancestorFallback
                || this.ancestorFallback.texture.coverageStatus
                    === 'missing') {

                parent = this.ancestorFallback.sourceTile.parent;

                if (this.ancestorFallback.source) {

                    // a tile with a null parent link is the tree root
                    // or no longer belongs to the tile tree; there is
                    // no hierarchy to walk. Report not ready and keep
                    // the state unchanged so a live tile can re-claim
                    // this texture through the resource cache.
                    if (!parent) {
                        this.warnMissingParent(
                            this.ancestorFallback.sourceTile);
                        return false;
                    }

                    if (parent.id[0]
                        < this.ancestorFallback.source.lodRange[0]) {

                        this.neverReady = true;
                        this.ancestorFallback.tile.resetDrawCommands = true;
                        this.map.markDirty();
                        return false;
                    }
                }
 
                this.setAncestorTexture(parent, this.ancestorFallback.source);
            }
            
            var ready = this.ancestorFallback.texture.isReady(
                doNotLoad, priority, doNotCheckGpu);
            
            if (ready && this.ancestorMaskPending) {
                this.ancestorFallback.tile.resetDrawCommands =
                    (this.ancestorFallback.texture.getMaskTexture() != null);
                this.ancestorMaskPending = false;
            }

            return ready;
            
        } // if (this.ancestorFallback.texture)

        else {

            // if (! this.ancestorFallback.texture)

            this.setAncestorTexture(
                this.ancestorFallback.sourceTile,
                this.ancestorFallback.source);
            return this.isReady(doNotLoad, priority, doNotCheckGpu);
        }
    } // if (this.ancestorFallback)

    if (this.hasCoverage) {

        if (this.coverageStatus === 'unchecked') {

            const tile = this.textureContext.tile;
            let metaResources = tile.rasterMetaResources;

            if (!metaResources) {
                metaResources =
                    this.map.resourcesTree.findAgregatedNode(
                        tile.id, 8, true);
                tile.rasterMetaResources = metaResources;
            }

            const source = this.textureContext.source;

            if (!this.textureContext.metaPath) {
                this.textureContext.metaPath =
                    source.getMetatileUrl(metaResources.id);
            }

            // Height decoding exposes the metatile's RGBA bytes to the CPU.
            const metatileTexture = metaResources.getTexture(
                this.textureContext.metaPath, GpuTexture.Type.Height,
                null, null, this.tile, this.internal);

            if (!metatileTexture.isReady(
                doNotLoad, priority, doNotCheckGpu)) {

                return false;
            }

            const value = metatileTexture.getHeightMapValue(
                tile.id[1] & 255, tile.id[2] & 255);

            if (!(value & 128)) {
                this.coverageStatus = 'missing';
            } else if (!(value & 64)) {

                const path = source.getMaskUrl(tile.id);
                this.maskTexture = tile.resources.getTexture(
                    path, GpuTexture.Type.Mask,
                    null, null, this.tile, this.internal);
                this.coverageStatus = 'mask-loading';

            } else {
                this.coverageStatus = 'present';
            }

            tile.resetDrawCommands = true;
            this.map.markDirty();
        }

        if (this.coverageStatus === 'mask-loading') {

            if (!this.maskTexture.isReady(
                doNotLoad, priority, doNotCheckGpu, this)) {

                return false;
            }

            this.coverageStatus = 'present';
        }

        if (this.coverageStatus === 'missing') {

            if (!this.ancestorFallback) {

                parent = this.textureContext.tile.parent;

                if (!parent) {
                    this.warnMissingParent(this.textureContext.tile);
                    return false;
                }

                if (parent.id[0] < this.textureContext.source.lodRange[0]) {
                    this.neverReady = true;
                    this.textureContext.tile.resetDrawCommands = true;
                    this.map.markDirty();
                    return false;
                }

                this.ancestorFallback = {
                    tile: this.textureContext.tile,
                    source: this.textureContext.source,
                };
                this.setAncestorTexture(
                    parent, this.ancestorFallback.source);
                this.ancestorMaskPending = true;
            }

            while (this.ancestorFallback.texture.ancestorFallback
                || this.ancestorFallback.texture.coverageStatus
                    === 'missing') {

                parent = this.ancestorFallback.sourceTile.parent;

                if (!parent) {
                    this.warnMissingParent(
                        this.ancestorFallback.sourceTile);
                    return false;
                }

                if (parent.id[0]
                    < this.ancestorFallback.source.lodRange[0]) {

                    this.neverReady = true;
                    this.ancestorFallback.tile.resetDrawCommands = true;
                    this.map.markDirty();
                    return false;
                }

                this.setAncestorTexture(
                    parent, this.ancestorFallback.source);
            }

            return false;
        }
    }

    var maskState = true;

    if (this.maskTexture) {
        maskState = this.maskTexture.isReady(doNotLoad, priority, doNotCheckGpu, this);
    }
    

    return this.mainTexture.isReady(doNotLoad, priority, doNotCheckGpu, this) && maskState;
};

MapTexture.prototype.isMaskPossible = function() {
    var texture = this;

    if (this.ancestorFallback) {
        if (this.ancestorFallback.texture) {
            texture = this.ancestorFallback.texture;
        }
    }

    return texture.hasCoverage;
};

MapTexture.prototype.isMaskInfoReady = function() {
    var texture = this;

    if (this.ancestorFallback) {
        if (this.ancestorFallback.texture) {
            texture = this.ancestorFallback.texture;
        }
    }

    if (texture.hasCoverage) {
        if (this.maskTexture || texture.coverageStatus === 'present'
            || this.neverReady) {

            return true;
        }

        return false;
    }

    return true;
}

MapTexture.prototype.getGpuTexture = function() {
    if (this.ancestorFallback) {
        if (this.ancestorFallback.texture) {
            return this.ancestorFallback.texture.getGpuTexture();
        }
        return null;
    } 

    return this.mainTexture.getGpuTexture();
};


MapTexture.prototype.getMaskTexture = function() {
    if (this.ancestorFallback) {
        if (this.ancestorFallback.texture) {
            return this.ancestorFallback.texture.getMaskTexture();
        }
    } 

    return this.maskTexture;
};


MapTexture.prototype.getGpuMaskTexture = function() {
    if (this.ancestorFallback) {
        if (this.ancestorFallback.texture
            && this.ancestorFallback.texture.maskTexture) {

            return this.ancestorFallback.texture.getGpuMaskTexture();
        }
        return null;
    } 

    if (this.maskTexture) {
        return this.maskTexture.getGpuTexture();
    }
    
    return null;
};

MapTexture.prototype.getGpuSize = function() {
    return (this.mainTexture ? (this.mainTexture.gpuSize ? this.mainTexture.gpuSize : 0) : 0) + (this.maskTexture ? (this.maskTexture.gpuSize ? this.maskTexture.gpuSize : 0) : 0);
};

MapTexture.prototype.getImageData = function() {
    return this.mainTexture.imageData;
};


MapTexture.prototype.getImageExtents = function() {
    return this.mainTexture.imageExtents;
};


MapTexture.prototype.getHeightMapValue = function(x, y) {
    return this.mainTexture.getHeightMapValue(x, y);
};


MapTexture.prototype.getTransform = function() {
    if (this.ancestorFallback) {
        if (this.ancestorFallback.texture) {
            return this.ancestorFallback.transform;
        }
        return null;
    } 

    return [1,1,0,0];
};


export default MapTexture;
