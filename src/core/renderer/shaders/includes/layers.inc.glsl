

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

const int blendMode_Overlay             = 0;
const int blendMode_Add                 = 1;
const int blendMode_Multiply            = 2;
const int blendMode_specularMultiply    = 3;

const int textureUVs_External           = 0;
const int textureUVs_Internal           = 1;


struct OpRaw {

    highp ivec4 tag; // x: target
                     // y: source
                     // z: operation
                     // w: reserved

    ivec4 p0; // x: srcShadeType / srcTextureTexture sampler
              // y: srcShadeNormal / srcTextureMask sampler
              // z: srcTextureUVs
              // w: opBlendMode

    vec4 p1;  // xyz: srcConstant / xyzw: srcTextureTransformation
    vec4 p2;  // x: opBlendAlpha, wyz: reserved
    vec4 p3;  // xyz: tgColorWhitewash, w: reserved
};

/*layout (std140) uniform uboLayers {

    OpRaw ops[32];
};*/


uniform sampler2D uTexture[64];

//struct Operation {
//};
