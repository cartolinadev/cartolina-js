
import GpuProgram from './program';
import GpuTexture from './texture';
import Renderer from '../renderer';
import * as utils from '../../utils/utils';


/**
 * GpuDevice, despite its name, is not an abstraction of a GPU device.
 * Here is what it does:
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
 *   * it provides a thin wrapper around gl.useProgram and gl.bindTexture
 *
 *   * it reads pixels from framebuffer-backed textures without exposing raw
 *     framebuffer binding as a public rendering operation
 */


export class GpuDevice {

    /**
     * Renderer that owns this WebGL context.
     */
    renderer!: Renderer;

    /**
     * DOM container that receives the managed canvas.
     */
    div!: HTMLElement;

    /**
     * Canvas element whose default framebuffer is the base render target.
     */
    canvas!: HTMLCanvasElement;

    /**
     * WebGL2 context used by all renderer GPU objects.
     */
    gl!: WebGL2RenderingContext;

    /**
     * Current drawing destination. All draw-target changes should go through
     * `setRenderTarget()` so framebuffer and viewport state stay in sync.
     */
    private renderTarget_!: GpuDevice.RenderTarget;

    /**
     * Cached GL viewport dimensions for the current render target.
     */
    viewport!: Viewport;

    /**
     * Cached WebGL fixed-function state managed by `setState()`.
     */
    currentState!: GpuDevice.State;

    /**
     * Initial fixed-function state used as the renderer baseline.
     */
    defaultState!: GpuDevice.State;

    /**
     * Currently bound GPU program, used to skip redundant gl.useProgram calls.
     */
    currentProgram?: GpuProgram;

    /**
     * Whether the default framebuffer should preserve contents for screenshots.
     */
    keepFrameBuffer!: boolean;

    /**
     * Whether the WebGL context was requested with antialiasing enabled.
     */
    antialias!: boolean;

    /**
     * Requested anisotropic filtering level, clamped to the device maximum.
     */
    anisoLevel!: GLfloat;

    /**
     * Maximum anisotropic filtering level reported by the browser.
     */
    maxAniso!: GLfloat;

    /**
     * Optional anisotropic filtering extension.
     */
    anisoExt?: EXT_texture_filter_anisotropic | null;

    /**
     * @deprecated Used only by legacy `useProgram()` attribute toggling.
     */
    maxAttributesCount = 8;

    /**
     * @deprecated Scratch buffer used only by legacy `useProgram()`.
     */
    newAttributes = new Uint8Array(this.maxAttributesCount);

    /**
     * @deprecated Attribute-enable cache used only by legacy `useProgram()`.
     */
    enabledAttributes = new Uint8Array(this.maxAttributesCount);

/**
 * Create the WebGL canvas/context wrapper for a renderer.
 *
 * @param renderer Renderer that owns this device.
 * @param div DOM container that receives the created canvas.
 * @param keepFrameBuffer Whether the canvas should preserve drawing buffer
 * contents for screenshots.
 * @param antialias Whether to request an antialiased WebGL context.
 * @param aniso Requested anisotropic filtering level.
 */
constructor(
    renderer: Renderer,
    div: HTMLElement,
    keepFrameBuffer: boolean,
    antialias: boolean,
    aniso: GLfloat
) {

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

    this.renderTarget_ = {
        kind: 'canvas',
        viewportSize: [canvas.width, canvas.height],
        logicalSize: [canvas.width, canvas.height]
    };
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


/**
 * Resize the managed canvas element.
 *
 * The upper renderer layer owns size calculation. `GpuDevice` only applies
 * the CSS and backing-store sizes to the canvas and refreshes the active
 * viewport cache when the canvas target is currently bound.
 *
 * @param cssSize Canvas layout size in CSS pixels.
 * @param pixelSize Canvas backing-store size in physical pixels.
 */
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

    if (this.renderTarget_?.kind === 'canvas') {
        this.viewport = { width: pixelSize[0], height: pixelSize[1] };
    }
};


/**
 * Clamp and store the requested anisotropic filtering level.
 *
 * @param aniso Requested anisotropic filtering level, or -1 for maximum.
 */
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


/**
 * Get the managed canvas element.
 *
 * @returns Canvas element owned by this device.
 */
getCanvas(): HTMLCanvasElement {
    return this.canvas;
};


/**
 * Current drawing destination.
 *
 * `setRenderTarget()` is the only public operation that changes the active
 * target. This getter lets renderer code inspect the target that is already
 * bound without allowing assignment through `gpu.currentRenderTarget = ...`.
 */
get currentRenderTarget(): Readonly<GpuDevice.RenderTarget> {

    return this.renderTarget_;
}


/**
 * Bind a render target as the active drawing destination.
 *
 * This is the public draw-target switch. It updates `currentRenderTarget`,
 * binds the target framebuffer, caches its viewport size, and applies the GL
 * viewport. Callers that need to render to the canvas should provide a canvas
 * target built from the renderer's current canvas sizes.
 *
 * @param target Canvas or framebuffer target to draw into.
 */
setRenderTarget(target: GpuDevice.RenderTarget) {

    this.renderTarget_ = target;
    this.viewport = {
        width: target.viewportSize[0],
        height: target.viewportSize[1]
    };

    this.bindRenderTargetFramebuffer(target);
    this.applyViewport();
}


/**
 * Clear the active render target.
 *
 * @param clearDepth Whether to clear the depth buffer.
 * @param clearColor Whether to clear the color buffer.
 * @param color Clear color in 0-255 RGBA components.
 */
clear(clearDepth: boolean, clearColor: boolean, color : Color): void {

    if (color != null) {
        this.gl.clearColor(color[0]/255, color[1]/255, color[2]/255, color[3]/255);
    }

    this.gl.clear((clearColor ? this.gl.COLOR_BUFFER_BIT : 0) |
                  (clearDepth ? this.gl.DEPTH_BUFFER_BIT : 0) );
};

/**
 * Binds a program without touching vertex attributes or sampler uniforms.
 *
 * The caller is responsible for configuring vertex attributes and sampler
 * uniforms explicitly. New rendering code should use this method instead of
 * `useProgram()`.
 *
 * @param program GPU program object to use.
 */
useProgram2(program: GpuProgram) {

    if (this.currentProgram != program) {

        this.gl.useProgram(program.program);
        this.currentProgram = program;
    }
}

/**
 * Bind a loaded texture to a texture unit.
 *
 * @param texture Texture to bind.
 * @param id Texture unit index. Unit 0 is used when omitted.
 */
bindTexture(texture: GpuTexture, id?: GLint) {

    if (!texture.loaded) 
        throw new Error('Trying to bind a texture that is not loaded.');

    const gl = this.gl;

    const unit = (id == null ? 0 : id);
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, texture.texture);

