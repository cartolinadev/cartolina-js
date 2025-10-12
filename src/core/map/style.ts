
import Map from '../map/map';

import MapRefFrame from '../map/refframe';
import MapSrs from '../map/srs';
import MapBody from '../map/body';
import Atmosphere from '../map/atmosphere';
import MapSurface from '../map/surface';
import MapCredit from '../map/credit';
import MapUrl from '../map/url';
import MapBoundLayer from '../map/bound-layer';

import typia from "typia";


import * as utils from '../utils/utils';

/**
 * The style specification.
 */

export namespace MapStyle {

export interface StyleSpecification  {

    version: 2;
    'reference-frame'?: string;

    sources: Record<string, SourceSpecification>;

    terrain: TerrainSpecification;

    layers?: LayerSpecification[];

    constants?: Record<string, any>;
    bitmaps?: Record<string, Expression>;
    fonts?: Record<string, string>;

    illumination?: IlluminationSpecification;
    verticalExaggeration?: VerticalExaggerationSpecification;

    atmosphere?: AtmosphereSpecification;
    shadows?: any;
}

export type SourceSpecification =
    | CartolinaSurfaceSource
    | CartolinaTmsSource
    | CartolinaFreeLayerSource;


type SourceBase<TType extends string> = {
    type: TType,
    url: string
}

export type CartolinaSurfaceSource = SourceBase<'cartolina-surface'>
export type CartolinaTmsSource = SourceBase<'cartolina-tms'>
export type CartolinaFreeLayerSource = SourceBase<'cartolina-freelayer'>

export type TerrainSpecification = {

    sources: string[]
}


export type LayerSpecification =
    | TileLayer
    | LetteringLayer;


export type TileLayer = TileTextureLayer | TileConstantLayer;

export type LetteringLayer = LabelsLayer | LinesLayer

export type TileTextureLayer = DiffuseMapLayer | BumpMapLayer | SpecularMapLayer;

export type TileConstantLayer = DiffuseConstantLayer;

export type LayerBase<TType extends string> = {

    type: TType,
    necessity?: 'optional' | 'essential'
}

export type TileLayerBase<TType extends string> = LayerBase<TType> & {

    terrain?: string[]
    source: string,
    whitewash?: number,
    blendMode?: BlendMode,
    alpha?: Alpha
}

export type DiffuseLayer = DiffuseMapLayer | DiffuseConstantLayer;

export type DiffuseMapLayer = Omit<TileLayerBase<'diffuse-map'>, 'type'> & {

    type?: 'diffuse-map',
}

export type DiffuseConstantLayer = Omit<TileLayerBase<
    'constant' | 'diffuse-constant'>, 'source'> & {

    source: Color3Spec
}

export type SpecularMapLayer = TileLayerBase<'specular-map'>;
export type BumpMapLayer = TileLayerBase<'bump-map'>;

export type LetteringLayerBase<TType extends string> = LayerBase<TType> & {

    id: string,
    type: TType,
    source: string,

    filter?: FilterCondition

} & Partial<LetteringLayerProperties>

export type LabelsLayer = LetteringLayerBase<'labels'>;
export type LinesLayer = LetteringLayerBase<'lines'>;

export type LetteringLayerProperties = {

    inherit : string,

    'importance-source': Property<number>,
    'importance-weight': Property<number>,

    pack: Property<boolean>,
    hysteresis: [number, number, string, boolean],


    line: Property<boolean>,
    'line-flat': Property<boolean>,
    'line-width': Property<number>,
    'line-width-units': 'pixels' | 'meters' | 'ratio',
    'line-style':  'solid' | 'textured',
    'line-style-texture': [string, number, number],
    'line-style-background': Property<Color4Spec>,
    'line-color': Property<Color4Spec>,
    'line-label': Property<boolean>,
    'line-label-font': Property<string[]>,
    'line-label-color': Property<Color4Spec>,
    'line-label-color2': Property<Color4Spec>,
    'line-label-outline': Property<[number, number, number, number]>,
    'line-label-source': Property<string>,
    'line-label-size': Property<number>,
    'line-label-offset': Property<number>,
    'line-label-no-overlap': Property<boolean>,
    'line-label-no-overlap-margin': Property<number>,

    point: Property<boolean>,
    'point-flat': Property<boolean>,
    'point-radius': Property<number>,
    'point-style': 'solid',
    'point-color': Property<Color4Spec>,

    icon: Property<boolean>,
    'icon-source': Property<[string, number, number, number]>,
    'icon-scale': Property<number>,
    'icon-offset': Property<[number, number]>,
    'icon-origin': Property<number[]>,
    'icon-stick': Property<number[]>,

    label: Property<boolean>,
    'label-font': Property<string[]>,
    'label-source': Property<string>,
    'label-size': Property<number>,
    'label-color': Property<Color4Spec>,
    'label-color2': Property<Color4Spec>,

    'label-outline': Property<[number, number, number, number]>,
    'label-offset': Property<[number, number]>,
    'label-origin': Property<number[]>,
    'label-align': 'left' | 'right' | 'center',
    'label-width': Property<number>,
    'label-stick': Property<number[]>,
    'label-no-overlap': boolean,
    'label-no-overlap-margin': [number, number],

    polygon: boolean,
    'polygon-color': Property<Color4Spec>,

    'z-index': Property<number>,
    'z-buffer-offset': Property<[number, number, number]>,
    'selected-layer' : Property<string>,
    'selected-hover-layer': Property<string>,
    'enter-event': Property<boolean>,
    'leave-event': Property<boolean>,
    'hover-event': Property<boolean>,
    'hover-layer': Property<string>,
    'click-event': Property<boolean>
    'advanced-hit': Property<boolean>

    'visible': Property<boolean>,
    'visibility': Property<number>,
    'visibility-abs': Property<[number, number]>,
    'visibility-rel': Property<[number, number, number, number]>,
    'visibility-switch': [['string', 'string']],
    'culling': Property<number>,

    'next-pass': [number, string]
}


export type Expression = {} | string;

export type Property<T> = T | Expression;

export type FilterCondition = any[];

export type Color3Spec = [number, number, number]
export type Color4Spec = [number, number, number, number]

export type BlendMode = 'overlay' | 'add' | 'multiply'

export type AlphaMode = 'constant' | 'viewdep'

export type Alpha = number
    | { mode: AlphaMode, value: number, illumination?: [number, number] }

export type IlluminationSpecification = {

    light: ['tracking', number, number],
    ambientCoef?: number
}

export type VerticalExaggerationSpecification =  {

    heightRamp?: [[number, number], [number, number]],
    viewExtentProgression?: [number, number, number, number, number]
}

export type AtmosphereSpecification = Partial<Atmosphere.Specification>;

} // export namespace MapStyle

