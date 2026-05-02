/**
 * The primary public API entry point for cartolina-js.
 *
 * `Viewer` is the single object that new applications interact with. It
 * provides a flat, typed method surface for all map operations: lifecycle,
 * camera, rendering controls, coordinate conversion, and hit-testing.
 *
 * It is constructed indirectly through the `map()` or `browser()`
 * factory functions exported from this package. The public type alias for
 * this class is `Map`.
 *
 * Sub-objects from the legacy API (`.map`, `.renderer`) are not part of this
 * class's public interface. Methods are promoted to flat accessors on this
 * class on a case-by-case basis as new applications require them.
 */

import Browser from './browser';
import { CoreInterface } from '../core/interface';
import Atmosphere from '../core/map/atmosphere';
import Renderer from '../core/renderer/renderer';
import type { MapRuntimeOptionValue } from './index';
import MapStyle from '../core/map/style';
import MapPosition from '../core/map/position';
import Map from '../core/map/map';
import MapInterface from '../core/map/interface'
import * as utils from '../core/utils/utils';

import type {
    HeightMode,
    Lod,
    CoreEventMap,
} from '../core/types';

import type { vec3 } from '../core/utils/math';


/**
 * The primary public API object returned by the `map()` factory.
 *
 * Exported as the type alias `Map` from the package index.
 */
class Viewer {

    //private readonly _browser: InstanceType<typeof Browser>;
    private readonly _browser: Browser;
    private readonly _core: CoreInterface;
    private _killed = false;

    /** The internal terrain engine (`Core.map`). Non-null after `ready`. */
    private get _map(): Map | null { return this._core?.core?.map ?? null; }

    /** The internal WebGL renderer (`Core.renderer`). */
    private get _renderer(): Renderer | null {
        return this._core?.core?.renderer ?? null;
    }

    /**
     * The internal `MapInterface` — used for methods whose delegation
     * logic lives there and has not yet been promoted. Not public.
     */
    private get _mapInterface(): MapInterface | null {
        return this._core?.core?.mapInterface ?? null;
    }

    /** Returns true when the viewer has been destroyed. */
    private _guard(): boolean { return this._killed; }

    /**
     * Do not construct directly — use the `map()` or `browser()` factory
     * functions exported from this package.
     *
     * @param element the container element or its CSS selector / id
     * @param config browser configuration object
     *   (style-based or legacy mapConfig)
     */
    constructor(element: HTMLElement | string, config: Viewer.Config) {

        this._browser = new Browser(element, config);
        this._core = this._browser.getCore() as CoreInterface;
    }

    // -------------------------------------------------------------------------
    // Lifecycle
    // -------------------------------------------------------------------------

    /**
     * Promise that resolves once the map is fully loaded and ready to render.
     */
    get ready(): Promise<void> {

        return this._core.ready;
    }

    /** Destroys the viewer and releases all GPU and DOM resources. */
    destroy(): void {

        if (this._guard()) return;
        this._core.destroy();
        this._browser.kill();
        this._killed = true;
    }

    // -------------------------------------------------------------------------
    // Events
    // -------------------------------------------------------------------------

    /**
     * Subscribes to a named map event.
     * See `CoreEventMap` for available event names.
     *
     * @param eventName the event to subscribe to
     * @param callback invoked each time the event fires
     * @returns an unsubscribe function
     */
    on<K extends keyof CoreEventMap>(
        eventName: K,
        callback: (event: CoreEventMap[K]) => void,
    ): (() => void) | null {

        if (this._guard()) return null;
        return this._core.on(eventName, callback);
    }

    /**
     * Subscribes to a named map event for a single invocation.
     * See `CoreEventMap` for available event names.
     *
     * @param eventName the event to subscribe to
     * @param callback invoked once when the event fires
     * @param wait number of events to skip before invoking the callback
     */
    once<K extends keyof CoreEventMap>(
        eventName: K,
        callback: (event: CoreEventMap[K]) => void,
        wait?: number,
    ): void {

        if (this._guard()) return;
        this._core.once(eventName, callback, wait);
    }

    // -------------------------------------------------------------------------
    // Camera
    // -------------------------------------------------------------------------

    /**
     * Sets the camera position.
     *
     * @param position a 10-component vts-geospatial position array or
     *   `MapPosition` instance
     */
    setPosition(position: MapPosition | number[]): this {

        if (this._guard()) return this;
        this._map?.setPosition(position);
        return this;
    }

    /** Returns the current camera position as a `MapPosition` instance. */
    getPosition(): MapPosition | null {

        if (this._guard()) return null;
        return this._map?.getPosition() ?? null;
    }

    // -------------------------------------------------------------------------
    // Render control
    // -------------------------------------------------------------------------

    /** Marks the scene dirty, triggering a re-render on the next frame. */
    redraw(): this {

        if (this._guard()) return this;
        this._map?.markDirty();
        return this;
    }

