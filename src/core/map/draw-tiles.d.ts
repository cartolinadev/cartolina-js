import type { TileRenderRig } from './tile-render-rig';
import type MapSurfaceTile from './surface-tile';
import type { LegacyMetanode } from './surface-tile';
import type GpuTexture from '../renderer/gpu/texture';
import type { vec3 } from '../utils/math';

export type SurfaceTileReadiness = {
    minimum: TileRenderRig.ReadinessLevel;
    desired: TileRenderRig.ReadinessLevel;
};

/**
 * Type surface for the legacy `MapDrawTiles` helper (`draw-tiles.js`).
 */
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
        readiness?: SurfaceTileReadiness,
        maskTexture?: GpuTexture,
    ): TileRenderRig | boolean | null;
}
