/*
 * draw-tiles.d.ts - typed surface for the legacy `MapDrawTiles` helper
 * (`draw-tiles.js`).
 */

import type { TileRenderRig } from './tile-render-rig';
import type MapSurfaceTile from './surface-tile';
import type MapMetanode from './metanode';
import type GpuTexture from '../renderer/gpu/texture';
import type { vec3 } from '../utils/math';

export default class MapDrawTiles {

    drawSurfaceTile(
        tile: MapSurfaceTile,
        node: MapMetanode,
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