    /**
     * Sets the atmosphere rendering parameters.
     *
     * @param spec atmosphere specification; partial updates are merged
     *
     * BUG: if the loaded style has no `atmosphere` section, `this._map.atmosphere`
     * is null and the optional-chain silently discards the call. `getAtmosphere()`
     * then continues to return null, giving no indication that the set failed.
     * Styles without an atmosphere section must have one injected before map
     * creation for `setAtmosphere` / `getAtmosphere` to work at all.
     */
    setAtmosphere(spec: Atmosphere.Specification): void {

        if (this._guard()) return;
        this._map?.atmosphere?.setRuntimeParameters(spec);
    }

    /** Returns the current runtime atmosphere rendering parameters. */
    getAtmosphere(): Atmosphere.RuntimeParameters | null {

        if (this._guard()) return null;
        return this._map?.atmosphere?.getRuntimeParameters() ?? null;
    }

    /**
     * Sets the illumination definition (light direction, shading weights, etc.)
     *
     * @param spec illumination definition
     */
    setIllumination(spec: Renderer.IlluminationDef): void {

        if (this._guard()) return;
        this._renderer?.setIllumination(spec);
    }

    /** Returns the current illumination definition. */
    getIllumination(): Renderer.IlluminationDef | null {

        if (this._guard()) return null;
        return this._renderer?.getIllumination() ?? null;
    }

    /**
     * Sets the vertical exaggeration spec (elevation ramp and scale ramp).
     *
     * @param spec vertical exaggeration specification
     */
    setVerticalExaggeration(spec: Renderer.VerticalExaggerationSpec): void {

        if (this._guard()) return;
        this._renderer?.setVerticalExaggeration(spec);
    }

    /** Returns the current vertical exaggeration specification. */
    getVerticalExaggeration(): Renderer.VerticalExaggerationSpec | null {

        if (this._guard()) return null;
        return this._renderer?.getVerticalExaggeration() ?? null;
    }

    /**
     * Sets rendering feature flags (lighting, normal maps, atmosphere, etc.)
     *
     * @param options rendering options
     */
    setRenderingOptions(options: Renderer.RenderingOptions): void {

        if (this._guard()) return;
        this._renderer?.setRenderingOptions(options);
    }

    /** Returns the current rendering options. */
    getRenderingOptions(): Renderer.RenderingOptions | null {

        if (this._guard()) return null;
        return this._renderer?.getRenderingOptions() ?? null;
    }

    // -------------------------------------------------------------------------
    // Scale
    // -------------------------------------------------------------------------

    /**
     * Returns the scale denominator for a given view extent.
     *
     * @param extent view extent in metres
     */
    getScaleDenominator(extent: number): number {

        if (this._guard()) return 0;
        return this._renderer?.getScaleDenominator(extent) ?? 0;
    }

    /**
     * Returns the vertical exaggeration scale factor at the given position.
     *
     * @param position a `MapPosition` instance or 10-component array
     */
    getVeScaleFactor(position: MapPosition): number {

        if (this._guard()) return 1;
        return this._renderer?.getVeScaleFactor(position) ?? 1;
    }

    // -------------------------------------------------------------------------
    // Config params
    // -------------------------------------------------------------------------

    /**
     * Sets a single runtime configuration parameter.
     *
     * Parameters prefixed with `renderer*` are routed to the renderer;
     * those prefixed with `map*` are routed to the terrain engine.
     *
     * @param key parameter key
     * @param value parameter value
     */
    setParam(key: string, value: MapRuntimeOptionValue): this {

        if (this._guard()) return this;
        this._browser.setConfigParam(key, value, true);
        return this;
    }

    /**
     * Returns the current value of a runtime configuration parameter.
     *
     * @param key parameter key
     */
    getParam(key: string): MapRuntimeOptionValue {

        if (this._guard()) return null;
        return this._browser.getConfigParam(key);
    }

    // -------------------------------------------------------------------------
    // Hit testing and coordinate conversion
    // -------------------------------------------------------------------------

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

        if (this._guard()) return null;
        return this._mapInterface?.convertCoordsFromPublicToNav(
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

        if (this._guard()) return null;
        return this._mapInterface?.convertCoordsFromNavToCanvas(
            pos, mode, lod) ?? null;
    }

