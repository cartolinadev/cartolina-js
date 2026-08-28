/*
 * geodata-heightcoder.ts - view-owned geodata heightcoding
 */

import type Map from './map';


/** Heightcodes one geodata view from one retained terrain sample set. */
class MapGeodataHeightcoder {

    constructor(map: Map, source: unknown) {

        this.map_ = map;
        this.source_ = parseGeodata(source);

        const legacyMap = map.map;
        if (!this.source_ || !legacyMap) return;

        const navSrs = legacyMap.getNavigationSrs();
        const physSrs = legacyMap.getPhysicalSrs();

        for (const group of this.source_.groups) {

            const physicalCoords = readPhysicalCoords(group);
            const metadata = group.heightcoding;
            const records: CoordinateRecord[] = [];

            for (let index = 0; index < physicalCoords.length; index++) {

                const physical = physicalCoords[index];
                const supplied = metadata?.[index];

                if (metadata && !supplied) {

                    records.push({ physical });
                    continue;
                }

                const nav = supplied
                    ? [supplied[0], supplied[1], supplied[2]]
                    : navSrs.convertCoordsFrom(physical, physSrs);

                const sampleIndex = this.positions_.length;

                this.positions_.push([nav[0], nav[1]]);
                this.legacyHeights_.push(supplied ? undefined : nav[2]);
                this.refreshCounts_.push(0);
                records.push({
                    physical,
                    source: [nav[0], nav[1]],
                    offset: supplied ? supplied[2] : 0,
                    sampleIndex,
                });
            }

            this.groups_.push(records);
        }

        this.sampleSet_ = {
            positions: this.positions_,
            desiredGsd: 0,
        };

        this.renderData_ = cloneGeodata(this.source_);
    }

    /** Geometry containing the latest store heights. */
    get geodata(): Geodata | null {

        return this.renderData_;
    }

    /** Updates this view's retained sample set at its current nominal gsd. */
    update(desiredGsd: number): Promise<boolean> {

        const sampleSet = this.sampleSet_;
        if (!sampleSet || this.disposed_) return Promise.resolve(false);

        sampleSet.desiredGsd = desiredGsd;
        if (this.update_) return this.update_;

        const previous = sampleSet.samples?.slice() ?? [];

        this.update_ = this.map_.updateTerrainSamples(sampleSet)
            .then((changed) => {

                if (!changed || this.disposed_) return false;

                const samples = sampleSet.samples ?? [];

                for (let index = 0; index < samples.length; index++)
                    if (samples[index] !== previous[index])
                        this.refreshCounts_[index]++;

                this.rebuild();
                return true;
            })
            .finally(() => { this.update_ = null; });

        return this.update_;
    }

    /** Values read by the optional report from this same live view. */
    report(): MapGeodataHeightcoder.Report {

        const samples = this.sampleSet_?.samples ?? [];
        const gsds: number[] = [];
        const differences: number[] = [];
        let covered = 0;
        let refreshes = 0;

        for (let index = 0; index < this.positions_.length; index++) {

            refreshes += this.refreshCounts_[index];

            const sample = samples[index];
            if (!sample) continue;

            covered++;
            gsds.push(sample.actualGsd);

            const legacyHeight = this.legacyHeights_[index];
            if (legacyHeight !== undefined)
                differences.push(sample.height - legacyHeight);
        }

        return {
            coordinates: this.positions_.length,
            covered,
            refreshes,
            gsds,
            differences,
        };
    }

    /** Prevents an outstanding readback from writing into a dead view. */
    dispose(): void {

        if (this.disposed_) return;
        this.disposed_ = true;

        if (this.sampleSet_)
            this.map_.disposeTerrainSamples(this.sampleSet_);
    }

    private rebuild(): void {

        const source = this.source_;
        const sampleSet = this.sampleSet_;
        const legacyMap = this.map_.map;

        if (!source || !sampleSet || !legacyMap) return;

        const result = this.renderData_ ?? cloneGeodata(source);
        const navSrs = legacyMap.getNavigationSrs();
        const physSrs = legacyMap.getPhysicalSrs();
        const samples = sampleSet.samples ?? [];

        for (let groupIndex = 0;
                groupIndex < this.groups_.length;
                groupIndex++) {

            const physicalCoords: number[][] = [];

            for (const record of this.groups_[groupIndex]) {

                const sample = record.sampleIndex === undefined
                    ? undefined : samples[record.sampleIndex];

                if (!sample || !record.source) {

                    physicalCoords.push(record.physical);
                    continue;
                }

                physicalCoords.push(physSrs.convertCoordsFrom([
                    record.source[0],
                    record.source[1],
                    sample.height + (record.offset ?? 0),
                ], navSrs));
            }

            writePhysicalCoords(result.groups[groupIndex], physicalCoords);
        }

        this.renderData_ = result;
    }

