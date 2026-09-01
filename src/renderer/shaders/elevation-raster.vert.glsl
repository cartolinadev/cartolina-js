#version 300 es
precision highp float;
precision highp int;

// vertex position, in normalized submesh coordinates
in vec3 aPosition;

// external texture coordinates: u east, v south, spanning the tile
in vec2 aTexCoords2;

// frameUbo + rendering flags
#include "./includes/frame.inc.glsl";
#include "./includes/elevation.inc.glsl";

// model matrix, aPosition -> camera-relative physical position
uniform mat4 uModel;

// geodetic height above the ellipsoid when true, physical Z when false
uniform bool uGeocentric;

out float vHeight;
out vec2 vTexCoords2;

void main() {

    // Camera-relative physical position. Vertical exaggeration is a
    // rendering transform and is deliberately not applied.
    vec4 worldPos = uModel * vec4(aPosition, 1.0);
    vec3 physicalPos = worldPos.xyz + uFrame.physicalEyePos.xyz;

    // Height is taken at the vertices and interpolated across the
    // triangle. Interpolating the position instead and taking the height
    // of that point measures the chord, which on a coarse mesh runs
    // kilometres below the surface its vertices sit on.
    vHeight = uGeocentric
        ? elevationGeodeticHeight(physicalPos, uFrame.bodyParams.x,
                                  uFrame.bodyParams.y)
        : physicalPos.z;

    vTexCoords2 = aTexCoords2;

    // Expand half a texel so the fill rule covers boundary fragments.
    gl_Position = vec4(
        (aTexCoords2 * 2.0 - 1.0)
            * ((elevationSampleSpan + 0.5) / 256.0),
        0.0, 1.0);
}
