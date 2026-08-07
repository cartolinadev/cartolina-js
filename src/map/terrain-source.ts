/*
 * terrain-source.ts - resolve and expose terrain surface metadata
 */

import type Map from './map';

import typia from 'typia';

import * as url from '../utils/url';


/**
 * A resolved `cartolina-surface` source owned by `Map`.
 *
 * Construction extracts the supported metadata from the surface entry
 * of a surface definition into immutable state, so every instance is
 * complete and ready for resource URL queries. A retrieval failure
 * rejects style loading and produces no instance.
 */
class TerrainSource {

    /**
     * Constructs an immutable source from validated metadata.
     *
     * @param map typed map that owns this source
     * @param sourceId style source id
     * @param definition validated surface definition
     * @param baseUrl URL used to resolve relative resource templates
     */
    private constructor(
        map: Map,
        sourceId: string,
        definition: TerrainSource.Definition,
        baseUrl: string,
    ) {

        this.map_ = map;
        this.id = sourceId;
        this.lodRange = definition.lodRange;
        this.metaUrl = TerrainSource.resolveUrl(definition.metaUrl, baseUrl);
        this.navUrl = TerrainSource.resolveUrl(definition.navUrl, baseUrl);
        this.meshUrl = TerrainSource.resolveUrl(definition.meshUrl, baseUrl);
        this.specificity =
            Math.pow(2, this.lodRange[1]) + this.lodRange[0];

        if (definition.textureUrl !== undefined)
            this.textureUrl =
                TerrainSource.resolveUrl(definition.textureUrl, baseUrl);

        if (definition.normalsUrl !== undefined)
            this.normalsUrl =
                TerrainSource.resolveUrl(definition.normalsUrl, baseUrl);

        Object.freeze(this.lodRange);
        Object.freeze(this);
    }

    /**
     * Validates and resolves the surface entry of a surface definition.
     *
     * Both fetched and inline definitions enter through this boundary,
     * so invalid data cannot reach the constructor.
     *
     * @param map typed map that will own the resolved source
     * @param sourceId style source id
     * @param value untrusted surface-entry JSON
     * @param baseUrl URL used to resolve relative resource templates
     * @returns immutable resolved terrain source
     */
    static fromMetadata(
        map: Map,
        sourceId: string,
        value: unknown,
        baseUrl: string,
    ): TerrainSource {

        const definition = TerrainSource.validateDefinition(sourceId, value);
        return new TerrainSource(map, sourceId, definition, baseUrl);
    }

    readonly id: string;
    readonly lodRange: TerrainSource.LodRange;
    readonly metaUrl: string;
    readonly navUrl: string;
    readonly meshUrl: string;
    readonly textureUrl?: string;
    readonly normalsUrl?: string;
    readonly specificity: number;

    /**
     * Expands the metatile URL.
     *
     * @param id metatile address
     * @param skipBaseUrl passed to the map URL expander
     * @returns resolved metatile URL
     */
    getMetaUrl(id: TerrainSource.TileId, skipBaseUrl?: boolean): string {

        return this.expandUrl(this.metaUrl, id, null, skipBaseUrl);
    }

    /**
     * Expands the navigation tile URL.
     *
     * @param id tile address
     * @param skipBaseUrl passed to the map URL expander
     * @returns resolved navigation tile URL
     */
    getNavUrl(id: TerrainSource.TileId, skipBaseUrl?: boolean): string {

        return this.expandUrl(this.navUrl, id, null, skipBaseUrl);
    }

    /**
     * Expands the mesh URL.
     *
     * @param id tile address
     * @param skipBaseUrl passed to the map URL expander
     * @returns resolved mesh URL
     */
    getMeshUrl(id: TerrainSource.TileId, skipBaseUrl?: boolean): string {

        return this.expandUrl(this.meshUrl, id, null, skipBaseUrl);
    }

    /**
     * Expands an internal texture URL.
     *
     * @param id tile address
     * @param subId submesh index selecting the texture within the tile
     * @param skipBaseUrl passed to the map URL expander
     * @returns resolved internal texture URL
     */
    getTextureUrl(
        id: TerrainSource.TileId,
        subId: number,
        skipBaseUrl?: boolean,
    ): string {

        if (this.textureUrl === undefined)
            throw new Error(
                `Terrain source "${this.id}" has no internal texture.`);

        return this.expandUrl(this.textureUrl, id, subId, skipBaseUrl);
    }

