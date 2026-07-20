/*
 * vts-stylesheet-linker.ts - merge resolved VTS stylesheets into one
 * symbol space
 */

/**
 * A VTS stylesheet document as fetched: four symbol spaces. The
 * caller absolutizes embedded URLs (font files) before linking.
 */
export type VtsStylesheetData = {
    constants?: Record<string, unknown>;
    fonts?: Record<string, string>;
    bitmaps?: Record<string, unknown>;
    layers?: Record<string, Record<string, unknown>>;
};

/**
 * One resolved VTS stylesheet entering the linker. This identity is
 * transitional: it exists only to qualify colliding symbols during
 * linking and does not survive into the returned style.
 */
export interface VtsStylesheetInput {

    /** Deterministic scope id, unique per resolved stylesheet, used
     *  to qualify conflicting symbols. */
    stylesheetScopeId: string;

    /** Style source id of the geodata source this stylesheet styles. */
    sourceId: string;

    /** Diagnostic path prefix for warnings and notes. */
    path: string;

    /** The absolutized stylesheet document. */
    data: VtsStylesheetData;
}

/** One output rule bound to its geodata source. */
export interface LinkedLayer {
    id: string;
    sourceId: string;
    stylesheetScopeId: string;
    rule: Record<string, unknown>;
}

export interface LinkerNote {
    code: string;
    path: string;
    message: string;
}

export interface LinkerWarning {
    code: string;
    path: string;
    message: string;
    recovery: string;
}

/** The merged symbol spaces plus diagnostics. */
export interface LinkerResult {
    constants: Record<string, unknown>;
    fonts: Record<string, string>;
    bitmaps: Record<string, unknown>;
    layers: LinkedLayer[];
    notes: LinkerNote[];
    warnings: LinkerWarning[];
}


// layer-rule properties whose plain-string value names another layer
const layerRefProps = [
    'inherit', 'selected-layer', 'selected-hover-layer', 'hover-layer',
];

// properties whose value carries font aliases
const fontProps = ['label-font', 'line-label-font'];

// properties whose first array element names a bitmap
const bitmapProps = ['icon-source', 'line-style-texture'];


/*
 * Canonical JSON with sorted object keys: structural equality that
 * ignores object key order while keeping array order significant.
 */
function canonicalJson(value: unknown): string {

    if (Array.isArray(value)) {
        return '[' + value.map(canonicalJson).join(',') + ']';
    }

    if (value !== null && typeof value === 'object') {

        const record = value as Record<string, unknown>;
        const keys = Object.keys(record).sort();

        return '{' + keys.map(
            (key) => JSON.stringify(key) + ':'
                + canonicalJson(record[key])).join(',') + '}';
    }

    return JSON.stringify(value) ?? 'undefined';
}


/**
 * Links several resolved VTS stylesheets into one output symbol space
 * per the RFC 11 rules: a symbol absent from the output keeps its
 * name, a structurally equal definition coalesces silently, and a
 * conflicting definition gets a deterministic scope-qualified name
 * whose references are rewritten across that stylesheet. A fully
 * rewritten collision is an exact conversion recorded as a note; a
 * reference that cannot be classified produces a lossy-conversion
 * warning and the first definition stays bound.
 *
 * Stylesheets must arrive in deterministic order; the caller orders
 * them by source id and view id.
 *
 * `reservedLayerIds` seeds the layer-id space with ids already
 * allocated outside the linker (raster presentation ids), so a
 * qualified lettering layer id cannot collide with one of them.
 */
