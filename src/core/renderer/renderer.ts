
import {vec3, mat4} from '../utils/matrix';
import * as math from '../utils/math';
import * as utils from '../utils/utils';
import GpuDevice from './gpu/device';
import GpuProgram from './gpu/program';
import GpuTexture from './gpu/texture';
import GpuMesh from './gpu/mesh';
import GpuFont from './gpu/font';
import Camera from './camera';
import RenderInit from './init';
import RenderDraw from './draw';
import RendererRMap from './rmap';

import * as Illumination from '../map/illumination';

import Atmosphere from '../map/atmosphere';
import MapPosition from '../map/position';
import MapSrs from '../map/srs';
import MapBody from '../map/position';
import MapCamera from '../map/camera';

import shaderTileVert from './shaders/tile.vert.glsl';
import shaderTileFrag from './shaders/tile.frag.glsl';

import backgroundTileVert from './shaders/background.vert.glsl';
import backgroundTileFrag from './shaders/background.frag.glsl';


/**
 * As with many classes in vts-browser-js, it is difficult to find any
 * meaningful abstraction behind this class. Despite its name, it's not a
 * renderer. Here is a non-exhaustive list of what id does.
 *
 *  * It's a collection of compiled GPU programs and GPU texture objects.
 *
 *  * It keeps track of scene illumination vector and provides a public API
 *    to provide the vector in camera space.
 *
 *  * It keeps track of vertical exaggeration (superelevation) configuration and
 *    provides methods for applying superelevation.
 *
 *  * It keeps a 'debug' object which is in fact a set of rendering flags.
 *
 *  * It provides an object for creation a  per-frame uniform buffer object
 *    (uboFrame) with view and projection matrices and provides a method for
 *    per-frame updates. Indirectly, it does the same same for the uboAtm object,
 *    which passes parameters for physical atmosphere to the shader program.
 *
 *  * It holds a 'hitmap', a depth map of the scene. It's an offscreen framebuffer
 *    a map is rendered into in 'draw channel 1' when depth info is requested
 *
 *  * It keeps track of the CSS pixel size of the map
 *
 *  * It maintains an image projection matrix, used as projection matrix in
 *    various shaders and keeps it in sync with the CSS pixel size.
 *
 *  * It probably does many other things and is accessed through numerous
 *     undocumented backdoors.
 */

export class Renderer {

    config: Config;
    core: Core;
    div: HTMLElement;
    onResizeCall: () => void;

    marginFlags = 0; // see rmap.js

    uboFrame: WebGLBuffer;

    // label-free margins on  the map: [top, right, bottom, left]
    labelFreeMargins: [number, number, number, number] = [0, 0, 0, 0];

    // flags
    onlyDepth = false;
    onlyLayers = false;
    onlyHitLayers = false;
    onlyAdvancedHitLayers = false;
    advancedPassNeeded = false;

    drawLabelBoxes = false;
    drawGridCells = false;
    drawAllLabels = false;

    geoRenderCounter = 0;
    geoHitmapCounter = 0;
    frameTime = 0;

    hitmapCounter = 0;
    hitmapData: Optional<Uint8Array> = null;

    debug: { [key: string] : boolean }  = {}

    geometries = {} // no clue, see MapInterface.getGeodataGeometry

    stencilLineState: Optional<GpuDevice.State> = null;

    mapHack: any = null; // assigned in map/draw.js

    geodataSelection = []; // see geodata-click-and-hover-events/demo.j    //reduce garbage collection

    hoverFeatureCounter = 0;
    hoverFeatureList = [];

    touchSurfaceEvent = [];

    dirty = true;

    viewExtent = 1;

    gpu!: GpuDevice;
    camera!: Camera;

    drawTileMatrix = mat4.create();
    drawTileMatrix2 = mat4.create();
    drawTileWorldMatrix = mat4.create();
    pixelTileSizeMatrix = mat4.create();
    drawTileVec = [0,0,0];

    // programs
    programs!: {
        tile: GpuProgram,
        background: GpuProgram
    }

    // texture unit indices
    textureIdxs: {
        atmosphere: GLenum
    }

    // legacy programs
    progTile: Optional<GpuProgram> = null;
    progTile2: Optional<GpuProgram> = null;
    progTile3: Optional<GpuProgram> = null;
    progHeightmap: Optional<GpuProgram> = null;
    progSkydome: Optional<GpuProgram> = null;
    progWireframeTile: Optional<GpuProgram> = null;
    progWireframeTile2: Optional<GpuProgram> = null;
    progText: Optional<GpuProgram> = null;

    // physical window
    winSize!: Size2;
    curSize!: Size2;
    oldSize!: Size2;

    // vertical exaggeration
    useSuperElevation = false;
    seHeightRamp: Optional<SeRamp> = null; // 7 elements
    seProgression: SeProgression;

    // these values, important for vertical exaggeration, are calculated from
    // navigationSrs in MapDraw.drawMap as a side effect of drawing the skydome
    // (which is not guaranteed). TODO: move their initilization here, or drop
    // them altogether and use the map object
    earthRadius: Optional<number> = null; // major axis
    earthRadius2: Optional<number> = null; // minor axis
    earthERatio: Optional<number> = null;

    // illumination
    illumination:  Optional<Renderer.Illumination> = null;

    // textures
    heightmapTexture: Optional<GpuTexture> = null;
    skydomeMesh: Optional<GpuMesh> = null;
    hitmapTexture: Optional<GpuTexture> = null;
    geoHitmapTexture: Optional<GpuTexture> = null;
    geoHitmapTexture2: Optional<GpuTexture> = null;
    redTexture: Optional<GpuTexture> = null;
    whiteTexture: Optional<GpuTexture> = null;
    blackTexture: Optional<GpuTexture> = null;
    textTexture2: Optional<GpuTexture> = null;

    // meshes
    atmoMesh: Optional<GpuMesh> = null;
    bboxMesh: Optional<GpuMesh> = null;

    // GpuPixelLine3
    plines: any = null;
    plineJoints: any = null; // probably not used, but still initialize by init


    /** copied from config.mapDMapSize. hitmap (depth map) linear size in
     *  pixels. */
    hitmapSize: number = 1024;

    /**
     *  copied from config.mapDMapMode. Governs getDepth behaviour.
     *  0, 1 - readFramebufferPixels for each getDepth call
     *  2 - 'fastMode' - same thing, just without switching framebuffer
     *  3 - call copyHitmap once per frame, then sample it per getDepth call (faster)
     */
    hitmapMode: number = 3;

    /** interval between hitmap updates */
    hitmapCopyIntervalMs: number = 200;

    updateHitmap = true;
    updateGeoHitmap = true;
    lastHitmapCopyTime = 0;

