/*
 * depth-terrain-sink.ts - draw terrain tiles into the depth hitmap
 */

import type Map from './map';
import type LegacyMap from './legacy-map';
import type MapSurfaceTile from './surface-tile';
import type GpuTexture from '../renderer/gpu/texture';
import type { GpuDevice } from '../renderer/gpu/device';
import { TileRenderRig } from './tile-render-rig';


/**
 * The terrain output of the depth pass that feeds the hitmap.
 *
 * The pass writes distance to the surface, so readiness rests on the
 * mesh alone.
 *
 * The render target is captured when the sink is constructed, so the
 * caller binds its target before starting the pass.
 */
export class DepthTerrainSink {

    /**
     * @param map Typed map owning the frame.
     */
    constructor(map: Map) {

        this.map = map;
        this.legacyMap = map.map!;
        this.target = map.renderer.gpu.currentRenderTarget;
    }

    isReady(
        rig: TileRenderRig,
        _readiness: TileRenderRig.ReadinessLevels,
        priority: TileRenderRig.Priority,
        options: TileRenderRig.IsReadyOptions,
    ): boolean {

        return rig.isDepthReady(priority.essential, options);
    }

    draw(
        _tile: MapSurfaceTile,
        rig: TileRenderRig,
        maskTexture?: GpuTexture,
    ): void {

        const legacyMap = this.legacyMap;

        // set render target
        this.map.renderer.gpu.setRenderTarget(this.target);

        // draw
        this.map.withNavigationCamera(() =>
            rig.drawDepth(legacyMap.camera.position, maskTexture));
    }

    private readonly map: Map;
    private readonly legacyMap: LegacyMap;
    private readonly target: Readonly<GpuDevice.RenderTarget>;
}

export default DepthTerrainSink;
