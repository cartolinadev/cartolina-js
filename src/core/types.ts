import type MapSrs from './map/srs';

/**
 * Shared configuration object owned by the legacy core and passed to the
 * map and renderer layers.
 *
 * The full runtime object has many legacy keys. This type records the
 * fields used by current TypeScript modules and should grow only when
 * typed code touches another key.
 */
export interface CoreConfig {
    [key: string]: boolean | number | string | number[] | undefined;
    rendererAllowScreenshots?: boolean;
    rendererAntialiasing?: boolean;
    rendererAnisotropic?: number;
    rendererCssDpi?: number;
    mapShadingLambertian?: boolean;
    mapShadingSlope?: boolean;
    mapShadingAspect?: boolean;
    mapFlagLighting?: boolean;
    mapFlagNormalMaps?: boolean;
    mapFlagDiffuseMaps?: boolean;
    mapFlagSpecularMaps?: boolean;
    mapFlagBumpMaps?: boolean;
    mapFlagAtmosphere?: boolean;
    mapFlagShadows?: boolean;
    mapFlagLabels?: boolean;
    mapDMapSize?: number;
    mapDMapMode?: number;
    mapDMapCopyIntervalMs?: number;
    mapDMapDilatePx?: number;
    mapSplitMargin?: number;
    mapLabelFreeMargins?: [number, number, number, number];
}

/** Height mode for coordinate conversions and hit-testing. */
export type HeightMode = 'fix' | 'float';

/**
 * Level-of-detail hint for coordinate conversions and height sampling.
 * A higher value requests a finer terrain mesh.
 */
export type Lod = number;

/** Result of `MapMeasure.getNodeInformation()` for one spatial division node. */
export type NodeInformation = {
    id: [number, number, number];
    height: number;
    srs: MapSrs;
    extents: {
        ll: [number, number];
        ur: [number, number];
    };
    physicalCorners: {
        ul: [number, number, number];
        ur: [number, number, number];
        lr: [number, number, number];
        ll: [number, number, number];
    };
    divisionNode: unknown;
    upVector: [number, number, number];
};

/**
 * Map from event name to its payload type.
 *
 * Payloads from the legacy JS core are typed as `unknown` until the
 * underlying JS is migrated to TypeScript.
 */
export interface CoreEventMap {
    'map-mapconfig-loaded': unknown;
    'map-loaded': unknown;
    'map-unloaded': unknown;
    'map-update': unknown;
    'map-position-changed': unknown;
    'map-position-fixed-height-changed': unknown;
    'tick': unknown;
    'gpu-context-lost': unknown;
    'gpu-context-restored': unknown;
    'geo-feature-enter': unknown;
    'geo-feature-leave': unknown;
    'geo-feature-hover': unknown;
    'geo-feature-click': unknown;
}