    rectVerticesBuffer: Optional<WebGLBuffer> = null;
    rectIndicesBuffer: Optional<WebGLBuffer> = null;

    /** col-major projection matrix, used in various shaders. */
    imageProjectionMatrix: Optional<Float32Array> = null;

    fonts: {[key:string] : any} = {};

    fogDensity = 0;

    // feature caches, hitmaps, etc. for geodata rendering
    gmap = new Array(2048);
    gmap2 = new Array(2048);
    gmap3 = new Array(10000);
    gmap3Size = new Array(10000);
    gmap4 = new Array(10000);

    gmapIndex = 0;

    /**  1-5 scr-count 4-8, 0 - no label hierarchy */
    gmapUseVersion: number  = 0;

    gmapTop = new Array(512);
    gmapHit = new Array(512);
    gmapStore = new Array(512);
    fmaxDist = 0;
    fminDist = 0;

    jobZBuffer = new Array(512);
    jobZBufferSize = new Array(512);

    jobZBuffer2 = new Array(512);
    jobZBuffer2Size = new Array(512);

    jobHBuffer = {};
    jobHBufferSize = 0;
    jobHSortBuffer = new Array(2048);

    radixCountBuffer16 = new Uint16Array(256*4);
    radixCountBuffer32 = new Uint32Array(256*4);

    buffFloat32 = new Float32Array(1);
    buffUint32 = new Uint32Array(this.buffFloat32.buffer);

    bitmaps: { [key: string] : any } = {};  // array of GpuTextures, used from gpugroup and geodata

    cameraPosition = [0,0,0];
    cameraOrientation = [0,0,0];
    cameraTiltFator = 1;
    cameraViewExtent = 1;
    distanceFactor = 1;
    tiltFactor = 1;
    localViewExtentFactor = 1;
    cameraVector = [0,0,0];
    labelVector = [0,0,0];
    drawnGeodataTiles = 0;
    drawnGeodataTilesFactor = 0;
    drawnGeodataTilesUsed = false;

    // tile shader program variants, created in MapMesh.drawSubmesh
    progMap : {[key: string] : GpuProgram } = {};

    gridHmax = 0;
    gridHmin = 0;
    seCounter = 0;

    // temporary objects hoisted as class members to reduce garbage collection
    seTmpVec = [0,0,0];
    seTmpVec2 = [0,0,0];
    seTmpVec3 = [0,0,0];

    // hit test
    lastHitPosition = [0,0,100];

    // encapsulated objects


    init : any = null;
    rmap: any = null; // RenderRM
    draw: any = null;

