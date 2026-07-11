/*
 * core.d.ts — type surface for the legacy startup / animation-frame
 *             shell (`core.js`), being phased out
 */

import type LegacyMap from './map/map';
import type Inspector from './inspector/inspector';
import type Renderer from './renderer/renderer';
import type Map from './map';
import type EventBus from './event-bus';
import type { CoreConfig, ViewerEventMap } from './types';


/**
 * Legacy initialisation and animation-frame plumbing. Holds the
 * renderer, the loaded map (`LegacyMap | null`), the optional
 * inspector, and the `requestAnimationFrame` entry point
 * (`onUpdate`), which delegates to typed `Map.tick` through
 * `outerMap`.
 *
 * Not a load-bearing abstraction: a transitional shell that
 * dissolves as its responsibilities migrate onto typed `Map` and
 * the legacy half is absorbed.
 */
export class Core {

    constructor(
        element: HTMLElement,
        config: Partial<CoreConfig>,
        bus: EventBus<ViewerEventMap>,
    );

    /**
     * Back-pointer to the typed `Map` wrapper. Set by the `Map`
     * constructor immediately after `new Core(...)`, so it is non-null
     * from the first `rAF` callback onwards. `Core.onUpdate` uses it
     * to invoke `Map.tick` without going through `Core.map`, which is
     * null during async style loading and after `destroyMap()`.
     */
    outerMap: Map;

    /**
     * Event bus owned by the typed `Map`. Temporary wiring: `Core`
     * publishes only `map-mapconfig-loaded` and `map-unloaded` through
     * it. Disappears when those emit sites move out of `Core`.
     */
    bus: EventBus<ViewerEventMap>;

    config: CoreConfig;
    killed: boolean;
    contextLost: boolean;

    renderer: Renderer;
    map: LegacyMap | null;
    inspector: Inspector | null;

    /**
     * Resolves once `Map.ready` resolves. The actual resolution flows
     * through `markReady_`, called by `Map.tick` when the reference
     * frame first becomes ready. The payload is the loaded map's
     * `browserOptions` but `Map.ready` only re-exposes resolution, so
     * the payload type stays opaque to consumers.
     */
    ready: Promise<void>;

    destroy(): void;
    destroyMap(): void;
    loadMap(path: string): void;

    setRendererConfigParam(key: string, value: unknown): void;
    getRendererConfigParam(key: string): unknown;

    /**
     * Resolves the typed `Map.ready` Promise. Called by `Map.tick`
     * on the first frame after the reference frame becomes ready.
     * Owns only the Promise plumbing; the gate decision lives on `Map`.
     */
    markReady_(payload: unknown): void;
}

export function getCoreVersion(full?: boolean): string;
