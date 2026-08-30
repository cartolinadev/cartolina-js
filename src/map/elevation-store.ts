/*
 * elevation-store.ts - bounded GPU height field over the terrain in view
 */

import type Map from './map';
import type MapDivisionNode from './division-node';
import type MapSurfaceTile from './surface-tile';
import type { TileRenderRig } from './tile-render-rig';
import type GpuTexture from '../renderer/gpu/texture';
import ElevationUnits from '../renderer/elevation-units';
import ElevationTerrainSink from './elevation-terrain-sink';
import * as utils from '../utils/utils';


/**
 * A height field over the terrain ready for normal rendering.
 *
 * One unit belongs to each resident tile at or below a spatial division
 * node root. Node-root units stay resident after obtaining coverage; the
 * rest are evicted least-recently-used against
 * `mapElevationStoreGPUCache`.
 *
 * Consumers retain sample sets. A sample retains the resolved spatial
 * division node and the unit that answered, so an unchanged set avoids
 * repeating coordinate conversion and tile-path work.
 */
class ElevationStore {

    /**
     * @param map the owning map
     */
    constructor(map: Map) {

        this.map_ = map;
        this.units_ = new ElevationUnits(map.renderer);
        this.sink = new ElevationTerrainSink(this);
        this.budgetBytes_ = this.resolveBudget();
    }

    /**
     * Updates covered samples in place.
     *
     * Repeated calls for one sample set share an in-flight update. A miss
     * leaves an earlier answer unchanged. A sample set checked more
     * often than `mapElevationStoreSampleIntervalMs` resolves `false`
     * without scanning, since the store cannot have committed anything
     * new in between.
     *
     * @param sampleSet caller-owned positions, requested gsd, and samples
     * @returns whether at least one height or actual gsd changed
     */
    updateTerrainSamples(
        sampleSet: ElevationStore.SampleSet,
    ): Promise<boolean> {

        if (!Number.isFinite(sampleSet.desiredGsd)
                || sampleSet.desiredGsd < 0) {

            return Promise.reject(new RangeError(
                'updateTerrainSamples: desiredGsd must be finite and '
                + 'non-negative.'));
        }

        if (this.disposedSampleSets_.has(sampleSet))
            return Promise.resolve(false);

        const existing = this.updates_.get(sampleSet);
        if (existing) return existing.promise;

        const retainedState = this.sampleSetStates_.get(sampleSet);
        const count = sampleCount(sampleSet);

        if (!retainedState
                || retainedState.positions !== sampleSet.positions
                || retainedState.samples !== sampleSet.samples
                || retainedState.samples.length !== count) {

            for (let index = 0; index < count; index++) {

                if (!validPosition(sampleSet, index)) {

                    return Promise.reject(new TypeError(
                        'updateTerrainSamples: every position must contain '
                        + 'two finite numbers.'));
                }
            }
        }

        const state = this.sampleSetState(sampleSet);

        const interval = this.map_.config.mapElevationStoreSampleIntervalMs;
        const now = performance.now();

        if (now - state.lastChecked < interval) return Promise.resolve(false);
        state.lastChecked = now;

        const lookups: Lookup[] = [];

        for (let index = 0; index < count; index++) {

            let ref = state.refs[index];

            if (!ref) {

                ref = sampleSet.coordinateSpace === 'spatial-division'
                    ? this.resolveSpatialDivisionPosition(sampleSet, index)
                    : this.resolveGeographicPosition(
                        sampleSet.positions[index]);
                state.refs[index] = ref;
            }

            if (!ref) continue;

            const candidates = this.resolveUnits(
                ref, sampleSet.desiredGsd);

            if (candidates && candidates.length > 0)
                lookups.push({ update: null!, index, candidates });
        }

        if (lookups.length === 0) return Promise.resolve(false);

        let resolve!: (changed: boolean) => void;
        const promise = new Promise<boolean>((settle) => {
            resolve = settle;
        });

        const update: SampleUpdate = {
            sampleSet,
            state,
            lookups,
            next: 0,
            pending: lookups.length,
            changed: false,
            promise,
            resolve,
            settled: false,
        };

        for (const lookup of lookups) lookup.update = update;

        this.updates_.set(sampleSet, update);
        this.queue_.push(update);
        return promise;
    }

