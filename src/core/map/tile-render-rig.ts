/*
 * tilerenderrig.ts - prepare and draw mesh tiles
 */

import MapResourceNode from 'resource-node';
import MapSurface from 'surface';
import MapMesh from 'mesh';
import MapTexture from 'texture';
import Renderer from '../renderer/renderer';

import * as vts from '../constants';


//import * as utils from '../utils/utils';


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
  * There are two levels of draw readiness: full readiness (or simply readiness)
  * and fallback readiness. The fallback readiness is meant for a tile that is
  * meant to be a replacement for better (typically higher resolution) data.
  * This matters: not all data are made ready for the sake of fallback readiness.
  */

export class TileRenderRig {

    private readonly config!: Config;
    private readonly tile!: SurfaceTile;
    private readonly renderer!: Renderer;

    private mesh!: MapMesh;
    normalMap?: MapTexture;
    internalTexture?: MapTexture;

    rt = {
        illumination: false,
        normals: false,
        externalUVs: false,
        internalUVs: false
    }

    constructor(submeshIndex: number, tile: SurfaceTile, renderer: Renderer,
        config: Config,
        priority: TileRenderRig.Priority = TileRenderRig.DEFAULT_PRIORITY) {

        this.tile = tile;
        this.renderer = renderer;
        this.config = config;

        this.mesh = tile.surfaceMesh;

        // examine surface
        const surface = tile.resourceSurface;


        this.rt.illumination = this.renderer.getIlluminationState()

        /** WARN: glues currently don't carry normalsUrls, so normal information
           is lost even when the original surface carried it. */
        this.rt.normals = surface.normalsUrl && ! config.mapNoNormalMaps;

        // unlike the old pipeline, we guess the presence of external and internal
        // UVs from surface definition. If the surface publishes texture URLs
        // its meshes are expected to carry internal UVs and the surface is
        // expected to provide internal textures.
        this.rt.internalUVs = !! surface.textureUrl;
        this.rt.externalUVs = !! surface.normalsUrl
            || surface.boundLayerSequence.length > 0
            || surface.specularSequence.length > 0
            || surface.bumpSequence.length > 0;


        // build the layer stack - this may change the flags above
        this.buildLayerStack();

        if (this.rt.internalUVs) {
            // request internal texture
            let path = tile.resourceSurface.getTextureUrl(tile.id, submeshIndex);
            this.internalTexture = tile.resources.getTexture(
                path, vts.TEXTURETYPE_COLOR, null, null, tile, true);

        }

        if (this.rt.normals) {

            // request normal map
            let path = surface.getNormalsUrl(tile.id, submeshIndex);
            this.normalMap = tile.resources.getTexture(
                path, vts.TEXTURETYPE_COLOR, null, null, tile, true);
        }

    }

    isReady(minimum: TileRenderRig.Level = 'full',
            desired: TileRenderRig.Level = 'full',
            options = TileRenderRig.DEFAULT_ISREADY_OPTIONS): boolean {

        return true;
    }

    draw(renderFlags: Partial<TileRenderRig.RenderFlags> = {}) {

        let flags = {...TileRenderRig.DEFAULT_RENDER_FLAGS, ...renderFlags };
    }

    /**
     * retrieve a list of *active* layerIds from the tile, i.e. ids of layers
     * that will be actually used in rendering. This is used for assembling tile
     * credits.
     */
    activeLayerIds(): string[] {
        // TODO
        return []; }


    private buildLayerStack() {

        // build the stack
        // optimize it for non-transparency
        // turn off internal/external UVs if no layer needs them
    }
};


// local types

type Config = {
    [key: string]: boolean | number | string | number[];

    // do not download or use normal maps (use GL derivatives instead)
    mapNoNormalMaps?: boolean;
}

type SurfaceTile = {

    id: [number, number, number];

    resources: MapResourceNode;
    resourceSurface: MapSurface;
    surfaceMesh: MapMesh;
}


// export types
export namespace TileRenderRig {

    export type Level = 'fallback' | 'full';


    export const DEFAULT_PRIORITY = { bare: 0, full: 0}

    export type Priority = typeof DEFAULT_PRIORITY;

    export const DEFAULT_RENDER_FLAGS = {
        illumination: true,
        normalMap: true,
        bumps: true,
        diffuse: true,
        specular: true,
        atmosphere: false,
        shadows: false
    };

    export type RenderFlags = typeof DEFAULT_RENDER_FLAGS;

    /**
     * These are passed to MapMesh.isReady() and MapTexture.isReady().
     *
     * The first one checks readiness without queueing requests for missing content.
     * The second one seems to prevent checking agains exhaustion of gpu resources.
     */
    export const DEFAULT_ISREADY_OPTIONS = {
        doNotLoad: false, doNotCheckGpu: false
    }

    export type CheckReadyOptions = typeof DEFAULT_ISREADY_OPTIONS;
}
