/*
 * drawtraversalmask.ts - manage UV-space terrain coverage masks
 */

import type { TileRenderRig } from './tile-render-rig';
import Renderer from '../renderer/renderer';
import type GpuProgram from '../renderer/gpu/program';
import GpuTexture from '../renderer/gpu/texture';
import type { GpuDevice } from '../renderer/gpu/device';


/**
 * Owns the coverage masks used by recursive terrain traversal.
 *
 * A node's coverage is the union of two coexisting parts that never
 * replace each other:
 *
 *   - a list of axis-aligned rectangles in the node's UV [0,1] space,
 *     carrying all dyadic coverage (watertight cells and the LOD
 *     hierarchy). Rectangles transform up the tree on the CPU with no
 *     framebuffer touched and stay exact at any scale; and
 *   - a per-depth footprint texture holding only the non-rectangular
 *     coverage produced by non-watertight tiles. It is allocated lazily
 *     and stays empty in the common watertight case.
 *
 * Rectangles are rasterized into a texture only when a draw actually
 * samples the mask (`materialize`), so most of the per-frame framebuffer
 * churn of the earlier eager fill/blit scheme disappears.
 */
class DrawTraversalMaskPool {

    readonly resolution: number;

    private readonly renderer_: Renderer;
    private readonly size_: GpuDevice.NumberPair;

    // Per recursion depth: footprint-only coverage texture and a flag
    // for whether it currently holds anything.
    private readonly nodeMasks_: GpuTexture[] = [];
    private readonly hasFootprint_: boolean[] = [];

    // Per recursion depth: dyadic coverage as UV-space rectangles.
    private readonly rects_: MaskRect[][] = [];

    private readonly scratch_: GpuTexture;
    private readonly consume_: GpuTexture;
    private readonly footprintState_: GpuDevice.State;
    private readonly blitState_: GpuDevice.State;
    private readonly erodeState_: GpuDevice.State;
    private quadVao_: WebGLVertexArrayObject | null = null;
    private quadBuffer_: WebGLBuffer | null = null;

    // Dynamic geometry for single-draw rectangle rasterization.
    private rectVao_: WebGLVertexArrayObject | null = null;
    private rectBuffer_: WebGLBuffer | null = null;
    private rectVerts_ = new Float32Array(0);

    /**
     * @param renderer Renderer that owns the WebGL context.
     * @param resolution Width and height of every mask texture.
     */
    constructor(renderer: Renderer, resolution: number) {

        this.renderer_ = renderer;
        this.resolution = resolution;
        this.size_ = [resolution, resolution];
        this.scratch_ = this.createMask();
        this.consume_ = this.createMask();

        // Pre-allocate the two GPU states. The footprint state writes
        // opaque coverage (footprint draws and rectangle rasterization);
        // the blit state OR-composites a texture with a MAX blend.
        // Recreating these every call would allocate on the hot path.
        this.footprintState_ = renderer.gpu.createState({
            culling: false,
            ztest: false,
            zwrite: false,
        });
        this.blitState_ = renderer.gpu.createState({
            blend: true,
            culling: false,
            ztest: false,
            zwrite: false,
        });
        this.erodeState_ = renderer.gpu.createState({
            culling: false,
            ztest: false,
            zwrite: false,
        });
    }

    /** Releases GPU resources owned by this pool. */
    dispose(): void {

        for (const texture of this.nodeMasks_) {

            texture[Symbol.dispose]();
        }

        this.nodeMasks_.length = 0;
        this.scratch_[Symbol.dispose]();
        this.consume_[Symbol.dispose]();

        const gl = this.renderer_.gpu.gl;
        gl.deleteVertexArray(this.quadVao_);
        gl.deleteBuffer(this.quadBuffer_);
        gl.deleteVertexArray(this.rectVao_);
        gl.deleteBuffer(this.rectBuffer_);
        this.quadVao_ = null;
        this.quadBuffer_ = null;
        this.rectVao_ = null;
        this.rectBuffer_ = null;
    }

    /**
     * Reset a depth's coverage to empty. Called once at node entry.
     *
     * With rectangles there is no GPU clear to defer, so this is a CPU
     * reset and no lazy-init guard is needed.
     *
     * @param depth Recursion depth.
     */
    resetCoverage(depth: number): void {

        this.ensureDepth(depth);
        this.rects_[depth].length = 0;
        this.hasFootprint_[depth] = false;
    }

