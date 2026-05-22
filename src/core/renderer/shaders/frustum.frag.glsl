#version 300 es
precision mediump float;

#include "./includes/frame.inc.glsl";

in vec3 vPosition;

uniform vec4 uColor;

out vec4 outColor;

void main()
{
    vec3 normal = normalize(cross(dFdx(vPosition), dFdy(vPosition)));
    vec3 toLight = normalize(-uFrame.lightDirection.xyz);
    float lambert = max(dot(normal, toLight), 0.0);
    Light light = frameLight();
    vec3 shade = light.ambient + lambert * light.diffuse;

    outColor = vec4(uColor.rgb * shade, uColor.a);
}
