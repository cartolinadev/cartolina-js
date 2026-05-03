
import GpuProgram from './program';
import GpuTexture from './texture';
import Renderer from '../renderer';
import * as utils from '../../utils/utils';


/**
 * GpuDevice is not an abstraction of a GPU device. Here is what it does:
 *
 *   * it manages the canvas inside the map element and sets its size properly
 *     according to the provided CSS pixel size and device pixel ratio.
 *
 *   * it tracks the current render target and keeps framebuffer binding and the
 *     gl viewport in sync with it
 *
 *   * it abstracts various GL rendering flags (gl.BLEND, gl.STENCIL_TEST,
 *     gl.DEPTH) into a single state object, with getState and setState accessors.
 *
 *   * it provides a thin wrapper around gl.userProgram and gl.bindTexture
 *
 *   * it reads pixels from framebuffer-backed textures without exposing raw
 *     framebuffer binding as a public rendering operation
 */


export class GpuDevice {

    maxAttributesCount = 8;
    newAttributes = new Uint8Array(this.maxAttributesCount);
    enabledAttributes = new Uint8Array(this.maxAttributesCount);
    //noTextures = false; // never used

    renderer!: Renderer;
    div!: HTMLElement;
    defaultState!: GpuDevice.State;
    currentState!: GpuDevice.State;
    keepFrameBuffer!: boolean;
    antialias!: boolean;
    anisoLevel!: GLfloat;
    maxAniso!: GLfloat;
    activeTexture?: GLint;

    //currentOffset = 0; //used fot direct offset

    canvas!: HTMLCanvasElement;
    gl!: WebGL2RenderingContext
    currentProgram?: WebGLProgram;

    viewport!: Viewport;
    canvasRenderTarget!: GpuDevice.RenderTarget;
    currentRenderTarget!: GpuDevice.RenderTarget;
    anisoExt?: EXT_texture_filter_anisotropic | null;

constructor(renderer: Renderer, div: HTMLElement,
            keepFrameBuffer: boolean, antialias: boolean,
            aniso: GLfloat) {

    this.renderer = renderer;
    this.div = div;

    //state of device when first initialized
    this.defaultState = this.createState({blend:false, stencil:false,
        zequal: false, ztest:false, zwrite: false, culling:false});
    this.currentState = this.defaultState;

    this.keepFrameBuffer = keepFrameBuffer;
    this.antialias = antialias;
    this.anisoLevel = aniso;

    this.init();
};


private init() {

    var canvas = document.createElement('canvas');

    if (canvas == null) {
        //canvas not supported
        return;
    }

    this.canvas = canvas;
    canvas.style.display = 'block';
    this.div.appendChild(canvas);

    if (canvas.getContext == null) {
        //canvas not supported
        return;
    }

    canvas.addEventListener("webglcontextlost", this.contextLost.bind(this), false);
    canvas.addEventListener("webglcontextrestored", this.contextRestored.bind(this), false);

    const context = canvas.getContext('webgl2', 
        {preserveDrawingBuffer: this.keepFrameBuffer, antialias: this.antialias, stencil: true});

    if (!context) throw new Error('Error obtaining webgl2 context, webgl not supported?');

    let gl = this.gl = context;

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

    this.canvasRenderTarget = {
        kind: 'canvas',
        viewportSize: [canvas.width, canvas.height],
        logicalSize: [canvas.width, canvas.height]
    };
    this.currentRenderTarget = this.canvasRenderTarget;
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
};


contextLost(event: Event) {

    console.error('WebGL context lost', new Date().toISOString());
    event.preventDefault();
    this.renderer.core.contextLost = true;
    this.renderer.core.callListener('gpu-context-lost', {});
};


contextRestored(): void {

    this.renderer.core.callListener('gpu-context-restored', {});
};


resizeCanvas(cssSize: NumberPair, pixelSize: NumberPair) {

    let canvas = this.canvas;

    if (canvas != null) {
        canvas.width = pixelSize[0];
        canvas.height = pixelSize[1];
        canvas.style.width = cssSize[0] + 'px';
        canvas.style.height = cssSize[1] + 'px';

        __DEV__ && utils.logOnce(`canvas size: [${pixelSize[0]}, ${pixelSize[1]}], `
                + `canvas css size: [${cssSize[0]} ${cssSize[1]}]`);
    }

    if (this.canvasRenderTarget) {
        this.canvasRenderTarget.viewportSize = [...pixelSize];
        this.canvasRenderTarget.logicalSize = [...cssSize];
    }

    if (this.currentRenderTarget?.kind === 'canvas') {
        this.viewport = { width: pixelSize[0], height: pixelSize[1] };
    }
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

setRenderTarget(target: GpuDevice.RenderTarget) {

    this.currentRenderTarget = target;
    this.viewport = {
        width: target.viewportSize[0],
        height: target.viewportSize[1]
    };

    this.bindRenderTargetFramebuffer(target);
    this.setViewport();
}


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

    if (!texture.loaded) 
        throw new Error('Trying to bind a texture that is not loaded.');

    const gl = this.gl;

    const unit = (id == null ? 0 : id);
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, texture.texture);

    gl.activeTexture(gl.TEXTURE0);
}

readFramebufferPixels(
    texture: GpuTexture,
    x: number,
    y: number,
    lx: number,
    ly: number,
    data?: Uint8Array,
) : Uint8Array {

    if (!texture.framebuffer) {
        throw new Error('Cannot read pixels from a texture without '
            + 'a framebuffer.');
    }

    const gl = this.gl;
    this.bindFramebuffer(texture, gl.READ_FRAMEBUFFER);

    if (!data) {
        data = new Uint8Array(lx * ly * 4);
    }

    gl.readPixels(x, y, lx, ly, gl.RGBA, gl.UNSIGNED_BYTE, data);
    this.bindReadFramebufferForRenderTarget(this.currentRenderTarget);

    return data;
}

private bindRenderTargetFramebuffer(target: GpuDevice.RenderTarget) {

    this.bindFramebuffer(
        target.kind === 'canvas' ? null : target.texture,
        this.gl.FRAMEBUFFER,
    );
}

private bindReadFramebufferForRenderTarget(target: GpuDevice.RenderTarget) {

    this.bindFramebuffer(
        target.kind === 'canvas' ? null : target.texture,
        this.gl.READ_FRAMEBUFFER,
    );
}

private bindFramebuffer(texture: GpuTexture | null, target: GLenum) {

    if (texture) {

        if (!texture.framebuffer) {
            throw new Error('Cannot bind a texture without a framebuffer.');
        }

        this.gl.bindFramebuffer(target, texture.framebuffer);
        return;
    }

    this.gl.bindFramebuffer(target, null);
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

export type RenderTarget =
    | {
        kind: 'canvas',
        viewportSize: NumberPair,
        logicalSize: NumberPair
    }
    | {
        kind: 'framebuffer',
        texture: GpuTexture,
        viewportSize: NumberPair,
        logicalSize: NumberPair
    }

} // export namespace GpuDevice


export default GpuDevice;
