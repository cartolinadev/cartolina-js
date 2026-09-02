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
 * whose opcodes are compile-time constants. The UBO still
 * carries per-draw dynamic values (texture transforms, blend
 * alphas, constant colors), so no per-tile recompilation is
 * needed — programs are keyed by the structural shape of the
 * layer stack.
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
    lines.push(
        '    int renderFlags'
        + ' = frameRenderFlags();');
    lines.push('');

    lines.push('#ifdef TILE_DISCARD');
    lines.push('    if (uMaskEnabled) {');
    lines.push(
        '        float covered = texture('
        + 'uMask, vTexCoords2).r;');
    lines.push(
        '        if (covered'
        + ' > frameMaskThreshold())'
        + ' discard;');
    lines.push('    }');
    lines.push('#endif');
    lines.push('');

    lines.push('    Light light = frameLight();');
    lines.push('    Eye eye = frameEye();');
    lines.push('');

    lines.push(
        '    vec3 flatNormal = normalize('
        + 'cross(dFdx(vFragPos),'
        + ' dFdy(vFragPos)));');
    lines.push('');

    // pre-scan to find max stack depths so registers
    // can be declared at function scope
    let maxColorDepth = 0;
    let maxNormalDepth = 1; // n0 is always declared
    {
        let cd = 0, nd = 1;
        for (const layer of layers) {
            if (layer.operation === 'push') {
                if (layer.target === 'color')
                    cd++;
                if (layer.target === 'normal')
                    nd++;
            }
            if (layer.source === 'pop') {
                if (layer.target === 'color')
                    cd--;
                if (layer.target === 'normal')
                    nd--;
            }
            if (cd > maxColorDepth)
                maxColorDepth = cd;
            if (nd > maxNormalDepth)
                maxNormalDepth = nd;
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

    // declare shadeN at function scope so it survives the
    // flag-guard block around a shade layer
    const needsShadeN = layers.some(
        l => l.source === 'shade');

    if (needsShadeN)
        lines.push('    vec3 shadeN;');

    lines.push('');

    const needsZenith = layers.some(
        l => l.source === 'shade'
            || (l.source === 'texture'
                && l.srcTextureSampling
                    === 'normal'));

    if (needsZenith) {
        lines.push(
            '    vec3 zenithNorm'
            + ' = normalize('
            + 'vEllipsoidZenith);');
        lines.push('');
    }

    for (let idx = 0; idx < layers.length; idx++) {

        const layer = layers[idx];
        const ubo = `uLayers.layers[${idx}]`;

        if (layer.flagMask) {
            lines.push(
                '    if ((renderFlags'
                + ` & ${layer.flagMask})`
                + ` == ${layer.flagMask}) {`);
        }

        const ind = layer.flagMask
            ? '        ' : '    ';
        const op = `op${idx}`;

        emitSource(
            layer, idx, ubo, op, ind, lines,
            normalDepth);

        if (layer.target === 'color')
            lines.push(
                `${ind}${op} = vec4(`
                + `mix(vec3(${op}),`
                + ` vec3(1.0),`
                + ` ${ubo}.p2.y),`
                + ` ${op}.w);`);

        emitOperation(
            layer, idx, op, ind, lines,
            colorDepth, normalDepth);

        if (layer.operation === 'push') {
            if (layer.target === 'color')
                colorDepth++;
            if (layer.target === 'normal')
                normalDepth++;
        }
        if (layer.source === 'pop') {
            if (layer.target === 'color')
                colorDepth--;
            if (layer.target === 'normal')
                normalDepth--;
        }

        if (layer.flagMask)
            lines.push('    }');

        lines.push('');
    }

    lines.push(
        `    fragColor = vec4(`
        + `c${colorDepth - 1}, 1.0);`);
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

function emitSource(
    layer: LayerDesc,
    idx: number,
    ubo: string,
    op: string,
    ind: string,
    lines: string[],
    normalDepth: number,
): void {

    switch (layer.source) {

        case 'constant':
            lines.push(
                `${ind}vec4 ${op}`
                + ` = vec4(`
                + `${ubo}.p1.xyz, 1.0);`);
            break;

        case 'texture':
            emitTextureSource(
                layer, idx, ubo, op,
                ind, lines);
            break;

        case 'shade':
            emitShadeSource(
                layer, idx, op, ind, lines,
                normalDepth);
            break;

        case 'pop':
            lines.push(
                `${ind}vec4 ${op}`
                + ` = vec4(1.0);`);
            break;

        case 'atm-density':
            lines.push(
                `${ind}vec4 ${op}`
                + ` = vec4(`
                + `vec3(vAtmDensity), 1.0);`);
            break;

        case 'none':
            lines.push(
                `${ind}vec4 ${op}`
                + ` = vec4(0.0);`);
            break;

        case 'normal-flat':
            lines.push(
                `${ind}vec4 ${op}`
                + ` = vec4(`
                + `flatNormal, 1.0);`);
            break;
    }
}


function emitTextureSource(
    layer: LayerDesc,
    idx: number,
    ubo: string,
    op: string,
    ind: string,
    lines: string[],
): void {

    const uv = layer.srcTextureUVs === 'internal'
        ? 'vTexCoords' : 'vTexCoords2';

    lines.push(
        `${ind}vec4 xf${idx} = ${ubo}.p1;`);

    lines.push(
        `${ind}vec2 uv${idx} = vec2(`
        + `xf${idx}.x * ${uv}.x`
        + ` + xf${idx}.z,`
        + ` xf${idx}.y * ${uv}.y`
        + ` + xf${idx}.w);`);

    const texIdx = layer.srcTextureIdx!;

    if (layer.srcTextureSampling === 'normal') {
        lines.push(
            `${ind}vec4 ${op}`
            + ` = vec4(`
            + `sampleOctBilinear(`
            + `${texIdx}, uv${idx},`
            + ` vec2(1./256., 1./256.)),`
            + ` 1.0);`);
    } else {
        lines.push(
            `${ind}vec4 ${op}`
            + ` = texture(`
            + `uTexture[${texIdx}],`
            + ` uv${idx});`);
    }

    if (layer.srcTextureMaskIdx !== undefined
        && layer.srcTextureMaskIdx >= 0)

        lines.push(
            `${ind}${op}.w *= texture(`
            + `uTexture[`
            + `${layer.srcTextureMaskIdx}],`
            + ` uv${idx}).x;`);
}


function emitShadeSource(
    layer: LayerDesc,
    idx: number,
    op: string,
    ind: string,
    lines: string[],
    normalDepth: number,
): void {

    const nTop = `n${normalDepth - 1}`;

    // start from the current normal-stack top; the exaggeration
    // correction, the tangent-frame transform and the slope are
    // gated on the runtime flags exactly as the interpreter does
    lines.push(`${ind}shadeN = ${nTop};`);
    lines.push(`${ind}float slope${idx} = 0.0;`);

    lines.push(
        `${ind}if ((renderFlags & FlagNormalMaps) != 0) {`);

    // skip the exaggeration correction when there is none
    lines.push(
        `${ind}    if (vVerticalExaggeration - 1.0 > 1e-3) {`);
    lines.push(
        `${ind}        float va${idx} = vVerticalExaggeration;`);
    lines.push(
        `${ind}        if (abs(1.0 - shadeN.z) < 5e-4)`);
    lines.push(
        `${ind}            va${idx} = 1.0`
        + ` + abs(1.0 - shadeN.z)`
        + ` / 5e-4 * (va${idx} - 1.0);`);
    lines.push(`${ind}        shadeN.z *= 1.0 / va${idx};`);
    lines.push(`${ind}        shadeN = normalize(shadeN);`);
    lines.push(`${ind}    }`);

    lines.push(
        `${ind}    if ((renderFlags & FlagShadingSlope) != 0)`);
    lines.push(
        `${ind}        slope${idx}`
        + ` = acos(clamp(shadeN.z, -1.0, 1.0));`);

    lines.push(
        `${ind}    shadeN`
        + ` = tangentialFrame2Wc(zenithNorm, uUpVector)`
        + ` * shadeN;`);
    lines.push(`${ind}} else {`);

    lines.push(
        `${ind}    if ((renderFlags & FlagShadingSlope) != 0)`);
    lines.push(
        `${ind}        slope${idx} = acos(clamp(`
        + `dot(flatNormal, zenithNorm), -1.0, 1.0));`);
    lines.push(`${ind}}`);

    if (layer.srcShadeType === 'diffuse') {
        lines.push(
            `${ind}float df${idx} = diffuseCoef(`
            + `shadeN, light, zenithNorm,`
            + ` slope${idx}, renderFlags);`);
        lines.push(
            `${ind}vec4 ${op} = vec4(`
            + `light.ambient + df${idx} * light.diffuse, 1.0);`);
    } else {
        lines.push(
            `${ind}vec3 vd${idx} = vFragPos - eye.virtualPos;`);
        lines.push(
            `${ind}vec3 hw${idx} = -normalize(`
            + `normalize(vd${idx})`
            + ` + normalize(light.direction));`);
        lines.push(
            `${ind}vec4 ${op} = vec4(`
            + `vec3(max(dot(shadeN, hw${idx}), 0.0)), 1.0);`);
    }
}


function emitOperation(
    layer: LayerDesc,
    idx: number,
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
                ? `c${colorDepth}`
                : `n${normalDepth}`;
            lines.push(
                `${ind}${reg}`
                + ` = ${op}.xyz;`);
            break;
        }

        case 'blend': {

            if (layer.source === 'pop') {
                const popReg =
                    layer.target === 'color'
                        ? `c${colorDepth - 1}`
                        : `n${normalDepth - 1}`;
                const newBase =
                    layer.target === 'color'
                        ? `c${colorDepth - 2}`
                        : `n${normalDepth - 2}`;
                emitBlendBody(
                    layer, idx, popReg,
                    newBase, op, ind, lines);
                break;
            }

            const baseReg =
                layer.target === 'color'
                    ? `c${colorDepth - 1}`
                    : `n${normalDepth - 1}`;
            emitBlendBody(
                layer, idx, op, baseReg,
                op, ind, lines);
            break;
        }

        case 'atm-color': {
            const reg = `c${colorDepth - 1}`;
            lines.push(
                `${ind}${reg} = atmColor(`
                + `${op}.x,`
                + ` vec4(${reg}, 1.0))`
                + `.xyz;`);
            break;
        }

        case 'shadows': {
            const reg = `c${colorDepth - 1}`;
            lines.push(
                `${ind}float shadowR`
                + ` = min(-vFragPosVC.z`
                + ` / eye.eyeToCenter,`
                + ` 1.0);`);
            lines.push(
                `${ind}float shadowRatio;`);
            lines.push(
                `${ind}if (`
                + `eye.virtualEyeToCenter`
                + ` / eye.eyeToCenter`
                + ` > 0.9) {`);
            lines.push(
                `${ind}    shadowRatio`
                + ` = shadowR;`);
            lines.push(`${ind}} else {`);
            lines.push(
                `${ind}    float d`
                + ` = (eye.eyeToCenter`
                + ` - eye.virtualEyeToCenter)`
                + ` / eye.eyeToCenter;`);
            lines.push(
                `${ind}    shadowRatio`
                + ` = pow(shadowR,`
                + ` log(0.5) / log(d));`);
            lines.push(`${ind}}`);
            lines.push(
                `${ind}${reg} = ${reg}`
                + ` * shadowRatio;`);
            break;
        }
    }
}