    /**
     * Whether a depth currently holds any coverage to sample.
     *
     * @param depth Recursion depth.
     * @returns True if either a rectangle or footprint coverage exists.
     */
    hasCoverage(depth: number): boolean {

        return this.rects_[depth].length > 0 || this.hasFootprint_[depth];
    }

    /**
     * Add the unit-quadrant rectangles named by a four-bit mask.
     *
     * @param depth Recursion depth of the destination node.
     * @param quadrantMask Four-bit mask in traversal quadrant order.
     */
    addQuadrantRects(depth: number, quadrantMask: number): void {

        if (quadrantMask === 0) return;

        const rects = this.rects_[depth];

        for (let quadrant = 0; quadrant < 4; quadrant++) {

            if ((quadrantMask & (1 << quadrant)) === 0) continue;

            // A quadrant occupies a half-unit square of the node cell.
            const qx = (quadrant & 1) ? 0.5 : 0;
            const qy = (quadrant & 2) ? 0.5 : 0;
            rects.push({ x0: qx, y0: qy, x1: qx + 0.5, y1: qy + 0.5 });
        }
    }

    /**
     * Fold a child node's coverage into its quadrant of the parent.
     *
     * The two parts are handled independently: dyadic rectangles map up
     * by a CPU scale-and-offset, and footprint coverage (if any) is
     * blitted into the parent quadrant texture.
     *
     * @param childDepth Recursion depth of the source child node.
     * @param parentDepth Recursion depth of the destination parent node.
     * @param quadrant Child quadrant index: 0 lower-left, 1 lower-right,
     *     2 upper-left, 3 upper-right.
     */
    appendChild(
        childDepth: number,
        parentDepth: number,
        quadrant: number,
    ): void {

        // Map child UV into the parent quadrant: halve and shift.
        const qx = (quadrant & 1) ? 0.5 : 0;
        const qy = (quadrant & 2) ? 0.5 : 0;

        const childRects = this.rects_[childDepth];
        const parentRects = this.rects_[parentDepth];

        for (const rect of childRects) {

            parentRects.push({
                x0: rect.x0 * 0.5 + qx,
                y0: rect.y0 * 0.5 + qy,
                x1: rect.x1 * 0.5 + qx,
                y1: rect.y1 * 0.5 + qy,
            });
        }

        // Footprint coverage is non-rectangular, so it can only travel up
        // as a rasterized blit. Skip entirely when the child has none.
        if (!this.hasFootprint_[childDepth]) return;

        const gpu = this.renderer_.gpu;
        const previousTarget = gpu.currentRenderTarget;
        const half = this.resolution >> 1;
        const x = (quadrant & 1) ? half : 0;
        const y = (quadrant & 2) ? half : 0;

        this.ensureFootprintTarget(parentDepth);
        gpu.setTextureSpaceRenderTarget(this.nodeMask(parentDepth), this.size_);
        gpu.setViewport(x, y, half, half);
        this.drawOrQuad(this.nodeMask(childDepth));

        // rebinding the target also restores its full viewport
        gpu.setRenderTarget(previousTarget);
    }

    /**
     * Draw a non-watertight tile's footprint into the depth's footprint
     * texture. The rectangle list is left untouched.
     *
     * @param rig Ready tile render rig.
     * @param depth Recursion depth of the destination node.
     */
    addFootprint(rig: TileRenderRig, depth: number): void {

        const gpu = this.renderer_.gpu;
        const previousTarget = gpu.currentRenderTarget;

        this.ensureFootprintTarget(depth);

        // Rasterize the mesh footprint into scratch, then OR it into the
        // depth's footprint texture so several footprints accumulate.
        const previousState = gpu.currentState;

        gpu.setTextureSpaceRenderTarget(this.scratch_, this.size_);
        gpu.setState(this.footprintState_);
        gpu.clearColor(MaskClearUncovered);
        rig.footprint();
        gpu.setState(previousState, true);

        this.orTextureIntoNode(this.scratch_, depth);
        gpu.setRenderTarget(previousTarget);
    }

