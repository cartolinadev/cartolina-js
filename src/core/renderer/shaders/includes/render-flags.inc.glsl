#ifndef RENDER_FLAGS_INC_GLSL
#define RENDER_FLAGS_INC_GLSL

// rendering flags

const int FlagNone               = 0;
const int FlagLighting           = 1 << 0;  // bit 0
const int FlagNormalMaps         = 1 << 1;  // bit 1
const int FlagDiffuseMaps        = 1 << 2;  // bit 2
const int FlagSpecularMaps       = 1 << 3;  // bit 3
const int FlagBumpMaps           = 1 << 4;  // bit 4
const int FlagAtmosphere         = 1 << 5;  // bit 5
const int FlagShadows            = 1 << 6;  // bit 6
const int FlagUseLabels          = 1 << 7;  // bit 7
const int FlagShadingLambertian  = 1 << 8;  // bit 8
const int FlagShadingSlope       = 1 << 9;  // bit 9
const int FlagShadingAspect      = 1 << 10; // bit 10

int decodeRenderFlags(ivec4 raw) {
    return raw.x | (raw.y << 8);
}

#endif
