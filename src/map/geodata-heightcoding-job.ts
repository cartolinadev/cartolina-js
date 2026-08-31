/*
 * geodata-heightcoding-job.ts - join one geodata worker job to terrain samples
 */

import type Map from './map';
import ElevationStore from './elevation-store';
import type MapDivisionNode from './division-node';
import type MapGeodataProcessor from './geodata-processor/processor';


const ReadinessPersistenceMs = 1000;


/**
 * Retains the main-thread half of one worker-owned geodata job.
 *
 * The worker owns parsed geometry and rebuilding. This object owns only the
 * corresponding terrain sample set, revision state, and worker routing for
 * the lifetime of `MapGeodata`.
 */
class GeodataHeightcodingJob {

    /**
     * @param map map which owns the elevation store
     * @param processor worker which owns the parsed geodata
     * @param tileId tiled-geodata tile id, or null for monolithic geodata
     * @param onUnused called when the payload needs no client heightcoding
     */
    constructor(
        map: Map,
        processor: MapGeodataProcessor,
        tileId: readonly number[] | null,
        onUnused: () => void,
    ) {

        this.map_ = map;
        this.processor_ = processor;
        this.onUnused_ = onUnused;
        this.node_ = tileId
            ? map.map?.referenceFrame?.getSpatialDivisionNodeForTile(tileId)
                ?? null
            : null;
        this.jobId_ = processor.registerHeightcodingJob(
            this.onMessage.bind(this));
    }

    /** Whether the worker retained parsed geometry for this job. */
    get retained(): boolean {

        return this.sampleSet_ !== null;
    }

    /** Whether the first parse has been sent to the worker. */
    get started(): boolean {

        return this.started_;
    }

    /** Routes worker render output to the current transient view. */
    attach(listener: GeodataHeightcodingJob.Listener): void {

        if (this.listener_ === listener) return;

        // Output in flight belongs to the view that held the route.
        this.listener_ = listener;
        this.readinessDemandSince_ = -Infinity;
        this.publishPending_ = false;
    }

    /** Stops routing output to a view without releasing the worker job. */
    detach(listener: GeodataHeightcodingJob.Listener): void {

        if (this.listener_ !== listener) return;

        // Output in flight belongs to the view that held the route.
        this.listener_ = null;
        this.publishPending_ = false;
    }

    /**
     * Accepts the worker output a view has committed, which releases the
     * next height update.
     *
     * @param listener the committing view's message route
     */
    notePublished(listener: GeodataHeightcodingJob.Listener): void {

        if (this.disposed_ || this.listener_ !== listener) return;

        this.published_ = true;
        this.publishPending_ = false;

        if (!this.changesPending_) return;

        this.changesPending_ = false;
        this.sendChangedHeights();
    }

    /**
     * Returns the metadata for the payload's first worker parse.
     *
     * @returns worker request metadata, or null after the first parse
     */
    beginInitial(): GeodataHeightcodingJob.InitialRequest | null {

        if (this.started_) return null;
        this.started_ = true;

        const legacyMap = this.map_.map!;
        const node = this.node_;

        return {
            jobId: this.jobId_,
            coordinateSpace: node ? 'spatial-division' : 'geographic',
            physicalSrs: legacyMap.getPhysicalSrs().srsDef,
            navigationSrs: legacyMap.getNavigationSrs().srsDef,
            node: node ? {
                id: node.id,
                extents: node.extents,
                srs: node.srs.srsDef,
            } : undefined,
        };
    }

    /** Requests fresh render commands from the retained worker geometry. */
    rebuild(): boolean {

        if (!this.retained || !this.published_ || this.publishPending_)
            return false;

        this.publishPending_ = true;
        this.send('heightcoding-rebuild', {
            jobId: this.jobId_,
            revision: this.sentRevision_,
        });
        return true;
    }

    /** Updates the retained terrain samples at the view's requested gsd. */
    update(desiredGsd: number): Promise<boolean> | null {

        const sampleSet = this.sampleSet_;
        if (!sampleSet || this.disposed_) return null;

        const now = performance.now();

        if (this.map_.moving) {

            if (this.readinessDemandSince_ === -Infinity)
                this.readinessDemandSince_ = now;

            if (now - this.readinessDemandSince_ < ReadinessPersistenceMs) {

                this.map_.map?.markDirty();
                return null;
            }

        } else {

            this.readinessDemandSince_ = -Infinity;
        }

        sampleSet.desiredGsd = desiredGsd;

        if (this.sampleUpdate_) return this.sampleUpdate_;
        this.readinessDemandSince_ = now;

        this.sampleUpdate_ = this.map_.updateTerrainSamples(sampleSet)
            .then((changed) => {

                if (changed && !this.disposed_) this.sendChangedHeights();
                return changed;
            })
            .finally(() => { this.sampleUpdate_ = null; });

        return this.sampleUpdate_;
    }