    /** Stops an update and prevents a later readback from writing to it. */
    disposeTerrainSamples(sampleSet: ElevationStore.SampleSet): void {

        this.disposedSampleSets_.add(sampleSet);
        this.sampleSetStates_.delete(sampleSet);

        const update = this.updates_.get(sampleSet);
        if (update) this.cancelUpdate(update);
    }

    /** Settles completed lookups and submits the next result chunk. */
    update(): void {

        const signature = this.map_.surfaceList()
            .map((source) => source.id).join(' ');

        if (signature !== this.sourceSignature_) {

            this.sourceSignature_ = signature;
            this.clear();
        }

        this.collectReadback();
        this.submitBatch();
    }

    /** GPU bytes the store holds, units and fixed buffers together. */
    get usedBytes(): number {

        return this.usedBytes_ + this.units_.fixedBytes;
    }

    /** GPU bytes the store may hold, after the budget clamp. */
    get budgetBytes(): number {

        return this.budgetBytes_ + this.units_.fixedBytes;
    }

    /**
     * Admits this tick's elevation pass when its interval has elapsed.
     *
     * @returns whether the caller should run the pass
     */
    admitElevationPass(): boolean {

        const interval = this.map_.config.mapElevationStoreUpdateIntervalMs;
        const now = performance.now();

        if (now - this.lastPassTime_ < interval) return false;

        this.lastPassTime_ = now;
        return true;
    }

    /** Releases every unit and settles every pending update. */
    clear(): void {

        for (const unit of this.resident_.values())
            this.units_.releaseUnit(unit.handle);

        this.resident_.clear();
        this.pinned_.clear();
        this.usedBytes_ = 0;
        this.deepestLod_ = -1;
        this.sampleSetStates_ = new WeakMap();

        this.settlePending();
    }

    /** Releases every store-owned GPU resource. */
    [Symbol.dispose](): void {

        this.clear();
        this.units_[Symbol.dispose]();
    }

    /** Starts one replacement unit from its published children. */
    beginUnit(tileId: [number, number, number]): void {

        this.replacementTile_ = tileId;
        this.replacementDirty_ = false;
        this.replacementWatertight_ = false;
        this.replacementContent_ = null;

        if (!this.withinNodeRoot(tileId)) return;

        this.units_.beginReplacement();

        const childUnits = [0, 1, 2, 3].map((quadrant) =>
            this.resident_.get(unitKey([
                tileId[0] + 1,
                tileId[1] * 2 + (quadrant & 1),
                tileId[2] * 2 + (quadrant >> 1),
            ])) ?? null);

        this.replacementContent_ = {
            childGenerations: childUnits.map(
                (child) => child?.generation ?? -1),
            rigs: [],
        };

        const children = childUnits.map((child) => child?.handle ?? null);
        this.replacementWatertight_ = childUnits.every(
            (child) => child?.watertight === true);

        if (this.units_.reduceChildren(children))
            this.replacementDirty_ = true;
    }

    /** Adds one selected ready rig to the replacement unit. */
    drawUnit(
        tile: MapSurfaceTile,
        rig: TileRenderRig,
        maskTexture?: GpuTexture,
    ): void {

        if (!this.replacementTile_) return;
        if (!this.withinNodeRoot(tile.id)) return;

        this.replacementContent_!.rigs.push(rig);

        const legacyMap = this.map_.map!;

        this.map_.withNavigationCamera(() => this.units_.rasterizeRig(
            rig,
            legacyMap.camera.position,
            this.heightRange(),
            legacyMap.isGeocent,
            maskTexture));

        this.replacementDirty_ = true;
        this.replacementWatertight_ = true;
    }

    /** Publishes a complete replacement when the node has coverage. */
    endUnit(
        tileId: [number, number, number],
        covered: boolean,
        watertight: boolean,
    ): void {

        const dirty = this.replacementDirty_;
        const unitWatertight = watertight && this.replacementWatertight_;
        const content = this.replacementContent_;

        this.replacementTile_ = null;
        this.replacementDirty_ = false;
        this.replacementWatertight_ = false;
        this.replacementContent_ = null;

        if (!covered || !dirty || !content) return;
        if (!this.withinNodeRoot(tileId)) return;

        const resident = this.resident_.get(unitKey(tileId));

        if (resident && resident.watertight === unitWatertight
                && sameContent(resident.content, content)) {

            this.touch(resident.key, resident);
            return;
        }

        const unit = this.admitUnit(tileId);
        if (!unit) return;

        this.units_.publishReplacement(unit.handle);
        unit.content = content;
        unit.generation = ++this.nextGeneration_;
        unit.watertight = unitWatertight;
    }

