
import type LegacyMap from './legacy-map';

import * as viewerConfig from '../viewer-config';
import MapRefFrame from './refframe';
import MapSrs from './srs';
import MapBody from './body';
import Atmosphere from './atmosphere';
import MapFreeLayer from './free-layer';
import MapCredit from './credit';
import RasterSource from './raster-source';
import TerrainSource from './terrain-source';
import type Map from './map';
import { utilsUrl } from '../utils/url';

import * as styleSchema from './style-schema';


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
    bitmaps?: Record<string, BitmapSpecification>;
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

/**
 * Where a source definition comes from: a URL to fetch it from, or
 * the definition inline together with the base URL that resolves any
 * relative URLs inside it.
 */
export type SourceLocation<T> =
    | { url: string, data?: never, baseUrl?: never }
    | { data: T, baseUrl: string, url?: never };

/**
 * Inline data of a `cartolina-surface` source: a single-surface
 * document carrying the surface resource definition plus the
 * reference-frame, SRS, body, service, and credit metadata needed to
 * initialize it. The same shape a surface URL resolves to.
 */
export type SurfaceSourceDefinition = {

    referenceFrame: {
        id: string;
    } & Record<string, unknown>;

    srses: Record<string, unknown>;
    bodies?: Record<string, Record<string, unknown>>;
    services?: {
        atmdensity?: {
            url: string;
        };
    } & Record<string, unknown>;

    surfaces: Array<Record<string, unknown>>;
    credits?: Record<string, MapCredit.Definition>;
}

/**
 * Inline data of a `cartolina-tms` source: a tiled raster source
 * definition, the same shape a `cartolina-tms` URL resolves to.
 */
export type TmsSourceDefinition =
    RasterSource.Definition & Record<string, unknown>;

/**
 * Inline data of a `cartolina-freelayer` source: a monolithic
 * (`type: 'geodata'`) or tiled (`type: 'geodata-tiles'`) geodata
 * definition, the same shapes a `cartolina-freelayer` URL resolves
 * to.
 */
export type FreeLayerSourceDefinition =
    | ({ type: 'geodata' } & Record<string, unknown>)
    | ({ type: 'geodata-tiles' } & Record<string, unknown>);

export type CartolinaSurfaceSource = {
    type: 'cartolina-surface'
} & SourceLocation<SurfaceSourceDefinition>;

export type CartolinaTmsSource = {
    type: 'cartolina-tms'
} & SourceLocation<TmsSourceDefinition>;

export type CartolinaFreeLayerSource = {
    type: 'cartolina-freelayer'
} & SourceLocation<FreeLayerSourceDefinition>;

export type TerrainSpecification = {

    sources: string[]
}

/**
 * One entry of the root `bitmaps` table: the bitmap URL, or an
 * object carrying the URL with the optional filter and tiling
 * flags the geodata processor accepts.
 */
export type BitmapSpecification =
    | string
    | {
        url: string,
        filter?: string,
        tiled?: boolean,
    };


export type LayerSpecification =
    | TileLayer
    | LetteringLayer;


export type TileLayer = TileTextureLayer | TileConstantLayer;

export type LetteringLayer = LabelsLayer | LinesLayer

export type TileTextureLayer = DiffuseMapLayer | BumpMapLayer | SpecularMapLayer;

export type TileConstantLayer = DiffuseConstantLayer;

export type LayerBase<TType extends string> = {

    type: TType,
    id?: string,
    terrain?: string[],
    necessity?: 'optional' | 'essential'
}

export type TileLayerBase<TType extends string> = LayerBase<TType> & {

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
    'line-label-type': Property<string>,
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
    'icon-color': Property<Color4Spec>,
    'icon-no-overlap': Property<boolean>,
    'icon-offset': Property<[number, number]>,
    'icon-origin': Property<number[]>,
    'icon-stick': Property<number[]>,

    label: Property<boolean>,
    'label-font': Property<string[]>,
    'label-source': Property<string>,
    'label-size': Property<number>,
    'label-spacing': Property<number>,
    'label-line-height': Property<number>,
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
    'visibility-switch': Array<[string, string | null]>,
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
    useLighting?: boolean,
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

/**
 * One primitive runtime style mutation, submitted through the core
 * map's atomic style-mutation batch.
 */
export type StyleMutation =
    | { kind: 'layer-terrain', layerId: string, terrain: string[] }
    | { kind: 'terrain-sources', sources: string[] };

} // export namespace MapStyle

