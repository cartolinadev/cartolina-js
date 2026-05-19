#version 300 es
precision highp float;

// atmUbo + atmDensity() + uTexAtmDensity sampler
#include "./includes/atmosphere.inc.glsl";

// vertex position, in normalized submesh coordinates
in vec3 aPosition;

// internal texture coordinates
in vec2 aTexCoords;

// external texture (and/or normalmap) coordinates
in vec2 aTexCoords2;

// frameUbo + rendering flags
#include "./includes/frame.inc.glsl";


// model matrix, aPosition -> worldPos
uniform mat4 uModel;

// output (varyings)
out vec3 vFragPos;          // fragment position in world coordinates
out vec3 vFragPosVC;        // fragment position in view coordinates
out vec3 vEllipsoidZenith;  // ellipsoid normal at fragment, in world coordinates
out vec2 vTexCoords;        // internal texture coordinates
out vec2 vTexCoords2;       // external texture/normal coordinates
out float vAtmDensity;      // atm density at fragment
out float vVerticalExaggeration; // vertical exaggeration factor at fragment


// main
void main() {

    // obtain worldPos
    vec4 worldPos = uModel * vec4(aPosition, 1.0);

    // apply vertical exaggeration
    worldPos = applyVerticalExaggeration(worldPos, vVerticalExaggeration);

    // obtain view space coords
    vec4 worldPosVC = uFrame.view * worldPos;

    // obtain atmospheric density
    float atmDensity_ = atmDensity(worldPosVC.xyz);

    // output
    gl_Position = uFrame.projection * worldPosVC;

    vFragPos = worldPos.xyz;
    vFragPosVC = worldPosVC.xyz;
    vEllipsoidZenith = computeEllipsoidZenith(worldPos);
    vTexCoords = aTexCoords;
    vTexCoords2 = aTexCoords2;
    vAtmDensity = atmDensity_;
}

