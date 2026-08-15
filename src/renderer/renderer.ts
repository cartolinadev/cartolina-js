/*
 * renderer.ts — WebGL2 graphics class
 */

import {vec3, mat4} from '../utils/matrix';
import * as math from '../utils/math';
import * as utils from '../utils/utils';
import GpuDevice from './gpu/device';
import GpuProgram from './gpu/program';
import GpuTexture from './gpu/texture';
import GpuFont from './gpu/font';
import Camera from './camera';
import RenderInit from './init';
import RenderDraw from './draw';
import RendererRMap from './rmap';

import * as IlluminationMath from '../map/illumination';
import MapPosition from '../map/position';
import { defaultOverrides, type Overrides } from '../map/overrides';
import type * as viewerConfig from '../viewer-config';
import type Map from '../map/map';
import { TextureBlend } from './textureblend';

import shaderTileVert from './shaders/tile.vert.glsl';
import shaderTileFrag from './shaders/tile.frag.glsl';

import backgroundTileVert from './shaders/background.vert.glsl';
import backgroundTileFrag from './shaders/background.frag.glsl';

import shaderTileDepthVert from './shaders/tile-depth.vert.glsl';
import shaderTileDepthFrag from './shaders/tile-depth.frag.glsl';

import shaderTileMaskFootprintVert from
    './shaders/tile-mask-footprint.vert.glsl';
import shaderTileMaskFootprintFrag from
    './shaders/tile-mask-footprint.frag.glsl';
import shaderTileMaskBlitVert from './shaders/tile-mask-blit.vert.glsl';
import shaderTileMaskBlitFrag from './shaders/tile-mask-blit.frag.glsl';
import shaderTileMaskErodeFrag from './shaders/tile-mask-erode.frag.glsl';

import shaderFrustumVert from './shaders/frustum.vert.glsl';
import shaderFrustumFrag from './shaders/frustum.frag.glsl';

/**
 * The WebGL2 renderer. It sits below `Map` in the ownership chain.
 * It holds the GL context, render targets, and
 * shader programs and issues all GPU draw calls. Map code decides
 * what to draw; this class carries out the GPU work.
 *
 * - It is the draw surface exposed to custom overlay callbacks:
 *   `drawImage`, `drawLineString`, `createTexture`, `getCanvasSize`.
 *
 * - It holds a collection of compiled GPU programs and GPU texture
 *   objects.
 *
 * - It provides a per-frame uniform buffer object (`uboFrame`) with
 *   view and projection matrices and a method for per-frame updates.
 *   Indirectly, it does the same for the atmosphere UBO (`uboAtm`),
 *   which passes parameters for physical atmosphere to the shaders.
 *
 * - It keeps track of scene illumination and provides a public API
 *   to deliver the illumination vector in camera space.
 *
 * - It keeps track of vertical exaggeration (superelevation)
 *   configuration and provides methods for applying superelevation.
 *
 * - It holds a depth map of the scene (`hitmapTexture`) — an
 *   off-screen framebuffer rendered when depth info is requested.
 *
 * - It also holds geodata hitmaps (`geoHitmapTexture`,
 *   `geoHitmapTexture2`) where each pixel records which geodata
 *   feature is at that screen position.
 *
 * - It maintains an image projection matrix used as the 2D
 *   projection in various shaders, rebuilt from the canvas logical
 *   size on each base pass via `setProjection()`.
 *
 * Many legacy auxiliary classes (`init`, `draw`, `rmap`) and legacy geodata
 * drawing code reach directly into its fields. These are legacy
 * access patterns, not part of the intended interface.
 */

export class Renderer {

    config: Readonly<viewerConfig.ViewerConfig>;
    /**
     * The typed `Map` that owns this renderer. Legacy JavaScript
     * modules reach it as `renderer.map` and the loaded legacy map as
     * `renderer.map.legacyMap`.
     */
    map: Map;
    div: HTMLElement;

    marginFlags = 0; // see rmap.js

    uboFrame!: WebGLBuffer;

    // label-free margins on  the map: [top, right, bottom, left]
    labelFreeMargins!: [number, number, number, number];

    /**
     * Return the active renderer margin flags.
     *
     * These flags reserve screen edges for browser UI controls during label
     * placement. The method replaces the removed `RendererInterface` wrapper.
     *
     * @returns margin flag bit mask used by `rmap.js`
     */
    getMarginFlags(): number {

        return this.marginFlags;
    }

    /**
     * Set the active renderer margin flags.
     *
     * Browser UI controls call this when their visibility changes so label
     * placement can avoid occupied screen edges.
     *
     * @param flags margin flag bit mask used by `rmap.js`
     */
    setMarginFlags(flags: number): void {

        this.marginFlags = flags;
    }

    /**
     * Return the visible canvas size in CSS pixels.
     *
     * This replaces the removed `RendererInterface.getCanvasSize`, which
     * returned a copy of the renderer's logical canvas size.
     *
     * @returns `[width, height]` of the active render target
     */
    getCanvasSize(): Size2 {

        const size = this.apparentSize;
        return [size[0], size[1]];
    }

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

    overrides: Overrides = { ...defaultOverrides }

    /** @deprecated Legacy alias for `overrides`. */
    get debug(): Overrides { return this.overrides; }

    geometries = {} // no clue, see legacy geodata geometry lookup

    stencilLineState: Optional<GpuDevice.State> = null;
    backgroundState: Optional<GpuDevice.State> = null;

    geodataSelection: any[] = [];