/// vts stylesheet shape, compile from style for goedata free layer rendering

type VtsStylesheetLayer =
    Omit<MapStyle.LetteringLayer, 'id' | 'type' | 'source' | 'terrain'>;

type vtsStylesheet = {

    constants?: Record<string, MapStyle.Expression>;
    bitmaps?: Record<string, MapStyle.BitmapSpecification>;
    fonts?: Record<string, string>;
    layers?: Record<string, VtsStylesheetLayer>
}

/*
 * Class map style, provides a method to initialize the map object according
 * to a style spec.
 */

export class MapStyle {

    /**
     * Builds the normalized runtime clone of an authored style: every
     * layer gets a unique id and an explicit terrain list, while the
     * caller's object stays untouched.
     *
     * Anonymous layers receive a deterministic generated id derived
     * from the layer's effective type (after the omitted diffuse type
     * default) and its array position; while the candidate equals an
     * explicit authored id, a deterministic `-anon` suffix is appended
     * until it is unique. Duplicate explicit ids are rejected. An
     * omitted layer `terrain` expands to the explicit list of every
     * `cartolina-surface` entry in the `sources` dictionary,
     * independent of the initial `terrain.sources` stack.
     *
     * @param styleSpec the validated authored style
     * @returns the normalized clone
     */
    static normalizeStyle(
        styleSpec: MapStyle.StyleSpecification,
    ): MapStyle.StyleSpecification {

        return styleSchema.normalizeStyle(styleSpec);
    }

    /**
     * Validates an authored style against the schema and the inline
     * surface consistency rules, then returns the normalized runtime
     * clone via `normalizeStyle`. Throws before any map object is
     * constructed: on a schema violation, inconsistent inline surface
     * metadata, a duplicate explicit layer id, or a `terrain.sources`
     * entry naming an unknown surface source.
     *
     * Shared by `loadStyle` and by `mapConfigToStyle()`, so a
     * conversion result is rejected at conversion time rather than
     * only when a `Viewer` later loads it.
     *
     * @param styleSpec the authored style
     * @returns the normalized clone
     */
    static validateAndNormalize(
        styleSpec: MapStyle.StyleSpecification,
    ): MapStyle.StyleSpecification {

        return styleSchema.validateAndNormalizeStyle(styleSpec);
    }

    /**
     * Load a map from style specification. This entails retrieving the sources,
     * building the terrain, raster and free-layer source registries, and serves
     * also as a factory to initialize the mapStyle object itself and set it
     * to style property in the map.
     *
     * @param map the target map object
     * @param styleSpec the style specification
     */

