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


const PreparationBudgetMs = 8;
const PreparationChunk = 256;


/**
 * A height field over the terrain ready for normal rendering.
 *
 * The store provides machinery for client-side heightcoding - resolving
 * of 2D geographic or spatial-division coordinates into geodetic heights, based
 * on the currently resident terrain.
 *
 * Consumers retain sample sets. For each coordinate the store keeps, in
 * parallel typed arrays, the resolved node and the unit that answered, so
 * an unchanged set avoids repeating coordinate conversion and tile-path
 * work.
 *
 * Internally, the store is composed of units, which correspond to the
 * color-pass terrain tiles, one unit per each resident tile. The store
 * operates on a budget configured through `mapElevationStoreGPUCache`.
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
     * without reading the store. Calling again after the interval gets
     * the reading that call missed; the map is kept drawing until then.
     *
     * The store retains a sample set and its metadata until disposed by
     * call to `disposeTerrainSamples` (or until garbage-collected).
     *
     * @param sampleSet caller-owned positions, requested gsd, and samples
     * @returns whether at least one height or actual gsd changed
     */
    updateTerrainSamples(
        sampleSet: ElevationStore.SampleSet,
    ): Promise<boolean> {

        // sanity
        if (!Number.isFinite(sampleSet.desiredGsd)
                || sampleSet.desiredGsd < 0) {

            return Promise.reject(new RangeError(
                'updateTerrainSamples: desiredGsd must be finite and '
                + 'non-negative.'));
        }

        // disposed -> bail out
        if (this.disposedSampleSets_.has(sampleSet))
            return Promise.resolve(false);

        // arm store updates (a one-off operation for an empty store)
        this.sampleSetUpdateRequested_ = true;

        // update in flight, return the existing promise
        const existing = this.updates_.get(sampleSet);
        if (existing) return existing.promise;

        // store empty -> bail out without armig the updateStarted guard
        if (this.resident_.size === 0) return Promise.resolve(false);

        const retainedState = this.sampleSetStates_.get(sampleSet);
        const count = sampleCount(sampleSet);

        const validate = !retainedState
                || retainedState.positions !== sampleSet.positions
                || retainedState.count !== count;

        const state = this.sampleSetState(sampleSet, count);
        const refs = this.refs_.get(sampleSet)!;

        const interval = this.map_.config.mapElevationStoreSampleIntervalMs;
        const now = performance.now();

        if (now - state.updateStarted < interval) {

            // This method is called by isReady checks within geodata draw
            // traversal. A clean map will stop issuing these calls, so if there
            // is a published terrain change, we keep it drawing until the
            // throttle expires.
            if (state.updateGeneration !== this.nextGeneration_)
                this.map_.map?.markDirty();

            return Promise.resolve(false);
        }

        state.updateStarted = now;
        state.updateGeneration = this.nextGeneration_;

        let resolve!: (changed: boolean) => void;
        let reject!: (reason: unknown) => void;
        const promise = new Promise<boolean>((settle, fail) => {
            resolve = settle;
            reject = fail;
        });

        const update: SampleUpdate = {
            sampleSet,
            refs,
            desiredGsd: sampleSet.desiredGsd,
            count,
            validate,
            scanIndex: 0,
            nodeScans: new globalThis.Map(),
            lookups: [],
            next: 0,
            pending: 0,
            changed: false,
            promise,
            resolve,
            reject,
            settled: false,
        };

        this.updates_.set(sampleSet, update);
        this.preparing_.push(update);
        return promise;
    }

    /** Stops an update and prevents a later readback from writing to it. */
    disposeTerrainSamples(sampleSet: ElevationStore.SampleSet): void {

        this.disposedSampleSets_.add(sampleSet);
        this.sampleSetStates_.delete(sampleSet);
        this.refs_.delete(sampleSet);

        const update = this.updates_.get(sampleSet);
        if (update) this.cancelUpdate(update);
    }

    /** Advances every pending sample-set update by one tick — applies a
     * finished GPU answer and starts the next one. Call once per map
     * tick to make progress on outstanding `updateTerrainSamples()`
     * calls. */
    update(): void {

        // change in the map's active surface set => full teardown
        const signature = this.map_.surfaceList()
            .map((source) => source.id).join(' ');

        if (signature !== this.sourceSignature_) {

            this.sourceSignature_ = signature;
            this.clear();
        }

        this.collectReadback();
        this.prepareUpdates();
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

    /** Admits this tick's elevation pass when its interval has elapsed. */
    admitElevationPass(): boolean {

        if (!this.sampleSetUpdateRequested_) return false;

        const interval = this.map_.config.mapElevationStoreUpdateIntervalMs;
        const now = performance.now();

        if (now - this.lastPassTime_ < interval) return false;

        this.sampleSetUpdateRequested_ = false;
        this.lastPassTime_ = now;
        return true;
    }

    /**
     * Starts one replacement unit from its published children.
     *
     * ElevationTerrainSink hook, called once per node before any
     * `drawUnit()`/`endUnit()` for it.
     *
     * @param tileId the node root under construction
     */
    beginUnit(tileId: [number, number, number]): void {

        this.replacementTile_ = tileId;
        this.replacementDirty_ = false;
        this.replacementWatertight_ = false;
        this.replacementFailed_ = false;
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

    /**
     * Adds one selected ready rig to the replacement unit.
     *
     * ElevationTerrainSink hook, called once per drawn tile under the
     * current node.
     *
     * @param tile the drawn tile
     * @param rig its already-drawn colour-frame render rig, reused here
     * @param maskTexture the tile's multi-surface mask, if any
     */
    drawUnit(
        tile: MapSurfaceTile,
        rig: TileRenderRig,
        maskTexture?: GpuTexture,
    ): void {

        if (!this.replacementTile_) return;
        if (!this.withinNodeRoot(tile.id)) return;

        const legacyMap = this.map_.map!;

        const drawn = this.map_.withNavigationCamera(
            () => this.units_.rasterizeRig(
                rig,
                legacyMap.camera.position,
                this.heightRange(),
                legacyMap.isGeocent,
                maskTexture));

        // A rig that cannot draw — the GPU cache took its mesh since the
        // traversal found it ready — leaves a hole no sample can detect,
        // so the whole replacement is abandoned and the resident unit
        // stays until a later pass builds a complete one.
        if (!drawn) {

            this.replacementFailed_ = true;
            return;
        }

        this.replacementContent_!.rigs.push(rig);

        this.replacementDirty_ = true;
        this.replacementWatertight_ = true;
    }

    /**
     * Publishes a complete replacement when the node has coverage.
     *
     * ElevationTerrainSink hook, closing the `beginUnit()` that started
     * this node.
     *
     * @param tileId the node root, matching the `beginUnit()` call
     * @param covered whether the traversal drew or masked the whole node
     * @param watertight whether that coverage has no partial or
     *   off-screen gaps
     */
    endUnit(
        tileId: [number, number, number],
        covered: boolean,
        watertight: boolean,
    ): void {

        const dirty = this.replacementDirty_;
        const unitWatertight = watertight && this.replacementWatertight_;
        const content = this.replacementContent_;
        const failed = this.replacementFailed_;

        this.replacementTile_ = null;
        this.replacementDirty_ = false;
        this.replacementWatertight_ = false;
        this.replacementFailed_ = false;
        this.replacementContent_ = null;

        if (failed) return;
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

        // Wakes a map that stopped drawing before this unit existed.
        this.map_.map?.markDirty();
    }

    /** Releases every store-owned GPU resource. */
    [Symbol.dispose](): void {

        this.clear();
        this.units_[Symbol.dispose]();
    }

    /** The elevation sink that builds units during a pass. */
    readonly sink: ElevationTerrainSink;

    /** Releases every unit and settles every pending update. */
    private clear(): void {

        for (const unit of this.resident_.values())
            this.units_.releaseUnit(unit.handle);

        this.resident_.clear();
        this.pinned_.clear();
        this.usedBytes_ = 0;
        this.deepestLod_ = -1;
        this.sampleSetStates_ = new WeakMap();

        this.settlePending();
    }

    private sampleSetState(
        sampleSet: ElevationStore.SampleSet,
        count: number,
    ): SampleSetState {

        // Answers live on the sample set, so a store reset leaves the last
        // heights in place until the units that answered come back.
        if (!sampleSet.sampleHeight
                || sampleSet.sampleHeight.length !== count) {

            sampleSet.sampleHeight = new Float32Array(count).fill(NaN);
            sampleSet.sampleGsd = new Float32Array(count);
        }

        // Resolved references also outlive a reset, so an unchanged set
        // does not repeat coordinate conversion after every source change.
        let refs = this.refs_.get(sampleSet);

        if (!refs || refs.positions !== sampleSet.positions
                || refs.count !== count) {

            refs = makeSampleRefs(sampleSet, count);
            this.refs_.set(sampleSet, refs);
        }

        let state = this.sampleSetStates_.get(sampleSet);

        if (state && state.positions === sampleSet.positions
                && state.count === count)
            return state;

        state = {
            positions: sampleSet.positions,
            count,
            updateStarted: -Infinity,
            updateGeneration: -1,
        };

        this.sampleSetStates_.set(sampleSet, state);
        return state;
    }

    private resolveGeographicPosition(
        position: ElevationStore.Position,
    ): { node: MapDivisionNode; coords: [number, number] } | undefined {

        const refFrame = this.map_.map?.referenceFrame;
        if (!refFrame) return undefined;

        const owner = refFrame.resolveSpatialDivisionNodes(
            [position[0], position[1], 0]).find(
            (entry) => productiveNode(entry.node));

        if (!owner) return undefined;

        return { node: owner.node, coords: [owner.coords[0], owner.coords[1]] };
    }

    /**
     * Returns candidate units in fine-to-coarse order. `null` means the
     * retained answer is current and no GPU lookup is needed.
     */
    private resolveUnits(
        node: MapDivisionNode,
        coords: readonly number[],
        prevKey: number,
        prevGeneration: number,
        desiredGsd: number,
        nodeScans: globalThis.Map<MapDivisionNode, NodeScan>,
    ): ResidentUnit[] | null {

        const refFrame = this.map_.map?.referenceFrame;
        if (!refFrame) return [];

        let scan = nodeScans.get(node);

        // One node and one requested gsd give one start LOD, so every
        // sample against this node shares the figures below. Every gsd is
        // rounded to Float32 so a stored gsd compares equal to one derived
        // again on the next scan.
        if (!scan) {

            const rootLod = node.id[0];
            const rootGsd = Math.fround(
                refFrame.getNodeGsd(node, rootLod, 256));
            const desired = Math.fround(desiredGsd);

            const idealLod = desired === 0
                ? Infinity
                : Math.max(rootLod, rootLod
                    + Math.floor(Math.log2(rootGsd / desired)));

            scan = {
                rootLod,
                rootGsd,
                startLod: Math.min(idealLod, this.deepestLod_),
                ladders: new globalThis.Map(),
            };

            nodeScans.set(node, scan);
        }

        const rootLod = scan.rootLod;
        const startLod = scan.startLod;
        if (startLod < rootLod) return [];

        const uv = [0, 0];
        const startTile = refFrame.getNodeTileAt(node, coords, startLod, uv);
        const ladder = this.tileLadder(scan, startTile);
        let candidates: ResidentUnit[] | null = null;
        let x = startTile[1];
        let y = startTile[2];
        let u = uv[0];
        let v = uv[1];
        let actualGsd = Math.fround(
            scan.rootGsd / Math.pow(2, startLod - rootLod));

        for (let step = 0; step < ladder.length; step++) {

            const unit = ladder[step];

            // The ladder holds the unit at this step's tile, so a key match
            // means the retained answer named that same tile.
            if (unit && unit.key === prevKey) {

                if (!candidates && unit.generation === prevGeneration)
                    return null;

                (candidates ??= []).push({ unit, u, v, actualGsd });

                if (unit.watertight) return candidates;

                break;
            }

            if (unit)
                (candidates ??= []).push({ unit, u, v, actualGsd });

            if (unit?.watertight) return candidates;

            u = ((x & 1) + u) * 0.5;
            v = ((y & 1) + v) * 0.5;
            x >>= 1;
            y >>= 1;
            actualGsd *= 2;
        }

        return candidates ?? [];
    }

    /**
     * Units on the tile path from a start tile down to its node root,
     * ending at the first watertight unit that answers there.
     *
     * The path depends only on the start tile, so samples sharing one
     * tile share the walk; a sample's own position enters through the
     * texture coordinates its caller carries down the path.
     */
    private tileLadder(
        scan: NodeScan,
        startTile: readonly number[],
    ): (Unit | null)[] {

        const key = unitKey(startTile);
        const retained = scan.ladders.get(key);
        if (retained) return retained;

        const ladder: (Unit | null)[] = [];
        let x = startTile[1];
        let y = startTile[2];

        for (let lod = startTile[0]; lod >= scan.rootLod; lod--) {

            const unit = this.resident_.get(unitKey([lod, x, y])) ?? null;
            ladder.push(unit);

            if (unit?.watertight) break;

            x >>= 1;
            y >>= 1;
        }

        scan.ladders.set(key, ladder);
        return ladder;
    }

    private prepareUpdates(): void {

        const deadline = performance.now() + PreparationBudgetMs;
        let active: SampleUpdate | null = null;

        while (this.preparing_.length > 0) {

            const update = this.preparing_[0];

            if (update !== active) {

                update.nodeScans.clear();
                active = update;
            }

            if (update.settled) {

                this.preparing_.shift();
                continue;
            }

            this.prepareUpdate(update);

            if (update.settled) {

                this.preparing_.shift();
                continue;
            }

            if (update.scanIndex === update.count) {

                this.preparing_.shift();
                update.pending = update.lookups.length;

                if (update.pending === 0)
                    this.finishUpdate(update);
                else
                    this.queue_.push(update);
            }

            if (performance.now() >= deadline) break;
        }
    }

    private prepareUpdate(update: SampleUpdate): void {

        const sampleSet = update.sampleSet;
        const refs = update.refs;
        const spatial = sampleSet.coordinateSpace === 'spatial-division';
        const spatialNode = spatial ? sampleSet.node : null;
        const coords = this.coordScratch_;
        const end = Math.min(
            update.scanIndex + PreparationChunk, update.count);

        // Residency cannot move while this scan runs, so the per-node
        // figures and tile paths it derives hold for every sample here.
        for (let index = update.scanIndex; index < end; index++) {

            if (update.validate && !validPosition(sampleSet, index)) {

                this.failUpdate(update, new TypeError(
                    'updateTerrainSamples: every position must contain '
                    + 'two finite numbers.'));
                return;
            }

            let node: MapDivisionNode;

            if (spatial) {

                // A spatial-division coordinate is its own store position;
                // its node is the whole set's node.
                node = spatialNode!;
                coords[0] = sampleSet.positions[index * 2];
                coords[1] = sampleSet.positions[index * 2 + 1];
                const extents = node.extents;

                if (!productiveNode(node)
                        || coords[0] < extents.ll[0]
                        || coords[0] > extents.ur[0]
                        || coords[1] < extents.ll[1]
                        || coords[1] > extents.ur[1]) {

                    __DEV__ && utils.warnOnce('elevation store: sample '
                        + 'outside its spatial division node');
                    continue;
                }

            } else {

                // A geographic coordinate is projected and placed in a node;
                // the result is cached so a later scan reuses it.
                if (refs.nodeIndex![index] < 0) {

                    const resolved = this.resolveGeographicPosition(
                        sampleSet.positions[index]);

                    if (!resolved) continue;

                    refs.nodeIndex![index] = internNode(refs, resolved.node);
                    refs.coordX![index] = resolved.coords[0];
                    refs.coordY![index] = resolved.coords[1];
                }

                node = refs.nodes![refs.nodeIndex![index]];
                coords[0] = refs.coordX![index];
                coords[1] = refs.coordY![index];
            }

            const candidates = this.resolveUnits(
                node, coords, refs.key[index], refs.generation[index],
                update.desiredGsd, update.nodeScans);

            if (candidates && candidates.length > 0)
                update.lookups.push({ update, index, candidates });
        }

        update.scanIndex = end;
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
        const index = lookup.index;

        update.refs.key[index] = candidate.unit.key;
        update.refs.generation[index] = candidate.unit.generation;

        // The GPU readback is already Float32 and the gsd is rounded to
        // it, so a re-resolution to the same answer flags no change.
        const heights = update.sampleSet.sampleHeight!;
        const gsds = update.sampleSet.sampleGsd!;

        if (heights[index] !== height
                || gsds[index] !== candidate.actualGsd) {

            heights[index] = height;
            gsds[index] = candidate.actualGsd;
            update.changed = true;
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

    private failUpdate(update: SampleUpdate, error: unknown): void {

        if (update.settled) return;

        update.settled = true;
        this.updates_.delete(update.sampleSet);
        this.sampleSetStates_.delete(update.sampleSet);
        this.refs_.delete(update.sampleSet);
        update.reject(error);
    }

    private settlePending(): void {

        if (this.inFlight_) {

            this.units_.dropReadback(this.inFlight_.readback);
            this.inFlight_ = null;
        }

        for (const update of this.updates_.values())
            this.cancelUpdate(update);

        this.preparing_ = [];
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

    private touch(key: number, unit: Unit): void {

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
    private readonly resident_ = new globalThis.Map<number, Unit>();
    private readonly pinned_ = new Set<number>();
    private readonly disposedSampleSets_ =
        new WeakSet<ElevationStore.SampleSet>();
    private readonly updates_ =
        new globalThis.Map<ElevationStore.SampleSet, SampleUpdate>();

    private sampleSetStates_ =
        new WeakMap<ElevationStore.SampleSet, SampleSetState>();

    // Persists across a store reset: an unchanged set keeps its resolved
    // references and does not repeat coordinate conversion.
    private readonly refs_ =
        new WeakMap<ElevationStore.SampleSet, SampleRefs>();

    // Reused per sample during a scan; holds no state between samples.
    private readonly coordScratch_: [number, number] = [0, 0];

    private preparing_: SampleUpdate[] = [];
    private queue_: SampleUpdate[] = [];
    private inFlight_: InFlight | null = null;

    private usedBytes_ = 0;
    private budgetBytes_: number;
    private deepestLod_ = -1;
    private nextGeneration_ = 0;
    private replacementTile_: [number, number, number] | null = null;
    private replacementDirty_ = false;
    private replacementWatertight_ = false;
    private replacementFailed_ = false;
    private replacementContent_: UnitContent | null = null;
    private sampleSetUpdateRequested_ = false;
    private lastPassTime_ = -Infinity;
    private sourceSignature_: string | null = null;
}


type Unit = {
    handle: ElevationUnits.Unit;
    key: number;
    tileId: [number, number, number];
    generation: number;
    watertight: boolean;
    content: UnitContent | null;
};


type UnitContent = {
    childGenerations: number[];
    rigs: TileRenderRig[];
};


/** One sample set's resolved references, packed in parallel typed arrays
 * over its coordinate order. The unit key and generation record the unit
 * that last answered each coordinate; -1 means none yet. A geographic set
 * also caches the node and node-SRS coordinate its projection resolved,
 * indexed into a small per-set node table; a spatial-division set reads
 * those from the set directly and leaves the geographic fields null. */
type SampleRefs = {
    positions: readonly ElevationStore.Position[] | Float64Array;
    count: number;
    key: Float64Array;
    generation: Int32Array;
    nodes: MapDivisionNode[] | null;
    nodeIndex: Int32Array | null;
    coordX: Float64Array | null;
    coordY: Float64Array | null;
};


type NodeScan = {
    rootLod: number;
    rootGsd: number;
    startLod: number;
    ladders: globalThis.Map<number, (Unit | null)[]>;
};


/** One step of `resolveUnits`'s fine-to-coarse candidate chain for a
 * sample: a unit, where in it, and at what resolution. */
type ResidentUnit = {
    unit: Unit;

    /** Texture coordinates of the sample inside `unit`. */
    u: number;
    v: number;

    /** gsd this unit actually answers at */
    actualGsd: number;
};


/** One sample set's state, retained for as long as its owner — the
 * code holding the `SampleSet` object across repeated
 * `updateTerrainSamples()` calls — keeps it around. The store only
 * releases this when the owner calls `disposeTerrainSamples()`;
 * `sampleSetStates_` is a `WeakMap`, so an owner that never calls it
 * still does not leak once nothing else references the `SampleSet`. */
type SampleSetState = {
    positions: readonly ElevationStore.Position[] | Float64Array;

    /** Sample count this state was validated against. */
    count: number;

    /** `performance.now()` of when update for this set most recently began. */
    updateStarted: number;

    /** The store's unit-publish counter as of `updateStarted`. */
    updateGeneration: number;
};


/** One call to `updateTerrainSamples()`, alive from acceptance until its
 * promise settles. */
type SampleUpdate = {

    sampleSet: ElevationStore.SampleSet;
    refs: SampleRefs;
    desiredGsd: number;

    /** sample count when this update was accepted. */
    count: number;

    /** whether every position must be checked this scan */
    validate: boolean;

    /** how far into the sample set preparation has scanned */
    scanIndex: number;

    /** per-node lookup figures, valid only while this update is the one
     * being prepared */
    nodeScans: globalThis.Map<MapDivisionNode, NodeScan>;

    /** lookups this update has produced, in scan order */
    lookups: Lookup[];

    /** how many of lookups have been submitted to a GPU batch */
    next: number;

    /** how many submitted lookups still await a GPU answer  */
    pending: number;

    /** whether any sample's height or actual gsd changed */
    changed: boolean;

    /** the promise returned by update and its resolution funcs */
    promise: Promise<boolean>;
    resolve: (changed: boolean) => void;
    reject: (reason: unknown) => void;

    /** whether the promise has settled, guarding against settling it
     * twice from separate completion paths */
    settled: boolean;
};

/** One sample's fine-to-coarse candidates, queued for next GPU batch */
type Lookup = {
    update: SampleUpdate;

    /** The sample's index within `update`'s sample set. */
    index: number;
    candidates: ResidentUnit[];
};


/** The one GPU lookup batch currently submitted and awaiting readback;
 * the store keeps at most one in flight at a time. */
type InFlight = {
    readback: ElevationUnits.Readback;
    batch: Lookup[];
};


function unitKey(tileId: readonly number[]): number {

    // Packs the tile id into one exact double, so the ladder walk in
    // `resolveUnits` looks units up without building a key string.
    __DEV__ && tileId[0] > 24 && utils.warnOnce(
        'elevation store: tile LOD above 24 has no distinct unit key');

    return tileId[0] * 0x1000000000000
        + tileId[2] * 0x1000000
        + tileId[1];
}


function makeSampleRefs(
    sampleSet: ElevationStore.SampleSet,
    count: number,
): SampleRefs {

    const geographic = sampleSet.coordinateSpace !== 'spatial-division';

    return {
        positions: sampleSet.positions,
        count,
        key: new Float64Array(count).fill(-1),
        generation: new Int32Array(count).fill(-1),
        nodes: geographic ? [] : null,
        nodeIndex: geographic ? new Int32Array(count).fill(-1) : null,
        coordX: geographic ? new Float64Array(count) : null,
        coordY: geographic ? new Float64Array(count) : null,
    };
}


/** Index of a node in a geographic set's node table, appending it if new.
 * The table holds the few nodes a set's coordinates fall in. */
function internNode(refs: SampleRefs, node: MapDivisionNode): number {

    const nodes = refs.nodes!;
    let index = nodes.indexOf(node);

    if (index < 0) {

        index = nodes.length;
        nodes.push(node);
    }

    return index;
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

        /** Resolved height per position, NaN where no terrain covers it.
         * The store allocates and fills it; callers read it. */
        sampleHeight?: Float32Array;

        /** Ground sample distance each resolved height was taken at. */
        sampleGsd?: Float32Array;

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
}

export default ElevationStore;
