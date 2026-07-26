#version 300 es
precision highp float;

#include "./includes/frame.inc.glsl";

uniform vec3 uVertices[18];

out vec3 vPosition;

void main()
{
    vPosition = uVertices[gl_VertexID];
    gl_Position =
        uFrame.projection * uFrame.view * vec4(vPosition, 1.0);
}