export function linkStylesheets(
    stylesheets: VtsStylesheetInput[],
    reservedLayerIds: Iterable<string> = [],
): LinkerResult {

    const result: LinkerResult = {
        constants: {},
        fonts: {},
        bitmaps: {},
        layers: [],
        notes: [],
        warnings: [],
    };

    const usedLayerIds = new Set<string>(reservedLayerIds);

    for (const stylesheet of stylesheets) {

        const data = stylesheet.data;

        // clone: rewriting must not touch the caller's document
        const constants = structuredClone(data.constants ?? {});
        const fonts = structuredClone(data.fonts ?? {});
        const bitmaps = structuredClone(data.bitmaps ?? {});
        const layers = structuredClone(data.layers ?? {});

        // pass 1: decide the output name of every stylesheet's symbol
        const constantRenames = planRenames(
            result.constants, constants, stylesheet, 'constants', result);
        const fontRenames = planRenames(
            result.fonts, fonts, stylesheet, 'fonts', result);
        const bitmapRenames = planRenames(
            result.bitmaps, bitmaps, stylesheet, 'bitmaps', result);

        // layer symbols: two sources cannot share one output layer,
        // so a taken id is qualified regardless of equality. Reserve
        // this stylesheet's own layer names too, or a generated
        // qualified name could collide with one of its other layers
        // before it is inserted.
        const layerRenames = new Map<string, string>();
        const reservedLayerNames = new Set(usedLayerIds);
        for (const name of Object.keys(layers)) reservedLayerNames.add(name);

        for (const name of Object.keys(layers)) {

            if (!usedLayerIds.has(name)) continue;

            const qualified = qualifiedName(
                name, stylesheet.stylesheetScopeId,
                (id) => reservedLayerNames.has(id));
            layerRenames.set(name, qualified);
            reservedLayerNames.add(qualified);

            result.notes.push({
                code: 'symbol-renamed',
                path: `${stylesheet.path}:layers.${name}`,
                message: `Layer "${name}" of stylesheet `
                    + `"${stylesheet.stylesheetScopeId}" renamed to `
                    + `"${qualified}"; all references were rewritten.`,
            });
        }

        // pass 2: rewrite the stylesheet's references to renamed symbols
        if (constantRenames.size > 0) {

            rewriteConstantRefs(constants, constantRenames);
            rewriteConstantRefs(layers, constantRenames);
        }

        rewriteFontRefs(
            layers, constants, fontRenames, stylesheet, result);
        rewriteBitmapRefs(
            layers, constants, bitmapRenames, stylesheet, result);
        rewriteLayerRefs(layers, layerRenames, stylesheet, result);

        // pass 3: insert the surviving symbols under their names
        insertSymbols(result.constants, constants, constantRenames);
        insertSymbols(result.fonts, fonts, fontRenames);
        insertSymbols(result.bitmaps, bitmaps, bitmapRenames);

        for (const [name, rule] of Object.entries(layers)) {

            const id = layerRenames.get(name) ?? name;
            usedLayerIds.add(id);

            result.layers.push({
                id,
                sourceId: stylesheet.sourceId,
                stylesheetScopeId: stylesheet.stylesheetScopeId,
                rule,
            });
        }
    }

    return result;
}


/*
 * Decides the output name of each symbol in one space: keep, coalesce,
 * or qualify. Returns the rename map (old name -> qualified name) and
 * records a note per rename.
 */
function planRenames(
    outTable: Record<string, unknown>,
    stylesheetTable: Record<string, unknown>,
    stylesheet: VtsStylesheetInput,
    space: string,
    result: LinkerResult,
): Map<string, string> {

    const renames = new Map<string, string>();

    // reserved names: everything already in the output table, plus
    // every name the stylesheet being merged defines, so a generated
    // qualified name cannot collide with either
    const reserved = new Set(Object.keys(outTable));
    for (const name of Object.keys(stylesheetTable)) reserved.add(name);

    for (const [name, definition] of Object.entries(stylesheetTable)) {

        if (!(name in outTable)) continue;

        if (canonicalJson(outTable[name]) === canonicalJson(definition)) {

            // structurally equal: coalesce silently
            delete stylesheetTable[name];
            continue;
        }

        const qualified = qualifiedName(
            name, stylesheet.stylesheetScopeId, (id) => reserved.has(id));
        renames.set(name, qualified);
        reserved.add(qualified);

        result.notes.push({
            code: 'symbol-renamed',
            path: `${stylesheet.path}:${space}.${name}`,
            message: `${space} symbol "${name}" of stylesheet `
                + `"${stylesheet.stylesheetScopeId}" renamed to `
                + `"${qualified}"; all references were rewritten.`,
        });
    }

    return renames;
}


