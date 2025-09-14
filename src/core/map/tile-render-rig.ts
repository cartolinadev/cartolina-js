/*
 * tilerenderrig.ts - prepare and draw mesh tiles
 */

import MapResourceNode from 'resource-node';
import MapSurface from 'surface';
import MapMesh from 'mesh';
import MapSubmesh from 'submesh';
import MapTexture from 'texture';
import MapBoundLayer from 'bound-layer'
import Renderer from '../renderer/renderer';
import * as Illumination from './illumination';

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
  * program, including optional atmospheric scattering, hence there is no "draw
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
    private submesh!: MapSubmesh;
    private submeshIndex!: number;

    normalMap?: MapTexture;


    private rt : {
        illumination: boolean,
        normals: boolean,
        externalUVs: boolean,
        internalUVs: boolean,
        layerStack: Layer[],
    } = {

        illumination: false,
        normals: false,
        externalUVs: false,
        internalUVs: false,
        layerStack: [],
    }

    constructor(submeshIndex: number,
        layerDef: TileRenderRig.LayerDef, tile: SurfaceTile, renderer: Renderer,
        config: Config) {

        this.tile = tile;
        this.renderer = renderer;
        this.config = config;

        this.mesh = tile.surfaceMesh;
        this.submeshIndex = submeshIndex;
        this.submesh = this.mesh.submeshes[submeshIndex];

        // examine surface
        const surface = tile.resourceSurface;


        this.rt.illumination
            = surface.normalsUrl && this.renderer.getIlluminationState()

        /** WARN: glues currently don't carry normalsUrls, so normal information
           is lost even when the original surface carried it. */
        this.rt.normals = surface.normalsUrl && ! config.mapNoNormalMaps;

        // if the surface publishes texture URLs its meshes are expected to
        // carry internal UVs and the surface is expected to provide internal textures.
        this.rt.internalUVs = !! surface.textureUrl;
        this.rt.externalUVs = !! surface.normalsUrl
            || surface.diffuseSequence.length > 0
            || surface.specularSequence.length > 0
            || surface.bumpSequence.length > 0;


        // build the layer stack - this may change the flags due to optimization
        this.buildLayerStack(layerDef);

        // shared resources
        if (this.rt.internalUVs) {
            // request internal texture

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
        const rt = this.rt;
        const tile = this.tile;

        // if there is illumination, start by pushing a diffuse shading layer
        if (rt.illumination) {

            rt.layerStack.push({
                target: 'color',
                source: 'shade',
                operation: 'push',
                srcShadeType: 'diffuse',
                srcShadeNormal: this.rt.normals ? 'normal' : 'flat'
            });
        }


        // push a constant (default) color as background
        rt.layerStack.push({
                target: 'color',
                source: 'constant',
                operation: 'push',
                sourceConstant: [0.9, 0.9, 0.8] // this could be configurable
        });

        // if internal textures exist, overlay an internal texture
        if (rt.internalUVs && this.submesh.internalUVs)  {

            let path = tile.resourceSurface.getTextureUrl(tile.id, this.submeshIndex);
            let internalTexture = tile.resources.getTexture(
                path, vts.TEXTURETYPE_COLOR, null, null, tile, true);

            rt.layerStack.push({
                target: 'color',
                source: 'texture',
                operation: 'blend',
                srcTextureTexture: internalTexture,
                srcTextureUVs: 'internal',
                opBlendMode: 'overlay',
                opBlendAlpha: { mode: 'constant', value: 1.0 },
            });

        }

        // add diffuse bound layers
        let getParentTile = (tile: SurfaceTile, lod: number) => {

            while(tile && tile.id[0] > lod) { tile = tile.parent; }
            return tile;
        }

        layerDef.diffuseSequence.forEach((item) => {

            const layer = item.layer;

            if (!(layer && layer.ready && layer.hasTileOrInfluence(tile.id)))
                return;

            let extraBound = null;

            if (tile.id[0] > layer.lodRange[1])
                extraBound = {
                    sourceTile: getParentTile(tile, layer.lodRange[1]),
                    sourceTexture: null, layer: layer, tile: tile };

            let texture: MapTexture = tile.boundTextures[layer.id];

            if (!texture) {

                let path = layer.getUrl(tile.id);
                texture = tile.resources.getTexture(
                    path, layer.dataType, extraBound,
                    {tile: tile, layer: layer}, tile, false);

                if (texture.checkType == vts.TEXTURECHECK_METATILE) {
                    texture.checkMask = true;
                }

                texture.isReady(true); //check metatile/mask but do not load
                tile.boundTextures[layer.id] = texture;
            }

            if (texture.neverReady) return;

            let isOpaque = true;

            if (texture.isMaskPossible() || item.alpha.value < 1.0
                || item.alpha.mode != 'constant' || item.mode != 'normal'
                || layer.isTransparent ) isOpaque = false;

            let mode: BlendMode;
            switch (item.mode) {
                case 'multiply': mode = 'multiply'; break;
                case 'normal': default: mode = 'overlay'; break;
            }

            let alpha: Alpha = {
                mode: item.alpha.mode,
                value: item.alpha.value
            }

            if (item.alpha.mode === 'viewdep') {

                alpha.illuminationNED = Illumination.illuminationVector(
                    item.alpha.illumination[0],
                    item.alpha.illumination[1],
                    Illumination.CoordSystem.NED);

            }

            // ommit this silent side effect of the old code for now
            //tile.boundLayers[layer.id] = item.layer;

            rt.layerStack.push({
                operation: 'blend',
                source: 'texture',
                target: 'color',

                srcTextureTexture: texture,
                srcTextureUVs: 'external',

                opBlendMode: mode,
                opBlendAlpha: alpha,

                rt: { isOpaque: isOpaque }
            });


        }); // layerDef.diffuseSequence.forEach((item)

        // if there is illumination, add a pop-multiply
        if (rt.illumination)  {

            rt.layerStack.push({
                target: 'color',
                source: 'pop',
                operation: 'blend',
                opBlendMode: 'multiply',
                opBlendAlpha: { mode: 'constant', value: 1.0 },
            });
        }

        // push black on top (init specular sequence)

        // add specular bound layers

        // add addition - pop

        // add atmosphere and shadows


        // add bump layers


        // optimize stack for non-transparency
        // TODO

        // turn off internal/external UVs if no layer needs them
        // TODO

        //console.log(tile.resourceSurface.id, tile.id, this.rt.layerStack);
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

    parent?: SurfaceTile;

    resources: MapResourceNode;
    resourceSurface: MapSurface;
    surfaceMesh: MapMesh;

    boundTextures: { [key: string]: MapTexture };
}

type AlphaMode = 'constant' | 'viewdep';

type Alpha = {
    mode: AlphaMode,
    value: number,
    illuminationNED?: Illumination.vec3
}

type BlendMode = 'overlay' | 'add' | 'multiply';

type Layer = {

    operation: 'blend'  | 'normalBlend' | 'push',
    source: 'constant' | 'shade' | 'pop' | 'atmColor' | 'texture' | 'shadows',
    target: 'color' | 'normal',

    sourceConstant?: [number, number, number],

    srcShadeType?: 'diffuse' | 'specular',
    srcShadeNormal?: 'normal' | 'flat',

    srcTextureTexture?: MapTexture,
    srcTextureUVs?: 'internal' | 'external',
    //srcTextureMask?: MapTexture,

    opBlendMode?: BlendMode,
    opBlendAlpha?: Alpha,

    whitewash?: number,

    rt?: {
        isOpaque?: boolean,
        vdalpha?: number,
    }
}


// export types
export namespace TileRenderRig {

    /**
     * the legacy layer definition (the thre sequences in MapSurface)
     */

    type SurfaceLayerDef = {

        diffuseSequence: {
            layer: MapBoundLayer,
            mode: 'normal' | 'multiply',
            alpha: {
                    value: number,
                    mode?: AlphaMode,
                    illumination?: [number, number]
                }
            }[];

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
