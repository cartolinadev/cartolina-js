

const int target_Color              = 0;
const int target_Normal             = 1;

const int source_Constant           = 0;
const int source_Texture            = 1;
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

/* see the sample ladders below before you change these constants. */

#define MAX_LAYERS                      16
#define MAX_TEXTURES                    14

layout (std140) uniform uboLayers {

    highp ivec4 layerCount; // x: layerCount, yzw: reserved

    LayerRaw layers[MAX_LAYERS];
} uLayers;


/* sampler array, a referenced in layer */

uniform sampler2D uTexture[MAX_TEXTURES];


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


/* a cyan error pixel for diagnostics */
const vec4 errPixel = vec4(0.0, 1.0, 1.0, 1.0);


/** the switch ladder needs to be defined to overcome limitation in ESSL which
  * requires all texture array indices to be compile-time constants.
  */

// MAX_TEXTURES = 14
vec4 sample2D(int idx, vec2 uv) {

  switch (idx) {
    case 0:  return texture(uTexture[0], uv);
    case 1:  return texture(uTexture[1], uv);
    case 2:  return texture(uTexture[2], uv);
    case 3:  return texture(uTexture[3], uv);
    case 4:  return texture(uTexture[4], uv);
    case 5:  return texture(uTexture[5], uv);
    case 6:  return texture(uTexture[6], uv);
    case 7:  return texture(uTexture[7], uv);
    case 8:  return texture(uTexture[8], uv);
    case 9:  return texture(uTexture[9], uv);
    case 10: return texture(uTexture[10], uv);
    case 11: return texture(uTexture[11], uv);
    case 12: return texture(uTexture[12], uv);
    case 13: return texture(uTexture[13], uv);
    default: return errPixel;
  }
}
