/*
 * pre-v6-watertight.ts - infer watertight flags for pre-v6 metatiles.
 */

import type MapSurfaceTile from './surface-tile';

type MeshArray = Uint16Array | Float32Array;

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
 * Marks a pre-v6 parent mesh watertight from four loaded watertight
 * children. A coherent terrain pyramid lets four complete child cells
 * establish full coverage for a parent that declares its own geometry.
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

        if (!node.hasChild(quadrant)) return false;

        const child = tile.children[quadrant];
        const childNode = child?.metanode;

        if (!childNode || !childNode.watertight) return false;
    }

    node.watertight = true;
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
