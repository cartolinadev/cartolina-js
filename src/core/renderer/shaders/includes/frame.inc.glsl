
// rendering flags

const int FlagNone           = 0;
const int FlagLighting       = 1 << 0; // bit 0
const int FlagNormalMaps     = 1 << 1; // bit 1
const int FlagDiffuseMaps    = 1 << 2; // bit 2
const int FlagSpecularMaps   = 1 << 3; // bit 3
const int FlagBumpMaps       = 1 << 4; // bit 4
const int FlagAtmosphere     = 1 << 5; // bit 5
const int FlagShadows            = 1 << 6; // bit 6
const int FlagShadingLambertian  = 1 << 7; // bit 7
const int FlagShadingSlope       = 1 << 8; // bit 8
const int FlagShadingAspect      = 1 << 9; // bit 9

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
    highp ivec4 renderFlags; // x: low byte, y: high byte, zw reserved

    // cameraPos, center of view
    highp vec4 physicalEyePos; // xyz- physicalEyePos, w: eyeToCenter

    // illumination
    highp vec4 lightDirection; // z reserved
    mediump vec4 lightAmbient; // z reserved
    mediump vec4 lightDiffuse;  // z reserved
    mediump vec4 lightSpecular; // z reserved
    mediump vec4 shadingParams; // x: lambertian weight, y: slope weight, z: aspect weight, w reserved

    // virtual eye (for shadows and specular reflections)
    highp vec4 virtualEye; // xyz: virtualEyePos, w: virtualEyeToCenter

    // clip margin
    highp vec4 clipParams; // x = clipMargin, yzw reserved
} uFrame;


struct Light {

    vec3 direction;
    vec3 ambient;
    vec3 diffuse;
    vec3 specular;
    float shadingLambertianWeight;
    float shadingSlopeWeight;
    float shadingAspectWeight;
};


struct Eye {

    vec3 physicalPos;
    float eyeToCenter;

    vec3 virtualPos;
    float virtualEyeToCenter;
};

Eye frameEye() {

    Eye eye;
    eye.physicalPos = uFrame.physicalEyePos.xyz;
    eye.eyeToCenter = uFrame.physicalEyePos.w;

    eye.virtualPos = uFrame.virtualEye.xyz;
    eye.virtualEyeToCenter = uFrame.virtualEye.w;

    return eye;
}

int decodeRenderFlags(ivec4 raw) {
    return raw.x | (raw.y << 8);
}

int frameRenderFlags() {
    return decodeRenderFlags(uFrame.renderFlags);
}


Light frameLight() {

    Light light;

    light.direction = uFrame.lightDirection.rgb;
    light.ambient = uFrame.lightAmbient.rgb;
    light.diffuse = uFrame.lightDiffuse.rgb;
    light.specular = uFrame.lightSpecular.rgb;
    light.shadingLambertianWeight = uFrame.shadingParams.x;
    light.shadingSlopeWeight = uFrame.shadingParams.y;
    light.shadingAspectWeight = uFrame.shadingParams.z;

    return light;

}
