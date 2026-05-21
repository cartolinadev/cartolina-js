/*
 * TextureBlend — offscreen texture blending in two modes:
 *
 * 'trivial'    Raw RGBA hardware alpha-blend into a single FBO. Used
 *              by the legacy MapDraw bump-map path.
 *
 * 'oct-normal' Decode octahedral RG normals from both the source and
 *              the accumulated result, lerp in ℝ³, normalize, and
 *              re-encode as octahedral RG. Ping-pong between two FBOs
 *              so each step can read the previous accumulator without
 *              framebuffer feedback. Used by TileRenderRig collapse.
 *
 * The mode is selected per blend sequence via init().
 */


export class TextureBlend {

    private gl: WebGLRenderingContext;
    private width: number;
    private height: number;
    private trivialProgram: WebGLProgram | null;
    private octNormalProgram: WebGLProgram | null;
    private positionBuffer: WebGLBuffer | null;

    // fboA is the sole target in trivial mode.
    // In oct-normal mode both FBOs ping-pong.
    private fboA: WebGLFramebuffer | null;
    private texA: WebGLTexture | null;
    private fboB: WebGLFramebuffer | null;
    private texB: WebGLTexture | null;

    private accumIsA: boolean = true;
    private mode: 'trivial' | 'oct-normal' = 'trivial';

    // In trivial mode accumFbo is always fboA (accumIsA never flips).
    private get accumFbo() { return this.accumIsA ? this.fboA : this.fboB; }
    private get accumTex() { return this.accumIsA ? this.texA : this.texB; }
    private get writeFbo() { return this.accumIsA ? this.fboB : this.fboA; }

    // State to restore after the init/blend*/copyResult sequence.
    private originalFramebuffer: WebGLFramebuffer | null = null;
    private originalProgram: WebGLProgram | null = null;
    private originalActiveTexture: GLenum = 0;
    private originalTextureBinding: WebGLTexture | null = null;
    private originalViewport: Int32Array | null = null;
    private originalBlendEnabled: boolean = false;

    constructor(gl: WebGLRenderingContext, width: number, height: number) {

        this.gl = gl;
        this.width = width;
        this.height = height;

        this.storeInitialState();

        [this.fboA, this.texA] = this.createFbo();
        [this.fboB, this.texB] = this.createFbo();

        this.trivialProgram = this.initShaderProgram('trivial');
        this.octNormalProgram = this.initShaderProgram('oct-normal');

        this.positionBuffer = this.gl.createBuffer();
        this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.positionBuffer);
        this.gl.bufferData(this.gl.ARRAY_BUFFER,
            new Float32Array([-1, -1,  1, -1,  -1, 1,  1, 1]),
            this.gl.STATIC_DRAW);

