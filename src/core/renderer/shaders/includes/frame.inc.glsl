
#ifndef FRAME_INC_GLSL
#define FRAME_INC_GLSL

#include "./render-flags.inc.glsl";

// the per frame configuration

layout(std140) uniform uboFrame {

    // view and projection matrices
    highp mat4 view;
    highp mat4 projection;

    // celestial body params
    highp vec4 bodyParams; // majorAxis, majorAxis / minorAxis, zw reserved

    // vertical exaggeration parameters 1
    highp vec4 vaParams1; // h1, f1, h2, f2
    highp vec4 vaParams2; // h2 - h1, f2 - f1, 1.0 / (h2 - h1), w reserved

    // renderingFlags
    highp ivec4 renderFlags; // x: low byte, y: high byte, zw reserved

    // cameraPos, center of view
    highp vec4 physicalEyePos; // xyz- physicalEyePos, w: eyeToCenter

    // illumination
    highp vec4 lightDirection; // z reserved
    mediump vec4 lightAmbient; // z reserved
    mediump vec4 lightDiffuse;  // z reserved
    mediump vec4 lightSpecular; // z reserved
    mediump vec4 shadingParams; // x: lambertian weight, y: slope weight, z: aspect weight, w reserved

    // virtual eye (for shadows and specular reflections)
    highp vec4 virtualEye; // xyz: virtualEyePos, w: virtualEyeToCenter

    // clip margin
    highp vec4 clipParams; // x = clipMargin, y = maskThreshold, zw reserved
} uFrame;


// decode eye (camera) confiugration from the frame ubo

struct Eye {

    vec3 physicalPos;
    float eyeToCenter;

    vec3 virtualPos;
    float virtualEyeToCenter;
};

Eye frameEye() {

    Eye eye;
    eye.physicalPos = uFrame.physicalEyePos.xyz;
    eye.eyeToCenter = uFrame.physicalEyePos.w;

    eye.virtualPos = uFrame.virtualEye.xyz;
    eye.virtualEyeToCenter = uFrame.virtualEye.w;

    return eye;
}


// decode light from frame ubo

struct Light {

    vec3 direction;
    vec3 ambient;
    vec3 diffuse;
    vec3 specular;
    float shadingLambertianWeight;
    float shadingSlopeWeight;
    float shadingAspectWeight;
};


Light frameLight() {

    Light light;

    light.direction = uFrame.lightDirection.rgb;
    light.ambient = uFrame.lightAmbient.rgb;
    light.diffuse = uFrame.lightDiffuse.rgb;
    light.specular = uFrame.lightSpecular.rgb;
    light.shadingLambertianWeight = uFrame.shadingParams.x;
    light.shadingSlopeWeight = uFrame.shadingParams.y;
    light.shadingAspectWeight = uFrame.shadingParams.z;

    return light;

}

// decode render flags from the frame ubo

int frameRenderFlags() {
    return decodeRenderFlags(uFrame.renderFlags);
}


// coverage value above which a fallback fragment is discarded because a
// finer surface already covers it; read from the frame ubo

float frameMaskThreshold() {
    return uFrame.clipParams.y;
}



/* apply vertical exaggeration on a world position, based on the frame 
 * configuration */

vec4 applyVerticalExaggeration(vec4 worldPos, out float verticalExaggeration) {

    // this is in an approximation, but sufficient for the purpose
    // we use an estimate of ellipsoidal height to apply exaggeration

    // extract parameters from frame metadata
    float majorAxis = uFrame.bodyParams.x;
    float majorToMinor = uFrame.bodyParams.y;

    float h1 = uFrame.vaParams1.x, f1 = uFrame.vaParams1.y,
         h2 = uFrame.vaParams1.z, f2 = uFrame.vaParams1.w;
    //float hdiff = uFrame.vaParams2.x, fdiff = uFrame.vaParams2.y,
    //      invhdiff = uFrame.vaParams2.z;

    // approximate ellipsoid by a sphere
    vec3 geoPos = worldPos.xyz + uFrame.physicalEyePos.xyz;
    geoPos.z *= majorToMinor;

    // distance from center
    float ll = length(geoPos.xyz);

    // ellipsoidal height approximation
    float h = ll - majorAxis;

    // h_ = clamp(h, h1, h2)
    float h_ = clamp(h, h1, h2);

    // exaggeration factor at h
    verticalExaggeration = f1 + (h_ - h1) / (h2 - h1) * (f2 - f1);

    // obtain exaggerated height
    float hNew = h * verticalExaggeration;

    // local normal (on sphere)
    vec3 v = geoPos.xyz;

    // back to ellipsoid coordinates (transpose of inverse, hence multiply)
    v = normalize(vec3(v.xy, v.z * majorToMinor));

    // move worldPos along the normal by the height difference
    worldPos.xyz += v * (hNew - h);

    // done
    return worldPos;
}

/* compute the zenith direction at a given world position, as defined by the 
 * ellipsoid in the frame. */

vec3 computeEllipsoidZenith(vec4 worldPos) {

    // obtain the true world position (which, confusingly, is not the worldPos)
    vec3 geoPos = worldPos.xyz + uFrame.physicalEyePos.xyz;

    // extract axis ratio from frame metadata
    float majorToMinorSquared = uFrame.bodyParams.y * uFrame.bodyParams.y;

    // back to ellipsoid coordinates (the formula follows from the ellipsoid
    // to auxiliary squere transformation - the z coordinate is scaled by 
    // majorToMinor and the normal is scaled by the same factor in transformation
    // back to ellipsoid coordinates, hence the square 
    return normalize(vec3(geoPos.xy, geoPos.z * majorToMinorSquared));
}


#endif
