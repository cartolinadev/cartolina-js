/*
 * Blending of (multiple) textures in a framebuffer
 */


export class TextureBlend {
    private gl: WebGLRenderingContext;
    private framebuffer: WebGLFramebuffer | null;
    private width: number;
    private height: number;
    private program: WebGLProgram | null = null;
    private positionBuffer: WebGLBuffer | null = null;
    private currentTexture: WebGLTexture | null = null;

    // State to be restored
    private originalFramebuffer: WebGLFramebuffer | null;
    private originalProgram: WebGLProgram | null;
    private originalActiveTexture: GLenum;
    private originalTextureBinding: WebGLTexture | null;

    constructor(gl: WebGLRenderingContext, width: number, height: number) {
        this.gl = gl;
        this.width = width;
        this.height = height;

        // Save the current state to restore later
        this.originalFramebuffer = this.gl.getParameter(this.gl.FRAMEBUFFER_BINDING);
        this.originalProgram = this.gl.getParameter(this.gl.CURRENT_PROGRAM);
        this.originalActiveTexture = this.gl.getParameter(this.gl.ACTIVE_TEXTURE);
        this.originalTextureBinding = this.gl.getParameter(this.gl.TEXTURE_BINDING_2D);

        // Create framebuffer
        this.framebuffer = this.gl.createFramebuffer();
        this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, this.framebuffer);

        // Create a texture to attach to the framebuffer
        const fboTexture = this.gl.createTexture();
        this.gl.bindTexture(this.gl.TEXTURE_2D, fboTexture);
        this.gl.texImage2D(this.gl.TEXTURE_2D, 0, this.gl.RGBA, width, height, 0, this.gl.RGBA, this.gl.UNSIGNED_BYTE, null);
        this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_MIN_FILTER, this.gl.LINEAR);
        this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_MAG_FILTER, this.gl.LINEAR);
        this.gl.framebufferTexture2D(this.gl.FRAMEBUFFER, this.gl.COLOR_ATTACHMENT0, this.gl.TEXTURE_2D, fboTexture, 0);

        // Check if framebuffer was created successfully
        if (this.gl.checkFramebufferStatus(this.gl.FRAMEBUFFER) !== this.gl.FRAMEBUFFER_COMPLETE) {
            throw new Error('Framebuffer is not complete');
        }

        // Unbind framebuffer
        this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, null);

        // Compile and link shaders
        this.program = this.initShaderProgram();

        // Create a buffer for the position (full screen quad)
        this.positionBuffer = this.gl.createBuffer();
        this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.positionBuffer);
        const positions = new Float32Array([
            -1, -1, // bottom left
             1, -1, // bottom right
            -1,  1, // top left
             1,  1, // top right
        ]);
        this.gl.bufferData(this.gl.ARRAY_BUFFER, positions, this.gl.STATIC_DRAW);

        // Restore initial state (unbind framebuffer and buffers)
        this.restoreInitialState();
    }

    // Init function to clear the framebuffer
    init() {
        this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, this.framebuffer);
        this.gl.clearColor(0, 0, 0, 0);
        this.gl.clear(this.gl.COLOR_BUFFER_BIT);
        this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, null);
    }

    // Blend function to perform alpha blending
    blend(textureId: WebGLTexture, alpha: number) {
        // Bind the framebuffer for offscreen rendering
        this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, this.framebuffer);

        // Use blending shaders
        this.gl.useProgram(this.program);

        // Set alpha uniform
        const alphaLocation = this.gl.getUniformLocation(this.program!, 'u_alpha');
        this.gl.uniform1f(alphaLocation, alpha);

        // Bind position buffer and set attribute pointers
        const positionLocation = this.gl.getAttribLocation(this.program!, 'a_position');
        this.gl.enableVertexAttribArray(positionLocation);
        this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.positionBuffer);
        this.gl.vertexAttribPointer(positionLocation, 2, this.gl.FLOAT, false, 0, 0);

        // Bind texture
        const textureLocation = this.gl.getUniformLocation(this.program!, 'u_texture');
        this.gl.uniform1i(textureLocation, 0);
        this.gl.activeTexture(this.gl.TEXTURE0);
        this.gl.bindTexture(this.gl.TEXTURE_2D, textureId);

        // Enable blending and set the blend mode
        this.gl.enable(this.gl.BLEND);
        this.gl.blendFunc(this.gl.SRC_ALPHA, this.gl.ONE_MINUS_SRC_ALPHA);

        // Draw a full screen quad
        this.gl.drawArrays(this.gl.TRIANGLE_STRIP, 0, 4);

        // Unbind everything after blending
        this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, null);
        this.gl.disableVertexAttribArray(positionLocation);
    }

    // Copy the result from the framebuffer to the given texture
    copyResult(dstTexture: WebGLTexture) {
        // Bind the framebuffer where the blending result is stored
        this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, this.framebuffer);

        // Bind the destination texture
        this.gl.bindTexture(this.gl.TEXTURE_2D, dstTexture);

        // Copy the framebuffer content into the destination texture
        this.gl.copyTexSubImage2D(this.gl.TEXTURE_2D, 0, 0, 0, 0, 0, this.width, this.height);

        // Unbind framebuffer
        this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, null);
    }

    // Get framebuffer texture
    contents(): WebGLFramebuffer | null {
        return this.framebuffer;
    }

    // Cleanup on destruction and restore original WebGL state
    destroy() {
        if (this.framebuffer) {
            this.gl.deleteFramebuffer(this.framebuffer);
            this.framebuffer = null;
        }
        if (this.program) {
            this.gl.deleteProgram(this.program);
            this.program = null;
        }
        if (this.positionBuffer) {
            this.gl.deleteBuffer(this.positionBuffer);
            this.positionBuffer = null;
        }

        // Restore the WebGL state
        this.restoreInitialState();
    }

    // Restore the initial WebGL state (before this class modified it)
    private restoreInitialState() {
        this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, this.originalFramebuffer);
        this.gl.useProgram(this.originalProgram);
        this.gl.activeTexture(this.originalActiveTexture);
        this.gl.bindTexture(this.gl.TEXTURE_2D, this.originalTextureBinding);
    }

    // Compile shader
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

    // Initialize the shader program
    private initShaderProgram(): WebGLProgram {
        const vertexShaderSource = `
            attribute vec2 a_position;
            varying vec2 v_texCoord;
            void main() {
                v_texCoord = a_position * 0.5 + 0.5;
                gl_Position = vec4(a_position, 0.0, 1.0);
            }
        `;

        const fragmentShaderSource = `
            precision mediump float;
            uniform sampler2D u_texture;
            uniform float u_alpha;
            varying vec2 v_texCoord;
            void main() {
                vec4 texColor = texture2D(u_texture, v_texCoord);
                gl_FragColor = vec4(texColor.rgb * u_alpha, texColor.a * u_alpha);
            }
        `;

        const vertexShader = this.compileShader(vertexShaderSource, this.gl.VERTEX_SHADER);
        const fragmentShader = this.compileShader(fragmentShaderSource, this.gl.FRAGMENT_SHADER);

        const program = this.gl.createProgram()!;
        this.gl.attachShader(program, vertexShader);
        this.gl.attachShader(program, fragmentShader);
        this.gl.linkProgram(program);

        if (!this.gl.getProgramParameter(program, this.gl.LINK_STATUS)) {
            const error = this.gl.getProgramInfoLog(program);
            this.gl.deleteProgram(program);
            throw new Error('Program linking failed: ' + error);
        }

        this.gl.deleteShader(vertexShader);
        this.gl.deleteShader(fragmentShader);

        return program;
    }
}