    /**
     * Build the single texture a consumer samples for this depth.
     *
     * The footprint texture (when present) and the exact rectangles are
     * combined into a transient texture without disturbing either stored
     * part, so backtrack can still propagate rectangles and footprints
     * separately.
     *
     * @param depth Recursion depth being consumed.
     * @param erosion Radius in texels. Only 0 and 1 are supported.
     * @returns The combined coverage texture.
     */
    materialize(depth: number, erosion: number): GpuTexture {

        const gpu = this.renderer_.gpu;
        const previousTarget = gpu.currentRenderTarget;

        gpu.setTextureSpaceRenderTarget(this.consume_, this.size_);
        gpu.clearColor(MaskClearUncovered);

        // Footprint first (arbitrary shape), exact rectangles on top.
        if (this.hasFootprint_[depth]) this.drawOrQuad(this.nodeMask(depth));

        this.rasterizeRects(this.rects_[depth]);

        // The caller samples the returned texture right away, so it must
        // not be left bound as the render target.
        if (erosion <= 0) {

            gpu.setRenderTarget(previousTarget);
            return this.consume_;
        }

        this.erodeMaterializedMask();
        gpu.setRenderTarget(previousTarget);
        return this.scratch_;
    }

    /** Grow the per-depth coverage arrays to cover `depth`. */
    private ensureDepth(depth: number): void {

        while (this.rects_.length <= depth) {

            this.rects_.push([]);
            this.hasFootprint_.push(false);
        }
    }

    /**
     * Return the footprint texture for a recursion depth, allocating it
     * on demand. Footprint textures exist only where real footprints do.
     */
    private nodeMask(depth: number): GpuTexture {

        while (this.nodeMasks_.length <= depth) {

            this.nodeMasks_.push(this.createMask());
        }

        return this.nodeMasks_[depth];
    }

    /**
     * On the first footprint contribution at a depth, start its footprint
     * texture from empty coverage. Later contributions accumulate.
     */
    private ensureFootprintTarget(depth: number): void {

        if (this.hasFootprint_[depth]) return;

        const gpu = this.renderer_.gpu;
        gpu.setTextureSpaceRenderTarget(this.nodeMask(depth), this.size_);
        gpu.clearColor(MaskClearUncovered);
        this.hasFootprint_[depth] = true;
    }

    /**
     * Rasterize a rectangle list into the currently bound mask target in
     * a single draw call.
     *
     * The list is expanded into clip-space triangles (two per rectangle)
     * and uploaded once; the blit vertex shader passes the positions
     * straight through and the footprint fragment shader writes full
     * coverage. Adjacent rectangles are not merged yet; this is a
     * candidate optimization.
     */
    private rasterizeRects(rects: MaskRect[]): void {

        if (rects.length === 0) return;

        const renderer = this.renderer_;
        const gl = renderer.gpu.gl;
        const program = renderer.programTileMaskRect();

        renderer.gpu.useProgram2(program);

        // Two triangles (six vertices, two coordinates each) per rect.
        const needed = rects.length * 12;
        if (this.rectVerts_.length < needed)
            this.rectVerts_ = new Float32Array(needed);

        const verts = this.rectVerts_;
        let offset = 0;

        for (const rect of rects) {

            // UV [0,1] to clip [-1,1].
            const x0 = rect.x0 * 2 - 1;
            const y0 = rect.y0 * 2 - 1;
            const x1 = rect.x1 * 2 - 1;
            const y1 = rect.y1 * 2 - 1;

            verts[offset++] = x0; verts[offset++] = y0;
            verts[offset++] = x1; verts[offset++] = y0;
            verts[offset++] = x0; verts[offset++] = y1;
            verts[offset++] = x1; verts[offset++] = y0;
            verts[offset++] = x1; verts[offset++] = y1;
            verts[offset++] = x0; verts[offset++] = y1;
        }

        const previousState = renderer.gpu.currentState;
        renderer.gpu.setState(this.footprintState_);

        this.bindRectBuffer(program, verts, offset);
        gl.drawArrays(gl.TRIANGLES, 0, offset / 2);
        gl.bindVertexArray(null);

        renderer.gpu.setState(previousState, true);
    }

