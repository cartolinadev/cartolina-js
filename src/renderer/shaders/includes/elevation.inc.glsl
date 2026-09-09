#ifndef ELEVATION_INC_GLSL
#define ELEVATION_INC_GLSL

/*
 * Shared encoding and geometry for the elevation store.
 *
 * A stored sample is the height quantized linearly over the reference
 * frame's declared height range into an R16UI texel: 0 at the range
 * minimum, 65534 at its maximum. 65535 stands for no coverage, so
 * validity is part of the value and the store needs no separate mask.
 */

const uint elevationInvalid = 0xFFFFu;
const float elevationLevels = 65534.0;

/*
 * Samples have 255 intervals between the two tile edges. Rasterization
 * expands the geometry by half a texel to cover boundary fragments; the
 * fragment shader evaluates those fragments back on this exact grid.
 */
const float elevationSampleSpan = 255.0;

uint elevationEncode(float height, vec2 range) {

    return uint(round(
        (height - range.x) / (range.y - range.x) * elevationLevels));
}

float elevationDecode(uint sample_, vec2 range) {

    return range.x
        + float(sample_) / elevationLevels * (range.y - range.x);
}

bool elevationValid(uint sample_) {

    return sample_ != elevationInvalid;
}

/*
 * A decoded value written to the lookup result: the IEEE 754 bit pattern
 * of a float32, as four bytes of an RGBA8UI texel in little-endian order.
 * The CPU reads it back with DataView.getFloat32(..., true).
 */
uvec4 elevationPackResult(float value) {

    uint bits = floatBitsToUint(value);

    return uvec4(
         bits         & 0xFFu,
        (bits >>  8u) & 0xFFu,
        (bits >> 16u) & 0xFFu,
         bits >> 24u);
}


/*
 * Geodetic height of an absolute Cartesian position, by Bowring's formula.
 * `a` is the semi-major axis and `majorToMinor` the major-to-minor ratio,
 * both taken from the frame uniform's bodyParams.
 *
 * The two auxiliary angles are carried as normalized sine and cosine
 * pairs. GLSL ES guarantees `sin` and `cos` only to an absolute error of
 * about 1e-4, which a body radius scales into hundreds of metres; a
 * normalized pair keeps the full relative precision of its inputs.
 */
float elevationGeodeticHeight(vec3 ecef, float a, float majorToMinor) {

    float b = a / majorToMinor;

    float p = length(ecef.xy);

    // on the polar axis the parametric latitude degenerates, but the
    // height is simply the distance past the semi-minor axis
    if (p < 1.0) return abs(ecef.z) - b;

    float a2 = a * a;
    float b2 = b * b;

    // first and second eccentricity squared
    float e2 = (a2 - b2) / a2;
    float ep2 = (a2 - b2) / b2;

    // Bowring's auxiliary (parametric) latitude
    vec2 theta = normalize(vec2(p * b, ecef.z * a));

    float cos3 = theta.x * theta.x * theta.x;
    float sin3 = theta.y * theta.y * theta.y;

    // the geodetic latitude it corrects to
    vec2 lat = normalize(vec2(p - e2 * a * cos3,
                              ecef.z + ep2 * b * sin3));

    // height above the ellipsoid along the geodetic normal; the first
    // two terms give the prime-vertical radius plus the height, and the
    // third takes the radius back out
    return p * lat.x + ecef.z * lat.y
        - a * sqrt(1.0 - e2 * lat.y * lat.y);
}

#endif
