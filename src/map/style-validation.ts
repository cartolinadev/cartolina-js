/*
 * style-validation.ts - validate authored style specifications
 */

import typia from 'typia';

import type * as StyleSchema from './style-schema';


/**
 * Validates an authored style before any map object is constructed.
 *
 * Checks schema equality, inline source consistency, unique explicit
 * layer ids, terrain source references, and raster source references.
 * The input remains unchanged.
 *
 * A key the schema does not know is warned about and ignored; a key it
 * knows but whose value has the wrong shape fails the load. The style
 * document is written by a tileserver that versions separately from
 * this library, so a key added there must not stop an older client from
 * rendering what it does understand.
 *
 * @param styleSpec the authored style
 */
export function validateSpecification(
    styleSpec: StyleSchema.StyleSpecification,
): void {

    // Validate the authored object shape. `validateEquals` reports an
    // unrecognized key as a property expecting `undefined`, which
    // separates the two cases above.
    const res = validateStyle(styleSpec);

    if (!res.success) {

        const errs = 'errors' in res ? res.errors : [];

        const unknownKeys = errs.filter(
            (error) => error.expected === 'undefined');
        const malformed = errs.filter(
            (error) => error.expected !== 'undefined');

        for (const error of unknownKeys)
            console.warn(`Unknown style key ${error.path}; ignored.`);

        if (malformed.length > 0) {

            // the cause travels in the message, so an application
            // handling the failure receives it rather than having to
            // read a separate console line
            const details = malformed
                .map((error) => `${error.path}: expected ${error.expected}, `
                    + `got ${JSON.stringify(error.value)}`)
                .join('; ');

            throw new Error(`Invalid style: ${details}.`);
        }
    }

    // Validate relationships between authored source definitions.
    checkInlineSurfaceConsistency(styleSpec.sources);

    const surfaceSourceIds = Object.entries(styleSpec.sources)
        .filter(([, sourceSpec]) => sourceSpec.type === 'cartolina-surface')
        .map(([id]) => id);
    const unknownTerrainSources = styleSpec.terrain.sources
        .filter((id) => !surfaceSourceIds.includes(id));

    if (unknownTerrainSources.length > 0) {
        const msg = 'Invalid style terrain.sources: unknown style surface '
            + 'source id(s): '
            + unknownTerrainSources.join(', ')
            + '. Expected one of: ' + surfaceSourceIds.join(', ');

        throw new Error(msg);
    }

    // Validate explicit layer identity and raster source references.
    const explicitLayerIds = new Set<string>();

    for (const layer of styleSpec.layers ?? []) {

        if (layer.id !== undefined) {

            if (explicitLayerIds.has(layer.id)) {
                throw new Error(
                    `Duplicate style layer id "${layer.id}".`);
            }

            explicitLayerIds.add(layer.id);
        }

        const type = layer.type ?? 'diffuse-map';
        if (!['diffuse-map', 'bump-map', 'specular-map'].includes(type))
            continue;

        const sourceId = layer.source as string;
        const source = styleSpec.sources[sourceId];

        if (!source || source.type !== 'cartolina-tms') {
            throw new Error(`Raster style layer `
                + `"${layer.id ?? '<anonymous>'}" references `
                + `"${sourceId}", which is not a cartolina-tms source.`);
        }
    }
}


/**
 * Validates a surface definition before its metadata reaches any map
 * object.
 *
 * Covers the fields the style loader reads from the definition itself:
 * the reference frame, the SRS, body and service tables, the credit
 * table, and the surface list. Each surface entry stays the
 * responsibility of `TerrainSource.fromMetadata`.
 *
 * @param sourceId style source id, named in the error message
 * @param value untrusted surface definition
 * @returns the validated definition
 */
export function validateSurfaceDefinition(
    sourceId: string,
    value: unknown,
): StyleSchema.SurfaceSourceDefinition {

    const result = typia.validate<StyleSchema.SurfaceSourceDefinition>(value);

    if (!result.success) {

        const details = result.errors
            .map((error) => `${error.path}: expected ${error.expected}`)
            .join('; ');

        throw new Error(`Terrain source "${sourceId}" has an invalid surface `
            + `definition: ${details}.`);
    }

    return result.data;
}


const validateStyle =
    typia.createValidateEquals<StyleSchema.StyleSpecification>();


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
 * checked; they keep the historical first-definition acceptance behavior.
 */
function checkInlineSurfaceConsistency(
    sources: Record<string, StyleSchema.SourceSpecification>,
): void {

    const inline: Array<[
        string,
        StyleSchema.SurfaceSourceDefinition,
    ]> = [];

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

        const definition = sourceSpec.definition as Record<string, unknown>;
        const credits = creditTable(definition.credits);

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


function creditTable(value: unknown): Record<string, unknown> {

    if (value === null || typeof value !== 'object'
        || Array.isArray(value)) return {};

    return value as Record<string, unknown>;
}
