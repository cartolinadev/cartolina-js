/*
 * tile.frag.template.glsl — the tile fragment shader, assembled
 * per layer-stack shape
 *
 * This file is never compiled as-is. The specializer
 * (tile-shader-specializer.ts) parses the named snippets below and
 * concatenates them into a complete fragment shader: the prologue
 * (varyings, uniforms, the shared opcode helper functions, and the
 * opening of main) followed by straight-line register and layer
 * code generated for one layer stack, then the epilogue.
 *
 * Each snippet runs from a //%snippet <name> line to a matching
 * //%end <name> line; the lines between are kept verbatim. ${name}
 * holes are filled by the specializer with generated register
 * names, indentation, and per-layer indices. A physical line ending
 * in a backslash continues onto the next, dropping the newline and
 * the continuation line's leading whitespace, so one output
 * statement can be wrapped here to stay within the line limit.
 */


//%snippet prologue
#version 300 es
precision mediump float;

// varyings
in vec3 vFragPos;
in vec3 vFragPosVC;
in vec3 vEllipsoidZenith;
in vec2 vTexCoords;
in vec2 vTexCoords2;
in float vAtmDensity;
in float vVerticalExaggeration;

// frame ubo
#include "./includes/frame.inc.glsl";

// layer stack ubo
#include "./includes/layers.inc.glsl";

// atm functions
#include "./includes/atmosphere.inc.glsl";

// other uniforms
uniform vec3 uUpVector;
#ifdef TILE_DISCARD
uniform sampler2D uMask;
uniform bool uMaskEnabled;
#endif

// render target
out vec4 fragColor;

// consts
const float HALF_PI = 1.5707963267948966;
const float SQR_HALF_PI = HALF_PI * HALF_PI;


// octahedron rg decoding of normals

vec3 decodeOct(vec2 rg, bool normalize_) {
    vec2 p = rg * 2.0 - 1.0;                          // [-1,1]^2
    vec3 n = vec3(p, 1.0 - abs(p.x) - abs(p.y));      // L1 “unproject”
    // branchless fold fixup (t = amount to slide back to the upper sheet)
    float t = clamp(-n.z, 0.0, 1.0);                  // >0 only when z<0
    n.xy += vec2(p.x >= 0.0 ? -t : t,
                 p.y >= 0.0 ? -t : t);

    if (! normalize_) return n;
    return normalize(n);
}


// manual biliniear filtering of decoded values
// (we cannot rely on gl interpolation, octahedron encoding is not continuous)

vec3 sampleOctBilinear(int tex, vec2 uv, vec2 texel) {

  vec2 pos = uv / texel - 0.5;
  vec2 f = fract(pos);
  vec2 base = (floor(pos) + 0.5) * texel;

  vec2 uv00 = base;
  vec2 uv10 = base + vec2(texel.x,0.0);
  vec2 uv01 = base + vec2(0.0,texel.y);
  vec2 uv11 = base + texel;

  vec3 n00 = decodeOct(sample2D(tex, uv00).rg, false);
  vec3 n10 = decodeOct(sample2D(tex, uv10).rg, false);
  vec3 n01 = decodeOct(sample2D(tex, uv01).rg, false);
  vec3 n11 = decodeOct(sample2D(tex, uv11).rg, false);

  vec3 n0 = mix(n00, n10, f.x), n1 = mix(n01, n11, f.x);
  return normalize(mix(n0, n1, f.y));
}

vec3 sampleNormal(int tex, vec2 uv) {
    //vec2 rg = texture(tex, uv).rg;

    // optionally add; manual bilinear fiterling + jitter
    //return decodeOct(rg);

    // TODO: use textureSize instead of fixed size
    return sampleOctBilinear(tex, uv, vec2(1./256., 1./256.));
}

// obtain a transformation matrix for transformation of tangential space 
// normals to world coordinates. See tileserver code for details on the 
// construction of the tangential frame and the choice of upVector.
// *note that zenith is expected to be normalized*

mat3 tangentialFrame2Wc(vec3 zenith, vec3 upVector) {

    vec3 b2 = normalize(zenith);
    vec3 b0 = normalize(cross(upVector, b2));
    vec3 b1 = cross(b2, b0);

    return mat3(b0, b1, b2);
}

// obtain the diffuse coefficient for the given normal (passed explicitely)
// and the light params and rendering flags from the frame ubo. This is used 
// for source_Shade layers with diffuse shading type.

