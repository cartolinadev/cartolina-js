
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

import * as IlluminationMath from '../map/illumination';

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

    marginFlags = 0; // see rmap.js

    uboFrame!: WebGLBuffer;

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

    debug: Renderer.Debug = {}

    geometries = {} // no clue, see MapInterface.getGeodataGeometry

    stencilLineState: Optional<GpuDevice.State> = null;

    mapHack: any = null; // assigned in map/draw.js

    geodataSelection: any[] = [];

    hoverFeatureCounter = 0;
    hoverFeatureList: any[] = [];

    touchSurfaceEvent: any[] = [];

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
        tile?: GpuProgram,
        background?: GpuProgram
    }

    // texture unit indices
    textureIdxs!: {
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

    /// Layout size of the onscreen canvas (CSS pixels, before transforms).
    /// Always the canvas size regardless of which render target is active.
    /// Use this — not `curSize` — in label-placement code that works in
    /// screen (canvas) space.
    canvasCssSize!: Size2;

    /// physical size in device pixels (after dpr and css transforms)
    private pixelSize!: Size2;

    /// css transform layout size adjustment, per axis
    private visibleScale_!: Size2;

    /// stable viewport CSS height (css()[1] * visibleScale_[1]) — only updated
    /// during the main render pass, not during hitmap/depth framebuffer passes
    private mainViewportCssH!: number;

    // vertical exaggeration
    useSuperElevation = false;
    seHeightRamp?: SeRamp; // 7 elements
    veScaleRamp?: VeScaleRamp;

    // these values, important for vertical exaggeration, are calculated from
    // navigationSrs in MapDraw.drawMap as a side effect of drawing the skydome
    // (which is not guaranteed). TODO: move their initilization here, or drop
    // them altogether and use the map object
    earthRadius: Optional<number> = null; // major axis
    earthRadius2: Optional<number> = null; // minor axis
    earthERatio: Optional<number> = null;

    // illumination
    illumination:  Optional<Illumination> = null;

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
     *  0, 1, 2 - readFramebufferPixels for each getDepth call
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


constructor(core: Core, div: HTMLElement, config : Config) {

    this.config = config; // || {};
    this.core = core;
    this.div = div;
    this.geometries = {};
    this.stencilLineState = null;

    // device
    this.camera = new Camera(this, 45, 2, 1200000.0);

    if (config.mapLabelFreeMargins)
        this.labelFreeMargins = config.mapLabelFreeMargins;

    this.hitmapSize = config.mapDMapSize ?? this.hitmapSize;
    this.hitmapMode = config.mapDMapMode ?? this.hitmapMode;
    this.hitmapCopyIntervalMs
        = config.mapDMapCopyIntervalMs ?? this.hitmapCopyIntervalMs;

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

    this.buffFloat32 = new Float32Array(1);
    this.buffUint32 = new Uint32Array(this.buffFloat32.buffer);

    // device
    const sizes = this.calculateSizes();
    this.applyCanvasState(sizes);

    this.gpu = new GpuDevice(this, div,
        !! this.config.rendererAllowScreenshots, 
        !! this.config.rendererAntialiasing, 
        this.config.rendererAnisotropic ?? 0);

    this.syncCanvas();
    this.syncCanvasRenderTarget();
    this.gpu.setRenderTarget(this.gpu.canvasRenderTarget);
    this.updateLogicalSize(this.gpu.canvasRenderTarget.logicalSize);

    // initialize resources
    this.init = new RenderInit(this);

    this.initTextureIdxs();
    this.programs = {}

    this.rmap = new RendererRMap(this, 50);
    this.draw = new RenderDraw(this);
};


/// Legacy compatibility getter for the logical size of the active render
/// target. Do not use `curSize` in new code. Use an explicit size source
/// instead: for example `canvasCssSize` for the onscreen map view, or
/// `RenderTarget.logicalSize` for target-local coordinates.
get curSize(): Readonly<Size2> {

    return this.gpu.currentRenderTarget.logicalSize;
}

private calculateSizes(): Renderer.CanvasState {

    const el = this.div as HTMLElement;

    // css size, based on layout
    let W = el.offsetWidth || el.clientWidth;
    let H = el.offsetHeight || el.clientHeight;

    // pixel size, based on dpr and css transforms
    const rect = el.getBoundingClientRect();
    let dpr = window.devicePixelRatio || 1;

    // TODO: compute this properly, applying compose of all css transforms
    return {
        cssSize: [W, H],
        pixelSize: [rect.width * dpr, rect.height * dpr],
        visibleScale: [rect.width / W, rect.height / H]
    };
}

private applyCanvasState(sizes: Renderer.CanvasState) {

    this.canvasCssSize = [...sizes.cssSize];
    this.pixelSize = [...sizes.pixelSize];
    this.visibleScale_ = [...sizes.visibleScale];
    this.mainViewportCssH = sizes.cssSize[1] * sizes.visibleScale[1];
}

/**
 * Lazy tile program initialization, including binding buffers to block names
 * and fixed samplers.
 */

programTile() {

    if (this.programs.tile) return this.programs.tile;

    let atmBindings = {}

    if (this.core.map.atmosphere) {

        atmBindings = { uboAtm: Renderer.UniformBlockName.Atmosphere }
    }

    __DEV__ && console.log('Initializing programs.tile');


    this.programs.tile = new GpuProgram(
        this.gpu, shaderTileVert, shaderTileFrag,
        'shader-tile', {
            uboFrame: Renderer.UniformBlockName.Frame,
            uboLayers: Renderer.UniformBlockName.Layers,
            ...atmBindings
        }, { uTexAtmDensity: this.textureIdxs.atmosphere });

    return this.programs.tile;
}

/**
 * Lazy background program initialization, including binding buffers to block names
 * and fixed samplers.
 */

programBackground() {

    if (this.programs.background) return this.programs.background;

    let atmBindings = {}

    if (this.core.map.atmosphere) {

        atmBindings = { uboAtm: Renderer.UniformBlockName.Atmosphere }

    } else {

        __DEV__ && utils.warnOnce('running programs.background without atmosphere?');
    }

    __DEV__ && console.log('Initializing programs.background');

    this.programs.background = new GpuProgram(
        this.gpu, backgroundTileVert, backgroundTileFrag,
        'shader-background', {
            ...atmBindings
        },{ uTexAtmDensity: this.textureIdxs.atmosphere });

    return this.programs.background;
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

    let renderFlags: Renderer.RenderFlags = Renderer.RenderFlags.FlagNone;

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
        data.lightAmbient = [0, 0, 0, 0];
        data.lightDiffuse = [0, 0, 0, 0];
        data.lightSpecular = [0, 0, 0, 0];
        data.shadingParams = [0.0, 0.0, 0.0, 0.0];
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

        let illumination = this.illumination as Illumination;
        let ambcf = illumination.ambientCoef;

        data.lightAmbient = [ambcf, ambcf, ambcf, 0.0];

        const dc = illumination.light.diffuseColor;
        const maxComp = Math.max(dc[0], dc[1], dc[2]);

        if (maxComp > 0) {
            const s = (1.0 - ambcf) / maxComp;
            data.lightDiffuse = [dc[0] * s, dc[1] * s, dc[2] * s, 0.0];
        } else {
            data.lightDiffuse = [0.0, 0.0, 0.0, 0.0];
        }

        data.lightSpecular = [...illumination.light.specularColor, 0.0];
        data.shadingParams = [
            illumination.shadingLambertianWeight,
            illumination.shadingSlopeWeight,
            illumination.shadingAspectWeight,
            0.0
        ];
    }

    // physicalEyePos, eyeToCenter
    data.physicalEyePos = map.camera.position;
    data.eyeToCenter =  [map.position.getViewDistance()];

    // obtain the data: render flags
    // debug fields override config defaults (undefined = use config);
    // flags start at FlagNone so any flag not explicitly set remains 0.
    const d = this.debug;
    const cfg = map.config;

    // FlagLighting requires both the debug/config flag AND active illumination.
    if ((d.flagLighting ?? cfg.mapFlagLighting) && this.getIlluminationState())
        renderFlags |= Renderer.RenderFlags.FlagLighting;

    if (d.flagNormalMaps    ?? cfg.mapFlagNormalMaps)    renderFlags |= Renderer.RenderFlags.FlagNormalMaps;
    if (d.flagDiffuseMaps   ?? cfg.mapFlagDiffuseMaps)   renderFlags |= Renderer.RenderFlags.FlagDiffuseMaps;
    if (d.flagSpecularMaps  ?? cfg.mapFlagSpecularMaps)  renderFlags |= Renderer.RenderFlags.FlagSpecularMaps;
    if (d.flagBumpMaps      ?? cfg.mapFlagBumpMaps)      renderFlags |= Renderer.RenderFlags.FlagBumpMaps;
    if (d.flagAtmosphere    ?? cfg.mapFlagAtmosphere)    renderFlags |= Renderer.RenderFlags.FlagAtmosphere;
    if (d.flagShadows       ?? cfg.mapFlagShadows)       renderFlags |= Renderer.RenderFlags.FlagShadows;
    if (d.flagLabels        ?? cfg.mapFlagLabels)        renderFlags |= Renderer.RenderFlags.FlagUseLabels;
    if (d.flagShadingLambertian ?? cfg.mapShadingLambertian) renderFlags |= Renderer.RenderFlags.FlagShadingLambertian;
    if (d.flagShadingSlope  ?? cfg.mapShadingSlope)      renderFlags |= Renderer.RenderFlags.FlagShadingSlope;
    if (d.flagShadingAspect ?? cfg.mapShadingAspect)     renderFlags |= Renderer.RenderFlags.FlagShadingAspect;

    data.renderFlags = Renderer.encodeRenderFlags(renderFlags);

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
        shadingParams:  272,        // 68
        virtualEye:     288,        // 72
        virtualEyeToCenter: 300,    // 75
        clipParams:     304         // 76
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
    f32.set(data.shadingParams,         OFF.shadingParams / 4);
    f32.set(data.virtualEye,            OFF.virtualEye / 4);
    f32.set(data.virtualEyeToCenter,    OFF.virtualEyeToCenter / 4);
    f32.set(data.clipParams,            OFF.clipParams / 4);

    // write ints for ivec4
    const ri = OFF.renderFlags / 4;
    i32[ri + 0] = data.renderFlags[0];
    i32[ri + 1] = data.renderFlags[1];

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
            view2ecef as math.mat4);
    }

}

