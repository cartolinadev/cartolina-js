/*
 * color-terrain-sink.ts - draw terrain tiles into the colour frame
 */

import type Map from './map';
import type LegacyMap from './legacy-map';
import type MapSurfaceTile from './surface-tile';
import type GpuTexture from '../renderer/gpu/texture';
import type { GpuDevice } from '../renderer/gpu/device';
import { TileRenderRig } from './tile-render-rig';


/**
 * The terrain output of the colour frame.
 *
 * Draws each selected rig with the tile program, and carries the effects
 * that belong to the visible frame: imagery and mesh credits, the
 * per-LOD and per-surface draw statistics the inspector reads, and the
 * terrain debug overlay.
 *
 * The render target is captured when the sink is constructed, so the
 * caller binds its target before starting the pass.
 */
export class ColorTerrainSink {

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

        const map = this.map;
        const legacyMap = this.legacyMap;

        // materializing a coverage mask leaves its own target bound
        map.renderer.gpu.setRenderTarget(this.target);

        map.withNavigationCamera(() =>
            rig.draw(legacyMap.camera.position, maskTexture));

        this.applyCredits(tile, rig);

        // terrain debug overlay, drawn where the tile painted content
        if (map.overrides.drawBBoxes && !map.overrides.drawGeodataOnly)
            map.withNavigationCamera(() =>
                legacyMap.draw.drawTiles.drawTileInfo(
                    tile, tile.metanode!, legacyMap.camera.position,
                    tile.surfaceMesh, tile.texelSize));

        this.recordStatistics(tile);
    }

    /** Collects the credits of every raster source the rig drew. */
    private applyCredits(tile: MapSurfaceTile, rig: TileRenderRig): void {

        const activeRasterSourceIds = rig.activeRasterSourceIds();

        activeRasterSourceIds.forEach((id) => {

            const source = tile.rasterSources[id];
            if (!source) return;

            const credits = source.credits;
            for (let k = 0; k < credits.length; k++)
                tile.imageryCredits[credits[k]] = source.specificity;
        });

        tile.addSubmeshCredits(0, activeRasterSourceIds);

        // extract and flush credits
        this.legacyMap.applyCredits(tile);
    }

    /** Counts the drawn tile per LOD and per terrain source. */
    private recordStatistics(tile: MapSurfaceTile): void {

        const stats = this.legacyMap.stats;

        stats.renderedLods[tile.id[0]]++;
        stats.drawnTiles++;

        // mirror the per-LOD tile count, keyed by surface id, so
        // the inspector can break the same total down by surface
        const surfaceId = tile.surface.id || '(no id)';

        stats.renderedSurfaces[surfaceId] =
            (stats.renderedSurfaces[surfaceId] || 0) + 1;
    }

    private readonly map: Map;
    private readonly legacyMap: LegacyMap;
    private readonly target: Readonly<GpuDevice.RenderTarget>;
}

export default ColorTerrainSink;
