
import * as utils from '../../utils/utils';
import {GpuDevice} from './device';

type Optional<T> = T | null;

export class GpuTexture {

    gpu!: GpuDevice;
    gl!: WebGL2RenderingContext;
    core: any;

    texture: Optional<WebGLTexture> = null;

    framebuffer: Optional<WebGLFramebuffer> = null;
    renderbuffer: Optional<WebGLRenderbuffer> = null;

    image: Optional<HTMLImageElement> = null;

    width: number = 0;
    height: number = 0;

    type_: GpuTexture.Type = GpuTexture.Type.Color;
    mipmapped: boolean = false;

    repeat!: boolean;

    filter!: GpuTexture.Filter;

    loaded: boolean = false;

    private disposed_ = false;


    /**
     * Create a GPU texture.
     *
     * When `path` is non-null, the image is fetched from that URL and
     * uploaded asynchronously. When null, the texture is left empty;
     * call `createFromData` or `createFromImage` to populate it.
     *
     * @param gpu     - owning GPU device
     * @param path    - image URL to load, or null for a manually
     *                  populated texture
     * @param core    - application core (used for `markDirty` and
     *                  lifetime checks)
     * @param direct  - pass true to bypass the image-cache path in
     *                  `utils.loadImage`
     * @param repeat  - texture wrap mode; false means clamp-to-edge
     * @param filter  - minification/magnification filter
     * @param keepImage - retain the `HTMLImageElement` after upload
     * @param onLoaded  - called after the texture is uploaded
     * @param onError   - called if the fetch fails
     */
    constructor(gpu: GpuDevice, path: string | null, core: any, _?: any, direct = false,
        repeat = false, filter?: GpuTexture.Filter, keepImage = false,
                          onLoaded?: () => void, onError?: () => void) {

        this.gpu = gpu;
        this.gl = gpu.gl;

        this.repeat = repeat;
        this.filter = filter || 'linear';

        //this.trilinear = false;//true;
        this.core = core;

        if (path != null) {
            this.load(path, onLoaded, onError, direct, keepImage);
        }
    };


/** Releases the GPU texture handle. */
[Symbol.dispose](): void {

    if (this.disposed_) return;
    this.disposed_ = true;
    this.gl.deleteTexture(this.texture);
    this.texture = null;
}

// subtexture.js calls this directly; remove once subtexture.js is TS.
kill() { this[Symbol.dispose](); }


/**
 * Return GPU size estimate, in bytes (for cache bookkeeping)
 */
getSize() {

  let bytesPerTexel = 4;

  switch (this.type_) {

      case GpuTexture.Type.NormalMap:
          bytesPerTexel = 2;
          break;

      case GpuTexture.Type.Mask:
          bytesPerTexel = 1;
          break;
  }

  const base = this.width * this.height * bytesPerTexel;
  return (this.mipmapped) ? Math.ceil(base * 4/3) : base;
}


usesIntegerColorAttachment(): boolean {

    return this.type_ === GpuTexture.Type.DepthUint;
}


readPixelsFormat(): GLenum {

    return this.usesIntegerColorAttachment()
        ? this.gl.RGBA_INTEGER
        : this.gl.RGBA;
}


createFromData(lx: GLsizei, ly: GLsizei, data: Uint8Array,
    type_: GpuTexture.Type = GpuTexture.Type.Color,
    filter: GpuTexture.Filter = 'nearest', repeat?: GLfloat | GLint) {

    var gl = this.gl;

    this.type_ = type_;

    this.texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.texture);

    if (repeat){
        repeat = gl.REPEAT;
        this.repeat = true;
    } else {
        repeat = gl.CLAMP_TO_EDGE;
    }

    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, repeat);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, repeat);
    this.mipmapped = false;

    switch (filter) {

    case 'linear':
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        break;

    case 'trilinear':
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER,
                         gl.LINEAR_MIPMAP_LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        this.mipmapped = true;
        break;

    default:
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        break;
    }

    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);

    switch (this.type_) {

        case GpuTexture.Type.AtmosphereDensity:

            gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
            gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB8UI, lx, ly, 0, gl.RGB_INTEGER,
                          gl.UNSIGNED_BYTE, data);
            break;

        case GpuTexture.Type.DepthUint:

            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8UI, lx, ly, 0,
                          gl.RGBA_INTEGER, gl.UNSIGNED_BYTE, data);
            break;

        case GpuTexture.Type.Mask:

            gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
            gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, lx, ly, 0,
                          gl.RED, gl.UNSIGNED_BYTE, data);
            break;

        case GpuTexture.Type.Color:
        default:
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, lx, ly, 0, gl.RGBA,
                          gl.UNSIGNED_BYTE, data);
            break;
    }

    if (this.mipmapped) {
        gl.generateMipmap(gl.TEXTURE_2D);
    }

    gl.bindTexture(gl.TEXTURE_2D, null);

    this.width = lx;
    this.height = ly;
    this.loaded = true;
};


/**
 * Are these textures allways vertically flipped with respect to the original image?
 * There is no gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true).
 *
 * @param textureType See `GpuTexture.Type`.
 */

