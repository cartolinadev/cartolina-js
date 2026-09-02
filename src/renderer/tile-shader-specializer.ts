/*
 * tile-shader-specializer.ts — generate a specialized tile
 * fragment shader from the prepared layer stack
 *
 * The generic tile.frag.glsl interprets a UBO-encoded layer
 * stack per fragment: a loop, dynamic branching on
 * source/target/operation, sampler index ladders, and a
 * register stack. On complex styles this interpreter overhead
 * dominates GPU time.
 *
 * This module replaces the interpreter with straight-line GLSL
 * whose opcodes are compile-time constants. The per-opcode
 * bodies live as functions in tile.frag.glsl (shared with the
 * interpreter); the generated main() flattens the register
 * stack into scope-level registers and calls those functions.
 * The UBO still carries per-draw dynamic values (texture
 * transforms, blend alphas, constant colors), so no per-tile
 * recompilation is needed — programs are keyed by the
 * structural shape of the layer stack.
 */


/** Structural description of one active layer. */
export type LayerDesc = {
    target: 'color' | 'normal';
    source:
        | 'constant' | 'texture' | 'shade' | 'pop'
        | 'atm-density' | 'none' | 'normal-flat';
    operation:
        | 'push' | 'blend' | 'atm-color' | 'shadows';

    srcShadeType?: 'diffuse' | 'specular';
    srcTextureUVs?: 'internal' | 'external';
    srcTextureSampling?: 'raw' | 'normal';
    srcTextureMaskIdx?: number;

    opBlendMode?:
        | 'overlay' | 'add' | 'multiply'
        | 'specular-multiply';

    srcTextureIdx?: number;
    flagMask: number;
}


/**
 * Cache key from the layer-stack shape.
 */
export function layerSignature(
    layers: LayerDesc[],
): string {

    const parts: string[] = [];

    for (const layer of layers) {

        let key =
            `${layer.target[0]}`
            + `${layer.source[0]}`
            + `${layer.operation[0]}`;

        if (layer.source === 'shade')
            key += layer.srcShadeType![0];

        if (layer.source === 'texture') {
            key += layer.srcTextureUVs![0]
                + layer.srcTextureSampling![0];
            key += layer.srcTextureIdx;
            if (layer.srcTextureMaskIdx! >= 0)
                key += `m${layer.srcTextureMaskIdx}`;
        }

        if (layer.operation === 'blend')
            key += layer.opBlendMode![0];

        if (layer.flagMask)
            key += `f${layer.flagMask}`;

        parts.push(key);
    }

    return parts.join('|');
}


/**
 * Generate a specialized `void main()` body.
 */
