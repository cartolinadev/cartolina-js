#version 300 es
precision highp float;

in vec3 aPosition;
in vec2 aTexCoords2;

void main() {

    float keepPosition = aPosition.x * 0.0;
    gl_Position = vec4(aTexCoords2 * 2.0 - 1.0, keepPosition, 1.0);
}