function emitBlendBody(
    layer: LayerDesc,
    layerIdx: number,
    srcExpr: string,
    baseReg: string,
    op: string,
    ind: string,
    lines: string[],
): void {

    const ubo = `uLayers.layers[${layerIdx}]`;
    const alpha = `${ubo}.p2.x * ${op}.w`;

    switch (layer.opBlendMode) {

        case 'overlay':
            lines.push(
                `${ind}${baseReg}`
                + ` = (1.0 - ${alpha})`
                + ` * ${baseReg}`
                + ` + ${alpha}`
                + ` * ${srcExpr}.xyz;`);
            break;

        case 'add':
            lines.push(
                `${ind}${baseReg}`
                + ` = ${baseReg}`
                + ` + ${alpha}`
                + ` * ${srcExpr}.xyz;`);
            break;

        case 'multiply':
            lines.push(
                `${ind}${baseReg}`
                + ` = (1.0 - ${alpha}`
                + ` * (1.0`
                + ` - ${srcExpr}.xyz))`
                + ` * ${baseReg};`);
            break;

        case 'specular-multiply':
            emitSpecularMultiply(
                srcExpr, baseReg,
                ind, lines);
            break;
    }
}


function emitSpecularMultiply(
    srcExpr: string,
    baseReg: string,
    ind: string,
    lines: string[],
): void {

    lines.push(
        `${ind}int shininessBits = 4;`);
    lines.push(
        `${ind}int shmask`
        + ` = (1 << shininessBits) - 1;`);
    lines.push(
        `${ind}int cmask`
        + ` = 0xff & ~shmask;`);
    lines.push(
        `${ind}float cdivisor = float(`
        + `(1 << (8 - shininessBits))`
        + ` - 1);`);
    lines.push(
        `${ind}int smValue`
        + ` = int(${baseReg}.x * 255.0);`);
    lines.push(
        `${ind}float specularColor`
        + ` = float(`
        + `(smValue & cmask)`
        + ` >> shininessBits)`
        + ` / cdivisor;`);
    lines.push(
        `${ind}${baseReg}`
        + ` = light.specular`
        + ` * specularColor`
        + ` * pow(${srcExpr}.x, 32.0);`);
}
