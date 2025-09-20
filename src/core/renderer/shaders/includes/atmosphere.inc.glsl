
uniform sampler2D uTexAtmDensity; // change this to uFrame.samplers.x

layout(std140) uniform uboAtm
{
    highp mat4 uniAtmViewInv;
    highp vec4 uniAtmColorHorizon;
    highp vec4 uniAtmColorZenith;
    highp vec4 uniAtmSizes; // atmosphere thickness (divided by major axis), major / minor axes ratio, inverse major axis, atmoshpere offset from viewer (divided by major axis, normally 0)
    highp vec4 uniAtmCoefs; // horizontal exponent, colorGradientExponent, zw reserved
    highp vec4 uniAtmCameraPosition; // world position of camera (divided by major axis)
} uAtm;

float atmDecodeFloat(vec4 rgba)
{
    return dot(rgba, vec4(1.0, 1.0 / 256.0, 1.0 / (256.0*256.0), 0.0));
}

float atmSampleDensity(vec2 uv)
{
    // since some color channels of the density texture are not continuous
    //   it is important to first decode the float from rgba and only after
    //   that to filter the values
    ivec2 res = textureSize(uTexAtmDensity, 0);
    vec2 uvp = uv * vec2(res - 1);
    ivec2 iuv = ivec2(uvp); // upper-left texel fetch coordinates
    vec4 s;
    s.x = atmDecodeFloat(texelFetchOffset(uTexAtmDensity, iuv, 0, ivec2(0,0)));
    s.y = atmDecodeFloat(texelFetchOffset(uTexAtmDensity, iuv, 0, ivec2(1,0)));
    s.z = atmDecodeFloat(texelFetchOffset(uTexAtmDensity, iuv, 0, ivec2(0,1)));
    s.w = atmDecodeFloat(texelFetchOffset(uTexAtmDensity, iuv, 0, ivec2(1,1)));
    vec2 f = fract(uvp); // interpolation factors
    vec2 a = mix(s.xz, s.yw, f.x);
    return mix(a.x, a.y, f.y);
}

// fragDir is in model space
float atmDensityDir(vec3 fragDir, float fragDist)
{
    if (uAtm.uniAtmSizes[0] == 0.0) // no atmosphere
        return 0.0;

    // convert from ellipsoidal into spherical space
    vec3 camPos = uAtm.uniAtmCameraPosition.xyz;
    camPos.z *= uAtm.uniAtmSizes[1];
    vec3 camNormal = normalize(camPos);
    fragDir.z *= uAtm.uniAtmSizes[1];
    fragDir = normalize(fragDir);
    if (fragDist < 1000.0)
    {
        vec3 T = uAtm.uniAtmCameraPosition.xyz + fragDist * fragDir;
        T.z *= uAtm.uniAtmSizes[1];
        fragDist = length(T - camPos);
    }

    //float lb = 90000 * uAtm.uniAtmSizes[2];
    //float ub = 100000 * uAtm.uniAtmSizes[2];

    //return (fragDist - lb) / (ub  - lb);

    // ray parameters
    float ts[2];
    ts[1] = fragDist; // max ray length
    float l = length(camPos); // distance of camera center from world origin
    float x = dot(fragDir, camNormal) * -l; // distance from camera to a point called "x", which is on the ray and closest to world origin
    float y2 = l * l - x * x;
    float y = sqrt(y2); // distance of the ray from world origin

    float atmThickness = uAtm.uniAtmSizes[0]; // atmosphere height (excluding planet radius)
    float invAtmThickness = 1.0 / atmThickness;
    float atmRad = 1.0 + atmThickness; // atmosphere height including planet radius
    float atmRad2 = atmRad * atmRad;

    if (y > atmRad)
        return 0.0; // the ray does not cross the atmosphere

    float t1e = x - sqrt(1.0 - y2 + 1e-7); // t1 at ellipse

    // fill holes in terrain if the ray passes through the planet
    if (y < 0.998 && x >= 0.0 && ts[1] > 1000.0)
        ts[1] = t1e;

    // approximate the planet by the ellipsoid if the mesh is too rough
    if (y <= 1.0)
        ts[1] = mix(ts[1], t1e, clamp(l * 10.0 - 14.0, 0.0, 1.0));

    //float lb = 90000 * uAtm.uniAtmSizes[2];
    //float ub = 100000 * uAtm.uniAtmSizes[2];

    //return (ts[1] - lb) / (ub  - lb);


    // to improve accuracy, swap direction of the ray to point out of the terrain
    bool swapDirection = ts[1] < 1000.0 && x >= 0.0;

    // distance of atmosphere boundary from "x"
    float a = sqrt(atmRad2 - y2);

    // clamp t0 and t1 to atmosphere boundaries
    // ts is line segment that encloses the unobstructed portion of the ray and is inside atmosphere
    // ts[0] = max(0.0, x - a);
    ts[0] = max(uAtm.uniAtmSizes[3], x - a);
    ts[1] = min(ts[1], x + a);

    //float lb = 90000 * uAtm.uniAtmSizes[2];
    //float ub = 100000 * uAtm.uniAtmSizes[2];

    //return (ts[1] - lb) / (ub  - lb);


    // sample the density texture
    float ds[2];
    for (int i = 0; i < 2; i++)
    {
        float t = x - ts[i];
        float r = sqrt(t * t + y2);
        vec2 uv = vec2(
            0.5 - 0.5 * t / r,
            0.5 + 0.5 * (r - 1.0) * invAtmThickness);

        if (swapDirection)
            uv.x = 1.0 - uv.x;
        ds[i] = atmSampleDensity(uv);
    }

    // final optical transmittance
    float density = ds[0] - ds[1];
    if (swapDirection)
        density *= -1.0;
    float transmittance = exp(-uAtm.uniAtmCoefs[0] * density);
    return 1.0 - transmittance;
}

// fragVect is view-space fragment position
float atmDensity(vec3 fragVect)
{
    // convert fragVect to world-space and divide by major radius
    fragVect = (uAtm.uniAtmViewInv * vec4(fragVect, 1.0)).xyz;
    fragVect = fragVect * uAtm.uniAtmSizes[2];
    vec3 f = fragVect - uAtm.uniAtmCameraPosition.xyz;

    //float lb = 90000 * uAtm.uniAtmSizes[2];
    //float ub = 100000 * uAtm.uniAtmSizes[2];

    //return (length(f) - lb) / (ub  - lb);

    return atmDensityDir(f, length(f));
}

vec4 atmColor(float density, vec4 color)
{
    density = clamp(density, 0.0, 1.0);
    vec3 a = mix(uAtm.uniAtmColorHorizon.rgb, uAtm.uniAtmColorZenith.rgb, pow(1.0 - density, uAtm.uniAtmCoefs[1]));
    return vec4(mix(color.rgb, a, density), color.a);
}

#define VTS_ATM_PER_VERTEX 1
