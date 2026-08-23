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


/**
 * A height field over the terrain the map has drawn, answering
 * `Map.queryTerrainElevation`.
 *
 * One unit per resident tile, built by the terrain traversal with an
 * elevation sink and reduced into its ancestors on backtrack. Units
 * stop at the root of each spatial division node that carries tiles: a
 * cell above one of those roots spans nodes in different projected
 * SRSs. A node's root unit is pinned once it has coverage; the rest are
 * evicted least-recently-used against `mapElevationStoreGPUCache`.
 *
 * Coverage is whatever recent passes visited, so a lookup can miss.
 * The store requests no resource of its own, and records one value per
 * sample without which terrain source supplied it.
 *
 * `ElevationUnits` holds the textures and does the drawing; `Map`
 * constructs the store when the reference frame is ready and drives it
 * from the tick.
 */
class ElevationStore {

    /**
     * @param map Typed map owning the store.
     */
    constructor(map: Map) {

        this.map_ = map;
        this.units_ = new ElevationUnits(map.renderer);
        this.sink = new ElevationTerrainSink(this);
        this.budgetBytes_ = this.resolveBudget();

        this.unwatchBudget_ = map.configStore.watch(
            ['mapElevationStoreGPUCache'], () => this.applyBudget());
    }

    /**
     * Returns the terrain height at one position, or at each of an
     * array of positions. A later call can miss where an earlier one
     * succeeded, so callers keep the last answer.
     *
     * @param position navigation-SRS XY, or an array of them
     * @param desiredGsd wanted sample spacing in metres; zero, the
     *     default, asks for the finest unit resident
     * @returns the position with the height appended, or an array of
     *     them in input order
     */
    queryTerrainElevation(
        position: ElevationStore.Position,
        desiredGsd?: number,
    ): Promise<ElevationStore.Sample | undefined>;

    queryTerrainElevation(
        positions: readonly ElevationStore.Position[],
        desiredGsd?: number,
    ): Promise<readonly (ElevationStore.Sample | undefined)[]>;

    queryTerrainElevation(
        input: ElevationStore.Position
            | readonly ElevationStore.Position[],
        desiredGsd = 0,
    ): Promise<unknown> {

        if (!Number.isFinite(desiredGsd) || desiredGsd < 0) {

            return Promise.reject(new RangeError(
                'queryTerrainElevation: desiredGsd must be finite and '
                + 'non-negative.'));
        }

        const single = isPosition(input);
        const positions = single
            ? [input as ElevationStore.Position]
            : (input as readonly ElevationStore.Position[]);

        for (const position of positions) {

            if (!isPosition(position)) {

                return Promise.reject(new TypeError(
                    'queryTerrainElevation: every position must contain '
                    + 'two finite numbers.'));
            }
        }

        if (!single && positions.length === 0)
            return Promise.resolve([]);

        return new Promise((resolve) => {

            const request: Request = {
                positions,
                desiredGsd,
                single,
                results: new Array(positions.length).fill(undefined),
                pending: positions.length,
                next: 0,
                resolve,
            };

            this.requests_.push(request);
        });
    }

    /** Settles completed lookups and submits the next batch. */
    update(): void {

        // A different terrain source list is a different terrain, and the
        // store keeps no record of which source supplied a value.
        const signature = this.map_.surfaceList()
            .map((source) => source.id).join(' ');

        if (signature !== this.sourceSignature_) {

            this.sourceSignature_ = signature;
            this.clear();
        }

        this.collectReadback();
        this.submitChunk();
    }

    /** GPU bytes the store holds, units and fixed buffers together. */
    get usedBytes(): number {

        return this.usedBytes_ + this.units_.fixedBytes;
    }

    /** GPU bytes the store may hold, after the clamp on the setting. */
    get budgetBytes(): number {

        return this.budgetBytes_ + this.units_.fixedBytes;
    }

