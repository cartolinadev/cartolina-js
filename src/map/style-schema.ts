/*
 * style-schema.ts - style validation and id normalization: schema
 * conformance, inline surface consistency, and unique layer ids
 *
 * Deliberately free of any runtime dependency beyond `typia`: `Map`,
 * `Viewer`, and the renderer classes are not imported here, so this
 * module can be pulled into a lightweight context — such as the
 * `cartolina/compat` converter — without dragging in the GPU
 * rendering pipeline.
 */

import typia from 'typia';

import type { MapStyle } from './style';


export const validateStyle =
    typia.createValidateEquals<MapStyle.StyleSpecification>();


/*
 * Structural equality for inline source metadata: object key order is
 * irrelevant, array order and value identity are significant.
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


/*
 * Validates shared terrain metadata and credit definitions in inline
 * sources before any map object is constructed. URL sources are not
 * checked; they keep the historical first-document acceptance behavior.
 */
export function checkInlineSurfaceConsistency(
    sources: Record<string, MapStyle.SourceSpecification>,
): void {

    const inline: Array<[string, MapStyle.SurfaceSourceDefinition]> = [];

    for (const [id, sourceSpec] of Object.entries(sources))
        if (sourceSpec.type === 'cartolina-surface'
            && 'definition' in sourceSpec) {

            inline.push([id, sourceSpec.definition]);
        }

    if (inline.length > 1) {

        const [firstId, first] = inline[0];

        const sharedKeys =
            ['referenceFrame', 'srses', 'bodies', 'services'] as const;

        for (let i = 1; i < inline.length; i++) {

            const [otherId, other] = inline[i];

            for (const key of sharedKeys) {

                if (canonicalJson(first[key])
                    !== canonicalJson(other[key])) {

                    throw new Error(`Inline terrain sources "${firstId}" and `
                        + `"${otherId}" carry different "${key}" `
                        + `definitions; inline surface metadata must be `
                        + `structurally equal.`);
                }
            }
        }
    }

    // same-id inline credits must carry structurally equal definitions
    const creditOwners: Record<string, [string, string]> = {};

    for (const [id, sourceSpec] of Object.entries(sources)) {

        if (!('definition' in sourceSpec)) continue;

        const credits = effectiveCreditDefinitions(sourceSpec);

        for (const [creditId, credit] of Object.entries(credits)) {

            const canonical = canonicalJson(credit);
            const hasExisting = Object.prototype.hasOwnProperty.call(
                creditOwners, creditId);
            const existing = hasExisting
                ? creditOwners[creditId]
                : undefined;

            if (existing && existing[1] !== canonical) {

                throw new Error(`Credit "${creditId}" is defined differently `
                    + `by inline sources "${existing[0]}" and `
                    + `"${id}".`);
            }

            if (!existing) creditOwners[creditId] = [id, canonical];
        }
    }
}


function effectiveCreditDefinitions(
    sourceSpec: MapStyle.SourceSpecification & { definition: unknown },
): Record<string, unknown> {

    const definition = sourceSpec.definition as Record<string, unknown>;

    if (sourceSpec.type !== 'cartolina-surface')
        return creditTable(definition.credits);

    const outer = creditTable(definition.credits);
    const surfaces = definition.surfaces as unknown[];
    const surface = surfaces[0] as Record<string, unknown>;

    return {
        ...outer,
        ...creditTable(surface?.credits),
    };
}


function creditTable(value: unknown): Record<string, unknown> {

    if (value === null || typeof value !== 'object'
        || Array.isArray(value)) return {};

    return value as Record<string, unknown>;
}


/**
 * Builds the normalized runtime clone of an authored style: every
 * layer gets a unique id and an explicit terrain list, while the
 * caller's object stays untouched.
 *
 * Anonymous layers receive a deterministic generated id derived
 * from the layer's effective type (after the omitted diffuse type
 * default) and its array position; while the candidate equals an
 * explicit authored id, a deterministic `-anon` suffix is appended
 * until it is unique. Duplicate explicit ids are rejected. An
 * omitted layer `terrain` expands to the explicit list of every
 * `cartolina-surface` entry in the `sources` dictionary,
 * independent of the initial `terrain.sources` stack.
 *
 * @param styleSpec the validated authored style
 * @returns the normalized clone
 */