drawBackground() {

    let atmosphere = this.core.map.atmosphere;

    if (atmosphere && atmosphere.isReady()) {

            let [_, clip2ecef, eyePos] = this.calcEcefCamParams();
            atmosphere.drawBackground(eyePos, clip2ecef);
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

    switch (this.illumination.light.type) {

    case 'tracking':
        // vectorVC is initialized once in setIllumination().
        this.illumination.vectorNED = IlluminationMath.lned2ned(
            this.illumination.authoredVector, position);
        break;

    case 'geographic':
        // vectorNED is initialized once in setIllumination().
        this.illumination.vectorVC = IlluminationMath.ned2vc(
            this.illumination.authoredVector, position);
        break;
    }
}

visibleScale(): Readonly<Size2> {
    // TODO: make this configurable, return [1, 1] as default
    return this.visibleScale_;
}

updateSizeIfNeeded(): boolean {

    if (this.killed) {
        return false;
    }

    const nextSizes = this.calculateSizes();
    const changed =
        this.canvasCssSize[0] !== nextSizes.cssSize[0] ||
        this.canvasCssSize[1] !== nextSizes.cssSize[1] ||
        this.pixelSize[0] !== nextSizes.pixelSize[0] ||
        this.pixelSize[1] !== nextSizes.pixelSize[1] ||
        this.visibleScale_[0] !== nextSizes.visibleScale[0] ||
        this.visibleScale_[1] !== nextSizes.visibleScale[1];

    if (!changed) {
        return false;
    }

    this.applyCanvasState(nextSizes);
    this.syncCanvas();
    this.syncCanvasRenderTarget();

    if (this.gpu.currentRenderTarget.kind === 'canvas') {
        this.gpu.setRenderTarget(this.gpu.canvasRenderTarget);
        this.updateLogicalSize(this.gpu.canvasRenderTarget.logicalSize);
    }

    return true;
}

private updateLogicalSize(size: Readonly<Size2>) {

    let [width, height] = size;

    this.camera.setAspect(width / height);

    var m = new Float32Array(16);

    // the matrix is a column-major
    m[0] = 2.0/width; m[1] = 0; m[2] = 0; m[3] = 0;
    m[4] = 0; m[5] = -2.0/height; m[6] = 0; m[7] = 0;
    m[8] = 0; m[9] = 0; m[10] = 1; m[11] = 0;
    m[12] = -width*0.5*m[0]; m[13] = -height*0.5*m[5]; m[14] = 0; m[15] = 1;

    this.imageProjectionMatrix = m;
}

private syncCanvas() {

    this.gpu.resizeCanvas(this.canvasCssSize, this.pixelSize);
}

private syncCanvasRenderTarget() {

    this.gpu.canvasRenderTarget = {
        kind: 'canvas',
        viewportSize: [...this.pixelSize],
        logicalSize: [...this.canvasCssSize]
    };
}

private createFramebufferRenderTarget(
    texture: GpuTexture,
    viewportSize: Readonly<Size2>,
    logicalSize: Readonly<Size2> = viewportSize
): GpuDevice.RenderTarget {

    return {
        kind: 'framebuffer',
        texture,
        viewportSize: [...viewportSize],
        logicalSize: [...logicalSize]
    };
}


project2(
    point: math.vec3, mvp: math.mat4,
    cameraPos: math.vec3 | null | undefined,
    includeDistance: boolean = false,
) {
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
    return !! this.illumination && this.illumination.useLighting;
};

setIllumination(definition: Renderer.IlluminationDef) {

    if (!definition.light || typeof definition.light !== 'object') {
        throw new Error('Light missing, or invalid.');
    }

    let light = definition.light;
    let type: 'tracking' | 'geographic';
    let azimuth: number;
    let elevation: number;
    let specularColor: math.vec3;
    let diffuseColor: math.vec3;

    if (Array.isArray(light)) {

        // legacy format: [type, azimuth, elevation]
        if (light[0] != 'tracking') {
            throw new Error(
                'Legacy tuple lights support only the tracking type.');
        }

        type = 'tracking';
        azimuth = utils.validateNumber(light[1], 0, 360, 315);
        elevation = utils.validateNumber(light[2], 0, 90, 45);
        specularColor = [0.6, 0.6, 0.5];
        diffuseColor = [1.0, 1.0, 1.0];

    } else {

        // new format: { type, azimuth, elevation, diffuseColor, specularColor }
        if (light.type != 'tracking' && light.type != 'geographic') {
            throw new Error('Unsupported light type.');
        }

        type = light.type;
        azimuth = utils.validateNumber(light.azimuth, 0, 360, 315);
        elevation = utils.validateNumber(light.elevation, 0, 90, 45);
        specularColor = utils.validateNumberArray(
            light.specularColor, 3,
            [0, 0, 0], [255, 255, 255],
            [153, 153, 128]).map(v => v / 255) as math.vec3;
        diffuseColor = utils.validateNumberArray(
            light.diffuseColor, 3,
            [0, 0, 0], [255, 255, 255],
            [255, 255, 255]).map(v => v / 255) as math.vec3;
    }

    let useLighting = definition.useLighting ?? true;

    this.illumination = {
        ambientCoef: utils.validateNumber(
            definition.ambientCoef, 0.0, 1.0, 0.3),
        light: {
            type,
            azimuth,
            elevation,
            specularColor,
            diffuseColor
        },
        shadingLambertianWeight: utils.validateNumber(
            definition.shadingLambertianWeight, 0.0, 1.0, 0.75),
        shadingSlopeWeight: utils.validateNumber(
            definition.shadingSlopeWeight, 0.0, 1.0, 0.25),
        shadingAspectWeight: utils.validateNumber(
            definition.shadingAspectWeight, 0.0, 1.0, 0.25),
        authoredVector: [0, 0, 0],
        vectorVC: [0, 0, 0],
        vectorNED: [0, 0, 0],

        useLighting: !! useLighting
    }

    if (type === 'tracking') {

        this.illumination.authoredVector = IlluminationMath.illuminationVector(
            azimuth,
            elevation,
            IlluminationMath.CoordSystem.LNED);

        let authored = this.illumination.authoredVector;
        this.illumination.vectorVC = [authored[1], -authored[2], -authored[0]];
    }

    if (type === 'geographic') {

        this.illumination.authoredVector = IlluminationMath.illuminationVector(
            azimuth,
            elevation,
            IlluminationMath.CoordSystem.NED);
        this.illumination.vectorNED = [...this.illumination.authoredVector];
    }

    if (this.core.map?.position) {

        this.updateIllumination(this.core.map.position);
    }

    this.core.map?.markDirty();

    //__DEV__ && console.log("Illumination: ", this.illumination);
};


getIllumination(): Renderer.IlluminationDef | null {

    if (!this.illumination) {
        return null;
    }

    const illumination = this.illumination;

    return {
        useLighting: illumination.useLighting,
        light: {
            type: illumination.light.type,
            azimuth: illumination.light.azimuth,
            elevation: illumination.light.elevation,
            specularColor: illumination.light.specularColor.map(
                (v: number) => v * 255) as [number, number, number],
            diffuseColor: illumination.light.diffuseColor.map(
                (v: number) => v * 255) as [number, number, number]
        },
        ambientCoef: illumination.ambientCoef,
        shadingLambertianWeight: illumination.shadingLambertianWeight,
        shadingSlopeWeight: illumination.shadingSlopeWeight,
        shadingAspectWeight: illumination.shadingAspectWeight
    };
};


setRenderingOptions(options: Renderer.RenderingOptions) {

    const d = this.debug;

    if (options.useNormalMaps !== undefined)
        d.flagNormalMaps = options.useNormalMaps;

    if (options.useDiffuseMaps !== undefined)
        d.flagDiffuseMaps = options.useDiffuseMaps;

    if (options.useSpecularMaps !== undefined)
        d.flagSpecularMaps = options.useSpecularMaps;

    if (options.useBumpMaps !== undefined)
        d.flagBumpMaps = options.useBumpMaps;

    if (options.useAtmosphere !== undefined)
        d.flagAtmosphere = options.useAtmosphere;

    if (options.useShadows !== undefined)
        d.flagShadows = options.useShadows;

    if (options.useLabels !== undefined)
        d.flagLabels = options.useLabels;

    if (options.useShadingLambertian !== undefined)
        d.flagShadingLambertian = options.useShadingLambertian;

    if (options.useShadingSlope !== undefined)
        d.flagShadingSlope = options.useShadingSlope;

    if (options.useShadingAspect !== undefined)
        d.flagShadingAspect = options.useShadingAspect;

    this.core.map?.markDirty();

};


getRenderingOptions(): Renderer.RenderingOptions {

    const d = this.debug;
    const cfg = this.core.map?.config ?? this.config;

    return {
        useLighting:
            (d.flagLighting ?? cfg.mapFlagLighting)
            && this.getIlluminationState(),
        useNormalMaps:
            d.flagNormalMaps ?? cfg.mapFlagNormalMaps,
        useDiffuseMaps:
            d.flagDiffuseMaps ?? cfg.mapFlagDiffuseMaps,
        useSpecularMaps:
            d.flagSpecularMaps ?? cfg.mapFlagSpecularMaps,
        useBumpMaps:
            d.flagBumpMaps ?? cfg.mapFlagBumpMaps,
        useAtmosphere:
            d.flagAtmosphere ?? cfg.mapFlagAtmosphere,
        useShadows:
            d.flagShadows ?? cfg.mapFlagShadows,
        useLabels:
            d.flagLabels ?? cfg.mapFlagLabels,
        useShadingLambertian:
            d.flagShadingLambertian ?? cfg.mapShadingLambertian,
        useShadingSlope:
            d.flagShadingSlope ?? cfg.mapShadingSlope,
        useShadingAspect:
            d.flagShadingAspect ?? cfg.mapShadingAspect
    };
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

    if (!this.illumination)
        throw Error('illumination ambient coef requested, but no illumination defined.');   

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

/**
 * @deprecated Use {@link setVerticalExaggeration} instead.
 *   Kept for mapConfig-based map compatibility.
 */
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

            delete this.seHeightRamp;
        }

        // viewExtentProgression
        if (seDefinition.viewExtentProgression
            && Array.isArray(seDefinition.viewExtentProgression)) {

            this.setVeScaleRampFromProgression(
                seDefinition.viewExtentProgression);

        } else {

            delete this.veScaleRamp;
        }

        return;
    }

    throw new Error("Unsupported super elevation option.");
}

