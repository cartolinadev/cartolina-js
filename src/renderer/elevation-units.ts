/*
 * elevation-units.ts - draw and read the elevation store's height fields
 */

import type Renderer from './renderer';
import type { GpuDevice } from './gpu/device';
import GpuTexture from './gpu/texture';
import type { TileRenderRig } from '../map/tile-render-rig';
import type * as math from '../utils/math';


/**
 * The WebGL side of the elevation store: the unit textures, the draws
 * that fill them, and the batched lookup that reads them back.
 *
 * A unit is one tile's 256 by 256 field of packed float32 heights, with
 * one NaN pattern for no coverage. Only one unit is built at a time, and
 * a lookup issued while it is being built still reads the unit's
 * previous contents in full.
 *
 * `ElevationStore` decides which tiles have units and which answer a
 * position.
 */
export class ElevationUnits {

    constructor(renderer: Renderer) {

        this.renderer_ = renderer;

        const gpu = renderer.gpu;

        this.maxBatch = gpu.gl.getParameter(gpu.gl.MAX_TEXTURE_SIZE);

        this.replacement_ = this.createTexture(true);

        this.result_ = new GpuTexture(gpu, null, null);
        this.result_.createFromData(
            this.maxBatch, ResultRows,
            new Uint8Array(this.maxBatch * ResultRows * 4),
            GpuTexture.Type.Elevation);
        this.result_.createFramebuffer(this.maxBatch, ResultRows);

        this.readbackBytes_ = new Uint8Array(this.maxBatch * ResultRows * 4);
        this.readbackView_ = new DataView(this.readbackBytes_.buffer);
        this.pointRecords_ = new Float32Array(this.maxBatch * 4);

        this.rasterState_ = gpu.createState({
            culling: false, blend: false, ztest: true, zwrite: true,
        });
        this.composeState_ = gpu.createState({
            culling: false, blend: false, ztest: false, zwrite: false,
        });
        this.lookupState_ = gpu.createState({
            culling: false, blend: false, ztest: true, zwrite: true,
        });
    }

    /** Releases every texture and buffer owned here. */
    [Symbol.dispose](): void {

        this.replacement_[Symbol.dispose]();
        this.result_[Symbol.dispose]();

        const gl = this.renderer_.gpu.gl;

        gl.deleteBuffer(this.pointBuffer_);
        gl.deleteVertexArray(this.pointVao_);
        gl.deleteBuffer(this.quadBuffer_);
        gl.deleteVertexArray(this.quadVao_);
    }

    /** GPU bytes one unit occupies. */
    readonly unitBytes = UnitSize * UnitSize * 4;

    /** Most positions one lookup batch can carry. */
    readonly maxBatch: number;

    /** GPU bytes held regardless of unit count. */
    get fixedBytes(): number {

        // the replacement unit and its depth attachment, the two result
        // rows and their depth, one transient pixel-pack buffer (never
        // pooled -- see endLookup), and the points
        return 2 * this.unitBytes + 40 * this.maxBatch;
    }

    /** A new unit, with no coverage. */
    createUnit(): ElevationUnits.Unit {

        return { texture: this.createTexture(false) };
    }

    releaseUnit(unit: ElevationUnits.Unit): void {

        unit.texture[Symbol.dispose]();
    }

    // -----------------------------------------------------------------
    // Building one unit
    // -----------------------------------------------------------------

    /** Starts a unit, with no coverage. */
    beginReplacement(): void {

        const gpu = this.renderer_.gpu;

        gpu.setTextureSpaceRenderTarget(this.replacement_, UnitSizePair);
        gpu.setState(this.composeState_);
        gpu.clearColorAndDepth(InvalidClearColor);
    }

    /**
     * Reduces up to four published child units into the replacement.
     *
     * @param children Child units in tile-quadrant order, with a hole
     *     where a child has no unit.
     * @returns True when at least one child contributed.
     */
    reduceChildren(
        children: readonly (ElevationUnits.Unit | null)[],
    ): boolean {

        const renderer = this.renderer_;
        const gpu = renderer.gpu;

        let present = 0;

        for (let quadrant = 0; quadrant < 4; quadrant++) {

            const child = children[quadrant];
            if (!child) continue;

            gpu.bindTexture(child.texture,
                renderer.textureIdxs.elevation + quadrant);

            present |= 1 << quadrant;
        }

        if (present === 0) return false;

        const program = renderer.programElevationReduce();
        gpu.useProgram2(program);

        for (let quadrant = 0; quadrant < 4; quadrant++) {

            // an absent child leaves its sampler on whatever unit it had;
            // uChildPresent stops the shader from reading it
            program.setSampler(`uChild${quadrant}`,
                renderer.textureIdxs.elevation + quadrant);
        }

        program.setInt('uChildPresent', present);

        this.drawQuad(program);
        return true;
    }

