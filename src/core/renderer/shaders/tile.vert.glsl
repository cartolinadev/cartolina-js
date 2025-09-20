#version 300 es
precision highp float;

#include "./includes/atmosphere.inc.glsl";

// vertex position, in normalized submesh coordinates
in vec3 aPosition;

// internal texture coordinates
in vec2 aTexCoords;

// external texture (and/or normalmap) coordinates
in vec2 aTexCoords2;


// model matrix, aPosition -> worldPos
mat4 uModel;

// rendering flags

const int Illumination      = 1 << 0; // bit 0
const int UseNormalMap      = 1 << 1; // bit 1
const int useDiffuseMap     = 1 << 2; // bit 2
const int useSpecularMap    = 1 << 3; // bit 3
const int useBumpMaps       = 1 << 4; // bit 4
const int useAtmosphere     = 1 << 5; // bit 5
const int useShadows        = 1 << 6; // bit 6

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

// output (varyings)

out vec3 vFragPos;          // fragment position in world coordinates
out vec3 vFragPosVC;        // fragment position in view coordinates
out vec2 vTexCoords;        // internal texture coordinates
out vec2 vTexCoords2;       // external texture/normal coordinates
out float vAtmDensity;      // atm density at fragment


// apply vertical exaggeration on a world position, based on frame configuration

vec4 applyVerticalExaggeration(vec4 worldPos) {

    // this is in an approximation, but sufficient for the purpose
    // we use an estimate of ellipsoidal height to apply exaggeration

    // extract parameters from frame metadata
    float majorAxis = uFrame.bodyParams.x;
    float majorToMinor = uFrame.bodyParams.y;

    float h1 = uFrame.vaParams1.x, f1 = uFrame.vaParams1.y,
          h2 = uFrame.vaParams1.z, f2 = uFrame.vaParams1.w;
    float hdiff = uFrame.vaParams2.x, fdiff = uFrame.vaParams2.y,
          invhdiff = uFrame.vaParams2.z;

    // approximate ellipsoid by a sphere
    vec3 geoPos = worldPos.xyz;
    geoPos.z *= majorToMinor;

    // distance from center
    float ll = length(geoPos.xyz);

    // ellipsoidal height approximation
    float h = ll - majorAxis;

    // h_ = clamp(h, h1, h2)
    float h_ = clamp(h, h1, h2);

    // obtain exaggerated height
    float hNew = h * (f1 + (h_ - h1) / (h2 - h1) * (f2 - f1));

    // local normal (on sphere)
    vec3 v = geoPos.xyz;

    // back to ellipsoid coordinates (transpose of inverse, hence multiply)
    v = normalize(vec3(v.xy, v.z * majorToMinor));

    // move worldPos along the normal by the height difference
    worldPos.xyz += v * (hNew - h);

    // done
    return worldPos;
}

// main

void main() {

    // obtain worldPos
    vec4 worldPos = uModel * vec4(aPosition, 1.0);

    // apply vertical exaggeration
    worldPos = applyVerticalExaggeration(worldPos);

    // obtain view space coords
    vec4 worldPosVC = uFrame.view * worldPos;

    // obtain atmospheric density
    float atmDensity_ = atmDensity(worldPosVC.xyz);

    // output
    gl_Position = uFrame.projection * worldPosVC;

    vFragPos = worldPos.xyz;
    vFragPosVC = worldPosVC.xyz;
    vTexCoords = aTexCoords;
    vTexCoords2 = aTexCoords2;
    vAtmDensity = atmDensity_;
}