    // no idea
    killed = false;
    //layerGroupVisible = [];


constructor(core: Core, div: HTMLElement, onResize : () => void, config : Config) {

    this.config = config; // || {};
    this.core = core;
    this.div = div;
    //this.onUpdate = onUpdate;
    this.geometries = {};
    //this.clearStencilPasses = [];
    this.onResizeCall = onResize;
    this.stencilLineState = null;


    var rect = this.div.getBoundingClientRect();

    this.winSize = [rect.width, rect.height]; //QSize
    this.curSize = [rect.width, rect.height]; //QSize
    this.oldSize = [rect.width, rect.height]; //QSize

    this.gpu = new GpuDevice(this, div, this.curSize, this.config.rendererAllowScreenshots, this.config.rendererAntialiasing, this.config.rendererAnisotropic);
    this.camera = new Camera(this, 45, 2, 1200000.0);

    //this.heightmapMesh = null;
    //this.skydomeTexture = null;
    //this.font = null;

    if (config.mapLabelFreeMargins)
        this.labelFreeMargins = config.mapLabelFreeMargins;

    this.hitmapSize = config.mapDMapSize | this.hitmapSize;
    this.hitmapMode = config.mapDMapMode | this.hitmapMode;
    this.hitmapCopyIntervalMs
        = config.mapDMapCopyIntervalMs | this.hitmapCopyIntervalMs;

    __DEV__ && console.log(`hitmapCopyIntervalMs: ${this.hitmapCopyIntervalMs}`);

    for (var i = 0, li = this.jobZBuffer.length; i < li; i++) {
        this.jobZBuffer[i] = [];
        this.jobZBufferSize[i] = 0;
        this.jobZBuffer2[i] = {};
        this.jobZBuffer2Size[i] = 0;
    }

    for (i = 0, li = this.gmap3.length; i < li; i++) {
        this.gmap3[i] = [];
        this.gmap3Size[i] = 0;
    }

    this.radixCountBuffer16 = new Uint16Array(256*4);
    this.radixCountBuffer32 = new Uint32Array(256*4);
    //this.radixOutputBufferUint32 = new Uint32Array(256*256);
    //this.radixOutputBufferFloat32 = new Uint32Array(256*256);

    this.buffFloat32 = new Float32Array(1);
    this.buffUint32 = new Uint32Array(this.buffFloat32.buffer);


    window.addEventListener('resize', (this.onResize).bind(this), false);

    // initialize resources
    this.gpu.init();
    this.init = new RenderInit(this);

    this.initShaders();

    this.rmap = new RendererRMap(this, 50);
    this.draw = new RenderDraw(this);

    this.resizeGL(Math.floor(this.curSize[0]), Math.floor(this.curSize[1]));
};


/**
 * Initialize shader programs, bind buffers to their corresponding block names
 * and set fixed samplers for every program.
 */

initShaders() {

    this.initTextureIdxs();

    this.programs = {
        tile: new GpuProgram(this.gpu, shaderTileVert, shaderTileFrag,
        'shader-tile', {
            uboFrame: Renderer.UniformBlockName.Frame,
            uboLayers: Renderer.UniformBlockName.Layers,
            uboAtm: Renderer.UniformBlockName.Atmosphere
        },{
            uTexAtmDensity: this.textureIdxs.atmosphere
        }),
        background: new GpuProgram(this.gpu, backgroundTileVert, backgroundTileFrag,
        'shader-background', {
            uboAtm: Renderer.UniformBlockName.Atmosphere
        },{
            uTexAtmDensity: this.textureIdxs.atmosphere
        })
    }
}

/**
 * Compute fixed active texture units. We use the back offsets for these,
 * reserving low numbers for dynamic allocation (this probably does not make
 * much sense, but legacy shaders usually use indices 0 and 1 and we cannot
 * control them.
 */

initTextureIdxs() {

    let gl = this.gpu.gl;
    const maxFragTextures = gl.getParameter(gl.MAX_TEXTURE_IMAGE_UNITS);

    this.textureIdxs = {

        atmosphere: maxFragTextures - TextureIdxOffsets.Atmosphere,
    };

    // diagnostics
    __DEV__ && utils.logOnce(
        `Atmosphere uses texture unit ${this.textureIdxs.atmosphere}.`);
}

/**
 * initialize the uboFrame and ubooAtm uniform buffer objects, for later
 * per-frame updates.
 *
 * this function is not called in constructor because the mapconfig manifest is
 * typically not known when renderer is initialized. The map object needs to
 * exist before this function is called.
 */

createBuffers() {

    let gl = this.gpu.gl;

    // uboFrame
    this.uboFrame = gl.createBuffer();

    gl.bindBuffer(gl.UNIFORM_BUFFER, this.uboFrame);
    // 2*mat4 (2*64) + 10*vec4 (10*16) + ivec4 (16) = 304
    // see uboFrame in frame.inc.glsl
    gl.bufferData(gl.UNIFORM_BUFFER, UboFrameSize, gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.UNIFORM_BUFFER, null);

    gl.bindBufferBase(gl.UNIFORM_BUFFER, Renderer.UniformBlockName.Frame,
        this.uboFrame);

    // uboAtmosphere initialized in the atmosphere object
    if (this.core.map.atmosphere) this.core.map.atmosphere.createBuffers();

    // uboLayers not initialized here: each submesh keeps its own

}

/**
 * Update the contents of the uboFrame and uboAtm unform buffer objects based
 * on current position and view configuration. This should be called once per
 * frame.
 */

updateBuffers() {

    // TODO: sync these with debug.
    let renderFlags: Renderer.RenderFlags = Renderer.RenderFlags.FlagAll;

    // map
    let map = this.core.map;

    // one backing buffer, two typed views.
    const buf = new ArrayBuffer(UboFrameSize);
    const f32 = new Float32Array(buf); // for mat4/vec4
    const i32 = new Int32Array(buf);   // for ivec4

    let data: {[key:string]: any} = {};

    // obtain the data: matrices
    data.view = this.camera.getModelviewFMatrix();
    data.projection = this.camera.getProjectionFMatrix();

    // obtain the data: body params and vertical exaggeration

    let se = this.getSuperElevation(map.position);
    let srsInfo = this.core.map.getPhysicalSrs().getSrsInfo();
    let majorAxis = srsInfo.a;
    let minorAxis = srsInfo.b;

    data.bodyParams = [majorAxis, majorAxis / minorAxis, 0, 0];
    data.vaParams1 = se.slice(0,4);
    data.vaParams2 = se.slice(4,7).concat(0);

    // obtain the data: illumination

    if (!this.getIlluminationState()) {

        data.lightDirection = [0, 0, 0];
        data.lightAmbient = [0, 0, 0]
        data.lightDiffuse = [0, 0, 0];
        data.lightSpecular = [0, 0, 0];

        renderFlags &= ~Renderer.RenderFlags.FlagLighting;
    }

    if (this.getIlluminationState()) {

        let illumvecVC: math.vec3, illumvec: math.vec3, lightDir: math.vec3;

        illumvecVC = this.getIlluminationVectorVC().slice() as math.vec3;
        illumvec = vec3.create() as math.vec3;
        lightDir = vec3.create() as math.vec3;

        mat4.multiplyVec3_(
            this.camera.getModelviewMatrixInverse(), illumvecVC, illumvec);
        vec3.negate(illumvec, lightDir);

        data.lightDirection = lightDir;

        let ambcf = this.getIlluminationAmbientCoef();

        data.lightAmbient = [ambcf, ambcf, ambcf]

        // these should be configurable
        data.lightDiffuse = [1.0 - ambcf, 1.0 - ambcf, 1.0 - ambcf];
        data.lightSpecular = [0.6, 0.6, 0.5];
        //data.lightSpecular = [1.0, 0.2, 0.2];
    }

    // physicalEyePos, eyeToCenter
    data.physicalEyePos = map.camera.position;
    data.eyeToCenter =  [map.position.getViewDistance()];

    // obtain the data: render flags and clip params
    // TODO - use this.debug to set the flags
    data.renderFlags = [renderFlags, 0, 0, 0];

    // clip params
    data.clipParams = [this.core.map.config.mapSplitMargin, 0, 0, 0];

    // virtualEeye, virtualEyeToCenter
    const center_ = map.camera.getCenter();
    const eye_ = map.camera.position;

    let centerToEyeV = vec3.create();
    vec3.subtract(eye_, center_, centerToEyeV);

    // we set the viewPosFactor to virtual FOV 60 degrees
    // the virtual eye distance corresponds to vertical extent
    // TODO: make this configurable
    let viewPosFactor = map.position.getViewExtent()
        / map.position.getViewDistance();

    vec3.scale(centerToEyeV, viewPosFactor);
    let virtualEye = vec3.create();
    vec3.add(center_, centerToEyeV, virtualEye);
    vec3.subtract(virtualEye, map.camera.position); // physical space -> renderer world space

    data.virtualEye = virtualEye;
    data.virtualEyeToCenter = [vec3.length(centerToEyeV)];


    // offsets in bytes (std140): see frame.inc.glsl/ uboFrame
    const OFF = {
        view:           0,          // 0
        projection:     64,         // 16 floats
        bodyParams:     128,        // 32 floats
        vaParams1:      144,        // 36
        vaParams2:      160,        // 40
        renderFlags:    176,        // 44 (int view)
        physicalEyePos: 192,        // 48
        eyeToCenter:    204,        // 51
        lightDirection: 208,        // 52
        lightAmbient:   224,        // 56
        lightDiffuse:   240,        // 60
        lightSpecular:  256,        // 64
        virtualEye:     272,        // 68
        virtualEyeToCenter: 284,    // 71
        clipParams:     288         // 72
    };

    // console.log(data);

    // write floats (indices = byteOffset / 4)
    f32.set(data.view,                  OFF.view / 4);
    f32.set(data.projection,            OFF.projection / 4);
    f32.set(data.bodyParams,            OFF.bodyParams / 4);
    f32.set(data.vaParams1,             OFF.vaParams1 / 4);
    f32.set(data.vaParams2,             OFF.vaParams2 / 4);
    f32.set(data.physicalEyePos,        OFF.physicalEyePos / 4);
    f32.set(data.eyeToCenter,           OFF.eyeToCenter / 4);
    f32.set(data.lightDirection,        OFF.lightDirection / 4);
    f32.set(data.lightAmbient,          OFF.lightAmbient / 4);
    f32.set(data.lightDiffuse,          OFF.lightDiffuse / 4);
    f32.set(data.lightSpecular,         OFF.lightSpecular / 4);
    f32.set(data.virtualEye,            OFF.virtualEye / 4);
    f32.set(data.virtualEyeToCenter,    OFF.virtualEyeToCenter / 4);
    f32.set(data.clipParams,            OFF.clipParams / 4);

    // write ints for ivec4
    const ri = OFF.renderFlags / 4;
    i32[ri + 0] = data.renderFlags[0] | 0;

    // upload
    let gl = this.gpu.gl;

    gl.bindBuffer(gl.UNIFORM_BUFFER, this.uboFrame);
    gl.bufferSubData(gl.UNIFORM_BUFFER, 0, buf);
    gl.bindBuffer(gl.UNIFORM_BUFFER, null);


    // the uboAtm buffer
    if (this.core.map.atmosphere) {

        let [view2ecef, _, eyePos] = this.calcEcefCamParams();

        //console.log(this.core.map.camera.position);
        //console.log(view2ecef);

        this.core.map.atmosphere.updateBuffers(
            eyePos,
            map.position.getViewDistance(),
            view2ecef as math.mat4)
    }

}

drawBackground() {

    let atmosphere = this.core.map.atmosphere;

    if (atmosphere && this.core.map.atmosphere.isReady()) {

            let [_, clip2ecef, eyePos] = this.calcEcefCamParams();
            this.core.map.atmosphere.drawBackground(eyePos, clip2ecef);
    }
}

private calcEcefCamParams(): [math.mat4, math.mat4, math.vec3] {

    // as noted elsewhere, the renderer world coordinates are not
    // true physical world coordinates - they are translated relative to
    // camera center to avoid quantization errors. Hence this.
    let view2ecef = mat4.translate(mat4.identity(mat4.create()),
                                       this.core.map.camera.position);
    let clip2ecef = [...view2ecef];

    mat4.multiply(view2ecef, this.camera.modelviewinverse);
    mat4.multiply(clip2ecef, this.camera.mvpinverse);

    return [
        view2ecef as math.mat4,
        clip2ecef as math.mat4,
        this.core.map.camera.position as math.vec3];
}


initProceduralShaders() {
    this.init.initProceduralShaders();
};

updateIllumination(position: MapPosition) {

    if (!this.illumination) return;

    this.illumination.vectorNED =
        Illumination.lned2ned(this.illumination.vectorLNED, position);
}

onResize() {
    if (this.killed){
        return;
    }

    var rect = this.div.getBoundingClientRect();
    this.resizeGL(Math.floor(rect.width), Math.floor(rect.height));
    
    if (this.onResizeCall) {
        this.onResizeCall();
    }
};

resizeGL(width: number, height: number, skipCanvas: boolean = false) {
    this.camera.setAspect(width / height);
    this.curSize = [width, height];
    this.oldSize = [width, height];

    this.gpu.resize(this.curSize, skipCanvas);

    var m = new Float32Array(16);

    // the matrix is column-major
    m[0] = 2.0/width; m[1] = 0; m[2] = 0; m[3] = 0;
    m[4] = 0; m[5] = -2.0/height; m[6] = 0; m[7] = 0;
    m[8] = 0; m[9] = 0; m[10] = 1; m[11] = 0;
    m[12] = -width*0.5*m[0]; m[13] = -height*0.5*m[5]; m[14] = 0; m[15] = 1;

    this.imageProjectionMatrix = m;
};


project2(point, mvp, cameraPos, includeDistance: boolean = false) {
    var p = [0, 0, 0, 1];

    if (cameraPos) {
        p = mat4.multiplyVec4(mvp, [point[0] - cameraPos[0], point[1] - cameraPos[1], point[2] - cameraPos[2], 1 ]);
    } else {
        p = mat4.multiplyVec4(mvp, [point[0], point[1], point[2], 1 ]);
    }

    //project point coords to screen
    if (p[3] != 0) {
        var sp = [0,0,0];

        //x and y are in screen pixels
        sp[0] = ((p[0]/p[3])+1.0)*0.5*this.curSize[0];
        sp[1] = (-(p[1]/p[3])+1.0)*0.5*this.curSize[1];

        //depth in meters
        sp[2] = p[2]/p[3];

        if (includeDistance) {
            sp[3] = p[2];
        }

        return sp;
    } else {
        return [0, 0, 0];
    }
};

setIlluminationState(state: boolean) {

    if (this.illumination) this.illumination.useLighting = state;
};


getIlluminationState(): boolean {
    return this.illumination && this.illumination.useLighting;
};

setIllumination(definition: Renderer.IlluminationDef) {

    if (!definition.hasOwnProperty('light') || !Array.isArray(definition.light))
        throw new Error("Light missing, or no an array.");

    let light = definition.light;

    if (light[0] != "tracking") throw new Error('Only tracking lights supported.');

    let azimuth = utils.validateNumber(light[1], 0, 360, 315);
    let elevation = utils.validateNumber(light[2], 0, 90, 45);

    // if the illumination object exists, we presume that lighting is on
    let useLighting = definition.useLighting ?? true;

    this.illumination = {
        ambientCoef: utils.validateNumber(definition.ambientCoef, 0.0, 1.0, 0.3),
        trackingLight : {
            azimuth : azimuth,
            elevation: elevation
        },
        vectorVC : Illumination.illuminationVector(
                        azimuth, elevation, Illumination.CoordSystem.VC),
        vectorLNED : Illumination.illuminationVector(
                        azimuth, elevation, Illumination.CoordSystem.LNED),

        useLighting: !! useLighting
    }

    __DEV__ && console.log("Illumination: ", this.illumination);
};

getIlluminationVectorVC() {

    if (!this.illumination)
        throw Error('illumination vector requested, but no illumination defined.');

    //console.log("Illumination: vector", this.illumination.illuminationVectorVC);
    return this.illumination.vectorVC;
};

getIlluminationVectorNED() {

    if (!this.illumination)
        throw Error('illumination vector requested, but no illumination defined.');

    //console.log("Illumination: vector", this.illumination.vectorNED);
    return this.illumination.vectorNED;
};


getIlluminationAmbientCoef() {

    //console.log("Illumination: ambient coef", this.illumination.ambientCoef);

    return this.illumination.ambientCoef;
};

setSuperElevationState(state: boolean) {

    if (this.useSuperElevation != state) {
        this.useSuperElevation = state;
        this.seCounter++;
    }
};

getSuperElevationState(): boolean {
    return this.useSuperElevation;
};

setSuperElevation(seDefinition : Renderer.SeDefinition) {

    // old format
    if (Array.isArray(seDefinition)){

        return this.setSuperElevationRamp(seDefinition);
    }

    // new format
    if (typeof seDefinition === 'object' && seDefinition !== null
        && !Array.isArray(seDefinition)) {

        // heightRamp
        if (seDefinition.heightRamp && Array.isArray(seDefinition.heightRamp)) {

            this.setSuperElevationRamp(seDefinition.heightRamp);

        } else {

            this.seHeightRamp = null;
        }

        // viewExtentProgression
        if (seDefinition.viewExtentProgression
            && Array.isArray(seDefinition.viewExtentProgression)) {

            this.setSuperElevationProgression(
                seDefinition.viewExtentProgression);

        } else {

            this.seProgression = null;
        }

        return;
    }

    // default
    throw new Error("Unsupported super elevation option.");

}

private setSuperElevationProgression(progression: SeProgressionDef) {

    if (!(progression && progression[0] && progression[1] && progression[3]
            && progression[3] && progression[4])) {
        throw new Error("Unsupported super elevation option.");
    }

    this.seProgression = {
        baseValue: progression[0],
        baseExtent: progression[1],
        exponent: Math.log2(progression[2]),
        min: progression[3],
        max: progression[4]
    };

    this.useSuperElevation = true;

    //console.log("seProgression: ", this.seProgression);

}


private getSuperElevationProgression(): SeProgression  {

    return structuredClone(this.seProgression);
}


private setSuperElevationRamp(se: [[number, number], [number, number]]) {

    if (!(se && se[0] && se[1] && se[0].length >=2 && se[1].length >=2)) {
        throw new Error("Unsupported super elevation option.");
    }

    let h1 = se[0][0]; let f1 = se[1][0]; let h2 = se[0][1]; let f2 = se[1][1];

    if (f1 == 1 && f2 == 1) {
        if (this.useSuperElevation != false) {
            this.useSuperElevation = false;
            this.seCounter++;
        }

        if (h1 == h2) { h2 = h1 + 1; }
        this.seHeightRamp = [h1, f1, h2, f2, h2-h1, f2-f1, 1.0 / (h2-h1)];
        return;
    }

    if (h1 == h2) { h2 = h1 + 1; }
    this.seHeightRamp = [h1, f1, h2, f2, h2-h1, f2-f1, 1.0 / (h2-h1)];
    this.seCounter++;
};

getSeProgressionFactor(position: MapPosition | number) {

    if (arguments.length !== 1)
        throw new Error('function now requires current position');

    if (!this.seProgression) return 1.0;

    let progression_ = this.seProgression;

    let extent_ = typeof position === 'number' ? position : position.pos[8];

    let retval = math.clamp(
        progression_.baseValue *
            (extent_ / progression_.baseExtent) ** progression_.exponent,
        progression_.min, progression_.max);

    //console.log("seProgressionFactor", retval);

    return retval;
}


/**
 * @returns a tuple of 7 numbers describing the vertical exaggeration
 * if the original ramp spec was [h1, h2, f1, f2], the returned value is
 * something like:
 * [h1, f1, h2, f2, h2-h1, f2-f1, 1.0 / (h2-h1)]
 */

getSuperElevation(position) : SeRamp {

    if (arguments.length !== 1) {
        throw new Error('Function now requires current position.');
    }

    let retval;

    // heightRamp
    if (this.seHeightRamp) {
        retval = this.seHeightRamp.slice();
    } else {
        retval = [0, 1, 1000, 1, 1000, 0, 1.0 / 1000];
    }

    // progression
    if (this.seProgression) {
        retval[1] *= this.getSeProgressionFactor(position);
        retval[3] *= this.getSeProgressionFactor(position);

        retval[5] = retval[3] - retval[1];
    }

    //console.log('getSuperElevation: ', retval);

    return retval;
};


getSuperElevatedHeight(height, position) {

    if (arguments.length !== 2) {
        throw new Error('Function now requires current position.');
    }

    let retval;

    // heightRamp
    if (this.seHeightRamp) {
        retval = this.getSuperElevatedHeightRamp(height);
    } else {
        retval = height;
    }

    // progression
    if (this.seProgression) {
        retval *= this.getSeProgressionFactor(position);
    }

    return retval;
}


getSuperElevatedHeightRamp(height) {


    var se = this.seHeightRamp, h = height;

    if (h < se[0]) {  // 0 - h1, 1 - f1, 2 - h2, 3 - f2, 4 - dh, 5 - df, 6 - invdh
        h = se[0];
    }

    if (h > se[2]) {
        h = se[2];
    }

    return height * (se[1] + ((h - se[0]) * se[6]) * se[5]);
};


getUnsuperElevatedHeight(height, position) {

    if (arguments.length !== 2) {
        throw new Error('Function now requires current position.');
    }

    let retval;

    // heightRamp
    if (this.seHeightRamp) {
        retval = this.getUnsuperElevatedHeightRamp(height);
    } else {
        retval = height;
    }

    // progression
    if (this.seProgression) {
        retval /= this.getSeProgressionFactor(position);
    }

    return retval;
}


getUnsuperElevatedHeightRamp(height) {
    var se = this.seHeightRamp, s = height;

    if (se[1] == se[3]) {
        return s / se[1];
    }

    if (s <= se[0] * se[1]) {  // 0 - h1, 1 - f1, 2 - h2, 3 - f2, 4 - dh, 5 - df, 6 - invdh
        return s / se[1];
    }

    if (s >= se[2] * se[3]) {
        return s / se[3];
    }


    var h1 = se[0], f1 = se[1], h2 = se[2], f2 = se[3];

    // and f1!=f2 and h1!=h2

    return -(Math.sqrt(-2*f2*(f1*h1*h2 + 2*h1*s - 2*h2*s) + f1*(f1*h2*h2 + 4*h1*s - 4*h2*s) + f2*f2*h1*h1) - f1*h2 + f2*h1)/(2*(f1 - f2));
};


getEllipsoidHeight(pos, shift) {
    var p, p2;
    this.seTmpVec3 = [0,0,0];

    if (shift) {
        p = this.seTmpVec;
        p2 = [pos[0] + shift[0], pos[1] + shift[1], (pos[2] + shift[2]) * this.earthERatio];
    } else {
        p = pos;
        p2 = [p[0], p[1], p[2] * this.earthERatio];
    }

    var l = Math.sqrt(p2[0] * p2[0] + p2[1] * p2[1] + p2[2] * p2[2]);

    return l - this.earthRadius;
};


transformPointBySE(pos, shift, position) {

    if (arguments.length !== 3)
        throw new Error('function now requires current position');

    var p = pos, p2;
    this.seTmpVec3 = [0,0,0];

    if (shift) {
        p2 = [pos[0] + shift[0], pos[1] + shift[1], (pos[2] + shift[2]) * this.earthERatio];
    } else {
        p2 = [p[0], p[1], p[2] * this.earthERatio];
    }

    var l = Math.sqrt(p2[0] * p2[0] + p2[1] * p2[1] + p2[2] * p2[2]);
    var v = this.seTmpVec2;

    var m = (1.0/(l+0.0001));
    v[0] = p2[0] * m;
    v[1] = p2[1] * m;
    v[2] = p2[2] * m;

    var h = l - this.earthRadius;
    var h2 = this.getSuperElevatedHeight(h, position);
    m = (h2 - h);

    p2[0] = p[0] + v[0] * m;
    p2[1] = p[1] + v[1] * m;
    p2[2] = p[2] + v[2] * m;

    return p2;
};


transformPointBySE2(pos, shift, position) {

    if (arguments.length !== 3)
        throw new Error('function now requires current position');

    var p = pos, p2;
    this.seTmpVec3 = [0,0,0];

    if (shift) {
        p2 = [pos[0] + shift[0], pos[1] + shift[1], (pos[2] + shift[2]) * this.earthERatio];
    } else {
        p2 = [p[0], p[1], p[2] * this.earthERatio];
    }

    var l = Math.sqrt(p2[0] * p2[0] + p2[1] * p2[1] + p2[2] * p2[2]);
    var v = this.seTmpVec2;

    var m = (1.0/(l+0.0001));
    v[0] = p2[0] * m;
    v[1] = p2[1] * m;
    v[2] = p2[2] * m;

    var h = l - this.earthRadius;
    var h2 = this.getSuperElevatedHeight(h, position);
    m = (h2 - h);// * 10;

    pos = pos.slice();

    pos[0] = p[0] + v[0] * m;
    pos[1] = p[1] + v[1] * m;
    pos[2] = p[2] + v[2] * m;

    pos[13] = v[0] * m;
    pos[14] = v[1] * m;
    pos[15] = v[2] * m;

    return pos;
};

/*
// there is a type error in this function in calling this.cameraPosition(). Commenting out, as it's likely never called.
project(point) {
    //get mode-view-projection matrix
    var mvp = this.camera.getMvpMatrix();

    //get camera position relative to position
    var cameraPos2 = this.camera.getPosition();

    //get global camera position
    var cameraPos = this.cameraPosition();

    //get point coords relative to camera
    var p = [point[0] - cameraPos[0] + cameraPos2[0], point[1] - cameraPos[1] + cameraPos2[1], point[2] - cameraPos[2] + cameraPos2[2], 1 ];

    //project point coords to screen
    var p2 = [0, 0, 0, 1];
    p2 = mat4.multiplyVec4(mvp, p);

    if (p2[3] != 0) {

        var sp = [0,0,0];

        //x and y are in screen pixels
        sp[0] = ((p2[0]/p2[3])+1.0)*0.5*this.curSize[0];
        sp[1] = (-(p2[1]/p2[3])+1.0)*0.5*this.curSize[1];

        //depth in meters
        sp[2] = p2[2]/p2[3];

        return sp;
    } else {
        return [0, 0, 0];
    }
};*/


getScreenRay(screenX, screenY) {
    if (this.camera == null) {
        return [0,0,1.0];
    }

    this.camera.dirty = true; //???? why is projection matrix distored so I have to refresh

    //convert screen coords
    var x = (2.0 * screenX) / this.curSize[0] - 1.0;
    var y = 1.0 - (2.0 * screenY) / this.curSize[1];
    
    var rayNormalizeDeviceSpace = [x, y, 1.0];

    var rayClipCoords = [rayNormalizeDeviceSpace[0], rayNormalizeDeviceSpace[1], -1.0, 1.0];

    var invProjection = mat4.create();
    invProjection = mat4.inverse(this.camera.getProjectionMatrix());

    //console.log("--" + JSON.stringify(rayClipCoords));
    //console.log("----" + JSON.stringify(invProjection));

    var rayEye = [0,0,0,0];
    mat4.multiplyVec4(invProjection, rayClipCoords, rayEye); //inverse (projectionmatrix) * rayClipCoords;
    rayEye[2] = -1.0;
    rayEye[3] = 0.0;

    var invView = mat4.create();
    invView = mat4.inverse(this.camera.getModelviewMatrix());

    var rayWorld = [0,0,0,0];
    mat4.multiplyVec4(invView, rayEye, rayWorld); //inverse (projectionmatrix) * rayClipCoords;

    // don't forget to normalise the vector at some point
    rayWorld = vec3.normalize([rayWorld[0], rayWorld[1], rayWorld[2]]); //normalise (raywor);

    return rayWorld;
};


hitTestGeoLayers(screenX, screenY, secondTexture) {
    var gl = this.gpu.gl;

    //probably not needed
    //if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) != gl.FRAMEBUFFER_COMPLETE) {
      //  return [false, 0,0,0,0];
    //}

    var surfaceHit = false, pixel: Uint8Array;

    if (screenX >= 0 && screenX < this.curSize[0] &&
        screenY >= 0 && screenY < this.curSize[1]) {

        //convert screen coords to texture coords
        var x = 0, y = 0;

        //get screen coords
        x = Math.floor(screenX * (this.hitmapSize / this.curSize[0]));
        y = Math.floor(screenY * (this.hitmapSize / this.curSize[1]));

        //get pixel value from framebuffer

        if (secondTexture) {
            pixel = this.geoHitmapTexture2.readFramebufferPixels(x, this.hitmapSize - y - 1, 1, 1);
        } else {
            pixel = this.geoHitmapTexture.readFramebufferPixels(x, this.hitmapSize - y - 1, 1, 1);
        }

        surfaceHit = !(pixel[0] == 255 && pixel[1] == 255 && pixel[2] == 255 && pixel[3] == 255);
    }

    if (surfaceHit) {
        return [true, pixel[0], pixel[1], pixel[2], pixel[3]];
    } 

    return [false, 0,0,0,0];
};


switchToFramebuffer(type, texture) {
    var gl = this.gpu.gl, size, width, height;
    
    switch(type) {
    case 'base':

        width = this.oldSize[0];
        height = this.oldSize[1];
    
        gl.clearColor(0.0, 0.0, 0.0, 1.0);
    
        this.gpu.setFramebuffer(null);
        this.gpu.setViewport();

        this.camera.setAspect(width / height);
        this.curSize = [width, height];
        //this.gpu.resize(this.curSize, true);
        this.camera.update();
            //this.updateCamera();
        this.onlyDepth = false;
        this.onlyHitLayers = false;
        this.onlyAdvancedHitLayers = false;
        this.advancedPassNeeded = false;
        break;

    case 'depth':

        //set texture framebuffer
        this.gpu.setFramebuffer(this.hitmapTexture);

        this.oldSize = [ this.curSize[0], this.curSize[1] ];
   
        gl.clearColor(1.0,1.0, 1.0, 1.0);
        gl.enable(gl.DEPTH_TEST);

        size = this.hitmapSize;
    
        //clear screen
        gl.viewport(0, 0, size, size);
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    
        this.curSize = [size, size];

        //this.gpu.clear();
        this.camera.update();
        this.onlyDepth = true;
        this.onlyHitLayers = false;
        this.onlyAdvancedHitLayers = false;
        this.advancedPassNeeded = false;
        //console.log('curSize = ', this.curSize);
        break;

    case 'geo':
    case 'geo2':

        this.hoverFeatureCounter = 0;
        size = this.hitmapSize;
            
        //set texture framebuffer
        this.gpu.setFramebuffer(type == 'geo' ? this.geoHitmapTexture : this.geoHitmapTexture2);
            
        width = size;
        height = size;
            
        gl.clearColor(1.0, 1.0, 1.0, 1.0);
        gl.enable(gl.DEPTH_TEST);
            
        //clear screen
        gl.viewport(0, 0, size, size);
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
            
        this.curSize = [width, height];
            
        //render scene
        this.onlyHitLayers = true;
        this.advancedPassNeeded = false;
        this.onlyAdvancedHitLayers = (type == 'geo2');
            
        //this.gpu.clear();
        this.camera.update();
        break;

    case 'texture':
        //set texture framebuffer

        console.log('texture (warn: untested path)');

        this.oldSize = [...this.curSize];

        this.gpu.setFramebuffer(texture);

        gl.clearColor(0.0, 0.0, 0.0, 1.0);
        gl.enable(gl.DEPTH_TEST);

        //clear screen
        //gl.viewport(0, 0, this.gpu.canvas.width, this.gpu.canvas.height);
        gl.viewport(0, 0, texture.width, texture.height);
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

        // shouldn't this be texture size instead?
        this.curSize = [texture.width, texture.height];
        //this.curSize = [this.gpu.canvas.width, this.gpu.canvas.height];

        //this.gpu.clear();
        this.camera.update();
        this.onlyDepth = false;
        this.onlyHitLayers = false;
        this.onlyAdvancedHitLayers = false;
        this.advancedPassNeeded = false;
        break;        
    }
};


hitTest(screenX, screenY) {
    var gl = this.gpu.gl;

    //get screen ray
    var screenRay = this.getScreenRay(screenX, screenY);
    var cameraPos = this.camera.getPosition();

    //probably not needed
    //if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) != gl.FRAMEBUFFER_COMPLETE) {  
      //  return [0, 0, 0, null, screenRay, Number.MAX_VALUE, cameraPos];
    //}

    //convert screen coords to texture coords
    var x = 0, y = 0;

    //get screen coords
    x = Math.floor(screenX * (this.hitmapSize / this.curSize[0]));
    y = Math.floor(screenY * (this.hitmapSize / this.curSize[1]));

    //get pixel value from framebuffer
    var pixel = this.hitmapTexture.readFramebufferPixels(x, this.hitmapSize - y - 1, 1, 1);

    //convert rgb values into depth
    var depth = (pixel[0] * (1.0/255)) + (pixel[1]) + (pixel[2]*255.0) + (pixel[3]*65025.0);// + (pixel[3]*16581375.0);

    var surfaceHit = !(pixel[0] == 255 && pixel[1] == 255 && pixel[2] == 255 && pixel[3] == 255);

    //compute hit postion
    this.lastHitPosition = [cameraPos[0] + screenRay[0]*depth, cameraPos[1] + screenRay[1]*depth, cameraPos[2] + screenRay[2]*depth];

    return [this.lastHitPosition[0], this.lastHitPosition[1], this.lastHitPosition[2], surfaceHit, screenRay, depth, cameraPos];
};


copyHitmap() {

    this.hitmapTexture.readFramebufferPixels(
        0, 0, this.hitmapSize, this.hitmapSize, false, this.hitmapData
    );
};


getDepth(screenX: number, screenY: number, dilate: number = 0) {

    var x = Math.floor(screenX * (this.hitmapSize / this.curSize[0]));
    var y = Math.floor(screenY * (this.hitmapSize / this.curSize[1]));

    var depth: number;


    if (this.hitmapMode <= 2) {

        //get pixel value from framebuffer
        var pixel = this.hitmapTexture.readFramebufferPixels(x, this.hitmapSize - y - 1, 1, 1, (this.hitmapMode == 2));

        //convert rgb values into depth
        depth = (pixel[0] * (1.0/255)) + (pixel[1]) + (pixel[2]*255.0) + (pixel[3]*65025.0);
        var surfaceHit = !(pixel[0] == 255 && pixel[1] == 255 && pixel[2] == 255 && pixel[3] == 255);

     } else {

        // CPU-cached path; allow small dilation, if configured to catch near-occlusions (in pixels)
        var pixels = this.hitmapData;
        var rpx = dilate;
        var minDepth = Number.POSITIVE_INFINITY;
        var anyHit = false;
        /*if (rpx <= 0) {
            var index = (x + (this.hitmapSize - y - 1) * this.hitmapSize) * 4;
            var r = pixels[index], g = pixels[index+1], b = pixels[index+2], a = pixels[index+3];
            minDepth = (r * (1.0/255)) + (g) + (b*255.0) + (a*65025.0);
            anyHit = !(r == 255 && g == 255 && b == 255 && a == 255);
        } else */ {
            var hs = this.hitmapSize;
            var y0 = (this.hitmapSize - y - 1);
            for (var dy = -rpx; dy <= rpx; dy++) {
                var yy = y0 + dy;
                if (yy < 0 || yy >= hs) continue;
                for (var dx = -rpx; dx <= rpx; dx++) {
                    var xx = x + dx;
                    if (xx < 0 || xx >= hs) continue;
                    var idx = (xx + yy * hs) * 4;
                    var rr = pixels[idx], gg = pixels[idx+1], bb = pixels[idx+2], aa = pixels[idx+3];
                    var surface = !(rr == 255 && gg == 255 && bb == 255 && aa == 255);
                    if (surface) {
                        anyHit = true;
                        var d = (rr * (1.0/255)) + (gg) + (bb*255.0) + (aa*65025.0);
                        if (d < minDepth) minDepth = d;
                    }
                }
            }
            if (!anyHit) {
                // fall back to center sample
                var index2 = (x + y0 * hs) * 4;
                var r2 = pixels[index2], g2 = pixels[index2+1], b2 = pixels[index2+2], a2 = pixels[index2+3];
                minDepth = (r2 * (1.0/255)) + (g2) + (b2*255.0) + (a2*65025.0);
            }
        }
        var depth = minDepth;
        var surfaceHit = anyHit;
    }

    return [surfaceHit, depth];
};


getZoffsetFactor(params) {
    return (params[0] + params[1]*this.distanceFactor + params[2]*this.tiltFactor)*0.0001;
};


saveScreenshot(output, filename, filetype) {
    var gl = this.gpu.gl;

    //get current screen size
    var width = this.curSize[0];
    var height = this.curSize[1];

    //read rgba data from frame buffer
    //works only when webgl context is initialized with preserveDrawingBuffer: true
    var data2 = new Uint8Array(width * height * 4);
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, data2);

