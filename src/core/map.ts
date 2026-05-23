/**
 * Internal engine boundary used by the browser build.
 *
 * `Map` owns the map engine coordinator (`Core`) and exposes a typed
 * method surface used by `Viewer`: lifecycle, events, rendering
 * controls, coordinate conversion, and hit-testing.
 *
 * The `core` getter is a temporary migration shim that exposes the legacy
 * engine internals to code that has not yet been promoted to this surface.
 * It will be removed once the terrain engine is fully absorbed into `Map`.
 */

import { Core } from './core';
import type Renderer from './renderer/renderer';
import Atmosphere from './map/atmosphere';
import * as utils from './utils/utils';

import type { CoreConfig, CoreEventMap, HeightMode, Lod } from './types';
import type { vec3 } from './utils/math';


/**
 * Internal API class between `Viewer` and the map engine.
 *
 * Replaces the legacy `CoreInterface` ES5 wrapper. Owns the engine
 * coordinator and exposes typed methods for `Viewer` to call. Internal
 * engine objects (`Core`, terrain engine, `Renderer`) remain private
 * implementation details except for the temporary `core` migration shim.
 */
class Map {

    private core_: InstanceType<typeof Core>;
    private disposed_ = false;

    /**
     * @param element canvas element to render into
     * @param config engine configuration
     */
    constructor(element: HTMLElement, config: Partial<CoreConfig>) {

        this.core_ = new Core(element, config);
    }

    /** Throws if the map has been disposed. */
    private assertAlive_(): void {

        if (this.disposed_) {
            throw new Error('Map has been destroyed.');
        }
    }

    /**
     * Resolves once the map is fully loaded and ready to render.
     */
    get ready(): Promise<void> {

        this.assertAlive_();
        return this.core_.ready;
    }

    /**
     * Destroy the engine and release all owned resources.
     *
     * Prefer the `using` statement with `[Symbol.dispose]()` in new code.
     */
    [Symbol.dispose](): void {

        if (this.disposed_) return;
        this.core_.destroy();
        this.disposed_ = true;
    }

    /**
     * Load a map from a mapConfig URL.
     *
     * @param path URL to the mapConfig.json resource
     */
    loadMap(path: string): void {

        this.assertAlive_();
        this.core_.loadMap(path);
    }

    /**
     * Unload the currently loaded map without destroying the engine.
     *
     * The engine remains alive and a new map can be loaded afterwards.
     */
    unloadMap(): void {

        this.assertAlive_();
        this.core_.destroyMap();
    }

    /**
     * Set the vertical exaggeration ramps used by the renderer.
     *
     * @param spec vertical exaggeration ramp specification
     */
    setVerticalExaggeration(
        spec: Renderer.VerticalExaggerationSpec,
    ): void {

        this.assertAlive_();
        return this.core_.renderer.setVerticalExaggeration(spec);
    }

    /**
     * Return the current vertical exaggeration ramps.
     *
     * @returns vertical exaggeration specification
     */
    getVerticalExaggeration(): Renderer.VerticalExaggerationSpec | null {

        this.assertAlive_();
        return this.core_.renderer.getVerticalExaggeration();
    }

    /**
     * Set the renderer illumination definition.
     *
     * @param spec illumination definition
     */
    setIllumination(spec: Renderer.IlluminationDef): void {

        this.assertAlive_();
        return this.core_.renderer.setIllumination(spec);
    }

    /**
     * Return the current renderer illumination definition.
     *
     * @returns illumination definition, or null when unset
     */
    getIllumination(): Renderer.IlluminationDef | null {

        this.assertAlive_();
        return this.core_.renderer.getIllumination();
    }

    /**
     * Set live atmosphere parameters on the loaded map.
     *
     * @param spec atmosphere runtime parameters
     */
    setAtmosphere(spec: Atmosphere.RuntimeParameters): void {

        this.assertAlive_();
        this.core_.map?.atmosphere?.setRuntimeParameters(spec);
    }

    /**
     * Return live atmosphere parameters from the loaded map.
     *
     * @returns atmosphere runtime parameters, or null when unavailable
     */
    getAtmosphere(): Atmosphere.RuntimeParameters | null {

        this.assertAlive_();
        return this.core_.map?.atmosphere?.getRuntimeParameters() ?? null;
    }

    /**
     * Set renderer feature flags such as labels, atmosphere, and shading.
     *
     * @param options rendering feature flags
     */
    setRenderingOptions(options: Renderer.RenderingOptions): void {

        this.assertAlive_();
        return this.core_.renderer.setRenderingOptions(options);
    }

    /**
     * Return the current renderer feature flags.
     *
     * @returns rendering feature flags
     */
    getRenderingOptions(): Renderer.RenderingOptions | null {

        this.assertAlive_();
        return this.core_.renderer.getRenderingOptions();
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

        this.assertAlive_();
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

        this.assertAlive_();
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

        this.assertAlive_();
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

        this.assertAlive_();
        return this.core_.mapInterface?.convertCoordsFromNavToPhys(
            pos, mode, lod, includeSE) ?? null;
    }

    /**
     * Converts physical (ECEF) coordinates to camera space.
     *
     * @param pos `[x, y, z]` in physical space
     */
    convertCoordsFromPhysToCameraSpace(pos: vec3): vec3 | null {

        this.assertAlive_();
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

        this.assertAlive_();
        return this.core_.mapInterface?.getHitCoords(
            screenX, screenY, mode, lod) ?? null;
    }

    /**
     * Returns terrain distance at a 2D position in the current screen view.
     *
     * @param screenX horizontal coordinate in the selected space
     * @param screenY vertical coordinate in the selected space
     * @param dilate depth-map dilation radius in hitmap pixels
     * @param useGeometricIntersection compute a geometric ray intersection
     * instead of sampling the depth hitmap. Geocentric maps intersect the
     * ellipsoid; projected maps intersect the base plane.
     * @param coordinateSpace coordinate space of `screenX` and `screenY`
     * @returns `[hit, distance]`, or null when the map is not ready.
     * `distance` is the Euclidean distance from the viewer to the terrain
     * surface at the selected position. When `hit` is false, no terrain
     * covers the position and `distance` is a sentinel value.
     */
    getScreenDepth(
        screenX: number,
        screenY: number,
        dilate = 0,
        useGeometricIntersection = false,
        coordinateSpace: Renderer.CoordinateSpace = 'layout',
    ): [boolean, number] | null {

        this.assertAlive_();
        return this.core_.map?.getScreenDepth(
            screenX,
            screenY,
            dilate,
            useGeometricIntersection,
            coordinateSpace,
        ) ?? null;
    }

    /**
     * Subscribe to a named map event.
     *
     * @param eventName event to subscribe to
     * @param callback invoked each time the event fires
     * @returns unsubscribe function
     */
    on<K extends keyof CoreEventMap>(
        eventName: K,
        callback: (event: CoreEventMap[K]) => void,
    ): (() => void) {

        this.assertAlive_();
        const unsubscribe = this.core_.on(eventName, callback);
        if (unsubscribe == null) {
            throw new Error('Map event subscription failed.');
        }

        return unsubscribe;
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

        this.assertAlive_();
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
    get core(): InstanceType<typeof Core> {

        __DEV__ && utils.warnOnce(
            '[Map] .core is a migration shim and will be removed. ' +
            'Access internals through Map public methods instead.',
        );
        this.assertAlive_();
        return this.core_;
    }

    /**
     * Frame orchestrator. Will replace MapDraw.drawMap and the legacy
     * surface-tree traversal when the new surface compositor is
     * implemented.
     */
    private draw(): void {}
}


export default Map;