/**
 * Set vertical exaggeration using the new cartographic interface.
 *
 * @param spec - elevation and/or scale-denominator ramp pivots;
 *   see {@link Renderer.VerticalExaggerationSpec}
 */
setVerticalExaggeration(spec: Renderer.VerticalExaggerationSpec) {

    if (spec.elevationRamp) {

        const { min, max } = spec.elevationRamp;
        this.setSuperElevationRamp([[min[0], max[0]], [min[1], max[1]]]);

    } else {

        delete this.seHeightRamp;
    }

    if (spec.scaleRamp) {

        const { min, max } = spec.scaleRamp;
        this.veScaleRamp = this.makeVeScaleRamp(
            min[0], min[1], max[0], max[1]);

    } else {

        delete this.veScaleRamp;
    }

    this.useSuperElevation = true;
    this.seCounter++;
    this.core.map?.markDirty();
}


getVerticalExaggeration(): Renderer.VerticalExaggerationSpec {

    const spec: Renderer.VerticalExaggerationSpec = {};

    if (this.seHeightRamp) {

        spec.elevationRamp = {
            min: [this.seHeightRamp[0], this.seHeightRamp[1]],
            max: [this.seHeightRamp[2], this.seHeightRamp[3]]
        };
    }

    if (this.veScaleRamp) {

        spec.scaleRamp = {
            min: [this.veScaleRamp.sd0, this.veScaleRamp.va0],
            max: [this.veScaleRamp.sd1, this.veScaleRamp.va1]
        };
    }

    return spec;
}

