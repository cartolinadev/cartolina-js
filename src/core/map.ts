/**
 * Public API boundary for the core build.
 *
 * `Map` is the single entry point for the core build of cartolina-js.
 * It owns the map engine coordinator (`Core`) and exposes a flat, typed
 * method surface for all map operations: lifecycle, events, rendering
 * controls, coordinate conversion, and hit-testing.
 *
 * Construct via the `core()` factory exported from the core entry point,
 * not directly.
 *
 * The `core` getter is a temporary migration shim that exposes the legacy
 * engine internals to code that has not yet been promoted to this surface.
 * It will be removed once the terrain engine is fully absorbed into `Map`.
 */

import { Core } from './core';
import type LegacyMap from './map/map';
import type Renderer from './renderer/renderer';
import Atmosphere from './map/atmosphere';
import * as utils from './utils/utils';

import type { CoreConfig, CoreEventMap, HeightMode, Lod } from './types';
import type { vec3 } from './utils/math';


/**
 * Public API class for the core build.
 *
 * Replaces the legacy `CoreInterface` ES5 wrapper. Owns the engine
 * coordinator and exposes a typed, flat public surface. Internal
 * engine objects (`Core`, terrain engine, `Renderer`) are private
 * implementation detail accessible only through this surface.
 */
class Map {

    private core_: InstanceType<typeof Core>;

    /**
     * @param element canvas element to render into
     * @param config engine configuration
     */
    constructor(element: HTMLElement, config: Partial<CoreConfig>) {

        this.core_ = new Core(element, config);
    }

    /**
     * Resolves once the map is fully loaded and ready to render.
     */
    get ready(): Promise<void> {

        return this.core_.ready;
    }

    /**
     * Destroy the engine and release all owned resources.
     *
     * Prefer the `using` statement with `[Symbol.dispose]()` in new code.
     */
    [Symbol.dispose](): void {

        if (!this.core_) return;
        this.core_.destroy();
        this.core_ = null!;
    }

    /**
     * Load a map from a mapConfig URL.
     *
     * @param path URL to the mapConfig.json resource
     */
    loadMap(path: string): void {

        if (!this.core_) return;
        this.core_.loadMap(path);
    }

    /**
     * Unload the currently loaded map without destroying the engine.
     *
     * The engine remains alive and a new map can be loaded afterwards.
     */
    unloadMap(): void {

        if (!this.core_) return;
        this.core_.destroyMap();
    }

    /**
     * Set the vertical exaggeration ramps used by the renderer.
     *
     * @param spec vertical exaggeration ramp specification
     * @returns null after destruction
     */
    setVerticalExaggeration(
        spec: Renderer.VerticalExaggerationSpec,
    ): void | null {

        if (!this.core_) return null;
        return this.core_.getRendererInterface().setVerticalExaggeration(spec);
    }

    /**
     * Return the current vertical exaggeration ramps.
     *
     * @returns vertical exaggeration specification, or null after destruction
     */
    getVerticalExaggeration(): Renderer.VerticalExaggerationSpec | null {

        if (!this.core_) return null;
        return this.core_.getRendererInterface().getVerticalExaggeration();
    }

    /**
     * Set the renderer illumination definition.
     *
     * @param spec illumination definition
     * @returns null after destruction
     */
    setIllumination(spec: Renderer.IlluminationDef): void | null {

        if (!this.core_) return null;
        return this.core_.getRendererInterface().setIllumination(spec);
    }

    /**
     * Return the current renderer illumination definition.
     *
     * @returns illumination definition, or null when unset or destroyed
     */
    getIllumination(): Renderer.IlluminationDef | null {

        if (!this.core_) return null;
        return this.core_.getRendererInterface().getIllumination();
    }

    /**
     * Set live atmosphere parameters on the loaded map.
     *
     * @param spec atmosphere runtime parameters
     * @returns null after destruction
     */
    setAtmosphere(spec: Atmosphere.RuntimeParameters): void | null {

        if (!this.core_) return null;
        this.core_.map?.atmosphere?.setRuntimeParameters(spec);
    }

    /**
     * Return live atmosphere parameters from the loaded map.
     *
     * @returns atmosphere runtime parameters, or null when unavailable
     */
    getAtmosphere(): Atmosphere.RuntimeParameters | null {

        if (!this.core_) return null;
        return this.core_.map?.atmosphere?.getRuntimeParameters() ?? null;
    }

    /**
     * Set renderer feature flags such as labels, atmosphere, and shading.
     *
     * @param options rendering feature flags
     * @returns null after destruction
     */
    setRenderingOptions(options: Renderer.RenderingOptions): void | null {

        if (!this.core_) return null;
        return this.core_.getRendererInterface().setRenderingOptions(options);
    }

    /**
     * Return the current renderer feature flags.
     *
     * @returns rendering feature flags, or null after destruction
     */
    getRenderingOptions(): Renderer.RenderingOptions | null {

        if (!this.core_) return null;
        return this.core_.getRendererInterface().getRenderingOptions();
    }

