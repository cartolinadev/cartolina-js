/*
 * tile-shader-specializer.ts — assemble the tile fragment shader
 * for a given layer stack
 *
 * A style's layer stack is fixed per draw, not per fragment, so
 * the composition it describes is baked into straight-line GLSL
 * whose opcodes are compile-time constants. The generated main()
 * flattens the layer stack into scope-level registers and calls
 * the shared opcode helper functions. The UBO still carries the
 * per-draw dynamic values (texture transforms, blend alphas,
 * constant colors), so no per-tile recompilation is needed —
 * programs are keyed by the structural shape of the layer stack.
 *
 * The GLSL text lives as named snippets in
 * tile.frag.template.glsl: the prologue snippet is the whole
 * shader head (varyings, uniforms, the helper functions, and the
 * opening of main), and the rest are the register and per-layer
 * statement forms. This module supplies the register allocation,
 * indentation, and per-layer indices that fill them.
 */


import specializerTemplate from './shaders/tile.frag.template.glsl';


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


const SNIPPETS = parseSnippets(specializerTemplate);


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

    lines.push(SNIPPETS.prologue);
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
    for (let depth = 0; depth < maxNormalDepth; depth++)
        lines.push(fill(SNIPPETS.normalReg, { depth }));

    for (let depth = 0; depth < maxColorDepth; depth++)
        lines.push(fill(SNIPPETS.colorReg, { depth }));

    normalDepth = 1;

    lines.push('');

    for (let idx = 0; idx < layers.length; idx++) {

        const layer = layers[idx];
        const ubo = fill(SNIPPETS['expr.uboRef'], { idx });

        if (layer.flagMask)
            lines.push(
                fill(SNIPPETS.guardOpen, { flagMask: layer.flagMask }));

        const ind = layer.flagMask ? '        ' : '    ';
        const op = `op${idx}`;

        emitSource(layer, ubo, op, ind, lines, normalDepth);

        if (layer.target === 'color')
            lines.push(fill(SNIPPETS.whitewash, { ind, op, ubo }));

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

        if (layer.flagMask) lines.push(SNIPPETS.guardClose);

        lines.push('');
    }

    // an empty or normal-only stack pushed no color register; the
    // final color is then black, matching the retired interpreter
    const top = colorDepth >= 1 ? `c${colorDepth - 1}` : 'vec3(0.0)';

    lines.push(fill(SNIPPETS.epilogue, { top }));

    return lines.join('\n');
}


/**
 * Assemble the full tile fragment shader source for the layer
 * stack: the prologue (shader head and the opening of main)
 * followed by the generated register and layer code.
 */
export function specializeFragmentSource(
    layers: LayerDesc[],
): string {

    return generateSpecializedMain(layers) + '\n';
}


// -- internal helpers --


/**
 * Parse the snippet template into a name → text map. A snippet
 * runs from a `//%snippet <name>` line to the next `//%end`; the
 * lines between are kept verbatim, subject to line continuation.
 */
function parseSnippets(
    template: string,
): Record<string, string> {

    const snippets: Record<string, string> = {};
    const rawLines = template.split('\n');

    let name: string | null = null;
    let body: string[] = [];

    for (const rawLine of rawLines) {

        const start = rawLine.match(/^\/\/%snippet\s+(\S+)\s*$/);

        if (start) {
            name = start[1];
            body = [];
            continue;
        }

        const end = rawLine.match(/^\/\/%end(?:\s+(\S+))?\s*$/);

        if (end) {

            // an optional name on //%end is a reading anchor; when
            // present it must match the open snippet
            if (name !== null && end[1] && end[1] !== name)
                throw new Error(
                    `snippet '${name}' closed by '//%end ${end[1]}'`);

            if (name !== null) snippets[name] = joinContinuations(body);
            name = null;
            continue;
        }

        if (name !== null) body.push(rawLine);
    }

    return snippets;
}


/**
 * Join snippet body lines. A line ending in a backslash continues
 * onto the next line: the backslash and the following line's
 * leading whitespace are dropped, so one output statement can be
 * wrapped in the template to stay within the line limit.
 */