createFromImage(
    image: HTMLImageElement,
    type_: GpuTexture.Type,
    filter: GpuTexture.Filter,
    repeat?: boolean,
) {

    let gl = this.gl;
    let gpu = this.gpu;

    this.type_ = type_;

    //filter = 'trilinear'; aniso = null; this.gpu.anisoLevel = 0;
    var width = image.naturalWidth;
    var height = image.naturalHeight;

    this.texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);

    const wrap = repeat ? gl.REPEAT : gl.CLAMP_TO_EDGE;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap);

    this.mipmapped = false;
    this.filter = filter;

    switch (filter) {
    case 'linear':
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        break;
    case 'trilinear':
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        this.mipmapped = true;
        break;
    default:
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        break;
    }

    if (gpu.anisoExt && gpu.anisoLevel) {
        gl.texParameterf(gl.TEXTURE_2D, gpu.anisoExt.TEXTURE_MAX_ANISOTROPY_EXT, gpu.anisoLevel);
    }

    let levels = 1;
    if (this.mipmapped)
        levels = Math.floor(Math.log2(Math.max(width, height))) + 1;

    switch (this.type_) {

        case GpuTexture.Type.NormalMap:

            gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
            gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);

            gl.texStorage2D(gl.TEXTURE_2D, levels, gl.RG8, width, height);
            gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RG, gl.UNSIGNED_BYTE, image);

            break;

        case GpuTexture.Type.Mask:

            gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
            gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);

            gl.texStorage2D(gl.TEXTURE_2D, levels, gl.R8, width, height);
            gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RED, gl.UNSIGNED_BYTE, image);

            break;

        default:
            gl.texStorage2D(gl.TEXTURE_2D, levels, gl.RGBA8, width, height);
            gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, image);
    }


    if (this.mipmapped) gl.generateMipmap(gl.TEXTURE_2D);

    gl.bindTexture(gl.TEXTURE_2D, null);

    this.width = width;
    this.height = height;
    this.loaded = true;
};

private load(
    path: string,
    onLoaded: (() => void) | undefined,
    onError: (() => void) | undefined,
    direct: boolean,
    keepImage: boolean,
) {
    this.image = utils.loadImage(path, () => {
        if (this.core != null && this.core.killed) {
            return;
        }

        this.createFromImage(this.image!, this.type_, this.filter, this.repeat);

        if (!keepImage) {
            this.image = null;
        }

        if (onLoaded) {
            onLoaded();
        } else {
            if (this.core.map && this.core.map.markDirty) {
                this.core.map.markDirty();
            }
        }

    }, () => {

        if (this.core != null && this.core.killed) {
            return;
        }

        if (onError) {
            onError();
        }

    }, false, direct);

};


createFramebufferFromData(lx: GLsizei, ly: GLsizei, data: Uint8Array) {
    var gl = this.gl;

    console.log("Creating framebuffer from data.");

    this.type_ = GpuTexture.Type.Color;

    var framebuffer = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);

    var texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);

    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);

    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, lx, ly, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);

    var renderbuffer = gl.createRenderbuffer();
    gl.bindRenderbuffer(gl.RENDERBUFFER, renderbuffer);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT16, lx, ly);

    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);

    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, renderbuffer);

    this.width = lx;
    this.height = ly;

    this.texture = texture;
    this.renderbuffer = renderbuffer;
    this.framebuffer = framebuffer;

    gl.bindTexture(gl.TEXTURE_2D, null);
    gl.bindRenderbuffer(gl.RENDERBUFFER, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
};


createFramebuffer = (lx: GLsizei, ly: GLsizei) => {
    if (this.texture == null){
        return;
    }

    var gl = this.gl;

    var framebuffer = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);

    gl.bindTexture(gl.TEXTURE_2D, this.texture);

    var renderbuffer = gl.createRenderbuffer();
    gl.bindRenderbuffer(gl.RENDERBUFFER, renderbuffer);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT16, lx, ly);

    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.texture, 0);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, renderbuffer);

    gl.bindTexture(gl.TEXTURE_2D, null);
    gl.bindRenderbuffer(gl.RENDERBUFFER, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    this.framebuffer = framebuffer;
    this.renderbuffer = renderbuffer;
};


/**
 * Read pixels from this texture's framebuffer attachment.
 *
 * The actual framebuffer binding is delegated to `GpuDevice` so readback
 * does not expose raw framebuffer switching as public render-path state.
 *
 * @param x Left coordinate in framebuffer pixels.
 * @param y Bottom coordinate in framebuffer pixels.
 * @param lx Width of the read rectangle in pixels.
 * @param ly Height of the read rectangle in pixels.
 * @param data Optional destination buffer. A new buffer is allocated when
 * omitted.
 * @returns Pixel data in RGBA/UNSIGNED_BYTE layout.
 */
readFramebufferPixels(
    x: number, y: number, lx: number, ly: number,
    data?: Uint8Array) : Uint8Array {

    if (!this.texture) throw new Error(
        "GpuTexture.readFramebufferPixels: Texture not initialized.");

    return this.gpu.readFramebufferPixels(this, x, y, lx, ly, data);
};


} // class GpuTexture

// local types
// export types

export namespace GpuTexture {

    export type Filter = 'linear' | 'trilinear' | 'nearest';

    /**
     * Texture storage and upload format.
     *
     * Values match the legacy `TEXTURETYPE_*` constants while JavaScript
     * callers are still being migrated.
     */
    export enum Type {
        /** Standard RGBA8 colour texture. Used for imagery and user images. */
        Color = 0,

        /**
         * Legacy height data. `MapSubtexture` decodes it to CPU image data
         * for metatile and height-value lookups.
         */
        Height = 1,

        /**
         * Classification texture from bound layers. Uploaded as RGBA8 with
         * nearest filtering by current legacy callers.
         */
        Class = 2,

        /** Normal map texture. Uploaded as RG8 from two-channel images. */
        NormalMap = 3,

        /** Coverage mask texture. Uploaded as single-channel R8. */
        Mask = 4,

        /**
         * Atmosphere density lookup texture. CPU-decoded from an image and
         * uploaded as RGB8UI.
         */
        AtmosphereDensity = 5,

        /**
         * Depth hitmap texture. Stores raw float32 depth bit patterns as four
         * little-endian bytes in an RGBA8UI framebuffer attachment.
         */
        DepthUint = 6,
    }
}

export default GpuTexture;
