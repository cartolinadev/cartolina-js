
import type LegacyMap from '../map/map';

import * as viewerConfig from '../viewer-config';
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
    bodies: Record<string, MapBody.Configuration>;
    services?: {
        atmdensity?: {
            url: string;
        };
    } & Record<string, unknown>;

    surfaces: Array<Record<string, unknown>>;
    credits?: Record<string, unknown>;
}

/**
 * Inline data of a `cartolina-tms` source: a tiled raster source
 * definition, the same shape a `cartolina-tms` URL resolves to.
 */
export type TmsSourceDefinition = Record<string, unknown>;

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

/**
 * One primitive runtime style mutation, submitted through the core
 * map's atomic style-mutation batch.
 */
export type StyleMutation =
    | { kind: 'layer-terrain', layerId: string, terrain: string[] }
    | { kind: 'terrain-sources', sources: string[] };

} // export namespace MapStyle

const validateStyle = typia.createValidateEquals<MapStyle.StyleSpecification>();


/*
 * Structural equality for inline source metadata: object key order is
 * irrelevant, array order and value identity are significant.
 */

function canonicalJson(value: unknown): string {

    if (Array.isArray(value)) {
        return '[' + value.map(canonicalJson).join(',') + ']';
    }

    if (value !== null && typeof value === 'object') {

        const record = value as Record<string, unknown>;
        const keys = Object.keys(record).sort();

        return '{' + keys.map(
            (key) => JSON.stringify(key) + ':'
                + canonicalJson(record[key])).join(',') + '}';
    }

    return JSON.stringify(value) ?? 'undefined';
}


/*
 * Validates the consistency rules for inline `cartolina-surface`
 * sources: the reference frame and the shared SRS, body, and service
 * definitions must be structurally equal across all inline terrain
 * sources, and two inline definitions of the same credit id must be
 * structurally equal. Throws before any map object is constructed.
 * URL sources are not checked; they keep the historical
 * first-document acceptance behavior.
 */

function checkInlineSurfaceConsistency(
    sources: Record<string, MapStyle.SourceSpecification>,
): void {

    const inline: Array<[string, MapStyle.SurfaceSourceDefinition]> = [];

    for (const [id, sourceSpec] of Object.entries(sources))
        if (sourceSpec.type === 'cartolina-surface'
            && sourceSpec.data !== undefined) {

            inline.push([id, sourceSpec.data]);
        }

    if (inline.length < 2) return;

    const [firstId, first] = inline[0];

    const sharedKeys =
        ['referenceFrame', 'srses', 'bodies', 'services'] as const;

    for (let i = 1; i < inline.length; i++) {

        const [otherId, other] = inline[i];

        for (const key of sharedKeys) {

            if (canonicalJson(first[key]) !== canonicalJson(other[key])) {

                throw new Error(`Inline terrain sources "${firstId}" and `
                    + `"${otherId}" carry different "${key}" definitions; `
                    + `inline surface metadata must be structurally equal.`);
            }
        }
    }

    // credits merge by id; same id requires a structurally equal value
    const creditOwners: Record<string, [string, string]> = {};

    for (const [id, definition] of inline) {

        if (!definition.credits) continue;

        for (const [creditId, credit] of Object.entries(definition.credits)) {

            const canonical = canonicalJson(credit);
            const existing = creditOwners[creditId];

            if (existing && existing[1] !== canonical) {

                throw new Error(`Credit "${creditId}" is defined differently `
                    + `by inline terrain sources "${existing[0]}" and `
                    + `"${id}".`);
            }

            if (!existing) creditOwners[creditId] = [id, canonical];
        }
    }
}

/// vts stylesheet shape, compile from style for goedata free layer rendering

type VtsStylesheetLayer =
    Omit<MapStyle.LetteringLayer, 'id' | 'type' | 'source' | 'terrain'>;

