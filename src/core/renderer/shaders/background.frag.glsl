#version 300 es
precision mediump float;

// atmUbo + atmDensity() + uTexAtmDensity sampler
#include "./includes/atmosphere.inc.glsl";

in vec3 varFragDir;

out vec4 outColor;

void main()
{
    float atmosphere = atmDensityDir(varFragDir, 1001.0);
    outColor = atmColor(atmosphere, vec4(0.0, 0.0, 0.0, 1.0));
}

