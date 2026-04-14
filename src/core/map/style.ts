
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

    constants?: Record<string, Expression>;
    bitmaps?: Record<string, Expression>;
    fonts?: Record<string, string>;

    illumination?: IlluminationSpecification;
    'vertical-exaggeration'?: VerticalExaggerationSpecification;

    atmosphere?: AtmosphereSpecification;
    shadows?: Record<string, never>;

    config?: Record<string, unknown>;
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

} & Partial<LetteringLayerProperties> & {

    [key: `&${string}`]: Expression | undefined;
}

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
    'label-origin': Property<string>,
    'label-align': 'left' | 'right' | 'center',
    'label-width': Property<number>,
    'label-stick': Property<number[]>,
    'label-no-overlap': boolean,
    'label-no-overlap-margin': [number, number],

    polygon: boolean,
    'polygon-color': Property<Color4Spec>,

    'z-index': Property<number>,
    'zbuffer-offset': Property<[number, number, number]>,
    'selected-layer' : Property<string>,
    'selected-hover-layer': Property<string>,
    'enter-event': Property<boolean>,
    'leave-event': Property<boolean>,
    'hover-event': Property<boolean>,
    'hover-layer': Property<string>,
    'click-event': Property<boolean>,
    'advanced-hit': Property<boolean>

    'visible': Property<boolean>,
    'visibility': Property<number>,
    'visibility-abs': Property<[number, number]>,
    'visibility-rel': Property<[number, number, number, number]>,
    'visibility-switch': [['string', 'string']],
    'culling': Property<number>,

    'next-pass': [number, string]
}

type ExpressionScalar = string | number | boolean | null;
type Stops = Array<[number, Expression]>;

interface IfExpression {
    if: [Expression, Expression, Expression];
}

interface BinaryMathExpression {
    add?: [Expression, Expression];
    sub?: [Expression, Expression];
    mul?: [Expression, Expression];
    div?: [Expression, Expression];
    mod?: [Expression, Expression];
    pow?: [Expression, Expression];
    tofixed?: [Expression, Expression];
    atan2?: [Expression, Expression];
    random?: [Expression, Expression];
}

interface UnaryMathExpression {
    sgn?: Expression;
    sin?: Expression;
    cos?: Expression;
    tan?: Expression;
    asin?: Expression;
    acos?: Expression;
    atan?: Expression;
    sqrt?: Expression;
    abs?: Expression;
    log?: Expression;
    round?: Expression;
    floor?: Expression;
    ceil?: Expression;
    deg2rad?: Expression;
    rad2deg?: Expression;
}

interface UnaryStringExpression {
    strlen?: Expression;
    trim?: Expression;
    str2num?: Expression;
    lowercase?: Expression;
    uppercase?: Expression;
    capitalize?: Expression;
    'has-fonts'?: Expression;
    'has-latin'?: Expression;
    'is-cjk'?: Expression;
}

interface BinaryStringExpression {
    find?: [Expression, Expression];
}

interface TernaryStringExpression {
    replace?: [Expression, Expression, Expression];
}

interface StringSliceExpression {
    substr?: [Expression, Expression]
        | [Expression, Expression, Expression];
}

interface ExtremumExpression {
    min?: Expression[];
    max?: Expression[];
}

interface ClampExpression {
    clamp: [Expression, Expression, Expression];
}

type LogScaleExpression =
    | { logScale: [Expression, Expression]
        | [Expression, Expression, Expression]
        | [Expression, Expression, Expression, Expression] }
    | { 'log-scale': [Expression, Expression]
        | [Expression, Expression, Expression]
        | [Expression, Expression, Expression, Expression] };

type MapExpression = {
    map: [Expression, Array<[Expression, Expression]>, Expression];
};

type LinearExpression =
    | { linear: Stops }
    | { discrete: Stops }
    | { linear2: [Expression, Stops] }
    | { discrete2: [Expression, Stops] }
    | { 'lod-scaled': [number, number | Stops, number] };

type ExpressionObject =
    | IfExpression
    | BinaryMathExpression
    | UnaryMathExpression
    | UnaryStringExpression
    | BinaryStringExpression
    | TernaryStringExpression
    | StringSliceExpression
    | ExtremumExpression
    | ClampExpression
    | LogScaleExpression
    | MapExpression
    | LinearExpression;

interface ExpressionArray extends Array<Expression> {}

export type Expression = ExpressionScalar | ExpressionArray | ExpressionObject;

export type Property<T> = T | Expression;

export type FilterCondition = Expression[];

export type Color3Spec = [number, number, number]
export type Color4Spec = [number, number, number, number]

export type BlendMode = 'overlay' | 'add' | 'multiply'

export type Alpha = number
    | { mode: 'constant', value: number }
    | { mode: 'viewdep', value: number, illumination: [number, number] }

export type IlluminationSpecification = {

    light: LightSpecification | LegacyLightSpecification,
    ambientCoef?: number,
    shadingLambertianWeight?: number,
    shadingSlopeWeight?: number,
    shadingAspectWeight?: number
}

export type LegacyLightSpecification = ['tracking', number, number]