    //flip image vertically
    var data = new Uint8Array(width * height * 4);
    var index = 0;

    for (var y = 0; y < height; y++) {

        var index2 = ((height-1) - y) * width * 4;

        for (var x = 0; x < width; x++) {
            data[index] = data2[index2];
            data[index+1] = data2[index2+1];
            data[index+2] = data2[index2+2];
            data[index+3] = data2[index2+3];
            index+=4;
            index2+=4;
        }
    }

    // Create a 2D canvas to store the result
    var canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    var context = canvas.getContext('2d');

    // Copy the pixels to a 2D canvas
    var imageData = context.createImageData(width, height);
    imageData.data.set(data);
    context.putImageData(imageData, 0, 0);

    filetype = filetype || 'jpg'; 
   
    if (output == 'file') {
        var a = document.createElement('a');

        var dataURI= canvas.toDataURL('image/' + filetype);

        var byteString = atob(dataURI.split(',')[1]);
        
        // write the bytes of the string to an ArrayBuffer
        var ab = new ArrayBuffer(byteString.length);
        var ia = new Uint8Array(ab);
        for (var i = 0; i < byteString.length; i++) {
            ia[i] = byteString.charCodeAt(i);
        }
      
        var file = new Blob([ab], {type: filetype});

        var url = URL.createObjectURL(file);
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        setTimeout(function() {
            document.body.removeChild(a);
            window.URL.revokeObjectURL(url);  
        }, 0); 
    } if (output == 'tab') {
        //open image in new window
        window.open(canvas.toDataURL('image/' + filetype));
    }
    
