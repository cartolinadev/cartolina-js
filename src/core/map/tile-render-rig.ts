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
        layerDef: TileRenderRig.LayerDefs, tile: SurfaceTile, renderer: Renderer,
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
        // carry internal UVs and the surface is expected to provide internal
        // textures.
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
     * @param desired if 'full', the function makes all submesh resources ready.
     *      If 'fallback', only resources needed for fallback rendering are made
     *      ready.
     * @return true if resources are ready on the desired rendering level
     */
    isReady(minimum: TileRenderRig.Level = 'full',
            desired: TileRenderRig.Level = 'full',
            priority = TileRenderRig.DefaultPriority,
            options = TileRenderRig.DefaultIsReadyOptions): boolean {

        let layerStack = this.rt.layerStack;

        // if we have any 'notSureYet' masks, initiate checks and exit gracefully
        let unsureMasks = false;

        layerStack.forEach((item: Layer) => {

            if (item.rt && item.rt.hasMask === 'notSureYet') {

                //console.log('Checking mask for %s (%s): ', this.tile.id.join('-'), item.rt.layerId);

                console.assert(
                    item.source === 'texture', 'incompatible layer params');

                item.srcTextureTexture.isReady(
                    options.doNotLoad, priority.basic, options.doNotCheckGpu);

                item.rt.hasMask = TileRenderRig.hasMask(item.srcTextureTexture);

                item.rt.isWatertight =
                    item.rt.hasMask == 'no'
                    && item.opBlendAlpha.value === 1.0
                    && item.opBlendAlpha.mode == 'constant'
                    && item.opBlendMode == 'overlay'
                    && ! item.rt.isTransparent;

                if (item.rt.hasMask === 'notSureYet') unsureMasks = true;

            }
        });

        if (unsureMasks) return false;

        // actual readiness check
        // TODO

        return true;
    }

    /**
     * Process layer stack into actual draw calls, using the tile shader program.
     */
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


    private buildLayerStack(layerDefs: TileRenderRig.LayerDefs) {

        // build the stack
        const rt = this.rt;
        const tile = this.tile;

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
        let clampToLodRange = (tile: SurfaceTile, lodRange: number[]) => {

            while(tile && tile.id[0] > lodRange[1]) { tile = tile.parent; }
            return tile;
        }

        layerDefs.diffuseSequence.forEach((item) => {

            let layer: Layer | false = this.layerFromDef(item);
            if (layer) rt.layerStack.push(layer);
        });

        // if there is illumination, blend-multiply by a diffuse shading layer
        if (rt.illumination) {

            rt.layerStack.push({
                target: 'color',
                source: 'shade',
                operation: 'blend',
                srcShadeType: 'diffuse',
                srcShadeNormal: this.rt.normals ? 'normal' : 'flat',
                opBlendMode: 'multiply',
                opBlendAlpha: { mode: 'constant', value: 1.0 },
            });
        }

        // add specular bound layers (if illuminated)
        if (rt.illumination && layerDefs.specularSequence.length > 0) {

            // push black as background
            rt.layerStack.push({
                target: 'color',
                source: 'constant',
                operation: 'push',
                sourceConstant: [0, 0, 0]
            });


            // process specular sequence
            layerDefs.specularSequence.forEach((item) => {

                let layer: Layer | false = this.layerFromDef(item);
                if (layer) rt.layerStack.push(layer);

            }); // layerDef.specularSequence.forEach()

            // specular shade with specular multiply
            rt.layerStack.push({
                target: 'color',
                source: 'shade',
                operation: 'blend',
                srcShadeType: 'specular',
                srcShadeNormal: this.rt.normals ? 'normal' : 'flat',
                opBlendMode: 'specular-multiply',
                opBlendAlpha: { mode: 'constant', value: 1.0 }
            });

            // pop-add, to add to the underlying color
            rt.layerStack.push({
                target: 'color',
                source: 'pop',
                operation: 'blend',
                opBlendMode: 'add',
                opBlendAlpha: { mode: 'constant', value: 1.0 }
            });

        } // if (rt.illumination && layerDef.specularSequence.length > 0)

        // add atmosphere and shadows
        // TODO

        // add bump layers
        layerDefs.bumpSequence.forEach((item) => {

            // TODO
        }); // layerDef.bumpSequence.forEach()

        // optimize stack for non-transparency
        // TODO

        // turn off internal/external UVs if no layer needs them
        // TODO

        console.log('%s (%s):', this.tile.id.join('-'), tile.resourceSurface.id, this.rt.layerStack);
    }


    private static hasMask(texture: MapTexture): MaskStatus {

        if (texture.isMaskPossible()) {

            if (texture.isMaskInfoReady()) {

                if (texture.getMaskTexture()) return 'yes';
                return 'no';
            }

            return 'notSureYet';
        }

        return 'no';
    }


    private layerFromDef(layerDef: TileRenderRig.LayerDef): Layer | undefined {

        let tile = this.tile;
        const layer = layerDef.layer;

        let clampToLodRange = (tile: SurfaceTile, lodRange: number[]) => {

            while(tile && tile.id[0] > lodRange[1]) { tile = tile.parent; }
            return tile;
        }


        if (!(layer && layer.ready && layer.hasTileOrInfluence(tile.id)))
                return;

            let extraBound = null;

            if (tile.id[0] > layer.lodRange[1])
                extraBound = {
                    sourceTile: clampToLodRange(tile, layer.lodRange),
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

            let hasMask = TileRenderRig.hasMask(texture);

            let alpha_: any = layerDef.alpha;

            if (typeof layerDef.alpha === "number")
                alpha_ = { mode: 'constant', value: layerDef.alpha };


            let isWatertight = !(hasMask != 'no' || alpha_.value < 1.0
                || alpha_.mode != 'constant' || layerDef.mode != 'normal'
                || layer.isTransparent );

            let mode: BlendMode;
            switch (layerDef.mode) {

                case 'multiply': mode = 'multiply'; break;
                case 'normal': default: mode = 'overlay'; break;
            }

            let alpha: Alpha = {
                mode: alpha_.mode,
                value:alpha_.value
            }

            if (alpha_.mode === 'viewdep') {

                alpha.illuminationNED = Illumination.illuminationVector(
                    alpha_.illumination[0],
                    alpha_.illumination[1],
                    Illumination.CoordSystem.NED);
            }

            // ommit this silent side effect of the old code for now
            //tile.boundLayers[layer.id] = item.layer;

            return ({
                operation: 'blend',
                source: 'texture',
                target: 'color',

                srcTextureTexture: texture,
                srcTextureUVs: 'external',

                opBlendMode: mode,
                opBlendAlpha: alpha,

                rt: {
                    layerId: layer.id,
                    isWatertight: isWatertight,
                    hasMask: hasMask,
                    isTransparent: layer.isTransparent
                }
            });
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

type BlendMode = 'overlay' | 'add' | 'multiply' | 'specular-multiply';

type MaskStatus = 'yes' | 'no' | 'notSureYet';

/**
 * Layer stack item, basically an elementary instruction for the fragment shader.
 */

type Layer = {

    operation: 'blend'  | 'normal-blend' | 'push',
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
        layerId: string,
        hasMask: MaskStatus,
        isTransparent: boolean,
        isWatertight: boolean,
        vdalpha?: number,
    }
}


// export types
export namespace TileRenderRig {

    /**
     * the legacy layer definition (the three sequences in MapSurface)
     */

    export type LegacyLayerDef = {
        layer: MapBoundLayer,
        mode?: 'normal' | 'multiply'
        alpha: number | {
            value: number,
            mode?: AlphaMode,
            illumination?: [number, number]
        }
    }

    type LegacyLayerDefs = {

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
    export type LayerDef = LegacyLayerDef;
    export type LayerDefs = LegacyLayerDefs;


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
