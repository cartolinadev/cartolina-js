/*
 * tilerenderrig.ts - prepare and draw mesh tiles
 */

import MapResourceNode from './resource-node';
import MapSurface from './surface';
import MapMesh from './mesh';
import MapSubmesh from './submesh';
import MapTexture from './texture';
import MapBoundLayer from './bound-layer'
import Renderer from '../renderer/renderer';
import GpuProgram from '../renderer/gpu/program';
import GpuMesh from '../renderer/gpu/mesh';
import Atmosphere from './atmosphere';

import * as illumination from './illumination';
import * as math from '../utils/math';
import * as matrix from '../utils/matrix';
import * as utils from '../utils/utils';
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

    private normalMap?: MapTexture;

    private uboLayers?: WebGLBuffer;


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

        // prepare normal map texture if applicable
        if (this.rt.normals) {

            // request normal map
            let path = surface.getNormalsUrl(tile.id, submeshIndex);
            this.normalMap = tile.resources.getTexture(
                path, vts.TEXTURETYPE_NORMALMAP, null, null, tile, true);
        }

        // done

    } // constructor

    /**
     * Make rig resources ready and check readiness.
     *
     * @param readiness the two levels of readiness requested. *Minimum* controls
     *     which resources suffice for the tile rig to be evaluated as ready.
     *     *Desired* controls which resources the method *attempts* to make
     *     ready (activates their readiness triggers).
     * @param priority the priority for essential and optional resources.
     * @return true if resources are ready on the desired rendering level
     */
    isReady(readiness: TileRenderRig.ReadinessLevels = {
                minimum : 'full', desired: 'full' },
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
                    options.doNotLoad, priority.essential, options.doNotCheckGpu);

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

        // actual readiness starts
        let ready_: boolean = true;

        // mesh is always essential
        ready_ &&= TileRenderRig.isResourceReady(this.mesh, 'essential',
            readiness, priority, options);

        // process layerStack
        layerStack.forEach((item: Layer) => {
            ready_ &&= this.isLayerReady(item, readiness, priority, options)
        });

        /*if (ready_ && utils.compareTuples(this.tile.id, [15, 8772, 5758])) {
            console.log('%s render-ready.', this.logSign());
        }*/

        // if the rig is ready and uboLayers has not been created, create it
        if (ready_ && !this.uboLayers) this.createBuffer();

        // done
        return ready_;
    }

    /**
     * Process layer stack into an actual draw call, using the tile shader program.
     */
    draw(program: GpuProgram, cameraPos: math.vec3) {

        let renderer = this.renderer;


        if (!this.uboLayers) {
            console.warn(`draw called on an unready rig for ${this.logSign()}.`);
            return;
        }

        // uModel
        program.setMat4('uModel', this.submesh.getWorldMatrix(cameraPos));

        // uClip
        let splitMask = this.tile.splitMask || [1, 1, 1, 1];

        program.setFloatArray('uClip', splitMask);

        // rebuild the layer buffer, set sampler arrays, bind textures and buffer base
        this.updateBuffer(program);

        // temporary stuff for testing
        if (this.normalMap && this.normalMap.getGpuTexture()) {
            renderer.gpu.bindTexture(this.normalMap.getGpuTexture(), 0);
            program.setSampler('material.normalMap', NormalMapTextureIdx);
        }

        program.setFloat('material.shininess', 1.0);

        // draw
        let attrNames: GpuMesh.AttrNames = { position: 'aPosition' };
        if (this.rt.internalUVs) attrNames.uvs = 'aTexCoords';
        if (this.rt.externalUVs) attrNames.uvs2 = 'aTexCoords2';


        this.mesh.gpuSubmeshes[this.submeshIndex].draw2(program, attrNames);

        //console.log(`this.logSign(): draw.`);
    }

    /**
     * create the layer UBO
     */
    private createBuffer() {

        let gl = this.renderer.gpu.gl;

        this.uboLayers = gl.createBuffer();

        gl.bindBuffer(gl.UNIFORM_BUFFER, this.uboLayers);

        gl.bufferData(gl.UNIFORM_BUFFER, UboLayersSize, gl.DYNAMIC_DRAW);
        gl.bindBuffer(gl.UNIFORM_BUFFER, null);
    }

    /**
     * Rebuild the layer UBO, bind textures and set the sampler array uniform
     */
    private updateBuffer(program: GpuProgram) {

        let renderer = this.renderer;
        let gl = this.renderer.gpu.gl;

        // bind buffer base
        gl.bindBufferBase(gl.UNIFORM_BUFFER,
            Renderer.UniformBlockName.Layers, this.uboLayers);


        // update dynamic (vd) alpha values
        // TODO

        // now the buffer - one backing buffer, two typed views
        const buf = new ArrayBuffer(UboLayersSize);

        const bufacc = {
            f32: new Float32Array(buf), // for vec4
            i32: new Int32Array(buf),   // for ivec
            offset: 0
        }

        // samplers array
        let samplers = {

            samplers: new Int32Array(MaxTextures),
            nextTextureUnit: FirstLayerTextureUnit,
            ub: FirstLayerTextureUnit + MaxTextures
        }

        // we encode the layers first: due to fallback rendering, we
        // do not know the count until we process all of them
        let numLayers = 0;
        bufacc.offset = 16;

        this.rt.layerStack.forEach((layer) => {

            // sanity
            if (numLayers >= MaxLayers)
                throw Error('maximum rendering layers exhausted, aborting.');

            // a zero-trigger readiness check
            let ready = this.isLayerReady(layer,
                { minimum: 'full', desired: 'full' },
                TileRenderRig.DefaultPriority,
                { doNotLoad: true, doNotCheckGpu: true });

            if (!ready) return;

            // LayerRaw layers[16];
            this.encodeLayer(layer, bufacc, samplers)
            numLayers++;
        })

        // set the layer count last
        bufacc.i32.set([numLayers], 0);            // ivec4 layerCount

        if (numLayers < this.rt.layerStack.length)
            __DEV__ && console.log(`${this.logSign()}: encoded ${numLayers}
                / ${this.rt.layerStack.length} layers.`);

        // update buffer
        gl.bindBuffer(gl.UNIFORM_BUFFER, this.uboLayers);
        gl.bufferSubData(gl.UNIFORM_BUFFER, 0, buf);
        gl.bindBuffer(gl.UNIFORM_BUFFER, null);


        // sampler array uniform
        program.setIntArray('uTexture[0]', samplers.samplers);


        //console.log(`${this.logSign()}: bound `
        //    + `${samplers.nextTextureUnit - FirstLayerTextureUnit} texture units.`);
    }


    private encodeLayer(layer: Layer,
        bufacc: { f32: Float32Array, i32: Int32Array, offset: number },
        samplers: { samplers: Int32Array, nextTextureUnit: number,
                    ub: number }) {

        let renderer = this.renderer;

        // struct LayerRaw {


        // ivec4 tag
        // target
        let target = -1;

        switch (layer.target) {

            case 'color': target = UboTarget.Color; break;
            case 'normal': target = UboTarget.Normal; break;
        }

        bufacc.i32.set([target], bufacc.offset / 4); bufacc.offset += 4;    // tag.x

        // source
        let source = -1;

        switch (layer.source) {

            case 'constant': source = UboSource.Constant; break;
            case 'shade': source = UboSource.Shade; break;
            case 'pop': source = UboSource.Pop; break;
            case 'atm-density': source = UboSource.AtmDensity; break;
            case 'texture': source = UboSource.Texture; break;
            case 'none': source = UboSource.None; break;
        }

        bufacc.i32.set([source], bufacc.offset / 4); bufacc.offset += 4;    // tag.y

        // operation
        let operation = -1;

        switch (layer.operation) {

            case 'blend': operation = UboOperation.Blend; break;
            case 'normal-blend': operation = UboOperation.NormalBlend; break;
            case 'push': operation = UboOperation.Push; break;
            case 'atm-color': operation = UboOperation.AtmColor; break;
            case 'shadows': operation = UboOperation.Shadows; break;
        }

        bufacc.i32.set([operation], bufacc.offset / 4); bufacc.offset += 4; // tag.z
        bufacc.offset += 4;                                                 // tag.w

        // vec4 p0
        // vec4 p1
        // vec4 p2

        // TODO

        if (layer.source !== 'texture') return;

        let main = layer.srcTextureTexture.getGpuTexture();

        if (main) {
            //console.log(`${this.logSign()}: binding ${layer.rt.layerId} main.`);
            renderer.gpu.bindTexture(main, samplers.nextTextureUnit++);
        }

        let mask = layer.srcTextureTexture.getGpuMaskTexture();

        if (mask) {
            //console.log(`${logSign()}: binding ${layer.rt.layerId} mask.`);
            renderer.gpu.bindTexture(mask, samplers.nextTextureUnit++);
        }

    }

    /*
     * delete the external gpu resources
     */
    dispose() {

        __DEV__ && console.log(
            `Disposing of UBO for ${this.logSign()}.`);

        let gl = this.renderer.gpu.gl;

        gl.deleteBuffer(this.uboLayers);
    }

    /**
     * retrieve a list of *active* layerIds from the tile, i.e. ids of layers
     * that have beeen actually used in rendering. This is used for assembling tile
     * credits.
     */

    activeLayerIds(readiness: TileRenderRig.ReadinessLevels
        = { minimum: 'full', desired: 'full' }): string[] {

        const options: TileRenderRig.IsReadyOptions
            = { doNotLoad: true, doNotCheckGpu: true };

        let ret = [] as string[];

        this.rt.layerStack.forEach((item: Layer) => {

            // priority is irelevant, we load nothing
            if (this.isLayerReady(item, readiness,
                TileRenderRig.DefaultPriority, options)
                && item.rt && item.rt.layerId)
                ret.push(item.rt.layerId);
        });

        //console.log(this.logSign(), ret);

        return ret;
    }


    private buildLayerStack(layerDefs: TileRenderRig.LayerDefs) {

        // build the stack
        const rt = this.rt;
        const tile = this.tile;

        // target 'normal' layers need to come first, so that updated normal
        // is used for target 'color'

        // add bump layers, if any
        layerDefs.bumpSequence.forEach((item) => {

            let layer: Layer | false = this.layerFromDef(item, 'optional',
                false, 'normal');

            if (layer) rt.layerStack.push(layer);

        }); // layerDef.bumpSequence.forEach()

        // target 'color'

        // push a constant (default) color as background
        rt.layerStack.push({
                target: 'color',
                source: 'constant',
                operation: 'push',
                necessity: 'essential',
                srcConstant: [0.9, 0.9, 0.8] // this could be configurable
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
                necessity: 'essential',
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
                necessity: 'essential',
                srcShadeType: 'diffuse',
                srcShadeNormal: this.rt.normals ? 'normal-map' : 'flat',
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
                necessity: 'essential',  // sanity
                srcConstant: [0, 0, 0]
            });


            // process specular sequence
            layerDefs.specularSequence.forEach((item) => {

                let layer: Layer | false = this.layerFromDef(item, 'optional');
                if (layer) rt.layerStack.push(layer);

            }); // layerDef.specularSequence.forEach()

            // specular shade with specular multiply
            rt.layerStack.push({
                target: 'color',
                source: 'shade',
                operation: 'blend',
                necessity: 'essential', // sanity
                srcShadeType: 'specular',
                srcShadeNormal: this.rt.normals ? 'normal-map' : 'flat',
                opBlendMode: 'specular-multiply',
                opBlendAlpha: { mode: 'constant', value: 1.0 }
            });

            // pop-add, to add to the underlying color
            rt.layerStack.push({
                target: 'color',
                source: 'pop',
                operation: 'blend',
                necessity: 'essential', // sanity
                opBlendMode: 'add',
                opBlendAlpha: { mode: 'constant', value: 1.0 }
            });

        } // if (rt.illumination && layerDef.specularSequence.length > 0)

        // add atmosphere
        if (tile.map.atmosphere) {

            rt.layerStack.push({
                target: 'color',
                source: 'atm-density',
                necessity: 'optional',
                operation: 'atm-color',
            });
        }

        // add shadows
        rt.layerStack.push({
            target: 'color',
            source: 'none',
            necessity: 'optional',
            operation: 'shadows',
        });

        // optimize stack,
        // TODO

        // turn off internal/external UVs if no layer needs them?
        // console.log('%s (%s):', this.tile.id.join('-'), tile.resourceSurface.id, this.rt.layerStack);
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


    /**
     * Create an internal layer operation (blend) with texture source from
     * a layer definition.
     *
     * @param layerDef layerDefinition
     * @param necessity is layer necessary or optional for rendering
     * @param propagate: should layer tiles propage beyeond their lodRange to
     *      higher lods? Usually true.
     * @param target 'color' (for the fragment color stack) or 'normal'
     *      (for the surface normal stack), normally 'color'.
     * @return resultant layer operation, or undefined if layer def yields none.
     */

    private layerFromDef(layerDef: TileRenderRig.LayerDef,
                         necessity: Necessity = 'essential',
                         propagate: boolean = true,
                         target: 'color' | 'normal' = 'color' ): Layer | undefined {

        let tile = this.tile;
        const layer = layerDef.layer;

        let clampToLodRange = (tile: SurfaceTile, lodRange: number[]) => {

            while(tile && tile.id[0] > lodRange[1]) { tile = tile.parent; }
            return tile;
        }


        if (!(layer && layer.ready && layer.hasTileOrInfluence(tile.id)))
                return;

            let extraBound = null;

            if (propagate) {

                // normally, we want to fallback to higher lod tiles if
                // tiles are not available on the requested lod. This provides
                // necessary information to MapTexture. In some cases, like
                // bump maps, this is not desirable.
                if (tile.id[0] > layer.lodRange[1])
                    extraBound = {
                        sourceTile: clampToLodRange(tile, layer.lodRange),
                        sourceTexture: null, layer: layer, tile: tile };

            }

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

                alpha.illuminationNED = illumination.illuminationVector(
                    alpha_.illumination[0],
                    alpha_.illumination[1],
                    illumination.CoordSystem.NED);
            }

            let whitewash = 0.0;

            if (layer.shaderFilters
                && layer.shaderFilters[tile.resourceSurface.id]
                && layer.shaderFilters[tile.resourceSurface.id].whitewash) {

                whitewash = layer.shaderFilters[
                    tile.resourceSurface.id].whitewash;
            }


            // not a pretty side effect, copied verbatim from old code.
            // needed for credits extraction
            this.tile.boundLayers[layer.id] = layer;

            return ({
                operation: 'blend',
                source: 'texture',
                target: target,

                necessity: necessity,

                srcTextureTexture: texture,
                srcTextureUVs: 'external',
                srcTextureTransform: texture.getTransform(),

                opBlendMode: mode,
                opBlendAlpha: alpha,

                tgtColorWhitewash: whitewash,

                rt: {
                    layerId: layer.id,
                    isWatertight: isWatertight,
                    hasMask: hasMask,
                    isTransparent: layer.isTransparent
                }
            });
    } // layerFromDef

    /**
     * Check if a given resource satifies the readiness condition, given the
     * necessity of the resource and the requested readiness levels.
     *
     * The side effect is making the resource ready if input values imply it
     * should be used for rendering.
     */
    private static isResourceReady(
        resource: MapMesh | MapTexture | Atmosphere,
        necessity: Necessity,
        readiness: TileRenderRig.ReadinessLevels,
        priority: TileRenderRig.Priority,
        options: TileRenderRig.IsReadyOptions) : boolean {


        let priority_: number =  priority[necessity];

        // coalasce desired >= minimum
        let minimum = readiness.minimum;
        let desired = readiness.minimum === 'fallback' ? readiness.desired : 'full';

        if (necessity === 'optional') {

            // optional resource in purely fallback rendering, ok
            if (desired === 'fallback')  return true;

            // optional resource, desired but not necessary
            if (minimum === 'fallback') {
                resource.isReady(options.doNotLoad, priority_,
                                 options.doNotCheckGpu);
                return true;
            }
        }

        // essential resource, or full readiness level requested
        return resource.isReady(options.doNotLoad,
                                 priority_, options.doNotCheckGpu);
    }

    private isLayerReady(layer: Layer,
        readiness: TileRenderRig.ReadinessLevels,
        priority: TileRenderRig.Priority,
        options: TileRenderRig.IsReadyOptions) : boolean {

        let ready_ = true;
        let necessity = layer.necessity;

        switch (layer.source) {

            case 'shade':
                if (this.rt.normals)
                    ready_ &&= TileRenderRig.isResourceReady(this.normalMap,
                        necessity, readiness, priority, options);
                break;

            case 'texture':
                ready_ &&= TileRenderRig.isResourceReady(layer.srcTextureTexture,
                        necessity, readiness, priority, options);
                break;

            case 'atm-density':
                ready_ &&= TileRenderRig.isResourceReady(
                        this.tile.map.atmosphere,
                        necessity, readiness, priority, options);
                break;
        }

        return ready_;
    }


    /*
     * helper for diagnostics
     */
    private logSign(): string {

        return utils.idToString([...this.tile.id, this.submeshIndex]);
    }

}; // class TileRenderRig


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

    map: { atmosphere?: Atmosphere };

    splitMask?: [number, number, number, number];

    boundTextures: { [key: string]: MapTexture };

    // lookup bound layer by id
    boundLayers: { [key:string]: MapBoundLayer };
}