float diffuseCoef(vec3 normal, Light light, vec3 zenithNorm, float slope,
        int renderFlags) {

    float lambertianWeight = light.shadingLambertianWeight;
    float slopeWeight = light.shadingSlopeWeight;
    float aspectWeight = light.shadingAspectWeight;

    bool useLambertianShading = (renderFlags & FlagShadingLambertian) != 0 
        && (light.shadingLambertianWeight > 1e-3);
    bool useSlopeShading = (renderFlags & FlagShadingSlope) != 0 
        && (light.shadingSlopeWeight > 1e-3);
    bool useAspectShading = (renderFlags & FlagShadingAspect) != 0 
        && (light.shadingAspectWeight > 1e-3);

    // lambertian coef
    float lambertianCoef = 0.0;

    if (useLambertianShading)
        lambertianCoef = max(dot(-light.direction, normal), 0.0);
        
    // slope coef
    float slopeCoef = 0.0;
    
    if (useSlopeShading)
        slopeCoef = slope / SQR_HALF_PI;

    // aspect coef
    float aspectCoef = 0.0;

    if (useAspectShading) {

        // we compute the aspect coefficient in a compact form 
        // this is a cosine of normalized projections of normal and light 
        // direction onto the plane perpendicular to zenith, remapped from 
        // [-1,1] to [0,1]
        float an = dot(normal, zenithNorm);
        float bn = dot(-light.direction, zenithNorm);
        float ab = dot(normal, -light.direction);

        float norm_ap =  sqrt(max(1.0 - an * an, 0.0));
        float norm_bp =  sqrt(max(1.0 - bn * bn, 0.0));

        aspectCoef = 0.5;

        if (norm_ap > 1e-2 && norm_bp > 1e-2) {

            float aspectCos = (ab - an * bn) / (norm_ap * norm_bp);
            aspectCoef = 0.5 * (clamp(aspectCos, -1.0, 1.0) + 1.0);
        }
    }

    // no shading
    if (!useLambertianShading && !useSlopeShading && !useAspectShading) 
        return 1.0;

    // optimization path (pure Lambertian)
    if (useLambertianShading && !useSlopeShading && !useAspectShading) 
        return lambertianCoef;

    // optimization path (pure slope)
    if (!useLambertianShading && useSlopeShading && !useAspectShading) 
        return 1.0 - slopeCoef;

    // combined shading 
    float diffuseComplement = 1.0;
    float weightSum = 0.0;

    if (useLambertianShading) {
        diffuseComplement *= pow(1.0 - lambertianCoef,
            lambertianWeight);
        weightSum += lambertianWeight;
    }

    if (useSlopeShading) {
        diffuseComplement *= pow(slopeCoef, slopeWeight);
        weightSum += slopeWeight;
    }
    
    if (useAspectShading) {
        diffuseComplement *= pow(1.0 - aspectCoef, aspectWeight);
        weightSum += aspectWeight;
    }

    return 1.0 - pow(diffuseComplement, 1.0 / weightSum);
}

vec4 srcTexture(int texIdx, int maskIdx, vec2 baseUv, vec4 xform,
        bool normalSampling) {

    // obtain and transform uvs
    vec2 uv = vec2(xform.x * baseUv.x + xform.z,
        xform.y * baseUv.y + xform.w);

    vec4 operand = vec4(0.0);

    // result
    if (normalSampling) operand = vec4(sampleNormal(texIdx, uv), 1.0);
    else operand = sample2D(texIdx, uv);

    // mask
    if (maskIdx != -1) operand.w *= sample2D(maskIdx, uv).x;

    return operand;
}

vec4 srcShade(vec3 nTop, vec3 flatNormal, bool specular, Light light,
        Eye eye, int renderFlags) {

    vec3 normal_ = nTop;
    float slope = 0.0;

    vec3 zenithNorm = normalize(vEllipsoidZenith);

    bool useNormalMaps = (renderFlags & FlagNormalMaps) != 0; // needed for slope formula selection
    bool useSlopeShading = (renderFlags & FlagShadingSlope) != 0;

    if (useNormalMaps) {

        // skip this for no exaggeration (optimization)
        if (vVerticalExaggeration - 1.0 > 1e-3) {

            float va = vVerticalExaggeration;

            // numerical stability for near-flat areas
            if (abs(1.0 - normal_.z) < 5e-4)
                va = 1.0 + abs(1.0 - normal_.z) / 5e-4 * (va - 1.0);

            normal_.z *= 1.0 / va;
            normal_ = normalize(normal_);
        }

        if (useSlopeShading)
            slope = acos(clamp(normal_.z, -1.0, 1.0));

        normal_ = tangentialFrame2Wc(zenithNorm, uUpVector) * normal_;
    }

    if (!useNormalMaps) {

        if (useSlopeShading)
            slope = acos(clamp(dot(flatNormal, zenithNorm), -1.0, 1.0));
    }

    if (!specular) {

        float diffuse_ = diffuseCoef(normal_, light, zenithNorm, slope,
            renderFlags);
        return vec4(light.ambient + diffuse_ * light.diffuse, 1.0);
    }

    // specular (blinn-phong)
    vec3 viewDir = vFragPos - eye.virtualPos;
    vec3 halfway = -normalize(normalize(viewDir) + normalize(light.direction));

    return vec4(vec3(max(dot(normal_, halfway), 0.0)), 1.0);
}

