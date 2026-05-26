/*
 * drawtraversal.ts - recursively select and render terrain tiles
 */

import type MapSurfaceTree from './surface-tree';
import type MapSurfaceTile from './surface-tile';
import type { LegacyMetanode } from './surface-tile';
import DrawTraversalMaskPool from './draw-traversal-mask';
import type { TileRenderRig } from './tile-render-rig';
import type { SurfaceTileReadiness } from './draw-tiles';
import type { GpuDevice } from '../renderer/gpu/device';
import type { vec3 } from '../utils/math';


/**
 * Runs the first RFC draw-traversal implementation for terrain.
 *
 * This phase replaces the default top-down terrain draw with a recursive
 * backtracking traversal and UV-space coverage masks. It still uses the
 * legacy single selected surface stored on `MapSurfaceTile`; the RFC's
 * multi-surface active-set traversal builds on this path in the next
 * validation phase.
 *
 * @param tree Terrain surface tree to draw.
 * @param shift Periodic-world shift from the legacy call site. The current
 *     legacy `drawSurface` path does not use it; this traversal preserves
 *     that behavior.
 */
export function drawTerrainTraversal(
    tree: MapSurfaceTree,
    _shift: [number, number, number],
): void {

    const map = tree.map;
    const draw = map.draw;
    const stats = map.stats;
    const renderer = map.renderer;
    const screenTarget =
        renderer.gpu.currentRenderTarget as GpuDevice.RenderTarget;
    const root = tree.surfaceTree;

    if (!root.isMetanodeReady(tree, 0)) return;
    if (!root.metanode) return;

    const cameraPos = map.camera.position;
    if (!root.bboxVisible(root.id, root.metanode.bbox, cameraPos,
            root.metanode)) {
        return;
    }

    root.updateTexelSize();
    draw.drawCounter++;

    const counters: Counters = {
        processedNodes: 0,
        processedMetatiles: 0,
        usedNodes: 0,
    };

    const maskPool = getMaskPool(tree);

    map.gpuCache.skipCostCheck = true;

    traverseNode({
        tree,
        tile: root,
        depth: 0,
        cameraPos,
        screenTarget,
        maskPool,
        counters,
    });

    renderer.gpu.setRenderTarget(screenTarget);
    map.gpuCache.skipCostCheck = false;
    map.gpuCache.checkCost();

    stats.usedNodes = counters.usedNodes;
    stats.processedNodes = counters.processedNodes;
    stats.processedMetatiles = counters.processedMetatiles;
}


function traverseNode(context: NodeContext): boolean {

    const { tree, tile, depth, cameraPos, maskPool } = context;
    const map = tree.map;
    const draw = map.draw;
    const node = tile.metanode;

    if (!node) return false;

    recordNode(context, node);

    if (!tile.bboxVisible(tile.id, node.bbox, cameraPos, node)) return false;

    context.counters.usedNodes++;
    tile.updateTexelSize();
    maskPool.clearNode(depth);

    const needsFiner = node.hasChildren()
        && tile.texelSize > draw.texelSizeFit;
    let hasChildCoverage = false;

    if (needsFiner) {

        for (let quadrant = 0; quadrant < 4; quadrant++) {

            if (!node.hasChild(quadrant)) continue;

            const child = getReadyChild(tree, tile, quadrant);
            if (!child || !child.metanode) continue;

            const childCovered = traverseNode({
                ...context,
                tile: child,
                depth: depth + 1,
            });

            if (!childCovered) continue;

            maskPool.blitChildToParent(depth + 1, depth, quadrant);
            hasChildCoverage = true;
        }
    }

    const naturalLeaf = !needsFiner;
    const fallback = needsFiner;
    let hasCoverage = hasChildCoverage;

    if (naturalLeaf) {

        hasCoverage = renderTile(context, ReadinessFull) || hasCoverage;

    } else if (fallback) {

        hasCoverage = renderTile(context, ReadinessFallback) || hasCoverage;
    }

    return hasCoverage;
}


