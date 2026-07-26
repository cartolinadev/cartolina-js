/*
 * pre-v6-watertight.ts - infer watertight flags for pre-v6 metatiles.
 */

import type MapSurfaceTile from './surface-tile';
import type MapMetanode from './metanode';

type MeshArray = Uint16Array | Float32Array;

type SrsLike = {
    convertCoordsTo(
        coords: number[],
        srs: SrsLike,
        skipVerticalAdjust?: boolean,
    ): number[];
};

type ExtentsLike = { ll: number[]; ur: number[] };

/** Spatial division node fields consumed by the valid-area test; the
 *  runtime object is the untyped MapDivisionNode. `preV6Constraint`
 *  caches the resolved partition constraint on the node. */
type DivisionNodeLike = {
    id: number[];
    srs: SrsLike;
    extents: ExtentsLike;
    partitioning: unknown;
    preV6Constraint?: PartitionConstraint | null;
};

/** One subtree's partition range: extents in the SRS of the manually
 *  partitioned parent division node. */
type PartitionConstraint = { ll: number[]; ur: number[]; srs: SrsLike };

/**
 * Width and height of the coverage grid each submesh footprint is
 * rasterized into. 128 samples per axis resolve the real gaps in a
 * footprint (courtyards, data cuts) while staying cheap enough to run on
 * every pre-v6 submesh during parsing. A gap narrower than one grid cell
 * (about the tile width divided by 128) is not sampled and so is not
 * resolved.
 */
const COVERAGE_RESOLUTION = 128;

/**
 * Mutable parse-time state for one rasterized full-cell coverage test.
 * Each parsed face is rasterized into `grid`; the tile fully covers its
 * cell when every grid sample ends up set.
 */
export type CoverageAccumulator = {
    grid: Uint8Array;
    externalUVs: MeshArray;
    gridScale: number;
};

/**
 * Starts a rasterized full-cell coverage test for one submesh.
 *
 * @param externalUVs Vertex-indexed external UVs from the mesh parser.
 * @param enabled Whether the owning metatile is a pre-v6 metatile.
 * @returns An accumulator, or null when the compatibility test is disabled.
 */
export function createFullCoverageAccumulator(
    externalUVs: MeshArray | true | null | undefined,
    enabled: boolean,
): CoverageAccumulator | null {

    if (!enabled || !externalUVs || externalUVs === true) return null;

    // 16-bit submeshes span the cell as integers across 0..65535; float
    // submeshes use the normalized 0..1 cell. Scaling both onto the grid
    // lets the rasterizer treat them identically.
    const cellRange = externalUVs instanceof Uint16Array ? 65536 : 1;

    return {
        grid: new Uint8Array(COVERAGE_RESOLUTION * COVERAGE_RESOLUTION),
        externalUVs,
        gridScale: COVERAGE_RESOLUTION / cellRange,
    };
}

/**
 * Adds one indexed face to a full-cell coverage test by rasterizing its
 * triangle into the coverage grid.
 *
 * @param acc Accumulator returned by `createFullCoverageAccumulator`.
 * @param v1 First vertex index.
 * @param v2 Second vertex index.
 * @param v3 Third vertex index.
 */
export function addCoverageFace(
    acc: CoverageAccumulator | null,
    v1: number,
    v2: number,
    v3: number,
): void {

    if (!acc) return;

    rasterizeTriangle(acc, v1, v2, v3);
}

/**
 * Finishes the coverage test for one parsed submesh.
 *
 * @param acc Accumulator returned by `createFullCoverageAccumulator`.
 * @returns True when the rasterized footprint leaves no grid sample
 *     uncovered.
 */
export function finishFullCoverage(acc: CoverageAccumulator | null): boolean {

    if (!acc) return false;

    // a single uncovered sample is a gap in the footprint, so the tile
    // does not fully cover its cell
    const grid = acc.grid;
    for (let index = 0; index < grid.length; index++)
        if (grid[index] === 0) return false;

    return true;
}

/**
 * Marks a pre-v6 tile watertight when any parsed submesh covers its cell.
 *
 * @param tile Tile whose mesh has just become drawable.
 * @returns True when this call changed the metanode flag.
 */
