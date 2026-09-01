#version 300 es
precision highp float;
precision highp int;

in float vHeight;
in vec2 vTexCoords2;

#include "./includes/frame.inc.glsl";
#include "./includes/elevation.inc.glsl";

uniform sampler2D uMask;
uniform bool uMaskEnabled;

// height range of the reference frame, used for depth ordering
uniform vec2 uHeightRange;

out uvec4 fragColor;

void main() {

    vec2 sampleUv = floor(gl_FragCoord.xy) / elevationSampleSpan;

    // Undo the raster overscan. Height is affine within each triangle,
    // so screen derivatives recover the value at the exact sample UV.
    vec2 offset = (sampleUv - vTexCoords2)
        * (elevationSampleSpan + 0.5);
    float height = vHeight
        + dFdx(vHeight) * offset.x
        + dFdy(vHeight) * offset.y;

    // Coverage already established by finer children and higher-priority
    // terrain sources; this draw only fills what they left uncovered.
    if (uMaskEnabled) {

        float covered = texture(uMask, sampleUv).r;
        if (covered > frameMaskThreshold()) discard;
    }

    // Greatest height wins where projected triangles of this one rig
    // overlap, so depth falls as height rises; the attachment is cleared
    // to one and tested LEQUAL.
    float depth = (uHeightRange.y - height)
        / (uHeightRange.y - uHeightRange.x);

    // A height outside the reference frame's declared range is a
    // reference-frame or terrain-data error, and contributes nothing.
    if (!(depth >= 0.0 && depth <= 1.0)) discard;

    gl_FragDepth = depth;
    fragColor = elevationEncode(height);
}