/**
 * @deprecated Use {@link setVerticalExaggeration} instead.
 *   Converts a legacy `viewExtentProgression` spec to a {@link VeScaleRamp}
 *   using a canonical canvas height of 1113 CSS px for a 1:1 behavioural match.
 */
private setVeScaleRampFromProgression(progression: SeProgressionDef) {

    if (!(progression && progression[0] && progression[1] && progression[3]
            && progression[3] && progression[4])) {
        throw new Error("Unsupported super elevation option.");
    }

    const cssDpi = (this.config.rendererCssDpi as number | undefined) ?? 96;
    const canonicalH = 1113; // CSS px — matches legacy tuning baseline
    const toSd = (ext: number) => ext / (canonicalH / cssDpi * 0.0254);

    const baseValue  = progression[0];
    const baseExtent = progression[1];
    const exponent   = Math.log2(progression[2]);
    const min        = progression[3];
    const max        = progression[4];

    // Invert the old formula: extent at which old VA equals `va`
    const extfromva = (va: number) =>
        Math.pow(va / baseValue, 1 / exponent) * baseExtent;

    this.veScaleRamp = this.makeVeScaleRamp(
        toSd(extfromva(min)), min,
        toSd(extfromva(max)), max
    );

    this.useSuperElevation = true;
}