    return imageData;
};


getBitmap(url, filter, tiled, hash, useHash) {
    var id = (useHash ? hash : url) + '*' + filter + '*' + tiled;

    var texture = this.bitmaps[id];
    if (!texture && url) {
        texture = new GpuTexture(this.gpu, url, this.core, null, null, tiled, filter);
        this.bitmaps[id] = texture;
    }

    return texture;
};


getFont(url) {
    var font = this.fonts[url];
    if (!font) {
        font = new GpuFont(this.gpu, this.core, null, null, url);
        this.fonts[url] = font;
    }

    return font;
};

kill() {
    if (this.killed){
        return;
    }

    this.killed = true;

    //if (this.heightmapMesh) this.heightmapMesh.kill();
    if (this.heightmapTexture) this.heightmapTexture.kill();
    if (this.skydomeMesh) this.skydomeMesh.kill();
    //if (this.skydomeTexture) this.skydomeTexture.kill();
    if (this.hitmapTexture) this.hitmapTexture.kill();
    if (this.geoHitmapTexture) this.geoHitmapTexture.kill();
    if (this.redTexture) this.redTexture.kill();
    if (this.whiteTexture) this.whiteTexture.kill();
    if (this.blackTexture) this.blackTexture.kill();
    //if (this.lineTexture) this.lineTexture.kill();
    if (this.textTexture2) this.textTexture2.kill();
    if (this.atmoMesh) this.atmoMesh.kill();
    if (this.bboxMesh) this.bboxMesh.kill();
    //if (this.font) this.font.kill();
    if (this.plines) this.plines.kill();
    if (this.plineJoints) this.plineJoints.kill();

    this.gpu.kill();
    //this.div.removeChild(this.gpu.getCanvas());
};

} // export class Renderer

