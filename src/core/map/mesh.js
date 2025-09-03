
import {mat4 as mat4_, vec3} from '../utils/matrix';
import MapSubmesh_ from './submesh';
import BBox_ from '../renderer/bbox';
import GpuProgram_ from '../renderer/gpu/program';
import GpuShaders_ from '../renderer/gpu/shaders';


//get rid of compiler mess
var mat4 = mat4_;
var BBox = BBox_;
var MapSubmesh = MapSubmesh_;
var GpuProgram = GpuProgram_;
var GpuShaders = GpuShaders_;

var MapMesh = function(map, url, tile) {
    this.generateLines = true;
    this.map = map;
    this.stats = map.stats;
    this.mapLoaderUrl  = url;
    this.tile = tile; // used only for stats
    this.use16bit = map.config.map16bitMeshes;

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

    //if (doNotUseGpu) {
      //  doNotUseGpu = doNotUseGpu;
    //}

    //if (this.mapLoaderUrl == "https://cdn.vts.com/mario/proxy/melown2015/surface/vts/cz10/12-1107-688.bin?0") {
      //  this.mapLoaderUrl = this.mapLoaderUrl;
    //}

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

    this.map.loader.processLoadBinary(url, this.onLoaded.bind(this), this.onLoadError.bind(this), null, 'mesh');
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


MapMesh.prototype.generateTileShader = function (progs, v, useSuperElevation, splitMask) {
    var str = '';
    if (splitMask) {
        if (!this.map.config.mapSplitMargin) {
            if (splitMask.length == 4){ str += '#define clip4_nomargin\n' } else { str += '#define clip8\n' };
        } else {
            if (splitMask.length == 4){ str += '#define clip4\n' } else { str += '#define clip8\n' };
            str += '#define TMIN ' + (0.5-this.map.config.mapSplitMargin) + '\n' + '#define TMAX ' + (0.5+this.map.config.mapSplitMargin) + '\n';
        }
    }

    if (useSuperElevation) str += '#define applySE\n';

    if (v & VTS_TILE_SHADER_BLEND_MULTIPLY) {
        str += '#define blendMultiply\n';
    }

    if (v & VTS_TILE_SHADER_ILLUMINATION) {
        str += '#define shader_illumination\n';
    }

    if (v & VTS_TILE_SHADER_WHITEWASH) {
        str += '#define whitewash\n';
    }

    //if (progs === this.map.renderer.progDepthTile) {
    //    console.log(progs[0].vertex.replace('#define variants\n', str));
    //}

    var prog = (new GpuProgram(this.map.renderer.gpu, progs[0].vertex.replace('#define variants\n', str), progs[0].fragment.replace('#define variants\n', str)));
    progs[v] = prog;
    return prog;
};


MapMesh.prototype.drawSubmesh = function (cameraPos, index, texture, type, blending, alpha, runtime, layer, surface, splitMask, splitSpace, normalMap) {
    // index is the submesh index
    // type is the material (internal, external, both with fog and nofog variants, flat, depth, etc.

    if (this.gpuSubmeshes[index] == null && this.submeshes[index] != null && !this.submeshes[index].killed) {
        this.gpuSubmeshes[index] = this.submeshes[index].buildGpuMesh();
    }

    var submesh = this.submeshes[index];
    var gpuSubmesh = this.gpuSubmeshes[index];

    if (!gpuSubmesh) {
        return;
    }
    
    var renderer = this.map.renderer;
    var draw = this.map.draw;
    var program = null;
    var gpuMask = null;

    let texcoordsAttr = null;
    let texcoords2Attr = null;
    var drawWireframe = draw.debug.drawWireframe;

    var useSuperElevation = renderer.useSuperElevation;
    var attributes = ['aPosition'];
    var v = (useSuperElevation) ? VTS_TILE_SHADER_SE : 0;
    let whitewash = null;

    if (splitMask) {
        v |= VTS_TILE_SHADER_CLIP4;

        if (type != VTS_MATERIAL_EXTERNAL && type != VTS_MATERIAL_INTERNAL_NOFOG) {
            texcoords2Attr = 'aTexCoord2';
            attributes.push('aTexCoord2');
        }
    }

    if (blending == 'multiply') {
        v |= VTS_TILE_SHADER_BLEND_MULTIPLY;
    }

    if (normalMap && renderer.shaderIllumination) {
       v |= VTS_TILE_SHADER_ILLUMINATION;

       texcoords2Attr = 'aTexCoord2';
       attributes.push('aTexCoord2');
    }

    if (layer && layer.shaderFilters && layer.shaderFilters[surface.id] &&
        layer.shaderFilters[surface.id].whitewash) {

        v |= VTS_TILE_SHADER_WHITEWASH;
        whitewash = layer.shaderFilters[surface.id].whitewash;
    }

    if (texture && draw.debug.meshStats) {
        if (!submesh.uvAreaComputed) {
            submesh.computeUVArea(texture.getGpuTexture());
        }

        this.stats.meshesUVArea += submesh.uvArea;
        this.stats.meshesFaces += submesh.faces;
    }

    if (type == VTS_MATERIAL_DEPTH) {
        program = renderer.progDepthTile[v];

        if (!program) {
            program = this.generateTileShader(renderer.progDepthTile, v, useSuperElevation, splitMask);
        }

    } else if (type == VTS_MATERIAL_FLAT) {
        program = renderer.progFlatShadeTile[v];

        if (!program) {
            program = this.generateTileShader(renderer.progFlatShadeTile, v, useSuperElevation, splitMask);
        }

    } else {
        if (drawWireframe > 0 && type == VTS_MATERIAL_FOG) {
            return;
        }

        if (drawWireframe == 1 || drawWireframe == 3) {
            program = renderer.progFlatShadeTile[v];

            if (!program) {
                program = this.generateTileShader(renderer.progFlatShadeTile, v, useSuperElevation, splitMask);
            }

        } else {
            switch(type) {
            case VTS_MATERIAL_INTERNAL:
            case VTS_MATERIAL_INTERNAL_NOFOG:

                texcoordsAttr = 'aTexCoord';
                attributes.push('aTexCoord');

                program = renderer.progTile[v];

                if (!program) {
                    program = this.generateTileShader(renderer.progTile, v, useSuperElevation, splitMask);
                }

                break;

            case VTS_MATERIAL_EXTERNAL:
            case VTS_MATERIAL_EXTERNAL_NOFOG:

                var prog = renderer.progTile2;

                if (texture) {
                    gpuMask = texture.getGpuMaskTexture();
                    if (gpuMask) {
                        prog = renderer.progTile3;
                    }
                }

                program = prog[v];

                if (!program) {
                    program = this.generateTileShader(prog, v, useSuperElevation, splitMask);
                }


                if (layer && (layer.shaderFilters || layer.shaderFilter)) {
                    var filter, id, flatShade;

                    if (surface && layer.shaderFilters) {
                        filter = layer.shaderFilters[surface.id];

                        if (filter) {
                            if (filter.varFlatShade) {
                                flatShade = true;
                            }

                            filter = filter.filter;
                        }
                    }

                    if (!filter) {
                        filter = layer.shaderFilter;
                    }

                    if (filter) {

                        // yuck
                        var id = (gpuMask) ? 'progTile3' : 'progTile2';
                        var renderer = this.map.renderer;

                        if (useSuperElevation) {
                            id += 'se';
                        }

                        if (flatShade) {
                            id += 'fs';
                        }

                        if (splitMask) {
                            id += 'c4';
                        }

                        if (normalMap && renderer.shaderIllumination) {
                            id += 'nm';
                        }

                        if (whitewash) {
                            id += 'vw';
                        }

                        // yuck
                        id += filter;

                        program = renderer.progMap[id];

                        if (!program) {
                            var gpu = renderer.gpu, pixelShader, variations = '';

                            if (splitMask) {
                                if (!this.map.config.mapSplitMargin) {
                                    variations += '#define clip4_nomargin\n';
                                } else {
                                    variations += '#define clip4\n';
                                    variations += '#define TMIN ' + (0.5-this.map.config.mapSplitMargin) + '\n' + '#define TMAX ' + (0.5+this.map.config.mapSplitMargin) + '\n';
                                }
                            }

                            if (blending == 'multiply') {
                                variations += '#define blendMultiply\n';
                            }
                            
                            if (normalMap && renderer.shaderIllumination) {
                                variations += '#define shader_illumination\n';
                            }

                            var vertexShader = '#define externalTex\n' + variations + ((useSuperElevation) ? '#define applySE\n' : '') + GpuShaders.tileVertexShader;

                            if (gpuMask) {
                                pixelShader = '#define externalTex\n#define mask\n' + variations + GpuShaders.tileFragmentShader;
                            } else {
                                pixelShader = '#define externalTex\n' + variations + GpuShaders.tileFragmentShader;
                            }

                            if (flatShade) {
                                pixelShader =  '#extension GL_OES_standard_derivatives : enable\n#define flatShadeVar\n' + pixelShader;
                                vertexShader = '#define flatShadeVar\n' + vertexShader;

                                //if (this.map.mobile) {
                                    //pixelShader = '#define flatShadeVarFallback\n' + pixelShader;
                                    pixelShader = pixelShader.replace('mediump', 'highp');
                                //}
                            }

                            if (whitewash) {
                                pixelShader = "#define whitewash\n" + pixelShader;
                            }

                            program = new GpuProgram(gpu, vertexShader, pixelShader.replace('__FILTER__', filter));
                            renderer.progMap[id] = program;
                        }
                    }
                }

                texcoords2Attr = 'aTexCoord2';
                attributes.push('aTexCoord2');
                break;

            case VTS_MATERIAL_FOG:
                program = renderer.progFogTile[v];

                if (!program) {
                    program = this.generateTileShader(renderer.progFogTile, v, useSuperElevation, splitMask);
                }

                break;
            }
        }
    }

    if (!program || !program.isReady()) {
        return;
    }

    // use program (and set sampler0 and sampler1 statically, enable vertex attributes)
    //renderer.gpu.useProgram(program, attributes, gpuMask);
    renderer.gpu.useProgram2(program);

    // bind textures
    if (texture) {
        var gpuTexture = texture.getGpuTexture();

        if (gpuTexture) {
            if (texture.statsCoutner != this.stats.counter) {
                texture.statsCoutner = this.stats.counter;
                this.stats.gpuRenderUsed += gpuTexture.getSize();
            }

            renderer.gpu.bindTexture(gpuTexture);
            program.setSampler('uSampler', 0);

            if (gpuMask) {
                renderer.gpu.bindTexture(gpuMask, 1);
                program.setSampler('uSampler2', 1);
            }

        } else {
            return;
        }
    } else if (type != VTS_MATERIAL_FOG && type != VTS_MATERIAL_DEPTH && type != VTS_MATERIAL_FLAT) {
        return;
    }


    // set uniforms
    var mv = this.mBuffer, m = this.mBuffer2, v = this.vBuffer;

    if (useSuperElevation) {

        var m = this.mBuffer;
        var se = renderer.getSuperElevation(this.map.position);

        m[0] = submesh.bbox.min[0];
        m[1] = submesh.bbox.min[1];
        m[2] = submesh.bbox.min[2];

        m[3] = submesh.bbox.side(0);
        m[4] = submesh.bbox.side(1);
        m[5] = submesh.bbox.side(2);

        //m[6] = 0;
        //m[7] = 0;
        //m[8] = 0;

        m[9] = se[0]; // h1
        m[10] = se[1]; // f1
        m[11] = se[2]; // h2
        m[12] = se[6]; // inv dh
        m[13] = se[5]; // df

        m[14] = renderer.earthRadius;
        m[15] = renderer.earthERatio;

        program.setMat4('uParamsSE', m);

        //mv = renderer.camera.getModelviewFMatrix();

        mat4.multiply(renderer.camera.getModelviewFMatrix(),
                      submesh.getWorldMatrixSE(cameraPos, m), mv);

    } else {
        mat4.multiply(renderer.camera.getModelviewFMatrix(), submesh.getWorldMatrix(cameraPos, m), mv);
    }


    var proj = renderer.camera.getProjectionFMatrix();

    program.setMat4('uMV', mv);

    if (draw.zbufferOffset) {
        program.setMat4('uProj', proj, renderer.getZoffsetFactor(draw.zbufferOffset));
    } else {
        program.setMat4('uProj', proj);
    }

    // illumination uniforms and normal map texture
    if (normalMap) {

        // bind normal map texture
        let gpuTexture = normalMap.getGpuTexture();

        if (gpuTexture) {
            if (normalMap.statsCoutner != this.stats.counter) {
                normalMap.statsCoutner = this.stats.counter;
                this.stats.gpuRenderUsed += gpuTexture.getSize();
            }
        }

        renderer.gpu.bindTexture(gpuTexture, 2);
        program.setSampler("normalMap", 2);

        // viewPos and lightDir (prerequisite: superelevation
        let ilumvec = vec3.create();
        let lightDir = vec3.create();
        let viewPos = vec3.create();

        let ilumvecVC = renderer.getIlluminationVectorVC().slice();

        if (useSuperElevation) {

            // TODO: this should be done in LNED, not VC
            //ilumvecVC[2] /= renderer.getSeProgressionFactor(this.map.position);
            //vec3.normalize(ilumvecVC);
        }

        //console.log("ilumvecVC", ilumvecVC);

        mat4.multiplyVec3_(
            renderer.camera.getModelviewMatrixInverse(),
            ilumvecVC, ilumvec);

        vec3.negate(ilumvec, lightDir);

        mat4.multiplyVec3_(
            renderer.camera.getModelviewMatrixInverse(),
            [0.0, 0.0, 0.0],
            viewPos);

        //console.log("lightDir: ", lightDir);
        //console.log("viewPos: ", viewPos);

        program.setVec3('viewPos', viewPos);
        program.setVec3('lightDir', lightDir);
        program.setFloat('ambientCoef', renderer.getIlluminationAmbientCoef());
    }

    // whitewashing
    if (whitewash) {

        //console.log('Setting whitewash uniform to ' + +whitewash);
        program.setFloat('uWhitewash', +whitewash);
    }

    if (splitMask) {
        program.setFloatArray('uClip', splitMask);

        var p = this.map.camera.position;
        var s = splitSpace;

        if (splitSpace) {
            m[0] = s[0][0] - p[0]; m[1] = s[0][1] - p[1]; m[2] = s[0][2] - p[2];
            m[4] = s[1][0] - s[0][0]; m[5] = s[1][1] - s[0][1]; m[6] = s[1][2] - s[0][2];
            m[8] = s[2][0] - s[1][0]; m[9] = s[2][1] - s[1][1]; m[10] = s[2][2] - s[1][2];
            //m[12] = s[0][0] - s[4][0]; m[13] = s[0][1] - s[4][1]; m[14] = s[0][2] - s[4][2];
            m[12] = s[4][0] - s[0][0]; m[13] = s[4][1] - s[0][1]; m[14] = s[4][2] - s[0][2];

            var bmin = submesh.bbox.min, bmax = submesh.bbox.max;

            m[3] = bmin[0] - p[0];
            m[7] = bmin[1] - p[1];
            m[11] = bmin[2] - p[2];

            program.setMat4('uParamsC8', m);
        }
    }

    if (drawWireframe == 0) {
        var cv = this.map.camera.vector2, c = draw.atmoColor, t, bmin = submesh.bbox.min, bmax = submesh.bbox.max;

        switch(type) {
        case VTS_MATERIAL_INTERNAL:
        case VTS_MATERIAL_FOG:
        case VTS_MATERIAL_INTERNAL_NOFOG:

            m[0] = draw.zFactor, m[1] = (type == VTS_MATERIAL_INTERNAL_NOFOG) ? 0 : draw.fogDensity;
            m[2] = bmax[0] - bmin[0], m[3] = bmax[1] - bmin[1],
            m[4] = cv[0], m[5] = cv[1], m[6] = cv[2], m[7] = cv[3],
            m[12] = bmax[2] - bmin[2], m[13] = bmin[0], m[14] = bmin[1], m[15] = bmin[2];

            program.setMat4('uParams', m);

            v[0] = c[0], v[1] = c[1], v[2] = c[2];
            program.setVec4('uParams2', v);

            break;

        case VTS_MATERIAL_EXTERNAL:
        case VTS_MATERIAL_EXTERNAL_NOFOG:

            t = texture.getTransform();

            m[0] = draw.zFactor, m[1] = (type == VTS_MATERIAL_EXTERNAL) ? draw.fogDensity : 0;
            m[2] = bmax[0] - bmin[0], m[3] = bmax[1] - bmin[1],
            m[4] = cv[0], m[5] = cv[1], m[6] = cv[2], m[7] = cv[3],
            m[8] = t[0], m[9] = t[1], m[10] = t[2], m[11] = t[3],
            m[12] = bmax[2] - bmin[2], m[13] = bmin[0], m[14] = bmin[1], m[15] = bmin[2];

            program.setMat4('uParams', m);


            // establish texture alpha
            let alpha_ = 1.0;

            if (alpha) {
                // alpha object present in command
                alpha_ = alpha.value;

                if (alpha.mode == 'viewdep' ) {

                    // view-dependent normalized alpha is precomputed
                    alpha_ = runtime.vdalphan * alpha.value;
                    //console.log(alpha_);
                }
            }

            v[0] = c[0], v[1] = c[1], v[2] = c[2]; v[3] = (type == VTS_MATERIAL_EXTERNAL) ? 1 : alpha_;
            program.setVec4('uParams2', v);

            break;
        }
    }

    if (submesh.statsCoutner != this.stats.counter) {
        submesh.statsCoutner = this.stats.counter;
        this.stats.gpuRenderUsed += gpuSubmesh.getSize();
    }

    // GpuMesh.draw, actual draw call is there
    //gpuSubmesh.draw(program, 'aPosition', texcoordsAttr, texcoords2Attr, null, (drawWireframe == 2));
    if (drawWireframe != 2) {

        gpuSubmesh.draw2(program, {
            position: 'aPosition', uvs: 'aTexCoord', uvs2: 'aTexCoord2'});
    }

    if (drawWireframe == 1 || drawWireframe == 2) { //very slow debug only

        program = renderer.progWireFrameBasic[v];

        if (!program) {
            program = this.generateTileShader(renderer.progWireFrameBasic, v, useSuperElevation, splitMask);
        }

        renderer.gpu.useProgram(program, attributes, gpuMask);

        if (useSuperElevation) {
            program.setMat4('uParamsSE', m);
        }

        program.setMat4('uMV', mv);
        program.setVec4('uColor', [0,0,0,1]);

        program.setMat4('uProj', proj, renderer.getZoffsetFactor([-0.001,0,0]));

        if (splitMask) {
            program.setFloatArray('uClip', splitMask);
        }

        var gl = gpuSubmesh.gl;

        if (gpuSubmesh.indexBuffer) {

            for (var i = 0, li = gpuSubmesh.indexBufferLayout.numItems*2; i < li; i+=3) {

                gl.drawElements(gl.LINE_LOOP, 3, gl.UNSIGNED_SHORT, i);
            }
        }  else {


            for (var i = 0, li = gpuSubmesh.vertexBufferLayout.numItems*2; i < li; i+=3) {

                gl.drawArrays(gl.LINE_LOOP, i, 3);
            }
        }
    }

    this.stats.drawnFaces += this.faces;
    this.stats.drawCalls ++;
};


export default MapMesh;
