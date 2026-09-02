
#ifndef LAYERS_INC_GLSL
#define LAYERS_INC_GLSL

#include "./render-flags.inc.glsl";


/* raw layer,  as encoded in ubo */

struct LayerRaw {

    highp ivec4 tag; // x: target
                     // y: source
                     // z: operation
                     // w: srcTextureSampling

    highp ivec4 p0; // x: srcShadeType / srcTextureTexture
              // y: srcShadeNormal / srcTextureMask sampler array idx
              // z: srcTextureUVs
              // w: opBlendMode

    highp vec4 p1;  // xyz: srcConstant / xyzw: srcTextureTransform
    highp vec4 p2;  // x: opBlendAlpha, y: tgtColorWhitewash, zw: reserved
    highp ivec4 p3; // x: flagMask low byte, y: flagMask high byte (same encoding as frame renderFlags)
                    // zw: reserved
};

/* the ubo with raw layer array */

/* see the individual uniforms below before you change these constants. */

#define MAX_LAYERS                      16
#define MAX_TEXTURES                    12

layout (std140) uniform uboLayers {

    highp ivec4 layerCount; // x: layerCount, yzw: reserved

    LayerRaw layers[MAX_LAYERS];
} uLayers;


/* Individually named samplers to avoid array indexing issues in iOS/Metal */

// MAX_TEXTURES = 12

uniform sampler2D uTexture[MAX_TEXTURES];


/* a cyan error pixel for diagnostics */
const vec4 errColor = vec4(0.0, 1.0, 1.0, 1.0);

/* Switch ladder with constant cases */
vec4 sample2D(int idx, vec2 uv) {

  if (idx == 0) return texture(uTexture[0], uv);
  if (idx == 1) return texture(uTexture[1], uv);
  if (idx == 2) return texture(uTexture[2], uv);
  if (idx == 3) return texture(uTexture[3], uv);
  if (idx == 4) return texture(uTexture[4], uv);
  if (idx == 5) return texture(uTexture[5], uv);
  if (idx == 6) return texture(uTexture[6], uv);
  if (idx == 7) return texture(uTexture[7], uv);
  if (idx == 8) return texture(uTexture[8], uv);
  if (idx == 9) return texture(uTexture[9], uv);
  if (idx == 10) return texture(uTexture[10], uv);
  if (idx == 11) return texture(uTexture[11], uv);

  return errColor;

}

#endif
