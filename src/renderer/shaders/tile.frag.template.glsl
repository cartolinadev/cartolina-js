/*
 * tile.frag.template.glsl — GLSL text fragments for the tile
 * shader specializer
 *
 * This file is not a compiled shader. The specializer
 * (tile-shader-specializer.ts) parses the named snippets below
 * and assembles them into a specialized void main() body. Each
 * snippet lives between a //%snippet <name> line and a //%end
 * line; the lines between are kept verbatim. ${name} holes are
 * filled in by the specializer with generated register names,
 * indentation, and per-layer indices.
 *
 * A physical line ending in a backslash continues onto the next
 * line: the newline and the continuation line's leading
 * whitespace are dropped, so a single output statement can be
 * wrapped here to stay within the line limit.
 */


//%snippet prologue
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
//%end


//%snippet normalReg
    vec3 n${depth} = flatNormal;
//%end


//%snippet colorReg
    vec3 c${depth};
//%end


//%snippet guardOpen
    if ((renderFlags & ${flagMask}) == ${flagMask}) {
//%end


//%snippet guardClose
    }
//%end


//%snippet whitewash
${ind}${op} = vec4(mix(vec3(${op}), vec3(1.0), ${ubo}.p2.y), ${op}.w);
//%end


//%snippet src.constant
${ind}vec4 ${op} = vec4(${ubo}.p1.xyz, 1.0);
//%end


//%snippet src.texture
${ind}vec4 ${op} = srcTexture(${texIdx}, ${maskIdx}, \
    ${baseUv}, ${ubo}.p1, ${normalSampling});
//%end


//%snippet src.shade
${ind}vec4 ${op} = srcShade(${nTop}, flatNormal, ${specular}, \
    light, eye, renderFlags);
//%end


//%snippet src.pop
${ind}vec4 ${op} = vec4(1.0);
//%end


//%snippet src.atmDensity
${ind}vec4 ${op} = vec4(vec3(vAtmDensity), 1.0);
//%end


//%snippet src.none
${ind}vec4 ${op} = vec4(0.0);
//%end


//%snippet src.normalFlat
${ind}vec4 ${op} = vec4(flatNormal, 1.0);
//%end


//%snippet op.push
${ind}${reg} = ${op}.xyz;
//%end


//%snippet op.atmColor
${ind}${reg} = atmColor(${op}.x, vec4(${reg}, 1.0)).xyz;
//%end


//%snippet op.shadows
${ind}${reg} = applyShadows(${reg}, eye);
//%end


//%snippet blend.overlay
${ind}${base} = blendOverlay(${base}, ${operand}, ${alpha});
//%end


//%snippet blend.add
${ind}${base} = blendAdd(${base}, ${operand}, ${alpha});
//%end


//%snippet blend.multiply
${ind}${base} = blendMultiply(${base}, ${operand}, ${alpha});
//%end


//%snippet blend.specularMultiply
${ind}${base} = blendSpecularMultiply(${base}, ${operand}, light);
//%end


//%snippet expr.blendAlpha
${ubo}.p2.x * ${op}.w
//%end


//%snippet expr.popOperand
vec4(${popReg}, 1.0)
//%end


//%snippet expr.uboRef
uLayers.layers[${idx}]
//%end


//%snippet uv.internal
vTexCoords
//%end


//%snippet uv.external
vTexCoords2
//%end


//%snippet epilogue
    fragColor = vec4(${top}, 1.0);
}
//%end
