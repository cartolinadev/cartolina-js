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
 * Runs the multi-surface RFC draw-traversal for terrain.
 *
 * Each plain surface in `plainTrees` owns a private single-surface
 * helper tree (see `Map.resolvePlainSurfaceTrees`). The descent walks
 * those trees in lockstep over one combined sequence of tile positions:
 * at each `(lod, x, y)` it asks every still-active surface what it
 * knows about the position, decides whether at least one of them needs
 * a finer LOD, and recurses into quadrants only the active set can
 * still contribute to.
 *
 * On backtrack each surface that is at its natural leaf at the current
 * node draws against the accumulated mask; surfaces that still have
 * finer children render too, supplying fallback coverage. The mask
 * propagates back to the parent through `maskPool.blitChildToParent`.
 * Surfaces render front-to-back (last index first) so the front
 * surface claims pixels before the back ones can.
 *
 * Glues and virtual surfaces are never consulted. Watertight metadata
 * is not yet honoured — those phases come in step 4 and 6 of the RFC
 * rollout.
 *
 * @param map Typed `Map` owning the frame.
 * @param plainTrees Per-plain-surface helper trees, ordered
 *     back-to-front (front surface at the last index).
 * @param maskPool Mask pool owned by the typed `Map`.
 */

export function drawTerrainTraversal(
    map: Map,
    plainTrees: MapSurfaceTree[],
    maskPool: DrawTraversalMaskPool,
): void {

    if (plainTrees.length === 0) return;

    const legacyMap = plainTrees[0].map;
    const draw = legacyMap.draw;
    const stats = legacyMap.stats;
    const renderer = legacyMap.renderer;
    const screenTarget = renderer.gpu.currentRenderTarget;
    const cameraPos = legacyMap.camera.position;
    const fallbackCadence = Number(legacyMap.config.mapFallbackCadence ?? 3);

    // Activate every surface whose root metanode is ready, in view,
    // and not culled. The order in `plainTrees` is back-to-front; we
    // preserve it in the active set and reverse on render.
    const rootActive: ActiveSurface[] = [];

    for (const tree of plainTrees) {

        const tile = tree.surfaceTree;
        if (!tile.isMetanodeReady(tree, 0)) continue;
        if (!tile.metanode) continue;
        if (!tile.bboxVisible(tile.id, tile.metanode.bbox, cameraPos,
                tile.metanode)) {
            continue;
        }

        tile.updateTexelSize();
        rootActive.push({ tree, tile });
    }

    if (rootActive.length === 0) return;

    draw.drawCounter++;

    const counters: Counters = {
        processedNodes: 0,
        processedMetatiles: 0,
        usedNodes: 0,
    };

    legacyMap.gpuCache.skipCostCheck = true;

    traverseNode({
        map,
        active: rootActive,
        depth: 0,
        screenTarget,
        maskPool,
        counters,
        texelSizeFit: draw.texelSizeFit,
        cameraPos,
        fallbackCadence,
    });

    renderer.gpu.setRenderTarget(screenTarget);
    legacyMap.gpuCache.skipCostCheck = false;
    legacyMap.gpuCache.checkCost();

    stats.usedNodes = counters.usedNodes;
    stats.processedNodes = counters.processedNodes;
    stats.processedMetatiles = counters.processedMetatiles;
}


/**
 * Recurses into one tile position and returns whether the subtree
 * produced any rendered coverage.
 *
 * `active` carries the surfaces that are still candidates at this
 * node: each one has a ready, visible metanode at this `(lod, x, y)`.
 * Surfaces drop out of the active set as they fail visibility, lose
 * their metanode, or reach a position their tree no longer has a
 * child for.
 *
 * The returned boolean tells the caller whether to blit this node's
 * mask slice into the parent's mask slice. Returning `false` means
 * nothing was drawn here and no blit is needed.
 *
 * @param context Frame-wide state plus the active surface set and the
 *     current recursion depth.
 * @returns `true` if any surface drew at or below this node.
 */
