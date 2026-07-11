/*
 * viewer.ts — the public API object for cartolina-js
 */

import Browser from './browser';
import Map from '../core/map';
import Atmosphere from '../core/map/atmosphere';
import Renderer from '../core/renderer/renderer';
import type { MapRuntimeOptionValue } from './index';
import type { TransformRequestCallback } from '../core/types';
import MapStyle from '../core/map/style';
import MapPosition from '../core/map/position';
import type LegacyMap from '../core/map/map';
import * as utils from '../core/utils/utils';

import type { vec3 } from '../core/utils/math';


/**
 * The public API object returned by the `map()` factory.
 * Exported as the type alias `Map` from the package index.
 *
 * `Viewer` is the single object new applications interact with.
 * It provides a flat, typed method surface for all map operations:
 * lifecycle, camera, rendering controls, coordinate conversion, and
 * hit-testing.
 *
 * Do not construct directly — use the `map()` or `browser()`
 * factory functions. Sub-objects from the legacy API (`.map`,
 * `.renderer`) are not part of this public interface; methods are
 * promoted to flat accessors on `Viewer` as applications require
 * them.
 */
class Viewer {

    //private readonly _browser: InstanceType<typeof Browser>;
    private readonly _browser: Browser;
    private readonly map_: Map;
    private disposed_ = false;

    private get legacyMap(): LegacyMap | null {
        return this.map_.core.map;
    }

    private get _renderer(): Renderer {
        return this.map_.core.renderer;
    }


