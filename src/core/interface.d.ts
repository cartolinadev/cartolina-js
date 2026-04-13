import type Map from './map/map';
import type Renderer from './renderer/renderer';
import type MapInterface from './map/interface';
import type { CoreEventMap } from './types';

/**
 * Public API boundary for the map engine.
 *
 * The runtime implementation is in `interface.js`. This declaration
 * describes the subset of `CoreInterface` that TypeScript modules use.
 * Cast the result of `Browser.getCore()` to `CoreInterface` at the
 * construction boundary; do not use `as any` past that point.
 */
export class CoreInterface {

    /** The inner engine coordinator. Non-null after construction. */
    core: {
        map: InstanceType<typeof Map> | null;
        renderer: Renderer | null;
        mapInterface: InstanceType<typeof MapInterface> | null;
    } | null;

    /** Resolves once the map is fully loaded and ready to render. */
    readonly ready: Promise<void>;

    /** Legacy map interface wrapper. */
    readonly map: InstanceType<typeof MapInterface> | null;

    /** Legacy renderer interface wrapper. */
    readonly renderer: unknown;

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
    loadMap(path: unknown): unknown;
    destroyMap(): void;
}