function renderTile(
    context: NodeContext,
    readiness: SurfaceTileReadiness,
): boolean {

    const { tree, tile, depth, screenTarget, maskPool } = context;
    const map = tree.map;
    const node = tile.metanode;

    if (!node || !node.hasGeometry()) return false;

    const priority = tile.id[0] * tile.distance;
    const maskTexture = maskPool.nodeMask(depth);

    let rig: TileRenderRig | boolean | null;

    if (map.outerMap.drawChannel === 'color') {

        rig = map.outerMap.withNavigationCamera(() => {

            map.renderer.gpu.setRenderTarget(screenTarget);
            return map.draw.drawTiles.drawSurfaceTile(
                tile,
                node,
                map.camera.position,
                tile.texelSize,
                priority,
                false,
                false,
                false,
                readiness,
                maskTexture,
            );
        });

    } else {

        map.renderer.gpu.setRenderTarget(screenTarget);
        rig = map.draw.drawTiles.drawSurfaceTile(
            tile,
            node,
            context.cameraPos,
            tile.texelSize,
            priority,
            false,
            false,
            false,
            readiness,
            maskTexture,
        );
    }

    if (!isRig(rig)) return false;

    tile.drawCounter = map.draw.drawCounter;
    maskPool.addFootprint(rig, depth);
    return true;
}


function getReadyChild(
    tree: MapSurfaceTree,
    tile: MapSurfaceTile,
    quadrant: number,
): MapSurfaceTile | null {

    const child = tile.children[quadrant];
    if (!child) return null;

    if (!child.isMetanodeReady(tree, child.id[0])) return null;
    if (!child.metanode) return null;

    tree.updateNodeHeightExtents(child, child.metanode);
    return child;
}


function recordNode(context: NodeContext, node: LegacyMetanode): void {

    const drawCounter = context.tree.map.draw.drawCounter;
    const counters = context.counters;

    counters.processedNodes++;

    if (node.metatile.drawCounter === drawCounter) return;

    node.metatile.drawCounter = drawCounter;
    counters.processedMetatiles++;
}


function getMaskPool(tree: MapSurfaceTree): DrawTraversalMaskPool {

    const resolution = normalizedMaskResolution(
        tree.map.config.mapTraversalMaskResolution,
    );

    if (tree.terrainMaskPool
            && tree.terrainMaskPool.resolution === resolution) {
        return tree.terrainMaskPool;
    }

    if (tree.terrainMaskPool) tree.terrainMaskPool.dispose();

    tree.terrainMaskPool = new DrawTraversalMaskPool(
        tree.map.renderer,
        resolution,
    );
    return tree.terrainMaskPool;
}


function normalizedMaskResolution(
    value: boolean | number | string | number[] | undefined,
): number {

    if (typeof value !== 'number') return DefaultMaskResolution;

    const rounded = Math.round(value);
    if (rounded < 16) return DefaultMaskResolution;
    if ((rounded & (rounded - 1)) !== 0) return DefaultMaskResolution;

    return rounded;
}


function isRig(value: TileRenderRig | boolean | null): value is TileRenderRig {

    return typeof value === 'object' && value !== null;
}


type Counters = {
    processedNodes: number;
    processedMetatiles: number;
    usedNodes: number;
};

type NodeContext = {
    tree: MapSurfaceTree;
    tile: MapSurfaceTile;
    depth: number;
    cameraPos: vec3;
    screenTarget: GpuDevice.RenderTarget;
    maskPool: DrawTraversalMaskPool;
    counters: Counters;
};

const DefaultMaskResolution = 256;

const ReadinessFull: SurfaceTileReadiness = {
    minimum: 'fallback',
    desired: 'full',
};

const ReadinessFallback: SurfaceTileReadiness = {
    minimum: 'fallback',
    desired: 'fallback',
};
