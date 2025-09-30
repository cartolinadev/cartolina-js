
import MapBody from './body';
import MapSrs from './srs';
import MapTexture from './texture';
import * as utils from '../utils/utils';
import * as vts from '../constants';
import * as math from '../utils/math';
import {vec3, vec4, mat4} from '../utils/matrix';
import Renderer from '../renderer/renderer';

/**
 * The map atmosphere object. Provides density texture retrieval and decoding,
 * readiness trigger, rendering initialization and buffer and uniform updates during
 * tile rendering loop.
 * Drawing of background (sky) might be added.
 */


class Atmosphere {

    params!: Parameters;
    atmDensityTexture!: MapTexture;
    renderer!: Renderer;

    uboAtm!: WebGLBuffer;
    quadVao: WebGLVertexArrayObject;

    /**
     * Initialize from atmosphere parameters, initiailize atmdensity texture.
     * @param a atmosphere parameters (body.atmosphere object from mapConfig)
     * @param srs the body srs, usually physical, for radius retrieval
     * @param urlTemplate the URL template for atmdensity, usually comes
     *      from services.atmdensity in map configuration
     * @param map Map object, largely opaque. We pass it to map texture and
     *      we collect the Renderer object from it. The object is used to
     *      retrieve vertical exaggeration information and also to obtain
     *      access to gl context for buffer creation and updates.
     */
    constructor(a: MapBody.Atmosphere, srs: MapSrs, urlTemplate: string,
                map: Map) {

        const srsInfo = srs.getInfo();
        this.renderer = map.renderer;

        this.params = {...a,
            bodyMajorRadius: srsInfo.a,
            bodyMinorRadius: srsInfo.b,
        } as Parameters;

        let params = this.params;

        // normalize colors
        vec3.scale(params.colorHorizon, 1.0 / 255.0);
        vec3.scale(params.colorZenith, 1.0 / 255.0);
        //params.colorHorizon = [0.71, 0.81, 0.95, 1.0];
        //params.colorHorizon = [0.71, 0.81, 0.95, 1.0];

        // we inflate atmosphere thickness and visibility
        // by vertical exaggeration at view extent = body diameter
        params.thickness *= this.renderer.getSeProgressionFactor(2 * srsInfo.a);
        params.visibility *= this.renderer.getSeProgressionFactor(2 * srsInfo.a);

        // this is purely empirical. Note that visibility configured here is in
        // fact use only as upper limit on the visibility: see the calculation
        // in this.updateBuffers
        params.visibility *= 12;

        // the relative air density at the edge of compute
        let targetQuantile = 1e-6;

        // the vertical coefficient (which is not vertical exponent)
        // the exponential rate at which density drops with height (from 1)
        let k = - Math.log(params.thicknessQuantile) / params.thickness;

        // the edge of compute (when air density drops to target quantile)
        params.boundaryThickness = - Math.log(targetQuantile) / k;

        // the total drop across the shell (from surface to edge of compute)
        params.verticalExponent = - Math.log(targetQuantile);

        // construct query
        let name = Atmosphere.toQueryArg({
            version: 0,
            size: { width: 512, height: 512 },
            thickness: params.boundaryThickness / params.bodyMajorRadius,
            verticalCoefficient: params.verticalExponent,
            normFactor: 0.2,
            integrationStep: 0.0003
        });

        let url = utils.simpleFmtObj(urlTemplate, { 'param(0)' : name });
        this.atmDensityTexture = new MapTexture(
            map, url, vts.TEXTURETYPE_ATMDENSITY);

        __DEV__ && utils.logOnce(`atmDensityTexture url: ${url}`);
    }

    /**
     * create the uboAtm uniform buffer object.
     */
    createBuffers() {

        this.createAtmUbo();
        this.createQuadVao();
    }

    private createAtmUbo() {

        // create atmUbo buffer
        let gl = this.renderer.gpu.gl;

        this.uboAtm = gl.createBuffer();
        gl.bindBuffer(gl.UNIFORM_BUFFER, this.uboAtm);

        // total size in bytes (see shaders/include/atmosphere.inc.glsl)
        // mat4 (64) + vec4 (16) + vec4 (16) + vec4 (16) + vec4 (16) + vec3+p (16) = 144
        gl.bufferData(gl.UNIFORM_BUFFER, 144, gl.DYNAMIC_DRAW);

        gl.bindBufferBase(gl.UNIFORM_BUFFER,
            Renderer.UniformBlockName.Atmosphere, this.uboAtm);

        gl.bindBuffer(gl.UNIFORM_BUFFER, null);

    }

