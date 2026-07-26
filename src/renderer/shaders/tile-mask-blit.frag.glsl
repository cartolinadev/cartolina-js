#version 300 es
precision highp float;

uniform sampler2D uSource;

in vec2 vUV;

out float fragCoverage;

void main() {

    fragCoverage = texture(uSource, vUV).r;
}
