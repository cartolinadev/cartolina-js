import type Map from './map/map';
import type Renderer from './renderer/renderer';
import type MapInterface from './map/interface';

/** Height mode for coordinate conversions and hit-testing. */
export type HeightMode = 'fix' | 'float';

/**
 * Level-of-detail hint for coordinate conversions and height sampling.
 * A higher value requests a finer terrain mesh.
 */
export type Lod = number;

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

/**
 * Typed boundary interface over the legacy JS `CoreInterface`.
 *
 * Describes the subset of `CoreInterface` that TypeScript modules
 * access. Cast the result of `Browser.getCore()` to this type at the
 * construction boundary; do not use `as any` past that point.
 */
export interface ICoreInterface {

    readonly ready: Promise<void>;

    /** Internal engine objects — available after `ready` resolves. */
    readonly core: {
        map: InstanceType<typeof Map> | null;
        renderer: Renderer | null;
        mapInterface: InstanceType<typeof MapInterface> | null;
    } | null;

    on<K extends keyof CoreEventMap>(
        eventName: K,
        callback: (event: CoreEventMap[K]) => void,
    ): (() => void) | null;

    once<K extends keyof CoreEventMap>(
        eventName: K,
        callback: (event: CoreEventMap[K]) => void,
        wait?: number,
    ): void;

    destroy(): void;
    destroyMap(): void;
}
