/*
 * geodata-heightcoder.ts - transient client-side heightcoding of a
 * fixed set of geographic coordinates against the elevation store
 */

import type Map from './map';


/**
 * Heightcodes a fixed set of navigation-space coordinates against the
 * elevation store and keeps adapting as the store improves.
 *
 * The store is best-effort over the drawn view, so this never reaches a
 * terminal state. One request is in flight at a time, throttled to the
 * store's own improvement cadence; each coordinate retains its best
 * answer so far; a query that misses or fails to improve leaves the
 * retained value untouched, because the store only ever replaces a
 * value with a finer one. Whenever a coordinate's answer changes, the
 * owner is notified so it can re-heightcode and rebuild its geometry.
 *
 * A coordinate resolves -- stops being requested -- only when its
 * `actualGsd` drops below twice the requested GSD. With a requested GSD
 * of zero (monolithic geodata, which has no tile resolution) this is
 * never true, so every coordinate is refreshed for the life of the
 * layer. The resolve test is a per-coordinate optimization, not a stop
 * condition for the loop.
 *
 * The same engine drives both gate-2 consumers: the rendering path in
 * `geodata-builder.js` and the shadow comparator in
 * `elevation-store-geodata-analysis.ts`.
 */
class MapGeodataHeightcoder {

    /**
     * @param map the owning map
     * @param positions navigation-SRS XY, one per heightcoded coordinate
     * @param desiredGsd requested sample spacing in metres; zero asks
     *     for the finest available and never resolves
     * @param onUpdate called after a pass that changed one or more
     *     coordinates, with the indices that changed
     */
    constructor(
        map: Map,
        positions: readonly (readonly [number, number])[],
        desiredGsd: number,
        onUpdate: (changed: readonly number[]) => void,
    ) {

        this.map_ = map;
        this.positions_ = positions;
        this.desiredGsd_ = desiredGsd;
        this.onUpdate_ = onUpdate;

        this.samples_ = new Array(positions.length).fill(undefined);
        this.resolved_ = new Array(positions.length).fill(false);
        this.refreshCount_ = new Array(positions.length).fill(0);
    }

    /** The best sample retained for each coordinate, in input order. */
    get samples(): readonly (MapGeodataHeightcoder.Sample | undefined)[] {

        return this.samples_;
    }

    /** How many times each coordinate has taken a fresh answer. */
    get refreshCounts(): readonly number[] {

        return this.refreshCount_;
    }

    /** Whether every coordinate has resolved and no query is due. */
    get settled(): boolean {

        return this.resolved_.every((flag) => flag);
    }

    /**
     * Runs one throttled pass: submits a query for the unresolved
     * coordinates when the interval has elapsed and none is in flight.
     * Ticked from `Map.update`.
     */
    tick(): void {

        if (this.disposed_) return;
        if (this.inFlight_) return;

        const interval = this.map_.config.mapGeodataHeightcodeIntervalMs;
        const now = performance.now();

        if (now - this.lastPass_ < interval) return;

        // The columns still worth asking: those not yet resolved.
        const columns: number[] = [];

        for (let index = 0; index < this.positions_.length; index++)
            if (!this.resolved_[index]) columns.push(index);

        if (columns.length === 0) return;

        this.lastPass_ = now;
        this.inFlight_ = true;

        const query = columns.map((index) => this.positions_[index]);

        this.map_.queryTerrainElevationNav(query, this.desiredGsd_)
            .then((results) => this.absorb(columns, results),
                () => { this.inFlight_ = false; });
    }

    /** Stops the engine; a pending result is ignored. */
    dispose(): void {

        this.disposed_ = true;
    }

    /**
     * Takes one pass's results. A finer answer replaces the retained
     * sample; a miss or a coarser answer leaves it as it was. The owner
     * is told which coordinates changed.
     */
    private absorb(
        columns: readonly number[],
        results: readonly (MapGeodataHeightcoder.Sample | undefined)[],
    ): void {

        this.inFlight_ = false;
        if (this.disposed_) return;

        const changed: number[] = [];

        for (let slot = 0; slot < columns.length; slot++) {

            const index = columns[slot];
            const sample = results[slot];
            if (!sample) continue;

            const retained = this.samples_[index];

            // The store only improves: keep the finer answer, and take a
            // same-GSD answer only when its height actually moved.
            const finer = !retained || sample.actualGsd < retained.actualGsd;
            const refreshed = retained
                && sample.actualGsd === retained.actualGsd
                && sample.height !== retained.height;

            if (finer || refreshed) {

                this.samples_[index] = sample;
                this.refreshCount_[index]++;
                changed.push(index);
            }

            // A positive request lets a coordinate stop once the store
            // reaches its resolution; zero never satisfies this.
            if (this.desiredGsd_ > 0
                && sample.actualGsd < 2 * this.desiredGsd_)
                this.resolved_[index] = true;
        }

        if (changed.length > 0) this.onUpdate_(changed);
    }

    private readonly map_: Map;
    private readonly positions_: readonly (readonly [number, number])[];
    private readonly desiredGsd_: number;
    private readonly onUpdate_: (changed: readonly number[]) => void;

    private readonly samples_: (MapGeodataHeightcoder.Sample | undefined)[];
    private readonly resolved_: boolean[];
    private readonly refreshCount_: number[];

    private inFlight_ = false;
    private lastPass_ = -Infinity;
    private disposed_ = false;
}


namespace MapGeodataHeightcoder {

    /** One coordinate's navigation-space terrain answer. */
    export type Sample = {

        /** Terrain height in the navigation SRS. */
        height: number;

        /** Horizontal sample spacing that answered, in physical metres. */
        actualGsd: number;
    };
}

export default MapGeodataHeightcoder;
