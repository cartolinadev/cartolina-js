/*
 * draw-tiles.d.ts - typed surface for the legacy `MapDrawTiles` helper
 * (`draw-tiles.js`).
 *
 * Phase-1 validation contract introduced by rfc-draw-traversal so the
 * typed recursive traversal can call into the legacy orchestrator.
 * Removal target in phase 8 once the orchestrator is replaced by
 * direct rig calls.
 */

import type { TileRenderRig } from './tile-render-rig';
import type MapSurfaceTile from './surface-tile';
import type { LegacyMetanode } from './surface-tile';
import type GpuTexture from '../renderer/gpu/texture';
import type { vec3 } from '../utils/math';

export default class MapDrawTiles {

    drawSurfaceTile(
        tile: MapSurfaceTile,
        node: LegacyMetanode,
        cameraPos: vec3,
        pixelSize: number,
        priority: number,
        preventRender: boolean,
        preventLoad: boolean,
        doNotCheckGpu: boolean,
        readiness?: TileRenderRig.ReadinessLevels,
        maskTexture?: GpuTexture,
    ): TileRenderRig | boolean | null;
}