type Necessity = 'essential' | 'optional';

type AlphaMode = 'constant' | 'viewdep' | 'atm-density';

type Alpha = {
    mode: AlphaMode,
    value: number,
    illuminationNED?: math.vec3
}

type BlendMode = 'overlay' | 'add' | 'multiply' | 'specular-multiply';

type MaskStatus = 'yes' | 'no' | 'notSureYet';

/**
 * Layer stack item, basically an elementary instruction for the fragment shader.
 */

type Layer = {

    target: 'color' | 'normal',
    source: 'constant' | 'shade' | 'pop' | 'atm-density' | 'texture' | 'none',
    operation: 'blend'  | 'normal-blend' | 'push' | 'atm-color' | 'shadows',

    necessity: Necessity;

    srcConstant?: [number, number, number],

    srcShadeType?: 'diffuse' | 'specular',
    srcShadeNormal?: 'normal-map' | 'flat',

    srcTextureTexture?: MapTexture,
    srcTextureUVs?: 'internal' | 'external',
    // look for: uParams[8..11] in old tile shader
    srcTextureTransform?: [number, number, number, number]

    opBlendMode?: BlendMode,
    opBlendAlpha?: Alpha,

    tgtColorWhitewash?: number,

    rt?: {

        layerId: string,
        hasMask: MaskStatus,
        isTransparent: boolean,
        isWatertight: boolean,
        vdalpha?: number,
    }
}


