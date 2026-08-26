/**
 * Public type surface for `geodata-builder.js`.
 *
 * `MapGeodataBuilder` is the vector-overlay builder returned by
 * `Map.createGeodata()` / `Viewer.createGeodata()`. An application adds
 * geometry, heightcodes any `'float'` coordinates against the terrain,
 * and turns the result into a free-layer source. Only the public surface
 * is declared here; the heightcoding engine plumbing and geometry
 * internals stay untyped inside the module.
 */

/** How a coordinate's Z is interpreted. */
export type GeodataHeightMode = 'float' | 'fix';

/** A 2D or 3D coordinate: [x, y] or [x, y, z]. */
export type GeodataCoord = readonly number[];

/** Feature properties carried into the style filter and labels. */
export type GeodataProperties = Record<string, unknown> | null;

/** A source SRS, or null for the map's navigation SRS. */
export type GeodataSrs = unknown;

/** Extracted geometry, as returned by `extractGeometry`. */
export interface GeodataGeometry {

    /** Surface area of a polygon geometry, in square metres. */
    getSurfaceArea(): number;
}

/**
 * Builds a vector overlay and heightcodes it against the terrain.
 *
 * Geometry adders return the builder for chaining. A `'float'`
 * coordinate carries a height above the terrain surface; `processHeights`
 * resolves those through the elevation store and keeps refining them as
 * the terrain loads.
 */
export default class MapGeodataBuilder {

    /** Starts a new named group; subsequent adds target it. */
    addGroup(id: string): this;

    /** Adds one point feature. */
    addPoint(
        point: GeodataCoord,
        heightMode?: GeodataHeightMode | null,
        properties?: GeodataProperties,
        id?: string,
        srs?: GeodataSrs,
        directCopy?: boolean,
    ): this;

    /** Adds a multi-point feature. */
    addPointArray(
        points: readonly GeodataCoord[],
        heightMode?: GeodataHeightMode | null,
        properties?: GeodataProperties,
        id?: string,
        srs?: GeodataSrs,
        directCopy?: boolean,
    ): this;

    /** Adds one line-string feature. */
    addLineString(
        linePoints: readonly GeodataCoord[],
        heightMode?: GeodataHeightMode | null,
        properties?: GeodataProperties,
        id?: string,
        srs?: GeodataSrs,
        directCopy?: boolean,
    ): this;

    /** Adds a multi-line feature. */
    addLineStringArray(
        lines: readonly (readonly GeodataCoord[])[],
        heightMode?: GeodataHeightMode | null,
        properties?: GeodataProperties,
        id?: string,
        srs?: GeodataSrs,
        directCopy?: boolean,
    ): this;

    /** Adds one polygon feature (outer shape plus optional holes). */
    addPolygon(
        shape: readonly GeodataCoord[],
        holes?: readonly (readonly GeodataCoord[])[],
        middle?: GeodataCoord | null,
        heightMode?: GeodataHeightMode | null,
        properties?: GeodataProperties,
        id?: string,
        srs?: GeodataSrs,
        tesselation?: unknown,
    ): this;

    /** Adds one polygon feature (triangulated variant). */
    addPolygon3(
        shape: readonly GeodataCoord[],
        holes?: readonly (readonly GeodataCoord[])[],
        middle?: GeodataCoord | null,
        heightMode?: GeodataHeightMode | null,
        properties?: GeodataProperties,
        id?: string,
        srs?: GeodataSrs,
        tesselation?: unknown,
    ): this;

    /** Imports features from VTS geodata JSON. */
    importVTSGeodata(
        json: unknown,
        groupIdPrefix?: string,
        dontCreateGroups?: boolean,
    ): this;

    /** Imports features from GeoJSON. */
    importGeoJson(
        json: unknown,
        heightMode?: GeodataHeightMode | null,
        srs?: GeodataSrs,
        options?: unknown,
    ): this;

    /**
     * Heightcodes every `'float'` coordinate against the terrain for a
     * consumer that reads the geometry directly rather than rendering a
     * free layer (the measure tool). A rendered layer does not need this:
     * `makeFreeLayer` heightcodes on its own, because `'float'` already
     * declares that terrain height is wanted.
     *
     * Returns at once; the library owns the refresh. There is no terminal
     * state -- a better terrain value can arrive at any time, including
     * after a camera move.
     *
     * @param onRefine optional, called after each refinement with this
     *     builder, so the consumer can re-read the geometry
     */
    processHeights(
        onRefine?: (builder: MapGeodataBuilder) => void,
    ): void;

    /** Stops the heightcoder, if one is running. */
    stopHeightcoding(): void;

    /** Serializes the current geometry to a VTS geodata object. */
    makeGeodata(resolution?: number): Record<string, unknown>;

    /**
     * Builds a monolithic geodata free-layer definition from the current
     * geometry, for `addSource({ type: 'cartolina-freelayer', ... })`.
     * While heightcoding is active the layer stays bound to this builder
     * and refines as the store improves.
     */
    makeFreeLayer(
        style?: unknown,
        resolution?: number,
        geodata?: unknown,
    ): Record<string, unknown>;

    /** Extracts one feature's geometry by id, for measurement. */
    extractGeometry(id: string): GeodataGeometry;
}