    /** Whether a population pass should run on this tick. */
    populationDue(): boolean {

        const interval = this.map_.config.mapElevationStoreUpdateIntervalMs;
        const now = performance.now();

        if (now - this.lastPassTime_ < interval) {

            // A miss brings the next pass forward, but no more than one
            // such pass per interval.
            if (!this.onDemandPending_) return false;
            if (now - this.lastOnDemandTime_ < interval) return false;

            this.lastOnDemandTime_ = now;
        }

        this.onDemandPending_ = false;
        this.lastPassTime_ = now;
        return true;
    }

    /** Releases every unit and settles every pending lookup. */
    clear(): void {

        for (const unit of this.resident_.values())
            this.units_.releaseUnit(unit.handle);

        this.resident_.clear();
        this.pinned_.clear();
        this.usedBytes_ = 0;
        this.deepestLod_ = -1;
        this.gsdGrids_.clear();

        this.settlePending();
    }

    /** Releases every store-owned GPU resource. */
    [Symbol.dispose](): void {

        this.unwatchBudget_();
        this.clear();
        this.units_[Symbol.dispose]();
    }

    // -----------------------------------------------------------------
    // Population, driven by the elevation sink
    // -----------------------------------------------------------------

    /**
     * Starts the unit for one node, seeded from its published child
     * units.
     *
     * @param tileId tile address of the node being backtracked
     */
    beginUnit(tileId: [number, number, number]): void {

        this.replacementTile_ = tileId;
        this.replacementDirty_ = false;

        if (!this.withinNodeRoot(tileId)) return;

        this.units_.beginReplacement();

        const children = [0, 1, 2, 3].map((quadrant) =>
            this.resident_.get(unitKey([
                tileId[0] + 1,
                tileId[1] * 2 + (quadrant & 1),
                tileId[2] * 2 + (quadrant >> 1),
            ]))?.handle ?? null);

        if (this.units_.reduceChildren(children))
            this.replacementDirty_ = true;
    }

    /**
     * Adds one ready rig's height to the unit under construction.
     *
     * @param maskTexture coverage already established at this node
     */
    drawUnit(
        tile: MapSurfaceTile,
        rig: TileRenderRig,
        maskTexture?: GpuTexture,
    ): void {

        if (!this.replacementTile_) return;
        if (!this.withinNodeRoot(tile.id)) return;

        const legacyMap = this.map_.map!;

        this.map_.withNavigationCamera(() => this.units_.rasterizeRig(
            rig,
            legacyMap.camera.position,
            this.heightRange(),
            legacyMap.isGeocent,
            maskTexture));

        this.replacementDirty_ = true;
    }

    /**
     * Publishes the unit under construction, or drops it when the node
     * ended up with nothing in it.
     *
     * @param tileId tile address of the completed node
     * @param covered whether the node ended up covered
     */
    endUnit(tileId: [number, number, number], covered: boolean): void {

        const dirty = this.replacementDirty_;

        this.replacementTile_ = null;
        this.replacementDirty_ = false;

        if (!covered || !dirty) return;
        if (!this.withinNodeRoot(tileId)) return;

        const unit = this.admitUnit(tileId);
        if (!unit) return;

        this.units_.publishReplacement(unit.handle);
    }

    /** The sink the map's elevation pass hands to the traversal. */
    readonly sink: ElevationTerrainSink;

    // -----------------------------------------------------------------
    // Unit residency
    // -----------------------------------------------------------------