    gl.activeTexture(gl.TEXTURE0);
}

/**
 * Read pixels from a framebuffer-backed texture without changing the
 * tracked render target.
 *
 * This temporarily binds the texture framebuffer as the WebGL read
 * framebuffer, performs `gl.readPixels()`, then restores the read
 * framebuffer that belongs to `currentRenderTarget`. Draw-target changes
 * must still go through `setRenderTarget()`.
 *
 * @param texture Framebuffer-backed texture to read from.
 * @param x Left coordinate in framebuffer pixels.
 * @param y Bottom coordinate in framebuffer pixels.
 * @param lx Width of the read rectangle in pixels.
 * @param ly Height of the read rectangle in pixels.
 * @param data Optional destination buffer. A new buffer is allocated when
 * omitted.
 * @returns Pixel data in RGBA/UNSIGNED_BYTE layout.
 */
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
    this.bindReadFramebufferForRenderTarget(this.renderTarget_);

    return data;
}

private bindRenderTargetFramebuffer(target: GpuDevice.RenderTarget) {

    this.bindFramebuffer(
        target.kind === 'canvas' ? null : target.texture,
        this.gl.FRAMEBUFFER,
    );
}

private applyViewport() {

    this.gl.viewport(0, 0, this.viewport.width, this.viewport.height);
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

/**
 * Fill unspecified fixed-function state flags with renderer defaults.
 *
 * @param state Legacy state object to normalize in place.
 * @returns The normalized state object.
 */
createState(state: GpuDevice.State): GpuDevice.State {

    if (state.blend == null) { state.blend = false; }
    if (state.stencil == null) { state.stencil = false; }
    if (state.zwrite == null) { state.zwrite = true; }
    if (state.ztest == null) { state.ztest = true; }
    if (state.zequal == null) { state.zequal = false; }
    if (state.culling == null) { state.culling = true; }

    return state;
};


/**
 * Apply WebGL fixed-function state changes.
 *
 * @param state Desired fixed-function state. Missing/null state is ignored for
 * legacy callers.
 */
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

/**
 * @deprecated Legacy program binding API. It silently assigns sampler
 * uniforms and toggles global vertex-attribute enable state. New code should
 * use `useProgram2()` and configure attributes/samplers explicitly.
 *
 * @param program GPU program object to use.
 * @param attributes Attribute names to enable for the bound program.
 * @param nextSampler Whether to bind legacy `uSampler2` to texture unit 1.
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

        // Legacy path only: newer mesh rendering calls useProgram2(), then
        // GpuMesh.draw2() binds attributes through a VAO built from the
        // attribute names passed by the caller.
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

} // class GpuDevice

// local types
type NumberPair = [number, number];
type Color = [number, number, number, number]

type Viewport = { width: number, height: number }

// exported types
export namespace GpuDevice {

/**
 * Cached WebGL fixed-function state managed by `GpuDevice.setState()`.
 */
export type State = {
    blend: boolean,
    stencil: boolean,
    zequal: boolean,
    ztest: boolean,
    zwrite: boolean,
    culling: boolean
}

/**
 * Shared size fields for every drawing destination tracked by `GpuDevice`.
 */
export type RenderTargetBase = {

    /**
     * GL viewport/backing-store size, in physical pixels. This is passed to
     * `gl.viewport()`.
     *
     * For the base canvas target this is the canvas backing size
     * (`canvas.width`, `canvas.height`). For framebuffer targets this is the
     * texture/framebuffer storage size.
     */
    viewportSize: NumberPair,

    /**
     * Target-local 2D coordinate size used by renderer projection and
     * screen-space draw helpers.
     *
     * For the base canvas target this is the pre-transform canvas layout size
     * in CSS pixels. For current auxiliary hitmap targets this is the hitmap
     * texture size.
     */
    logicalSize: NumberPair
}

/**
 * Drawing destination backed by the default canvas framebuffer.
 */
export type CanvasTarget = RenderTargetBase & {
    kind: 'canvas'
}

/**
 * Drawing destination backed by a texture framebuffer.
 */
export type FramebufferTarget = RenderTargetBase & {

    /**
     * Texture whose framebuffer is bound when this target is active.
     */
    texture: GpuTexture,

    kind: 'framebuffer'
}

/**
 * Active drawing destination tracked by `GpuDevice`.
 */
export type RenderTarget = CanvasTarget | FramebufferTarget

} // export namespace GpuDevice


export default GpuDevice;
