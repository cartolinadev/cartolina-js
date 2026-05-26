/*
 * drawtraversalmask.ts - manage UV-space terrain coverage masks
 */

import type { TileRenderRig } from './tile-render-rig';
import Renderer from '../renderer/renderer';
import GpuTexture from '../renderer/gpu/texture';
import type { GpuDevice } from '../renderer/gpu/device';


/**
 * Owns the small R8 render targets used by recursive terrain traversal.
 *
 * The pool keeps one node mask per recursion depth and one scratch mask
 * reused for footprint draws. It binds those textures only through
 * `GpuDevice` render targets; callers provide the traversal order.
 */
class DrawTraversalMaskPool {

    readonly resolution: number;

    private readonly renderer_: Renderer;
    private readonly size_: GpuDevice.NumberPair;
    private readonly nodeMasks_: GpuTexture[] = [];
    private readonly scratch_: GpuTexture;
    private quadVao_: WebGLVertexArrayObject | null = null;
    private quadBuffer_: WebGLBuffer | null = null;

    /**
     * @param renderer Renderer that owns the WebGL context.
     * @param resolution Width and height of every mask texture.
     */
    constructor(renderer: Renderer, resolution: number) {

        this.renderer_ = renderer;
        this.resolution = resolution;
        this.size_ = [resolution, resolution];
        this.scratch_ = this.createMask_();
    }

    /** Releases GPU resources owned by this pool. */
    dispose(): void {

        for (const texture of this.nodeMasks_) {

            texture[Symbol.dispose]();
        }

        this.nodeMasks_.length = 0;
        this.scratch_[Symbol.dispose]();

        const gl = this.renderer_.gpu.gl;
        gl.deleteVertexArray(this.quadVao_);
        gl.deleteBuffer(this.quadBuffer_);
        this.quadVao_ = null;
        this.quadBuffer_ = null;
    }

    /**
     * Return the node mask texture for a recursion depth.
     *
     * @param depth Recursion depth.
     * @returns R8 mask texture for the depth.
     */
    nodeMask(depth: number): GpuTexture {

        while (this.nodeMasks_.length <= depth) {

            this.nodeMasks_.push(this.createMask_());
        }

        return this.nodeMasks_[depth];
    }

    /**
     * Clear a node mask to uncovered.
     *
     * @param depth Recursion depth.
     */
    clearNode(depth: number): void {

        const gpu = this.renderer_.gpu;
        gpu.setTextureSpaceRenderTarget(this.nodeMask(depth), this.size_);
        gpu.clearColor([0, 0, 0, 255]);
    }

    /**
     * Draw a terrain tile's footprint into scratch, then OR it into a node.
     *
     * @param rig Ready tile render rig.
     * @param depth Recursion depth of the destination node mask.
     */
    addFootprint(rig: TileRenderRig, depth: number): void {

        const gpu = this.renderer_.gpu;
        const previousState = gpu.currentState;
        const footprintState = gpu.createState({
            culling: false,
            ztest: false,
            zwrite: false,
        });

        gpu.setTextureSpaceRenderTarget(this.scratch_, this.size_);
        gpu.setState(footprintState);
        gpu.clearColor([0, 0, 0, 255]);
        rig.footprint();
        gpu.setState(previousState, true);

        this.orTextureIntoNode_(this.scratch_, depth);
    }

    /**
     * Blit a child node mask into its quadrant of the parent node mask.
     *
     * @param childDepth Recursion depth of the source child node.
     * @param parentDepth Recursion depth of the destination parent node.
     * @param quadrant Child quadrant index: 0 upper-left, 1 upper-right,
     *     2 lower-left, 3 lower-right.
     */
    blitChildToParent(
        childDepth: number,
        parentDepth: number,
        quadrant: number,
    ): void {

        const gpu = this.renderer_.gpu;
        const half = this.resolution >> 1;
        const x = (quadrant & 1) ? half : 0;
        const y = (quadrant & 2) ? half : 0;

        gpu.setTextureSpaceRenderTarget(this.nodeMask(parentDepth), this.size_);
        gpu.setViewport(x, y, half, half);
        this.drawOrQuad_(this.nodeMask(childDepth));
        gpu.setViewport(0, 0, this.resolution, this.resolution);
    }

    private orTextureIntoNode_(texture: GpuTexture, depth: number): void {

        const gpu = this.renderer_.gpu;
        gpu.setTextureSpaceRenderTarget(this.nodeMask(depth), this.size_);
        this.drawOrQuad_(texture);
    }

    private drawOrQuad_(texture: GpuTexture): void {

        const renderer = this.renderer_;
        const gl = renderer.gpu.gl;
        const program = renderer.programTileMaskBlit();

        renderer.gpu.useProgram2(program);
        renderer.gpu.bindTexture(texture, renderer.textureIdxs.maskBlit);

        const previousState = renderer.gpu.currentState;
        const state = renderer.gpu.createState({
            blend: true,
            culling: false,
            ztest: false,
            zwrite: false,
        });

        renderer.gpu.setState(state);
        gl.blendEquation(gl.MAX);
        gl.blendFunc(gl.ONE, gl.ONE);

        this.bindQuad_(program);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        gl.bindVertexArray(null);

        renderer.gpu.setState(previousState, true);
    }

    private bindQuad_(program: ReturnType<Renderer['programTileMaskBlit']>)
        : void {

        const gl = this.renderer_.gpu.gl;

        if (!this.quadVao_) {

            const vertices = new Float32Array([
                -1, -1,
                 1, -1,
                -1,  1,
                 1,  1,
            ]);

            this.quadBuffer_ = gl.createBuffer();
            this.quadVao_ = gl.createVertexArray();
            gl.bindVertexArray(this.quadVao_);
            gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer_);
            gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW);

            const location = program.getAttribLocation('aPosition');
            gl.enableVertexAttribArray(location);
            gl.vertexAttribPointer(location, 2, gl.FLOAT, false, 0, 0);

        } else {

            gl.bindVertexArray(this.quadVao_);
        }
    }

    private createMask_(): GpuTexture {

        const texture = new GpuTexture(
            this.renderer_.gpu,
            null,
            this.renderer_.core,
        );
        const data = new Uint8Array(this.resolution * this.resolution);
        texture.createFromData(
            this.resolution,
            this.resolution,
            data,
            GpuTexture.Type.Mask,
            'nearest',
        );
        texture.createFramebuffer(this.resolution, this.resolution);
        return texture;
    }
}

export default DrawTraversalMaskPool;
