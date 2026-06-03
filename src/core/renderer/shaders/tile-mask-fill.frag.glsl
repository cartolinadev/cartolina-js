#version 300 es
precision highp float;

uniform int uQuadrantMask;

in vec2 vUV;

out float fragCoverage;

void main() {

    int quadrant = 0;
    if (vUV.x >= 0.5) quadrant |= 1;
    if (vUV.y >= 0.5) quadrant |= 2;

    int bit = 1 << quadrant;
    fragCoverage = ((uQuadrantMask & bit) != 0) ? 1.0 : 0.0;
}
