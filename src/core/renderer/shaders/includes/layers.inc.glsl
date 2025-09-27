

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

    highp ivec4 p0; // x: srcShadeType / srcTextureTexture sampler
              // y: srcShadeNormal / srcTextureMask sampler
              // z: srcTextureUVs
              // w: opBlendMode

    highp vec4 p1;  // xyz: srcConstant / xyzw: srcTextureTransform
    highp vec4 p2;  // x: opBlendAlpha, y: tgtColorWhitewash, zw: reserved
};

/* the ubo with raw layer array */

#define MAX_LAYERS                      16
#define MAX_TEXTURES                    14

layout (std140) uniform uboLayers {

    highp ivec4 layerCount; // x: layerCount, yzw: reserved

    LayerRaw layers[MAX_LAYERS];
};


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

// Layer decodeLayer(int index) {}