    hoverFeatureCounter = 0;
    hoverFeatureList: any[] = [];
    hoverFeature: any = null;

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
        tileDiscarding?: GpuProgram
        background?: GpuProgram
        tileDepth?: GpuProgram
        tileMaskFootprint?: GpuProgram
        tileMaskBlit?: GpuProgram
        tileMaskErode?: GpuProgram
        tileMaskRect?: GpuProgram
        frustum?: GpuProgram
    }

    private frustumVao_: Optional<WebGLVertexArrayObject> = null;
    private frustumState_: Optional<GpuDevice.State> = null;

    // texture unit indices
    textureIdxs!: {
        atmosphere: GLenum
        tileMask: GLenum
        maskBlit: GLenum
    }

    // legacy programs
    progText: Optional<GpuProgram> = null;


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
    /**
     * Depth hitmap: off-screen auxiliary texture rendered with
     * `onlyDepth = true`. Each pixel encodes the depth of the closest
     * geometry fragment. Read back by `getDepth` / `getScreenRay` to
     * convert a screen coordinate to a world position.
     */
    hitmapTexture: Optional<GpuTexture> = null;

    /**
     * Geodata hitmap (normal hit layers): off-screen auxiliary texture
     * rendered with `onlyHitLayers = true`. Pixel values encode the
     * identity of the geographic feature at that screen position.
     * Read back by `hitTest` and `hitTestGeoLayers` to answer which
     * vector feature the user is pointing at.
     */
    geoHitmapTexture: Optional<GpuTexture> = null;

    /**
     * Geodata hitmap (advanced hit layers): same purpose as
     * `geoHitmapTexture` but rendered with
     * `onlyAdvancedHitLayers = true` for the second hit-test pass.
     */
    geoHitmapTexture2: Optional<GpuTexture> = null;

    redTexture: Optional<GpuTexture> = null;
    whiteTexture: Optional<GpuTexture> = null;
    blackTexture: Optional<GpuTexture> = null;
    textTexture2: Optional<GpuTexture> = null;

    // meshes
    bboxMesh: Optional<LegacyGpuBBox> = null;
    bboxMesh2: Optional<LegacyGpuBBox> = null;

    // GpuPixelLine3
    plines: any = null;
    plineJoints: any = null; // probably not used, but still initialize by init


    /** copied from config.mapDMapSize. hitmap (depth map) linear size in
     *  pixels. */
    hitmapSize!: number;

    /**
     *  copied from config.mapDMapMode. Governs getDepth behaviour.
     *  0, 1, 2 - readFramebufferPixels for each getDepth call
     *  3 - call copyHitmap once per frame, then sample it per getDepth call (faster)
     */
    hitmapMode!: number;

    /** interval between hitmap updates */
    hitmapCopyIntervalMs!: number;

    updateHitmap = true;
    updateGeoHitmap = true;
    lastHitmapCopyTime = 0;

    rectVerticesBuffer: Optional<WebGLBuffer> = null;
    rectIndicesBuffer: Optional<WebGLBuffer> = null;

    /** col-major projection matrix, used in various shaders. */
    imageProjectionMatrix: Optional<Float32Array> = null;

    fonts: {[key:string] : any} = {};

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
    buffUint32!: Uint32Array;

    bitmaps: { [key: string] : any } = {};  // array of GpuTextures, used from gpugroup and geodata

    cameraPosition = [0,0,0];
    cameraOrientation = [0,0,0];
    cameraTiltFator = 1;
    cameraViewExtent = 1;
    cameraViewExtent2 = 1;
    distanceFactor = 1;
    tiltFactor = 1;
    localViewExtentFactor = 1;
    cameraVector = [0,0,0];
    labelVector = [0,0,0];
    drawnGeodataTiles = 0;
    drawnGeodataTilesFactor = 0;
    drawnGeodataTilesUsed = false;
    debugStr: string | null = null;
    benevolentMargins = false;
    drawHiddenLabels = false;

    gridHmax = 0;
    gridHmin = 0;

    // temporary objects hoisted as class members to reduce garbage collection
    seTmpVec = [0,0,0];
    seTmpVec2 = [0,0,0];
    seTmpVec3 = [0,0,0];

    // hit test
    lastHitPosition = [0,0,100];

    // encapsulated objects
    init : any;
    rmap: any; // RenderRM
    draw: any;
    nmblender!: TextureBlend;

    /** Unsubscribes the renderer-key config watcher on dispose. */
    private unwatchConfig_!: () => void;

    disposed_ = false;


constructor(map: Map, div: HTMLElement, config: Readonly<viewerConfig.ViewerConfig>) {

    this.config = config; // || {};
    this.map = map;
    this.div = div;

    // device
    this.camera = new Camera(this, 45, 2, 1200000.0);

    this.labelFreeMargins = config.mapLabelFreeMargins;
    this.hitmapSize = config.mapDMapSize;
    this.hitmapMode = config.mapDMapMode;
    this.hitmapCopyIntervalMs = config.mapDMapCopyIntervalMs;

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

    this.buffUint32 = new Uint32Array(this.buffFloat32.buffer);

    // device
    this.gpu = new GpuDevice(this, div,
        !! this.config.rendererAllowScreenshots,
        !! this.config.rendererAntialiasing,
        this.config.rendererAnisotropic,
        map.bus);

    const canvasTarget = this.gpu.updateCanvasRenderTarget();
    this.setProjection(canvasTarget.apparentSize);

    // initialize resources
    this.init = new RenderInit(this);
    this.initHitmapTexture();

    this.initTextureIdxs();
    this.programs = {}

    this.nmblender = new TextureBlend(this.gpu.gl, 256, 256);
    this.rmap = new RendererRMap(this, 50);
    this.draw = new RenderDraw(this);

    // rendererCssDpi is read per frame by the scale computations;
    // mapLabelFreeMargins is copied into the renderer field the
    // label passes read. The other renderer keys are fixed at WebGL
    // context or texture creation — see their notes in
    // `ViewerConfig`.
    this.unwatchConfig_ = map.configStore.watch(
        ['rendererCssDpi', 'mapLabelFreeMargins'],
        (values) => {

            this.labelFreeMargins = values.mapLabelFreeMargins;
            this.map.legacyMap?.markDirty();
        },
    );
};