// local types

type Optional<T> = T | null;

type Config = {
    [key: string]: boolean | number | string | number[];
    rendererAllowScreenshots?: boolean;
    rendererAntialiasing?: boolean;
    rendererAnisotropic?: number;
    mapDMapSize?: number;
    mapDMapMode?: number;
    mapDMapCopyIntervalMs?: number;
    mapLabelFreeMargins?: [number, number, number, number];
}

type Size2 = [ number, number ];

type SeProgression = {

    // value when view ext = baseExtent
    baseValue: number;

    // base extent, reference for the value
    baseExtent: number;

    // exponent of dependency on extent
    exponent: number;

    // minimum
    min: number

    // maximum
    max: number
}

type SeProgressionDef =
    [number, number, number, number, number];

type SeRamp =
    [number, number, number, number, number, number, number];

type SeRampDef = [[number, number], [number, number]];

type Core = {

    map: Map;
    contextLost: boolean;

    callListener(name: string, event: any, log?: boolean): void;

}

type Map = {

    body: MapBody;
    atmosphere?: Atmosphere;
    position: MapPosition;
    camera: MapCamera;

    getPhysicalSrs(): MapSrs;

    config: {
        mapSplitMargin: number
    }
}

/** Fixed texture indices - the actual index is computed as
  * Idx % gl.MAX_TEXTURE_IMAGE_UNITS
  */

