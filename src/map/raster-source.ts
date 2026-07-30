/*
 * raster-source.ts - resolve and expose tiled-raster metadata
 */

import type LegacyMap from './legacy-map';

import MapCredit from './credit';
import * as url from '../utils/url';


/**
 * A resolved `cartolina-tms` source owned by `Map`.
 *
 * Construction extracts the supported metadata into immutable state.
 * Metadata retrieval failures are stored by `Map`, so every instance is
 * complete and ready for tile URL and coverage queries.
 */
class RasterSource {

    /**
     * Resolves and normalizes one raster source definition.
     *
     * @param map owning map data object
     * @param sourceId style source id
     * @param value source-definition JSON
     * @param baseUrl URL used to resolve relative resource templates
     */
    constructor(
        map: LegacyMap,
        sourceId: string,
        value: unknown,
        baseUrl: string,
    ) {

        const definition = parseDefinition(sourceId, value);

        this.map_ = map;
        this.id = sourceId;
        this.url = RasterSource.resolveUrl(definition.url, baseUrl);
        this.lodRange = definition.lodRange;
        this.tileRange = definition.tileRange;
        this.isTransparent = definition.isTransparent ?? false;
        this.specificity =
            Math.pow(2, this.lodRange[1]) + this.lodRange[0] + 1;
        this.credits = this.registerCredits(definition.credits);

        if (definition.metaUrl && definition.maskUrl) {

            this.coverage = {
                metaUrl: RasterSource.resolveUrl(
                    definition.metaUrl, baseUrl),
                maskUrl: RasterSource.resolveUrl(
                    definition.maskUrl, baseUrl),
            };
            Object.freeze(this.coverage);
        }

        Object.freeze(this.lodRange);
        Object.freeze(this.tileRange[0]);
        Object.freeze(this.tileRange[1]);
        Object.freeze(this.tileRange);
        Object.freeze(this.credits);
        Object.freeze(this);
    }

    readonly id: string;
    readonly url: string;
    readonly lodRange: RasterSource.LodRange;
    readonly tileRange: RasterSource.TileRange;
    readonly credits: string[];
    readonly specificity: number;
    readonly isTransparent: boolean;
    readonly coverage?: RasterSource.Coverage;

    /**
     * Tests a tile against the source range.
     *
     * @param id tile address
     * @returns zero outside the range, one for ancestor influence, or two
     *   when the tile itself is available
     */
    hasTileOrInfluence(id: RasterSource.TileId): 0 | 1 | 2 {

        const shift = id[0] - this.lodRange[0];
        if (shift < 0) return 0;

        const x = id[1] >> shift;
        const y = id[2] >> shift;

        if (x < this.tileRange[0][0] || x > this.tileRange[1][0]
            || y < this.tileRange[0][1] || y > this.tileRange[1][1]) {

            return 0;
        }

        return id[0] > this.lodRange[1] ? 1 : 2;
    }

    /**
     * Expands the tile image URL.
     *
     * @param id tile address
     * @param skipBaseUrl passed to the map URL expander
     * @returns resolved tile image URL
     */
    getUrl(id: RasterSource.TileId, skipBaseUrl?: boolean): string {

        return this.map_.url.makeUrl(
            this.url,
            { lod: id[0], ix: id[1], iy: id[2] },
            null,
            skipBaseUrl,
        );
    }

    /**
     * Expands the coverage metatile URL.
     *
     * @param id metatile address
     * @param skipBaseUrl passed to the map URL expander
     * @returns resolved metatile URL
     */
    getMetatileUrl(
        id: RasterSource.TileId,
        skipBaseUrl?: boolean,
    ): string {

        if (!this.coverage) {
            throw new Error(
                `Raster source "${this.id}" has no coverage.`);
        }

        return this.map_.url.makeUrl(
            this.coverage.metaUrl,
            { lod: id[0], ix: id[1], iy: id[2] },
            null,
            skipBaseUrl,
        );
    }

    /**
     * Expands a per-tile coverage-mask URL.
     *
     * @param id tile address
     * @param skipBaseUrl passed to the map URL expander
     * @returns resolved mask URL
     */
    getMaskUrl(
        id: RasterSource.TileId,
        skipBaseUrl?: boolean,
    ): string {

        if (!this.coverage) {
            throw new Error(
                `Raster source "${this.id}" has no coverage.`);
        }

        return this.map_.url.makeUrl(
            this.coverage.maskUrl,
            { lod: id[0], ix: id[1], iy: id[2] },
            null,
            skipBaseUrl,
        );
    }

