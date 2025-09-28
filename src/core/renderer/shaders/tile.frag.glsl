#version 300 es
precision mediump float;

// structures

struct Material {

    sampler2D diffuseMap;
    sampler2D specularMap;
    sampler2D normalMap;
    sampler2D bumpMap;
    float shininess;
    float bumpWeight;
};


// varyings
in vec3 vFragPos;
in vec3 vFragPosVC;
in vec2 vTexCoords;
in vec2 vTexCoords2;
in float vAtmDensity;


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

//uniform vec3 virtualEyePos;
//uniform float eyeToCenter, virtualEyeToCenter;
uniform Material material;

// render target
out vec4 fragColor;

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

vec3 sampleOctBilinear(sampler2D tex, vec2 uv, vec2 texel) {

  vec2 pos = uv / texel - 0.5;
  vec2 f = fract(pos);
  vec2 base = (floor(pos) + 0.5) * texel;

  vec2 uv00 = base;
  vec2 uv10 = base + vec2(texel.x,0.0);
  vec2 uv01 = base + vec2(0.0,texel.y);
  vec2 uv11 = base + texel;

  vec3 n00 = decodeOct(texture(tex, uv00).rg, false);
  vec3 n10 = decodeOct(texture(tex, uv10).rg, false);
  vec3 n01 = decodeOct(texture(tex, uv01).rg, false);
  vec3 n11 = decodeOct(texture(tex, uv11).rg, false);

  vec3 n0 = mix(n00, n10, f.x), n1 = mix(n01, n11, f.x);
  return normalize(mix(n0, n1, f.y));
}



vec3 sampleNormal(sampler2D tex, vec2 uv) {
    //vec2 rg = texture(tex, uv).rg;

    // optionally add; manual bilinear fiterling + jitter
    //return decodeOct(rg);

    // TODO: use textureSize instead of fixed size
    return sampleOctBilinear(tex, uv, vec2(1./256., 1./256.));
}




// main

void main() {

    // render flags
    int renderFlags = uFrame.renderFlags.x;
    //renderFlags = FlagNone;
    renderFlags = renderFlags
        & (FlagLighting | FlagNormalMap | FlagAtmosphere | FlagShadows);
    //renderFlags = FlagLighting | FlagNormalMap ;

    bool useLighting = (renderFlags & FlagLighting) != 0; // bit 0
    bool useNormalMap = (renderFlags & FlagNormalMap) != 0; // bit 1
    bool useDiffuseMap = (renderFlags & FlagDiffuseMaps) != 0; // bit 2
    bool useSpecularMap = (renderFlags & FlagSpecularMaps) != 0; // bit 3
    bool useBumpMap = (renderFlags & FlagBumpMaps) != 0; // bit 4
    bool useAtmosphere = (renderFlags & FlagAtmosphere) != 0; // bit 5
    bool useShadows = (renderFlags & FlagShadows) != 0; // bit 6

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

    // normal
    vec3 normal_;

    if (useNormalMap) {

        normal_ = sampleNormal(material.normalMap, vTexCoords2);

    } else {

        normal_ = normalize(cross(dFdx(vFragPos), dFdy(vFragPos)));
    }

    push(normal, normal_);

    // decode and execute layers
    for (int i = 0; i < layerCount(); i++ ) {

        Layer l = decodeLayer(i);

        // TODO: execute
        vec4 operand;

        if (l.source == source_Constant) {

            operand = vec4(l.srcConstant, 1.0);
        }

        if (l.source == source_Shade) {

            if (l.srcShadeType == shadeType_Diffuse)
                operand = vec4(light.ambient + light.diffuse
                    * max(dot(-light.direction, top(normal)), 0.0), 1.0);
        }

        if (l.operation == operation_Push) {

            if (l.target == target_Color) push(color, operand.xyz);
            if (l.target == target_Normal) push(normal, operand.xyz);
        }

        if (l.operation == operation_Blend) {

            vec3 base, result;

            if (l.target == target_Color) base = top(color);
            if (l.target == target_Normal) base = top(normal);

            float alpha = l.opBlendAlpha * operand.w;

            switch(l.opBlendMode) {

                //case blendMode_Overlay: break;
                //case blendMode_Add: break;

                case blendMode_Multiply:
                    result = (1.0 - alpha * (1.0 - operand.xyz)) * base;
                    break;

                //case blendMode_specularMultiply: break;
                default: result = base;
            }

            if (l.target == target_Color) swapTop(color, result);
            if (l.target == target_Normal) swapTop(normal, result);
        }
    }


    // done
    //fragColor = color_;
    fragColor = vec4(top(color), 1.0);

/*
    // TODO: tangent, bitangent
    if (useBumpMap) {
        vec3 bump = normalize(
            texture(material.bumpMap, vTexCoords).rgb * 2.0  - 1.0);

        normal = (1.0 - material.bumpWeight) * normal
            + material.bumpWeight * bump;
        //normal = normalize(normal + material.bumpWeight * bump);
    }

    // diffuse and ambient color
    vec3 diffuseColor;

    if (useDiffuseMap) {
        diffuseColor = vec3(texture(material.diffuseMap, vTexCoords2));
    } else {
        diffuseColor = vec3(0.9, 0.9, 0.8);
        //diffuseColor = vec3(0.3, 0.6, 0.4);
        //diffuseColor = vec3(0.85, 0.85, 0.85);
    }

    // specular color
    vec3 specularColor;

    if (useSpecularMap) {
        specularColor = vec3(texture(material.specularMap, vTexCoords));
    } else {
        specularColor = vec3(0.0);
    }

    vec4 color;

    // base color
    if (useLighting) {

        // ambient
        vec3 ambient = light.ambient * diffuseColor;

        // diffuse
        vec3 diffuse = light.diffuse * diffuseColor
            * max(dot(normalize(-light.direction), normal), 0.0);


        vec3 specular = vec3(0.0);
*/
        /*
        // specular (blinn-phong)
        vec3 viewDir = vFragPos - virtualEyePos;

        vec3 halfway = - normalize(
            normalize(viewDir) + normalize(light.direction));
        vec3 specular = light.specular * specularColor
            * pow(max(dot(normal, halfway), 0.0), material.shininess);*/
/*
        // output
        color = vec4(ambient + diffuse + specular, 1.0);


    } else {

         color = vec4(diffuseColor, 1.0);
    }

    // atmosphere
    if (useAtmosphere)
        //color = vec4(vec3(vAtmDensity), 1.0);
        color = atmColor(vAtmDensity, color);

    // shadows
    if (useShadows) {

        float r = min(-vFragPosVC.z / eye.eyeToCenter, 1.0);
        float ratio;

        // the below dichotomy is a little ugly but it yields decent empirical results
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

        //color = vec4(vec3(min(ratio, 1.0)), 1.0);

        color = vec4(vec3(color) * ratio, 1.0);
    }

    // result
    fragColor = color;  */
}