/* Deterministic scope-qualified name, suffixed until unused. */
function qualifiedName(
    name: string,
    stylesheetScopeId: string,
    taken: (candidate: string) => boolean,
): string {

    let candidate = `${name}--${stylesheetScopeId}`;
    while (taken(candidate)) candidate += '-x';
    return candidate;
}


/* Moves the stylesheet's symbols into the output table under their
 * decided names. Coalesced symbols were already deleted. */
function insertSymbols<T>(
    outTable: Record<string, T>,
    stylesheetTable: Record<string, T>,
    renames: Map<string, string>,
): void {

    for (const [name, definition] of Object.entries(stylesheetTable)) {
        outTable[renames.get(name) ?? name] = definition;
    }
}


/*
 * Rewrites constant references across a value tree: a standalone
 * string equal to a renamed constant, and template occurrences of
 * "{@name}" inside larger strings. Template parsing targets constant
 * references only, so label text and local "&" variables are never
 * touched.
 */
function rewriteConstantRefs(
    value: unknown,
    renames: Map<string, string>,
): void {

    const rewrite = (node: unknown): unknown => {

        if (typeof node === 'string') {

            if (renames.has(node)) return renames.get(node);

            return node.replace(
                /\{(@[^{}]+)\}/g,
                (whole, name: string) =>
                    renames.has(name) ? `{${renames.get(name)}}` : whole);
        }

        if (Array.isArray(node)) {

            for (let i = 0; i < node.length; i++) {
                node[i] = rewrite(node[i]);
            }
            return node;
        }

        if (node !== null && typeof node === 'object') {

            const record = node as Record<string, unknown>;
            for (const key of Object.keys(record)) {
                record[key] = rewrite(record[key]);
            }
            return record;
        }

        return node;
    };

    rewrite(value);
}


/*
 * Rewrites font-alias references for renamed fonts. Font aliases
 * appear in the *-font properties — as alias arrays, single alias
 * strings, or a constant reference — and inside the constants those
 * properties reach. A value shape outside that grammar produces an
 * unresolved-reference warning and stays bound to the first
 * definition.
 */
function rewriteFontRefs(
    layers: Record<string, Record<string, unknown>>,
    constants: Record<string, unknown>,
    renames: Map<string, string>,
    stylesheet: VtsStylesheetInput,
    result: LinkerResult,
): void {

    if (renames.size === 0) return;

    rewriteAliasRefs(
        layers, constants, renames, fontProps, 'font',
        (value, rename) => {

            // alias array, or a single alias string
            if (Array.isArray(value)) {

                for (let i = 0; i < value.length; i++)
                    if (typeof value[i] === 'string')
                        value[i] = rename(value[i] as string);
                return true;
            }

            return false;
        },
        stylesheet, result);
}


/*
 * Rewrites bitmap references for renamed bitmaps. Bitmap names appear
 * as the first element of the icon-source and line-style-texture
 * tuples, directly or through a constant.
 */
function rewriteBitmapRefs(
    layers: Record<string, Record<string, unknown>>,
    constants: Record<string, unknown>,
    renames: Map<string, string>,
    stylesheet: VtsStylesheetInput,
    result: LinkerResult,
): void {

    if (renames.size === 0) return;

    rewriteAliasRefs(
        layers, constants, renames, bitmapProps, 'bitmap',
        (value, rename) => {

            if (Array.isArray(value) && typeof value[0] === 'string') {

                value[0] = rename(value[0] as string);
                return true;
            }

            return false;
        },
        stylesheet, result);
}


/*
 * Shared alias-rewrite walk for fonts and bitmaps: visits the given
 * properties on every rule, applies the shape-specific rewrite, and
 * follows constant references transitively. Emits an
 * unresolved-reference warning when a property value's shape cannot
 * be classified.
 */
