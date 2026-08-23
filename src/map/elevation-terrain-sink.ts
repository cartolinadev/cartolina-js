/*
 * elevation-terrain-sink.ts - build elevation-store units from terrain
 */

import type ElevationStore from './elevation-store';
import type MapSurfaceTile from './surface-tile';
import type GpuTexture from '../renderer/gpu/texture';
import { TileRenderRig } from './tile-render-rig';


/**
 * The terrain output of the elevation-store population pass: one unit
 * per node, built between `beginNode` and `endNode`.
 *
 * The readiness check never loads, so the pass sees only terrain the
 * colour traversal already classified and drew. A rig that is not ready
 * contributes nothing at this interval.
 */
export class ElevationTerrainSink {

    constructor(store: ElevationStore) {

        this.store = store;
    }

    beginNode(tileId: [number, number, number]): void {

        this.store.beginUnit(tileId);
    }

    isReady(
        rig: TileRenderRig,
        readiness: TileRenderRig.ReadinessLevels,
        priority: TileRenderRig.Priority,
        options: TileRenderRig.IsReadyOptions,
    ): boolean {

        // the stored field is the terrain as rendered, at whatever the
        // colour frame has already brought in
        return rig.isReady(readiness, priority,
            { ...options, doNotLoad: true });
    }

    draw(
        tile: MapSurfaceTile,
        rig: TileRenderRig,
        maskTexture?: GpuTexture,
    ): void {

        this.store.drawUnit(tile, rig, maskTexture);
    }

    endNode(tileId: [number, number, number], covered: boolean): void {

        this.store.endUnit(tileId, covered);
    }

    private readonly store: ElevationStore;
}

export default ElevationTerrainSink;
