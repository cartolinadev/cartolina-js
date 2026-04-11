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

// stack helper
#include "./includes/stack.inc.glsl";

// atm functions
#include "./includes/atmosphere.inc.glsl";

// other uniforms
uniform float uClip[4];
uniform vec3 uUpVector;

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

mat3 tangentialFrame2Wc(vec3 zenith, vec3 upVector) {

    vec3 b2 = normalize(zenith);
    vec3 b0 = normalize(cross(upVector, b2));
    vec3 b1 = cross(b2, b0);

    return mat3(b0, b1, b2);
}

// main

void main() {

    // render flags
    int renderFlags = frameRenderFlags();

    //renderFlags = FlagNone;
    //renderFlags = renderFlags
    //    & (FlagLighting | FlagNormalMaps | FlagAtmosphere | FlagShadows);

    bool useNormalMaps = (renderFlags & FlagNormalMaps) != 0; // needed for slope formula selection
    bool useLambertianShading = (renderFlags & FlagShadingLambertian) != 0;
    bool useSlopeShading = (renderFlags & FlagShadingSlope) != 0;

    // clip
    vec2 clipCoord = vTexCoords2;
    float clipMargin = uFrame.clipParams.x;

    float tmin = 0.5 - clipMargin; float tmax = 0.5 + clipMargin;

    if (clipCoord.y > 0.5) {

        if (clipCoord.x > 0.5){
            if (uClip[3] == 0.0 && !(clipCoord.x < tmax && uClip[2] != 0.0) && !(clipCoord.y < tmax && uClip[1] != 0.0)) discard;
        } else {
            if (uClip[2] == 0.0 && !(clipCoord.x > tmin && uClip[3] != 0.0) && !(clipCoord.y < tmax && uClip[0] != 0.0)) discard;
        }

    } else {

        if (clipCoord.x > 0.5) {
            if (uClip[1] == 0.0 && !(clipCoord.x < tmax && uClip[0] != 0.0) && !(clipCoord.y > tmin && uClip[3] != 0.0)) discard;
        } else {
            if (uClip[0] == 0.0 && !(clipCoord.x > tmin && uClip[1] != 0.0) && !(clipCoord.y > tmin && uClip[2] != 0.0)) discard;
        }
    }

    // light
    Light light = frameLight();
    Eye eye = frameEye();

    // initialize the two stacks
    Stack normal; initStack(normal);
    Stack color; initStack(color);

    int numLayers = layerCount();

    vec3 flatNormal = normalize(cross(dFdx(vFragPos), dFdy(vFragPos)));

    // pre-push flat normal as baseline so bump layers always have a normal to blend into,
    // even when FlagNormalMaps is off and the normal-map push layer is skipped
    push(normal, flatNormal);

    // decode and execute layers
    for (int i = 0; i < numLayers; i++ ) {

        Layer l = decodeLayer(i);

        // skip layer if its required render flags are not all set
        if (l.flagMask != 0 && (renderFlags & l.flagMask) != l.flagMask) continue;

        vec4 operand;

        // source: constant
        if (l.source == source_Constant) {

            operand = vec4(l.srcConstant, 1.0);
        }

        // source: texture
        if (l.source == source_Texture) {

            // obtain and transform uvs
            vec2 uv = vTexCoords2;

            if (l.srcTextureUVs == textureUVs_Internal)
                uv = vTexCoords;

            float xform[4] = l.srcTextureTransform;

            uv = vec2(
                xform[0] * uv.x + xform[2], xform[1] * uv.y + xform[3]);

            operand = vec4(0.0);

            // result
            if (l.srcTextureSampling == textureSampling_Raw)
                operand = sample2D(l.srcTextureIdx, uv);

            if (l.srcTextureSampling == textureSampling_Normal) {

                operand = vec4(sampleNormal(l.srcTextureIdx, uv), 1.0);
            }

            // mask
            if (l.srcTextureMaskIdx != -1)
                operand.w *= sample2D(l.srcTextureMaskIdx, uv).x;
        }

        // source: normal-flat
        if (l.source == source_NormalFlat) {

            operand = vec4(flatNormal, 1.0);
        }

        // source: shade
        if (l.source == source_Shade) {

            vec3 normal_;
            float slope = 0.0;

            normal_ = top(normal);

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

                normal_ = tangentialFrame2Wc(vEllipsoidZenith, uUpVector)
                    * normal_;
            }

            if (!useNormalMaps) {

                if (useSlopeShading)
                    slope = acos(clamp(dot(flatNormal,
                        normalize(vEllipsoidZenith)), -1.0, 1.0));
            }

            if (l.srcShadeType == shadeType_Diffuse) {

                float lambertianCoef = max(dot(-light.direction, normal_), 0.0);
                float slopeCoef = slope / SQR_HALF_PI;

                float aspectCoef = 0.5;

                vec3 znorm = normalize(vEllipsoidZenith);

                float an = dot(normal_, znorm);
                float bn = dot(-light.direction, znorm);
                float ab = dot(normal_, -light.direction);

                float norm_ap =  sqrt(1.0 - an * an);
                float norm_bp =  sqrt(1.0 - bn * bn);

                if (norm_ap > 1e-4 && norm_bp > 1e-4) 
                    aspectCoef = 0.5 * ((ab - an * bn) / (norm_ap * norm_bp) + 1.0);

                float diffuseCoef = 1.0;

                float lambertianWeight = light.shadingLambertianWeight;
                float slopeWeight = light.shadingSlopeWeight;

                // combined shading 
                if (useLambertianShading && useSlopeShading) 
                    diffuseCoef = 1.0 - pow(1.0 - lambertianCoef, lambertianWeight)
                        * pow(slopeCoef, slopeWeight);

                // pure lambertian
                if (useLambertianShading && !useSlopeShading) 
                    diffuseCoef = lambertianCoef;

                // pure slope
                if (!useLambertianShading && useSlopeShading) 
                    diffuseCoef = 1.0 - slopeCoef;

                //diffuseCoef = aspectCoef;

                operand = vec4(light.ambient +  diffuseCoef * light.diffuse, 1.0);

            }

            if (l.srcShadeType == shadeType_Specular) {

                // specular (blinn-phong)
                vec3 viewDir = vFragPos - eye.virtualPos;

                vec3 halfway = - normalize(
                    normalize(viewDir) + normalize(light.direction));

                operand = vec4(vec3(max(dot(normal_, halfway), 0.0)), 1.0);
            }

        }

        // source: pop
        if (l.source == source_Pop) {

            if (l.target == target_Color) operand = vec4(pop(color), 1.0);
            if (l.target == target_Normal) operand = vec4(pop(normal), 1.0);
        }

        // source: atmdensity
        if (l.source == source_AtmDensity) {

            if (l.target == target_Color)
                operand = vec4(vec3(vAtmDensity), 1.0);
        }

        // operation: common
        if (l.target == target_Color) {
            operand = vec4(mix(vec3(operand), vec3(1.0),
                l.targetColorWhitewash), operand.w);
        }

        // operation: push
        if (l.operation == operation_Push) {

            //operand = vec4(1,0,0,1);

            if (l.target == target_Color) push(color, operand.xyz);
            if (l.target == target_Normal) push(normal, operand.xyz);
        }

        // operation: blend
        if (l.operation == operation_Blend) {

            vec3 base, result;

            if (l.target == target_Color) base = top(color);
            if (l.target == target_Normal) base = top(normal);

            float alpha = l.opBlendAlpha * operand.w;

            switch(l.opBlendMode) {

                case blendMode_Overlay:
                    result = (1.0 - alpha) * base + alpha * operand.xyz;
                    break;

                case blendMode_Add:
                    result = base + alpha * operand.xyz;
                    //result = operand.xyz;
                    break;

                case blendMode_Multiply:
                    result = (1.0 - alpha * (1.0 - operand.xyz)) * base;
                    break;

                case blendMode_specularMultiply:
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
                    result = light.specular
                        * specularColor * pow(operand.x, 32.0);

                    break;

                default: result = base;
            }

            if (l.target == target_Color) swapTop(color, result);
            if (l.target == target_Normal) swapTop(normal, result);
        }

        // operation: atmcolor
        if (l.operation == operation_AtmColor) {

            if (l.target == target_Color)
                swapTop(color, atmColor(operand.x, vec4(top(color), 1.0)).xyz);
        }

        // operation: shadows
        if (l.operation == operation_Shadows) {

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

                ratio = pow(r, log(0.5)/ log(d));
            }

            if (l.target == target_Color) swapTop(color, top(color) * ratio);
        }


    } // end iterate layers

    // done
    fragColor = vec4(top(color), 1.0);
}
