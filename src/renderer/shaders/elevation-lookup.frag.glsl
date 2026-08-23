#version 300 es
precision highp float;
precision highp int;
precision highp usampler2D;

#include "./includes/elevation.inc.glsl";

in vec2 vUv;
in float vPreference;

// the unit this draw asks
uniform usampler2D uUnit;

// 0 writes the height row, 1 the preference-index row
uniform int uRow;

out uvec4 fragColor;

void main() {

    // The unit stores nearest-filtered bit patterns, so bilinear
    // filtering is done here over the four decoded neighbours. The
    // sample grid includes both tile boundaries
    vec2 grid = clamp(vUv, 0.0, 1.0) * elevationSampleSpan;

    ivec2 base = ivec2(min(floor(grid), 254.0));
    vec2 fraction = grid - vec2(base);

    float weights[4];
    weights[0] = (1.0 - fraction.x) * (1.0 - fraction.y);
    weights[1] = fraction.x * (1.0 - fraction.y);
    weights[2] = (1.0 - fraction.x) * fraction.y;
    weights[3] = fraction.x * fraction.y;

    float height = 0.0;

    for (int i = 0; i < 4; i++) {

        // a sample the interpolation does not reach may be invalid
        // without stopping this unit from answering
        if (weights[i] == 0.0) continue;

        ivec2 texel = base + ivec2(i & 1, i >> 1);
        float sample_ = elevationDecode(texelFetch(uUnit, texel, 0));

        // one uncovered contributor leaves the answer to a later unit
        if (!elevationValid(sample_)) discard;

        height += sample_ * weights[i];
    }

    fragColor = elevationEncode(uRow == 0 ? height : vPreference);
}