function traverseNode(context: NodeContext): boolean {

    const { active, depth, maskPool, texelSizeFit, fallbackCadence } =
        context;

    if (active.length === 0) return false;

    // The bbox-visibility check has already been applied to every
    // entry of `active` by the caller (root setup or the child loop
    // below); we only record stats and clear the local mask here.
    recordSurfaces(context);
    maskPool.clearNode(depth);

    // Combined descent decision: any active surface that still has a
    // child and would benefit from finer detail forces descent. We
    // descend into quadrants whose child set is non-empty.
    let canDescend = false;
    for (const entry of active) {

        if (entry.tile.metanode!.hasChildren()
                && entry.tile.texelSize > texelSizeFit) {

            canDescend = true;
            break;
        }
    }

    let hasChildCoverage = false;

    if (canDescend) {

        for (let quadrant = 0; quadrant < 4; quadrant++) {

            const childActive = collectChildActive(context, quadrant);
            if (childActive.length === 0) continue;

            const childContext: NodeContext = {
                ...context,
                active: childActive,
                depth: depth + 1,
            };

            const childCovered = traverseNode(childContext);
            if (!childCovered) continue;

            maskPool.blitChildToParent(depth + 1, depth, quadrant);
            hasChildCoverage = true;
        }
    }

    // Render the surfaces front-to-back. The last entry is the front
    // surface (lowest `viewSurfaceIndex`), so iterate in reverse.
    // A surface at its natural leaf at this node renders unconditionally
    // (RFC §2.1 step 4). A surface that could still go deeper renders
    // coarse fallback coverage (RFC §2.1 step 5) only on a fallback LOD,
    // chosen by the cadence: this node's LOD modulo `fallbackCadence`.
    // Cadence 1 makes every inner node a fallback LOD (topdown); a large
    // cadence makes none (fitonly, only leaves render).
    let hasCoverage = hasChildCoverage;

    const fallbackLod = active[0].tile.id[0] % fallbackCadence === 0;

    for (let i = active.length - 1; i >= 0; i--) {

        const entry = active[i];
        const node = entry.tile.metanode!;
        const naturalLeaf = !(node.hasChildren()
            && entry.tile.texelSize > texelSizeFit);

        // A non-natural-leaf surface only draws on a fallback LOD; off
        // the cadence it contributes nothing and the gap is filled by an
        // ancestor fallback LOD or by its own finer descendants.
        if (!naturalLeaf && !fallbackLod) continue;

        const readiness = naturalLeaf ? ReadinessFull : ReadinessFallback;

        if (renderSurface(context, entry, readiness)) {
            hasCoverage = true;
        }
    }

    return hasCoverage;
}


/**
 * Builds the active surface set for one child quadrant of the current
 * node. For each currently-active surface that knows it has a child
 * at this quadrant, this fetches the child tile, runs the metanode
 * readiness check, and applies frustum culling. Surfaces with no
 * child at this quadrant simply drop out — their parent-level
 * coverage already includes this quadrant geographically and they
 * will be drawn at the current node, not pushed further down.
 */
function collectChildActive(
    context: NodeContext,
    quadrant: number,
): ActiveSurface[] {

    const { active, cameraPos } = context;
    const childActive: ActiveSurface[] = [];

    for (const entry of active) {

        if (!entry.tile.metanode!.hasChild(quadrant)) continue;

        const childTile = getReadyChild(entry.tree, entry.tile, quadrant);
        if (!childTile || !childTile.metanode) continue;

        if (!childTile.bboxVisible(childTile.id, childTile.metanode.bbox,
                cameraPos, childTile.metanode)) {

            continue;
        }

        childTile.updateTexelSize();
        childActive.push({ tree: entry.tree, tile: childTile });
    }

    return childActive;
}


/**
 * Draws one surface at the current node using the depth-local node
 * mask as the read-and-write coverage. Returns whether anything was
 * actually drawn; the caller uses this to track whether the subtree
 * produced coverage.
 */
function renderSurface(
    context: NodeContext,
    entry: ActiveSurface,
    readiness: TileRenderRig.ReadinessLevels,
): boolean {

    const { tree, tile } = entry;
    const { depth, screenTarget, maskPool } = context;
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


/**
 * Returns the child tile at `quadrant` if it is allocated and its
 * metanode for this position is ready; otherwise null. Also pulls the
 * height extents forward from the parent metanode when the child's
 * metatile pre-dates the v4 navtile-free encoding.
 */
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


/**
 * Counts each active surface's node and the first appearance of each
 * metatile this frame. The first-appearance check is per-metatile, not
 * per-surface, because the same metatile binary backs all nodes in a
 * metatile-aligned block.
 */
function recordSurfaces(context: NodeContext): void {

    const counters = context.counters;
    const drawCounter = context.active[0].tree.map.draw.drawCounter;

    for (const entry of context.active) {

        counters.processedNodes++;
        counters.usedNodes++;

        const metatile = entry.tile.metanode!.metatile;
        if (metatile.drawCounter === drawCounter) continue;

        metatile.drawCounter = drawCounter;
        counters.processedMetatiles++;
    }
}


function isRig(value: TileRenderRig | boolean | null): value is TileRenderRig {

    return typeof value === 'object' && value !== null;
}


/** One participating surface at a tile position during traversal. */
type ActiveSurface = {
    tree: MapSurfaceTree;
    tile: MapSurfaceTile;
};


type Counters = {
    processedNodes: number;
    processedMetatiles: number;
    usedNodes: number;
};


type NodeContext = {
    map: Map;
    active: ActiveSurface[];
    depth: number;
    screenTarget: GpuDevice.RenderTarget;
    maskPool: DrawTraversalMaskPool;
    counters: Counters;
    texelSizeFit: number;
    cameraPos: [number, number, number];
    fallbackCadence: number;
};


const ReadinessFull: TileRenderRig.ReadinessLevels = {
    minimum: 'fallback',
    desired: 'full',
};

const ReadinessFallback: TileRenderRig.ReadinessLevels = {
    minimum: 'fallback',
    desired: 'fallback',
};


// LegacyMetanode is re-exported only to keep this module's imports
// aligned with the surface-tile contract; the local helpers above use
// the metanode through `MapSurfaceTile.metanode` only.
export type { LegacyMetanode };