function rewriteAliasRefs(
    layers: Record<string, Record<string, unknown>>,
    constants: Record<string, unknown>,
    renames: Map<string, string>,
    props: string[],
    kind: string,
    rewriteShape: (
        value: unknown,
        rename: (alias: string) => string,
    ) => boolean,
    stylesheet: VtsStylesheetInput,
    result: LinkerResult,
): void {

    const rename = (alias: string) => renames.get(alias) ?? alias;
    const constantQueue: string[] = [];
    const visited = new Set<string>();

    const classify = (value: unknown, path: string): void => {

        if (typeof value === 'string') {

            // a constant reference: follow it; a bare alias: rename
            if (value.startsWith('@')) {
                constantQueue.push(value);
                return;
            }

            // handled by the caller replacing the property below
            return;
        }

        if (rewriteShape(value, rename)) return;

        result.warnings.push({
            code: 'unresolved-reference',
            path,
            message: `Cannot classify the ${kind} reference at `
                + `${path}; a renamed ${kind} may stay bound to the `
                + `first definition.`,
            recovery: `The first definition of the conflicting `
                + `${kind} remains in effect for this reference.`,
        });
    };

    for (const [layerName, rule] of Object.entries(layers)) {

        for (const prop of props) {

            if (!(prop in rule)) continue;

            const value = rule[prop];

            if (typeof value === 'string' && !value.startsWith('@')) {

                rule[prop] = rename(value);
                continue;
            }

            classify(value, `${stylesheet.path}:layers.${layerName}.${prop}`);
        }
    }

    // follow referenced constants transitively
    while (constantQueue.length > 0) {

        const name = constantQueue.pop() as string;
        if (visited.has(name)) continue;
        visited.add(name);

        if (!(name in constants)) continue;

        const value = constants[name];

        if (typeof value === 'string') {

            if (value.startsWith('@')) {
                constantQueue.push(value);
            } else {
                constants[name] = rename(value);
            }
            continue;
        }

        classify(value, `${stylesheet.path}:constants.${name}`);
    }
}


/*
 * Rewrites layer-id references for renamed layers: the plain-string
 * reference properties, the next-pass tuple, and visibility-switch
 * pairs. An expression-valued reference cannot be classified while a
 * rename is pending and produces a warning.
 */
function rewriteLayerRefs(
    layers: Record<string, Record<string, unknown>>,
    renames: Map<string, string>,
    stylesheet: VtsStylesheetInput,
    result: LinkerResult,
): void {

    if (renames.size === 0) return;

    const warn = (path: string) => result.warnings.push({
        code: 'unresolved-reference',
        path,
        message: `Cannot classify the layer reference at ${path}; `
            + `a renamed layer may stay bound to its original name.`,
        recovery: `The reference keeps its original layer name.`,
    });

    for (const [layerName, rule] of Object.entries(layers)) {

        const path = (prop: string) =>
            `${stylesheet.path}:layers.${layerName}.${prop}`;

        for (const prop of layerRefProps) {

            if (!(prop in rule)) continue;

            const value = rule[prop];

            if (typeof value === 'string') {

                if (renames.has(value)) rule[prop] = renames.get(value);

            } else {

                warn(path(prop));
            }
        }

        const nextPass = rule['next-pass'];
        if (nextPass !== undefined) {

            if (Array.isArray(nextPass)
                && typeof nextPass[1] === 'string') {

                if (renames.has(nextPass[1]))
                    nextPass[1] = renames.get(nextPass[1]);

            } else {

                warn(path('next-pass'));
            }
        }

        const visibilitySwitch = rule['visibility-switch'];
        if (visibilitySwitch !== undefined) {

            if (Array.isArray(visibilitySwitch)) {

                for (const pair of visibilitySwitch) {

                    // a pair's second element names a layer, or is
                    // null for a level with no layer
                    if (Array.isArray(pair)
                        && typeof pair[1] === 'string') {

                        if (renames.has(pair[1]))
                            pair[1] = renames.get(pair[1]);

                    } else if (!Array.isArray(pair)
                        || pair[1] != null) {

                        warn(path('visibility-switch'));
                    }
                }

            } else {

                warn(path('visibility-switch'));
            }
        }
    }
}
