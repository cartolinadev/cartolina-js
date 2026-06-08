#version 300 es
precision highp float;

// varyings
in float vDepth;
in vec2 vTexCoords2;

// frame ubo
#include "./includes/frame.inc.glsl";

uniform sampler2D uMask;
uniform bool uMaskEnabled;

// render target
out uvec4 fragColor;

// main

void main() {

    if (uMaskEnabled) {

        float covered = texture(uMask, vTexCoords2).r;
        if (covered > frameMaskThreshold()) discard;
    }

    /*
     * Store the raw IEEE 754 bit pattern of vDepth as four bytes in
     * little-endian order (LSB in R). The RGBA8UI attachment writes the
     * exact integer bytes with no float normalization. The CPU reads them
     * back with DataView.getFloat32(..., true).
     */
    uint depthBits = floatBitsToUint(vDepth);

    fragColor = uvec4(
         depthBits         & 0xFFu,
        (depthBits >>  8u) & 0xFFu,
        (depthBits >> 16u) & 0xFFu,
         depthBits >> 24u);
}
