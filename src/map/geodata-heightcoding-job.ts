/*
 * geodata-heightcoding-job.ts - join one geodata worker job to terrain samples
 *
 * Client heightcoding is split across the worker boundary. The worker
 * (`WorkerHeightcodingJobs`) parses geodata, converts coordinates, and
 * rebuilds render geometry; this class, on the main thread, samples the
 * elevation store and feeds the worker heights. They share a job id and
 * exchange five messages:
 *
 *   heightcoding-request  worker -> main  the store coordinates for a
 *                                         payload that needs heightcoding;
 *                                         this class builds its sample set
 *   heightcoding-unused   worker -> main  the payload needs no heightcoding;
 *                                         this class tears itself down
 *   heightcoding-update   main -> worker  changed heights and a revision;
 *                                         the worker applies them, rebuilds,
 *                                         and republishes the geometry
 *   publish-retained      main -> worker  the worker re-emits its current
 *                                         geometry for a new view
 *   heightcoding-release  main -> worker  drop the retained worker job
 */

import type Map from './map';
import ElevationStore from './elevation-store';
import type MapDivisionNode from './division-node';
import type MapGeodataProcessor from './geodata-processor/processor';


const ReadinessPersistenceMs = 1000;


/**
 * The main-thread half of one worker-owned geodata heightcoding job.
 *
 * One instance lives for the lifetime of a `MapGeodata` and survives the
 * transient `MapGeodataView`s that render it. It owns the terrain sample
 * set, samples the elevation store when a view demands it, and sends the
 * changed heights to the worker over the protocol above. The worker owns
 * the parsed geometry and the rebuild; this class holds no geodata.
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

    /**
     * Whether a tiled tile has reached its fixed target resolution and
     * the worker holds that final geometry, so its retained state can be
     * released. Monolithic jobs (no node) never settle.
     */
    get settled(): boolean {

        // Geometry can publish before sampleSet_ is created.
        return this.node_ !== null
            && this.published_ && !this.publishPending_
            && !this.changesPending_ && !this.sendOwed_ && !this.sampleUpdate_
            && this.sampleSet_ !== null && this.sampleSet_.settled;
    }

    /** Routes worker render output to the current transient view. */
    attach(listener: GeodataHeightcodingJob.Listener): void {

        if (this.listener_ === listener) return;

        // Output in flight belongs to the view that held the route.
        this.listener_ = listener;
        this.readinessDemandSince_ = -Infinity;
        this.dropPublication();
    }

    /** Stops routing output to a view without releasing the worker job. */
    detach(listener: GeodataHeightcodingJob.Listener): void {

        if (this.listener_ !== listener) return;

        // Output in flight belongs to the view that held the route.
        this.listener_ = null;
        this.dropPublication();
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
        this.dropPublication();

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

        if (!this.processor_.acquirePublication(this.jobId_)) return false;

        this.publishPending_ = true;
        this.send('publish-retained', {
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

                // An owed send retries on every answer, changed or not.
                if ((changed || this.sendOwed_) && !this.disposed_)
                    this.sendChangedHeights();

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

        this.dropPublication();
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

        const heightField = this.sampleSet_?.sampleHeight;
        const last = this.lastSentHeights_;
        if (!heightField || !last) return;

        // Only one worker output is in flight at a time.
        if (this.publishPending_) {

            this.changesPending_ = true;
            return;
        }

        // The slot comes before the scan: a refused send costs a lookup
        // and is owed until a later store answer gets the slot. The
        // release of a slot redraws the map, which is what asks again.
        if (!this.processor_.acquirePublication(this.jobId_)) {

            this.sendOwed_ = true;
            return;
        }

        this.sendOwed_ = false;

        const changed: number[] = [];

        for (let index = 0; index < heightField.length; index++) {

            // NaN marks a coordinate no terrain covers yet.
            const height = heightField[index];
            if (!Number.isNaN(height) && height !== last[index])
                changed.push(index, height);
        }

        if (changed.length === 0) {

            this.processor_.releasePublication(this.jobId_);
            return;
        }

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

    /** Ends the outstanding publication, committed or orphaned. */
    private dropPublication(): void {

        this.publishPending_ = false;
        this.processor_.releasePublication(this.jobId_);
    }

    private send(
        command: string,
        data: GeodataHeightcodingJob.WorkerRequest,
        transferables?: Transferable[],
    ): void {

        this.processor_.sendCommand(
            command, data, null, null, transferables);
    }

    /** Owning map, source of the elevation store and the moving flag. */
    private readonly map_: Map;

    /** Geodata worker this job registers with and messages. */
    private readonly processor_: MapGeodataProcessor;

    /** Reference-frame node of a tiled job; null for a monolithic one. */
    private readonly node_: MapDivisionNode | null;

    /** Called when the worker reports the payload needs no heightcoding. */
    private readonly onUnused_: () => void;

    /** Worker-registry key shared by both threads. */
    private readonly jobId_: number;

    /** Current view's message route; null between views. */
    private listener_: GeodataHeightcodingJob.Listener | null = null;

    /** Retained store coordinates; null until the worker registers them. */
    private sampleSet_: ElevationStore.SampleSet | null = null;

    /** In-flight store update; repeated calls share this promise. */
    private sampleUpdate_: Promise<boolean> | null = null;

    /** Heights last sent per coordinate, to diff the next update. */
    private lastSentHeights_: Float64Array | null = null;

    /** Monotonic update counter; the worker drops an older revision. */
    private sentRevision_ = 0;

    /** When this view first demanded readiness while the map moved. */
    private readinessDemandSince_ = -Infinity;

    /** Whether the first parse has been sent to the worker. */
    private started_ = false;

    /** Whether a committed view has released the next update. */
    private published_ = false;

    /** Whether one worker output is in flight. */
    private publishPending_ = false;

    /** Whether heights changed while an output was in flight. */
    private changesPending_ = false;

    /** Whether a refused send still owes the worker its heights. */
    private sendOwed_ = false;

    /** Whether the job is released. */
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