    static async loadStyle(map: LegacyMap, styleSpec: MapStyle.StyleSpecification) {

        const spec = MapStyle.validateAndNormalize(styleSpec);

        // wipe the map clean
        map.referenceFrame = null;
        map.srses = {}
        map.bodies = {}
        map.credits = {}
        map.freeLayers = {}
        map.stylesheets = {}
        map.services = {}

        // Start every raster metadata request before the terrain documents
        // are awaited. The async function also turns synchronous validation
        // failures for inline definitions into rejected promises.
        //
        // An inline definition resolves without ever suspending, so its
        // source is constructed while this loop runs and registers its
        // credits into the table wiped above.
        const rasterIds: string[] = [];
        const rasterLoads: Promise<RasterSource>[] = [];

        for (const [id, sourceSpec] of Object.entries(spec.sources)) {

            if (sourceSpec.type !== 'cartolina-tms') continue;

            rasterIds.push(id);
            rasterLoads.push((async () => {

                if (sourceSpec.url !== undefined) {

                    const path = MapStyle.slapResource(
                        map.url.processUrl(sourceSpec.url),
                        'boundlayer.json');
                    const definition = await utils.loadJson(
                        path,
                        map.core.transformRequest,
                        'Source',
                    );

                    return RasterSource.fromMetadata(
                        map.outerMap,
                        id,
                        definition,
                        utilsUrl.getBase(path),
                    );
                }

                return RasterSource.fromMetadata(
                    map.outerMap,
                    id,
                    sourceSpec.data,
                    sourceSpec.baseUrl,
                );
            })());
        }

        const rasterResultsPromise = Promise.allSettled(rasterLoads);

        // Surface documents are requested alongside the raster metadata
        // rather than one after another. Their results are consumed in
        // source order below, so the first document still supplies the
        // reference frame and the shared map metadata.
        const terrainIds: string[] = [];
        const terrainLoads:
            Promise<[MapStyle.SurfaceSourceDefinition, string]>[] = [];

        for (const [id, sourceSpec] of Object.entries(spec.sources)) {

            if (sourceSpec.type !== 'cartolina-surface') continue;

            terrainIds.push(id);
            terrainLoads.push((async () => {

                if (sourceSpec.url !== undefined) {

                    const path = MapStyle.slapResource(
                        map.url.processUrl(sourceSpec.url),
                        'mapConfig.json');

                    const document = await utils.loadJson(
                        path,
                        map.core.transformRequest,
                        'MapConfig',
                    ) as MapStyle.SurfaceSourceDefinition;

                    return [document, path];
                }

                return [sourceSpec.data, sourceSpec.baseUrl];
            })());
        }

        const terrainResults = await Promise.allSettled(terrainLoads);
        const terrainSources = new globalThis.Map<string, TerrainSource>();

        // parse surfaces from style sources
        // (with special handling of the first surface, extracting ref frame, body and services
        for (let index = 0; index < terrainIds.length; index++) {

                const id = terrainIds[index];
                const result = terrainResults[index];

                // a surface document that cannot be retrieved leaves the
                // style unusable, so the first failure ends the load
                if (result.status === 'rejected') throw result.reason;

                const [mc, path] = result.value;

                // sanity: all surfaces need to share the same frame of reference
                if (map.referenceFrame)
                    console.assert(
                        mc.referenceFrame.id === map.referenceFrame.id);

                if (!map.referenceFrame) {
                    // ok, this is first surface, so we extract all the map metadata

                    // the srses
                    for (let key in mc.srses)
                        map.addSrs(key,
                            new MapSrs(map, key, mc.srses[key], path));

                    // the bodies
                    for (let key in mc.bodies)
                        map.addBody(key, new MapBody(
                            map,
                            mc.bodies[key] as MapBody.Configuration));

                    // the reference frame
                    map.referenceFrame = new MapRefFrame(map, mc.referenceFrame);

                    // the services
                    map.services = mc.services ?? {};

                    // the atmosphere subsystem exists whenever the
                    // body carries atmosphere parameters and the
                    // density service is available; the
                    // mapFlagAtmosphere config flag controls whether
                    // it renders
                    let body = map.referenceFrame.body;
                    let services = map.services;

                    if (body && body.atmosphere
                        && services && services.atmdensity) {

                        let atmoSpec: Atmosphere.Specification = {
                            visibilityToEyeDistance: 5.0,
                            edgeDistanceToEyeDistance: 1.0,
                            maxVisibility: 1e6,
                            ...body.atmosphere,
                            ...spec.atmosphere
                        };

                        map.atmosphere = new Atmosphere(
                            atmoSpec, map.getPhysicalSrs(),
                            utilsUrl.getProcessUrl(
                                services.atmdensity.url, path), map);
                       }
                }

                // the surface, only single-surface mapconfigs are admissible
                if (mc.surfaces.length != 1) {

                    throw Error(`The url for source ${id} does not define `
                        + `exactly one surface, bailing out.`);
                }

                // the credit definitions are registered before the source
                // resolves, so a surface credit list can name them
                if (mc.credits) for (let key in mc.credits)
                    map.addCredit(key, new MapCredit(map, mc.credits[key]));

                // the resolved surface entry and the document base reach
                // the source boundary for both URL and inline sources
                terrainSources.set(id, TerrainSource.fromMetadata(
                    map.outerMap, id, mc.surfaces[0], path));
            }

        map.outerMap.setTerrainSourceEntries(terrainSources);

        // parse free layers from sources
        for (const [id, sourceSpec] of Object.entries(spec.sources))
            if (sourceSpec.type === 'cartolina-freelayer') {

                if (sourceSpec.data !== undefined) {

                    let fl = new MapFreeLayer(
                        map, sourceSpec.data, sourceSpec.baseUrl);
                    map.addFreeLayer(id, fl);
                    continue;
                }

                const path = MapStyle.slapResource(
                    map.url.processUrl(sourceSpec.url), 'freelayer.json');

                // asynchronous: callbacks force repeated map.refreshView()
                let fl = new MapFreeLayer(map, path);
                map.addFreeLayer(id, fl);
            }

        const rasterResults = await rasterResultsPromise;
        const rasterEntries =
            new globalThis.Map<string, Map.RasterSourceEntry>();

        rasterResults.forEach((result, index) => {

            const id = rasterIds[index];

            if (result.status === 'fulfilled') {
                rasterEntries.set(
                    id, { status: 'ready', source: result.value });
                return;
            }

            const error = result.reason instanceof Error
                ? result.reason
                : new Error(String(result.reason));
            rasterEntries.set(id, { status: 'failed', error });
        });

        map.outerMap.setRasterSourceEntries(rasterEntries);


        // illumination
        if (spec.illumination) {

            map.renderer.setIllumination(spec.illumination);
        }

        // vertical exaggeration
        const veSpec = spec['vertical-exaggeration'];

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
        if (spec.config) {

            for (const [key, value] of Object.entries(spec.config)) {

                const patch = viewerConfig.normalizeConfigPatch(key, value);
                if (patch) map.core.configStore.set(patch);
            }
        }

        // a style with no atmosphere section starts with atmosphere
        // rendering off; an explicit config value takes precedence
        if (spec.config?.mapFlagAtmosphere === undefined) {

            const patch = viewerConfig.normalizeConfigPatch(
                'mapFlagAtmosphere', spec.atmosphere !== undefined);
            if (patch) map.core.configStore.set(patch);
        }

        // done
        //__DEV__ && console.log(map);
        const style = new MapStyle(map, spec);
        map.outerMap.assertRasterSourcesAvailable(style.style());
        map.style = style;
    }


