#version 300 es
precision highp float;

#include "./includes/atmosphere.inc.glsl";

layout (location = 0) in vec3 aPos;
layout (location = 1) in vec3 aNormal;
layout (location = 2) in vec2 aTexCoords;

uniform mat4 view;
uniform mat4 projection;

out vec3 vFragPos;
out vec3 vFragPosVC;
out vec3 vNormal;
out vec2 vTexCoords;
out float vAtmDensity;

void main() {
    vFragPos = aPos;
    vNormal = aNormal;
    vTexCoords = aTexCoords;

    vec4 fragPosVC = view * vec4(aPos, 1.0);
    gl_Position = projection * fragPosVC;

    vFragPosVC = fragPosVC.xyz;
    vAtmDensity = atmDensity(vFragPosVC);

}

