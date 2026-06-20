/*
 * pre-v6-watertight.ts - infer watertight flags for pre-v6 metatiles.
 */

import type MapSurfaceTile from './surface-tile';

type MeshArray = Uint16Array | Float32Array;

type CoverageEdge = {
    a: number;
    b: number;
    count: number;
};

/**
 * Mutable parse-time state for one conservative full-cell coverage test.
 */
export type CoverageAccumulator = {
    edgeCounts: Map<string, CoverageEdge>;
    externalUVs: MeshArray;
    failed: boolean;
    faceCount: number;
    hasMaxU: boolean;
    hasMaxV: boolean;
    hasMinU: boolean;
    hasMinV: boolean;
    fullCellMax: number;
};

/**
 * Starts a conservative full-cell coverage test for one submesh.
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

    return {
        edgeCounts: new Map<string, CoverageEdge>(),
        externalUVs,
        failed: false,
        faceCount: 0,
        hasMaxU: false,
        hasMaxV: false,
        hasMinU: false,
        hasMinV: false,
        fullCellMax: externalUVs instanceof Uint16Array ? 65535 : 1,
    };
}

/**
 * Adds one indexed face to a full-cell coverage test.
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

    acc.faceCount++;

    if (v1 === v2 || v2 === v3 || v1 === v3) {

        acc.failed = true;
        return;
    }

    recordCoverageVertex(acc, v1);
    recordCoverageVertex(acc, v2);
    recordCoverageVertex(acc, v3);

    recordCoverageEdge(acc, v1, v2);
    recordCoverageEdge(acc, v2, v3);
    recordCoverageEdge(acc, v3, v1);
}

/**
 * Finishes the coverage test for one parsed submesh.
 *
 * @param acc Accumulator returned by `createFullCoverageAccumulator`.
 * @returns True when a single submesh proves full-cell coverage.
 */
export function finishFullCoverage(acc: CoverageAccumulator | null): boolean {

    if (!acc || acc.failed || acc.faceCount === 0) return false;
    if (!acc.hasMinU || !acc.hasMaxU || !acc.hasMinV || !acc.hasMaxV)
        return false;

    for (const edge of acc.edgeCounts.values()) {

        if (edge.count !== 1) {

            if (edge.count > 2) return false;
            continue;
        }

        if (!isFlushBoundaryEdge(acc, edge.a, edge.b)) return false;
    }

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
 * Marks a pre-v6 parent watertight from four loaded watertight children.
 *
 * @param tile Parent tile checked on traversal backtrack.
 * @returns True when this call changed the metanode flag.
 */
export function inferPreV6WatertightFromChildren(
    tile: MapSurfaceTile,
): boolean {

    const node = tile.metanode;
    if (!node || node.watertight || node.metatile.version >= 6) return false;
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


function recordCoverageVertex(
    acc: CoverageAccumulator,
    vertex: number,
): void {

    const uvIndex = vertex * 2;
    const u = acc.externalUVs[uvIndex];
    const v = acc.externalUVs[uvIndex + 1];

    if (u === 0) acc.hasMinU = true;
    if (u === acc.fullCellMax) acc.hasMaxU = true;
    if (v === 0) acc.hasMinV = true;
    if (v === acc.fullCellMax) acc.hasMaxV = true;
}


function recordCoverageEdge(
    acc: CoverageAccumulator,
    a: number,
    b: number,
): void {

    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    const key = lo + ':' + hi;
    let edge = acc.edgeCounts.get(key);

    if (edge) {

        edge.count++;

    } else {

        edge = { a: lo, b: hi, count: 1 };
        acc.edgeCounts.set(key, edge);
    }
}


function isFlushBoundaryEdge(
    acc: CoverageAccumulator,
    a: number,
    b: number,
): boolean {

    const uvA = a * 2;
    const uvB = b * 2;
    const uA = acc.externalUVs[uvA];
    const vA = acc.externalUVs[uvA + 1];
    const uB = acc.externalUVs[uvB];
    const vB = acc.externalUVs[uvB + 1];
    const fullCellMax = acc.fullCellMax;

    return (uA === 0 && uB === 0)
        || (uA === fullCellMax && uB === fullCellMax)
        || (vA === 0 && vB === 0)
        || (vA === fullCellMax && vB === fullCellMax);
}
