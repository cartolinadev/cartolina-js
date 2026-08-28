/**
 * Public type surface for `geodata-builder.js`.
 *
 * `MapGeodataBuilder` is the vector-overlay builder returned by
 * `Map.createGeodata()` / `Viewer.createGeodata()`. An application adds
 * geometry and turns the result into a free-layer source. Rendered
 * `'float'` coordinates are heightcoded by their geodata view.
 */

/**
 * Builds a vector overlay.
 *
 * Geometry adders return the builder for chaining. A `'float'`
 * coordinate carries a height above the terrain surface.
 */
export default class MapGeodataBuilder {

    /** Starts a new named group; subsequent adds target it. */
    addGroup(id: string): this;

    /** Adds one point feature. */
    addPoint(
        point: MapGeodataBuilder.Coord,
        heightMode?: MapGeodataBuilder.HeightMode | null,
        properties?: MapGeodataBuilder.Properties,
        id?: string,
        srs?: MapGeodataBuilder.Srs,
        directCopy?: boolean,
    ): this;

    /** Adds a multi-point feature. */
    addPointArray(
        points: readonly MapGeodataBuilder.Coord[],
        heightMode?: MapGeodataBuilder.HeightMode | null,
        properties?: MapGeodataBuilder.Properties,
        id?: string,
        srs?: MapGeodataBuilder.Srs,
        directCopy?: boolean,
    ): this;

    /** Adds one line-string feature. */
    addLineString(
        linePoints: readonly MapGeodataBuilder.Coord[],
        heightMode?: MapGeodataBuilder.HeightMode | null,
        properties?: MapGeodataBuilder.Properties,
        id?: string,
        srs?: MapGeodataBuilder.Srs,
        directCopy?: boolean,
    ): this;

    /** Adds a multi-line feature. */
    addLineStringArray(
        lines: readonly (readonly MapGeodataBuilder.Coord[])[],
        heightMode?: MapGeodataBuilder.HeightMode | null,
        properties?: MapGeodataBuilder.Properties,
        id?: string,
        srs?: MapGeodataBuilder.Srs,
        directCopy?: boolean,
    ): this;

    /** Adds one polygon feature (outer shape plus optional holes). */
    addPolygon(
        shape: readonly MapGeodataBuilder.Coord[],
        holes?: readonly (readonly MapGeodataBuilder.Coord[])[],
        middle?: MapGeodataBuilder.Coord | null,
        heightMode?: MapGeodataBuilder.HeightMode | null,
        properties?: MapGeodataBuilder.Properties,
        id?: string,
        srs?: MapGeodataBuilder.Srs,
        tesselation?: unknown,
    ): this;

    /** Adds one polygon feature (triangulated variant). */
    addPolygon3(
        shape: readonly MapGeodataBuilder.Coord[],
        holes?: readonly (readonly MapGeodataBuilder.Coord[])[],
        middle?: MapGeodataBuilder.Coord | null,
        heightMode?: MapGeodataBuilder.HeightMode | null,
        properties?: MapGeodataBuilder.Properties,
        id?: string,
        srs?: MapGeodataBuilder.Srs,
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
        heightMode?: MapGeodataBuilder.HeightMode | null,
        srs?: MapGeodataBuilder.Srs,
        options?: unknown,
    ): this;

    /** Serializes the current geometry to a VTS geodata object. */
    makeGeodata(resolution?: number): Record<string, unknown>;

    /**
     * Builds a monolithic geodata free-layer definition from the current
     * geometry, for `addSource({ type: 'cartolina-freelayer', ... })`.
     * Floating source coordinates are retained in the serialized data so
     * the view can heightcode them.
     */
    makeFreeLayer(
        style?: unknown,
        resolution?: number,
        geodata?: unknown,
    ): Record<string, unknown>;

    /** Extracts one feature's geometry by id, for measurement. */
    extractGeometry(id: string): MapGeodataBuilder.Geometry;
}


export namespace MapGeodataBuilder {

    /** How a coordinate's Z is interpreted. */
    export type HeightMode = 'float' | 'fix';

    /** A 2D or 3D coordinate: [x, y] or [x, y, z]. */
    export type Coord = readonly number[];

    /** Feature properties carried into style filters and labels. */
    export type Properties = Record<string, unknown> | null;

    /** A source SRS, or null for the map's navigation SRS. */
    export type Srs = unknown;

    /** Extracted geometry returned by `extractGeometry`. */
    export type Geometry = {

        /** Surface area of a polygon geometry, in square metres. */
        getSurfaceArea(): number;
    };
}