export type LightSpecification = {
    type: 'tracking' | 'geographic',
    azimuth: number,
    elevation: number,
    diffuseColor?: Color3Spec,
    specularColor?: Color3Spec
}

export type VerticalExaggerationSpecification =
    | {
        elevationRamp?: {
            min: [number, number];
            max: [number, number];
        };
        scaleRamp?: {
            min: [number, number];
            max: [number, number];
        };
    }
    /** @deprecated Use the scale-denominator format above instead. */
    | {
        heightRamp?: [[number, number], [number, number]];
        viewExtentProgression?: [number, number, number, number, number];
    };

export type AtmosphereSpecification = Partial<Atmosphere.Specification>;

} // export namespace MapStyle

const validateStyle = typia.createValidateEquals<MapStyle.StyleSpecification>();

/// vts stylesheet shape, compile from style for goedata free layer rendering

type VtsStylesheetLayer = Omit<MapStyle.LetteringLayer, 'id' | 'type' | 'source'>;

type vtsStylesheet = {

    constants?: Record<string, MapStyle.Expression>;
    bitmaps?: Record<string, MapStyle.Expression>;
    fonts?: Record<string, string>;
    layers?: Record<string, VtsStylesheetLayer>
}

type SurfaceMapConfig = {

    referenceFrame: {
        id: string;
    } & Record<string, unknown>;

    srses: Record<string, unknown>;
    bodies: Record<string, MapBody.Configuration>;
    services?: {
        atmdensity?: {
            url: string;
        };
    } & Record<string, unknown>;

    surfaces: unknown[];
    credits?: Record<string, unknown>;
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

            let errs = 'errors' in res ? res.errors : [];

            for (const e of errs)
                console.error(`${e.path}: expected ${e.expected}, got ${JSON.stringify(e.value)}`);

            throw new Error(`Invalid style (${errs.length} errors)`);
        }

        const styleSurfaceSourceIds = Object.entries(styleSpec.sources)
            .filter(([, sourceSpec]) => sourceSpec.type === 'cartolina-surface')
            .map(([id]) => id);
        const unknownTerrainSources = styleSpec.terrain.sources
            .filter((id) => !styleSurfaceSourceIds.includes(id));

        if (unknownTerrainSources.length > 0) {
            const msg = 'Invalid style terrain.sources: unknown style surface source id(s): '
                + unknownTerrainSources.join(', ')
                + '. Expected one of: ' + styleSurfaceSourceIds.join(', ');

            console.error(msg);
            throw new Error(msg);
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

                let mc = await utils.loadJson(path) as SurfaceMapConfig;

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

                        let spec: Atmosphere.Specification = {
                            visibilityToEyeDistance: 5.0,
                            edgeDistanceToEyeDistance: 1.0,
                            maxVisibility: 1e6,
                            ...body.atmosphere, 
                            ...styleSpec.atmosphere
                        };

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
                surface.styleSourceId = id;
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
        const veSpec = styleSpec['vertical-exaggeration'];

        if (veSpec) {
            map.renderer.setSuperElevationState(true);

            if ('elevationRamp' in veSpec || 'scaleRamp' in veSpec) {

                map.renderer.setVerticalExaggeration(veSpec);

            } else {

                // @deprecated legacy heightRamp / viewExtentProgression format
                map.renderer.setSuperElevation(veSpec as any);
            }
        }

        // options
        if (styleSpec.config)
            for (const [key, value] of Object.entries(styleSpec.config))
                map.setConfigParam(key, value);

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

            if (!this.styleSpec.terrain.sources.includes(surface.styleSourceId)) return;

            map.tree.surfaceSequence.push([surface, false]);
            map.tree.surfaceOnlySequence.push([surface, false]);

            // surface layer sequence is the style spec itself
            surface.style = this.style();
        })


        // compile free layer stylesheets from style layers and set them
        let freeLayerStyles: Record<string, vtsStylesheet> = {};

        // iterate through layes, compiling layer style sheets along the way
        this.styleSpec.layers && this.styleSpec.layers.forEach((layer) => {

            if (['labels', 'lines'].includes(layer.type ?? '')) {

                let freelayerId = layer.source as string;
                let stylesheet: vtsStylesheet = freeLayerStyles[freelayerId];


                // copy global properties into the layer stylesheet
                if (!stylesheet) {

                    stylesheet = freeLayerStyles[freelayerId] = {}
                    if (this.styleSpec.fonts) stylesheet.fonts = this.styleSpec.fonts;
                    if (this.styleSpec.constants) stylesheet.constants = this.styleSpec.constants;
                    if (this.styleSpec.bitmaps) stylesheet.bitmaps = this.styleSpec.bitmaps;
                    stylesheet.layers = {};

                }

                const clonedLayer = structuredClone(
                    layer) as MapStyle.LetteringLayer;
                const { id, type, source, ...stylesheetLayer } = clonedLayer;

                // remove fields specific to cartolina style layers and
                // not present in vts stylesheets
                // final stylesheet
                stylesheet.layers![id] = stylesheetLayer;
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