    /**
     * Returns whether a public-space point is visible in the current
     * terrain view.
     *
     * This method is currently experimental and unreliable. The depth
     * comparison it uses does not yet match the renderer's projection
     * and hitmap conventions well enough for dependable application
     * logic.
     *
     * This uses the cached hitmap/depth-map path. Occlusion can lag
     * slightly while the camera is moving because hitmap copies are
     * throttled by runtime configuration.
     *
     * @param pos `[lon, lat, height]` in public space
     * @param mode height mode (`'fix'` or `'float'`)
     */
    checkVisibility(
        pos: vec3,
        mode: HeightMode,
    ): boolean | null {

        if (this._guard()) return null;

        const map = this._map;
        const renderer = this._renderer;

        if (!map || !renderer) {
            return null;
        }

        const navCoords = this.convertCoordsFromPublicToNav(pos, mode);
        if (!navCoords) {
            return false;
        }

        const navMode = (mode === 'float') ? 'fix' : mode;
        const canvasCoords = this.convertCoordsFromNavToCanvas(
            navCoords, navMode
        );

        if (!canvasCoords || canvasCoords[2] > 1) {
            return false;
        }

        const [screenX, screenY] = canvasCoords;
        const viewport = renderer.curSize;

        if (
            !Number.isFinite(screenX) || !Number.isFinite(screenY)
            || screenX < 0 || screenY < 0
            || screenX >= viewport[0] || screenY >= viewport[1]
        ) {
            return false;
        }

        const physCoords = this.convertCoordsFromNavToPhys(
            navCoords, navMode
        );
        if (!physCoords) {
            return false;
        }

        const cameraSpaceCoords = this.convertCoordsFromPhysToCameraSpace(
            physCoords
        );
        if (!cameraSpaceCoords) {
            return false;
        }

        const pointDepth = Math.hypot(
            cameraSpaceCoords[0],
            cameraSpaceCoords[1],
            cameraSpaceCoords[2],
        );
        const dilate = map.config.mapDMapDilatePx ?? 0;
        const screenDepth = map.getScreenDepth(screenX, screenY, dilate);

        __DEV__ && utils.logOnce(
            '[checkVisibility] raw depth debug logging is enabled in '
            + 'Viewer.checkVisibility(); replace it with targeted '
            + 'instrumentation before relying on this API.'
        );

        if (!screenDepth || !screenDepth[0]) {
            return true;
        }

        return (pointDepth - screenDepth[1]) <= (0.03 * pointDepth);
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

        if (this._guard()) return null;
        return this._mapInterface?.getHitCoords(
            screenX, screenY, mode, lod) ?? null;
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

        if (this._guard()) return null;
        return this._mapInterface?.convertCoordsFromNavToPublic(
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

        if (this._guard()) return null;
        return this._mapInterface?.convertCoordsFromNavToPhys(
            pos, mode, lod, includeSE) ?? null;
    }

    /**
     * Converts physical (ECEF) coordinates to camera space.
     *
     * @param pos `[x, y, z]` in physical space
     */
    convertCoordsFromPhysToCameraSpace(pos: vec3): vec3 | null {

        if (this._guard()) return null;
        return this._mapInterface?.convertCoordsFromPhysToCameraSpace(pos)
            ?? null;
    }

    // -------------------------------------------------------------------------
    // Browser sub-objects
    // -------------------------------------------------------------------------

    /** The browser UI layer (controls, DOM helpers). */
    get ui(): Browser['ui'] | undefined {

        if (this._killed) return undefined;
        return this._browser.ui;
    }

    /** The autopilot (camera animation) controller. */
    get autopilot(): Browser['autopilot'] | undefined {

        if (this._killed) return undefined;
        return this._browser.autopilot;
    }

    /** The presenter (tour / flythrough) controller. */
    get presenter(): Browser['presenter'] | undefined {

        if (this._killed) return undefined;
        return this._browser.presenter;
    }

    // -------------------------------------------------------------------------
    // Legacy / compat
    // -------------------------------------------------------------------------

    /** Unloads the current map. */
    destroyMap(): this {

        if (this._guard()) return this;
        this._core.destroyMap();
        return this;
    }

    /**
     * Sets the navigation control mode.
     *
     * Control modes switch navigation within a single map between the
     * default observer mode (moving around the map) and pano mode
     * (looking around inside a panoramic bubble). The pano path is
     * largely obsolete, but it is still kept for now.
     *
     * @param mode control mode identifier
     */
    setControlMode(mode: Browser['controlMode']): this {

        if (this._guard()) return this;
        this._browser.setControlMode(mode);
        return this;
    }

    /**
     * Returns the current navigation control mode.
     *
     * See `setControlMode()` for the built-in mode semantics.
     */
    getControlMode(): Browser['controlMode'] | null {

        if (this._guard()) return null;
        return this._browser.getControlMode();
    }

}

namespace Viewer {

    /**
     * The internal config shape passed into `Viewer`.
     *
     * This exists only as constructor glue: `Viewer` has a single
     * constructor, but the library still needs to support both the
     * preferred `map()` entry point and the legacy `browser()` entry
     * point. Their structural inputs are flattened here into one
     * temporary internal object shape.
     */
    export type Config = {

        [key: string]:
            | MapRuntimeOptionValue
            | MapPosition
            | MapStyle.StyleSpecification
            | Record<string, unknown>
            | undefined;

        style?: MapStyle.StyleSpecification;
        map?: string | Record<string, unknown>;
        position?: MapPosition;
        view?: Record<string, unknown>;
    };
}

export default Viewer;