    /**
     * Converts public (lon/lat/height) coordinates to navigation
     * (Cartesian) coordinates.
     *
     * @param pos `[lon, lat, height]` in public space
     * @param mode height mode (`'fix'` or `'float'`)
     * @param lod optional level-of-detail hint
     */
    convertCoordsFromPublicToNav(
        pos: vec3,
        mode: HeightMode,
        lod?: Lod,
    ): vec3 | null {

        if (!this.core_) return null;
        return this.core_.mapInterface?.convertCoordsFromPublicToNav(
            pos, mode, lod) ?? null;
    }

    /**
     * Projects navigation (Cartesian) coordinates onto the canvas.
     *
     * Returns `[x, y, depth]` in CSS pixels. A point is visible when
     * `depth <= 1` (in front of the camera).
     *
     * @param pos `[x, y, z]` in navigation space
     * @param mode height mode (`'fix'` or `'float'`)
     * @param lod optional level-of-detail hint
     */
    convertCoordsFromNavToCanvas(
        pos: vec3,
        mode: HeightMode,
        lod?: Lod,
    ): vec3 | null {

        if (!this.core_) return null;
        return this.core_.mapInterface?.convertCoordsFromNavToCanvas(
            pos, mode, lod) ?? null;
    }

    /**
     * Converts navigation coordinates to public (lon/lat/height) coordinates.
     *
     * @param pos `[x, y, z]` in navigation space
     * @param mode height mode
     * @param lod optional level-of-detail hint
     */
    convertCoordsFromNavToPublic(
        pos: vec3,
        mode: HeightMode,
        lod?: Lod,
    ): vec3 | null {

        if (!this.core_) return null;
        return this.core_.mapInterface?.convertCoordsFromNavToPublic(
            pos, mode, lod) ?? null;
    }

    /**
     * Converts navigation coordinates to physical (ECEF) coordinates.
     *
     * @param pos `[x, y, z]` in navigation space
     * @param mode height mode
     * @param lod optional level-of-detail hint
     * @param includeSE whether to apply super-elevation
     */
    convertCoordsFromNavToPhys(
        pos: vec3,
        mode: HeightMode,
        lod?: Lod,
        includeSE?: boolean,
    ): vec3 | null {

        if (!this.core_) return null;
        return this.core_.mapInterface?.convertCoordsFromNavToPhys(
            pos, mode, lod, includeSE) ?? null;
    }

    /**
     * Converts physical (ECEF) coordinates to camera space.
     *
     * @param pos `[x, y, z]` in physical space
     */
    convertCoordsFromPhysToCameraSpace(pos: vec3): vec3 | null {

        if (!this.core_) return null;
        return (this.core_.mapInterface?.convertCoordsFromPhysToCameraSpace(
            pos) ?? null) as vec3 | null;
    }

    /**
     * Returns the geographic coordinates at the given canvas pixel.
     *
     * @param screenX canvas X coordinate in CSS pixels
     * @param screenY canvas Y coordinate in CSS pixels
     * @param mode height mode (`'fix'` or `'float'`)
     * @param lod optional level-of-detail hint
     */
    getHitCoords(
        screenX: number,
        screenY: number,
        mode: HeightMode,
        lod?: Lod,
    ): vec3 | null {

        if (!this.core_) return null;
        return this.core_.mapInterface?.getHitCoords(
            screenX, screenY, mode, lod) ?? null;
    }

    /**
     * Subscribe to a named map event.
     *
     * @param eventName event to subscribe to
     * @param callback invoked each time the event fires
     * @returns unsubscribe function, or null after destruction
     */
    on<K extends keyof CoreEventMap>(
        eventName: K,
        callback: (event: CoreEventMap[K]) => void,
    ): (() => void) | null {

        if (!this.core_) return null;
        return this.core_.on(eventName, callback) ?? null;
    }

    /**
     * Subscribe to a named map event for a single invocation.
     *
     * @param eventName event to subscribe to
     * @param callback invoked once when the event fires
     * @param wait number of matching events to skip before invocation
     */
    once<K extends keyof CoreEventMap>(
        eventName: K,
        callback: (event: CoreEventMap[K]) => void,
        wait?: number,
    ): void {

        if (!this.core_) return;
        this.core_.once(eventName, callback, wait);
    }

    /**
     * Destroy the engine and release all owned resources.
     *
     * @deprecated Use `[Symbol.dispose]()` / `using` instead.
     */
    destroy(): void {

        __DEV__ && utils.warnOnce('[Map] destroy() is deprecated. Use Symbol.dispose instead.');
        this[Symbol.dispose]();
    }

    /**
     * Migration shim exposing legacy engine internals.
     *
     * @internal
     * @deprecated Access internals through Map public methods instead.
     *   This getter will be removed when the terrain engine is absorbed
     *   into Map.
     */
    get core(): {
        map: LegacyMap | null;
        renderer: Renderer | null;
    } | null {

        __DEV__ && utils.warnOnce(
            '[Map] .core is a migration shim and will be removed. ' +
            'Access internals through Map public methods instead.',
        );
        return this.core_ ?? null;
    }

    /**
     * Frame orchestrator. Will replace MapDraw.drawMap and the legacy
     * surface-tree traversal when the new surface compositor is
     * implemented.
     */
    private draw(): void {}
}


export default Map;