export function inferPreV6WatertightFromTile(tile: MapSurfaceTile): boolean {

    const node = tile.metanode;
    if (!node || node.watertight || node.metatile.version >= 6) return false;

    const mesh = tile.surfaceMesh;
    if (!mesh || !Array.isArray(mesh.submeshes)) return false;

    for (const submesh of mesh.submeshes) {

        if (submesh.inferredFullCoverage === true) {

            node.watertight = true;
            return true;
        }
    }

    return false;
}

/**
 * Marks a pre-v6 parent mesh watertight from its loaded watertight
 * children. A coherent terrain pyramid lets complete child cells
 * establish full coverage for a parent that declares its own geometry.
 * A child missing because its cell lies completely outside the
 * reference frame's valid (partitioned) area is exempt: nothing is
 * ever served there and the parent mesh is clipped to the same
 * boundary.
 *
 * @param tile Parent tile checked on traversal backtrack.
 * @returns True when this call changed the metanode flag.
 */
export function inferPreV6WatertightFromChildren(
    tile: MapSurfaceTile,
): boolean {

    const node = tile.metanode;
    if (!node || node.watertight || node.metatile.version >= 6) return false;
    if (!node.hasGeometry()) return false;
    if (!node.hasChildren()) return false;

    for (let quadrant = 0; quadrant < 4; quadrant++) {

        if (!node.hasChild(quadrant)) {

            if (quadrantOutsideValidArea(tile, quadrant)) continue;
            return false;
        }

        const child = tile.children[quadrant];
        const childNode = child?.metanode;

        if (!childNode || !childNode.watertight) return false;
    }

    node.watertight = true;
    return true;
}


/**
 * Samples per axis of the lattice a missing child's cell is tested
 * on against its subtree's partition range. Samples sit half a step
 * inside the cell edges, so a cell only touching the partition
 * boundary along an edge still reads as outside; an intersection the
 * lattice can miss is narrower than a sixteenth of the cell.
 */
const VALID_AREA_SAMPLES = 8;

/**
 * Resolves (and caches on the division node) the subtree's partition
 * range: the extents its manually partitioned parent division node
 * assigns to this subtree, in the parent's SRS. Null when the parent
 * does not exist or does not partition manually — then the subtree
 * has no constraint and every missing child counts.
 */
function subtreeConstraint(
    tile: MapSurfaceTile,
    division: DivisionNodeLike,
): PartitionConstraint | null {

    if (division.preV6Constraint !== undefined) {
        return division.preV6Constraint;
    }

    let constraint: PartitionConstraint | null = null;
    const nodes = (tile.map.referenceFrame as {
        getSpatialDivisionNodes(): DivisionNodeLike[];
    }).getSpatialDivisionNodes();

    for (const parent of nodes) {

        if (parent.id[0] !== division.id[0] - 1
            || parent.id[1] !== (division.id[1] >> 1)
            || parent.id[2] !== (division.id[2] >> 1)) continue;

        const partitioning = parent.partitioning;
        if (!partitioning || typeof partitioning !== 'object') break;

        // partition ranges are keyed by the child's position under
        // the parent: '<x><y>' with each coordinate 0 or 1
        const key = '' + (division.id[1] & 1) + (division.id[2] & 1);
        const extents =
            (partitioning as Record<string, ExtentsLike>)[key];

        if (extents && extents.ll && extents.ur) {
            constraint = {
                ll: extents.ll, ur: extents.ur, srs: parent.srs,
            };
        }
        break;
    }

    division.preV6Constraint = constraint;
    return constraint;
}

/**
 * Tests whether one missing child's cell lies completely outside the
 * subtree's partition range. The four-bit result for all quadrants is
 * computed once and cached on the metanode.
 */
function quadrantOutsideValidArea(
    tile: MapSurfaceTile,
    quadrant: number,
): boolean {

    const node = tile.metanode as MapMetanode;
    const division = node.divisionNode as DivisionNodeLike | null;
    if (!division) return false;

    let mask = node.preV6InvalidChildMask;
    if (mask === undefined) {

        mask = 0;
        const constraint = subtreeConstraint(tile, division);
        if (constraint) {
            for (let q = 0; q < 4; q++) {
                if (childCellOutside(node, division, constraint, q)) {
                    mask |= 1 << q;
                }
            }
        }
        node.preV6InvalidChildMask = mask;
    }

    return (mask & (1 << quadrant)) !== 0;
}

