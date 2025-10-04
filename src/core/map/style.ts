
import Map from '../map/map';


/**
 * The style specification.
 */

export interface StyleSpecification  {

    version: 2;
    'reference-frame'?: string;

    sources: Record<string, SourceSpecification>;

    layers: LayerSpecification[];

    constants: Record<string, Expression>;
    bitmaps: Record<string, Expression>;
    fonts: Record<string, string>;
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
    'diffuse' | 'diffuse-constant'>, 'source'> & {



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
    'line-label-font': [string],
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
    'label-font': [string],
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

type Color3Spec = [number, number, number, number]
type Color4Spec = [number, number, number]

type BlendMode = 'overlay' | 'add' | 'multiply'

type AlphaMode = 'constant' | 'viewdep'

type Alpha = number | { mode: AlphaMode, value: number }


/*
 * Class map style, provides a method to initialize the map object according
 * to a style spec.
 */


export class MapStyle {

    static loadStyle(map: Map, style: StyleSpecification) {

        throw new Error('unimplemented');
    }
}


export default MapStyle;
