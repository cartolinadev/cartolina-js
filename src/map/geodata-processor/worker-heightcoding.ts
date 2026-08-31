/*
 * worker-heightcoding.ts - retain and rebuild client-heightcoded geodata
 */

import proj4 from 'proj4';


/**
 * The worker-side registry of retained heightcoding jobs, keyed by job id.
 *
 * `register` parses one payload, converts each coordinate to its store
 * position, and returns those positions to the main thread. `apply` writes
 * the heights the main thread sends back and rebuilds the geometry; `get`
 * returns an already-built job for a view rebuild. This owns the parsed
 * geodata for the payload's lifetime; the main thread owns only the heights.
 */
class WorkerHeightcodingJobs {

    /**
     * Retains one parsed payload and returns its store coordinates.
     *
     * @param request job identity and coordinate definitions
     * @param geodata parsed geodata object
     * @param renderState tile-dependent worker state
     * @returns coordinate registration, or null when nothing needs heightcoding
     */
    register(
        request: WorkerHeightcodingJobs.Request,
        geodata: Geodata,
        renderState: WorkerHeightcodingJobs.RenderState,
    ): WorkerHeightcodingJobs.Registration | null {

        const spatial = request.coordinateSpace === 'spatial-division';
        const targetSrs = spatial ? request.node!.srs : request.navigationSrs;
        const toTarget = proj4(request.physicalSrs, targetSrs);
        const toPhysical = proj4(targetSrs, request.physicalSrs);
        const positions: number[] = [];
        const groups: GroupRecord[] = [];

        for (const group of geodata.groups ?? []) {

            const records: CoordinateRecord[] = [];
            const metadata = group.heightcoding;
            const physical = readPhysicalCoordinates(group);
            let coordinateIndex = 0;

            visitCoordinates(group, (target, offset) => {

                const original = physical[coordinateIndex];
                const supplied = metadata?.[coordinateIndex];

                coordinateIndex++;

                let source: number[] | null = null;
                let heightOffset = 0;

                // Tiled coordinates, and monolithic ones with no builder
                // entries, heightcode from the group's own geometry.
                if (spatial || !metadata)
                    source = toTarget.forward(original);

                // A builder entry carries the coordinate's source
                // position and its authored height above terrain; a null
                // entry keeps the delivered height.
                if (!spatial && supplied) {

                    source = supplied;
                    heightOffset = supplied[2];
                }

                const sampleIndex = source ? positions.length / 2 : -1;

                if (source) positions.push(source[0], source[1]);

                records.push({
                    target,
                    offset,
                    original: source ? null : original,
                    source,
                    heightOffset,
                    sampleIndex,
                });
            });

            delete group.heightcoding;
            groups.push({ group, records });
        }

        if (positions.length === 0) return null;

        const job: Job = {
            geodata,
            builtGeodata: geodata,
            groups,
            heights: new Float64Array(positions.length / 2).fill(NaN),
            initialized: false,
            revision: 0,
            renderState,
            toPhysical,
        };

        this.jobs_.set(request.jobId, job);

        return {
            jobId: request.jobId,
            coordinateSpace: request.coordinateSpace,
            positions: new Float64Array(positions),
        };
    }

    /** Applies changed heights and requantizes the retained geometry. */
    apply(update: WorkerHeightcodingJobs.Update): Job | null {

        const job = this.jobs_.get(update.jobId);
        if (!job || update.revision <= job.revision) return null;

        for (let index = 0; index < update.indices.length; index++)
            job.heights[update.indices[index]] = update.heights[index];

        job.revision = update.revision;

        if (!rebuild(job)) return null;

        job.initialized = true;
        return job;
    }

    /** Returns retained geometry for a view rebuild. */
    get(jobId: number): Job | null {

        const job = this.jobs_.get(jobId);
        return job?.initialized ? job : null;
    }

    /** Releases one retained parsed payload. */
    release(jobId: number): void {

        this.jobs_.delete(jobId);
    }

    private readonly jobs_ = new Map<number, Job>();
}


type Geodata = {
    groups?: GeodataGroup[];
};


type GeodataGroup = {
    bbox: [number[], number[]];
    resolution?: number;
    points?: { points?: number[][] }[];
    lines?: { lines?: number[][][] }[];
    polygons?: { vertices?: number[] }[];
    heightcoding?: ([number, number, number] | null)[];
};


type CoordinateRecord = {
    target: number[];
    offset: number;
    original: number[] | null;
    source: number[] | null;
    heightOffset: number;
    sampleIndex: number;
};


type GroupRecord = {
    group: GeodataGroup;
    records: CoordinateRecord[];
};


type Job = {

    /** Full parsed payload, kept so a later update can place a group
     * a build skipped. */
    geodata: Geodata;

    /** The subset of `geodata`'s groups published last, those with a
     * store height. */
    builtGeodata: Geodata;

    /** Per-group records mapping each vertex to its store coordinate and
     * height slot. */
    groups: GroupRecord[];

    /** Latest store height per sample coordinate; NaN until answered. */
    heights: Float64Array;

    /** Whether a build has produced publishable geometry at least once. */
    initialized: boolean;

    /** Highest update revision applied; a lower one is ignored. */
    revision: number;

    /** Tile-dependent render state replayed on each publish. */
    renderState: WorkerHeightcodingJobs.RenderState;

    /** Converts a store coordinate and height to a physical position. */
    toPhysical: proj4.Converter;
};