    /**
     * Composes one rig's unexaggerated height into the replacement.
     *
     * @param cameraPos camera position in world coordinates
     * @param heightRange the reference frame's declared height range
     * @param geocentric geodetic height above the ellipsoid when true,
     *     physical Z when false
     * @param maskTexture coverage already established at this node
     * @return whether the rig drew
     */
    rasterizeRig(
        rig: TileRenderRig,
        cameraPos: math.vec3,
        heightRange: [number, number],
        geocentric: boolean,
        maskTexture?: GpuTexture,
    ): boolean {

        const gpu = this.renderer_.gpu;

        gpu.setTextureSpaceRenderTarget(this.replacement_, UnitSizePair);
        gpu.setState(this.rasterState_);

        // Depth orders the overlapping triangles of one rig, so it
        // starts fresh for every rig; coverage across rigs comes from
        // the traversal's mask.
        gpu.clearDepth();

        return rig.drawElevation(
            cameraPos, heightRange, geocentric, maskTexture);
    }

    /** Publishes the unit started by `beginReplacement`. */
    publishReplacement(unit: ElevationUnits.Unit): void {

        const gpu = this.renderer_.gpu;

        gpu.setTextureSpaceRenderTarget(this.replacement_, UnitSizePair);
        gpu.copyRenderTargetToTexture(unit.texture, UnitSize, UnitSize);
    }

    // -----------------------------------------------------------------
    // Lookup
    // -----------------------------------------------------------------

    /**
     * Opens a lookup batch.
     *
     * @param maxPreference greatest preference index in the batch
     */
    beginLookup(maxPreference: number): void {

        const renderer = this.renderer_;
        const gpu = renderer.gpu;
        const program = renderer.programElevationLookup();

        this.entryTarget_ = gpu.currentRenderTarget;
        this.entryState_ = gpu.currentState;

        gpu.setTextureSpaceRenderTarget(
            this.result_, [this.maxBatch, ResultRows]);
        gpu.setState(this.lookupState_);
        gpu.clearColorAndDepth(InvalidClearColor);

        gpu.useProgram2(program);
        program.setFloat('uResultWidth', this.maxBatch);
        program.setFloat('uMaxPreference', maxPreference);
        program.setSampler('uUnit', renderer.textureIdxs.elevation);
    }

    /**
     * Asks one unit for every point that lists it, once into each
     * result row.
     *
     * @param points at most `maxBatch` of them
     */
    drawLookupGroup(
        unit: ElevationUnits.Unit,
        points: readonly ElevationUnits.LookupPoint[],
    ): void {

        const renderer = this.renderer_;
        const gpu = renderer.gpu;
        const gl = gpu.gl;
        const program = renderer.programElevationLookup();

        gpu.bindTexture(unit.texture, renderer.textureIdxs.elevation);
        this.uploadPoints(points);

        for (let row = 0; row < ResultRows; row++) {

            program.setInt('uRow', row);
            gl.drawArrays(gl.POINTS, 0, points.length);
        }
    }

    /**
     * Closes a lookup batch and starts reading its result rows.
     *
     * @param count positions actually submitted in this batch; only
     *     this many columns are read back, not the full `maxBatch`
     *     width the result target reserves
     * @returns a handle for `pollReadback()`, or null when the device
     *     could not fence the read
     */
    endLookup(count: number): ElevationUnits.Readback | null {

        const gpu = this.renderer_.gpu;

        gpu.gl.bindVertexArray(null);

        // A fresh, single-use buffer, never pooled: a buffer written
        // more than once in its lifetime triggers the driver's "written
        // again before being read back" performance warning on every
        // later write, however long the earlier one has had to drain.
        // dropReadback() deletes it once this batch's data is taken.
        const buffer = gpu.createPixelPackBuffer(count * ResultRows * 4);

        const fence = gpu.readFramebufferPixelsAsync(
            this.result_, count, ResultRows, buffer);

        gpu.setState(this.entryState_!, true);
        gpu.setRenderTarget(this.entryTarget_!);

        this.entryTarget_ = null;
        this.entryState_ = null;

        return fence ? { fence, buffer, count } : null;
    }

    /**
     * The result rows of a completed batch, or null while the read is
     * still running. The next batch reuses the returned view.
     *
     * Row zero holds one height per position, row one the preference
     * index of the unit that supplied it, both as four little-endian
     * bytes of a float32. NaN in either means no unit answered. A row
     * is `readback.count` pixels wide; `4 * readback.count` is the
     * byte offset of row one.
     */
    pollReadback(readback: ElevationUnits.Readback): DataView | null {

        const gpu = this.renderer_.gpu;
        if (!gpu.fenceSignalled(readback.fence)) return null;

        const bytes = readback.count * ResultRows * 4;
        gpu.readPixelPackBuffer(
            readback.buffer, this.readbackBytes_.subarray(0, bytes));
        this.dropReadback(readback);

        return this.readbackView_;
    }

    /** Abandons a batch whose result is no longer wanted. */
    dropReadback(readback: ElevationUnits.Readback): void {

        const gl = this.renderer_.gpu.gl;

        gl.deleteSync(readback.fence);
        gl.deleteBuffer(readback.buffer);
    }

    // -----------------------------------------------------------------
    // Private
    // -----------------------------------------------------------------

