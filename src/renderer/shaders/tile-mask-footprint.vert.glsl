#version 300 es
precision highp float;

in vec3 aPosition;
in vec2 aTexCoords2;

void main() {

    // The mesh's `aPosition` slot must stay live so `gpuSubmesh.draw2`
    // can bind it by name. Multiplying by zero keeps the attribute
    // referenced without affecting the UV-space clip position written
    // from `aTexCoords2`.
    float keepPosition = aPosition.x * 0.0;
    gl_Position = vec4(aTexCoords2 * 2.0 - 1.0, keepPosition, 1.0);
}