export function normalizeStyle(
    styleSpec: MapStyle.StyleSpecification,
): MapStyle.StyleSpecification {

    const spec = structuredClone(styleSpec);
    const layers = spec.layers ?? [];

    // duplicate explicit ids are authoring errors
    const explicitIds = new Set<string>();

    for (const layer of layers) {

        if (layer.id === undefined) continue;

        if (explicitIds.has(layer.id)) {
            throw new Error(
                `Duplicate style layer id "${layer.id}".`);
        }

        explicitIds.add(layer.id);
    }

    const surfaceSourceIds = Object.entries(spec.sources)
        .filter(([, sourceSpec]) =>
            sourceSpec.type === 'cartolina-surface')
        .map(([id]) => id);

    layers.forEach((layer, index) => {

        if (layer.id === undefined) {

            const effectiveType = layer.type ?? 'diffuse-map';
            let candidate = `${effectiveType}-${index}`;

            while (explicitIds.has(candidate)) candidate += '-anon';
            layer.id = candidate;
        }

        if (layer.terrain === undefined) {
            layer.terrain = [...surfaceSourceIds];
        }
    });

    return spec;
}


/**
 * Validates an authored style against the schema and the inline
 * surface consistency rules, then returns the normalized runtime
 * clone via `normalizeStyle`. Throws before any map object is
 * constructed: on a schema violation, inconsistent inline surface
 * metadata, a duplicate explicit layer id, or a `terrain.sources`
 * entry naming an unknown surface source.
 *
 * Shared by `MapStyle.loadStyle` and by `mapConfigToStyle()`, so a
 * conversion result is rejected at conversion time rather than only
 * when a `Viewer` later loads it.
 *
 * @param styleSpec the authored style
 * @returns the normalized clone
 */
export function validateAndNormalizeStyle(
    styleSpec: MapStyle.StyleSpecification,
): MapStyle.StyleSpecification {

    const res = validateStyle(styleSpec);

    if (!res.success) {

        let errs = 'errors' in res ? res.errors : [];

        for (const e of errs)
            console.error(`${e.path}: expected ${e.expected}, got ${JSON.stringify(e.value)}`);

        throw new Error(`Invalid style (${errs.length} errors)`);
    }

    // inline surface metadata must be consistent before any map
    // object is constructed
    checkInlineSurfaceConsistency(styleSpec.sources);

    // normalized runtime clone; the caller's object stays untouched
    const spec = normalizeStyle(styleSpec);

    const styleSurfaceSourceIds = Object.entries(spec.sources)
        .filter(([, sourceSpec]) => sourceSpec.type === 'cartolina-surface')
        .map(([id]) => id);
    const unknownTerrainSources = spec.terrain.sources
        .filter((id) => !styleSurfaceSourceIds.includes(id));

    if (unknownTerrainSources.length > 0) {
        const msg = 'Invalid style terrain.sources: unknown style surface source id(s): '
            + unknownTerrainSources.join(', ')
            + '. Expected one of: ' + styleSurfaceSourceIds.join(', ');

        console.error(msg);
        throw new Error(msg);
    }

    for (const layer of spec.layers ?? []) {

        const type = layer.type ?? 'diffuse-map';
        if (!['diffuse-map', 'bump-map', 'specular-map'].includes(type)) {
            continue;
        }

        const sourceId = layer.source as string;
        const source = spec.sources[sourceId];

        if (!source || source.type !== 'cartolina-tms') {
            throw new Error(`Raster style layer "${layer.id}" references `
                + `"${sourceId}", which is not a cartolina-tms source.`);
        }
    }

    return spec;
}