    private createTexture(withFramebuffer: boolean): GpuTexture {

        const texture = new GpuTexture(this.renderer_.gpu, null, null);

        texture.createFromData(UnitSize, UnitSize, invalidUnitBytes(),
            GpuTexture.Type.Elevation, 'nearest');

        if (withFramebuffer) texture.createFramebuffer(UnitSize, UnitSize);

        return texture;
    }

    /** Fills and binds the reusable point-input buffer. */
    private uploadPoints(
        points: readonly ElevationUnits.LookupPoint[],
    ): void {

        const gl = this.renderer_.gpu.gl;
        const program = this.renderer_.programElevationLookup();
        const records = this.pointRecords_;

        for (let i = 0; i < points.length; i++) {

            const point = points[i];
            records[i * 4] = point.column;
            records[i * 4 + 1] = point.u;
            records[i * 4 + 2] = point.v;
            records[i * 4 + 3] = point.preference;
        }

        if (!this.pointVao_) {

            this.pointBuffer_ = gl.createBuffer();
            this.pointVao_ = gl.createVertexArray();
        }

        gl.bindVertexArray(this.pointVao_);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.pointBuffer_);
        gl.bufferData(gl.ARRAY_BUFFER,
            records.subarray(0, points.length * 4), gl.STREAM_DRAW);

        const stride = 16;
        const bind = (name: string, size: number, offset: number) => {

            const location = program.getAttribLocation(name);
            if (location < 0) return;

            gl.enableVertexAttribArray(location);
            gl.vertexAttribPointer(
                location, size, gl.FLOAT, false, stride, offset);
        };

        bind('aIndex', 1, 0);
        bind('aUv', 2, 4);
        bind('aPreference', 1, 12);
    }

    /** Draws a full-target quad with the bound program. */
    private drawQuad(program: GpuProgramLike): void {

        const gl = this.renderer_.gpu.gl;

        if (!this.quadVao_) {

            this.quadBuffer_ = gl.createBuffer();
            this.quadVao_ = gl.createVertexArray();

            gl.bindVertexArray(this.quadVao_);
            gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer_);
            gl.bufferData(gl.ARRAY_BUFFER, QuadVertices, gl.STATIC_DRAW);

            const location = program.getAttribLocation('aPosition');
            gl.enableVertexAttribArray(location);
            gl.vertexAttribPointer(location, 2, gl.FLOAT, false, 0, 0);

        } else {

            gl.bindVertexArray(this.quadVao_);
        }

        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        gl.bindVertexArray(null);
    }

    private readonly renderer_: Renderer;

    /** The unit under construction, published by `publishReplacement`. */
    private readonly replacement_: GpuTexture;

    private readonly result_: GpuTexture;

    private readonly readbackBytes_: Uint8Array;
    private readonly readbackView_: DataView;
    private readonly pointRecords_: Float32Array;

    private pointVao_: WebGLVertexArrayObject | null = null;
    private pointBuffer_: WebGLBuffer | null = null;
    private quadVao_: WebGLVertexArrayObject | null = null;
    private quadBuffer_: WebGLBuffer | null = null;

    /** Target and state a lookup batch restores when it closes. */
    private entryTarget_: Readonly<GpuDevice.RenderTarget> | null = null;
    private entryState_: GpuDevice.State | null = null;

    private readonly rasterState_: GpuDevice.State;
    private readonly composeState_: GpuDevice.State;
    private readonly lookupState_: GpuDevice.State;
}


/** The part of `GpuProgram` the quad draw needs. */
type GpuProgramLike = { getAttribLocation(name: string): number };


const UnitSize = 256;
const UnitSizePair: [number, number] = [UnitSize, UnitSize];
const ResultRows = 2;

/** Little-endian bytes of the NaN pattern that stands for no coverage. */
const InvalidClearColor: [number, number, number, number] = [0, 0, 192, 127];

const QuadVertices = new Float32Array([
    -1, -1,
     1, -1,
    -1,  1,
     1,  1,
]);


let invalidUnitBytes_: Uint8Array | null = null;

/**
 * A unit texture's initial contents: no coverage everywhere. Built once
 * and shared; `createFromData` copies it at upload and never retains it.
 */
function invalidUnitBytes(): Uint8Array {

    if (invalidUnitBytes_) return invalidUnitBytes_;

    const bytes = new Uint8Array(UnitSize * UnitSize * 4);

    for (let i = 0; i < bytes.length; i += 4) {

        bytes[i + 2] = InvalidClearColor[2];
        bytes[i + 3] = InvalidClearColor[3];
    }

    return invalidUnitBytes_ = bytes;
}


export namespace ElevationUnits {

    /** One tile's height field. */
    export type Unit = {
        texture: GpuTexture;
    };

    /** One position asking one unit, in one lookup batch. */
    export type LookupPoint = {

        /** The position's place in the batch, and its result column. */
        column: number;

        /** The position within the unit, u east and v south. */
        u: number;
        v: number;

        /** The unit's place in the order the store wants tried. */
        preference: number;
    };

    /** A submitted lookup batch waiting on its read. */
    export type Readback = {
        fence: WebGLSync;
        buffer: WebGLBuffer;

        /** Positions submitted; the width of a result row. */
        count: number;
    };
}

export default ElevationUnits;
