/*
 * elevation-store-geodata-analysis.ts - RFC 13 gate 2 shadow diagnostic
 *
 * Re-heightcodes every delivered geodata coordinate through the
 * elevation store and reports how the client height compares to the
 * server height baked into the tile. It changes no rendering: it is the
 * validation that the client can replace server-side heightcoding.
 *
 * The same transient engine that renders client-heightcoded geometry
 * drives this; here it feeds a comparator instead of a rebuild. Switching
 * tiled geodata off server heightcoding later reuses this collection and
 * engine and swaps the comparator for the render binding.
 */

import type Map from './map';
import type MapGeodataHeightcoder from './geodata-heightcoder';


/**
 * Collects delivered geodata coordinates tile by tile, heightcodes them
 * against the store, and publishes a running client-minus-server height
 * distribution. Owned by `Map`, active only while
 * `debugElevationStoreGeodataShadow` is set.
 */
class ElevationStoreGeodataAnalysis {

    /**
     * @param map the owning map
     */
    constructor(map: Map) {

        this.map_ = map;
    }

    /**
     * Takes one delivered tiled-geodata payload. Parses its coordinates,
     * records each delivered server height, and starts a heightcoder that
     * re-heightcodes them through the store. Ignores anything but a
     * parseable JSON geodata object.
     *
     * @param geodata the geodata the view holds: a JSON string or the
     *     already-parsed object; a binary payload is skipped
     */
    collect(geodata: unknown): void {

        const parsed = parseGeodata(geodata);

        if (!parsed) {

            this.warnBinaryOnce();
            return;
        }

        const legacy = this.map_.map as Any;
        if (!legacy) return;

        const navSrs = legacy.getNavigationSrs();
        const physSrs = legacy.getPhysicalSrs();

        const positions: [number, number][] = [];
        const serverHeights: number[] = [];

        // Every delivered coordinate is physical; convert to navigation
        // to obtain the lookup XY and the delivered server height, then
        // drop the height from the query input.
        for (const physical of collectPhysicalCoords(parsed)) {

            const nav = navSrs.convertCoordsFrom(physical, physSrs);

            positions.push([nav[0], nav[1]]);
            serverHeights.push(nav[2]);
        }

        if (positions.length === 0) return;

        const entry: Entry = { serverHeights, coder: null };

        // Query the finest available (GSD zero) and record whatever
        // actualGsd the store returns. Requesting the tile's own
        // resolution instead is an optimization deferred here.
        entry.coder = this.map_.createGeodataHeightcoder(
            positions, 0, () => this.publish());

        this.entries_.push(entry);
    }

    /** Stops every heightcoder and clears the accumulated state. */
    dispose(): void {

        for (const entry of this.entries_)
            if (entry.coder) this.map_.disposeGeodataHeightcoder(entry.coder);

        this.entries_ = [];
    }

    /**
     * Recomputes the report from every entry's current samples and
     * publishes it, throttled. Called on each heightcoder refinement.
     */
    private publish(): void {

        const now = performance.now();
        if (now - this.lastPublish_ < PublishIntervalMs) return;
        this.lastPublish_ = now;

        const differences: number[] = [];
        const gsds: number[] = [];

        let total = 0;
        let covered = 0;
        let refreshes = 0;

        for (const entry of this.entries_) {

            const coder = entry.coder;
            if (!coder) continue;

            const samples = coder.samples;
            const counts = coder.refreshCounts;

            for (let index = 0; index < samples.length; index++) {

                total++;
                refreshes += counts[index];

                const sample = samples[index];
                if (!sample) continue;

                covered++;
                gsds.push(sample.actualGsd);
                differences.push(sample.height - entry.serverHeights[index]);
            }
        }

        const report: Report = {
            coordinates: total,
            covered,
            coverage: total > 0 ? covered / total : 0,
            refreshes,
            actualGsd: summarize(gsds),
            clientMinusServer: summarize(differences),
        };

        (globalThis as Any).__elevationStoreGeodataShadow = report;

        console.log('[elevation-store shadow] client - server height (m):',
            report.clientMinusServer,
            `coverage ${(report.coverage * 100).toFixed(1)}%`,
            `(${covered}/${total})`, 'GSD (m):', report.actualGsd);
    }

