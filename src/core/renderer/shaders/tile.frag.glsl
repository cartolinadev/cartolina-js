#version 300 es
precision mediump float;

//#include "./includes/atmosphere.inc.glsl";

// structures

struct Material {

    sampler2D diffuseMap;
    sampler2D specularMap;
    sampler2D normalMap;
    sampler2D bumpMap;
    float shininess;
    float bumpWeight;
};

struct Light {

    vec3 direction;
    vec3 ambient;
    vec3 diffuse;
    vec3 specular;
};

// attributes, uniforms

in vec3 vFragPos;
in vec3 vFragPosVC;
in vec2 vTexCoords;
in float vAtmDensity;

uniform vec3 virtualEyePos;
uniform float eyeToCenter, virtualEyeToCenter;
uniform Material material;
uniform Light light;

uniform int renderFlags;

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



vec3 sampleNormal(sampler2D tex, vec2 uv, vec3 worldPos) {
    //vec2 rg = texture(tex, uv).rg;

    // optionally add; manual bilinear fiterling + jitter
    //return decodeOct(rg);

    // TODO: pass texture size via unifom or textureSize once on GLSL ES 3.0
    return sampleOctBilinear(tex, uv, vec2(1./256., 1./256.));
}


// main

void main() {

    // render flags
    bool useLighting = (renderFlags & (1 << 0)) != 0; // bit 0
    bool useNormalMap = (renderFlags & (1 << 1)) != 0; // bit 1
    bool useDiffuseMap = (renderFlags & (1 << 2)) != 0; // bit 2
    bool useSpecularMap = (renderFlags & (1 << 3)) != 0; // bit 3
    bool useBumpMap = (renderFlags & (1 << 4)) != 0; // bit 4
    bool useAtmosphere = (renderFlags & (1 << 5)) != 0; // bit 5
    bool useShadows = (renderFlags & (1 << 6)) != 0; // bit 6

    // normal
    vec3 normal;

    if (useNormalMap) {

        vec3 normal_ = sampleNormal(material.normalMap, vTexCoords, vFragPos);
        //normal = normalize(texture(material.normalMap,
        //    vTexCoords).rgb * 2.0 - 1.0);
    }

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
        diffuseColor = vec3(texture(material.diffuseMap, vTexCoords));
    } else {
        diffuseColor = vec3(0.9, 0.9, 0.8);
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
        vec3 ambient = light.ambient * 0.3 * diffuseColor;

        // diffuse
        vec3 diffuse = light.diffuse * diffuseColor
            * max(dot(normalize(-light.direction), normal), 0.0);

        // specular (blinn-phong)
        vec3 viewDir = vFragPos - virtualEyePos;

        vec3 halfway = - normalize(
            normalize(viewDir) + normalize(light.direction));
        vec3 specular = light.specular * specularColor
            * pow(max(dot(normal, halfway), 0.0), material.shininess);

        // output
        color = vec4(ambient + diffuse + specular, 1.0);


    } else {

         color = vec4(diffuseColor, 1.0);
    }

    // atmosphere
    if (useAtmosphere)
        color = atmColor(vAtmDensity, color);

    // shadows
    if (useShadows) {

        float r = min(-vFragPosVC.z / eyeToCenter, 1.0);
        float ratio;

        if (virtualEyeToCenter / eyeToCenter > 0.9) {

            ratio = r;

        } else {
            float d = (eyeToCenter - virtualEyeToCenter) / eyeToCenter;
            //ratio = pow(r, log(0.5)/ log(d));
            ratio = pow(r, log(0.5)/ log(d));
        }

        color = color * ratio;
    }

    // result
    fragColor = color;
}
