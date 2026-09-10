#version 300 es
precision highp float;
precision highp int;
precision highp usampler2D;

#include "./includes/elevation.inc.glsl";

/*
 * Reduces four published child units into their parent unit.
 *
 * The children are bound in tile-quadrant order — north-west, north-east,
 * south-west, south-east — matching `MapSurfaceTile.children`. Their
 * shared edges hold nearly the same position in both neighbours, so
 * together they form one 511 by 511 grid; parent sample [i, j] sits at
 * child-grid sample [2i, 2j] and takes the separable [1, 2, 1] / 4
 * weights in each dimension. Invalid samples carry no weight and the rest
 * are renormalized, so an all-invalid neighbourhood produces an invalid
 * parent sample.
 */

uniform usampler2D uChild0;
uniform usampler2D uChild1;
uniform usampler2D uChild2;
uniform usampler2D uChild3;

// one bit per child, in the same order; a missing child contributes
// nothing
uniform int uChildPresent;

// height range of the reference frame: the sample's quantization domain
uniform vec2 uHeightRange;

out uint fragColor;

const int gridMax = 510;
const int childMax = 255;

// One texel of the child bound at `quadrant`.
uint childSample(int quadrant, ivec2 texel) {

    if (quadrant == 0) return texelFetch(uChild0, texel, 0).r;
    if (quadrant == 1) return texelFetch(uChild1, texel, 0).r;
    if (quadrant == 2) return texelFetch(uChild2, texel, 0).r;

    return texelFetch(uChild3, texel, 0).r;
}

// One sample of the combined child grid, invalid where no child covers it.
uint childGridSample(int x, int y) {

    // The shared edge at 255 belongs to both neighbours and holds the
    // same position in each, so any present neighbour with a valid
    // sample there may answer; the east or south one is asked first.
    int columnHigh = x < childMax ? 0 : 1;
    int columnLow = x > childMax ? 1 : 0;
    int rowHigh = y < childMax ? 0 : 1;
    int rowLow = y > childMax ? 1 : 0;

    for (int row = rowHigh; row >= rowLow; row--) {

        for (int column = columnHigh; column >= columnLow; column--) {

            int quadrant = row * 2 + column;
            if ((uChildPresent & (1 << quadrant)) == 0) continue;

            uint sample_ = childSample(
                quadrant, ivec2(x - column * childMax, y - row * childMax));
            if (elevationValid(sample_)) return sample_;
        }
    }

    return elevationInvalid;
}

void main() {

    ivec2 parent = ivec2(gl_FragCoord.xy);
    ivec2 centre = parent * 2;

    float sum = 0.0;
    float weightSum = 0.0;

    for (int dy = -1; dy <= 1; dy++) {

        for (int dx = -1; dx <= 1; dx++) {

            // the grid has no samples past its outer boundary, so the
            // neighbourhood folds back onto the boundary sample there
            int x = clamp(centre.x + dx, 0, gridMax);
            int y = clamp(centre.y + dy, 0, gridMax);

            uint sample_ = childGridSample(x, y);
            if (!elevationValid(sample_)) continue;

            float weight = (dx == 0 ? 2.0 : 1.0) * (dy == 0 ? 2.0 : 1.0);

            sum += elevationDecode(sample_, uHeightRange) * weight;
            weightSum += weight;
        }
    }

    if (weightSum == 0.0) {

        fragColor = elevationInvalid;
        return;
    }

    fragColor = elevationEncode(sum / weightSum, uHeightRange);
}
