
import GpuProgram from './program';
import GpuTexture from './texture';
import Renderer from '../renderer';

/**
 * GpuDevice is not an abstraction of a GPU device. Here is what it does:
 *
 *   * it manages the canvas inside the map element and sets its size properly
 *     according to the provided CSS pixel size
 *
 *   * it computes the size of the gl viewport, though it doen set it (it should)
 *     (setViewport)
 *
 *   * it abstracts various GL rendering flags (gl.BLEND, gl.STENCIL_TEST,
 *     gl.DEPTH) into a single state object, with getState and setState accessors.
 *
 *   * it provides a thin wrapper around gl.userProgram and gl.bindTexture
 *
 *   * it can set a framebuffer, though the logic is flawed (no tracking of that
 *     the rendering is now offscreen, no change to viewport, prone to errors)
 */


export class GpuDevice {

    maxAttributesCount = 8;
    newAttributes = new Uint8Array(this.maxAttributesCount);
    enabledAttributes = new Uint8Array(this.maxAttributesCount);
    //noTextures = false; // never used

    renderer!: Renderer;
    div!: HTMLElement;
    curSize!: NumberPair;
    defaultState!: GpuDevice.State;
    currentState!: GpuDevice.State;
    keepFrameBuffer!: boolean;
    antialias!: boolean;
    anisoLevel!: GLfloat;
    maxAniso!: GLfloat;

    //currentOffset = 0; //used fot direct offset

    canvas: Optional<HTMLCanvasElement> = null;
    gl: Optional<WebGL2RenderingContext> = null;
    currentProgram: Optional<WebGLProgram> = null;

    viewport: Optional<Viewport> = null;
    anisoExt: Optional<EXT_texture_filter_anisotropic>;

    constructor(renderer: Renderer, div: HTMLElement, size: NumberPair,
                keepFrameBuffer: boolean, antialias: boolean,
                aniso: GLfloat) {

        this.renderer = renderer;
        this.div = div;
        this.curSize = size;

        //state of device when first initialized
        this.defaultState = this.createState({blend:false, stencil:false,
            zequal: false, ztest:false, zwrite: false, culling:false});
        this.currentState = this.defaultState;

        this.keepFrameBuffer = keepFrameBuffer;
        this.antialias = antialias;
        this.anisoLevel = aniso;
    };


init() {

    var canvas = document.createElement('canvas');

    if (canvas == null) {
        //canvas not supported
        return;
    }

    this.canvas = canvas;
    canvas.style.display = 'block';
    this.div.appendChild(canvas);

    this.resize(this.curSize);

    if (canvas.getContext == null) {
        //canvas not supported
        return;
    }

    canvas.addEventListener("webglcontextlost", this.contextLost.bind(this), false);
    canvas.addEventListener("webglcontextrestored", this.contextRestored.bind(this), false);

    let gl: WebGL2RenderingContext;

    try {
        gl = canvas.getContext('webgl2', {preserveDrawingBuffer: this.keepFrameBuffer, antialias: this.antialias, stencil: true});
    } catch(e) {
        throw new Error('Error obtaining webgl2 context, webgl not supported?');
    }

    this.gl = gl;

    this.anisoExt = gl.getExtension('EXT_texture_filter_anisotropic');

    if (this.anisoExt) {
        this.maxAniso = gl.getParameter(this.anisoExt.MAX_TEXTURE_MAX_ANISOTROPY_EXT);

        if (this.anisoLevel) {
            if (this.anisoLevel == -1) {
                this.anisoLevel = this.maxAniso;
            } else {
                this.anisoLevel = Math.min(this.anisoLevel, this.maxAniso);
            }
        }
    } else {
        this.maxAniso = 0;
        this.anisoLevel = 0;
    }

    this.viewport = { width: canvas.width, height: canvas.height };

    gl.clearColor(0.0, 0.0, 0.0, 1.0);

    // initial state
    gl.disable(gl.BLEND);

    gl.disable(gl.STENCIL_TEST);
    gl.depthMask(false);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LESS);
    gl.disable(gl.CULL_FACE);

    //clear screen
    gl.viewport(0, 0, this.viewport.width, this.viewport.height);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
};


kill() {
    this.div.removeChild(this.canvas);
    delete this.canvas;
    this.canvas = null;
};


contextLost(event: WebGLContextEvent) {
    event.preventDefault();
    this.renderer.core.contextLost = true;
    this.renderer.core.callListener('gpu-context-lost', {});
};


contextRestored(): void {
    this.renderer.core.callListener('gpu-context-restored', {});
};


resize(size: NumberPair, skipCanvas: boolean = false) {

    this.curSize = size;
    let canvas = this.canvas;

    let dpr = window.devicePixelRatio || 1;

    var width = Math.floor(size[0]);
    var height = Math.floor(size[1]);
    var pwidth = Math.floor(width * dpr);
    var pheight = Math.floor(height * dpr);

    if (canvas != null && skipCanvas !== true) {
        canvas.width = pwidth;
        canvas.height = pheight;
        canvas.style.width = width + 'px';
        canvas.style.height = height + 'px';

        console.log('canvas size: [%d, %d], canvas css size: [%d %d]',
                    pwidth, pheight, width, height);
    }

    this.viewport = { width: canvas.width, height: canvas.height }
};


setAniso(aniso: GLfloat) {
    if (this.anisoExt) {
        if (this.anisoLevel) {
            if (aniso == -1) {
                this.anisoLevel = this.maxAniso;
            } else {
                this.anisoLevel = Math.min(aniso, this.maxAniso);
            }
        }
    }
};