    /** The elevation sink that builds units during a pass. */
    readonly sink: ElevationTerrainSink;

    private sampleSetState(
        sampleSet: ElevationStore.SampleSet,
    ): SampleSetState {

        let state = this.sampleSetStates_.get(sampleSet);

        const count = sampleCount(sampleSet);

        if (state && state.positions === sampleSet.positions
                && state.samples === sampleSet.samples
                && state.samples.length === count
                && state.refs.length === count) {

            return state;
        }

        if (!sampleSet.samples
                || sampleSet.samples.length !== count) {

            sampleSet.samples = new Array(count);
        }

        const refs = sampleSet.samples.map((sample) => {

            const unit = sample?.unit as UnitRef | undefined;
            return unit?.store === this ? unit : undefined;
        });

        state = {
            positions: sampleSet.positions,
            samples: sampleSet.samples,
            refs,
            lastChecked: -Infinity,
        };

        this.sampleSetStates_.set(sampleSet, state);
        return state;
    }

    private resolveGeographicPosition(
        position: ElevationStore.Position,
    ): UnitRef | undefined {

        const refFrame = this.map_.map?.referenceFrame;
        if (!refFrame) return undefined;

        const owner = refFrame.resolveSpatialDivisionNodes(
            [position[0], position[1], 0]).find(
            (entry) => productiveNode(entry.node));

        if (!owner) return undefined;

        return {
            store: this,
            node: owner.node,
            coords: [owner.coords[0], owner.coords[1]],
        };
    }

    private resolveSpatialDivisionPosition(
        sampleSet: ElevationStore.SpatialDivisionSampleSet,
        index: number,
    ): UnitRef | undefined {

        const node = sampleSet.node;
        const coords: [number, number] = [
            sampleSet.positions[index * 2],
            sampleSet.positions[index * 2 + 1],
        ];
        const extents = node.extents;

        if (!productiveNode(node)
                || coords[0] < extents.ll[0]
                || coords[0] > extents.ur[0]
                || coords[1] < extents.ll[1]
                || coords[1] > extents.ur[1]) {

            __DEV__ && utils.warnOnce(
                'elevation store: sample outside its spatial division node');
            return undefined;
        }

        return { store: this, node, coords };
    }

    /**
     * Returns candidate units in fine-to-coarse order. `null` means the
     * retained answer is current and no GPU lookup is needed.
     */
    private resolveUnits(
        ref: UnitRef,
        desiredGsd: number,
    ): ResidentUnit[] | null {

        const refFrame = this.map_.map?.referenceFrame;
        if (!refFrame) return [];

        const node = ref.node;
        const rootLod = node.id[0];
        const rootGsd = refFrame.getNodeGsd(node, rootLod, 256);

        const idealLod = desiredGsd === 0
            ? Infinity
            : Math.max(rootLod, rootLod
                + Math.floor(Math.log2(rootGsd / desiredGsd)));

        const startLod = Math.min(idealLod, this.deepestLod_);
        if (startLod < rootLod) return [];

        const candidates: ResidentUnit[] = [];
        const uv = [0, 0];
        const startTile = refFrame.getNodeTileAt(
            node, ref.coords, startLod, uv);
        let x = startTile[1];
        let y = startTile[2];
        let u = uv[0];
        let v = uv[1];
        let actualGsd = rootGsd / Math.pow(2, startLod - rootLod);

        for (let lod = startLod; lod >= rootLod; lod--) {

            const tileId: [number, number, number] = [lod, x, y];
            const unit = this.resident_.get(unitKey(tileId));

            if (unit) {

                candidates.push({
                    unit,
                    u,
                    v,
                    actualGsd,
                });
            }

            if (sameTile(tileId, ref.tileId) && unit) {

                if (candidates.length === 1
                        && unit.generation === ref.generation) {

                    return null;
                }

                if (unit.watertight) return candidates;

                break;
            }

            if (unit?.watertight) return candidates;

            u = ((x & 1) + u) * 0.5;
            v = ((y & 1) + v) * 0.5;
            x >>= 1;
            y >>= 1;
            actualGsd *= 2;
        }

        return candidates;
    }

