/*
 * tilerenderrig.ts - prepare and draw mesh tiles
 */

import * as utils from '../utils/utils';

 /**
  * A tile render rig manages the render process for a specific tile (more
  * accurately, for a tile submesh, but tiles with more than one submesh are
  * an oddity).
  *
  * It resolves and prepares the necessary resources for rendering, keeps track
  * of their availability (or readiness in vts terminology) and eventually,
  * draws the tile using MapMesh.draw2, after binding textures and setting all
  * the necessary uniforms and samplers.
  *
  * The rig is meant to be a replacement for a swath of old vts functionality,
  * mostly in MapDrawTiles.drawMeshTile, MapDrawTiles.updateTileBounds and
  * MapMesh.drawSubmesh. Unlike the old setup split across these methods,
  * the rig renders the tile always in a single pass, using a single, unified
  * shader, including optional atmospheric scattering, hence there is no "draw
  * command" sequence.
  *
  * The rig is self-contained in the sense that it can draw independently even
  * when/while the original tile changes.
  *
  * There are two types of draw readiness: full readiness (or simply readiness)
  * and fallback readiness. The fallback readiness is meant for a tile that is
  * meant to be a replacement for better (typically higher resolution) data.
  * This matters: not all data are made ready for the sake of fallback readiness.
  */

export class TileRenderRig {

    private readonly config!: Config;


    constructor (tileId: [number, number, number], config: Config,
        priority: TileRenderRig.Priority = TileRenderRig.DEFAULT_PRIORITY) {

        this.config = config;
        //console.log(tileId);

        // layer stack may not be constructed until mesh is ready at least
    }

    isReady(level:TileRenderRig.Level = 'full',
          checkReadyFlags = TileRenderRig.DEFAULT_CHECKREADYFLAGS): boolean {

        return true;
    }

    draw(renderFlags: Partial<TileRenderRig.RenderFlags> = {}) {

        let flags = {...TileRenderRig.DEFAULT_RENDER_FLAGS, ...renderFlags };
    }

    activeLayerIds(): string[] { return []; }


    private buildLayerStack() {}
};


// local types
type Config = {
    [key: string]: boolean | number | string | number[];
}


// export types
export namespace TileRenderRig {

    export type Level = 'fallback' | 'full';


    export const DEFAULT_PRIORITY = { bare: 0, full: 0}

    export type Priority = typeof DEFAULT_PRIORITY;

    export const DEFAULT_RENDER_FLAGS = {
        shaderIllumination: true,
        bumps: true,
        speculars: true,
    };

    export type RenderFlags = typeof DEFAULT_RENDER_FLAGS;

    /**
     * These are passed to MapMesh.isReady() and MapTexture.isReady().
     *
     * The first one checks readiness without queueing requests for missing content.
     * The second one seems to prevent checking agains exhaustion of gpu resources.
     */
    export const DEFAULT_CHECKREADYFLAGS = {
        doNotLoad: false, doNotCheckGpu: false
    }

    export type CheckReadyFlags = typeof DEFAULT_CHECKREADYFLAGS;
}
