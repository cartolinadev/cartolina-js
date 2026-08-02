/*
 * raster-source.ts - resolve and expose tiled-raster metadata
 */

import type Map from './map';

import typia from 'typia';

import type MapCredit from './credit';
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
     * Constructs an immutable source from validated metadata.
     *
     * @param map typed map that owns this source
     * @param sourceId style source id
     * @param definition validated source definition
     * @param baseUrl URL used to resolve relative resource templates
     */
    private constructor(
        map: Map,
        sourceId: string,
        definition: RasterSource.Definition,
        baseUrl: string,
    ) {

        this.map_ = map;
        this.id = sourceId;
        this.url = RasterSource.resolveUrl(definition.url, baseUrl);
        this.lodRange = definition.lodRange;
        this.tileRange = definition.tileRange;
        this.isTransparent = definition.isTransparent ?? false;
        this.specificity =
            Math.pow(2, this.lodRange[1]) + this.lodRange[0] + 1;
        this.credits = Array.isArray(definition.credits)
            ? [...definition.credits]
            : Object.keys(definition.credits ?? {});

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

    /**
     * Validates and resolves source-definition JSON.
     *
     * Both fetched metadata and inline style metadata enter through this
     * boundary, so invalid data cannot reach the constructor.
     *
     * @param map typed map that will own the resolved source
     * @param sourceId style source id
     * @param value untrusted source-definition JSON
     * @param baseUrl URL used to resolve relative resource templates
     * @returns immutable resolved raster source
     */
    static fromMetadata(
        map: Map,
        sourceId: string,
        value: unknown,
        baseUrl: string,
    ): RasterSource {

        const definition = RasterSource.validateDefinition(sourceId, value);
        return new RasterSource(map, sourceId, definition, baseUrl);
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
     * Classifies how this source can provide imagery for a tile.
     *
     * @param id tile address
     * @returns direct, ancestor, or no static tile-range match
     */
    matchTile(id: RasterSource.TileId): RasterSource.TileMatch {

        const shift = id[0] - this.lodRange[0];
        if (shift < 0) return RasterSource.TileMatch.None;

        const x = id[1] >> shift;
        const y = id[2] >> shift;

        if (x < this.tileRange[0][0] || x > this.tileRange[1][0]
            || y < this.tileRange[0][1] || y > this.tileRange[1][1]) {

            return RasterSource.TileMatch.None;
        }

        return id[0] > this.lodRange[1]
            ? RasterSource.TileMatch.Ancestor
            : RasterSource.TileMatch.Direct;
    }

    /**
     * Expands the tile image URL.
     *
     * @param id tile address
     * @param skipBaseUrl passed to the map URL expander
     * @returns resolved tile image URL
     */
    getUrl(id: RasterSource.TileId, skipBaseUrl?: boolean): string {

        return this.expandUrl(
            this.url,
            id,
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

        return this.expandUrl(
            this.coverage.metaUrl,
            id,
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

        return this.expandUrl(
            this.coverage.maskUrl,
            id,
            skipBaseUrl,
        );
    }

    private expandUrl(
        template: string,
        id: RasterSource.TileId,
        skipBaseUrl?: boolean,
    ): string {

        const legacyMap = this.map_.legacyMap;

        if (!legacyMap) {
            throw new Error(`Raster source "${this.id}" cannot expand a URL `
                + `without a loaded map.`);
        }

        return legacyMap.url.makeUrl(
            template,
            { lod: id[0], ix: id[1], iy: id[2] },
            null,
            skipBaseUrl,
        );
    }

    /**
     * Validates untrusted metadata and extracts its supported fields.
     *
     * @param sourceId style source id used in validation errors
     * @param value source-definition JSON
     * @returns normalized source definition
     */
    private static validateDefinition(
        sourceId: string,
        value: unknown,
    ): RasterSource.Definition {

        const result =
            typia.validate<RasterSource.Definition>(value);

        if (!result.success) {

            const details = result.errors
                .map((error) => `${error.path}: expected ${error.expected}`)
                .join('; ');

            throw new Error(`Raster source "${sourceId}" has invalid `
                + `metadata: ${details}.`);
        }

        const metadata = result.data;
        const tileUrl = metadata.url.trim();

        if (tileUrl === '') {
            throw new Error(`Raster source "${sourceId}" has no tile URL.`);
        }

        const lodRange = metadata.lodRange;
        const tileRange = metadata.tileRange;
        const rangeValues = [
            ...lodRange,
            ...tileRange[0],
            ...tileRange[1],
        ];

        if (!rangeValues.every(
            (item) => Number.isSafeInteger(item) && item >= 0)) {

            throw new Error(`Raster source "${sourceId}" ranges must contain `
                + `non-negative safe integers.`);
        }

        if (lodRange[0] > lodRange[1]) {
            throw new Error(`Raster source "${sourceId}" has a descending `
                + `lodRange.`);
        }

        if (tileRange[0][0] > tileRange[1][0]
            || tileRange[0][1] > tileRange[1][1]) {

            throw new Error(`Raster source "${sourceId}" has a descending `
                + `tileRange.`);
        }

        const metaUrl = metadata.metaUrl?.trim();
        const maskUrl = metadata.maskUrl?.trim();

        if (metadata.metaUrl !== undefined && metaUrl === '') {
            throw new Error(`Raster source "${sourceId}" has an empty `
                + `metaUrl.`);
        }

        if (metadata.maskUrl !== undefined && maskUrl === '') {
            throw new Error(`Raster source "${sourceId}" has an empty `
                + `maskUrl.`);
        }

        if (metaUrl !== undefined && maskUrl === undefined) {
            throw new Error(`Raster source "${sourceId}" provides metaUrl `
                + `without maskUrl.`);
        }

        return {
            url: tileUrl,
            lodRange: [lodRange[0], lodRange[1]],
            tileRange: [
                [tileRange[0][0], tileRange[0][1]],
                [tileRange[1][0], tileRange[1][1]],
            ],
            credits: typeof metadata.credits === 'string'
                ? undefined
                : metadata.credits,
            metaUrl,
            maskUrl,
            isTransparent: metadata.isTransparent,
        };
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

    private readonly map_: Map;
}


namespace RasterSource {

    export type TileId = [number, number, number];
    export type LodRange = [number, number];
    export type TileRange = [[number, number], [number, number]];

    export enum TileMatch {
        None,
        Ancestor,
        Direct,
    }

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
        credits?: string[] | Record<string, MapCredit.Definition>;
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
