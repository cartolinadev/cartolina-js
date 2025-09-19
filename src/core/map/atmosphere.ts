
import MapBody from './body';
import MapSrs from './srs';
import MapTexture from './texture';
import * as utils from '../utils/utils';
import * as vts from '../constants';

/**
 * The map atmosphere object. Provides density texture retrieval and decoding,
 * readiness trigger, rendering initialization and buffer and uniform updates during
 * tile rendering loop.
 * Drawing of background (sky) might be added.
 */


class Atmosphere {

    params!: Parameters;
    atmDensityTexture!: MapTexture;


    /**
     * Initialize from atmosphere parameters, initiailize atmdensity texture.
     * @param a atmosphere parameters (body.atmosphere object from mapConfig)
     * @param srs the body srs, usually physical, for radius retrieval
     * @param urlTemplate the URL template for atmdensity, usually comes
     *      from services.atmdensity in map configuration
     * @param map Map object to pass on to MapTexture (opaque in this class)
     */
    constructor(a: MapBody.Atmosphere, srs: MapSrs, urlTemplate: string,
                map: any) {

        const srsInfo = srs.getInfo();

        this.params = {...a,
            bodyMajorRadius: srsInfo.a,
            bodyMinorRadius: srsInfo.b,
        } as Parameters;

        let params = this.params;

        let targetQuantile = 1e-6;
        let k = - Math.log(params.thicknessQuantile) / params.thickness;

        params.boundaryThickness = - Math.log(targetQuantile) / k;
        params.verticalExponent = - Math.log(targetQuantile);

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

        //console.log('atmDensityTexture url: ', url);

        // create gl buffer
        // TODO
    }

    /**
     * readiness check/trigger
     *
     * @param doNotLoad passed on to MapTexture
     * @param priority  passed on to MapTexture
     * @param doNotCheckGpu passed on to MapTexture
     * @returns true if ready to render, side effect: triggers load
     */
    isReady(doNotLoad: boolean, priority: number, doNotCheckGpu: boolean): boolean
    {
        return this.atmDensityTexture.isReady(
            doNotLoad, priority, doNotCheckGpu);
        // buffer metadata and bind textures
        // TODO

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

        console.log('decodeAtmosphereDensity:', w, h);

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


// export types

namespace Atmosphere {

}

export default Atmosphere;