    map: LegacyMap;

    /** The normalized authored style: the immutable runtime baseline. */
    private authoredSpec_: MapStyle.StyleSpecification;

    /** The effective style state: authored plus runtime overrides. */
    private effectiveSpec_: MapStyle.StyleSpecification;

    /** Layer index over the authored clone, keyed by layer id. */
    private layersById_ = new globalThis.Map<
        string, MapStyle.LayerSpecification>();

    /** Ids of every `cartolina-surface` entry in `sources`. */
    private surfaceSourceIds_ = new Set<string>();

    /** Runtime per-layer terrain-list overrides, keyed by layer id. */
    private layerTerrainOverrides_ = new globalThis.Map<string, string[]>();

    /** Runtime active-terrain-stack override, or `null` for authored. */
    private terrainOverride_: string[] | null = null;


    /**
     * Returns the effective style state: the authored baseline with
     * runtime terrain and layer-applicability overrides applied.
     */
    style(): MapStyle.StyleSpecification {

        return this.effectiveSpec_;
    }

    /**
     * Applies a batch of primitive style mutations atomically: every
     * mutation is validated before any state is written, so an
     * invalid batch changes nothing. The caller recompiles sequences
     * after this method commits the already-validated effective state.
     *
     * @param mutations primitive mutations in application order
     * @returns whether the batch can affect lettering compilation
     */
    applyMutations(
        mutations: MapStyle.StyleMutation[],
    ): { letteringChanged: boolean } {

        // validation pass: nothing is written until every mutation
        // checks out
        for (const mutation of mutations) {

            if (mutation.kind === 'layer-terrain') {

                if (!this.layersById_.has(mutation.layerId)) {
                    throw new Error(
                        `Unknown style layer id "${mutation.layerId}".`);
                }

                this.validateTerrainIds(mutation.terrain);

            } else {

                this.validateTerrainIds(mutation.sources);
            }
        }

        const nextLayerOverrides =
            new globalThis.Map(this.layerTerrainOverrides_);
        let nextTerrainOverride = this.terrainOverride_ === null
            ? null
            : [...this.terrainOverride_];

        for (const mutation of mutations) {

            if (mutation.kind === 'layer-terrain') {

                nextLayerOverrides.set(
                    mutation.layerId, [...mutation.terrain]);

            } else {

                nextTerrainOverride = [...mutation.sources];
            }
        }

        const nextSpec = this.buildEffectiveState(
            nextTerrainOverride, nextLayerOverrides);

        // The prospective state is checked before any live override or
        // effective-style field changes.
        this.map.outerMap.assertRasterSourcesAvailable(nextSpec);

        const hasLettering = (this.authoredSpec_.layers ?? []).some(
            (layer) => ['labels', 'lines'].includes(layer.type ?? ''));
        const letteringChanged = mutations.some((mutation) =>
            mutation.kind === 'layer-terrain'
                ? this.isLetteringLayer(mutation.layerId)
                : hasLettering);

        this.layerTerrainOverrides_ = nextLayerOverrides;
        this.terrainOverride_ = nextTerrainOverride;
        this.effectiveSpec_ = nextSpec;

        return { letteringChanged };
    }

