#version 300 es
precision highp float;

// vertex position, in normalized submesh coordinates
in vec3 aPosition;

// external texture coordinates
in vec2 aTexCoords2;

// frameUbo + rendering flags
#include "./includes/frame.inc.glsl";

// model matrix, aPosition -> worldPos
uniform mat4 uModel;

// output (varyings)
out float vDepth;           // depth value to be written into output
out vec2 vTexCoords2;       // external texture coordinates

// main
void main() {

    // obtain worldPos
    vec4 worldPos = uModel * vec4(aPosition, 1.0);

    // apply vertical exaggeration
    float verticalExaggeration;

    worldPos = applyVerticalExaggeration(worldPos, verticalExaggeration);

    // obtain view space coords
    vec4 worldPosVC = uFrame.view * worldPos;

    // output
    vDepth = length(worldPosVC.xyz);
    vTexCoords2 = aTexCoords2;
    gl_Position = uFrame.projection * worldPosVC;

 }