    /** Releases the terrain samples, worker geometry, and message route. */
    dispose(): void {

        if (this.disposed_) return;
        this.disposed_ = true;

        if (this.sampleSet_)
            this.map_.disposeTerrainSamples(this.sampleSet_);

        this.processor_.releaseHeightcodingJob(this.jobId_);
        this.listener_ = null;
    }

    private onMessage(command: string, message: WorkerMessage): void {

        if (this.disposed_) return;

        if (command === 'heightcoding-request') {

            const positions = message.positions!;

            if (message.coordinateSpace === 'spatial-division') {

                this.sampleSet_ = new ElevationStore.SpatialDivisionSampleSet(
                    positions, 0, this.node_!);

            } else {

                const geographic: ElevationStore.Position[] = [];

                for (let index = 0; index < positions.length; index += 2)
                    geographic.push([positions[index], positions[index + 1]]);

                this.sampleSet_ = new ElevationStore.GeographicSampleSet(
                    geographic, 0);
            }

            this.lastSentHeights_ = new Float64Array(
                positions.length / 2).fill(NaN);
            this.map_.map?.markDirty();
            return;
        }

        if (command === 'heightcoding-unused') {

            this.processor_.forgetHeightcodingJob(this.jobId_);
            this.disposed_ = true;
            this.onUnused_();
            return;
        }

        this.listener_?.(command, message);
    }

    private sendChangedHeights(): void {

        const samples = this.sampleSet_?.samples;
        const last = this.lastSentHeights_;
        if (!samples || !last) return;

        // Only one worker output is in flight at a time.
        if (this.publishPending_) {

            this.changesPending_ = true;
            return;
        }

        if (this.sentRevision_ === 0) {

            for (let index = 0; index < last.length; index++)
                if (samples[index] === undefined) return;
        }

        const changed: number[] = [];

        for (let index = 0; index < samples.length; index++) {

            const height = samples[index]?.height;
            if (height !== undefined && height !== last[index])
                changed.push(index, height);
        }

        if (changed.length === 0) return;

        const indices = new Uint32Array(changed.length / 2);
        const heights = new Float64Array(indices.length);

        for (let index = 0; index < indices.length; index++) {

            indices[index] = changed[index * 2];
            heights[index] = changed[index * 2 + 1];
            last[indices[index]] = heights[index];
        }

        this.sentRevision_++;
        this.publishPending_ = true;
        this.send('heightcoding-update', {
            jobId: this.jobId_,
            revision: this.sentRevision_,
            indices,
            heights,
        }, [indices.buffer, heights.buffer]);
    }

    private send(
        command: string,
        data: GeodataHeightcodingJob.WorkerRequest,
        transferables?: Transferable[],
    ): void {

        this.processor_.sendCommand(
            command, data, null, null, transferables);
    }

    private readonly map_: Map;
    private readonly processor_: MapGeodataProcessor;
    private readonly node_: MapDivisionNode | null;
    private readonly onUnused_: () => void;
    private readonly jobId_: number;

    private listener_: GeodataHeightcodingJob.Listener | null = null;
    private sampleSet_: ElevationStore.SampleSet | null = null;
    private sampleUpdate_: Promise<boolean> | null = null;
    private lastSentHeights_: Float64Array | null = null;
    private sentRevision_ = 0;
    private readinessDemandSince_ = -Infinity;
    private started_ = false;
    private published_ = false;
    private publishPending_ = false;
    private changesPending_ = false;
    private disposed_ = false;
}


type WorkerMessage = {
    coordinateSpace?: 'geographic' | 'spatial-division';
    positions?: Float64Array;
} & Record<string, unknown>;


namespace GeodataHeightcodingJob {

    export type Listener = (
        command: string,
        message: WorkerMessage,
    ) => void;

    export type InitialRequest = {
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

    export type WorkerRequest =
        | {
            jobId: number;
            revision: number;
        }
        | {
            jobId: number;
            revision: number;
            indices: Uint32Array;
            heights: Float64Array;
        };
}


export default GeodataHeightcodingJob;
