// test/sandbox/atmosphere-density/main.ts
//
// Diagnostic app: compare CPU-decoded atmosphere density RGB vs GPU sampling.
// Uses Cartolina from the global ESM build (externalized to /build/cartolina.esm.js),
// so the sandbox bundle only contains this prototype code.
//
// Engine touchpoints:
// - Config parsing: MapConfig(map, json)  (src/core/map/config.js)
// - Atmosphere helper: Atmosphere.decodeAtmosphereDensity(img: ImageData)
// - GPU parity: upload as RGB8UI with format RGB_INTEGER (matches engine)

import MapConfig from '../../../src/core/map/config.js';     // <-- source (line 12)
import MapUrl from '../../../src/core/map/url.js';

import Atmosphere from '../../../src/core/map/atmosphere';   // <-- source (line 13)

import proj4 from 'proj4';  

import * as utils from '../../../src/core/utils/utils.js';

const MAP_CONFIG_URL = 'https://cdn.tspl.re/mapproxy/melown2015/surface/topoearth/copernicus-dem-glo30/mapConfig.json';

type AnyDict = Record<string, any>;

// Minimal Map stub; enough for config.js and atmosphere to operate.
class Renderer {

  getSuperElevationState(): boolean { return false; }
  getSeProgressionFactor(): number { return 1.0; }
};

class SandboxMap {
  proj4: any;
  stats = { loadedCount: 0, loadErrorCount: 0, loadFirst: 0, loadLast: 0, gpuRenderUsed: 0, renderBuild: 0 };
  draw = { maxGpuUsed: 999999 };
  config = { mapXhrImageLoad: true };

  // Use any here because constructors come from external ESM namespace.
  srs: Record<string, any> = {};
  bodies: Record<string, any> = {};
  referenceFrame: any = null;
  services: AnyDict = {};
  url: MapUrl;
  renderer: Renderer;

  addSrs = (id: string, srs: any) => { this.srs[id] = srs; };
  addBody = (id: string, body: any) => { this.bodies[id] = body; };

  getMapsSrs() { return this.srs; }
  getPublicSrs() { return this.getPhysicalSrs(); }
  getNavigationSrs() { return this.getPhysicalSrs(); }
  getPhysicalSrs() {
    const rf = this.referenceFrame;
    const srsId = (rf && rf.srs) ? rf.srs : Object.keys(this.srs)[0];
    return this.srs[srsId];
  }

  getBody(id) {
    return this.bodies[id];
  };

  addCredit(any) {};
  addSurface(any) {};

  // no-ops required by config.js in a few places
  setPosition() { /* noop */ }
  setView() { /* noop */ }
  callListener() { /* noop */ }
  
  constructor (path: string) {
      this.url = new MapUrl(this, path);
      this.renderer = new Renderer();
  }
}


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

  return { gl, canvas, prog, vao, uLoc };
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

  // 1) Fetch and parse mapConfig.json via Cartolina's config.js
  const cfgResp = await fetch(MAP_CONFIG_URL);
  if (!cfgResp.ok) throw new Error(`Failed to fetch mapConfig.json: ${cfgResp.status}`);
  const configJson = await cfgResp.json();

  const map = new SandboxMap(MAP_CONFIG_URL);
  map.proj4 = proj4;

  // MapConfig(map, json) parses srs/bodies/services/referenceFrame internally.
  const cfg = new MapConfig(map, configJson);
  
  // If your MapConfig version requires an explicit parse step, uncomment:
  // cfg.parseConfig();

  // Pull parsed objects
  const bodyId = configJson.referenceFrame.body;
  const body = map.bodies[bodyId];
  if (!body || !body.atmosphere) throw new Error('No atmosphere in selected body');

  const srs = map.getPhysicalSrs();
  const services = map.services || {};

  const atmdensityUrl = (services.atmdensity && services.atmdensity.url) || './atm-density.png';
  console.log(atmdensityUrl);

  // 2) Initialize Atmosphere similarly to engine path (constructor parity)
  const atm = new Atmosphere(body.atmosphere, srs, atmdensityUrl, map);
  // Note: for this diagnostic we only use Atmosphere.decodeAtmosphereDensity below.

  // 3) Fetch density PNG and read to ImageData
  const img = new Image();
  img.crossOrigin = 'anonymous'
  img.src = map.url.processUrl(atm.atmDensityTexture.mainTexture.mapLoaderUrl);

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
  const { gl, uLoc } = initGL(decoded.width, decoded.height, right);

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
    decoded.width, decoded.height, 0,
    gl.RGB_INTEGER, gl.UNSIGNED_BYTE,
    decoded.data
  );
  gl.bindTexture(gl.TEXTURE_2D, null);

  gl.viewport(0, 0, decoded.width, decoded.height);
  gl.useProgram(gl.getParameter(gl.CURRENT_PROGRAM));
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.uniform1i(uLoc, 0);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

  // 7) Info
  info.textContent =
    `Loaded ${img.naturalWidth}×${img.naturalHeight} density image → decoded RGB ${decoded.width}×${decoded.height}. URL: ${img.src}`;
})();
