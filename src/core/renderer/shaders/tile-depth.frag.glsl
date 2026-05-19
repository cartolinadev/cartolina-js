#version 300 es
precision highp float;

// varyings
in float vDepth;
in vec2 vTexCoords2;

// frame ubo
#include "./includes/frame.inc.glsl";

// tile quadrant clipping
#include "./includes/tile-clip.inc.glsl";

// render target
out vec4 fragColor;

// main

void main() {

    applyTileClip(vTexCoords2, uFrame.clipParams.x);

    // original float RGBA encoding, including the old bias term
    fragColor = fract(
        vec4(1.0, 1.0/255.0, 1.0/65025.0, 1.0/16581375.0) * vDepth)
        + (-0.5/255.0);
}