    private readonly map_: Map;
    private readonly source_: Geodata | null;
    private readonly positions_: [number, number][] = [];
    private readonly legacyHeights_: (number | undefined)[] = [];
    private readonly refreshCounts_: number[] = [];
    private readonly groups_: CoordinateRecord[][] = [];

    private sampleSet_: SampleSet | null = null;
    private renderData_: Geodata | null = null;
    private update_: Promise<boolean> | null = null;
    private disposed_ = false;
}


type SampleSet = {
    positions: readonly [number, number][];
    desiredGsd: number;
    samples?: (Sample | undefined)[];
};


type Sample = {
    height: number;
    actualGsd: number;
    unit: unknown;
};


type CoordinateRecord = {
    physical: number[];
    source?: [number, number];
    offset?: number;
    sampleIndex?: number;
};


type Geodata = {
    groups: GeodataGroup[];
};


type GeodataGroup = {
    bbox: [number[], number[]];
    resolution: number;
    points?: { points?: number[][] }[];
    lines?: { lines?: number[][][] }[];
    polygons?: { vertices?: number[] }[];
    heightcoding?: ([number, number, number] | null)[];
};


type JsonValue =
    | null
    | boolean
    | number
    | string
    | JsonValue[]
    | { [key: string]: JsonValue };


function parseGeodata(source: unknown): Geodata | null {

    let value = source;

    if (source instanceof ArrayBuffer) {

        value = new TextDecoder().decode(source);

    } else if (ArrayBuffer.isView(source)) {

        value = new TextDecoder().decode(source);
    }

    if (typeof value === 'string') {

        try {

            value = JSON.parse(value) as JsonValue;

        } catch (error) {

            return null;
        }
    }

    if (!value || typeof value !== 'object') return null;

    const geodata = value as Partial<Geodata>;
    return Array.isArray(geodata.groups) ? geodata as Geodata : null;
}


function cloneGeodata(geodata: Geodata): Geodata {

    return structuredClone(geodata);
}


function readPhysicalCoords(group: GeodataGroup): number[][] {

    const bbox = group.bbox;
    const resolution = group.resolution;

    if (!bbox || !resolution) return [];

    const min = bbox[0];
    const max = bbox[1];
    const scale = [
        (max[0] - min[0]) / resolution,
        (max[1] - min[1]) / resolution,
        (max[2] - min[2]) / resolution,
    ];
    const result: number[][] = [];

    visitCoords(group, (point) => result.push([
        min[0] + point[0] * scale[0],
        min[1] + point[1] * scale[1],
        min[2] + point[2] * scale[2],
    ]));

    return result;
}


function writePhysicalCoords(
    group: GeodataGroup,
    physicalCoords: readonly number[][],
): void {

    if (physicalCoords.length === 0) return;

    const min = physicalCoords[0].slice();
    const max = physicalCoords[0].slice();

    for (const point of physicalCoords) {
        for (let axis = 0; axis < 3; axis++) {
            min[axis] = Math.min(min[axis], point[axis]);
            max[axis] = Math.max(max[axis], point[axis]);
        }
    }

    const resolution = group.resolution;
    const scale = [
        resolution / ((max[0] - min[0]) + 1),
        resolution / ((max[1] - min[1]) + 1),
        resolution / ((max[2] - min[2]) + 1),
    ];
    let index = 0;

    visitCoords(group, (point, flat, offset) => {
        const physical = physicalCoords[index++];

        for (let axis = 0; axis < 3; axis++)
            if (flat && offset !== undefined)
                flat[offset + axis] = Math.round(
                    (physical[axis] - min[axis]) * scale[axis]);
            else
                point[axis] = Math.round(
                    (physical[axis] - min[axis]) * scale[axis]);
    });

    group.bbox = [min, max];
}


function visitCoords(
    group: GeodataGroup,
    visit: (point: number[], flat?: number[], offset?: number) => void,
): void {

    for (const feature of group.points ?? [])
        for (const point of feature.points ?? []) visit(point);

    for (const feature of group.lines ?? [])
        for (const line of feature.lines ?? [])
            for (const point of line) visit(point);

    for (const feature of group.polygons ?? []) {

        const vertices = feature.vertices ?? [];

        for (let index = 0; index + 2 < vertices.length; index += 3) {
            visit(vertices.slice(index, index + 3), vertices, index);
        }
    }
}


namespace MapGeodataHeightcoder {

    export type Report = {
        coordinates: number;
        covered: number;
        refreshes: number;
        gsds: number[];
        differences: number[];
    };
}


export default MapGeodataHeightcoder;