    /**
     * Returns the unit for a tile, allocating and admitting it against
     * the memory budget when it is not resident. Null when the budget
     * cannot hold it, which skips the tile until a later pass.
     */
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
        };

        this.resident_.set(key, unit);
        this.usedBytes_ += unitBytes;
        this.deepestLod_ = Math.max(this.deepestLod_, tileId[0]);

        // A node's own root unit is the coarsest field that node will
        // ever hold, so it stays resident once it has coverage.
        if (this.isNodeRoot(tileId)) this.pinned_.add(key);

        return unit;
    }

    /**
     * Takes the budget from the setting again and releases whatever no
     * longer fits. Called when `mapElevationStoreGPUCache` changes.
     */
    private applyBudget(): void {

        this.budgetBytes_ = this.resolveBudget();

        while (this.usedBytes_ > this.budgetBytes_) {

            if (!this.evictOne()) return;
        }
    }

    /**
     * Removes one field to make room.
     *
     * A field remains while any resident child reduces into it.
     *
     * @returns false when every resident field is pinned
     */
    private evictOne(): boolean {

        // resident_ iterates least recently touched first. A parent stays
        // until its resident children are gone, preserving the reduced
        // hierarchy while detail is discarded.
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
            return true;
        }

        return false;
    }

    /** Moves a unit to the recent end of the eviction order. */
    private touch(key: string, unit: Unit): void {

        this.resident_.delete(key);
        this.resident_.set(key, unit);
    }




    // -----------------------------------------------------------------
    // Lookup
    // -----------------------------------------------------------------

    /**
     * Submits the next batch of queued positions. Only one chunk is in
     * flight, so calls that arrive meanwhile join the next batch.
     */
    private submitChunk(): void {

        if (this.inFlight_) return;
        if (this.requests_.length === 0) return;

        const columns = this.collectColumns();
        if (columns.length === 0) return;

        let readback: ElevationUnits.Readback | null = null;

        try {

            readback = this.drawChunk(columns);

        } catch (error) {

            console.error('elevation lookup failed', error);
        }

        this.inFlight_ = readback ? { readback, columns } : null;

        // A batch whose read cannot be observed is reported as uncovered
        // rather than left unsettled.
        if (!readback) this.completeColumns(columns, null);
    }

    /**
     * Draws one batch into the result target and starts its read.
     *
     * @returns the handle its result arrives on, or null when the read
     *     could not be observed
     */
    private drawChunk(
        columns: readonly LookupColumn[],
    ): ElevationUnits.Readback | null {

        let maxPreference = 0;

        for (const column of columns)
            maxPreference =
                Math.max(maxPreference, column.units.length - 1);

        // one draw per unit, so every position asking it is answered
        // while it is bound
        const groups = new globalThis.Map<Unit, ElevationUnits.LookupPoint[]>();

        for (let index = 0; index < columns.length; index++) {

            const column = columns[index];

            for (let rank = 0; rank < column.units.length; rank++) {

                const resident = column.units[rank];
                let group = groups.get(resident.unit);

                if (!group) {

                    group = [];
                    groups.set(resident.unit, group);
                }

                group.push({
                    column: index,
                    u: resident.u,
                    v: resident.v,
                    preference: rank,
                });
            }
        }

        this.units_.beginLookup(maxPreference);

        for (const [unit, points] of groups)
            this.units_.drawLookupGroup(unit.handle, points);

        return this.units_.endLookup(columns.length);
    }

    /**
     * Takes as many queued positions as one result target holds and
     * resolves each to its ordered list of resident units.
     */
    private collectColumns(): LookupColumn[] {

        const columns: LookupColumn[] = [];

        while (this.requests_.length > 0
                && columns.length < this.units_.maxBatch) {

            const request = this.requests_[0];

            while (request.next < request.positions.length
                    && columns.length < this.units_.maxBatch) {

                const index = request.next++;

                columns.push({
                    request,
                    index,
                    units: this.resolveUnits(
                        request.positions[index], request.desiredGsd),
                });
            }

            if (request.next < request.positions.length) break;
            this.requests_.shift();
        }

        return columns;
    }

    /**
     * Orders the resident units on one position's tile path, best answer
     * first.
     *
     * The position belongs to one spatial division node, which fixes the
     * tile it falls in at every LOD; the units resident on that path are
     * what can answer, and the GPU takes the first of them that covers
     * the position. A request of zero runs finest to coarsest. A
     * positive request starts at the closest spacing at or above it and
     * grows coarser, down to the node root.
     *
     * Reduction renormalizes over the valid child samples, so a covered
     * sample is covered in every ancestor. A unit finer than the request
     * can therefore only answer where the coarser ones already did, and
     * the one case the request cannot meet — a request coarser than the
     * root's own spacing — is answered by the root.
     */
    private resolveUnits(
        position: ElevationStore.Position,
        desiredGsd: number,
    ): ResidentUnit[] {

        const refFrame = this.map_.map?.referenceFrame;
        if (!refFrame) return [];

        const owners = refFrame.resolveSpatialDivisionNodes(
            [position[0], position[1], 0]).filter(
            (entry) => productiveNode(entry.node));

        if (owners.length === 0) return [];

        const node = owners[0].node;
        const coords = owners[0].coords;

        const metresPerUnit = this.metresPerUnit(node, coords);
        if (!(metresPerUnit > 0)) return [];

        const rootSpacing = nodeRootSpacing(node);
        const resident: ResidentUnit[] = [];
        const uv: number[] = [0, 0];

        for (let lod = node.id[0]; lod <= this.deepestLod_; lod++) {

            const tileId = refFrame.getNodeTileAt(node, coords, lod, uv);

            const unit = this.resident_.get(unitKey(tileId));
            if (!unit) continue;

            const nominal = rootSpacing / Math.pow(2, lod - node.id[0]);

            resident.push({
                unit,
                u: uv[0],
                v: uv[1],
                actualGsd: nominal * metresPerUnit,
            });
        }

        // the walk produced coarsest first; a request of zero wants the
        // finest covered unit
        resident.reverse();

        if (desiredGsd === 0) return resident;

        const meets = resident.filter((r) => r.actualGsd >= desiredGsd);

        // every resident unit is finer than the request, so the coarsest
        // is as close as the store comes to it
        return meets.length > 0 ? meets : resident.slice(-1);
    }

    /** Copies a completed batch out of its pixel-pack buffer. */
    private collectReadback(): void {

        const inFlight = this.inFlight_;
        if (!inFlight) return;

        const results = this.units_.pollReadback(inFlight.readback);
        if (!results) return;

        this.inFlight_ = null;
        this.completeColumns(inFlight.columns, results);
    }

    /**
     * Turns one batch's result rows into samples and settles every
     * request whose positions are all accounted for.
     *
     * @param columns the batch's columns, in result-target order
     * @param results the two result rows, or null when the read could
     *     not be observed
     */
    private completeColumns(
        columns: readonly LookupColumn[],
        results: DataView | null,
    ): void {

        const heightRow = 0;

        // A row is columns.length pixels wide: exactly what this
        // batch's submission read back, not the target's full width.
        const preferenceRow = columns.length * 4;

        for (let index = 0; index < columns.length; index++) {

            const column = columns[index];
            let sample: ElevationStore.Sample | undefined;
            let rank = -1;

            if (results) {

                const height =
                    results.getFloat32(heightRow + index * 4, true);
                const preference =
                    results.getFloat32(preferenceRow + index * 4, true);

                if (!Number.isNaN(height) && !Number.isNaN(preference)) {

                    rank = Math.round(preference);
                    const resident = column.units[rank];

                    if (resident) {

                        const position = column.request.positions[
                            column.index];

                        sample = {
                            position: [position[0], position[1], height],
                            actualGsd: resident.actualGsd,
                        };
                    }
                }
            }

            // A miss, or an answer taken from a coarser unit than the
            // request, means the covered field has fallen behind the
            // camera and a pass is due sooner than the interval.
            if (rank !== 0) this.onDemandPending_ = true;

            // a successful lookup keeps its unit at the recent end of
            // the eviction order
            if (sample && rank >= 0) {

                const unit = column.units[rank].unit;
                if (this.resident_.get(unit.key) === unit)
                    this.touch(unit.key, unit);
            }

            this.settleColumn(column, sample);
        }
    }

    /** Records one column's result and settles its request when full. */
    private settleColumn(
        column: LookupColumn,
        sample: ElevationStore.Sample | undefined,
    ): void {

        const request = column.request;

        request.results[column.index] = sample;
        request.pending--;

        if (request.pending > 0) return;

        request.resolve(request.single
            ? request.results[0]
            : request.results);
    }

    /**
     * Settles every queued and in-flight lookup as uncovered. Clearing
     * or disposing the store must leave no query promise unsettled.
     */
    private settlePending(): void {

        const inFlight = this.inFlight_;

        if (inFlight) {

            this.units_.dropReadback(inFlight.readback);
            this.inFlight_ = null;
            this.completeColumns(inFlight.columns, null);
        }

        for (const request of this.requests_.splice(0)) {

            request.resolve(request.single
                ? undefined
                : new Array(request.positions.length).fill(undefined));
        }
    }

    // -----------------------------------------------------------------
    // Reference-frame geometry
    // -----------------------------------------------------------------

    /** Projection factor at a position, interpolated on the node's grid. */
    private metresPerUnit(
        node: MapDivisionNode,
        coords: readonly number[],
    ): number {

        const key = nodeKey(node);
        let grid = this.gsdGrids_.get(key);

        if (!grid) {

            grid = this.buildGsdGrid(node);
            this.gsdGrids_.set(key, grid);
        }

        if (!grid) return 0;

        const size = grid.size;
        const ll = node.extents.ll;
        const ur = node.extents.ur;

        const fx = (coords[0] - ll[0]) / (ur[0] - ll[0]) * (size - 1);
        const fy = (coords[1] - ll[1]) / (ur[1] - ll[1]) * (size - 1);

        const ix = Math.min(Math.max(Math.floor(fx), 0), size - 2);
        const iy = Math.min(Math.max(Math.floor(fy), 0), size - 2);

        const tx = Math.min(Math.max(fx - ix, 0), 1);
        const ty = Math.min(Math.max(fy - iy, 0), 1);

        const values = grid.values;
        const v00 = values[iy * size + ix];
        const v10 = values[iy * size + ix + 1];
        const v01 = values[(iy + 1) * size + ix];
        const v11 = values[(iy + 1) * size + ix + 1];

        return (v00 * (1 - tx) + v10 * tx) * (1 - ty)
            + (v01 * (1 - tx) + v11 * tx) * ty;
    }

    /**
     * Builds a node's grid of projection factors.
     *
     * `proj4` does not expose projection factors in the browser, so the
     * areal scale comes from a numerical Jacobian of the transform into
     * physical coordinates. A grid sample outside the projection domain
     * takes the value of the closest sample that could be evaluated;
     * a node where none can is left without a grid and answers no query.
     */
    private buildGsdGrid(node: MapDivisionNode): GsdGrid | null {

        const size = Math.max(
            2, Math.round(this.map_.config.mapElevationStoreGsdGridSize));

        const ll = node.extents.ll;
        const ur = node.extents.ur;

        const width = ur[0] - ll[0];
        const height = ur[1] - ll[1];

        // one metre in this SRS's own units, kept well inside the node
        const unitMetres = node.srs.getSrsInfo()['unitMetres'] || 1;
        const stepX = Math.min(1 / unitMetres, width / 4);
        const stepY = Math.min(1 / unitMetres, height / 4);

        const values = new Float64Array(size * size);
        let anyFinite = false;

        for (let j = 0; j < size; j++) {

            const y = ll[1] + height * (j / (size - 1));

            for (let i = 0; i < size; i++) {

                const x = ll[0] + width * (i / (size - 1));

                const value = arealScale(
                    node, x, y,
                    i === 0 ? stepX : (i === size - 1 ? -stepX : stepX),
                    j === 0 ? stepY : (j === size - 1 ? -stepY : stepY),
                    i > 0 && i < size - 1, j > 0 && j < size - 1);

                values[j * size + i] = value;
                if (Number.isFinite(value) && value > 0) anyFinite = true;
            }
        }

        if (!anyFinite) return null;

        fillFromNearest(values, size);
        return { size, values };
    }

    /** The reference frame's declared height range. */
    private heightRange(): [number, number] {

        const range = this.map_.map!.referenceFrame!.getGlobalHeightRange();
        return [range[0], range[1]];
    }

    /** Whether a tile lies at or below some spatial division node root. */
    private withinNodeRoot(tileId: readonly number[]): boolean {

        return this.nodeRootOf(tileId) !== null;
    }

    /** Whether a tile is itself a spatial division node root. */
    private isNodeRoot(tileId: readonly number[]): boolean {

        const node = this.nodeRootOf(tileId);
        return node !== null && node.id[0] === tileId[0];
    }

    /**
     * The productive spatial division node whose subtree contains a
     * tile, or null for a tile above every such node.
     *
     * Subtrees nest, so the deepest match is the owner: a manual node's
     * children are themselves subtree roots, and a tile below one of
     * them belongs to that child.
     */
    private nodeRootOf(tileId: readonly number[]): MapDivisionNode | null {

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

    /**
     * The GPU budget in bytes, clamped up to what the parsed reference
     * frame needs: the fixed work buffers plus one pinned unit for every
     * spatial division node root. A configured value below that is
     * written back so the reported setting matches the effective one.
     */
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

        this.map_.configStore.set({
            mapElevationStoreGPUCache: Math.ceil(minimum / (1024 * 1024)),
        });

        return minimum - fixed;
    }

    // -----------------------------------------------------------------
    // Private fields
    // -----------------------------------------------------------------

    private readonly map_: Map;

    /** The unit textures and the draws that fill and read them. */
    private readonly units_: ElevationUnits;

    /** Published units, keyed by tile id, in eviction order. */
    private readonly resident_ = new globalThis.Map<string, Unit>();

    /** Keys of node-root units, which eviction never takes. */
    private readonly pinned_ = new Set<string>();

    private usedBytes_ = 0;
    private budgetBytes_: number;

    /** Deepest LOD any resident unit holds; bounds the tile-path walk. */
    private deepestLod_ = -1;

    /** Projection-factor grids, one per node. */
    private readonly gsdGrids_ =
        new globalThis.Map<string, GsdGrid | null>();

    private replacementTile_: [number, number, number] | null = null;
    private replacementDirty_ = false;

    private lastPassTime_ = -Infinity;
    private lastOnDemandTime_ = -Infinity;
    private onDemandPending_ = false;

    /** Ends the subscription that keeps the budget current. */
    private readonly unwatchBudget_: () => void;

    /** Terrain source ids the resident units were built from. */
    private sourceSignature_: string | null = null;

    private readonly requests_: Request[] = [];
    private inFlight_: InFlight | null = null;

}