/**
 * Rasterized point-sampling test of one child cell against the
 * partition range: every lattice sample is converted from the
 * division node's SRS into the constraint's SRS and compared with the
 * constraint extents. A sample that converts poorly (error or NaN) is
 * treated as inside, keeping the test conservative.
 */
function childCellOutside(
    node: MapMetanode,
    division: DivisionNodeLike,
    constraint: PartitionConstraint,
    quadrant: number,
): boolean {

    const childLod = node.id[0] + 1;
    const childX = node.id[1] * 2 + (quadrant & 1);
    const childY = node.id[2] * 2 + (quadrant >> 1);

    const shift = childLod - division.id[0];
    const tiles = Math.pow(2, shift);
    const ext = division.extents;
    const cellWidth = (ext.ur[0] - ext.ll[0]) / tiles;
    const cellHeight = (ext.ur[1] - ext.ll[1]) / tiles;

    // the tile grid row grows downward from the node's upper edge
    const x0 = ext.ll[0] + (childX - division.id[1] * tiles) * cellWidth;
    const y1 = ext.ur[1] - (childY - division.id[2] * tiles) * cellHeight;

    for (let j = 0; j < VALID_AREA_SAMPLES; j++) {

        const y = y1 - ((j + 0.5) / VALID_AREA_SAMPLES) * cellHeight;

        for (let i = 0; i < VALID_AREA_SAMPLES; i++) {

            const x = x0 + ((i + 0.5) / VALID_AREA_SAMPLES) * cellWidth;

            let point;
            try {
                point = division.srs.convertCoordsTo(
                    [x, y, 0], constraint.srs, true);
            } catch (error) {
                return false;
            }
            if (!point
                || Number.isNaN(point[0]) || Number.isNaN(point[1])) {
                return false;
            }

            if (point[0] >= constraint.ll[0]
                && point[0] <= constraint.ur[0]
                && point[1] >= constraint.ll[1]
                && point[1] <= constraint.ur[1]) {
                return false;
            }
        }
    }

    return true;
}


/**
 * Rasterizes one triangle into the accumulator's coverage grid. A grid
 * sample is marked covered when its centre lies inside the triangle. A
 * degenerate (zero-area) triangle covers nothing and is skipped, so
 * overlapping geometry such as overhangs contributes coverage without
 * leaving a boundary that looks like a hole.
 */
function rasterizeTriangle(
    acc: CoverageAccumulator,
    v1: number,
    v2: number,
    v3: number,
): void {

    const uv = acc.externalUVs;
    const scale = acc.gridScale;
    const grid = acc.grid;
    const resolution = COVERAGE_RESOLUTION;

    const ax = uv[v1 * 2] * scale;
    const ay = uv[v1 * 2 + 1] * scale;
    const bx = uv[v2 * 2] * scale;
    const by = uv[v2 * 2 + 1] * scale;
    const cx = uv[v3 * 2] * scale;
    const cy = uv[v3 * 2 + 1] * scale;

    // signed area of the triangle; a zero area is degenerate and covers
    // no samples, so there is nothing to fill
    const area = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
    if (area === 0) return;

    const inverseArea = 1 / area;

    const minX = Math.max(0, Math.floor(Math.min(ax, bx, cx)));
    const maxX = Math.min(resolution - 1, Math.ceil(Math.max(ax, bx, cx)));
    const minY = Math.max(0, Math.floor(Math.min(ay, by, cy)));
    const maxY = Math.min(resolution - 1, Math.ceil(Math.max(ay, by, cy)));

    for (let pixelY = minY; pixelY <= maxY; pixelY++) {

        const sampleY = pixelY + 0.5;

        for (let pixelX = minX; pixelX <= maxX; pixelX++) {

            const sampleX = pixelX + 0.5;

            // barycentric weights of the sample point. All three are
            // non-negative exactly when the point lies inside the
            // triangle; dividing by the signed area keeps the test
            // correct for either winding order.
            const weightA = ((by - cy) * (sampleX - cx)
                + (cx - bx) * (sampleY - cy)) * inverseArea;
            if (weightA < 0) continue;

            const weightB = ((cy - ay) * (sampleX - cx)
                + (ax - cx) * (sampleY - cy)) * inverseArea;
            if (weightB < 0) continue;

            // the third weight is 1 - weightA - weightB
            if (weightA + weightB > 1) continue;

            grid[pixelY * resolution + pixelX] = 1;
        }
    }
}