    /** Bind the dynamic rect VAO and upload the used vertex range. */
    private bindRectBuffer(
        program: GpuProgram,
        verts: Float32Array,
        count: number,
    ): void {

        const gl = this.renderer_.gpu.gl;

        if (!this.rectVao_) {

            this.rectBuffer_ = gl.createBuffer();
            this.rectVao_ = gl.createVertexArray();
            gl.bindVertexArray(this.rectVao_);
            gl.bindBuffer(gl.ARRAY_BUFFER, this.rectBuffer_);

            const location = program.getAttribLocation('aPosition');
            gl.enableVertexAttribArray(location);
            gl.vertexAttribPointer(location, 2, gl.FLOAT, false, 0, 0);

        } else {

            gl.bindVertexArray(this.rectVao_);
            gl.bindBuffer(gl.ARRAY_BUFFER, this.rectBuffer_);
        }

        gl.bufferData(gl.ARRAY_BUFFER, verts.subarray(0, count),
            gl.DYNAMIC_DRAW);
    }

    private orTextureIntoNode(texture: GpuTexture, depth: number): void {

        const gpu = this.renderer_.gpu;
        gpu.setTextureSpaceRenderTarget(this.nodeMask(depth), this.size_);
        this.drawOrQuad(texture);
    }

    private drawOrQuad(texture: GpuTexture): void {

        const renderer = this.renderer_;
        const gl = renderer.gpu.gl;
        const program = renderer.programTileMaskBlit();

        renderer.gpu.useProgram2(program);
        renderer.gpu.bindTexture(texture, renderer.textureIdxs.maskBlit);

        const previousState = renderer.gpu.currentState;

        renderer.gpu.setState(this.blitState_);
        gl.blendEquation(gl.MAX);
        gl.blendFunc(gl.ONE, gl.ONE);

        this.bindQuad(program);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        gl.bindVertexArray(null);

        renderer.gpu.setState(previousState, true);
    }

    private erodeMaterializedMask(): void {

        const renderer = this.renderer_;
        const gl = renderer.gpu.gl;
        const program = renderer.programTileMaskErode();
        const previousState = renderer.gpu.currentState;

        renderer.gpu.setTextureSpaceRenderTarget(this.scratch_, this.size_);
        renderer.gpu.useProgram2(program);
        renderer.gpu.bindTexture(this.consume_, renderer.textureIdxs.maskBlit);
        renderer.gpu.setState(this.erodeState_);
        program.setVec2('uTexelSize', [
            1 / this.resolution,
            1 / this.resolution,
        ]);

        this.bindQuad(program);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        gl.bindVertexArray(null);

        renderer.gpu.setState(previousState, true);
    }

    private bindQuad(program: GpuProgram): void {

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

    private createMask(): GpuTexture {

        const texture = new GpuTexture(
            this.renderer_.gpu,
            null,
            this.renderer_.map,
        );
        const data = new Uint8Array(this.resolution * this.resolution);

        // Linear filtering is for footprint coverage, which is the only
        // part still carried as a texture and blit-downscaled per level
        // during backtrack. A consumer several LODs above the producer
        // reads it after many parent blits; with NEAREST the boundary
        // collapses to half-tile alignment error, with LINEAR it survives
        // as a gradient that the tile shader thresholds at 0.5 to recover
        // the edge. Rectangular coverage does not rely on this — it is
        // rasterized exactly at the consumer's resolution in `materialize`.
        // See phase 2 post-impl notes in docs/wiki/rfc03-draw-traversal.md.
        texture.createFromData(
            this.resolution,
            this.resolution,
            data,
            GpuTexture.Type.Mask,
            'linear',
        );
        texture.createFramebuffer(this.resolution, this.resolution);
        return texture;
    }
}

/** Covered rectangle in a node's UV [0,1] space. */
type MaskRect = {
    x0: number;
    y0: number;
    x1: number;
    y1: number;
};

// R8 mask "uncovered" value. Red channel zero is the meaningful bit;
// `clearColor` normalises the alpha component to 1.0, which the
// single-channel attachment then ignores.
const MaskClearUncovered: GpuDevice.Color = [0, 0, 0, 255];


export default DrawTraversalMaskPool;
