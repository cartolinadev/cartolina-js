

const int target_Color              = 0;
const int target_Normal             = 1;

const int source_Constant           = 1;
const int source_Texture            = 0;
const int source_Pop                = 2;
const int source_Shade              = 3;
const int source_AtmDensity         = 4;
const int source_Shadows            = 5;
const int source_None               = 6;

const int operation_Blend           = 0;
const int operation_Push            = 1;
const int operation_AtmColor        = 2;
const int operation_Shadows         = 4;
const int operation_NormalBlend     = 5;

const int shadeType_Diffuse         = 0;
const int shadeType_Specular        = 1;

const int shadeNormal_NormalMap     = 0;
const int shadeNormal_Flat          = 1;

const int blendMode_Overlay             = 0;
const int blendMode_Add                 = 1;
const int blendMode_Multiply            = 2;
const int blendMode_specularMultiply    = 3;

const int textureUVs_External           = 0;
const int textureUVs_Internal           = 1;


/* raw layer,  as encoded in ubo */

struct LayerRaw {

    highp ivec4 tag; // x: target
                     // y: source
                     // z: operation
                     // w: reserved

    highp ivec4 p0; // x: srcShadeType / srcTextureTexture sampler array idx
              // y: srcShadeNormal / srcTextureMask sampler array idx
              // z: srcTextureUVs
              // w: opBlendMode

    highp vec4 p1;  // xyz: srcConstant / xyzw: srcTextureTransform
    highp vec4 p2;  // x: opBlendAlpha, y: tgtColorWhitewash, zw: reserved
};

/* the ubo with raw layer array */

/* see the individual uniforms below before you change these constants. */

#define MAX_LAYERS                      16
#define MAX_TEXTURES                    12

layout (std140) uniform uboLayers {

    highp ivec4 layerCount; // x: layerCount, yzw: reserved

    LayerRaw layers[MAX_LAYERS];
} uLayers;


/* the decoded layer for processing */

struct Layer {

    int target;
    int source;
    int operation;

    int srcShadeType;
    int srcShadeNormal;

    int srcTextureIdx;
    int srcTextureMaskIdx;
    int srcTextureUVs;

    int opBlendMode;

    vec3 srcConstant;
    float srcTextureTransform[4];
    float opBlendAlpha;
    float targetColorWhitewash;
};


int layerCount() { return uLayers.layerCount.x; }

/* the decode func, transforming ubo-encoded layer into processing format */

Layer decodeLayer(int index) {

    LayerRaw raw = uLayers.layers[index];

    Layer layer;

    layer.target = raw.tag.x;
    layer.source = raw.tag.y;
    layer.operation = raw.tag.z;

    if (layer.source == source_Shade) {

        layer.srcShadeType = raw.p0.x;
        layer.srcShadeNormal = raw.p0.y;
    }

    if (layer.source == source_Texture) {

        layer.srcTextureIdx = raw.p0.x;
        layer.srcTextureMaskIdx = raw.p0.y;
        layer.srcTextureUVs = raw.p0.z;
    }

    if (layer.operation == operation_Blend)
        layer.opBlendMode = raw.p0.w;


    if (layer.source == source_Constant)
        layer.srcConstant = raw.p1.xyz;


    if (layer.source == source_Texture) {

        layer.srcTextureTransform[0] = raw.p1.x;
        layer.srcTextureTransform[1] = raw.p1.y;
        layer.srcTextureTransform[2] = raw.p1.z;
        layer.srcTextureTransform[3] = raw.p1.w;
    }

    if (layer.operation == operation_Blend)
        layer.opBlendAlpha = raw.p2.x;


    if (layer.target == target_Color)
        layer.targetColorWhitewash = raw.p2.y;


    return layer;
}


/* Individually named samplers to avoid array indexing issues in iOS/Metal */

// MAX_TEXTURES = 14

uniform sampler2D uTexture0;
uniform sampler2D uTexture1;
uniform sampler2D uTexture2;
uniform sampler2D uTexture3;
uniform sampler2D uTexture4;
uniform sampler2D uTexture5;
uniform sampler2D uTexture6;
uniform sampler2D uTexture7;
uniform sampler2D uTexture8;
uniform sampler2D uTexture9;
uniform sampler2D uTexture10;
uniform sampler2D uTexture11;

/* a cyan error pixel for diagnostics */
const vec4 errColor = vec4(0.0, 1.0, 1.0, 1.0);

/* Switch ladder with constant cases */
vec4 sample2D(int idx, vec2 uv) {

  if (idx == 0) return texture(uTexture0, uv);
  if (idx == 1) return texture(uTexture1, uv);
  if (idx == 2) return texture(uTexture2, uv);
  if (idx == 3) return texture(uTexture3, uv);
  if (idx == 4) return texture(uTexture4, uv);
  if (idx == 5) return texture(uTexture5, uv);
  if (idx == 6) return texture(uTexture6, uv);
  if (idx == 7) return texture(uTexture7, uv);
  if (idx == 8) return texture(uTexture8, uv);
  if (idx == 9) return texture(uTexture9, uv);
  if (idx == 10) return texture(uTexture10, uv);
  if (idx == 11) return texture(uTexture11, uv);

  return errColor;

}