vec3 blendSpecularMultiply(vec3 base, vec4 operand, Light light) {

    // specular reflectivity
    int shininessBits = 4;
    int shmask = (1 << shininessBits) - 1;
    int cmask = 0xff & ~shmask;
    float cdivisor = float((1 << (8 - shininessBits)) - 1);

    int value = int(base.x * 255.0);

    float specularColor = float((value & cmask) >> shininessBits);
    specularColor /= cdivisor;

    float shininess = float(value & shmask);

    //result = light.specular
    //    * specularColor * pow(operand.x, shininess);
    return light.specular
        * specularColor * pow(operand.x, 32.0);
}

vec3 applyShadows(vec3 color, Eye eye) {

    float r = min(-vFragPosVC.z / eye.eyeToCenter, 1.0);
    float ratio;

    // the below dichotomy is not pretty but it yields decent empirical results
    if (eye.virtualEyeToCenter / eye.eyeToCenter > 0.9) {

        // scenario 1: linear ramp
        ratio = r;

    } else {

        // scenario 2: generic power function
        // we want the ratio to be equal to 0.5 at virtualEyeCenter
        // and to 0 at eyeCenter

        // relative eycenter distance
        float d = (eye.eyeToCenter - eye.virtualEyeToCenter) / eye.eyeToCenter;

        ratio = pow(r, log(0.5) / log(d));
    }

    return color * ratio;
}

void main() {

    int renderFlags = frameRenderFlags();

#ifdef TILE_DISCARD
    if (uMaskEnabled) {
        float covered = texture(uMask, vTexCoords2).r;
        if (covered > frameMaskThreshold()) discard;
    }
#endif

    Light light = frameLight();
    Eye eye = frameEye();

    vec3 flatNormal = normalize(cross(dFdx(vFragPos), dFdy(vFragPos)));
//%end prologue


//%snippet normalReg
    vec3 n${depth} = flatNormal;
//%end normalReg


//%snippet colorReg
    vec3 c${depth};
//%end colorReg


//%snippet guardOpen
    if ((renderFlags & ${flagMask}) == ${flagMask}) {
//%end guardOpen


//%snippet guardClose
    }
//%end guardClose


//%snippet whitewash
${ind}${op} = vec4(mix(vec3(${op}), vec3(1.0), ${ubo}.p2.y), ${op}.w);
//%end whitewash


//%snippet src.constant
${ind}vec4 ${op} = vec4(${ubo}.p1.xyz, 1.0);
//%end src.constant


//%snippet src.texture
${ind}vec4 ${op} = srcTexture(${texIdx}, ${maskIdx}, \
    ${baseUv}, ${ubo}.p1, ${normalSampling});
//%end src.texture


//%snippet src.shade
${ind}vec4 ${op} = srcShade(${nTop}, flatNormal, ${specular}, \
    light, eye, renderFlags);
//%end src.shade


//%snippet src.pop
${ind}vec4 ${op} = vec4(1.0);
//%end src.pop


//%snippet src.atmDensity
${ind}vec4 ${op} = vec4(vec3(vAtmDensity), 1.0);
//%end src.atmDensity


//%snippet src.none
${ind}vec4 ${op} = vec4(0.0);
//%end src.none


//%snippet src.normalFlat
${ind}vec4 ${op} = vec4(flatNormal, 1.0);
//%end src.normalFlat


//%snippet op.push
${ind}${reg} = ${op}.xyz;
//%end op.push


//%snippet op.atmColor
${ind}${reg} = atmColor(${op}.x, vec4(${reg}, 1.0)).xyz;
//%end op.atmColor


//%snippet op.shadows
${ind}${reg} = applyShadows(${reg}, eye);
//%end op.shadows


//%snippet blend.alpha
${ind}float ${alphaVar} = ${alphaExpr};
//%end blend.alpha


//%snippet blend.overlay
${ind}${base} = (1.0 - ${alpha}) * ${base} + ${alpha} * ${operand}.xyz;
//%end blend.overlay


//%snippet blend.add
${ind}${base} = ${base} + ${alpha} * ${operand}.xyz;
//%end blend.add


//%snippet blend.multiply
${ind}${base} = (1.0 - ${alpha} * (1.0 - ${operand}.xyz)) * ${base};
//%end blend.multiply


//%snippet blend.specularMultiply
${ind}${base} = blendSpecularMultiply(${base}, ${operand}, light);
//%end blend.specularMultiply


//%snippet expr.blendAlpha
${ubo}.p2.x * ${op}.w
//%end expr.blendAlpha


//%snippet expr.popOperand
vec4(${popReg}, 1.0)
//%end expr.popOperand


//%snippet expr.uboRef
uLayers.layers[${idx}]
//%end expr.uboRef


//%snippet uv.internal
vTexCoords
//%end uv.internal


//%snippet uv.external
vTexCoords2
//%end uv.external


//%snippet epilogue
    fragColor = vec4(${top}, 1.0);
}
//%end epilogue