    /**
     * Returns a copy of one layer's effective terrain-source list.
     * Always an explicit array; an omitted authored list was expanded
     * at validation.
     *
     * @param layerId id of the layer to query
     * @throws on an unknown layer id
     */
    getLayerTerrainSources(layerId: string): string[] {

        const layer = this.layersById_.get(layerId);
        if (!layer) {
            throw new Error(`Unknown style layer id "${layerId}".`);
        }

        const override = this.layerTerrainOverrides_.get(layerId);
        return [...(override ?? layer.terrain ?? [])];
    }

    /** Returns a copy of the effective active terrain stack. */
    getTerrainSources(): string[] {

        return [...(this.terrainOverride_
            ?? this.authoredSpec_.terrain.sources)];
    }

    /** Returns the ids of every style layer in array order. */
    getLayerIds(): string[] {

        return (this.authoredSpec_.layers ?? []).map(
            (layer) => layer.id as string);
    }

    /**
     * Returns whether a layer id names a lettering (`labels` or
     * `lines`) layer.
     *
     * @param layerId id of the layer to query
     */
    isLetteringLayer(layerId: string): boolean {

        const layer = this.layersById_.get(layerId);
        return layer !== undefined
            && ['labels', 'lines'].includes(layer.type ?? '');
    }

    /**
     * Rebuilds the effective style state from the authored baseline
     * and the current runtime overrides. Called by the style-mutation
     * commit before sequences recompile.
     */
    rebuildEffectiveState(): void {

        this.effectiveSpec_ = this.buildEffectiveState(
            this.terrainOverride_, this.layerTerrainOverrides_);
    }

    private buildEffectiveState(
        terrainOverride: string[] | null,
        layerTerrainOverrides:
            globalThis.Map<string, string[]>,
    ): MapStyle.StyleSpecification {

        const spec = structuredClone(this.authoredSpec_);

        if (terrainOverride) {
            spec.terrain.sources = [...terrainOverride];
        }

        for (const layer of spec.layers ?? []) {

            const override =
                layerTerrainOverrides.get(layer.id as string);
            if (override) layer.terrain = [...override];
        }

        return spec;
    }

