/*
 * worker-heightcoding.ts - retain and rebuild client-heightcoded geodata
 */

import proj4 from 'proj4';


/** Owns parsed geodata retained for elevation-store heightcoding. */
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
                    original,
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
            groups,
            heights: new Float64Array(positions.length / 2).fill(NaN),
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
        rebuild(job);
        return job;
    }

    /** Returns retained geometry for a view rebuild. */
    get(jobId: number): Job | null {

        return this.jobs_.get(jobId) ?? null;
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
    original: number[];
    source: number[] | null;
    heightOffset: number;
    sampleIndex: number;
};


type GroupRecord = {
    group: GeodataGroup;
    records: CoordinateRecord[];
};


type Job = {
    geodata: Geodata;
    groups: GroupRecord[];
    heights: Float64Array;
    revision: number;
    renderState: WorkerHeightcodingJobs.RenderState;
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


function rebuild(job: Job): void {

    for (const { group, records } of job.groups) {

        if (records.length === 0) continue;

        const physical = records.map((record) => {

            const height = job.heights[record.sampleIndex];

            if (record.sampleIndex < 0 || Number.isNaN(height))
                return record.original;

            return job.toPhysical.forward([
                record.source![0],
                record.source![1],
                height + record.heightOffset,
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