        this.restoreInitialState();
    }

    /**
     * Begin a blend sequence in the given mode (default 'trivial').
     * Saves GL state for restoration after copyResult().
     */
    init(mode: 'trivial' | 'oct-normal' = 'trivial') {

        this.storeInitialState();
        this.mode = mode;
        this.accumIsA = true;

        if (mode === 'trivial') {
            this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, this.fboA);
            this.gl.clearColor(0, 0, 0, 0);
            this.gl.clear(this.gl.COLOR_BUFFER_BIT);
            this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, null);
        }

        // oct-normal: no clear needed — first blend always has alpha 1.0,
        // making the accumulator contribution zero.
    }

    blend(sourceTexture: WebGLTexture, alpha: number) {

        if (this.mode === 'trivial')
            this.blendTrivial(sourceTexture, alpha);
        else
            this.blendOctNormal(sourceTexture, alpha);
    }

    /** Copy the accumulated result into dstTexture and restore GL state. */
    copyResult(dstTexture: WebGLTexture) {

        const gl = this.gl;
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.accumFbo);
        gl.bindTexture(gl.TEXTURE_2D, dstTexture);
        gl.copyTexSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 0, 0,
            this.width, this.height);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        this.restoreInitialState();
    }

    /** Return the current accumulator framebuffer. */
    contents(): WebGLFramebuffer | null {
        return this.accumFbo;
    }

    destroy() {

        const gl = this.gl;
        if (this.fboA) { gl.deleteFramebuffer(this.fboA); this.fboA = null; }
        if (this.texA) { gl.deleteTexture(this.texA); this.texA = null; }
        if (this.fboB) { gl.deleteFramebuffer(this.fboB); this.fboB = null; }
        if (this.texB) { gl.deleteTexture(this.texB); this.texB = null; }
        if (this.trivialProgram) {
            gl.deleteProgram(this.trivialProgram);
            this.trivialProgram = null;
        }
        if (this.octNormalProgram) {
            gl.deleteProgram(this.octNormalProgram);
            this.octNormalProgram = null;
        }
        if (this.positionBuffer) {
            gl.deleteBuffer(this.positionBuffer);
            this.positionBuffer = null;
        }
    }

    // ---------------------------------------------------------------

    private blendTrivial(sourceTexture: WebGLTexture, alpha: number) {

        const gl = this.gl;
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.fboA);
        gl.viewport(0, 0, this.width, this.height);
        gl.useProgram(this.trivialProgram);

        gl.activeTexture(gl.TEXTURE0 + 5);
        gl.bindTexture(gl.TEXTURE_2D, sourceTexture);
        gl.uniform1i(
            gl.getUniformLocation(this.trivialProgram!, 'u_texture'), 5);
        gl.uniform1f(
            gl.getUniformLocation(this.trivialProgram!, 'u_alpha'), alpha);

        const posLoc =
            gl.getAttribLocation(this.trivialProgram!, 'a_position');
        gl.enableVertexAttribArray(posLoc);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.positionBuffer);
        gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);

        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        // trivial mode never swaps — fboA is always the accumulator
    }

    private blendOctNormal(sourceTexture: WebGLTexture, alpha: number) {

        const gl = this.gl;
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.writeFbo);
        gl.viewport(0, 0, this.width, this.height);
        gl.disable(gl.BLEND);
        gl.useProgram(this.octNormalProgram);

        gl.activeTexture(gl.TEXTURE0 + 5);
        gl.bindTexture(gl.TEXTURE_2D, sourceTexture);
        gl.uniform1i(
            gl.getUniformLocation(this.octNormalProgram!, 'u_texture'), 5);

        gl.activeTexture(gl.TEXTURE0 + 6);
        gl.bindTexture(gl.TEXTURE_2D, this.accumTex);
        gl.uniform1i(
            gl.getUniformLocation(this.octNormalProgram!, 'u_accum'), 6);

        gl.uniform1f(
            gl.getUniformLocation(this.octNormalProgram!, 'u_alpha'), alpha);

        const posLoc =
            gl.getAttribLocation(this.octNormalProgram!, 'a_position');
        gl.enableVertexAttribArray(posLoc);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.positionBuffer);
        gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);

        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);

        this.accumIsA = !this.accumIsA;
    }

    // ---------------------------------------------------------------

    private createFbo(): [WebGLFramebuffer | null, WebGLTexture | null] {

        const gl = this.gl;
        const fbo = gl.createFramebuffer();
        gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);

        const tex = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA,
            this.width, this.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0,
            gl.TEXTURE_2D, tex, 0);

        if (gl.checkFramebufferStatus(gl.FRAMEBUFFER)
                !== gl.FRAMEBUFFER_COMPLETE)
            throw new Error('Framebuffer is not complete');

        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        return [fbo, tex];
    }

    private storeInitialState() {

        const gl = this.gl;
        this.originalViewport =
            gl.getParameter(gl.VIEWPORT) as Int32Array;
        this.originalFramebuffer =
            gl.getParameter(gl.FRAMEBUFFER_BINDING);
        this.originalProgram =
            gl.getParameter(gl.CURRENT_PROGRAM);
        this.originalActiveTexture =
            gl.getParameter(gl.ACTIVE_TEXTURE);
        this.originalTextureBinding =
            gl.getParameter(gl.TEXTURE_BINDING_2D);
        this.originalBlendEnabled =
            gl.getParameter(gl.BLEND) as boolean;
    }

    /*
     * WARN:
     * Restores only part of the state changed by blend(). Array-buffer
     * binding and vertex attribute enables are left as-is, so caller-side
     * state caches can drift from actual GL state after this runs.
     */
    private restoreInitialState() {

        const gl = this.gl;
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.originalFramebuffer);
        gl.useProgram(this.originalProgram);
        gl.activeTexture(this.originalActiveTexture);
        gl.bindTexture(gl.TEXTURE_2D, this.originalTextureBinding);
        gl.viewport(
            this.originalViewport![0], this.originalViewport![1],
            this.originalViewport![2], this.originalViewport![3]);
        if (this.originalBlendEnabled) gl.enable(gl.BLEND);
        else gl.disable(gl.BLEND);
    }

    private compileShader(source: string, type: number): WebGLShader {

        const shader = this.gl.createShader(type)!;
        this.gl.shaderSource(shader, source);
        this.gl.compileShader(shader);

        if (!this.gl.getShaderParameter(shader, this.gl.COMPILE_STATUS)) {
            const error = this.gl.getShaderInfoLog(shader);
            this.gl.deleteShader(shader);
            throw new Error('Shader compilation failed: ' + error);
        }

        return shader;
    }

    private initShaderProgram(mode: 'trivial' | 'oct-normal'): WebGLProgram {

        const vert = `
            precision mediump float;
            attribute vec2 a_position;
            varying vec2 v_uv;
            void main() {
                v_uv = a_position * 0.5 + 0.5;
                gl_Position = vec4(a_position, 0.0, 1.0);
            }
        `;

        const trivialFrag = `
            precision mediump float;
            uniform sampler2D u_texture;
            uniform float u_alpha;
            varying vec2 v_uv;
            void main() {
                vec4 c = texture2D(u_texture, v_uv);
                gl_FragColor = vec4(c.rgb, u_alpha);
            }
        `;

        /* Decode both inputs from octahedral RG, lerp in R³, normalize,
         * re-encode. The fold step handles z < 0, which can occur for
         * overhanging surfaces in the ellipsoid tangent frame. */
        const octNormalFrag = `
            precision mediump float;
            uniform sampler2D u_texture;
            uniform sampler2D u_accum;
            uniform float u_alpha;
            varying vec2 v_uv;

            vec3 decodeOct(vec2 rg) {
                vec2 p = rg * 2.0 - 1.0;
                vec3 n = vec3(p, 1.0 - abs(p.x) - abs(p.y));
                float t = clamp(-n.z, 0.0, 1.0);
                n.xy += vec2(p.x >= 0.0 ? -t : t,
                             p.y >= 0.0 ? -t : t);
                return normalize(n);
            }

            vec2 encodeOct(vec3 n) {
                n /= (abs(n.x) + abs(n.y) + abs(n.z));
                vec2 p = n.z >= 0.0
                    ? n.xy
                    : (1.0 - abs(n.yx)) * sign(n.xy);
                return p * 0.5 + 0.5;
            }

            void main() {
                vec3 src = decodeOct(texture2D(u_texture, v_uv).rg);
                vec3 acc = decodeOct(texture2D(u_accum,   v_uv).rg);
                vec3 blended = normalize(mix(acc, src, u_alpha));
                gl_FragColor = vec4(encodeOct(blended), 0.5, 1.0);
            }
        `;

        const frag = mode === 'trivial' ? trivialFrag : octNormalFrag;
        const vertShader = this.compileShader(vert, this.gl.VERTEX_SHADER);
        const fragShader = this.compileShader(frag, this.gl.FRAGMENT_SHADER);

        const program = this.gl.createProgram()!;
        this.gl.attachShader(program, vertShader);
        this.gl.attachShader(program, fragShader);
        this.gl.linkProgram(program);

        if (!this.gl.getProgramParameter(program, this.gl.LINK_STATUS)) {
            const error = this.gl.getProgramInfoLog(program);
            this.gl.deleteProgram(program);
            throw new Error('Program linking failed: ' + error);
        }

        this.gl.deleteShader(vertShader);
        this.gl.deleteShader(fragShader);

        return program;
    }
}