    /** Warns once that binary geodata cannot be shadowed. */
    private warnBinaryOnce(): void {

        if (this.warnedBinary_) return;
        this.warnedBinary_ = true;

        console.warn('[elevation-store shadow] geodata is not a parseable '
            + 'JSON object; set mapGeodataBinaryLoad false to shadow it.');
    }

    private readonly map_: Map;
    private entries_: Entry[] = [];
    private lastPublish_ = -Infinity;
    private warnedBinary_ = false;
}


/** Loosely-typed access to legacy JS structures at the boundary. */
type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any


/** One delivered tile's server heights and the engine refining them. */
type Entry = {
    serverHeights: number[];
    coder: MapGeodataHeightcoder | null;
};


/** One distribution: the fields RFC 13 gate 2 records. */
type Summary = {
    count: number;
    mean: number;
    std: number;
    p50: number;
    p90: number;
    p99: number;
    min: number;
    max: number;
};


/** The published report. */
type Report = {
    coordinates: number;
    covered: number;
    coverage: number;
    refreshes: number;
    actualGsd: Summary;
    clientMinusServer: Summary;
};


/** Milliseconds between report publishes. */
const PublishIntervalMs = 1000;


/**
 * Parses the delivered geodata into its group object, or returns null
 * when it is not a plain JSON payload (a binary buffer).
 */
function parseGeodata(geodata: unknown): Any {

    if (typeof geodata === 'string') {

        try {

            return JSON.parse(geodata);

        } catch (error) {

            return null;
        }
    }

    if (geodata && typeof geodata === 'object'
        && Array.isArray((geodata as Any).groups))
        return geodata;

    return null;
}


/**
 * Walks a delivered geodata object and yields every coordinate in
 * physical space, dequantized against each group's bbox and resolution
 * exactly as `geodata-import/vts-geodata.js` does.
 */
function* collectPhysicalCoords(
    parsed: Any,
): Generator<[number, number, number]> {

    for (const group of parsed.groups ?? []) {

        const bbox = group.bbox;
        const resolution = group.resolution;

        if (!bbox || !resolution || !bbox[0] || !bbox[1]) continue;

        const min = bbox[0];
        const max = bbox[1];

        const fx = (max[0] - min[0]) / resolution;
        const fy = (max[1] - min[1]) / resolution;
        const fz = (max[2] - min[2]) / resolution;

        const real = (point: Any): [number, number, number] => [
            min[0] + point[0] * fx,
            min[1] + point[1] * fy,
            min[2] + point[2] * fz,
        ];

        for (const feature of group.points ?? [])
            for (const point of feature.points ?? [])
                yield real(point);

        for (const feature of group.lines ?? [])
            for (const line of feature.lines ?? [])
                for (const point of line)
                    yield real(point);

        // Polygon vertices are one flat [x, y, z, x, y, z, ...] array.
        for (const feature of group.polygons ?? []) {

            const vertices = feature.vertices ?? [];

            for (let index = 0; index + 2 < vertices.length; index += 3)
                yield real([
                    vertices[index],
                    vertices[index + 1],
                    vertices[index + 2],
                ]);
        }
    }
}


/** Reduces a sample set to the distribution RFC 13 gate 2 records. */
function summarize(values: number[]): Summary {

    const count = values.length;

    if (count === 0)
        return { count: 0, mean: 0, std: 0, p50: 0, p90: 0, p99: 0,
            min: 0, max: 0 };

    const sorted = values.slice().sort((a, b) => a - b);

    let sum = 0;
    for (const value of sorted) sum += value;
    const mean = sum / count;

    let variance = 0;
    for (const value of sorted) variance += (value - mean) ** 2;
    const std = Math.sqrt(variance / count);

    const percentile = (fraction: number): number =>
        sorted[Math.min(count - 1, Math.floor(fraction * count))];

    return {
        count,
        mean,
        std,
        p50: percentile(0.50),
        p90: percentile(0.90),
        p99: percentile(0.99),
        min: sorted[0],
        max: sorted[count - 1],
    };
}


export default ElevationStoreGeodataAnalysis;
