#version 300 es
precision highp float;
precision highp int;

/*
 * One point per position-unit pair. The pairs are grouped by unit, so a
 * draw carries every position that asks the currently bound unit.
 */

// result column in the two-row target
in float aIndex;

// position within the unit, u east and v south
in vec2 aUv;

// place of this unit in the CPU's GSD ordering for that position
in float aPreference;

// width of the result target, in texels
uniform float uResultWidth;

// greatest preference index in this submission
uniform float uMaxPreference;

// 0 writes the height row, 1 the preference-index row
uniform int uRow;

out vec2 vUv;
out float vPreference;

void main() {

    vUv = aUv;
    vPreference = aPreference;

    float x = (aIndex + 0.5) / uResultWidth * 2.0 - 1.0;
    float y = (float(uRow) + 0.5) / 2.0 * 2.0 - 1.0;

    // Depth rises with the preference index and the test is LESS, so the
    // valid unit nearest the start of the CPU ordering wins whatever the
    // draw order. The attachment is cleared to one, which no record can
    // reach.
    float depth = (aPreference + 1.0) / (uMaxPreference + 2.0);

    gl_PointSize = 1.0;
    gl_Position = vec4(x, y, depth * 2.0 - 1.0, 1.0);
}
