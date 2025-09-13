
import * as utils from '../../utils/utils';
import {GpuDevice} from 'device';

import * as vts from '../../constants';

type Optional<T> = T | null;

// local types
// export types

export namespace GpuTexture {

    export type Filter = 'linear' | 'trilinear' | 'nearest';
}


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

    type_: number = vts.TEXTURETYPE_COLOR;
    mipmapped: boolean = false;

    repeat!: boolean;

    filter!: GpuTexture.Filter;

    loaded: boolean = false;

    // stats
    fileSize!: number;

    constructor(gpu: GpuDevice, path: string, core: any,
                          fileSize : number, direct: boolean, repeat: boolean,
                          filter: GpuTexture.Filter, keepImage?: boolean,
                          onLoaded?: () => void, onError?: () => void) {

        this.gpu = gpu;
        this.gl = gpu.gl;

        this.fileSize = fileSize; //used for stats

        this.repeat = repeat;
        this.filter = filter || 'linear';

        //this.trilinear = false;//true;
        this.core = core;

        if (path != null) {
            this.load(path, onLoaded, onError, direct, keepImage);
        }
    };

//destructor
kill() {
    this.gl.deleteTexture(this.texture);
    
    this.texture = null;
};


/**
 * Return GPU size estimate, in bytes (for cache bookkeeping)
 */
getSize() {

  let bytesPerTexel = 4;

  switch (this.type_) {

      case vts.TEXTURETYPE_NORMALMAP:
          bytesPerTexel = 2;
          break;

      case vts.TEXTURETYPE_MASK:
          bytesPerTexel = 1;
          break;
  }

  const base = this.width * this.height * bytesPerTexel;
  return (this.mipmapped) ? Math.ceil(base * 4/3) : base;
}


createFromData(lx: GLsizei, ly: GLsizei, data: Uint8Array,
    filter: GpuTexture.Filter, repeat?: GLfloat | GLint) {

    var gl = this.gl;

    this.type_ = vts.TEXTURETYPE_COLOR;

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
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        this.mipmapped = true;
        break;
    default:
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        break;
    }

    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);

    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, lx, ly, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);

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
 * @param textureType see constants.ts for texture types
 */

createFromImage(image: HTMLImageElement,
                type_: number, filter: GpuTexture.Filter, repeat?: boolean) {

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

    if (gpu.anisoLevel) {
        gl.texParameterf(gl.TEXTURE_2D, gpu.anisoExt.TEXTURE_MAX_ANISOTROPY_EXT, gpu.anisoLevel);
    }

    let levels = 1;
    if (this.mipmapped)
        levels = Math.floor(Math.log2(Math.max(width, height))) + 1;

    switch (this.type_) {

        case vts.TEXTURETYPE_NORMALMAP:

            gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
            gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);

            gl.texStorage2D(gl.TEXTURE_2D, levels, gl.RG8, width, height);
            gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RG, gl.UNSIGNED_BYTE, image);

            break;

        case vts.TEXTURETYPE_MASK:

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

load(path: string, onLoaded : () => void, onError: () => void, direct: boolean,
    keepImage: boolean) {

    this.image = utils.loadImage(path, (function () {
        if (this.core != null && this.core.killed) {
            return;
        }

        this.createFromImage(this.image, this.type, this.filter, this.repeat);
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

    }).bind(this), (function () {

        if (this.core != null && this.core.killed) {
            return;
        }

        if (onError) {
            onError();
        }
    }).bind(this),
     
     null, direct
     
     );

};


createFramebufferFromData(lx: GLsizei, ly: GLsizei, data: Uint8Array) {
    var gl = this.gl;

    console.log("Creating framebuffer from data.");

    this.type_ = vts.TEXTURETYPE_COLOR;

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


createFramebuffer = function(lx:GLsizei, ly: GLsizei) {
    if (this.texture == null){
        return;
    }

    var gl = this.gl;

    var framebuffer = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    framebuffer.width = lx;
    framebuffer.height = ly;

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


readFramebufferPixels(
    x: number, y: number, lx: number, ly: number, fastMode: boolean = false,
    data?: Uint8Array) : Uint8Array {

    if (this.texture == null) {
        return;
    }

    this.gpu.bindTexture(this);

    if (!fastMode) {
        this.gpu.setFramebuffer(this);
    }

    var gl = this.gl;

    // Read the contents of the framebuffer (data stores the pixel data)
    if (!data) {
        data = new Uint8Array(lx * ly * 4);        
    }
    gl.readPixels(x, y, lx, ly, gl.RGBA, gl.UNSIGNED_BYTE, data);

    if (!fastMode) {
        this.gpu.setFramebuffer(null);
    }

    return data;
};


} // class GpuTexture

export default GpuTexture;