private initHitmapTexture(): void {

    const size = this.hitmapSize;
    const data = new Uint8Array(size * size * 4);

    if (this.hitmapMode > 2) {
        this.hitmapData = data;
    }

    this.hitmapTexture = new GpuTexture(this.gpu, null, null);

    this.hitmapTexture.createFromData(size, size, data,
        GpuTexture.Type.DepthUint);

    this.hitmapTexture.createFramebuffer(size, size);
}


/** Apparent logical size of the active render target: the visible extent
 *  in CSS units after CSS transforms (`cssLayoutSize * cssScale`). Use in
 *  rendering code that must work correctly for any render target:
 *  geometry, label-density calculations, NDC-to-pixel conversions. */
get apparentSize(): Readonly<Size2> {

    return this.gpu.currentRenderTarget.apparentSize;
}

/** @deprecated Use `apparentSize` instead. */
get curSize(): Readonly<Size2> {

    return this.apparentSize;
}


/**
 * Lazy tile program initialization, including binding buffers to block names
 * and fixed samplers.
 */

programTile() : GpuProgram {

    // discard-free variant for unmasked, unclipped tiles
    if (this.programs.tile) return this.programs.tile;

    __DEV__ && console.log('Initializing programs.tile');

    this.programs.tile = this.buildTileColorProgram('shader-tile', []);

    return this.programs.tile;
}

/**
 * Tile color program variant that keeps the coverage mask and quadrant
 * clip `discard`, lazy initialization. Used for tiles that need to
 * discard fragments (masked or clipped).
 */

programTileDiscarding() : GpuProgram {

    if (this.programs.tileDiscarding) return this.programs.tileDiscarding;

    __DEV__ && console.log('Initializing programs.tileDiscarding');

    this.programs.tileDiscarding = this.buildTileColorProgram(
        'shader-tile-discarding', ['TILE_DISCARD']);

    return this.programs.tileDiscarding;
}

/**
 * Build a tile color program with the shared bindings, optionally
 * compiling the masked variant via preprocessor defines.
 * @name diagnostic program name
 * @defines preprocessor macros to define (e.g. `['TILE_DISCARD']`)
 */

private buildTileColorProgram(name: string, defines: string[]): GpuProgram {

    let atmBindings = {}

    if (this.map.legacyMap!.atmosphere) {

        atmBindings = { uboAtm: Renderer.UniformBlockName.Atmosphere }
    }

    return new GpuProgram(
        this.gpu, shaderTileVert, shaderTileFrag,
        name, {
            uboFrame: Renderer.UniformBlockName.Frame,
            uboLayers: Renderer.UniformBlockName.Layers,
            ...atmBindings
        }, { uTexAtmDensity: this.textureIdxs.atmosphere }, defines);
}

/**
 * Lazy background program initialization, including binding buffers to block names
 * and fixed samplers.
 */

