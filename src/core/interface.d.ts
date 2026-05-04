import type Map from './map/map';
import type Renderer from './renderer/renderer';
import type Atmosphere from './map/atmosphere';
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

    /**
     * Subscribe to a named core event.
     *
     * @param eventName event to subscribe to
     * @param callback function invoked when the event fires
     * @returns unsubscribe function, or null after destruction
     */
    on<K extends keyof CoreEventMap>(
        eventName: K,
        callback: (event: CoreEventMap[K]) => void,
    ): (() => void) | null;

    /**
     * Subscribe to a named core event for one invocation.
     *
     * @param eventName event to subscribe to
     * @param callback function invoked when the event fires
     * @param wait number of matching events to skip before invocation
     * @returns nothing
     */
    once<K extends keyof CoreEventMap>(
        eventName: K,
        callback: (event: CoreEventMap[K]) => void,
        wait?: number,
    ): void;

    /**
     * Destroy the engine coordinator and release owned map resources.
     *
     * @returns nothing
     */
    destroy(): void;

    /**
     * Destroy the currently loaded map without destroying the interface.
     *
     * @returns nothing
     */
    destroyMap(): void;

    /**
     * Set the vertical exaggeration ramps used by the renderer.
     *
     * @param spec vertical exaggeration ramp specification
     * @returns nothing, or null after destruction
     */
    setVerticalExaggeration(
        spec: Renderer.VerticalExaggerationSpec,
    ): void | null;

    /**
     * Return the current vertical exaggeration ramps.
     *
     * @returns vertical exaggeration specification, or null after destruction
     */
    getVerticalExaggeration(): Renderer.VerticalExaggerationSpec | null;

    /**
     * Set the renderer illumination definition.
     *
     * @param spec illumination definition
     * @returns nothing, or null after destruction
     */
    setIllumination(spec: Renderer.IlluminationDef): void | null;

    /**
     * Return the current renderer illumination definition.
     *
     * @returns illumination definition, or null when unset or destroyed
     */
    getIllumination(): Renderer.IlluminationDef | null;

    /**
     * Set live atmosphere parameters on the loaded map.
     *
     * @param spec atmosphere runtime parameters
     * @returns nothing, or null after destruction
     */
    setAtmosphere(spec: Atmosphere.RuntimeParameters): void | null;

    /**
     * Return live atmosphere parameters from the loaded map.
     *
     * @returns atmosphere runtime parameters, or null when unavailable
     */
    getAtmosphere(): Atmosphere.RuntimeParameters | null;

    /**
     * Set renderer feature flags such as labels, atmosphere, and shading.
     *
     * @param options rendering feature flags
     * @returns nothing, or null after destruction
     */
    setRenderingOptions(options: Renderer.RenderingOptions): void | null;

    /**
     * Return the current renderer feature flags.
     *
     * @returns rendering feature flags, or null after destruction
     */
    getRenderingOptions(): Renderer.RenderingOptions | null;
}