const validateStyle = typia.createValidate<MapStyle.StyleSpecification>();

/// vts stylesheet shape, compile from style for goedata free layer rendering

type vtsStylesheet = {

    constants?: Record<string, any>;
    bitmaps?: Record<string, any>;
    fonts?: Record<string, string>;
    layers?: Record<string, any>
}


/*
 * Class map style, provides a method to initialize the map object according
 * to a style spec.
 */

export class MapStyle {

    /**
     * Load a map from style specification. This entails retrieving the sources,
     * building the list of surfaces, bound layers and free layers, and serves
     * also as a factory to initialize the mapStyle object itself and set it
     * to style property in the map.
     *
     * @param map the target map object
     * @param styleSpec the style specification
     */

    static async loadStyle(map: Map, styleSpec: MapStyle.StyleSpecification) {

        // validation
        const res = validateStyle(styleSpec);

        if (!res.success) {

            // @ts-expect-error Typia typing bug
            let errs = res.errors ?? [];

            for (const e of errs)
                console.error(`${e.path}: expected ${e.expected}, got ${JSON.stringify(e.value)}`);

            throw new Error(`Invalid style (${errs.length} errors)`);
        }

        // wipe the map clean
        map.referenceFrame = null;
        map.srses = {}
        map.bodies = {}
        map.credits = {}
        map.surfaces = []
        map.virtualSurfaces = {}
        map.glues = {}
        map.freeLayers = {}
        map.boundLayers = {}
        map.stylesheets = {}
        map.services = {}
        map.initialView = null;
        map.currentView_ = null;

        // parse surfaces from style sources
        // (with special handling of the first surface, extracting ref frame, body and services
        for (const [id, sourceSpec] of Object.entries(styleSpec.sources))
            if (sourceSpec.type === 'cartolina-surface') {

                // load surface map config
                const path = MapStyle.slapResource(
                    map.url.processUrl(sourceSpec.url), 'mapConfig.json');

                let mc = await utils.loadJson(path);

                // TODO: validation
                //__DEV__ && console.log(mc);

                // not pretty, but constructors called below silently rely on this
                let mapurl = map.url;

                map.url = new MapUrl(map, path);

                // sanity: all surfaces need to share the same frame of reference
                if (map.referenceFrame)
                    console.assert(
                        mc.referenceFrame.id === map.referenceFrame.id);

                if (!map.referenceFrame) {
                    // ok, this is first surface, so we extract all the map metadata

                    // the srses
                    for (let key in mc.srses)
                        map.addSrs(key, new MapSrs(map, key, mc.srses[key]));

                    // the bodies
                    for (let key in mc.bodies)
                        map.addBody(key, new MapBody(map, mc.bodies[key]));

                    // the reference frame
                    map.referenceFrame = new MapRefFrame(map, mc.referenceFrame);

                    // the services
                    map.services = mc.services ?? {};

                    // atmosphere
                    let body = map.referenceFrame.body;
                    let services = map.services;

                    if (styleSpec.atmosphere
                        && body && body.atmosphere
                        && services && services.atmdensity) {

                        let spec = { ...body.atmosphere, ...styleSpec.atmosphere
                            } as Atmosphere.Specification;

                        map.atmosphere = new Atmosphere(
                            spec, map.getPhysicalSrs(),
                            map.url.makeUrl(services.atmdensity.url, {}), map);
                       }
                }

                // the surface, only single-surface mapconfigs are admissible
                if (mc.surfaces.length != 1) {

                    throw Error(`The url for source ${id} does not define `
                        + `exactly one surface, bailing out.`);
                }

                let surface = new MapSurface(map, mc.surfaces[0]);
                map.addSurface(surface.id, surface);

                // the credits
                if (mc.credits) for (let key in mc.credits)
                    map.addCredit(key, new MapCredit(map, mc.credits[key]));

                // restore the mapurl (style path)
                map.url = mapurl;
            }

        // parse bound layers from sources
        for (const [id, sourceSpec] of Object.entries(styleSpec.sources))
            if (sourceSpec.type === 'cartolina-tms') {

                const path = MapStyle.slapResource(
                    map.url.processUrl(sourceSpec.url), 'boundlayer.json');

                // asynchronous: callbacks force repeated map.refreshView()
                let bl = new MapBoundLayer(map, path, id);
                map.addBoundLayer(id, bl);
            }

        // parse free layers from sources
        for (const [id, sourceSpec] of Object.entries(styleSpec.sources))
            if (sourceSpec.type === 'cartolina-freelayer') {

                const path = MapStyle.slapResource(
                    map.url.processUrl(sourceSpec.url), 'freelayer.json');

                // asynchronous: callbacks force repeated map.refreshView()
                let fl = new MapSurface(map, path, 'free');
                map.addFreeLayer(id, fl);
            }


        // illumination
        if (styleSpec.illumination) {

            map.renderer.setIllumination(styleSpec.illumination);
        }

        // vertical exaggeration
        if (styleSpec['vertical-exaggeration']) {

            map.renderer.setSuperElevationState(true);
            map.renderer.setSuperElevation(styleSpec['vertical-exaggeration']);
        }

        // done
        //__DEV__ && console.log(map);
        map.style = new MapStyle(map, styleSpec);
    }