function joinContinuations(
    bodyLines: string[],
): string {

    const out: string[] = [];

    for (const line of bodyLines) {

        // a pending backslash appends this line to the previous
        // one with its leading whitespace removed
        if (out.length > 0 && out[out.length - 1].endsWith('\\')) {

            const prev = out[out.length - 1];
            out[out.length - 1] =
                prev.slice(0, -1) + line.replace(/^\s+/, '');
            continue;
        }

        out.push(line);
    }

    return out.join('\n');
}


/**
 * Substitute every `${name}` hole in a snippet with its value.
 */
function fill(
    template: string,
    slots: Record<string, string | number>,
): string {

    let out = template;

    for (const key of Object.keys(slots))
        out = out.split('${' + key + '}').join(String(slots[key]));

    return out;
}


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
            lines.push(fill(SNIPPETS['src.constant'], { ind, op, ubo }));
            break;

        case 'texture':
            emitTextureSource(layer, ubo, op, ind, lines);
            break;

        case 'shade': {
            const nTop = `n${normalDepth - 1}`;
            const specular = layer.srcShadeType === 'specular'
                ? 'true' : 'false';
            lines.push(
                fill(SNIPPETS['src.shade'],
                    { ind, op, nTop, specular }));
            break;
        }

        // pop's value feeds the blend below; op only carries its
        // alpha (1.0)
        case 'pop':
            lines.push(fill(SNIPPETS['src.pop'], { ind, op }));
            break;

        case 'atm-density':
            lines.push(fill(SNIPPETS['src.atmDensity'], { ind, op }));
            break;

        case 'none':
            lines.push(fill(SNIPPETS['src.none'], { ind, op }));
            break;

        case 'normal-flat':
            lines.push(fill(SNIPPETS['src.normalFlat'], { ind, op }));
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
        ? SNIPPETS['uv.internal'] : SNIPPETS['uv.external'];
    const texIdx = layer.srcTextureIdx!;
    const maskIdx = layer.srcTextureMaskIdx !== undefined
        && layer.srcTextureMaskIdx >= 0
            ? layer.srcTextureMaskIdx : -1;
    const normalSampling = layer.srcTextureSampling === 'normal'
        ? 'true' : 'false';

    lines.push(
        fill(SNIPPETS['src.texture'],
            { ind, op, texIdx, maskIdx, baseUv, ubo, normalSampling }));
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
            lines.push(fill(SNIPPETS['op.push'], { ind, reg, op }));
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
                const operand =
                    fill(SNIPPETS['expr.popOperand'], { popReg });
                emitBlend(layer, ubo, op, base, operand, ind, lines);
                break;
            }

            const base = layer.target === 'color'
                ? `c${colorDepth - 1}` : `n${normalDepth - 1}`;
            emitBlend(layer, ubo, op, base, op, ind, lines);
            break;
        }

        case 'atm-color': {
            const reg = `c${colorDepth - 1}`;
            lines.push(fill(SNIPPETS['op.atmColor'], { ind, reg, op }));
            break;
        }

        case 'shadows': {
            const reg = `c${colorDepth - 1}`;
            lines.push(fill(SNIPPETS['op.shadows'], { ind, reg }));
            break;
        }
    }
}


// emit the blend of `operand` into register `base`; specular
// multiply keeps its helper, the three trivial modes are inlined

function emitBlend(
    layer: LayerDesc,
    ubo: string,
    op: string,
    base: string,
    operand: string,
    ind: string,
    lines: string[],
): void {

    // specular multiply has a substantial body; keep it a function
    if (layer.opBlendMode === 'specular-multiply') {
        lines.push(
            fill(SNIPPETS['blend.specularMultiply'],
                { ind, base, operand }));
        return;
    }

    // bind the blend alpha to a temp so overlay does not evaluate
    // the expression twice
    const alphaVar = `${op}Alpha`;
    const alphaExpr = fill(SNIPPETS['expr.blendAlpha'], { ubo, op });

    lines.push(
        fill(SNIPPETS['blend.alpha'], { ind, alphaVar, alphaExpr }));

    switch (layer.opBlendMode) {

        case 'overlay':
            lines.push(
                fill(SNIPPETS['blend.overlay'],
                    { ind, base, operand, alpha: alphaVar }));
            break;

        case 'add':
            lines.push(
                fill(SNIPPETS['blend.add'],
                    { ind, base, operand, alpha: alphaVar }));
            break;

        case 'multiply':
            lines.push(
                fill(SNIPPETS['blend.multiply'],
                    { ind, base, operand, alpha: alphaVar }));
            break;
    }
}
