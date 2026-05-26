/*
 * draw-traversal.ts - recursively select and render terrain tiles
 */

import type Map from '../map';
import type MapSurfaceTree from './surface-tree';
import type MapSurfaceTile from './surface-tile';
import type { LegacyMetanode } from './surface-tile';
import type DrawTraversalMaskPool from './draw-traversal-mask';
import type { TileRenderRig } from './tile-render-rig';
import type { GpuDevice } from '../renderer/gpu/device';


/**
 * Runs the first RFC draw-traversal implementation for terrain.
 *
 * This phase replaces the default top-down terrain draw with a recursive
 * backtracking traversal and UV-space coverage masks. It still uses the
 * legacy single selected surface stored on `MapSurfaceTile`; the RFC's
 * multi-surface active-set traversal builds on this path in the next
 * phase.
 *
 * @param map Typed `Map` owning the frame.
 * @param tree Terrain surface tree to draw.
 * @param maskPool Mask pool owned by the typed `Map`.
 */

export function drawTerrainTraversal(
    map: Map,
    tree: MapSurfaceTree,
    maskPool: DrawTraversalMaskPool,
): void {

    const legacyMap = tree.map;
    const draw = legacyMap.draw;
    const stats = legacyMap.stats;
    const renderer = legacyMap.renderer;
    const screenTarget = renderer.gpu.currentRenderTarget;
    const root = tree.surfaceTree;

    if (!root.isMetanodeReady(tree, 0)) return;
    if (!root.metanode) return;

    const cameraPos = legacyMap.camera.position;
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

    legacyMap.gpuCache.skipCostCheck = true;

    traverseNode({
        map,
        tree,
        tile: root,
        depth: 0,
        screenTarget,
        maskPool,
        counters,
    });

    renderer.gpu.setRenderTarget(screenTarget);
    legacyMap.gpuCache.skipCostCheck = false;
    legacyMap.gpuCache.checkCost();

    stats.usedNodes = counters.usedNodes;
    stats.processedNodes = counters.processedNodes;
    stats.processedMetatiles = counters.processedMetatiles;
}


/**
 * Perform one step of the recursive terrain descent for a single tile
 * node. Recurses into child quadrants whose metatiles are ready, then
 * renders the node itself as a natural leaf (all children covered) or
 * as a fallback (at least one child is not yet available).
 *
 * @param context - State bundle for this node: tile, depth, render
 *   targets, mask pool, and per-frame counters.
 * @returns `true` if this subtree produced any rendered coverage.
 *   The caller uses this to decide whether to blit this node's mask
 *   slice into the parent's mask slice via `blitChildToParent`.
 *   Returning `false` means nothing was drawn here and no blit is
 *   needed.
 */
function traverseNode(context: NodeContext): boolean {

    const { tree, tile, depth, maskPool } = context;
    const legacyMap = tree.map;
    const draw = legacyMap.draw;
    const node = tile.metanode;

    if (!node) return false;

    recordNode(context, node);

    const cameraPos = legacyMap.camera.position;
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

            // collect accumulated mask from the child (if any)
            maskPool.blitChildToParent(depth + 1, depth, quadrant);
            hasChildCoverage = true;
        }
    }

    const naturalLeaf = !needsFiner;
    let hasCoverage = hasChildCoverage;

    // Natural leaves render with full-readiness; inner-node fallbacks
    // render with fallback-readiness so they do not pull optional
    // resources that would slow down leaf loads (RFC §2.4).
    if (naturalLeaf) {
        hasCoverage = renderTile(context, ReadinessFull) || hasCoverage;
    } else {
        hasCoverage = renderTile(context, ReadinessFallback) || hasCoverage;
    }

    return hasCoverage;
}


function renderTile(
    context: NodeContext,
    readiness: TileRenderRig.ReadinessLevels,
): boolean {

    const { tree, tile, depth, screenTarget, maskPool } = context;
    const legacyMap = tree.map;
    const node = tile.metanode;

    if (!node || !node.hasGeometry()) return false;

    const priority = tile.id[0] * tile.distance;
    const maskTexture = maskPool.nodeMask(depth);

    legacyMap.renderer.gpu.setRenderTarget(screenTarget);

    // SSE and culling ran under the selection camera; only the draw
    // call needs the live camera position.
    const rig = context.map.withNavigationCamera(() =>
        legacyMap.draw.drawTiles.drawSurfaceTile(
            tile,
            node,
            legacyMap.camera.position,
            tile.texelSize,
            priority,
            false,
            false,
            false,
            readiness,
            maskTexture,
        ));

    if (!isRig(rig)) return false;

    tile.drawCounter = legacyMap.draw.drawCounter;
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


function isRig(value: TileRenderRig | boolean | null): value is TileRenderRig {

    return typeof value === 'object' && value !== null;
}


type Counters = {
    processedNodes: number;
    processedMetatiles: number;
    usedNodes: number;
};

type NodeContext = {
    map: Map;
    tree: MapSurfaceTree;
    tile: MapSurfaceTile;
    depth: number;
    screenTarget: GpuDevice.RenderTarget;
    maskPool: DrawTraversalMaskPool;
    counters: Counters;
};

const ReadinessFull: TileRenderRig.ReadinessLevels = {
    minimum: 'fallback',
    desired: 'full',
};

const ReadinessFallback: TileRenderRig.ReadinessLevels = {
    minimum: 'fallback',
    desired: 'fallback',
};