    map: Map;
    styleSpec: MapStyle.StyleSpecification;


    /**
     * Obtain the style specification
     */
    style(): MapStyle.StyleSpecification {

        return this.styleSpec;
    }

    /**
     * refresh the map surfaceSequence, boundLayerSequence and freeLayerSequence
     * objects according to the style content.
     */
    refreshSequences(): void {

        let map = this.map;

        // build  surface sequence
        map.tree.surfaceSequence = [];
        map.tree.surfaceOnlySequence = [];

        map.surfaces.forEach((surface: MapSurface) => {

            if (!this.styleSpec.terrain.sources.includes(surface.id)) return;

            map.tree.surfaceSequence.push([surface, false]);
            map.tree.surfaceOnlySequence.push([surface, false]);

            // surface layer sequence is the style spec itself
            surface.style = this.style();
        })


        // compile free layer stylesheets from style layers and set them
        let freeLayerStyles: Record<string, vtsStylesheet> = {};

        // iterate through layes, compiling layer style sheets along the way
        this.styleSpec.layers && this.styleSpec.layers.forEach((layer) => {

            if (['labels', 'lines'].includes(layer.type)) {

                let freelayerId = layer.source as string;
                let stylesheet: vtsStylesheet = freeLayerStyles[freelayerId];


                // copy global properties into the layer stylesheet
                if (!stylesheet) {

                    stylesheet = freeLayerStyles[freelayerId] = {}
                    if (this.styleSpec.fonts) stylesheet.fonts = this.styleSpec.fonts;
                    if (this.styleSpec.constants) stylesheet.constants = this.styleSpec.constants;
                    if (this.styleSpec.bitmaps) stylesheet.bitmaps = this.styleSpec.bitmaps;
                    stylesheet.layers = [];

                }

                let stylesheetLayer: any = structuredClone(layer);
                let id = (layer as MapStyle.LetteringLayer).id;

                // remove fields specific to cartolina style layers and
                // not present in vts stylesheets
                delete stylesheetLayer.id; delete stylesheetLayer.type;
                delete stylesheetLayer.source;

                // final stylesheet
                stylesheet.layers[id] = stylesheetLayer;
            }
        })

        // build free layer sequence
        map.freeLayerSequence = [];

        for (const [id, stylesheet] of Object.entries(freeLayerStyles)) {

            // copied from generatesurfacesequenece
            // copied from Map.refreshFreeLayersInView
            let freeLayer = map.getFreeLayer(id);

            if (freeLayer) {

                freeLayer.surfaceSequence = [freeLayer];
                freeLayer.surfaceOnlySequence = [freeLayer];
                freeLayer.options = {};

                if (freeLayer.geodata)
                    this.map.freeLayersHaveGeodata = true;

                // WARN: investigage, possibly add to layer properties
                //freeLayer.zFactor = stylesheet['depthOffset'];
                //freeLayer.maxLod = stylesheet['maxLod'];

                map.freeLayerSequence.push(freeLayer);
                freeLayer.setStyle(stylesheet);
            }
        }

        //console.log(map.freeLayerSequence);
    }

    private static slapResource(path: string, resource: string): string {

        if (path.endsWith('/')) return path + resource;
        return path;
    }

    /**
     * The bare bones constructor (to be invoked from the static factory func)
     */
    constructor(map: Map, style: MapStyle.StyleSpecification) {

        this.map = map; this.styleSpec = style;
    }
}


export default MapStyle;
