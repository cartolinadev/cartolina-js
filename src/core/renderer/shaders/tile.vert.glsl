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
    vec3 geoPos = worldPos.xyz + uFrame.physicalEyePos.xyz;
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

