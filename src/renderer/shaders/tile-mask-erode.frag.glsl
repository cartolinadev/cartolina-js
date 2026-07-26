#version 300 es
precision highp float;

uniform sampler2D uSource;
uniform vec2 uTexelSize;

in vec2 vUV;

out float fragCoverage;

void main() {

    float center = texture(uSource, vUV).r;

    if (vUV.x <= uTexelSize.x || vUV.y <= uTexelSize.y
            || vUV.x >= 1.0 - uTexelSize.x
            || vUV.y >= 1.0 - uTexelSize.y) {

        fragCoverage = center;
        return;
    }

    float covered = center;

    for (int y = -1; y <= 1; y++) {

        for (int x = -1; x <= 1; x++) {

            vec2 offset = vec2(float(x), float(y)) * uTexelSize;
            covered = min(covered, texture(uSource, vUV + offset).r);
        }
    }

    fragCoverage = covered;
}
