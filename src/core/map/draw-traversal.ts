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
 * finer children render too, supplying fallback coverage. Partial
 * coverage propagates back to the parent through `maskPool.appendChild`;
 * watertight coverage propagates as state and exact quadrant
 * rectangles. Surfaces render front-to-back (last index first) so the
 * front surface claims pixels before the back ones can.
 *
 * Glues and virtual surfaces are never consulted.
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
 * Recurses into one tile position and returns the coverage produced by
 * the subtree.
 *
 * `active` carries the surfaces that are still candidates at this
 * node: each one has a ready, visible metanode at this `(lod, x, y)`.
 * Surfaces drop out of the active set as they fail visibility, lose
 * their metanode, or reach a position their tree no longer has a
 * child for.
 *
 * The returned kind tells the caller how this quadrant of the parent is
 * covered:
 *   - `watertight`: the on-screen cell is fully covered; the caller
 *     records it analytically (a quadrant rectangle), no mask.
 *   - `partial`: covered with an arbitrary shape that lives in this
 *     depth's node mask; the caller blits it into the parent.
 *   - `gap`: on-screen but nothing rendered yet (waiting for data); the
 *     caller leaves it uncovered for its own draw or an ancestor to fill.
 *   - `empty`: no on-screen area at all (off-screen); the caller folds it
 *     into a watertight result instead of drawing a fallback.
 *
 * @param context Frame-wide state plus the active surface set and the
 *     current recursion depth.
 * @returns Coverage state for the subtree rooted at this node.
 */
function traverseNode(context: NodeContext): CoverageResult {

    const { active, depth, maskPool, texelSizeFit, fallbackCadence } =
        context;

    if (active.length === 0) return CoverageEmpty;

    // The bbox-visibility check has already been applied to every
    // entry of `active` by the caller (root setup or the child loop
    // below); we only record stats here. The depth-local mask is
    // cleared lazily once partial coverage first needs storage.
    recordSurfaces(context);

    // Combined descent decision: any active surface that still has a
    // child and would benefit from finer detail forces descent. We
    // descend into quadrants whose child set is non-empty.
    let shouldDescend = false;
    let hasWatertightFit = false;

    for (const entry of active) {

        if (entry.tile.metanode!.hasChildren()
                && entry.tile.texelSize > texelSizeFit)
            shouldDescend = true;

        if (entry.tile.metanode!.watertight
                && entry.tile.texelSize <= texelSizeFit)
            hasWatertightFit = true;
    }

    // Process children if applicable. We descend if an active surface can
    // benefit from finer LOD, but not if we already have a watertight fit
    // from any active surface: this prevents forced descent to surfaces
    // that have geometry available only on finer LODs.

    // Each node starts from empty coverage. Reset is CPU-cheap (it clears
    // a rectangle list), so there is no lazy-init guard.
    maskPool.resetCoverage(depth);

    let watertightMask = 0;
    let emptyMask = 0;

    if (!hasWatertightFit && shouldDescend) {

        for (let quadrant = 0; quadrant < 4; quadrant++) {

            const child = collectChildActive(context, quadrant);

            if (child.active.length === 0) {

                // Culled (off-screen for every surface): nothing to cover,
                // so fold it in. Otherwise a real gap, left for the draw.
                if (child.culled) emptyMask |= 1 << quadrant;
                continue;
            }

            const childContext: NodeContext = {
                ...context,
                active: child.active,
                depth: depth + 1,
            };

            const childCoverage = traverseNode(childContext);

            if (childCoverage.kind === 'watertight') {

                watertightMask |= 1 << quadrant;
                continue;
            }

            if (childCoverage.kind === 'empty') {

                emptyMask |= 1 << quadrant;
                continue;
            }

            if (childCoverage.kind === 'partial') {

                // Fold the child's mask into this node's quadrant: its
                // rectangles map up on the CPU, footprint coverage blits
                // up only if the child has any.
                maskPool.appendChild(depth + 1, depth, quadrant);
                continue;
            }

            // 'gap': on-screen and uncovered; nothing to fold.
        }
    }

    // No on-screen area anywhere below: this node contributes nothing.
    if (emptyMask === AllQuadrantsMask) return CoverageEmpty;

    // Every on-screen quadrant is watertight (the rest are off-screen):
    // covered, no draw or mask needed, early return
    if ((watertightMask | emptyMask) === AllQuadrantsMask)
        return CoverageWatertight;

    // Record watertight children as exact quadrant rectangles.
    if (watertightMask !== 0) maskPool.addQuadrantRects(depth, watertightMask);

    // Render surfaces front-to-back. The last entry is the front surface
    // (lowest `viewSurfaceIndex`), so iterate in reverse.
    //
    // There are three backtrack render cases:
    //
    // 1. Natural leaf: render unconditionally with full desired readiness.
    // 2. Cadence fallback: render a non-leaf fallback LOD and allow missing
    //    fallback resources to be requested.
    // 3. Off-cadence probe: try a non-leaf fallback draw with loading
    //    disabled. This keeps an already available intermediate LOD visible
    //    while the deeper natural leaf loads, without making every traversed
    //    LOD a proactive fallback request.
    const fallbackLod = active[0].tile.id[0] % fallbackCadence === 0;

    for (let i = active.length - 1; i >= 0; i--) {

        const entry = active[i];
        const node = entry.tile.metanode!;
        const naturalLeaf = !(node.hasChildren()
            && entry.tile.texelSize > texelSizeFit);

        const readiness = naturalLeaf ? ReadinessFull : ReadinessFallback;

        // off-cadence residence-only probe, see above
        const preventLoad = !naturalLeaf && !fallbackLod;

        const renderedCoverage =
            renderSurface(
                context,
                entry,
                readiness,
                preventLoad,
            );

        // A surface drawing watertight fully covers the node.
        if (renderedCoverage.kind === 'watertight') return CoverageWatertight;

        // A watertight metanode claims the node even before it draws, so
        // stop rendering lower-priority surfaces under it.
        if (node.watertight) break;
    }

    // The node's coverage is whatever ended up in its mask: watertight
    // rectangles, blitted child masks, or rendered footprints. An empty
    // mask means an on-screen gap nothing has filled yet.
    return maskPool.hasCoverage(depth) ? CoveragePartial : CoverageGap;
}


