
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

export interface StyleSpecification  {

    version: 2;
    'reference-frame'?: string;

    sources: Record<string, SourceSpecification>;

    layers?: LayerSpecification[];

    constants?: Record<string, any>;
    bitmaps?: Record<string, Expression>;
    fonts?: Record<string, string>;

    illumination?: IlluminationSpecification;
    verticalExaggeration?: VerticalExaggerationSpecification;
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


export type LayerSpecification =
    | DiffuseMapLayer
    | DiffuseConstantLayer
    | SpecularMapLayer
    | BumpMapLayer
    | AtmosphereLayer
    | ShadowsLayer
    | LabelsLayer
    | LinesLayer


type LayerBase<TType extends string> = {

    type: TType,
    necessity?: 'optional' | 'essential'
}

type LayerMapBase<TType extends string> = LayerBase<TType> & {

    source: string,
    whitewash?: number,
    blendMode?: BlendMode,
    alpha?: Alpha
}

export type DiffuseMapLayer = Omit<LayerMapBase<'diffuse-map'>, 'type'> & {

    type?: 'diffuse-map',
}

export type DiffuseConstantLayer = Omit<LayerMapBase<
    'constant' | 'diffuse-constant'>, 'source'> & {

    source: Color3Spec
}

export type SpecularMapLayer = LayerMapBase<'specular-map'>;
export type BumpMapLayer = LayerMapBase<'bump-map'>;

export type AtmosphereLayer = LayerBase<'atmosphere'>;
export type ShadowsLayer = LayerBase<'shadows'>;

type LetteringLayerBase<TType extends string> = LayerBase<TType> & {

    id: string,
    type: TType,
    source: string,

    filter?: FilterCondition

} & Partial<LetteringLayerProperties>

export type LabelsLayer = LetteringLayerBase<'labels'>;
export type LinesLayer = LetteringLayerBase<'lines'>;

type LetteringLayerProperties = {

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

type Property<T> = T | Expression;

type FilterCondition = any[];

type Color3Spec = [number, number, number]
type Color4Spec = [number, number, number, number]

type BlendMode = 'overlay' | 'add' | 'multiply'

type AlphaMode = 'constant' | 'viewdep'

type Alpha = number | { mode: AlphaMode, value: number }

type IlluminationSpecification = {

    light: ['tracking', number, number],
    ambientCoef?: number
}

type VerticalExaggerationSpecification =  {

    heightRamp?: [[number, number], [number, number]],
    viewExtentProgression?: [number, number, number, number, number]
}

const validateStyle = typia.createValidate<StyleSpecification>();

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

    static async loadStyle(map: Map, styleSpec: StyleSpecification) {

        // validation
        const res = validateStyle(styleSpec);

        if (!res.success) {

            // @ts-expect-error Typia typing bug
            let errs = res.errors ?? [];

            for (const e of errs)
                console.warn(`${e.path}: expected ${e.expected}, got ${JSON.stringify(e.value)}`);

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

                    if (body && body.atmosphere && services && services.atmdensity)
                    map.atmosphere = new Atmosphere(
                        body.atmosphere, map.getPhysicalSrs(),
                        map.url.makeUrl(services.atmdensity.url, {}), map);
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

                // asynchronous: callbacks force repeated map.refreshView()
                let bl = new MapBoundLayer(map, sourceSpec.url, id);
                map.addBoundLayer(id, bl);
            }

        // parse free layers from sources
        // TODO

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
        console.log(map);
        map.style = new MapStyle(map, styleSpec);
    }


    map: Map;
    styleSpec: StyleSpecification;


    /**
     * The bare bones constructor
     */
    constructor(map: Map, style: StyleSpecification) {

        this.map = map; this.styleSpec = style;
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
            map.tree.surfaceSequence.push([surface, false]);
            map.tree.surfaceOnlySequence.push([surface, false]);
        });


        // TODO


        // build bound layer sequences
        // compile free layer stylesheets from style layers and set them
    }


    private static slapResource(path: string, resource: string): string {
        if (path.endsWith('/')) return path + resource;
    }
}


export default MapStyle;