    private submitBatch(): void {

        if (this.inFlight_) return;

        const batch: Lookup[] = [];

        while (this.queue_.length > 0
                && batch.length < this.units_.maxBatch) {

            const update = this.queue_[0];

            if (update.settled) {

                this.queue_.shift();
                continue;
            }

            while (update.next < update.lookups.length
                    && batch.length < this.units_.maxBatch) {

                batch.push(update.lookups[update.next++]);
            }

            if (update.next < update.lookups.length) break;
            this.queue_.shift();
        }

        if (batch.length === 0) return;

        let readback: ElevationUnits.Readback | null = null;

        try {

            readback = this.drawBatch(batch);

        } catch (error) {

            console.error('elevation lookup failed', error);
        }

        this.inFlight_ = readback ? { readback, batch } : null;

        if (!readback) this.completeBatch(batch, null);
    }

    private drawBatch(
        batch: readonly Lookup[],
    ): ElevationUnits.Readback | null {

        let maxPreference = 0;

        for (const entry of batch)
            maxPreference = Math.max(
                maxPreference, entry.candidates.length - 1);

        const groups = new globalThis.Map<
            Unit, ElevationUnits.LookupPoint[]>();

        for (let index = 0; index < batch.length; index++) {

            const entry = batch[index];

            for (let preference = 0;
                    preference < entry.candidates.length;
                    preference++) {

                const candidate = entry.candidates[preference];
                let group = groups.get(candidate.unit);

                if (!group) {

                    group = [];
                    groups.set(candidate.unit, group);
                }

                group.push({
                    column: index,
                    u: candidate.u,
                    v: candidate.v,
                    preference,
                });
            }
        }

        this.units_.beginLookup(maxPreference);

        for (const [unit, points] of groups) {

            if (this.resident_.get(unit.key) !== unit) continue;

            this.touch(unit.key, unit);
            this.units_.drawLookupGroup(unit.handle, points);
        }

        return this.units_.endLookup(batch.length);
    }

    private collectReadback(): void {

        const inFlight = this.inFlight_;
        if (!inFlight) return;

        const results = this.units_.pollReadback(inFlight.readback);
        if (!results) return;

        this.inFlight_ = null;
        this.completeBatch(inFlight.batch, results);
    }

    private completeBatch(
        batch: readonly Lookup[],
        results: DataView | null,
    ): void {

        const preferenceRow = batch.length * 4;

        for (let index = 0; index < batch.length; index++) {

            const lookup = batch[index];
            const update = lookup.update;

            if (update.settled
                    || this.disposedSampleSets_.has(update.sampleSet)) {

                continue;
            }

            if (results) {

                const height = results.getFloat32(index * 4, true);
                const preferenceValue = results.getFloat32(
                    preferenceRow + index * 4, true);

                if (!Number.isNaN(height)
                        && !Number.isNaN(preferenceValue)) {

                    const preference = Math.round(preferenceValue);
                    const candidate = lookup.candidates[preference];

                    if (candidate) {
                        this.writeSample(lookup, candidate, height);
                    }
                }
            }

            update.pending--;
            if (update.pending === 0) this.finishUpdate(update);
        }

        this.submitBatch();
    }

    private writeSample(
        lookup: Lookup,
        candidate: ResidentUnit,
        height: number,
    ): void {

        const update = lookup.update;
        const ref = update.state.refs[lookup.index]!;
        const previous = update.sampleSet.samples![lookup.index];

        ref.tileId = candidate.unit.tileId;
        ref.generation = candidate.unit.generation;

        if (!previous || previous.height !== height
                || previous.actualGsd !== candidate.actualGsd) {

            update.sampleSet.samples![lookup.index] = {
                height,
                actualGsd: candidate.actualGsd,
                unit: ref,
            };

            update.changed = true;

        } else {

            previous.unit = ref;
        }

    }

    private finishUpdate(update: SampleUpdate): void {

        if (update.settled) return;

        update.settled = true;
        this.updates_.delete(update.sampleSet);
        update.resolve(update.changed);
    }

    private cancelUpdate(update: SampleUpdate): void {

        if (update.settled) return;

        update.settled = true;
        this.updates_.delete(update.sampleSet);
        update.resolve(false);
    }

    private settlePending(): void {

        if (this.inFlight_) {

            this.units_.dropReadback(this.inFlight_.readback);
            this.inFlight_ = null;
        }

        for (const update of this.updates_.values())
            this.cancelUpdate(update);

        this.queue_ = [];
        this.updates_.clear();
    }