export function generateSpecializedMain(
    layers: LayerDesc[],
): string {

    const lines: string[] = [];
    let colorDepth = 0;
    let normalDepth = 0;

    lines.push('void main() {');
    lines.push('');
    lines.push('    int renderFlags = frameRenderFlags();');
    lines.push('');

    lines.push('#ifdef TILE_DISCARD');
    lines.push('    if (uMaskEnabled) {');
    lines.push(
        '        float covered = texture(uMask, vTexCoords2).r;');
    lines.push(
        '        if (covered > frameMaskThreshold()) discard;');
    lines.push('    }');
    lines.push('#endif');
    lines.push('');

    lines.push('    Light light = frameLight();');
    lines.push('    Eye eye = frameEye();');
    lines.push('');

    lines.push(
        '    vec3 flatNormal'
        + ' = normalize(cross(dFdx(vFragPos), dFdy(vFragPos)));');
    lines.push('');

    // pre-scan to find max stack depths so registers can be
    // declared at function scope
    let maxColorDepth = 0;
    let maxNormalDepth = 1; // n0 is always declared
    {
        let cd = 0, nd = 1;
        for (const layer of layers) {
            if (layer.operation === 'push') {
                if (layer.target === 'color') cd++;
                if (layer.target === 'normal') nd++;
            }
            if (layer.source === 'pop') {
                if (layer.target === 'color') cd--;
                if (layer.target === 'normal') nd--;
            }
            if (cd > maxColorDepth) maxColorDepth = cd;
            if (nd > maxNormalDepth) maxNormalDepth = nd;
        }
    }

    // declare all stack registers at function scope; normal
    // registers start at flatNormal so a runtime-skipped push
    // (a flag-gated normal layer) leaves the stack top at the
    // flat normal, matching the interpreter's runtime stack
    lines.push('    vec3 n0 = flatNormal;');

    for (let depth = 1; depth < maxNormalDepth; depth++)
        lines.push(`    vec3 n${depth} = flatNormal;`);

    for (let depth = 0; depth < maxColorDepth; depth++)
        lines.push(`    vec3 c${depth};`);

    normalDepth = 1;

    lines.push('');

    for (let idx = 0; idx < layers.length; idx++) {

        const layer = layers[idx];
        const ubo = `uLayers.layers[${idx}]`;

        if (layer.flagMask)
            lines.push(
                '    if ((renderFlags'
                + ` & ${layer.flagMask}) == ${layer.flagMask}) {`);

        const ind = layer.flagMask ? '        ' : '    ';
        const op = `op${idx}`;

        emitSource(layer, ubo, op, ind, lines, normalDepth);

        if (layer.target === 'color')
            lines.push(
                `${ind}${op} = vec4(mix(vec3(${op}), vec3(1.0),`
                + ` ${ubo}.p2.y), ${op}.w);`);

        emitOperation(
            layer, ubo, op, ind, lines, colorDepth, normalDepth);

        if (layer.operation === 'push') {
            if (layer.target === 'color') colorDepth++;
            if (layer.target === 'normal') normalDepth++;
        }
        if (layer.source === 'pop') {
            if (layer.target === 'color') colorDepth--;
            if (layer.target === 'normal') normalDepth--;
        }

        if (layer.flagMask) lines.push('    }');

        lines.push('');
    }

    lines.push(`    fragColor = vec4(c${colorDepth - 1}, 1.0);`);
    lines.push('}');

    return lines.join('\n');
}


/**
 * Replace main() in the full tile fragment shader source
 * with the specialized version.
 */
export function specializeFragmentSource(
    baseSource: string,
    layers: LayerDesc[],
): string {

    const mainIdx =
        baseSource.indexOf('void main()');

    if (mainIdx < 0)
        throw new Error(
            'tile.frag.glsl: void main() not found');

    let cutIdx = mainIdx;
    const commentIdx = baseSource.lastIndexOf(
        '// main', mainIdx);

    if (commentIdx >= 0
        && mainIdx - commentIdx < 20)
        cutIdx = commentIdx;

    return baseSource.substring(0, cutIdx)
        + generateSpecializedMain(layers) + '\n';
}


// -- internal helpers --

// emit the statement that computes `vec4 opN` for this layer's
// source; texture and shade defer to shared GLSL functions,
// the rest are one-liners

function emitSource(
    layer: LayerDesc,
    ubo: string,
    op: string,
    ind: string,
    lines: string[],
    normalDepth: number,
): void {

    switch (layer.source) {

        case 'constant':
            lines.push(
                `${ind}vec4 ${op} = vec4(${ubo}.p1.xyz, 1.0);`);
            break;

        case 'texture':
            emitTextureSource(layer, ubo, op, ind, lines);
            break;

        case 'shade': {
            const nTop = `n${normalDepth - 1}`;
            const specular = layer.srcShadeType === 'specular'
                ? 'true' : 'false';
            lines.push(
                `${ind}vec4 ${op} = srcShade(${nTop}, flatNormal,`
                + ` ${specular}, light, eye, renderFlags);`);
            break;
        }

        // pop's value feeds the blend below; op only carries its
        // alpha (1.0)
        case 'pop':
            lines.push(`${ind}vec4 ${op} = vec4(1.0);`);
            break;

        case 'atm-density':
            lines.push(
                `${ind}vec4 ${op} = vec4(vec3(vAtmDensity), 1.0);`);
            break;

        case 'none':
            lines.push(`${ind}vec4 ${op} = vec4(0.0);`);
            break;

        case 'normal-flat':
            lines.push(
                `${ind}vec4 ${op} = vec4(flatNormal, 1.0);`);
            break;
    }
}