    private createQuadVao() {

        let gl = this.renderer.gpu.gl;
        let program = this.renderer.programs.background;

        this.quadVao = gl.createVertexArray()!;
        gl.bindVertexArray(this.quadVao);

        // positions -> inPosition
        const posLoc = program.getAttribLocation("inPosition");
        const vboPos = gl.createBuffer()!;
        gl.bindBuffer(gl.ARRAY_BUFFER, vboPos);
        gl.bufferData(gl.ARRAY_BUFFER, QuadPos, gl.STATIC_DRAW);
        gl.enableVertexAttribArray(posLoc);
        gl.vertexAttribPointer(posLoc, 3, gl.FLOAT, false, 0, 0);

        // uvs -> inUv
        const uvLoc = program.getAttribLocation("inUv");
        const vboUv = gl.createBuffer()!;
        gl.bindBuffer(gl.ARRAY_BUFFER, vboUv);
        gl.bufferData(gl.ARRAY_BUFFER, QuadUv, gl.STATIC_DRAW);
        gl.enableVertexAttribArray(uvLoc);
        gl.vertexAttribPointer(uvLoc, 2, gl.FLOAT, false, 0, 0);

        // indices
        const ebo = gl.createBuffer()!;
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ebo);
        gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, QuadIdx, gl.STATIC_DRAW);

        // tidy
        gl.bindBuffer(gl.ARRAY_BUFFER, null);
        gl.bindVertexArray(null);
    }

    /**
     * readiness check/trigger
     *
     * @param doNotLoad passed on to MapTexture
     * @param priority  passed on to MapTexture
     * @param doNotCheckGpu passed on to MapTexture
     * @returns true if ready to render, side effect: triggers load
     */
    isReady(doNotLoad: boolean = false, priority: number = 0,
            doNotCheckGpu: boolean = false): boolean
    {
        return this.atmDensityTexture.isReady(
            doNotLoad, priority, doNotCheckGpu);
    }

    /**
     * update the atm ubo buffer based on current map parameters, sets sampler
     * uniform
     *
     * @param eyePos camera position in ECEF (physical coordinates)
     * @param eyeToCenter distance of camera to center of orbit (for dynamic
     *      visibility
     * @param viewInverse inverse of the view matrix (VC to ECEF)
     */
    updateBuffers(eyePos: math.vec3, eyeToCenter: number, viewInverse: math.mat4) {

        // bind textures - note: the sampler idx is set once in program creation
        // and untouched. The call could be done only once when the gpu texture
        // is created, since the binding never changes, but once per frame, it
        // does not hurt.
        let atmDensity = this.atmDensityTexture.getGpuTexture();

        if (atmDensity)
            this.renderer.gpu.bindTexture(
                this.atmDensityTexture.getGpuTexture(),
                this.renderer.textureIdxs.atmosphere);

        // compute ubo values
        const params = this.params;

        // this should be configurable:
        // we make the visiblity dependent on the distance from view center
        const visibility = Math.min(3.0 * eyeToCenter, params.visibility);
        const horizontalExponent = - params.bodyMajorRadius
            * Math.log(params.visibilityQuantile) / visibility * 5.0;
        // times 5 as compensation for texture normalization factor

        let eyePosNormalized = vec3.create();
        vec3.scale(eyePos, 1.0 / params.bodyMajorRadius, eyePosNormalized);

        let data = {

            uniAtmViewInv: viewInverse,
            uniAtmColorHorizon: params.colorHorizon,
            uniAtmColorZenith: params.colorZenith,
            uniAtmSizes: [
                params.boundaryThickness / params.bodyMajorRadius,
                params.bodyMajorRadius / params.bodyMinorRadius,
                1.0 / params.bodyMajorRadius,
                // this should be configurable as well
                // we shift the edge of atmosphere to view center
                // to make everything unhazed until then
                eyeToCenter / params.bodyMajorRadius],
                //Math.min(eyeToCenter, 1.0/3.0 * visibility) / params.bodyMajorRadius],
            uniAtmCoefs: [
                horizontalExponent,
                params.colorGradientExponent,
                0.0, 0.0],
            uniAtmCameraPosition: eyePosNormalized
        };

        // create and populate backing array
        const buffer = new Float32Array(36); // 144 / 4 = 36 floats

        let offset = 0;

        // mat4 uniAtmViewInv (16 floats)
        buffer.set(data.uniAtmViewInv, offset); offset += 16;

        // vec4 uniAtmColorHorizon
        buffer.set(data.uniAtmColorHorizon, offset); offset += 4;

        // vec4 uniAtmColorZenith
        buffer.set(data.uniAtmColorZenith, offset); offset += 4;

        // vec4 uniAtmSizes
        buffer.set(data.uniAtmSizes, offset); offset += 4;

        // vec4 uniAtmCoefs
        buffer.set(data.uniAtmCoefs, offset); offset += 4;

        // vec3 uniAtmCameraPosition (+ pad float)
        buffer.set(data.uniAtmCameraPosition, offset);
        buffer[offset + 3] = 0.0;
        offset += 4;

        // upload
        let gl = this.renderer.gpu.gl;

        gl.bindBuffer(gl.UNIFORM_BUFFER, this.uboAtm);
        gl.bufferSubData(gl.UNIFORM_BUFFER, 0, buffer);
        gl.bindBuffer(gl.UNIFORM_BUFFER, null);
    }

    drawBackground(
        eyePos: math.vec3, mvpInverse: math.mat4)   {

        let gl = this.renderer.gpu.gl;
        let program = this.renderer.programs.background;

        // compute corners here - the scaling is probably not needed at all,
        // since we deal with directions, and divisions by huger numbers
        // do not improve numeric stability. Still we replicate the formulas
        // originally found in vts-browser-cpp (librenderer/renderView.cpp)
        const invr = 1. / this.params.bodyMajorRadius;

        let mvpInverse_ = mat4.scale(mat4.identity(mat4.create()),
                                      [invr, invr, invr]);
        mat4.multiply(mvpInverse_, mvpInverse);


        let cornerDirsD: math.vec4[] = [

            mat4.multiplyVec4(mvpInverse_, [-1, -1, 0, 1]),
            mat4.multiplyVec4(mvpInverse_, [+1, -1, 0, 1]),
            mat4.multiplyVec4(mvpInverse_, [-1, +1, 0, 1]),
            mat4.multiplyVec4(mvpInverse_, [+1, +1, 0, 1])
        ];

        let eyePos_ = vec3.create();
        vec3.scale(eyePos, invr, eyePos_);
        let cornerDirs: math.vec3[] = [];

        for (let i = 0; i < 4; i++) {

            cornerDirs.push(
                vec3.normalize(vec3.subtract(vec4.toVec3(cornerDirsD[i]), eyePos_)));
        }

        // flatten 4×vec3 into Float32Array
        const flat = new Float32Array([
            ...cornerDirs[0], ...cornerDirs[1],
            ...cornerDirs[2], ...cornerDirs[3]]);

        // use
        this.renderer.gpu.useProgram2(this.renderer.programs.background);

        // Set the vec3 array uniform (query from [0], pass 12 floats)
        program.setVec3("uniCorners[0]", flat)

        // draw
        gl.bindVertexArray(this.quadVao);
        gl.drawElements(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0);

        // tidy
        gl.bindVertexArray(null);
}

    /**
     * decode the grayscale atmosphere density image data into interleaved rgb
     *
     * @param img grayscale atmosphere density
     * @returns the interlaved rgb density rgb array, with dimensions
     */

    static decodeAtmosphereDensity(img: ImageData):
        { width: number, height: number, data: Uint8Array } {

        const w = img.width, h3 = img.height, rgba = img.data;
        console.assert(h3 % 3 === 0, `height ${h3} not divisible by 3`);

        const h = h3 / 3, planeSize = w * h;

        // repack stacked grayscale planes -> interleaved RGB

        const rgb = new Uint8Array(planeSize * 3);

        const offRpx = 0, offGpx = planeSize, offBpx = planeSize * 2;
        let di = 0;

        for (let i = 0; i < planeSize; i++) {

            const rIdx = (offRpx + i) * 4;
            const gIdx = (offGpx + i) * 4;
            const bIdx = (offBpx + i) * 4;

            rgb[di++] = rgba[rIdx]; // take R from each grayscale plane
            rgb[di++] = rgba[gIdx];
            rgb[di++] = rgba[bIdx];
        }

        return { width: w, height: h, data: rgb }
    }

    /**
     * convert AtmosphereTextureSpec to a base64-encoded query argument
     * @spec atmosphere texture spec, derived from parameters
     * @returns 'def' arg for atmdensity query
     */
    private static toQueryArg(spec: AtmosphereTextureSpec): string {

        // note the little endian
        const buffer = new ArrayBuffer(1 + 2 + 2 + 4 * 4); // 21 bytes
        const view = new DataView(buffer);
        let offset = 0;

        view.setUint8(offset, spec.version); offset += 1;
        view.setUint16(offset, spec.size.width, true); offset += 2;
        view.setUint16(offset, spec.size.height, true); offset += 2;
        view.setFloat32(offset, spec.thickness, true); offset += 4;
        view.setFloat32(offset, spec.verticalCoefficient, true); offset += 4;
        view.setFloat32(offset, spec.normFactor, true); offset += 4;
        view.setFloat32(offset, spec.integrationStep, true); offset += 4;

        // Convert to base64
        const bytes = new Uint8Array(buffer);
        return btoa(String.fromCharCode(...bytes));
    }

    /**
     * convert the query argument back to AtmosphereTextureSpec (currently unused)
     * @arg 'def' arg from atmdensity query
     * @returns atmosphere texture spec
     */
    private static fromQueryArg(arg: string): AtmosphereTextureSpec {

        const spec: AtmosphereTextureSpec = EmptyAtmosphereTextureSpec;

        // Decode base64 to bytes
        const binaryString = atob(arg);
        const bytes = new Uint8Array(binaryString.length);
        for (let i = 0; i < binaryString.length; i++) {
            bytes[i] = binaryString.charCodeAt(i); }

        // note the little endian
        const view = new DataView(bytes.buffer);
        let offset = 0;

        spec.version = view.getUint8(offset); offset += 1;
        if (spec.version !== 0)
            throw new Error(`Atmdensity: unsupported version <${spec.version}>.`);

        spec.size.width = view.getUint16(offset, true); offset += 2;
        spec.size.height = view.getUint16(offset, true); offset += 2;
        spec.thickness = view.getFloat32(offset, true); offset += 4;
        spec.verticalCoefficient = view.getFloat32(offset, true); offset += 4;
        spec.normFactor = view.getFloat32(offset, true); offset += 4;
        spec.integrationStep = view.getFloat32(offset, true); offset += 4;

        if (bytes.length !== 21) throw new Error('Invalid buffer size.');

        return spec;
    }


} // class Atmosphere