    private admitUnit(tileId: [number, number, number]): Unit | null {

        const key = unitKey(tileId);
        const resident = this.resident_.get(key);

        if (resident) {

            this.touch(key, resident);
            return resident;
        }

        const unitBytes = this.units_.unitBytes;

        while (this.usedBytes_ + unitBytes > this.budgetBytes_) {

            if (!this.evictOne()) return null;
        }

        const unit: Unit = {
            handle: this.units_.createUnit(),
            key,
            tileId,
            generation: 0,
            watertight: false,
            content: null,
        };

        this.resident_.set(key, unit);
        this.usedBytes_ += unitBytes;
        this.deepestLod_ = Math.max(this.deepestLod_, tileId[0]);

        if (this.isNodeRoot(tileId)) this.pinned_.add(key);

        return unit;
    }

    private evictOne(): boolean {

        for (const unit of this.resident_.values()) {

            if (this.pinned_.has(unit.key)) continue;
            if ([0, 1, 2, 3].some((quadrant) =>
                this.resident_.has(unitKey([
                    unit.tileId[0] + 1,
                    unit.tileId[1] * 2 + (quadrant & 1),
                    unit.tileId[2] * 2 + (quadrant >> 1),
                ])))) continue;

            this.units_.releaseUnit(unit.handle);
            this.resident_.delete(unit.key);
            this.usedBytes_ -= this.units_.unitBytes;

            if (unit.tileId[0] === this.deepestLod_)
                this.recomputeDeepestLod();

            return true;
        }

        return false;
    }

    private recomputeDeepestLod(): void {

        let deepest = -1;

        for (const unit of this.resident_.values())
            deepest = Math.max(deepest, unit.tileId[0]);

        this.deepestLod_ = deepest;
    }

    private touch(key: string, unit: Unit): void {

        this.resident_.delete(key);
        this.resident_.set(key, unit);
    }

    private heightRange(): [number, number] {

        const range = this.map_.map!.referenceFrame!.getGlobalHeightRange();
        return [range[0], range[1]];
    }

    private withinNodeRoot(tileId: readonly number[]): boolean {

        return this.nodeRootOf(tileId) !== null;
    }

    private isNodeRoot(tileId: readonly number[]): boolean {

        const node = this.nodeRootOf(tileId);
        return node !== null && node.id[0] === tileId[0];
    }

    private nodeRootOf(
        tileId: readonly number[],
    ): MapDivisionNode | null {

        const refFrame = this.map_.map?.referenceFrame;
        if (!refFrame) return null;

        let owner: MapDivisionNode | null = null;

        for (const node of refFrame.getSpatialDivisionNodes()) {

            if (!productiveNode(node)) continue;

            const shift = tileId[0] - node.id[0];
            if (shift < 0) continue;
            if ((tileId[1] >> shift) !== node.id[1]) continue;
            if ((tileId[2] >> shift) !== node.id[2]) continue;

            if (!owner || node.id[0] > owner.id[0]) owner = node;
        }

        return owner;
    }

    private resolveBudget(): number {

        const configured =
            this.map_.config.mapElevationStoreGPUCache * 1024 * 1024;

        const nodes = this.map_.map?.referenceFrame
            ?.getSpatialDivisionNodes().filter(productiveNode).length ?? 1;

        const fixed = this.units_.fixedBytes;
        const minimum = fixed + nodes * this.units_.unitBytes;

        if (configured >= minimum) return configured - fixed;

        console.warn('mapElevationStoreGPUCache raised to '
            + `${Math.ceil(minimum / (1024 * 1024))} MiB, the least this `
            + 'reference frame can work with.');

        return minimum - fixed;
    }

    private readonly map_: Map;
    private readonly units_: ElevationUnits;
    private readonly resident_ = new globalThis.Map<string, Unit>();
    private readonly pinned_ = new Set<string>();
    private readonly disposedSampleSets_ =
        new WeakSet<ElevationStore.SampleSet>();
    private readonly updates_ =
        new globalThis.Map<ElevationStore.SampleSet, SampleUpdate>();

    private sampleSetStates_ =
        new WeakMap<ElevationStore.SampleSet, SampleSetState>();
    private queue_: SampleUpdate[] = [];
    private inFlight_: InFlight | null = null;

    private usedBytes_ = 0;
    private budgetBytes_: number;
    private deepestLod_ = -1;
    private nextGeneration_ = 0;
    private replacementTile_: [number, number, number] | null = null;
    private replacementDirty_ = false;
    private replacementWatertight_ = false;
    private replacementContent_: UnitContent | null = null;
    private lastPassTime_ = -Infinity;
    private sourceSignature_: string | null = null;
}