/**
 * Builds the active surface set for one child quadrant of the current
 * node: each active surface with a ready, in-frustum child at this
 * quadrant contributes that child.
 *
 * Also reports the quadrant as `culled` when every active surface with
 * known coverage here is loaded and frustum-culled — off-screen for the
 * whole active set. A missing child on a watertight parent is covered by
 * that parent; a missing child on a sparse parent is considered absent
 * coverage.
 * An unloaded child is not off-screen because visibility is unknown. The
 * caller folds a culled quadrant into a watertight result instead of
 * drawing a fallback nothing can see.
 */
function collectChildActive(
    context: NodeContext,
    quadrant: number,
): ChildQuadrant {

    const { active, cameraPos } = context;
    const childActive: ActiveSurface[] = [];

    // Holds while every surface's finer child here is loaded and
    // off-screen; each other case clears it (see the branches).
    let culled = true;

    for (const entry of active) {

        const node = entry.tile.metanode!;

        if (!node.hasChild(quadrant)) {

            if (node.watertight && node.hasGeometry()) {
                culled = false;  // watertight parent covers this quadrant
            }
            continue;
        }

        const childTile = getReadyChild(entry.tree, entry.tile, quadrant);

        if (!childTile || !childTile.metanode) {

            culled = false;      // finer child not loaded; visibility unknown
            continue;
        }

        if (!childTile.bboxVisible(childTile.id, childTile.metanode.bbox,
                cameraPos, childTile.metanode)) {

            continue;            // finer child loaded and off-screen
        }

        culled = false;          // finer child visible; joins the active set
        childTile.updateTexelSize();
        childActive.push({ tree: entry.tree, tile: childTile });
    }

    return { active: childActive, culled };
}


/**
 * Draws one surface at the current node using the depth-local node
 * mask as the read-and-write coverage. Only a tile that actually draws
 * can produce watertight coverage: a drawn watertight tile returns
 * analytic coverage instead of rasterizing its footprint into the mask.
 */
function renderSurface(
    context: NodeContext,
    entry: ActiveSurface,
    readiness: TileRenderRig.ReadinessLevels,
    preventLoad = false,
): CoverageResult {

    const { tree, tile } = entry;
    const { depth, screenTarget, maskPool } = context;
    const legacyMap = tree.map;
    const node = tile.metanode;

    if (!node || !node.hasGeometry()) return CoverageGap;

    const priority = tile.id[0] * tile.distance;

    // Sample prior coverage (finer descendants and higher-priority
    // surfaces drawn before this one) only when some exists; materialize
    // rasterizes the rectangle list and footprint texture on demand.
    const maskTexture = maskPool.hasCoverage(depth)
        ? maskPool.materialize(depth)
        : undefined;

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
            preventLoad,
            false,
            readiness,
            maskTexture,
        ));

    if (!isRig(rig)) return CoverageGap;

    tile.drawCounter = legacyMap.draw.drawCounter;

    if (node.watertight) {
        return CoverageWatertight;
    }

    // Non-watertight tile: its footprint joins this node's coverage so
    // the next (back) surface and the parent see it.
    maskPool.addFootprint(rig, depth);
    return CoveragePartial;
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


/** One quadrant's active children, and whether it is fully culled. */
type ChildQuadrant = {
    active: ActiveSurface[];
    culled: boolean;
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


// `partial` is partial *coverage* (an arbitrary covered shape held in
// the mask), unrelated to a partial *tile* (a non-watertight mesh).
type CoverageResult =
    | { kind: 'empty' }       // no on-screen area — nothing to cover
    | { kind: 'gap' }         // on-screen, nothing rendered yet (waiting)
    | { kind: 'partial' }     // covered with an arbitrary shape, in a mask
    | { kind: 'watertight' }; // on-screen cell fully covered, analytic


const CoverageEmpty: CoverageResult = { kind: 'empty' };
const CoverageGap: CoverageResult = { kind: 'gap' };
const CoveragePartial: CoverageResult = { kind: 'partial' };
const CoverageWatertight: CoverageResult = { kind: 'watertight' };

const AllQuadrantsMask = 0b1111;


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
