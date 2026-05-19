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
out float fragColor;

// main

void main() {

    applyTileClip(vTexCoords2, uFrame.clipParams.x);

    fragColor = vDepth;
}
