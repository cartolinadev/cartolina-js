
// rendering flags

const int FlagNone           = 0;
const int FlagLighting       = 1 << 0; // bit 0
const int FlagNormalMap      = 1 << 1; // bit 1
const int FlagDiffuseMaps    = 1 << 2; // bit 2
const int FlagSpecularMaps   = 1 << 3; // bit 3
const int FlagBumpMaps       = 1 << 4; // bit 4
const int FlagAtmosphere     = 1 << 5; // bit 5
const int FlagShadows        = 1 << 6; // bit 6

// the per frame configuration

layout(std140) uniform uboFrame {

    // view and projection matrices
    highp mat4 view;
    highp mat4 projection;

    // celestial body params
    highp vec4 bodyParams; // majorAxis, majorAxis / minorAxis, zw reserved

    // vertical exaggeration parameters 1
    highp vec4 vaParams1; // h1, f1, h2, f2
    highp vec4 vaParams2; // h2 - h1, f2 - f1, 1.0 / (h2 - h1), w reserved

    // renderingFlags
    highp ivec4 renderFlags; // renderFlags (see above), yzw reserved

    // clip margin
    highp vec4 clipParams; // x = clipMargin, yzw reserved

} uFrame;