programBackground() : GpuProgram {

    if (this.programs.background) return this.programs.background;

    let atmBindings = {}

    if (this.map.legacyMap!.atmosphere) {

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
 * Tile depth program, lazy initialization + bindings
 */

programTileDepth() : GpuProgram {

    if (this.programs.tileDepth) return this.programs.tileDepth;

    __DEV__ && console.log('Initializing programs.tileDepth');

    this.programs.tileDepth = new GpuProgram(
        this.gpu, shaderTileDepthVert, shaderTileDepthFrag,
        'shader-tile-depth', {
            uboFrame: Renderer.UniformBlockName.Frame
        }, {});

    // done
    return this.programs.tileDepth;
}


/**
 * Tile UV-footprint mask program, lazy initialization.
 */
programTileMaskFootprint(): GpuProgram {

    if (this.programs.tileMaskFootprint)
        return this.programs.tileMaskFootprint;

    __DEV__ && console.log('Initializing programs.tileMaskFootprint');

    this.programs.tileMaskFootprint = new GpuProgram(
        this.gpu,
        shaderTileMaskFootprintVert,
        shaderTileMaskFootprintFrag,
        'shader-tile-mask-footprint',
        {},
        {});

    return this.programs.tileMaskFootprint;
}


/**
 * Tile mask OR/blit program, lazy initialization.
 */
programTileMaskBlit(): GpuProgram {

    if (this.programs.tileMaskBlit) return this.programs.tileMaskBlit;

    __DEV__ && console.log('Initializing programs.tileMaskBlit');

    this.programs.tileMaskBlit = new GpuProgram(
        this.gpu,
        shaderTileMaskBlitVert,
        shaderTileMaskBlitFrag,
        'shader-tile-mask-blit',
        {},
        { uSource: this.textureIdxs.maskBlit });

    return this.programs.tileMaskBlit;
}


/**
 * Tile mask erosion program, lazy initialization.
 */
programTileMaskErode(): GpuProgram {

    if (this.programs.tileMaskErode) return this.programs.tileMaskErode;

    __DEV__ && console.log('Initializing programs.tileMaskErode');

    this.programs.tileMaskErode = new GpuProgram(
        this.gpu,
        shaderTileMaskBlitVert,
        shaderTileMaskErodeFrag,
        'shader-tile-mask-erode',
        {},
        { uSource: this.textureIdxs.maskBlit });

    return this.programs.tileMaskErode;
}


/**
 * Tile mask rectangle-rasterization program, lazy initialization.
 *
 * Dynamic rectangle geometry (using the blit vertex shader) paired with
 * the footprint fragment shader writes full coverage for exact UV-space
 * rectangles into a mask target.
 */
programTileMaskRect(): GpuProgram {

    if (this.programs.tileMaskRect) return this.programs.tileMaskRect;

    __DEV__ && console.log('Initializing programs.tileMaskRect');

    this.programs.tileMaskRect = new GpuProgram(
        this.gpu,
        shaderTileMaskBlitVert,
        shaderTileMaskFootprintFrag,
        'shader-tile-mask-rect',
        {},
        {});

    return this.programs.tileMaskRect;
}


/**
 * Frustum overlay program, lazy initialization.
 */
programFrustum(): GpuProgram {

    if (this.programs.frustum) return this.programs.frustum;

    __DEV__ && console.log('Initializing programs.frustum');

    this.programs.frustum = new GpuProgram(
        this.gpu, shaderFrustumVert, shaderFrustumFrag,
        'shader-frustum', {
            uboFrame: Renderer.UniformBlockName.Frame
        }, {});

    this.frustumVao_ = this.gpu.gl.createVertexArray();
    this.frustumState_ = this.gpu.createState({
        blend: true,
        zwrite: false,
        ztest: true,
        culling: false,
    });

    return this.programs.frustum;
}

/**
 * Draw a frozen camera frustum as a translucent pyramid.
 *
 * @param apex physical-space camera position at freeze time
 * @param base four physical-space base corners
 * @param liveCamPos current physical-space camera position
 */
drawFrustumPyramid(
    apex: number[],
    base: number[][],
    liveCamPos: number[],
): void {

    const program = this.programFrustum();
    if (!program.isReady() || !this.frustumVao_ || !this.frustumState_) {
        return;
    }

    const toRenderer = (p: number[]) => [
        p[0] - liveCamPos[0],
        p[1] - liveCamPos[1],
        p[2] - liveCamPos[2],
    ];
    const a = toRenderer(apex);
    const tl = toRenderer(base[0]);
    const tr = toRenderer(base[1]);
    const br = toRenderer(base[2]);
    const bl = toRenderer(base[3]);
    const vertices = new Float32Array([
        ...a, ...tr, ...tl,
        ...a, ...br, ...tr,
        ...a, ...bl, ...br,
        ...a, ...tl, ...bl,
        ...tl, ...br, ...bl,
        ...tl, ...tr, ...br,
    ]);

    const gl = this.gpu.gl;
    this.gpu.setState(this.frustumState_);
    this.gpu.useProgram2(program);
    program.setVec3('uVertices[0]', vertices);
    program.setVec4('uColor', [1.0, 0.5, 0.5, 0.25]);

    gl.bindVertexArray(this.frustumVao_);
    gl.drawArrays(gl.TRIANGLES, 0, 18);
    gl.bindVertexArray(null);
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
        tileMask: maxFragTextures - TextureIdxOffsets.TileMask,
        maskBlit: maxFragTextures - TextureIdxOffsets.MaskBlit,
    };

    // diagnostics
    __DEV__ && utils.logOnce(
        `Atmosphere uses texture unit ${this.textureIdxs.atmosphere}.`);
    __DEV__ && utils.logOnce(
        `Tile masks use texture units ${this.textureIdxs.tileMask} `
        + `and ${this.textureIdxs.maskBlit}.`);
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
    if (this.map.legacyMap!.atmosphere) this.map.legacyMap!.atmosphere.createBuffers();

    // uboLayers not initialized here: each submesh keeps its own

}

/**
 * Initialize renderer-owned state for the current map frame.
 *
 * The legacy map draw code used to write these fields directly before
 * drawing. This method keeps the same data local to the renderer and updates
 * the frame UBO from the selection position used for terrain selection.
 */
initFrame(): void {

    const map = this.map.legacyMap!;
    const config = map.config;
    const overrides = map.outerMap.overrides;

    this.debugStr = `AsyncImageDecode: ${config.mapAsyncImageDecode}`;
    this.overrides = overrides;
    this.benevolentMargins = !!config.mapBenevolentMargins;

    const forcedFrameTime = config.mapForceFrameTime;

    if (typeof forcedFrameTime === 'number' && forcedFrameTime !== 0) {

        this.frameTime = forcedFrameTime !== -1
            ? forcedFrameTime
            : 0;

        // consume-once: reset through the store so the shared value
        // map stays consistent
        if (forcedFrameTime !== -1) {
            this.map.configStore.set({ mapForceFrameTime: -1 });
        }

    } else {

        this.frameTime = map.stats.frameTime;
    }

    this.hoverFeatureCounter = 0;
    this.hoverFeatureList = map.hoverFeatureList;
    this.hoverFeature = map.hoverFeature;

    this.drawLabelBoxes = !!overrides.drawLabelBoxes;
    this.drawGridCells = !!overrides.drawGridCells;
    this.drawAllLabels = !!overrides.drawAllLabels;
    this.drawHiddenLabels = !!overrides.drawHiddenLabels;
    this.fmaxDist = Number.NEGATIVE_INFINITY;
    this.fminDist = Number.POSITIVE_INFINITY;

    const navigationSrsInfo = map.getNavigationSrs().getSrsInfo();
    this.earthRadius = navigationSrsInfo.a;
    this.earthRadius2 = navigationSrsInfo.b;
    this.earthERatio = navigationSrsInfo.a / navigationSrsInfo.b;

    const updateFrameBuffers = () => {

        map.camera.update();
        this.syncCameraState();
        this.updateIllumination(map.position);
        this.updateBuffers(map.outerMap.getSelectionPosition()!);
    };

    if (map.outerMap.drawChannel === 'color') {

        updateFrameBuffers();

    } else {

        map.outerMap.withSelectionCamera(updateFrameBuffers);
    }
}

/**
 * Recompute renderer camera caches from the currently installed map camera.
 *
 * Freeze mode swaps legacy map and camera fields for scoped draw callbacks.
 * Calling this after a swap keeps renderer draw helpers aligned with the
 * active camera context without forcing another UBO upload.
 */
syncCameraState(): void {

    const map = this.map.legacyMap!;
    const camera = map.camera;
    const position = map.position;

    this.cameraPosition = camera.position;
    this.cameraVector = camera.vector;
    this.cameraOrientation = position.getOrientation();
    this.cameraTiltFator =
        Math.cos(math.radians(this.cameraOrientation[1]));
    this.cameraViewExtent = position.getViewExtent();
    this.cameraViewExtent2 = Math.pow(
        2.0,
        Math.max(
            1.0,
            Math.floor(Math.log(this.cameraViewExtent) / Math.log(2))
        )
    );

    if (map.getNavigationSrs().isProjected()) {

        const yaw = math.radians(this.cameraOrientation[0]);
        this.labelVector = [-Math.sin(yaw), Math.cos(yaw), 0, 0, 0];

    } else {

        const vector = camera.vector;
        this.labelVector = [vector[0], vector[1], vector[2], 0];
    }

    this.distanceFactor =
        1 / Math.max(1, Math.log(camera.distance) / Math.log(1.04));
    this.tiltFactor = Math.abs(this.cameraOrientation[1] / -90);
    this.localViewExtentFactor =
        2 * Math.tan(math.radians(position.getFov() * 0.5));
}

/**
 * Update the contents of the uboFrame and uboAtm uniform buffer objects based
 * on current position and view configuration.
 *
 * @param position map position or view extent used for scale-dependent
 *   vertical exaggeration
 */

updateBuffers(
    position: MapPosition | number = this.map.legacyMap!.outerMap.getNavigationPosition()!
) {

    let renderFlags: Renderer.RenderFlags = Renderer.RenderFlags.FlagNone;

    // map
    let map = this.map.legacyMap!;

    // one backing buffer, two typed views.
    const buf = new ArrayBuffer(UboFrameSize);
    const f32 = new Float32Array(buf); // for mat4/vec4
    const i32 = new Int32Array(buf);   // for ivec4

    let data: {[key:string]: any} = {};

    // obtain the data: matrices
    data.view = this.camera.getModelviewFMatrix();
    data.projection = this.camera.getProjectionFMatrix();

    // obtain the data: body params and vertical exaggeration
    let se = this.getSuperElevation(position);
    let srsInfo = this.map.legacyMap!.getPhysicalSrs().getSrsInfo();
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
    const d = this.overrides;
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

    // clip params; y carries the fallback-coverage discard threshold
    data.clipParams = [
        this.map.legacyMap!.config.mapSplitMargin,
        this.map.legacyMap!.config.mapTraversalMaskThreshold,
        0,
        0,
    ];

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

    // the uboAtm buffer, updated only while atmosphere rendering is on
    if (this.map.legacyMap!.atmosphere
            && (d.flagAtmosphere ?? cfg.mapFlagAtmosphere)) {

        let [view2ecef, _, eyePos] = this.calcEcefCamParams();

        //console.log(this.map.legacyMap.camera.position);
        //console.log(view2ecef);

        this.map.legacyMap!.atmosphere.updateBuffers(
            eyePos,
            map.position.getViewDistance(),
            view2ecef as math.mat4);
    }

}

drawBackground() {

    let atmosphere = this.map.legacyMap!.atmosphere;

    if (atmosphere && atmosphere.isReady()) {

        this.gpu.setState(this.backgroundState!);
        let [_, clip2ecef, eyePos] = this.calcEcefCamParams();
        atmosphere.drawBackground(eyePos, clip2ecef);
    }
}

private calcEcefCamParams(): [math.mat4, math.mat4, math.vec3] {

    // as noted elsewhere, the renderer world coordinates are not
    // true physical world coordinates - they are translated relative to
    // camera center to avoid quantization errors. Hence this.
    let view2ecef = mat4.translate(mat4.identity(mat4.create()),
                                       this.map.legacyMap!.camera.position);
    let clip2ecef = [...view2ecef];

    mat4.multiply(view2ecef, this.camera.modelviewinverse);
    mat4.multiply(clip2ecef, this.camera.mvpinverse);

    return [
        view2ecef as math.mat4,
        clip2ecef as math.mat4,
        this.map.legacyMap!.camera.position as math.vec3];
}


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

/** Ensure the canvas render target is current and correctly sized.
 *
 *  Always binds the canvas as the active GL render target. When the
 *  canvas DOM size has changed since the last frame, also resizes the
 *  canvas element and recomputes projection matrices. Call at the top
 *  of the render loop only — mid-pass calls would discard any auxiliary
 *  framebuffer that was current.
 *
 *  @returns `true` when a resize occurred; `false` when nothing changed
 *    or the renderer has been disposed. */
ensureCanvasRenderTarget(): boolean {

    if (this.disposed_) return false;

    if (!this.gpu.canvasRenderTargetNeedsUpdate()) {
        this.gpu.setCanvasRenderTarget();
        return false;
    }

    const canvasTarget = this.gpu.updateCanvasRenderTarget();
    this.setProjection(canvasTarget.apparentSize);
    return true;
}

/** Set projection matrices from the logical size of the active render
 *  target. Updates two coupled pieces of state:
 *  - camera aspect ratio (width / height), which drives the 3D scene
 *    perspective matrix
 *  - `imageProjectionMatrix`, the column-major orthographic matrix that
 *    maps 2D draw-helper coordinates to NDC
 *
 *  The absolute dimensions matter for `imageProjectionMatrix` (scale
 *  factors are 2/width and 2/height), not just the ratio.
 *
 *  Called only from the base canvas pass. Auxiliary passes deliberately
 *  skip it so the camera aspect stays locked to the canvas view even
 *  when the framebuffer has a different size. */
private setProjection(size: Readonly<Size2>) {

    let [width, height] = size;

    this.camera.setAspect(width / height);

    var m = new Float32Array(16);

    // column-major orthographic matrix
    m[0] = 2.0/width; m[1] = 0; m[2] = 0; m[3] = 0;
    m[4] = 0; m[5] = -2.0/height; m[6] = 0; m[7] = 0;
    m[8] = 0; m[9] = 0; m[10] = 1; m[11] = 0;
    m[12] = -width*0.5*m[0]; m[13] = -height*0.5*m[5]; m[14] = 0; m[15] = 1;

    this.imageProjectionMatrix = m;
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
        sp[0] = ((p[0]/p[3])+1.0)*0.5*this.apparentSize[0];
        sp[1] = (-(p[1]/p[3])+1.0)*0.5*this.apparentSize[1];

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


private coordinateSpaceSize(
    coordinateSpace: Renderer.CoordinateSpace,
): Readonly<Size2> {

    if (coordinateSpace === 'apparent') {
        return this.gpu.currentRenderTarget.apparentSize;
    }

    return this.gpu.currentRenderTarget.cssLayoutSize
        ?? this.gpu.currentRenderTarget.apparentSize;
}


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

    if (this.map.legacyMap?.position) {

        this.updateIllumination(this.map.legacyMap!.position);
    }

    this.map.legacyMap?.markDirty();

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

    const d = this.overrides;

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

    this.map.legacyMap?.markDirty();

};


getRenderingOptions(): Renderer.RenderingOptions {

    const d = this.overrides;
    const cfg = this.config;

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

/*
 * Vertical exaggeration lives on the map: see
 * `src/map/vertical-exaggeration.ts`. The members below forward to it
 * for the legacy JavaScript call sites that still name it in the
 * retired `superelevation` vocabulary.
 */

get useSuperElevation(): boolean {

    return this.map.verticalExaggeration.enabled;
}

get seCounter(): number {

    return this.map.verticalExaggeration.counter;
}

getSuperElevation(position: MapPosition | number) {

    return this.map.verticalExaggeration.vaParams(position);
}

getSuperElevatedHeight(height: number, position: MapPosition | number) {

    return this.map.verticalExaggeration.apply(height, position);
}

getUnsuperElevatedHeight(height: number, position: MapPosition | number) {

    return this.map.verticalExaggeration.unapply(height, position);
}


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

getScreenRay(
    screenX: number,
    screenY: number,
    coordinateSpace: Renderer.CoordinateSpace = 'layout',
) {
    if (this.camera == null) {
        return [0,0,1.0];
    }

    this.camera.dirty = true; //???? why is projection matrix distored so I have to refresh

    const inputSize = this.coordinateSpaceSize(coordinateSpace);
    var x = (2.0 * screenX) / inputSize[0] - 1.0;
    var y = 1.0 - (2.0 * screenY) / inputSize[1];
    
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


hitTestGeoLayers(
    screenX: number,
    screenY: number,
    secondTexture: boolean,
    coordinateSpace: Renderer.CoordinateSpace = 'layout',
) {

    var surfaceHit = false, pixel: Uint8Array = new Uint8Array(4);

    const inputSizeGeo = this.coordinateSpaceSize(coordinateSpace);

    if (screenX >= 0 && screenX < inputSizeGeo[0] &&
        screenY >= 0 && screenY < inputSizeGeo[1]) {

        //convert screen coords to texture coords
        var x = 0, y = 0;

        //get screen coords
        x = Math.floor(screenX * (this.hitmapSize / inputSizeGeo[0]));
        y = Math.floor(screenY * (this.hitmapSize / inputSizeGeo[1]));

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
    case 'base': {
        const canvasTarget = this.gpu.setCanvasRenderTarget();

        gl.clearColor(0.0, 0.0, 0.0, 1.0);

        this.setProjection(canvasTarget.apparentSize);
        this.camera.update();
        this.onlyDepth = false;
        this.onlyHitLayers = false;
        this.onlyAdvancedHitLayers = false;
        this.advancedPassNeeded = false;
        break;
    }

    case 'depth': {

        // Auxiliary pass: inherits projection from the canvas target.
        this.gpu.setAuxiliaryRenderTarget(this.hitmapTexture!,
            [this.hitmapSize, this.hitmapSize]);

        this.gpu.clearColorAndDepth([255, 255, 255, 255]);

        gl.enable(gl.DEPTH_TEST);

        this.camera.update();
        this.onlyDepth = true;
        this.onlyHitLayers = false;
        this.onlyAdvancedHitLayers = false;
        this.advancedPassNeeded = false;
        break;
    }

    case 'geo':
    case 'geo2': {

        // Auxiliary pass: inherits projection from the canvas target.
        this.gpu.setAuxiliaryRenderTarget(
            (type == 'geo' ? this.geoHitmapTexture : this.geoHitmapTexture2)!,
            [this.hitmapSize, this.hitmapSize]
        );
        gl.clearColor(1.0, 1.0, 1.0, 1.0);
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

        gl.enable(gl.DEPTH_TEST);

        this.hoverFeatureCounter = 0;

        this.onlyHitLayers = true;
        this.advancedPassNeeded = false;
        this.onlyAdvancedHitLayers = (type == 'geo2');
        this.camera.update();
        break;
    }

    }
};


/**
 * Read one hitmap pixel and return the world-space hit position.
 *
 * @param screenX Horizontal screen coordinate.
 * @param screenY Vertical screen coordinate.
 * @param coordinateSpace Coordinate space of the input screen point.
 * @returns `[x, y, z, surfaceHit, screenRay, depth, cameraPos]`.
 */
hitTest(
    screenX: number,
    screenY: number,
    coordinateSpace: Renderer.CoordinateSpace = 'layout',
) {

    //get screen ray
    var screenRay = this.getScreenRay(screenX, screenY, coordinateSpace);
    var cameraPos = this.camera.getPosition();

    //probably not needed
    //if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) != gl.FRAMEBUFFER_COMPLETE) {  
      //  return [0, 0, 0, null, screenRay, Number.MAX_VALUE, cameraPos];
    //}

    const inputSizeHit = this.coordinateSpaceSize(coordinateSpace);

    //convert screen coords to texture coords
    var x = 0, y = 0;

    //get screen coords
    x = Math.floor(screenX * (this.hitmapSize / inputSizeHit[0]));
    y = Math.floor(screenY * (this.hitmapSize / inputSizeHit[1]));

    //get pixel value from framebuffer
    const hitmapTexture = this.hitmapTexture;
    if (!hitmapTexture) {
        return [0, 0, 0, false, screenRay, Number.MAX_VALUE, cameraPos];
    }

    var pixel = hitmapTexture.readFramebufferPixels(
        x, this.hitmapSize - y - 1, 1, 1);

    var depth = Renderer.decodeHitmapDepth(pixel, 0);
    if (depth == Number.POSITIVE_INFINITY) {

        return [0, 0, 0, false, screenRay, Number.MAX_VALUE, cameraPos];

    }

    //compute hit postion
    this.lastHitPosition = [cameraPos[0] + screenRay[0]*depth, cameraPos[1] + screenRay[1]*depth, cameraPos[2] + screenRay[2]*depth];


    return [this.lastHitPosition[0], this.lastHitPosition[1],
            this.lastHitPosition[2], true, screenRay, depth, cameraPos];
};


/**
 * Read the full hitmap framebuffer into `hitmapData`.
 * Called once per frame when `hitmapMode > 2`.
 */
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


/**
 * Return the farthest finite hitmap depth.
 *
 * This scans the copied hitmap buffer when available, or reads the full
 * hitmap framebuffer for non-cached hitmap modes. Intended for diagnostic
 * one-shot queries, not per-frame render work.
 *
 * @param stride pixel step used while scanning the hitmap
 * @returns farthest finite depth, or null when no surface was hit
 */
getMaxFiniteDepth(stride: number = 3): number | null {

    const hitmapTexture = this.hitmapTexture;
    if (!hitmapTexture) return null;

    const pixels = this.hitmapData ?? hitmapTexture.readFramebufferPixels(
        0, 0, this.hitmapSize, this.hitmapSize);
    const step = Math.max(1, Math.floor(stride));
    const view = new DataView(
        pixels.buffer,
        pixels.byteOffset,
        pixels.byteLength,
    );
    let maxDepth = Number.NEGATIVE_INFINITY;

    for (let y = 0; y < this.hitmapSize; y += step) {

        for (let x = 0; x < this.hitmapSize; x += step) {

            const offset = (x + y * this.hitmapSize) * 4;
            const depth = view.getFloat32(offset, true);
            if (Number.isFinite(depth) && depth > maxDepth)
                maxDepth = depth;
        }
    }

    return maxDepth > Number.NEGATIVE_INFINITY ? maxDepth : null;
}


/**
 * Sample hitmap depth at the given screen position.
 *
 * @param screenX Horizontal screen coordinate.
 * @param screenY Vertical screen coordinate.
 * @param dilate Neighbourhood radius in hitmap pixels. Used by cached
 * mode (`hitmapMode > 2`) to find the nearest surface hit within a
 * small dilation window.
 * @param coordinateSpace Coordinate space of the input screen point.
 * @returns `[surfaceHit, depth]`.
 */
getDepth(
    screenX: number,
    screenY: number,
    dilate: number = 0,
    coordinateSpace: Renderer.CoordinateSpace = 'layout',
) {

    const inputSizeDepth = this.coordinateSpaceSize(coordinateSpace);
    var x = Math.floor(screenX * (this.hitmapSize / inputSizeDepth[0]));
    var y = Math.floor(screenY * (this.hitmapSize / inputSizeDepth[1]));

    var depth: number;


    if (this.hitmapMode <= 2) {

        //get pixel value from framebuffer
        const hitmapTexture = this.hitmapTexture;
        if (!hitmapTexture) return [false, Number.POSITIVE_INFINITY];

        const pixel = hitmapTexture.readFramebufferPixels(
            x, this.hitmapSize - y - 1, 1, 1);

        const sampleDepth = Renderer.decodeHitmapDepth(pixel, 0);
        var surfaceHit = sampleDepth < Number.POSITIVE_INFINITY;
        depth = sampleDepth;

     } else {

        // CPU-cached path; dilation catches near occlusions in hitmap pixels.
        var pixels = this.hitmapData;
        if (!pixels) {
            return [false, Number.POSITIVE_INFINITY];
        }
        var rpx = dilate;
        var minDepth = Number.POSITIVE_INFINITY;
        var anyHit = false;
        {
            var hs = this.hitmapSize;
            var y0 = (this.hitmapSize - y - 1);
            for (var dy = -rpx; dy <= rpx; dy++) {

                var yy = y0 + dy;
                if (yy < 0 || yy >= hs) continue;
                for (var dx = -rpx; dx <= rpx; dx++) {

                    var xx = x + dx;
                    if (xx < 0 || xx >= hs) continue;
                    var idx = (xx + yy * hs) * 4;
                    var d = Renderer.decodeHitmapDepth(pixels, idx);
                    if (d < Number.POSITIVE_INFINITY) {

                        anyHit = true;
                        if (d < minDepth) minDepth = d;

                    }
                }
            }
            if (!anyHit) minDepth = Number.POSITIVE_INFINITY;
        }
        var depth = minDepth;
        var surfaceHit = anyHit;
    }

    return [surfaceHit, depth];
};


private static decodeHitmapDepth(
    pixels: Uint8Array,
    offset: number,
): number {

    const depth = new DataView(
        pixels.buffer, pixels.byteOffset + offset).getFloat32(0, true);

    return isFinite(depth) ? depth : Number.POSITIVE_INFINITY;
}


getZoffsetFactor(params: ArrayLike<number>) {
    return (params[0] + params[1]*this.distanceFactor + params[2]*this.tiltFactor)*0.0001;
};


saveScreenshot(output: string, filename: string, filetype: string) {
    var gl = this.gpu.gl;

    //get current screen size
    var width = this.apparentSize[0];
    var height = this.apparentSize[1];

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
            this.gpu, url, this.map, null, undefined, tiled, filter);
        this.bitmaps[id] = texture;
    }

    return texture;
};


getFont(url: string) {
    var font = this.fonts[url];
    if (!font) {
        font = new GpuFont(this.gpu, this.map, null, null, url);
        this.fonts[url] = font;
    }

    return font;
};

// -------------------------------------------------------------------------
// Inspector scripting API — promoted from the legacy RendererInterface
// wrapper.
// -------------------------------------------------------------------------

/**
 * Create a GPU texture from raw pixel data or an Image element.
 *
 * Used by the debug inspector to display overlays.
 *
 * @param options `{ source, filter?, repeat?, width?, height? }` —
 *   `source` is a `Uint8Array` (requires `width` and `height`) or `Image`.
 * @returns new `GpuTexture`, or null if options are invalid
 */
createTexture(options: any): GpuTexture | null {

    if (options == null || typeof options !== 'object') return null;

    const source = options['source'];
    if (source == null) return null;

    const filter = options['filter'] || 'linear';
    const repeat = options['repeat'] || false;

    if (source instanceof Uint8Array) {

        const width = options['width'];
        const height = options['height'];

        if (width && height) {

            const texture = new GpuTexture(this.gpu, null, this.map);
            texture.createFromData(
                width, height, source, GpuTexture.Type.Color, filter, repeat
            );
            return texture;
        }
    }

    if (source instanceof Image) {

        const texture = new GpuTexture(this.gpu, null, this.map);
        texture.createFromImage(source, GpuTexture.Type.Color, filter, repeat);
        return texture;
    }

    return null;
}

/**
 * Draw a textured rectangle at given canvas coordinates.
 *
 * Used by the debug inspector to draw circle markers
 * at control-point positions.
 *
 * @param options `{ texture, rect, color?, depth?, depthOffset?,
 *   depthTest?, blend?, writeDepth?, useState? }`
 */
drawImage(options: any): void {

    if (options == null || typeof options !== 'object') return;
    if (options['texture'] == null || options['rect'] == null) return;

    const rect       = options['rect'];
    const raw        = options['color'] || [255, 255, 255, 255];
    const color      = [raw[0] / 255, raw[1] / 255, raw[2] / 255, raw[3] / 255];
    const depth      = options['depth']       ?? 0;
    const depthOffset = options['depthOffset'] ?? null;
    const depthTest  = options['depthTest']   ?? false;
    const blend      = options['blend']       ?? false;
    const writeDepth = options['writeDepth']  ?? false;
    const useState   = options['useState']    ?? false;

    this.draw.drawImage(
        rect[0], rect[1], rect[2], rect[3],
        options['texture'], color,
        depth, depthOffset, depthTest, blend, writeDepth, useState
    );
}

/**
 * Draw a world-space or screen-space polyline.
 *
 * Used by the debug inspector and measurement UI.
 *
 * @param options `{ points, color?, size?, screenSpace?,
 *   depthOffset?, depthTest?, blend?, writeDepth?, useState? }`
 */
drawLineString(options: any): void {

    if (options == null || typeof options !== 'object') return;
    if (options['points'] == null) return;

    const raw        = options['color'] || [255, 255, 255, 255];
    const color      = [raw[0] / 255, raw[1] / 255, raw[2] / 255, raw[3] / 255];
    const depthOffset = options['depthOffset'] ?? null;
    const size       = options['size']       || 2;
    const screenSpace = options['screenSpace'] ?? true;
    const depthTest  = options['depthTest']  ?? false;
    const blend      = options['blend']      ?? false;
    const writeDepth = options['writeDepth'] ?? false;
    const useState   = options['useState']   ?? false;

    this.draw.drawLineString(
        options['points'], screenSpace, size, color,
        depthOffset, depthTest, blend, writeDepth, useState
    );
}


/**
 * Releases all GPU resources owned by this renderer.
 * Sets `disposed_` to block further rendering after teardown.
 */
[Symbol.dispose](): void {

    if (this.disposed_) return;
    this.disposed_ = true;

    this.unwatchConfig_();

    this.heightmapTexture?.[Symbol.dispose]();
    this.hitmapTexture?.[Symbol.dispose]();
    this.geoHitmapTexture?.[Symbol.dispose]();
    this.geoHitmapTexture2?.[Symbol.dispose]();
    this.redTexture?.[Symbol.dispose]();
    this.whiteTexture?.[Symbol.dispose]();
    this.blackTexture?.[Symbol.dispose]();
    this.textTexture2?.[Symbol.dispose]();
    this.bboxMesh?.kill();
    this.bboxMesh2?.kill();
    this.plines?.kill();
    this.plineJoints?.kill();
    this.nmblender?.destroy();
    this.gpu[Symbol.dispose]();
}

} // export class Renderer

// local types

type Optional<T> = T | null;

type Size2 = [ number, number ];

type LegacyGpuBBox = {
    kill(): void;
    draw(program: GpuProgram, attrPosition: string): void;
};

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

/** Fixed texture indices - the actual index is computed as
  * Idx % gl.MAX_TEXTURE_IMAGE_UNITS
  */

enum TextureIdxOffsets {

    Atmosphere = -1,
    TileMask = 2,
    MaskBlit = 3,
}

const UboFrameSize = 320;

// export types
export namespace Renderer {

/** Coordinate space used by hit, depth, and ray screen-coordinate APIs. */
export type CoordinateSpace = 'layout' | 'apparent';

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

/* Uniform buffer object binding points. */

export enum UniformBlockName {

    Frame = 0,
    Layers = 1,
    Atmosphere = 2
}

} // export namespace Rendrer


export default Renderer;
