// test/sandbox/atmosphere-density/main.ts
//
// Diagnostic app: compare CPU-decoded atmosphere density RGB vs GPU sampling.
//
// Engine touchpoints:
// - Config parsing: MapConfig(map, json)  (src/core/map/config.js)
// - Atmosphere helper: Atmosphere.decodeAtmosphereDensity(img: ImageData)
// - GPU parity: upload as RGB8UI with format RGB_INTEGER (matches engine)

import {Core} from '../../../src/core/core.js';
import Atmosphere from '../../../src/core/map/atmosphere'; 

const MAP_CONFIG_URL = 'https://cdn.tspl.re/mapproxy/melown2015/surface/topoearth/copernicus-dem-glo30/mapConfig.json';


// WebGL2 helper: draw full-screen quad sampling a RGB8UI texture with usampler2D
function initGL(width: number, height: number, mount: HTMLElement) {
  const canvas = document.createElement('canvas');
  canvas.width = width; canvas.height = height;
  mount.replaceChildren(canvas);
  const gl = canvas.getContext('webgl2') as WebGL2RenderingContext | null;
  if (!gl) throw new Error('WebGL2 not supported');

  const vsSrc = `#version 300 es
    precision highp float;
    const vec2 QUAD[4] = vec2[4]( vec2(-1.,-1.), vec2(1.,-1.), vec2(-1.,1.), vec2(1.,1.) );
    out vec2 vUv;
    void main() {
      vUv = (QUAD[gl_VertexID].xy + 1.0) * 0.5;
      gl_Position = vec4(QUAD[gl_VertexID], 0., 1.);
    }`;

  const fsSrc = `#version 300 es
    precision highp float;
    precision highp usampler2D;
    in vec2 vUv;
    uniform usampler2D uTex;
    out vec4 frag;
    void main() {
      uvec3 u = texture(uTex, vUv).rgb;
      frag = vec4(vec3(u) / 255.0, 1.0);
    }`;

  const compile = (type: number, src: string) => {
    const sh = gl.createShader(type)!; gl.shaderSource(sh, src); gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      throw new Error(String(gl.getShaderInfoLog(sh)));
    }
    return sh;
  };

  const prog = gl.createProgram()!;
  gl.attachShader(prog, compile(gl.VERTEX_SHADER, vsSrc));
  gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, fsSrc));
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    throw new Error(String(gl.getProgramInfoLog(prog)));
  }

  const vao = gl.createVertexArray()!;
  gl.bindVertexArray(vao);
  gl.useProgram(prog);
  const uLoc = gl.getUniformLocation(prog, 'uTex');

  return { gl, prog, uLoc, vao };
}

// CPU path: blit interleaved RGB to <canvas>
function drawRgbToCanvas(rgb: Uint8Array, width: number, height: number, mount: HTMLElement) {
  const canvas = document.createElement('canvas');
  canvas.width = width; canvas.height = height;
  mount.replaceChildren(canvas);
  const ctx = canvas.getContext('2d')!;
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let i = 0, j = 0; i < rgb.length; i += 3, j += 4) {
    rgba[j] = rgb[i];
    rgba[j + 1] = rgb[i + 1];
    rgba[j + 2] = rgb[i + 2];
    rgba[j + 3] = 255;
  }
  const imgData = new ImageData(rgba, width, height);
  ctx.putImageData(imgData, 0, 0);
}

(async function main() {

  const left = document.getElementById('left')!;
  const right = document.getElementById('right')!;
  const info = document.getElementById('info')!;

  // 1) Fetch and parse mapConfig.json via Cartolina's core object
  let div = document.createElement('div');
  div.style.width = '10px';
  div.style.height = '10px';

  const core = new Core(div, {'map': MAP_CONFIG_URL}); 
  await core.ready;
  console.log('Core ready');

  // 2) await atmosphere readiness
  let atm = core.map!.atmosphere as Atmosphere;
  let atmReady = new Promise<void>((resolve) => {
      let tick = () => {

          if (atm.isReady()) { resolve(); return; }
          requestAnimationFrame(tick);
      }

      tick();
  })

  await atmReady;
  console.log('Atmosphere ready');

  // 3) Fetch density PNG and read to ImageData
  const img = new Image();
  img.crossOrigin = 'anonymous'
  img.src = core.map!.url.processUrl(atm.atmDensityTexture.mainTexture.mapLoaderUrl);

  console.log(img.src);
  await img.decode();

  const tmp = document.createElement('canvas');
  tmp.width = img.naturalWidth; tmp.height = img.naturalHeight;
  const tctx = tmp.getContext('2d')!;
  tctx.drawImage(img, 0, 0);
  const imgData = tctx.getImageData(0, 0, tmp.width, tmp.height);

  // 4) Decode stacked grayscale to RGB using Cartolina's helper
  const decoded = Atmosphere.decodeAtmosphereDensity(imgData) as {
    width: number; height: number; data: Uint8Array
  };

  // 5) LEFT: CPU canvas
  drawRgbToCanvas(decoded.data, decoded.width, decoded.height, left);

  // 6) RIGHT: WebGL2 (RGB8UI)
  let [width, height] = atm.atmDensityTexture.getImageExtents();

  /*core.map!.renderer.gpu.bindTexture(
      atm.atmDensityTexture.getGpuTexture(),
      core.map!.renderer.textureIdxs.atmosphere);

  const pixels = new Uint8Array(width * height * 3);*/

  const { gl, prog, uLoc, vao } = initGL(width, height, right);

  const tex = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
  gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 0);
  gl.texImage2D(
    gl.TEXTURE_2D, 0,
    gl.RGB8UI,
    width, height, 0,
    gl.RGB_INTEGER, gl.UNSIGNED_BYTE,
    atm.atmDensityTexture.mainTexture.decoded.data);
  gl.bindTexture(gl.TEXTURE_2D, null);

  gl.viewport(0, 0, width, height);
  gl.useProgram(prog);

  //core.map!.renderer.gpu.bindTexture(
  //    atm.atmDensityTexture.getGpuTexture(),
  //    core.map!.renderer.textureIdxs.atmosphere);

  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, tex);

  //gl.uniform1i(uLoc, core.map!.renderer.textureIdxs.atmosphere);
  gl.uniform1i(uLoc, 0);
  gl.bindVertexArray(vao);

  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

  // 7) Info
  info.textContent =
    `Loaded ${img.naturalWidth}×${img.naturalHeight} density image → decoded RGB ${decoded.width}×${decoded.height}. URL: ${img.src}`;
})();