type vtsStylesheet = {

    constants?: Record<string, MapStyle.Expression>;
    bitmaps?: Record<string, MapStyle.Expression>;
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

        const spec = structuredClone(styleSpec);
        const layers = spec.layers ?? [];

        // duplicate explicit ids are authoring errors
        const explicitIds = new Set<string>();

        for (const layer of layers) {

            if (layer.id === undefined) continue;

            if (explicitIds.has(layer.id)) {
                throw new Error(
                    `Duplicate style layer id "${layer.id}".`);
            }

            explicitIds.add(layer.id);
        }

        const surfaceSourceIds = Object.entries(spec.sources)
            .filter(([, sourceSpec]) =>
                sourceSpec.type === 'cartolina-surface')
            .map(([id]) => id);

        layers.forEach((layer, index) => {

            if (layer.id === undefined) {

                const effectiveType = layer.type ?? 'diffuse-map';
                let candidate = `${effectiveType}-${index}`;

                while (explicitIds.has(candidate)) candidate += '-anon';
                layer.id = candidate;
            }

            if (layer.terrain === undefined) {
                layer.terrain = [...surfaceSourceIds];
            }
        });

        return spec;
    }

    /**
     * Load a map from style specification. This entails retrieving the sources,
     * building the list of surfaces, bound layers and free layers, and serves
     * also as a factory to initialize the mapStyle object itself and set it
     * to style property in the map.
     *
     * @param map the target map object
     * @param styleSpec the style specification
     */

    static async loadStyle(map: LegacyMap, styleSpec: MapStyle.StyleSpecification) {

        // validation
        const res = validateStyle(styleSpec);

        if (!res.success) {

            let errs = 'errors' in res ? res.errors : [];

            for (const e of errs)
                console.error(`${e.path}: expected ${e.expected}, got ${JSON.stringify(e.value)}`);

            throw new Error(`Invalid style (${errs.length} errors)`);
        }

        // inline surface metadata must be consistent before any map
        // object is constructed
        checkInlineSurfaceConsistency(styleSpec.sources);

        // normalized runtime clone; the caller's object stays untouched
        const spec = MapStyle.normalizeStyle(styleSpec);

        const styleSurfaceSourceIds = Object.entries(spec.sources)
            .filter(([, sourceSpec]) => sourceSpec.type === 'cartolina-surface')
            .map(([id]) => id);
        const unknownTerrainSources = spec.terrain.sources
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
        map.freeLayers = {}
        map.boundLayers = {}
        map.stylesheets = {}
        map.services = {}
        map.initialView = null;
        map.currentView_ = null;

        // parse surfaces from style sources
        // (with special handling of the first surface, extracting ref frame, body and services
        for (const [id, sourceSpec] of Object.entries(spec.sources))
            if (sourceSpec.type === 'cartolina-surface') {

                // resolve the surface document: fetch the URL form,
                // take the inline form as already-resolved data
                let path: string;
                let mc: MapStyle.SurfaceSourceDefinition;

                if (sourceSpec.url !== undefined) {

                    path = MapStyle.slapResource(
                        map.url.processUrl(sourceSpec.url),
                        'mapConfig.json');

                    mc = await utils.loadJson(
                        path,
                        map.core.config.transformRequest ?? undefined,
                        'MapConfig',
                    ) as MapStyle.SurfaceSourceDefinition;

                } else {

                    path = sourceSpec.baseUrl;
                    mc = sourceSpec.data;
                }

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

                    if (spec.atmosphere
                        && body && body.atmosphere
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
        for (const [id, sourceSpec] of Object.entries(spec.sources))
            if (sourceSpec.type === 'cartolina-tms') {

                if (sourceSpec.url !== undefined) {

                    const path = MapStyle.slapResource(
                        map.url.processUrl(sourceSpec.url),
                        'boundlayer.json');

                    // asynchronous: callbacks force repeated
                    // map.refreshView()
                    let bl = new MapBoundLayer(map, path, id);
                    map.addBoundLayer(id, bl);

                } else {

                    let bl = new MapBoundLayer(
                        map, sourceSpec.data, id, sourceSpec.baseUrl);
                    map.addBoundLayer(id, bl);
                }
            }

        // parse free layers from sources
        for (const [id, sourceSpec] of Object.entries(spec.sources))
            if (sourceSpec.type === 'cartolina-freelayer') {

                if (sourceSpec.data !== undefined) {

                    let fl = new MapSurface(
                        map, sourceSpec.data, 'free', sourceSpec.baseUrl);
                    map.addFreeLayer(id, fl);
                    continue;
                }

                const path = MapStyle.slapResource(
                    map.url.processUrl(sourceSpec.url), 'freelayer.json');

                // asynchronous: callbacks force repeated map.refreshView()
                let fl = new MapSurface(map, path, 'free');
                map.addFreeLayer(id, fl);
            }


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

        // done
        //__DEV__ && console.log(map);
        map.style = new MapStyle(map, spec);
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
     * invalid batch changes nothing. The caller commits the result by
     * rebuilding the effective state and recompiling sequences.
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

        const hasLettering = (this.authoredSpec_.layers ?? []).some(
            (layer) => ['labels', 'lines'].includes(layer.type ?? ''));

        let letteringChanged = false;

        for (const mutation of mutations) {

            if (mutation.kind === 'layer-terrain') {

                this.layerTerrainOverrides_.set(
                    mutation.layerId, [...mutation.terrain]);

                if (this.isLetteringLayer(mutation.layerId))
                    letteringChanged = true;

            } else {

                this.terrainOverride_ = [...mutation.sources];

                // a stack change can activate or deactivate rules
                // through the stack-intersection contract
                if (hasLettering) letteringChanged = true;
            }
        }

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

        const spec = structuredClone(this.authoredSpec_);

        if (this.terrainOverride_) {
            spec.terrain.sources = [...this.terrainOverride_];
        }

        for (const layer of spec.layers ?? []) {

            const override =
                this.layerTerrainOverrides_.get(layer.id as string);
            if (override) layer.terrain = [...override];
        }

        this.effectiveSpec_ = spec;
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
     * refresh the map surfaceSequence, boundLayerSequence and freeLayerSequence
     * objects according to the style content.
     */
    refreshSequences(): void {

        let map = this.map;
        const spec = this.effectiveSpec_;

        spec.terrain.sources.forEach((sourceId: string) => {

            const surface = map.surfaces.find((s: MapSurface) =>
                s.styleSourceId === sourceId);

            if (!surface) {
                throw new Error(`terrain.sources references `
                    + `"${sourceId}" but no surface was loaded for `
                    + `that source`);
            }

            // surface layer sequence is the style spec itself
            surface.style = spec;
        })


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
            let freeLayer = map.getFreeLayer(id);

            if (freeLayer) {

                if (!freeLayer.geodata) continue;

                freeLayer.options = {};
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