    /** Throws if the viewer has been destroyed. */
    private assertAlive(): void {

        if (this.disposed_) {
            throw new Error('Viewer has been destroyed.');
        }
    }

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
        this.map_ = this._browser.getCore() as Map;
    }

    // -------------------------------------------------------------------------
    // Lifecycle
    // -------------------------------------------------------------------------

    /**
     * Promise that resolves once the map is fully loaded and ready to render.
     */
    get ready(): Promise<void> {

        this.assertAlive();
        return this.map_.ready;
    }

    /**
     * Destroys the viewer and releases all GPU and DOM resources.
     *
     * Call this when discarding the viewer. For block-scoped teardown,
     * use the `using` declaration: `using viewer = cartolina.map(...)`.
     */
    [Symbol.dispose](): void {

        if (this.disposed_) return;
        this.map_[Symbol.dispose]();
        this._browser.kill();
        this.disposed_ = true;
    }

    // -------------------------------------------------------------------------
    // Events
    // -------------------------------------------------------------------------

    /**
     * Subscribes to a named map event.
     * See `Map.ViewerEventMap` for available event names.
     *
     * @param eventName the event to subscribe to
     * @param callback invoked each time the event fires
     * @returns an unsubscribe function
     */
    on<K extends keyof Map.ViewerEventMap & string>(
        eventName: K,
        callback: (event: Map.ViewerEventMap[K]) => void,
    ): (() => void) {

        this.assertAlive();
        return this.map_.on(eventName, callback);
    }

    /**
     * Subscribes to a named map event for a single invocation.
     * See `Map.ViewerEventMap` for available event names.
     *
     * @param eventName the event to subscribe to
     * @param callback invoked once when the event fires
     * @returns an unsubscribe function
     */
    once<K extends keyof Map.ViewerEventMap & string>(
        eventName: K,
        callback: (event: Map.ViewerEventMap[K]) => void,
    ): (() => void) {

        this.assertAlive();
        return this.map_.once(eventName, callback);
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

        this.assertAlive();
        this.legacyMap?.setPosition(position);
        return this;
    }

    /** Returns the current camera position as a `MapPosition` instance. */
    getPosition(): MapPosition | null {

        this.assertAlive();
        return this.legacyMap?.getPosition() ?? null;
    }

    // -------------------------------------------------------------------------
    // Render control
    // -------------------------------------------------------------------------

    /** Marks the scene dirty, triggering a re-render on the next frame. */
    redraw(): this {

        this.assertAlive();
        this.legacyMap?.markDirty();
        return this;
    }

    /**
     * Sets the atmosphere rendering parameters.
     *
     * @param spec atmosphere specification; partial updates are merged
     *
     * BUG: if the loaded style has no `atmosphere` section, `this.legacyMap.atmosphere`
     * is null and the optional-chain silently discards the call. `getAtmosphere()`
     * then continues to return null, giving no indication that the set failed.
     * Styles without an atmosphere section must have one injected before map
     * creation for `setAtmosphere` / `getAtmosphere` to work at all.
     */
    setAtmosphere(spec: Atmosphere.Specification): void {

        this.assertAlive();
        this.legacyMap?.atmosphere?.setRuntimeParameters(spec);
    }

    /** Returns the current runtime atmosphere rendering parameters. */
    getAtmosphere(): Atmosphere.RuntimeParameters | null {

        this.assertAlive();
        return this.legacyMap?.atmosphere?.getRuntimeParameters() ?? null;
    }

    /**
     * Switches to a named legacy mapConfig view, or to a supplied view
     * definition. Only valid for mapConfig-initialized maps.
     *
     * @param view named view id or legacy view definition
     * @returns this viewer
     */
    setView(view: string | Record<string, unknown>): this {

        this.assertAlive();
        this.map_.setView(view);
        return this;
    }

    /**
     * Returns the current legacy mapConfig view definition, or `null`
     * when no map is loaded.
     */
    getView(): Record<string, unknown> | null {

        this.assertAlive();
        return this.map_.getView();
    }

    /**
     * Returns the named legacy mapConfig view ids available on the
     * loaded map.
     */
    getNamedViews(): string[] {

        this.assertAlive();
        return this.map_.getNamedViews();
    }

    /**
     * Sets the illumination definition (light direction, shading weights, etc.)
     *
     * @param spec illumination definition
     */
    setIllumination(spec: Renderer.IlluminationDef): void {

        this.assertAlive();
        this._renderer.setIllumination(spec);
    }

    /** Returns the current illumination definition. */
    getIllumination(): Renderer.IlluminationDef | null {

        this.assertAlive();
        return this._renderer.getIllumination();
    }

    /**
     * Sets the vertical exaggeration spec (elevation ramp and scale ramp).
     *
     * @param spec vertical exaggeration specification
     */
    setVerticalExaggeration(spec: Renderer.VerticalExaggerationSpec): void {

        this.assertAlive();
        this._renderer.setVerticalExaggeration(spec);
    }

    /** Returns the current vertical exaggeration specification. */
    getVerticalExaggeration(): Renderer.VerticalExaggerationSpec | null {

        this.assertAlive();
        return this._renderer.getVerticalExaggeration();
    }

    /**
     * Sets rendering feature flags (lighting, normal maps, atmosphere, etc.)
     *
     * @param options rendering options
     */
    setRenderingOptions(options: Renderer.RenderingOptions): void {

        this.assertAlive();
        this._renderer.setRenderingOptions(options);
    }

    /** Returns the current rendering options. */
    getRenderingOptions(): Renderer.RenderingOptions | null {

        this.assertAlive();
        return this._renderer.getRenderingOptions();
    }

    // -------------------------------------------------------------------------
    // Scale
    // -------------------------------------------------------------------------

    /**
     * Returns the scale denominator for a given view extent.
     *
     * If `extent` is omitted, returns the denominator for the current
     * selection position. During freeze diagnostics this matches the terrain
     * selection context rather than the live navigation camera.
     *
     * @param extent view extent in metres
     */
    getScaleDenominator(extent?: number): number {

        this.assertAlive();
        const currentExtent = extent
            ?? this.map_.getSelectionPosition()?.getViewExtent();

        if (currentExtent === undefined) {
            throw new Error('No map is loaded.');
        }

        return this._renderer.getScaleDenominator(currentExtent);
    }

    /**
     * Returns the vertical exaggeration scale factor at the given position.
     *
     * If `position` is omitted, returns the factor for the current selection
     * position. During freeze diagnostics this matches the vertical
     * exaggeration used for terrain rendering.
     *
     * @param position a `MapPosition` instance
     */
    getVeScaleFactor(position?: MapPosition): number {

        this.assertAlive();
        const currentPosition = position
            ?? this.map_.getSelectionPosition();

        if (!currentPosition) {
            throw new Error('No map is loaded.');
        }

        return this._renderer.getVeScaleFactor(currentPosition);
    }

    // -------------------------------------------------------------------------
    // Config params
    // -------------------------------------------------------------------------

    /**
     * Sets a single runtime configuration parameter.
     *
     * Parameters prefixed with `renderer*` are routed to the renderer;
     * those prefixed with `map*` are routed to the map.
     *
     * @param key parameter key
     * @param value parameter value
     */
    setParam(key: string, value: MapRuntimeOptionValue): this {

        this.assertAlive();
        this._browser.setConfigParam(key, value);
        return this;
    }

    /**
     * Returns the current value of a runtime configuration parameter.
     *
     * @param key parameter key
     */
    getParam(key: string): MapRuntimeOptionValue {

        this.assertAlive();
        return this._browser.getConfigParam(key) as MapRuntimeOptionValue;
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
        mode: Map.HeightMode,
        lod?: Map.Lod,
    ): vec3 | null {

        this.assertAlive();
        return this.map_.convertCoordsFromPublicToNav(pos, mode, lod);
    }

    /**
     * Projects navigation (Cartesian) coordinates onto the canvas.
     *
     * Returns `[x, y, depth]` in apparent pixels. A point is visible when
     * `depth <= 1` (in front of the camera).
     *
     * @param pos `[x, y, z]` in navigation space
     * @param mode height mode (`'fix'` or `'float'`)
     * @param lod optional level-of-detail hint
     */
    convertCoordsFromNavToCanvas(
        pos: vec3,
        mode: Map.HeightMode,
        lod?: Map.Lod,
    ): vec3 | null {

        this.assertAlive();
        return this.map_.convertCoordsFromNavToCanvas(pos, mode, lod);
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
        mode: Map.HeightMode,
    ): boolean | null {

        this.assertAlive();

        const map = this.legacyMap;
        const renderer = this._renderer;

        if (!map) {
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
        const viewport = renderer.apparentSize;

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
        const screenDepth = map.getScreenDepth(
            screenX, screenY, dilate, false, 'apparent');

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
        mode: Map.HeightMode,
        lod?: Map.Lod,
    ): vec3 | null {

        this.assertAlive();
        return this.map_.getHitCoords(screenX, screenY, mode, lod);
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
        mode: Map.HeightMode,
        lod?: Map.Lod,
    ): vec3 | null {

        this.assertAlive();
        return this.map_.convertCoordsFromNavToPublic(pos, mode, lod);
    }

    /**
     * Converts navigation coordinates to physical (ECEF) coordinates.
     *
     * @param pos `[x, y, z]` in navigation space
     * @param mode height mode
     * @param lod optional level-of-detail hint
     * @param applyVerticalExaggeration whether to apply vertical exaggeration
     */
    convertCoordsFromNavToPhys(
        pos: vec3,
        mode: Map.HeightMode,
        lod?: Map.Lod,
        applyVerticalExaggeration?: boolean,
    ): vec3 | null {

        this.assertAlive();
        return this.map_.convertCoordsFromNavToPhys(
            pos, mode, lod, applyVerticalExaggeration);
    }

    /**
     * Converts physical (ECEF) coordinates to camera space.
     *
     * @param pos `[x, y, z]` in physical space
     */
    convertCoordsFromPhysToCameraSpace(pos: vec3): vec3 | null {

        this.assertAlive();
        return this.map_.convertCoordsFromPhysToCameraSpace(pos);
    }

    /**
     * Returns terrain distance at a canvas pixel.
     *
     * @param screenX canvas X coordinate in CSS pixels
     * @param screenY canvas Y coordinate in CSS pixels
     * @param dilate optional dilation radius in pixels
     * @param useGeometricIntersection compute a geometric ray intersection
     * instead of sampling the depth hitmap. Geocentric maps intersect the
     * ellipsoid; projected maps intersect the base plane.
     * @returns `[hit, distanceMeters]`, or `null` when the map is not ready.
     * `distanceMeters` is the Euclidean distance from the viewer to the
     * terrain surface at that layout position. `hit` is false when no terrain
     * covers the pixel; `distanceMeters` is then a sentinel value.
     */
    getScreenDepth(
        screenX: number,
        screenY: number,
        dilate?: number,
        useGeometricIntersection = false,
    ): [boolean, number] | null {

        this.assertAlive();
        return this.map_.getScreenDepth(
            screenX,
            screenY,
            dilate,
            useGeometricIntersection,
            'layout',
        );
    }

    // -------------------------------------------------------------------------
    // Geodata overlays
    // -------------------------------------------------------------------------

    /**
     * Creates a geodata builder for constructing vector overlays
     * (lines, polygons, points) to be added to the map as free layers.
     *
     * Return type is `unknown` pending promotion of the full geodata
     * type surface. Use the returned builder's `addLineString`,
     * `importGeoJson`, and `makeFreeLayer` methods directly.
     */
    createGeodata(): unknown {

        this.assertAlive();
        return this.map_.createGeodata();
    }

    /**
     * Adds a free layer (vector overlay) to the map under the given id.
     *
     * @param id layer identifier; used to remove the layer later
     * @param layer result of `geodataBuilder.makeFreeLayer(style)`
     */
    addFreeLayer(id: string, layer: unknown): this {

        this.assertAlive();
        this.map_.addFreeLayer(id, layer);
        return this;
    }

    /**
     * Removes the free layer registered under the given id.
     *
     * @param id layer identifier passed to `addFreeLayer`
     */
    removeFreeLayer(id: string): this {

        this.assertAlive();
        this.map_.removeFreeLayer(id);
        return this;
    }

    // -------------------------------------------------------------------------
    // Custom overlays
    // -------------------------------------------------------------------------

    /**
     * Registers a custom overlay that runs as the explicit last step
     * of every canvas-target frame, after terrain, free layers, and
     * label/icon jobs have been drawn.
     *
     * Overlays do not run during the depth/hit pass or any auxiliary
     * render target. Inside `render(ctx)` the host may issue WebGL
     * draws through `ctx.renderer` (`drawImage`, `drawLineString`,
     * `createTexture`, `getCanvasSize`).
     *
     * `onAdd` fires on the first frame after registration (deferred
     * until the map is loaded). `onRemove` fires when the overlay
     * is removed or the viewer is disposed.
     *
     * @param name unique overlay id
     * @param spec lifecycle callbacks; only `render` is required
     */
    addOverlay(name: string, spec: Map.OverlaySpec): this {

        this.assertAlive();
        this.map_.addOverlay(name, spec);
        return this;
    }

    /**
     * Removes the overlay registered under the given id and fires
     * its `onRemove` callback if `onAdd` had run.
     *
     * @param name overlay id passed to `addOverlay`
     */
    removeOverlay(name: string): this {

        this.assertAlive();
        this.map_.removeOverlay(name);
        return this;
    }

    /**
     * Toggles whether the overlay's `render` callback runs each frame.
     * Does not fire `onAdd` or `onRemove`.
     *
     * @param name overlay id passed to `addOverlay`
     * @param enabled `true` to render, `false` to skip
     */
    setOverlayEnabled(name: string, enabled: boolean): this {

        this.assertAlive();
        this.map_.setOverlayEnabled(name, enabled);
        return this;
    }

    // -------------------------------------------------------------------------
    // Legacy shims — pending promotion to flat Viewer methods
    //
    // These three getters expose Browser sub-objects directly. They exist
    // because no flat Viewer method covers the needed call sites yet.
    // Each one should be replaced by a specific typed method on Viewer
    // (e.g. `flyTo()` instead of `viewer.autopilot.flyTo()`), and the
    // getter removed once all call sites are updated.
    // -------------------------------------------------------------------------

    /**
     * The browser UI layer (controls, DOM helpers).
     *
     * @deprecated Direct sub-object access. Use a flat `Viewer` method
     *   once the relevant capability is promoted.
     */
    get ui(): Browser['ui'] {

        this.assertAlive();
        return this._browser.ui;
    }

    /**
     * The autopilot (camera animation) controller.
     *
     * @deprecated Direct sub-object access. Use a flat `Viewer` method
     *   once the relevant capability is promoted.
     */
    get autopilot(): Browser['autopilot'] {

        this.assertAlive();
        return this._browser.autopilot;
    }

    /**
     * The presenter (tour / flythrough) controller.
     *
     * @deprecated Direct sub-object access. Use a flat `Viewer` method
     *   once the relevant capability is promoted.
     */
    get presenter(): Browser['presenter'] {

        this.assertAlive();
        return this._browser.presenter;
    }

    // -------------------------------------------------------------------------
    // Legacy / compat
    // -------------------------------------------------------------------------

    /** Unloads the current map. */
    destroyMap(): this {

        this.assertAlive();
        this.map_.unloadMap();
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

        this.assertAlive();
        this._browser.setControlMode(mode);
        return this;
    }

    /**
     * Returns the current navigation control mode.
     *
     * See `setControlMode()` for the built-in mode semantics.
     */
    getControlMode(): Browser['controlMode'] | null {

        this.assertAlive();
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
            | TransformRequestCallback
            | Record<string, unknown>
            | undefined;

        style?: MapStyle.StyleSpecification;
        map?: string | Record<string, unknown>;
        position?: MapPosition;
        view?: string | Record<string, unknown>;
        transformRequest?: TransformRequestCallback;
    };
}

export default Viewer;