/** One resident tile's height field. */
type Unit = {
    handle: ElevationUnits.Unit;
    key: string;
    tileId: [number, number, number];
};


/** One resident unit on a queried position's tile path. */
type ResidentUnit = {
    unit: Unit;
    u: number;
    v: number;
    actualGsd: number;
};


/** One queried position and the units that may answer it. */
type LookupColumn = {
    request: Request;
    index: number;
    units: ResidentUnit[];
};


/** One caller's outstanding query. */
type Request = {
    positions: readonly ElevationStore.Position[];
    desiredGsd: number;
    single: boolean;
    results: (ElevationStore.Sample | undefined)[];
    pending: number;
    next: number;
    resolve: (value: unknown) => void;
};


/** A submitted batch waiting on its read. */
type InFlight = {
    readback: ElevationUnits.Readback;
    columns: LookupColumn[];
};


/** One node's grid of projection factors. */
type GsdGrid = {
    size: number;
    values: Float64Array;
};


/** Intervals between the two edges of a tile. */
const SampleSpan = 255;


function unitKey(tileId: readonly number[]): string {

    return `${tileId[0]}/${tileId[1]}/${tileId[2]}`;
}


function nodeKey(node: MapDivisionNode): string {

    return unitKey(node.id);
}


function isPosition(value: unknown): boolean {

    return Array.isArray(value)
        && value.length >= 2
        && Number.isFinite(value[0])
        && Number.isFinite(value[1]);
}