// if you change this, change the corresponding literals in layers.inc.glsl
const NormalMapTextureIdx = 0;
const MaxLayers = 16;
const MaxTextures = 14;
const FirstLayerTextureUnit = NormalMapTextureIdx + 1;

// 1x ivec4 + MaxTextures * (2x ivec4 + 2x vec4)
const UboLayersSize = 16 + MaxLayers * 64;


enum UboTarget {

    Color              = 0,
    Normal             = 1
}


enum UboSource {

    Constant           = 0,
    Texture            = 1,
    Pop                = 2,
    Shade              = 3,
    AtmDensity         = 4,
    Shadows            = 5,
    None               = 6
}


enum UboOperation {

    Blend           = 0,
    Push            = 1,
    AtmColor        = 2,
    Shadows         = 4,
    NormalBlend     = 5
}

enum uboShadeType {

    Diffuse         = 0,
    Specular        = 1
}

enum uboShadeNormal {

    NormalMap     = 0,
    Flat          = 1
}

enum uboBlendMode {

    Overlay             = 0,
    Add                 = 1,
    Multiply            = 2,
    specularMultiply    = 3
}


enum textureUVs {

    External           = 0,
    Internal           = 1
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
     * resrouce readiness level, see TileRenderRig.isReady for details
     */
    export type ReadinessLevel = 'fallback' | 'full';

    /**
     * the levels of readiness passed to isReady checks
     */
    export type ReadinessLevels = {
        minimum: ReadinessLevel,
        desired: ReadinessLevel }

    /**
     * basic resources are necessary to render tile, extras are embelishments.
     */
    export const DefaultPriority = { essential: 0, optional: 0}

    export type Priority = typeof DefaultPriority;

    /**
     * These are passed to MapMesh.isReady() and MapTexture.isReady().
     *
     * The first one checks readiness without queueing requests for missing content.
     * The second one seems to prevent checking agains exhaustion of gpu resources.
     */
    export const DefaultIsReadyOptions = {
        doNotLoad: false, doNotCheckGpu: false
    }

    export type IsReadyOptions = typeof DefaultIsReadyOptions;
}