getCanvas(): HTMLCanvasElement {
    return this.canvas;
};


setViewport() {
    this.gl.viewport(0, 0, this.viewport.width, this.viewport.height);
};


clear(clearDepth: boolean, clearColor: boolean, color : Color): void {

    if (color != null) {
        this.gl.clearColor(color[0]/255, color[1]/255, color[2]/255, color[3]/255);
    }

    this.gl.clear((clearColor ? this.gl.COLOR_BUFFER_BIT : 0) |
                  (clearDepth ? this.gl.DEPTH_BUFFER_BIT : 0) );
};

/**
 * The newAPI does not enable attributes or silently set sampler uniforms.
 * Both is responsibility  of the calling layer.
 *
 * @param Program the GPUProgram object to use.
 */

useProgram2(program: GpuProgram) {

    if (this.currentProgram != program) {

        this.gl.useProgram(program.program);
        this.currentProgram = program;
    }
}

/**
 * Old API, deprecated/
 */

useProgram(program: GpuProgram, attributes: string[], nextSampler: boolean) {

    if (this.currentProgram != program) {

        this.gl.useProgram(program.program);
        this.currentProgram = program;

        // why this is done for every program statically i do not know
        // in the tile program the first uniform identifies the main
        // texture slot (0), the second one the mask (1)
        program.setSampler('uSampler', 0);

        if (nextSampler) {
            program.setSampler('uSampler2', 1);
        }

        // TODO: we should handle this by switching VAOs
        var newAttributes = this.newAttributes;
        var enabledAttributes = this.enabledAttributes;

        //reset new attributes list
        for (var i = 0, li = newAttributes.length; i < li; i++){
            newAttributes[i] = 0;
        }

        for (i = 0, li = attributes.length; i < li; i++){
            var index = program.getAttribLocation(attributes[i]);

            if (index != -1){
                newAttributes[index] = 1;
            }
        }

        //enable or disable current attributes according to new attributes list
        for (i = 0, li = newAttributes.length; i < li; i++){
            if (enabledAttributes[i] != newAttributes[i]) {
                if (newAttributes[i]) {
                    this.gl.enableVertexAttribArray(i);
                    enabledAttributes[i] = 1;
                } else {
                    this.gl.disableVertexAttribArray(i);
                    enabledAttributes[i] = 0;
                }
            }
        }
    }
};


bindTexture(texture: GpuTexture, id?: GLint) {

    if (!texture.loaded) {
        return;
    }

    let slot = id ? this.gl.TEXTURE0 + id : this.gl.TEXTURE0;

    this.gl.activeTexture(slot);
    this.gl.bindTexture(this.gl.TEXTURE_2D, texture.texture);
};

/**
 * WARN: The function does nothing to the gl.viewport, which is set by the
 * calling layer. Pretty ugly, things may fall appart as soon as the upper
 * layer issues an innocent call to this.setViewport.
 */

setFramebuffer(texture: GpuTexture) {
    if (texture != null) {
        this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, texture.framebuffer);
    } else {
        this.gl.bindTexture(this.gl.TEXTURE_2D, null);
        this.gl.bindRenderbuffer(this.gl.RENDERBUFFER, null);
        this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, null);
    }
};


createState(state: GpuDevice.State): GpuDevice.State {

    if (state.blend == null) { state.blend = false; }
    if (state.stencil == null) { state.stencil = false; }
    if (state.zwrite == null) { state.zwrite = true; }
    if (state.ztest == null) { state.ztest = true; }
    if (state.zequal == null) { state.zequal = false; }
    if (state.culling == null) { state.culling = true; }

    return state;
};


setState(state: GpuDevice.State) {

    if (!state) {
        return;
    }

    var gl = this.gl;
    var currentState = this.currentState;

    if (currentState.blend != state.blend) {
        if (state.blend) {
            gl.blendEquationSeparate(gl.FUNC_ADD, gl.FUNC_ADD);
            gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
            gl.enable(gl.BLEND);
        } else {
            gl.disable(gl.BLEND);
        }
    }

    if (currentState.stencil != state.stencil) {
        if (state.stencil) {
            gl.enable(gl.STENCIL_TEST);
        } else {
            gl.disable(gl.STENCIL_TEST);
        }
    }

    if (currentState.zwrite != state.zwrite) {
        if (state.zwrite) {
            gl.depthMask(true);
        } else {
            gl.depthMask(false);
        }
    }

    if (currentState.ztest != state.ztest) {
        if (state.ztest) {
            gl.enable(gl.DEPTH_TEST);
        } else {
            gl.disable(gl.DEPTH_TEST);
        }
    }

    if (currentState.zequal != state.zequal) {
        if (state.zequal) {
            gl.depthFunc(gl.LEQUAL);
        } else {
            gl.depthFunc(gl.LESS);
        }
    }

    if (currentState.culling != state.culling) {
        if (state.culling) {
            gl.enable(gl.CULL_FACE);
        } else {
            gl.disable(gl.CULL_FACE);
        }
    }

    this.currentState = state;
};

} // class GpuDevice

type Optional<T> = T | null;

// local types
type NumberPair = [number, number];
type Color = [number, number, number, number]

type Viewport = { width: number, height: number }

// exported types
export namespace GpuDevice {

export type State = {
    blend: boolean,
    stencil: boolean,
    zequal: boolean,
    ztest: boolean,
    zwrite: boolean,
    culling: boolean
}

} // export namespace GpuDevice


export default GpuDevice;




