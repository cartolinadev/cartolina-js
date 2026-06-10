
/**
 * Minimal decoder for 8-bit grayscale, non-interlaced PNG images.
 *
 * The browser image pipeline (Image element, createImageBitmap, canvas
 * getImageData) runs PNG pixels through color management. On iOS,
 * CoreGraphics assigns untagged grayscale images a gamma 2.2 gray color
 * space and converts the values to sRGB, which changes the stored bytes
 * by a few counts. Textures that carry encoded numbers rather than
 * colors (the atmosphere density lookup table) are corrupted by this
 * remapping. Decoding the PNG here returns the stored bytes verbatim
 * on every platform.
 *
 * The decoder intentionally supports only the format produced by the
 * tileserver atmdensity service: bit depth 8, color type 0 (grayscale),
 * compression 0, filter 0, interlace 0.
 */

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/**
 * Check whether the decoder can run in this browser. Requires the
 * DecompressionStream API (Chrome 80+, Safari 16.4+, Firefox 113+).
 *
 * @returns true when decodeGrayPng is available
 */
export function grayPngDecodeAvailable(): boolean {

    return typeof DecompressionStream !== 'undefined';
}

/**
 * Decode an 8-bit grayscale non-interlaced PNG to raw bytes.
 *
 * @param buffer the complete PNG file
 * @returns width, height and one byte per pixel in row-major order
 */
export async function decodeGrayPng(buffer: ArrayBuffer):
    Promise<{ width: number, height: number, data: Uint8Array }> {

    const bytes = new Uint8Array(buffer);
    const view = new DataView(buffer);

    for (let index = 0; index < 8; index++) {
        if (bytes[index] !== PNG_SIGNATURE[index])
            throw new Error('gray-png: not a PNG file');
    }

    let width = 0, height = 0;
    const idatParts: Uint8Array[] = [];
    let idatLength = 0;

    // walk the chunk list, collecting IHDR fields and IDAT payloads
    let offset = 8;

    while (offset + 8 <= bytes.length) {

        const length = view.getUint32(offset);

        const type = String.fromCharCode(
            bytes[offset + 4], bytes[offset + 5],
            bytes[offset + 6], bytes[offset + 7]);

        const dataStart = offset + 8;

        if (type === 'IHDR') {

            width = view.getUint32(dataStart);
            height = view.getUint32(dataStart + 4);

            const bitDepth = bytes[dataStart + 8];
            const colorType = bytes[dataStart + 9];
            const interlace = bytes[dataStart + 12];

            if (bitDepth !== 8 || colorType !== 0 || interlace !== 0)
                throw new Error(
                    'gray-png: unsupported format (bit depth '
                    + `${bitDepth}, color type ${colorType}, `
                    + `interlace ${interlace})`);
        }

        if (type === 'IDAT') {

            idatParts.push(bytes.subarray(dataStart, dataStart + length));
            idatLength += length;
        }

        if (type === 'IEND') break;

        // chunk header (8) + payload + crc (4)
        offset = dataStart + length + 4;
    }

    if (!width || !height || !idatLength)
        throw new Error('gray-png: missing IHDR or IDAT data');

    // concatenate the IDAT payloads into one zlib stream and inflate it
    const compressed = new Uint8Array(idatLength);
    let position = 0;

    for (const part of idatParts) {
        compressed.set(part, position);
        position += part.length;
    }

    const stream = new Blob([compressed]).stream().pipeThrough(
        new DecompressionStream('deflate'));

    const raw = new Uint8Array(await new Response(stream).arrayBuffer());

    // each scanline is one filter byte followed by width gray bytes
    if (raw.length < height * (width + 1))
        throw new Error('gray-png: truncated pixel data');

    const data = new Uint8Array(width * height);

    for (let row = 0; row < height; row++) {

        const filter = raw[row * (width + 1)];
        const source = row * (width + 1) + 1;
        const target = row * width;

        unfilterRow(raw, source, data, target, width, row, filter);
    }

    return { width, height, data };
}

/**
 * Reverse one PNG scanline filter in place into the output buffer.
 * Operates on one byte per pixel (grayscale, bit depth 8).
 *
 * @param raw inflated stream with filter bytes
 * @param source index of the first pixel byte of the row in raw
 * @param data output buffer without filter bytes
 * @param target index of the first pixel of the row in data
 * @param width pixels per row
 * @param row row index, used to guard the up references on row 0
 * @param filter PNG filter type byte (0 to 4)
 */
function unfilterRow(
    raw: Uint8Array, source: number, data: Uint8Array, target: number,
    width: number, row: number, filter: number) {

    for (let column = 0; column < width; column++) {

        const value = raw[source + column];
        const left = column > 0 ? data[target + column - 1] : 0;
        const up = row > 0 ? data[target + column - width] : 0;
        const upLeft =
            (row > 0 && column > 0) ? data[target + column - width - 1] : 0;

        let result;

        switch (filter) {

            case 0: result = value; break;
            case 1: result = value + left; break;
            case 2: result = value + up; break;
            case 3: result = value + ((left + up) >> 1); break;
            case 4: result = value + paeth(left, up, upLeft); break;

            default:
                throw new Error(`gray-png: unknown filter ${filter}`);
        }

        data[target + column] = result & 0xff;
    }
}

/**
 * The Paeth predictor from the PNG specification: pick the neighbor
 * closest to left + up - upLeft.
 *
 * @param left pixel to the left
 * @param up pixel above
 * @param upLeft pixel above and to the left
 * @returns predicted byte value
 */
function paeth(left: number, up: number, upLeft: number): number {

    const estimate = left + up - upLeft;
    const deltaLeft = Math.abs(estimate - left);
    const deltaUp = Math.abs(estimate - up);
    const deltaUpLeft = Math.abs(estimate - upLeft);

    if (deltaLeft <= deltaUp && deltaLeft <= deltaUpLeft) return left;
    if (deltaUp <= deltaUpLeft) return up;

    return upLeft;
}