enum TextureIdxOffsets {

    Atmosphere = -1
}

const UboFrameSize = 304;

// export types
export namespace Renderer {

export enum RenderFlags {

    FlagNone           = 0,
    FlagLighting       = 1 << 0, // bit 0
    FlagNormalMaps     = 1 << 1, // bit 1
    FlagDiffuseMaps    = 1 << 2, // bit 2
    FlagSpecularMaps   = 1 << 3, // bit 3
    FlagBumpMaps       = 1 << 4, // bit 4
    FlagAtmosphere     = 1 << 5, // bit 5
    FlagShadows        = 1 << 6, // bit 6
    FlagAll            = 0xff
}

export type IlluminationDef = {

    // azimuth and elevation in VC
    light: ["tracking", number, number];

    useLighting: boolean;

    ambientCoef?: number;
}

export type Illumination = {

    // the definition (relative to the position of the viewer)
    trackingLight: { azimuth: number, elevation: number };

    // the local representation
    vectorVC: math.vec3;
    vectorLNED: math.vec3;

    // runtime value, dependent on map position and calculated on update
    vectorNED?: math.vec3;

    ambientCoef: number;

    useLighting: boolean;
}


export type SeDefinition = SeRampDef | {
    heightRamp?: SeRampDef;
    viewExtentProgression?: SeProgressionDef;
}


/* Uniform buffer object binding points. */

export enum UniformBlockName {

    Frame = 0,
    Layers = 1,
    Atmosphere = 2
}

} // export namespace Rendrer


export default Renderer;