    /**
     * Validates a terrain-source id list: every id must name a
     * `cartolina-surface` source and appear only once.
     */
    private validateTerrainIds(sourceIds: string[]): void {

        const seen = new Set<string>();

        for (const id of sourceIds) {

            if (!this.surfaceSourceIds_.has(id)) {
                throw new Error(
                    `"${id}" is not a terrain (cartolina-surface) `
                    + `source of this style.`);
            }

            if (seen.has(id)) {
                throw new Error(
                    `Duplicate terrain source id "${id}".`);
            }

            seen.add(id);
        }
    }

    /**
     * Refreshes terrain applicability and the free-layer sequence from the
     * effective style.
     */
    refreshSequences(): void {

        let map = this.map;
        const spec = this.effectiveSpec_;

        // every active terrain source must have resolved during loading
        spec.terrain.sources.forEach((sourceId: string) =>
            map.outerMap.resolveTerrainSource(sourceId));

        // compile free layer stylesheets from style layers and set them
        let freeLayerStyles: Record<string, vtsStylesheet> = {};

        // the active terrain stack gates lettering rules below
        const activeTerrain = spec.terrain.sources;

        // iterate through layes, compiling layer style sheets along the way
        spec.layers && spec.layers.forEach((layer) => {

            if (['labels', 'lines'].includes(layer.type ?? '')) {

                // a lettering rule is active exactly when its terrain
                // list intersects the active terrain stack
                const ruleTerrain = layer.terrain ?? [];
                if (!ruleTerrain.some((id) => activeTerrain.includes(id)))
                    return;

                let freelayerId = layer.source as string;
                let stylesheet: vtsStylesheet = freeLayerStyles[freelayerId];


                // copy global properties into the layer stylesheet
                if (!stylesheet) {

                    stylesheet = freeLayerStyles[freelayerId] = {}
                    if (spec.fonts) stylesheet.fonts = spec.fonts;
                    if (spec.constants) stylesheet.constants = spec.constants;
                    if (spec.bitmaps) stylesheet.bitmaps = spec.bitmaps;
                    stylesheet.layers = {};

                }

                const clonedLayer = structuredClone(
                    layer) as MapStyle.LetteringLayer;

                // remove fields specific to cartolina style layers and
                // not present in vts stylesheets
                const { id, type, source, terrain, ...stylesheetLayer }
                    = clonedLayer;

                // final stylesheet
                stylesheet.layers![id] = stylesheetLayer;
            }
        })

        // build free layer sequence
        map.freeLayerSequence = [];

        for (const [id, stylesheet] of Object.entries(freeLayerStyles)) {

            // copied from generatesurfacesequenece
            // copied from Map.refreshFreeLayersInView
            //
            // registration already guarantees the surviving geodata
            // form (addFreeLayer, MapFreeLayer's fetched-layer
            // validation), so this path trusts the registry: a
            // registered free layer is either present and eligible,
            // or the registry entry is null.
            let freeLayer = map.getFreeLayer(id);

            if (freeLayer) {

                freeLayer.options = {};

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
     * The bare bones constructor (to be invoked from the static
     * factory func). `style` must be the normalized clone produced by
     * `normalizeStyle`: every layer carries a unique id and an
     * explicit terrain list.
     */
    constructor(map: LegacyMap, style: MapStyle.StyleSpecification) {

        this.map = map;
        this.authoredSpec_ = style;
        this.effectiveSpec_ = style;

        for (const layer of style.layers ?? []) {
            this.layersById_.set(layer.id as string, layer);
        }

        for (const [id, sourceSpec] of Object.entries(style.sources))
            if (sourceSpec.type === 'cartolina-surface') {
                this.surfaceSourceIds_.add(id);
            }

        // materialize the effective clone so later commits never
        // hand out the authored baseline for mutation
        this.rebuildEffectiveState();
    }
}


export default MapStyle;
