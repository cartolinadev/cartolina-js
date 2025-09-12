/*
 * tilerenderrig.ts - prepare and draw mesh tiles
 */

import MapResourceNode from 'resource-node';
import MapSurface from 'surface';
import MapMesh from 'mesh';
import MapTexture from 'texture';
import MapBoundLayer from './bound-layer'
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

    private rt = {
        illumination: false,
        normals: false,
        externalUVs: false,
        internalUVs: false,
        layerStack: []
    }

    constructor(submeshIndex: number,
        layerDef: TileRenderRig.LayerDef, tile: SurfaceTile, renderer: Renderer,
        config: Config) {

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


        // build the layer stack - this may change the flags due to optimization
        this.buildLayerStack(layerDef);

        // shared resources
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
                path, vts.TEXTURETYPE_NORMALMAP, null, null, tile, true);
        }

    }

    /**
     * Make rig resources ready and check readiness.
     *
     * @param minimum if 'full', returns true only when all submesh resources
     *      are  ready. If 'fallback', returns when basic resources are ready.
     * @param desired if 'full', the functions makes extra resources ready.
     *      If 'fallback', only basicresources are made ready.
     * @return true if resources are ready on the desired rendering level
     */
    isReady(minimum: TileRenderRig.Level = 'full',
            desired: TileRenderRig.Level = 'full',
            priority = TileRenderRig.DefaultPriority,
            options = TileRenderRig.DefaultIsReadyOptions): boolean {

        return true;
    }

    draw(renderFlags: Partial<TileRenderRig.RenderFlags> = {}) {

        let flags = {...TileRenderRig.DefaultRenderFlags, ...renderFlags };
    }

    /**
     * retrieve a list of *active* layerIds from the tile, i.e. ids of layers
     * that will be actually used in rendering. This is used for assembling tile
     * credits.
     */
    activeLayerIds(): string[] {
        // TODO
        return []; }


    private buildLayerStack(layerDef: TileRenderRig.LayerDef) {

        // build the stack

        // always start by pushing the diffuse shading layer on the stack

        // and if there are no diffuse layers, multiply by constant color

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


type Layer = {

    operation: 'blend'  | 'normalBlend' | 'push',
    source: 'constant' | 'shade' | 'pop' | 'atmColor' | 'texture' | 'shadows',
    target: 'color' | 'normal',

    sourceConstant?: [number, number, number],

    srcShadeType?: 'diffuse' | 'specular',
    srcShadeNormal?: 'normal' | 'flat',

    srcTextureTexture?: MapTexture
    srcTextureMask?: MapTexture

    opBlendMode?: 'overlay' | 'add' | 'multiply',
    opBlendAlpha?: number,

    whitewash?: number,
}

const LayerDefaults: Partial<Layer> = {

    target: 'color'
}


// export types
export namespace TileRenderRig {

    /**
     * the legacy layer definition, effectively modeled by MapSurface
     */
    type SurfaceLayerDef = {

        boundLayerSequence: [
            MapBoundLayer,
            'normal', 'multiply',
            {
                value: number,
                mode?: 'constant' | 'viewdep',
                illumination?: [number, number]
            } ][];

        specularSequence: {
            layer: MapBoundLayer,
            alpha: number

        }[];

        bumpSequence: {
            layer: MapBoundLayer,
            alpha: number
        }[];
    }

    // to be widened to accomodate for new layer definition format
    export type LayerDef = SurfaceLayerDef;

    /**
     * rendering level, see TileRenderRig.isReady for details
     */
    export type Level = 'fallback' | 'full';

    /**
     * basic resources are necessary to render tile, extras are embelishments.
     */
    export const DefaultPriority = { basic: 0, extras: 0}

    export type Priority = typeof DefaultPriority;

    export const DefaultRenderFlags = {
        illumination: true,
        normalMap: true,
        bumps: true,
        diffuse: true,
        specular: true,
        atmosphere: false,
        shadows: false
    };

    export type RenderFlags = typeof DefaultRenderFlags;

    /**
     * These are passed to MapMesh.isReady() and MapTexture.isReady().
     *
     * The first one checks readiness without queueing requests for missing content.
     * The second one seems to prevent checking agains exhaustion of gpu resources.
     */
    export const DefaultIsReadyOptions = {
        doNotLoad: false, doNotCheckGpu: false
    }

    export type CheckReadyOptions = typeof DefaultIsReadyOptions;
}