function emitTextureSource(
    layer: LayerDesc,
    ubo: string,
    op: string,
    ind: string,
    lines: string[],
): void {

    const baseUv = layer.srcTextureUVs === 'internal'
        ? 'vTexCoords' : 'vTexCoords2';
    const texIdx = layer.srcTextureIdx!;
    const maskIdx = layer.srcTextureMaskIdx !== undefined
        && layer.srcTextureMaskIdx >= 0
            ? layer.srcTextureMaskIdx : -1;
    const normalSampling = layer.srcTextureSampling === 'normal'
        ? 'true' : 'false';

    lines.push(
        `${ind}vec4 ${op} = srcTexture(${texIdx}, ${maskIdx},`
        + ` ${baseUv}, ${ubo}.p1, ${normalSampling});`);
}


function emitOperation(
    layer: LayerDesc,
    ubo: string,
    op: string,
    ind: string,
    lines: string[],
    colorDepth: number,
    normalDepth: number,
): void {

    switch (layer.operation) {

        case 'push': {
            // registers are declared at function scope
            const reg = layer.target === 'color'
                ? `c${colorDepth}` : `n${normalDepth}`;
            lines.push(`${ind}${reg} = ${op}.xyz;`);
            break;
        }

        case 'blend': {

            // pop-blend folds the popped register into the one
            // below it; a plain blend folds the operand into the
            // current top
            if (layer.source === 'pop') {
                const popReg = layer.target === 'color'
                    ? `c${colorDepth - 1}` : `n${normalDepth - 1}`;
                const base = layer.target === 'color'
                    ? `c${colorDepth - 2}` : `n${normalDepth - 2}`;
                emitBlend(
                    layer, ubo, op, base,
                    `vec4(${popReg}, 1.0)`, ind, lines);
                break;
            }

            const base = layer.target === 'color'
                ? `c${colorDepth - 1}` : `n${normalDepth - 1}`;
            emitBlend(layer, ubo, op, base, op, ind, lines);
            break;
        }

        case 'atm-color': {
            const reg = `c${colorDepth - 1}`;
            lines.push(
                `${ind}${reg} = atmColor(${op}.x,`
                + ` vec4(${reg}, 1.0)).xyz;`);
            break;
        }

        case 'shadows': {
            const reg = `c${colorDepth - 1}`;
            lines.push(`${ind}${reg} = applyShadows(${reg}, eye);`);
            break;
        }
    }
}


// emit `base = blend<Mode>(base, operand, alpha);` for the
// layer's blend mode

function emitBlend(
    layer: LayerDesc,
    ubo: string,
    op: string,
    base: string,
    operand: string,
    ind: string,
    lines: string[],
): void {

    const alpha = `${ubo}.p2.x * ${op}.w`;

    switch (layer.opBlendMode) {

        case 'overlay':
            lines.push(
                `${ind}${base} = blendOverlay(${base}, ${operand},`
                + ` ${alpha});`);
            break;

        case 'add':
            lines.push(
                `${ind}${base} = blendAdd(${base}, ${operand},`
                + ` ${alpha});`);
            break;

        case 'multiply':
            lines.push(
                `${ind}${base} = blendMultiply(${base}, ${operand},`
                + ` ${alpha});`);
            break;

        case 'specular-multiply':
            lines.push(
                `${ind}${base} = blendSpecularMultiply(${base},`
                + ` ${operand}, light);`);
            break;
    }
}