type Unit = {
    handle: ElevationUnits.Unit;
    key: string;
    tileId: [number, number, number];
    generation: number;
    watertight: boolean;
    content: UnitContent | null;
};


type UnitContent = {
    childGenerations: number[];
    rigs: TileRenderRig[];
};


type UnitRef = {
    store: ElevationStore;
    node: MapDivisionNode;
    coords: [number, number];
    tileId?: [number, number, number];
    generation?: number;
};


type ResidentUnit = {
    unit: Unit;
    u: number;
    v: number;
    actualGsd: number;
};


type SampleSetState = {
    positions: readonly ElevationStore.Position[] | Float64Array;
    samples: (ElevationStore.Sample | undefined)[];
    refs: (UnitRef | undefined)[];
    lastChecked: number;
};


type Lookup = {
    update: SampleUpdate;
    index: number;
    candidates: ResidentUnit[];
};


type SampleUpdate = {
    sampleSet: ElevationStore.SampleSet;
    state: SampleSetState;
    lookups: Lookup[];
    next: number;
    pending: number;
    changed: boolean;
    promise: Promise<boolean>;
    resolve: (changed: boolean) => void;
    settled: boolean;
};


type InFlight = {
    readback: ElevationUnits.Readback;
    batch: Lookup[];
};


function unitKey(tileId: readonly number[]): string {

    return `${tileId[0]}/${tileId[1]}/${tileId[2]}`;
}


function sameTile(
    first: readonly number[],
    second?: readonly number[],
): boolean {

    return !!second
        && first[0] === second[0]
        && first[1] === second[1]
        && first[2] === second[2];
}


function sameContent(
    first: UnitContent | null,
    second: UnitContent,
): boolean {

    if (!first || first.rigs.length !== second.rigs.length) return false;

    for (let index = 0; index < first.childGenerations.length; index++)
        if (first.childGenerations[index]
                !== second.childGenerations[index]) return false;

    for (let index = 0; index < first.rigs.length; index++)
        if (first.rigs[index] !== second.rigs[index]) return false;

    return true;
}


function sampleCount(sampleSet: ElevationStore.SampleSet): number {

    return sampleSet.coordinateSpace === 'spatial-division'
        ? sampleSet.positions.length / 2
        : sampleSet.positions.length;
}


function validPosition(
    sampleSet: ElevationStore.SampleSet,
    index: number,
): boolean {

    if (sampleSet.coordinateSpace === 'spatial-division')
        return sampleSet.positions.length % 2 === 0
            && Number.isFinite(sampleSet.positions[index * 2])
            && Number.isFinite(sampleSet.positions[index * 2 + 1]);

    const value = sampleSet.positions[index];

    return Array.isArray(value)
        && value.length >= 2
        && Number.isFinite(value[0])
        && Number.isFinite(value[1]);
}


function productiveNode(node: MapDivisionNode): boolean {

    const partitioning = node.partitioning;

    if (partitioning && typeof partitioning === 'object') return false;

    return partitioning !== 'none' && partitioning !== 'barren';
}


namespace ElevationStore {

    /** A geographic position in the meaning of RFC 13 section 3.1. */
    export type Position = readonly [number, number];

    /** Common retained storage for one stable position list. */
    export abstract class SampleSetBase<Positions> {

        samples?: (Sample | undefined)[];

        protected constructor(
            readonly positions: Positions,
            public desiredGsd: number,
        ) {}
    }

    /** Geographic positions resolved by the store. */
    export class GeographicSampleSet extends
            SampleSetBase<readonly Position[]> {

        readonly coordinateSpace?: 'geographic';

        constructor(positions: readonly Position[], desiredGsd: number) {

            super(positions, desiredGsd);
        }
    }

    /** Packed positions in one spatial division node's SRS. */
    export class SpatialDivisionSampleSet extends
            SampleSetBase<Float64Array> {

        readonly coordinateSpace = 'spatial-division';

        constructor(
            positions: Float64Array,
            desiredGsd: number,
            readonly node: MapDivisionNode,
        ) {

            super(positions, desiredGsd);
        }
    }

    /** Either coordinate-space variant accepted by the store. */
    export type SampleSet = GeographicSampleSet | SpatialDivisionSampleSet;

    /** One covered terrain sample. */
    export type Sample = {
        height: number;
        actualGsd: number;
        unit: unknown;
    };
}

export default ElevationStore;