    /**
     * Expands a normal-map URL.
     *
     * @param id tile address
     * @param subId submesh index selecting the map within the tile
     * @param skipBaseUrl passed to the map URL expander
     * @returns resolved normal-map URL
     */
    getNormalsUrl(
        id: TerrainSource.TileId,
        subId: number,
        skipBaseUrl?: boolean,
    ): string {

        if (this.normalsUrl === undefined)
            throw new Error(
                `Terrain source "${this.id}" has no normal maps.`);

        return this.expandUrl(this.normalsUrl, id, subId, skipBaseUrl);
    }

    private expandUrl(
        template: string,
        id: TerrainSource.TileId,
        subId: number | null,
        skipBaseUrl?: boolean,
    ): string {

        const legacyMap = this.map_.legacyMap;

        if (!legacyMap)
            throw new Error(`Terrain source "${this.id}" cannot expand a URL `
                + `without a loaded map.`);

        return legacyMap.url.makeUrl(
            template,
            { lod: id[0], ix: id[1], iy: id[2] },
            subId,
            skipBaseUrl,
        );
    }

    /**
     * Validates untrusted metadata and extracts its supported fields.
     *
     * @param sourceId style source id used in validation errors
     * @param value surface-entry JSON
     * @returns normalized surface definition
     */
    private static validateDefinition(
        sourceId: string,
        value: unknown,
    ): TerrainSource.Definition {

        const result =
            typia.validate<TerrainSource.Definition>(value);

        if (!result.success) {

            const details = result.errors
                .map((error) => `${error.path}: expected ${error.expected}`)
                .join('; ');

            throw new Error(`Terrain source "${sourceId}" has invalid `
                + `metadata: ${details}.`);
        }

        const metadata = result.data;

        const metaUrl = metadata.metaUrl.trim();
        const navUrl = metadata.navUrl.trim();
        const meshUrl = metadata.meshUrl.trim();

        if (metaUrl === '' || navUrl === '' || meshUrl === '')
            throw new Error(`Terrain source "${sourceId}" needs a metatile, `
                + `navigation tile, and mesh URL.`);

        const textureUrl = metadata.textureUrl?.trim();
        const normalsUrl = metadata.normalsUrl?.trim();

        if (metadata.textureUrl !== undefined && textureUrl === '')
            throw new Error(`Terrain source "${sourceId}" has an empty `
                + `textureUrl.`);

        if (metadata.normalsUrl !== undefined && normalsUrl === '')
            throw new Error(`Terrain source "${sourceId}" has an empty `
                + `normalsUrl.`);

        const lodRange = metadata.lodRange;
        const tileRange = metadata.tileRange;
        const rangeValues = [
            ...lodRange,
            ...tileRange[0],
            ...tileRange[1],
        ];

        if (!rangeValues.every(
            (item) => Number.isSafeInteger(item) && item >= 0))

            throw new Error(`Terrain source "${sourceId}" ranges must contain `
                + `non-negative safe integers.`);

        if (lodRange[0] > lodRange[1])
            throw new Error(`Terrain source "${sourceId}" has a descending `
                + `lodRange.`);

        if (tileRange[0][0] > tileRange[1][0]
            || tileRange[0][1] > tileRange[1][1])

            throw new Error(`Terrain source "${sourceId}" has a descending `
                + `tileRange.`);

        // tileRange is validated because every surface definition declares
        // it, but tile presence is answered by metanodes, so nothing reads
        // it after this point
        return {
            lodRange: [lodRange[0], lodRange[1]],
            tileRange: [
                [tileRange[0][0], tileRange[0][1]],
                [tileRange[1][0], tileRange[1][1]],
            ],
            metaUrl,
            navUrl,
            meshUrl,
            textureUrl,
            normalsUrl,
        };
    }

    private static resolveUrl(urlValue: string, baseUrl: string): string {

        const trimmed = urlValue.trim();

        if (trimmed.includes('://')) return trimmed;

        if (trimmed.startsWith('//'))
            return url.utilsUrl.getSchema(baseUrl) + trimmed;

        if (trimmed.startsWith('/'))
            return url.utilsUrl.getOrigin(baseUrl) + trimmed;

        const base = baseUrl.endsWith('/')
            ? baseUrl
            : url.utilsUrl.getBase(baseUrl);

        return base + trimmed;
    }

    private readonly map_: Map;
}


namespace TerrainSource {

    export type TileId = [number, number, number];
    export type LodRange = [number, number];
    export type TileRange = [[number, number], [number, number]];

    /**
     * Supported terrain surface metadata.
     *
     * The parser accepts JSON objects with additional properties and
     * extracts only these fields.
     */
    export type Definition = {

        lodRange: LodRange;
        tileRange: TileRange;
        metaUrl: string;
        navUrl: string;
        meshUrl: string;
        textureUrl?: string;
        normalsUrl?: string;
    };
}


export default TerrainSource;