// local types

type Parameters = MapBody.Atmosphere & {

    bodyMajorRadius: number;
    bodyMinorRadius: number;

    // derived attributes
    boundaryThickness: number;
    verticalExponent: number;

}

// Interface for AtmosphereTextureSpec

const EmptyAtmosphereTextureSpec = {
    version: 0,                     // uint8_t
    size: { width: 0, height: 0 },  // uint16_t, uint16_t
    thickness: 0,                   // float
    verticalCoefficient: 0,         // float
    normFactor: 0,                  // float
    integrationStep: 0              // float
}

type AtmosphereTextureSpec = typeof EmptyAtmosphereTextureSpec;


type Map = {

    renderer: Renderer;
}

// 1) Quad data (matches your OBJ: positions, uvs, indices)
const QuadPos = new Float32Array([
  -1, -1, 0,  // v1
   1, -1, 0,  // v2
  -1,  1, 0,  // v3
   1,  1, 0,  // v4
]);

const QuadUv = new Float32Array([
  0, 0,  // vt1
  1, 0,  // vt2
  0, 1,  // vt3
  1, 1,  // vt4
]);

const QuadIdx = new Uint16Array([
  0, 1, 2,   // f 1/1/1 2/2/1 3/3/1
  1, 3, 2,   // f 2/2/1 4/4/1 3/3/1
]);

// export types

namespace Atmosphere {

}

export default Atmosphere;