function readPhysicalCoordinates(group: GeodataGroup): number[][] {

    const bbox = group.bbox;
    const resolution = group.resolution ?? 4096;
    const scale = [
        (bbox[1][0] - bbox[0][0]) / resolution,
        (bbox[1][1] - bbox[0][1]) / resolution,
        (bbox[1][2] - bbox[0][2]) / resolution,
    ];
    const result: number[][] = [];

    visitCoordinates(group, (target, offset) => result.push([
        bbox[0][0] + target[offset] * scale[0],
        bbox[0][1] + target[offset + 1] * scale[1],
        bbox[0][2] + target[offset + 2] * scale[2],
    ]));

    return result;
}


/**
 * Requantizes every group the store can place and records them as the
 * job's built geodata.
 *
 * @returns whether any group was built
 */
function rebuild(job: Job): boolean {

    const built: GeodataGroup[] = [];

    for (const { group, records } of job.groups) {

        if (records.length === 0) continue;

        const heights = groupHeights(job, records);

        // A group with no store height at all lies entirely outside the
        // terrain the traversal has drawn, and so entirely off screen.
        // It is left out of this build and enters a later one once the
        // store covers it.
        if (!heights) continue;

        built.push(group);

        const physical = records.map((record, index) => {

            if (record.sampleIndex < 0) return record.original!;

            return job.toPhysical.forward([
                record.source![0],
                record.source![1],
                heights[index] + record.heightOffset,
            ]);
        });

        const minimum = physical[0].slice();
        const maximum = physical[0].slice();

        for (const point of physical)
            for (let axis = 0; axis < 3; axis++) {

                minimum[axis] = Math.min(minimum[axis], point[axis]);
                maximum[axis] = Math.max(maximum[axis], point[axis]);
            }

        const resolution = group.resolution ?? 4096;
        const scale = [
            resolution / (maximum[0] - minimum[0] + 1),
            resolution / (maximum[1] - minimum[1] + 1),
            resolution / (maximum[2] - minimum[2] + 1),
        ];

        for (let index = 0; index < records.length; index++) {

            const record = records[index];
            const point = physical[index];

            for (let axis = 0; axis < 3; axis++)
                record.target[record.offset + axis] = Math.round(
                    (point[axis] - minimum[axis]) * scale[axis]);
        }

        group.bbox = [minimum, maximum];
    }

    job.builtGeodata = { ...job.geodata, groups: built };
    return built.length > 0;
}


/**
 * Store heights for one group's records, in record order.
 *
 * A coordinate the store has no height for takes the height of the
 * nearest coordinate that has one. Record order follows the geometry,
 * so a line running out of the store's coverage carries on at the
 * height it had where the coverage ended. Such a coordinate is off
 * screen, and it gets a measured height once the store covers it.
 *
 * @returns null when the group has no store height at all
 */
function groupHeights(
    job: Job,
    records: readonly CoordinateRecord[],
): Float64Array | null {

    const heights = new Float64Array(records.length).fill(NaN);
    let carried = NaN;
    let answered = false;

    for (let index = 0; index < records.length; index++) {

        const sample = records[index].sampleIndex;
        if (sample < 0) continue;

        const height = job.heights[sample];

        if (!Number.isNaN(height)) {

            carried = height;
            answered = true;
        }

        heights[index] = carried;
    }

    if (!answered) return null;

    // The records before the first answer had nothing to carry, so they
    // take the first answer that follows them.
    carried = NaN;

    for (let index = records.length - 1; index >= 0; index--) {

        if (records[index].sampleIndex < 0) continue;

        if (Number.isNaN(heights[index])) heights[index] = carried;
        else carried = heights[index];
    }

    return heights;
}


function visitCoordinates(
    group: GeodataGroup,
    visit: (target: number[], offset: number) => void,
): void {

    for (const feature of group.points ?? [])
        for (const point of feature.points ?? []) visit(point, 0);

    for (const feature of group.lines ?? [])
        for (const line of feature.lines ?? [])
            for (const point of line) visit(point, 0);

    for (const feature of group.polygons ?? []) {

        const vertices = feature.vertices ?? [];

        for (let index = 0; index + 2 < vertices.length; index += 3)
            visit(vertices, index);
    }
}


namespace WorkerHeightcodingJobs {

    export type Request = {
        jobId: number;
        coordinateSpace: 'geographic' | 'spatial-division';
        physicalSrs: string;
        navigationSrs: string;
        node?: {
            id: readonly number[];
            extents: { ll: number[]; ur: number[] };
            srs: string;
        };
    };

    export type RenderState = {
        lod: number;
        ix: number;
        iy: number;
        tileSize: number;
        pixelSize: number;
        dpr: number;
    };

    export type Registration = {
        jobId: number;
        coordinateSpace: 'geographic' | 'spatial-division';
        positions: Float64Array;
    };

    export type Update = {
        jobId: number;
        revision: number;
        indices: Uint32Array;
        heights: Float64Array;
    };
}


export default WorkerHeightcodingJobs;
