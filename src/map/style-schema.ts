/*
 * style-schema.ts - the style specification
 */

import type MapCredit from './credit';
import type RasterSource from './raster-source';
import type Atmosphere from './atmosphere';


export interface StyleSpecification  {

    version: 2;
    'reference-frame'?: string;

    /** Default camera position; a `map()` `position` overrides it. */
    position?: (number | string)[];

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
 * Inline definition of a `cartolina-surface` source: a single-surface
 * definition carrying the surface resource definition plus the
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
 * Inline definition of a `cartolina-tms` source: a tiled raster source
 * definition, the same shape a `cartolina-tms` URL resolves to.
 */
export type TmsSourceDefinition =
    RasterSource.Definition & Record<string, unknown>;

/**
 * Inline definition of a `cartolina-freelayer` source: a monolithic
 * (`type: 'geodata'`) or tiled (`type: 'geodata-tiles'`) geodata
 * definition, the same shapes a `cartolina-freelayer` URL resolves
 * to.
 */
export type FreeLayerSourceDefinition =
    | ({ type: 'geodata' } & Record<string, unknown>)
    | ({ type: 'geodata-tiles' } & Record<string, unknown>);

export type CartolinaSurfaceSource =
    | { type: 'cartolina-surface', url: string }
    | {
        type: 'cartolina-surface',
        definition: SurfaceSourceDefinition,
    };

export type CartolinaTmsSource =
    | { type: 'cartolina-tms', url: string }
    | { type: 'cartolina-tms', definition: TmsSourceDefinition };

export type CartolinaFreeLayerSource =
    | { type: 'cartolina-freelayer', url: string }
    | {
        type: 'cartolina-freelayer',
        definition: FreeLayerSourceDefinition,
    };

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