/**
 * Whether a spatial division node carries tiles of its own.
 *
 * A manual node routes its children into new subtrees that each own a
 * projected SRS, so its own cells span several of them; `none` and
 * `barren` nodes carry no data either. The store follows the tile
 * hierarchy only where one projected SRS holds for the whole cell.
 */
function productiveNode(node: MapDivisionNode): boolean {

    const partitioning = node.partitioning;

    if (partitioning && typeof partitioning === 'object') return false;

    return partitioning !== 'none' && partitioning !== 'barren';
}


/** Nominal sample spacing of a node's root unit, in node SRS units. */
function nodeRootSpacing(node: MapDivisionNode): number {

    const ll = node.extents.ll;
    const ur = node.extents.ur;

    return Math.sqrt((ur[0] - ll[0]) * (ur[1] - ll[1])) / SampleSpan;
}


/**
 * The projection factor at one point: metres per SRS unit, from the
 * cross product of the two partial derivatives of the transform into
 * physical coordinates. Interior samples use centred differences; a
 * boundary sample uses an inward one-sided difference, so no evaluation
 * leaves the node.
 */
function arealScale(
    node: MapDivisionNode,
    x: number,
    y: number,
    stepX: number,
    stepY: number,
    centredX: boolean,
    centredY: boolean,
): number {

    const at = (px: number, py: number): number[] | null => {

        try {

            const point = node.getPhysicalCoords([px, py, 0], true);
            if (!point || !Number.isFinite(point[0])) return null;
            return point;

        } catch (error) {

            return null;
        }
    };

    const derivative = (
        dx: number, dy: number, step: number, centred: boolean,
    ): number[] | null => {

        const forward = at(x + dx, y + dy);
        const back = centred ? at(x - dx, y - dy) : at(x, y);

        if (!forward || !back) return null;

        const span = centred ? 2 * step : step;

        return [
            (forward[0] - back[0]) / span,
            (forward[1] - back[1]) / span,
            (forward[2] - back[2]) / span,
        ];
    };

    const du = derivative(stepX, 0, stepX, centredX);
    const dv = derivative(0, stepY, stepY, centredY);

    if (!du || !dv) return NaN;

    const cross = [
        du[1] * dv[2] - du[2] * dv[1],
        du[2] * dv[0] - du[0] * dv[2],
        du[0] * dv[1] - du[1] * dv[0],
    ];

    return Math.sqrt(Math.hypot(cross[0], cross[1], cross[2]));
}


/** Replaces every non-finite grid value with the closest finite one. */
function fillFromNearest(values: Float64Array, size: number): void {

    for (let j = 0; j < size; j++) {

        for (let i = 0; i < size; i++) {

            const value = values[j * size + i];
            if (Number.isFinite(value) && value > 0) continue;

            let best = NaN;
            let bestDistance = Infinity;

            for (let sj = 0; sj < size; sj++) {

                for (let si = 0; si < size; si++) {

                    const other = values[sj * size + si];
                    if (!Number.isFinite(other) || other <= 0) continue;

                    const distance =
                        (si - i) * (si - i) + (sj - j) * (sj - j);

                    if (distance >= bestDistance) continue;

                    best = other;
                    bestDistance = distance;
                }
            }

            values[j * size + i] = best;
        }
    }
}


namespace ElevationStore {

    /** A position to look up, in the meaning of section 3.1 of RFC 13. */
    export type Position = readonly [number, number];

    /** One answered lookup. */
    export type Sample = {

        /** The queried position with the stored height appended. */
        position: readonly [number, number, number];

        /**
         * Horizontal spacing, in physical metres, of the samples that
         * answered. It says nothing about vertical reliability.
         */
        actualGsd: number;
    };
}

export default ElevationStore;
