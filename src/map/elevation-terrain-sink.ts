/*
 * elevation-terrain-sink.ts - build elevation-store units from terrain
 */

import type ElevationStore from './elevation-store';
import type MapSurfaceTile from './surface-tile';
import type GpuTexture from '../renderer/gpu/texture';
import { TileRenderRig } from './tile-render-rig';


/**
 * Builds one elevation-store unit per node, between `beginNode` and
 * `endNode`, from the terrain drawn in an elevation pass.
 *
 * Its readiness check never loads, so it draws only rigs already ready
 * for the colour frame; an unready rig contributes nothing.
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

        return rig.isReady(readiness, priority, options);
    }

    draw(
        tile: MapSurfaceTile,
        rig: TileRenderRig,
        maskTexture?: GpuTexture,
    ): void {

        this.store.drawUnit(tile, rig, maskTexture);
    }

    endNode(
        tileId: [number, number, number],
        covered: boolean,
        watertight: boolean,
    ): void {

        this.store.endUnit(tileId, covered, watertight);
    }

    private readonly store: ElevationStore;
}

export default ElevationTerrainSink;