    private registerCredits(
        credits: RasterSource.Definition['credits'],
    ): string[] {

        if (Array.isArray(credits)) {

            return credits.filter(
                (credit): credit is string => typeof credit === 'string');
        }

        if (!credits) return [];

        const ids: string[] = [];
        const resolved: Array<[string, MapCredit]> = [];

        for (const [id, definition] of Object.entries(credits)) {

            ids.push(id);
            resolved.push([
                id, new MapCredit(this.map_, definition),
            ]);
        }

        for (const [id, credit] of resolved) {

            this.map_.addCredit(id, credit);
        }

        return ids;
    }

    private static resolveUrl(urlValue: string, baseUrl: string): string {

        const trimmed = urlValue.trim();

        if (trimmed.includes('://')) return trimmed;

        if (trimmed.startsWith('//')) {

            return url.utilsUrl.getSchema(baseUrl) + trimmed;
        }

        if (trimmed.startsWith('/')) {

            return url.utilsUrl.getOrigin(baseUrl) + trimmed;
        }

        const base = baseUrl.endsWith('/')
            ? baseUrl
            : url.utilsUrl.getBase(baseUrl);

        return base + trimmed;
    }

    private readonly map_: LegacyMap;
}


function isNumberPair(value: unknown): value is [number, number] {

    return Array.isArray(value)
        && value.length === 2
        && value.every((item) => typeof item === 'number');
}


function parseDefinition(
    sourceId: string,
    value: unknown,
): RasterSource.Definition {

    if (value === null || typeof value !== 'object'
        || Array.isArray(value)) {

        throw new Error(`Raster source "${sourceId}" definition is not `
            + `an object.`);
    }

    const definition = value as Record<string, unknown>;
    const tileUrl = definition.url;
    const lodRange = definition.lodRange;
    const tileRange = definition.tileRange;

    if (typeof tileUrl !== 'string' || tileUrl.trim() === '') {

        throw new Error(`Raster source "${sourceId}" has no tile URL.`);
    }

    if (!isNumberPair(lodRange)) {

        throw new Error(`Raster source "${sourceId}" has an invalid `
            + `lodRange.`);
    }

    if (!Array.isArray(tileRange)
        || tileRange.length !== 2
        || !isNumberPair(tileRange[0])
        || !isNumberPair(tileRange[1])) {

        throw new Error(`Raster source "${sourceId}" has an invalid `
            + `tileRange.`);
    }

    const metaUrl = definition.metaUrl;
    const maskUrl = definition.maskUrl;

    if (metaUrl !== undefined
        && (typeof metaUrl !== 'string' || metaUrl.trim() === '')) {

        throw new Error(`Raster source "${sourceId}" has an invalid `
            + `metaUrl.`);
    }

    if (maskUrl !== undefined
        && (typeof maskUrl !== 'string' || maskUrl.trim() === '')) {

        throw new Error(`Raster source "${sourceId}" has an invalid `
            + `maskUrl.`);
    }

    if (metaUrl !== undefined && maskUrl === undefined) {

        throw new Error(`Raster source "${sourceId}" provides metaUrl `
            + `without maskUrl.`);
    }

    const credits = definition.credits;

    if (credits !== undefined
        && typeof credits !== 'string'
        && !Array.isArray(credits)
        && (credits === null || typeof credits !== 'object')) {

        throw new Error(
            `Raster source "${sourceId}" has invalid credits.`);
    }

    const isTransparent = definition.isTransparent;

    if (isTransparent !== undefined
        && typeof isTransparent !== 'boolean') {

        throw new Error(`Raster source "${sourceId}" has an invalid `
            + `isTransparent value.`);
    }

    return {
        url: tileUrl,
        lodRange: [...lodRange],
        tileRange: [
            [...tileRange[0]],
            [...tileRange[1]],
        ],
        credits: typeof credits === 'string'
            ? undefined
            : credits as RasterSource.Definition['credits'],
        metaUrl,
        maskUrl,
        isTransparent,
    };
}


namespace RasterSource {

    export type TileId = [number, number, number];
    export type LodRange = [number, number];
    export type TileRange = [[number, number], [number, number]];

    /**
     * Supported `cartolina-tms` source metadata.
     *
     * The parser accepts JSON objects with additional properties and
     * extracts only these fields.
     */
    export type Definition = {

        url: string;
        lodRange: LodRange;
        tileRange: TileRange;
        credits?: string[] | Record<string, Record<string, unknown>>;
        metaUrl?: string;
        maskUrl?: string;
        isTransparent?: boolean;
    };

    export type Coverage = {

        metaUrl: string;
        maskUrl: string;
    };
}


export default RasterSource;