/**
 * Return the current map scale denominator computed from the given
 * view extent and the current canvas dimensions.
 *
 * @param extent - view extent in map units (metres)
 */
getScaleDenominator(extent: number): number {

    return this.currentScaleDenominator(extent);
}

setConfigParams(params: Record<string, unknown>) {

    if (!params || typeof params !== 'object') {
        return;
    }

    for (const [key, value] of Object.entries(params)) {
        this.setConfigParam(key, value);
    }
}

setConfigParam(key: string, value: unknown) {

    this.core.setRendererConfigParam(key, value);
    this.core.map?.markDirty();
}

getConfigParam(key: string) {

    return this.core.getRendererConfigParam(key);
}

/** Compute scale denominator from a view extent value. */
private currentScaleDenominator(extent: number): number {

    const cssDpi = (this.config.rendererCssDpi as number | undefined) ?? 96;
    return extent / (this.mainViewportCssH / cssDpi * 0.0254);
}

/** Build a VeScaleRamp from two pivot pairs, precomputing the exponent. */
private makeVeScaleRamp(
    sd0: number, va0: number,
    sd1: number, va1: number
): VeScaleRamp {

    return {
        sd0, va0, sd1, va1,
        exponent: Math.log(va1 / va0) / Math.log(sd1 / sd0)
    };
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

getVeScaleFactor(position: MapPosition | number) {

    if (arguments.length !== 1)
        throw new Error('function now requires current position');

    if (!this.veScaleRamp) return 1.0;

    const extent = typeof position === 'number'
        ? position : position.pos[8];
    const r = this.veScaleRamp;
    const sd = this.currentScaleDenominator(extent);
    const clamped = math.clamp(sd, r.sd0, r.sd1);
    return r.va0 * Math.pow(clamped / r.sd0, r.exponent);
}


/**
 * @param position current map position, or a vertical extent value
 *   directly (the value normally sourced from `position.pos[8]`)
 * @returns a tuple of 7 numbers describing the vertical exaggeration.
 *   If the original ramp spec was [h1, h2, f1, f2], the returned
 *   value is something like:
 *   [h1, f1, h2, f2, h2-h1, f2-f1, 1.0 / (h2-h1)]
 */
getSuperElevation(position: MapPosition | number) : SeRamp {

    if (arguments.length !== 1) {
        throw new Error('Function now requires current position.');
    }

    let retval: number[];

    // heightRamp
    if (this.seHeightRamp) {
        retval = this.seHeightRamp.slice();
    } else {
        retval = [0, 1, 1000, 1, 1000, 0, 1.0 / 1000];
    }

    // progression
    if (this.veScaleRamp) {
        retval[1] *= this.getVeScaleFactor(position);
        retval[3] *= this.getVeScaleFactor(position);

        retval[5] = retval[3] - retval[1];
    }

    return retval as SeRamp;
};


getSuperElevatedHeight(height: number, position: MapPosition | number) {

    if (arguments.length !== 2) {
        throw new Error('Function now requires current position.');
    }

    let retval: number;

    // heightRamp
    if (this.seHeightRamp) {
        retval = this.getSuperElevatedHeightRamp(height);
    } else {
        retval = height;
    }

    // progression
    if (this.veScaleRamp) {
        retval *= this.getVeScaleFactor(position);
    }

    return retval;
}

getSuperElevatedHeightRamp(height: number) {

    let se = this.seHeightRamp, h = height;
    if (!se) throw new Error('No super elevation ramp defined.');

    if (h < se[0]) {  // 0 - h1, 1 - f1, 2 - h2, 3 - f2, 4 - dh, 5 - df, 6 - invdh
        h = se[0];
    }

    if (h > se[2]) {
        h = se[2];
    }

    return height * (se[1] + ((h - se[0]) * se[6]) * se[5]);
};

getUnsuperElevatedHeight(height: number, position: any) {

    if (arguments.length !== 2) {
        throw new Error('Function now requires current position.');
    }

    let retval: number;

    // heightRamp
    if (this.seHeightRamp) {
        retval = this.getUnsuperElevatedHeightRamp(height);
    } else {
        retval = height;
    }

    // progression
    if (this.veScaleRamp) {
        retval /= this.getVeScaleFactor(position);
    }

    return retval;
}


getUnsuperElevatedHeightRamp(height: number) {
    let se = this.seHeightRamp, s = height;
    if (!se) throw new Error('No super elevation ramp defined.');

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


/*getEllipsoidHeight(pos, shift) {
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
};*/


transformPointBySE(
    pos: math.vec3, shift: math.vec3 | null | undefined,
    position: MapPosition | number,
) {
    if (arguments.length !== 3)
        throw new Error('function now requires current position');

    var p = pos, p2: number[];
    this.seTmpVec3 = [0,0,0];

    if (shift) {
        p2 = [pos[0] + shift[0], pos[1] + shift[1],
              (pos[2] + shift[2]) * this.earthERatio!];
    } else {
        p2 = [p[0], p[1], p[2] * this.earthERatio!];
    }

    var l = Math.sqrt(p2[0] * p2[0] + p2[1] * p2[1] + p2[2] * p2[2]);
    var v = this.seTmpVec2;

    var m = (1.0/(l+0.0001));
    v[0] = p2[0] * m;
    v[1] = p2[1] * m;
    v[2] = p2[2] * m;

    var h = l - this.earthRadius!;
    var h2 = this.getSuperElevatedHeight(h, position);
    m = (h2 - h);

    p2[0] = p[0] + v[0] * m;
    p2[1] = p[1] + v[1] * m;
    p2[2] = p[2] + v[2] * m;

    return p2;
};


transformPointBySE2(
    pos: number[], shift: math.vec3 | null | undefined,
    position: MapPosition | number,
) {
    if (arguments.length !== 3)
        throw new Error('function now requires current position');

    var p = pos, p2: number[];
    this.seTmpVec3 = [0,0,0];

    if (shift) {
        p2 = [pos[0] + shift[0], pos[1] + shift[1],
              (pos[2] + shift[2]) * this.earthERatio!];
    } else {
        p2 = [p[0], p[1], p[2] * this.earthERatio!];
    }

    var l = Math.sqrt(p2[0] * p2[0] + p2[1] * p2[1] + p2[2] * p2[2]);
    var v = this.seTmpVec2;

    var m = (1.0/(l+0.0001));
    v[0] = p2[0] * m;
    v[1] = p2[1] * m;
    v[2] = p2[2] * m;

    var h = l - this.earthRadius!;
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


getScreenRay(screenX: number, screenY: number) {
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


hitTestGeoLayers(screenX: number, screenY: number, secondTexture: boolean) {

    var surfaceHit = false, pixel: Uint8Array = new Uint8Array(4);

    if (screenX >= 0 && screenX < this.curSize[0] &&
        screenY >= 0 && screenY < this.curSize[1]) {

        //convert screen coords to texture coords
        var x = 0, y = 0;

        //get screen coords
        x = Math.floor(screenX * (this.hitmapSize / this.curSize[0]));
        y = Math.floor(screenY * (this.hitmapSize / this.curSize[1]));

        //get pixel value from framebuffer

        if (secondTexture) {
            pixel = this.geoHitmapTexture2!.readFramebufferPixels(
                x, this.hitmapSize - y - 1, 1, 1);
        } else {
            pixel = this.geoHitmapTexture!.readFramebufferPixels(
                x, this.hitmapSize - y - 1, 1, 1);
        }

        surfaceHit = !(pixel[0] == 255 && pixel[1] == 255 && pixel[2] == 255 && pixel[3] == 255);
    }

    if (surfaceHit) {
        return [true, pixel[0], pixel[1], pixel[2], pixel[3]];
    } 

    return [false, 0,0,0,0];
};


switchToFramebuffer(
    type: 'base' | 'depth' | 'geo' | 'geo2',
) {
    var gl = this.gpu.gl, size;
    
    switch(type) {
    case 'base':
        this.applyCanvasState(this.calculateSizes());
        this.syncCanvas();
        this.syncCanvasRenderTarget();

        gl.clearColor(0.0, 0.0, 0.0, 1.0);

        this.gpu.setRenderTarget(this.gpu.canvasRenderTarget);
        this.updateLogicalSize(this.gpu.canvasRenderTarget.logicalSize);
        this.camera.update();
        this.onlyDepth = false;
        this.onlyHitLayers = false;
        this.onlyAdvancedHitLayers = false;
        this.advancedPassNeeded = false;
        break;

    case 'depth':
        gl.clearColor(1.0,1.0, 1.0, 1.0);
        gl.enable(gl.DEPTH_TEST);

        size = this.hitmapSize;

        const depthTarget = this.createFramebufferRenderTarget(
            this.hitmapTexture!, [size, size]
        );
        this.gpu.setRenderTarget(depthTarget);
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

        // The depth and geodata hitmaps are auxiliary buffers for the
        // current screen view. Their square texture size is storage
        // resolution, not camera aspect. The base pass owns
        // `updateLogicalSize()` so these buffers keep the screen camera.
        this.camera.update();
        this.onlyDepth = true;
        this.onlyHitLayers = false;
        this.onlyAdvancedHitLayers = false;
        this.advancedPassNeeded = false;
        break;

    case 'geo':
    case 'geo2':
        this.hoverFeatureCounter = 0;
        size = this.hitmapSize;

        gl.clearColor(1.0, 1.0, 1.0, 1.0);
        gl.enable(gl.DEPTH_TEST);

        const geoTarget = this.createFramebufferRenderTarget(
            (type == 'geo' ? this.geoHitmapTexture : this.geoHitmapTexture2)!,
            [size, size]
        );
        this.gpu.setRenderTarget(geoTarget);
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

        this.onlyHitLayers = true;
        this.advancedPassNeeded = false;
        this.onlyAdvancedHitLayers = (type == 'geo2');
        this.camera.update();
        break;

    }
};


hitTest(screenX: number, screenY: number) {

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
    const hitmapTexture = this.hitmapTexture;
    if (!hitmapTexture) {
        return [0, 0, 0, false, screenRay, Number.MAX_VALUE, cameraPos];
    }

    var pixel = hitmapTexture.readFramebufferPixels(
        x, this.hitmapSize - y - 1, 1, 1);

    //convert rgb values into depth
    var depth = (pixel[0] * (1.0/255)) + (pixel[1]) + (pixel[2]*255.0) + (pixel[3]*65025.0);// + (pixel[3]*16581375.0);

    var surfaceHit = !(pixel[0] == 255 && pixel[1] == 255 && pixel[2] == 255 && pixel[3] == 255);

    //compute hit postion
    this.lastHitPosition = [cameraPos[0] + screenRay[0]*depth, cameraPos[1] + screenRay[1]*depth, cameraPos[2] + screenRay[2]*depth];

    return [this.lastHitPosition[0], this.lastHitPosition[1], this.lastHitPosition[2], surfaceHit, screenRay, depth, cameraPos];
};


copyHitmap() {

    const hitmapTexture = this.hitmapTexture;
    const hitmapData = this.hitmapData ?? undefined;

    if (!hitmapTexture) {
        return;
    }

    hitmapTexture.readFramebufferPixels(
        0, 0, this.hitmapSize, this.hitmapSize, hitmapData
    );
};


getDepth(screenX: number, screenY: number, dilate: number = 0) {

    var x = Math.floor(screenX * (this.hitmapSize / this.curSize[0]));
    var y = Math.floor(screenY * (this.hitmapSize / this.curSize[1]));

    var depth: number;


    if (this.hitmapMode <= 2) {

        //get pixel value from framebuffer
        const hitmapTexture = this.hitmapTexture;
        if (!hitmapTexture) {
            return [false, Number.POSITIVE_INFINITY];
        }

        var pixel = hitmapTexture.readFramebufferPixels(
            x, this.hitmapSize - y - 1, 1, 1);

        //convert rgb values into depth
        depth = (pixel[0] * (1.0/255)) + (pixel[1]) + (pixel[2]*255.0) + (pixel[3]*65025.0);
        var surfaceHit = !(pixel[0] == 255 && pixel[1] == 255 && pixel[2] == 255 && pixel[3] == 255);

     } else {

        // CPU-cached path; allow small dilation, if configured to catch near-occlusions (in pixels)
        var pixels = this.hitmapData;
        if (!pixels) {
            return [false, Number.POSITIVE_INFINITY];
        }
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


getZoffsetFactor(params: ArrayLike<number>) {
    return (params[0] + params[1]*this.distanceFactor + params[2]*this.tiltFactor)*0.0001;
};


saveScreenshot(output: string, filename: string, filetype: string) {
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
    if (!context) {
        throw new Error('Unable to create 2D canvas context for screenshot.');
    }

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


getBitmap(
    url: string, filter: GpuTexture.Filter, tiled: boolean,
    hash: string, useHash: boolean,
) {
    var id = (useHash ? hash : url) + '*' + filter + '*' + tiled;

    var texture = this.bitmaps[id];
    if (!texture && url) {
        texture = new GpuTexture(
            this.gpu, url, this.core, null, undefined, tiled, filter);
        this.bitmaps[id] = texture;
    }

    return texture;
};


getFont(url: string) {
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
    [key: string]: boolean | number | string | number[] | undefined;
    rendererAllowScreenshots?: boolean;
    rendererAntialiasing?: boolean;
    rendererAnisotropic?: number;
    mapShadingLambertian?: boolean;
    mapShadingSlope?: boolean;
    mapShadingAspect?: boolean;
    mapFlagLighting?: boolean;
    mapFlagNormalMaps?: boolean;
    mapFlagDiffuseMaps?: boolean;
    mapFlagSpecularMaps?: boolean;
    mapFlagBumpMaps?: boolean;
    mapFlagAtmosphere?: boolean;
    mapFlagShadows?: boolean;
    mapFlagLabels?: boolean;
    mapDMapSize?: number;
    mapDMapMode?: number;
    mapDMapCopyIntervalMs?: number;
    mapSplitMargin?: number;
    mapLabelFreeMargins?: [number, number, number, number];
    rendererCssDpi?: number;
}

type Size2 = [ number, number ];

type VeScaleRamp = {

    // scale denominator at lower pivot
    sd0: number;

    // VA factor at lower pivot
    va0: number;

    // scale denominator at upper pivot
    sd1: number;

    // VA factor at upper pivot
    va1: number;

    // log(va1/va0)/log(sd1/sd0), precomputed
    exponent: number;
}

type SeRamp =
    [number, number, number, number, number, number, number];

/** @deprecated Part of the legacy superelevation API. */
type SeProgressionDef = [number, number, number, number, number];

/** @deprecated Part of the legacy superelevation API. */
type SeRampDef = [[number, number], [number, number]];


type Illumination = {

    // the normalized style-facing definition
    light: {
        type: 'tracking' | 'geographic';
        azimuth: number;
        elevation: number;
        specularColor: math.vec3;
        diffuseColor: math.vec3;
    };

    // the authored light vector in the coordinate system implied by the type
    authoredVector: math.vec3;

    // runtime vectors updated from the current map position
    vectorVC: math.vec3;
    vectorNED: math.vec3;

    ambientCoef: number;
    shadingLambertianWeight: number;
    shadingSlopeWeight: number;
    shadingAspectWeight: number;

    useLighting: boolean;
}

type Core = {

    map: Map;
    contextLost: boolean;

    callListener(name: string, event: any, log?: boolean): void;
    setRendererConfigParam(key: string, value: unknown): void;
    getRendererConfigParam(key: string): unknown;

}

type Map = {

    body: MapBody;
    atmosphere?: Atmosphere;
    position: MapPosition;
    camera: MapCamera;

    getPhysicalSrs(): MapSrs;
    markDirty(): void;

    config: Config;
}

/** Fixed texture indices - the actual index is computed as
  * Idx % gl.MAX_TEXTURE_IMAGE_UNITS
  */

enum TextureIdxOffsets {

    Atmosphere = -1
}

const UboFrameSize = 320;

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
    FlagShadows            = 1 << 6, // bit 6
    FlagUseLabels      = 1 << 7, // bit 7
    FlagShadingLambertian  = 1 << 8, // bit 8
    FlagShadingSlope       = 1 << 9, // bit 9
    FlagShadingAspect      = 1 << 10, // bit 10
    FlagAll            = 0xffff
}

/** Encode a RenderFlags value into the ivec4 format used by frame and layer UBOs.
 *  Returns [low byte, high byte, 0, 0] matching the GLSL decode: x | (y << 8). */
export function encodeRenderFlags(flags: RenderFlags): [number, number, number, number] {
    return [flags & 0xff, (flags >> 8) & 0xff, 0, 0];
}

/** Per-frame debug overrides for the renderer. Exported from the namespace
 *  only so the Renderer class can use it as a member type; treat as internal.
 *  Flag fields are optional: undefined means "fall back to the config default". */
export type Debug = {
    // render flag overrides (undefined = use config default)
    flagLighting?: boolean;
    flagNormalMaps?: boolean;
    flagDiffuseMaps?: boolean;
    flagSpecularMaps?: boolean;
    flagBumpMaps?: boolean;
    flagAtmosphere?: boolean;
    flagShadows?: boolean;
    flagLabels?: boolean;
    flagShadingLambertian?: boolean;
    flagShadingSlope?: boolean;
    flagShadingAspect?: boolean;
    // fields from MapDraw.debug read by the renderer
    shaderIllumination?: boolean; // TODO: remove when legacy draw path is retired
    drawFog?: boolean;
    drawWireframe?: number;
    heightmapOnly?: boolean;
    drawBBoxes?: boolean;
    drawNBBoxes?: boolean;
    drawEarth?: boolean;
    drawLabelBoxes?: boolean;
    drawGridCells?: boolean;
    drawAllLabels?: boolean;
    drawHiddenLabels?: boolean;
    meshStats?: boolean;
    maxZoom?: boolean;
    drawTestData?: number;
    [key: string]: boolean | number | undefined;
}

export type CanvasState = {
    cssSize: Size2;
    pixelSize: Size2;
    visibleScale: Size2;
}

/**
 * Input/output type for `setIllumination` / `getIllumination`.
 *
 * Colour values (`specularColor`, `diffuseColor`) are in the 0–255
 * integer range, consistent with colour properties elsewhere in the
 * style spec (e.g. `label-color`). The renderer converts them to
 * 0–1 internally.
 *
 * Combined diffuse shading is a weighted geometric mean of up to three
 * methods — Lambertian, slope, and aspect — controlled by the
 * corresponding weight fields. Weights are independent of the enable
 * flags (`mapShadingLambertian` etc.), which are config-level concerns.
 *
 * The legacy tuple form of `light` (`['tracking', azimuth, elevation]`)
 * is still accepted by `setIllumination` but is never returned by
 * `getIllumination`.
 */
export type IlluminationDef = {

    light:
        | ['tracking', number, number]
        | {
            type: 'tracking' | 'geographic';
            azimuth: number;
            elevation: number;
            /** Diffuse light colour, 0–255 per channel. */
            diffuseColor?: [number, number, number];
            /** Specular highlight colour, 0–255 per channel. */
            specularColor?: [number, number, number];
        };

    useLighting?: boolean;

    ambientCoef?: number;
    shadingLambertianWeight?: number;
    shadingSlopeWeight?: number;
    shadingAspectWeight?: number;
}

export type RenderingOptions = {
    useLighting?:          boolean;
    useNormalMaps?:        boolean;
    useDiffuseMaps?:       boolean;
    useSpecularMaps?:      boolean;
    useBumpMaps?:          boolean;
    useAtmosphere?:        boolean;
    useShadows?:           boolean;
    useLabels?:            boolean;
    useShadingLambertian?: boolean;
    useShadingSlope?:      boolean;
    useShadingAspect?:     boolean;
}

/**
 * @deprecated Use {@link VerticalExaggerationSpec} instead.
 *   Kept for mapConfig-based map compatibility.
 */
export type SeDefinition = SeRampDef | {
    heightRamp?: SeRampDef;
    viewExtentProgression?: SeProgressionDef;
}

export type VerticalExaggerationSpec = {
    elevationRamp?: {
        min: [number, number];
        max: [number, number];
    };
    scaleRamp?: {
        min: [number, number];
        max: [number, number];
    };
}


/* Uniform buffer object binding points. */

export enum UniformBlockName {

    Frame = 0,
    Layers = 1,
    Atmosphere = 2
}

} // export namespace Rendrer


export default Renderer;
