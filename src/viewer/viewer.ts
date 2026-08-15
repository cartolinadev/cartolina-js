/*
 * viewer.ts — the public API object for cartolina-js
 */

import Map from '../map/map';
import Atmosphere from '../map/atmosphere';
import Renderer from '../renderer/renderer';
import ConfigStore from '../config-store';
import { GpuDevice } from '../renderer/gpu/device';
import * as viewerConfig from '../viewer-config';
import type * as StyleSchema from '../map/style-schema';
import MapPosition from '../map/position';
import type LegacyMap from '../map/legacy-map';
import type VerticalExaggeration from '../map/vertical-exaggeration';
import * as utils from '../utils/utils';
import getVersion from '../version';
import UI from './ui/ui';
import Autopilot from './autopilot/autopilot';
import ControlMode from './control-mode/control-mode';
import Presenter from './presenter/presenter';

import type { vec3 } from '../utils/math';


/**
 * The public API object returned by the `map()` factory.
 * Exported as the type alias `Map` from the package index.
 *
 * `Viewer` is the single object new applications interact with.
 * It provides a flat, typed method surface for all map operations:
 * lifecycle, camera, rendering controls, coordinate conversion, and
 * hit-testing.
 *
 * Do not construct directly — use the `map()` factory
 * function. Sub-objects from the legacy API (`.map`,
 * `.renderer`) are not part of this public interface; methods are
 * promoted to flat accessors on `Viewer` as applications require
 * them.
 */
class Viewer {

    /**
     * Do not construct directly — use the `map()` factory function
     * exported from this package.
     *
     * @param config the complete configuration accepted by `map()`
     */
    constructor(config: Viewer.Config) {

        GpuDevice.checkSupport();

        for (const key of Object.keys(config)) {

            if (!configKeys.has(key)) {
                throw new Error(`'${key}' is not a valid map() option.`);
            }
        }

        // Reject typos, invented keys, and dedicated factory inputs
        // inside the configuration bag. Catalogued internal and
        // debug keys pass for the query-string vocabulary.
        if (config.options)
            viewerConfig.assertConstructionConfigKeys(config.options);

        this.configStore = new ConfigStore(
            viewerConfig.defaultViewerConfig());
        this.config = this.configStore.values;
        this.applyOptions(config.options || {});

        const element = typeof config.container === 'string'
            ? document.getElementById(config.container)
            : config.container;

        if (element
            && window.getComputedStyle(element).position === 'static') {

            element.style.position = 'relative';
        }

        try {

            this.ui_ = new UI(this, element);
            this.ui_.init();

            const mapElement = this.ui_.getMapControl()!
                .getMapElement().getElement();

            this.map_ = new Map(
                mapElement,
                this.configStore,
                config.style,
                config.position,
                config.transformRequest,
            );

            // Immediately after construction, so a load that fails
            // before the rest of the viewer is built still has its
            // rejection handled. The loading indicator stops on loading
            // progress reported by a loaded map, which a failed load
            // never produces. Reacting to `ready` rather than to the
            // public `error` event leaves that event with no listener
            // of ours, so `Map` can tell whether the application
            // handles it.
            void this.map_.ready.catch(() => {

                // `UI.init` assigns the control outside the
                // constructor, so its inferred type stays optional here
                if (!this.disposed_) this.ui_.loading?.hide();
            });

            this.autopilot_ = new Autopilot(this);
            this.controlMode = new ControlMode(
                this, config.interactive ?? true);
            this.presenter_ = new Presenter(this);

            this.subscribeToMapEvents();
            this.watchConfig();

        } catch (error) {

            this[Symbol.dispose]();
            throw error;
        }
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

        this.disposed_ = true;

        for (const unsubscribe of this.unsubscribes_)
            unsubscribe();
        this.unsubscribes_ = [];

        // Fields are undefined only when construction failed before assignment.
        this.map_?.[Symbol.dispose]();
        this.ui_?.kill();
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
    setPosition(position: Map.PositionInput): this {

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
    // Layer terrain applicability and visibility profiles
    //
    // All six methods require style readiness: they throw before the
    // `ready` promise resolves. There is no pending-operation queue.
    // -------------------------------------------------------------------------

    /**
     * Applies a complete visibility snapshot atomically: the active
     * terrain stack plus the active terrain list of every style
     * layer. The profile is fully validated first; an invalid
     * profile changes nothing. Applying a profile is a one-time
     * write of ordinary visibility state — later direct changes
     * and later profiles follow normal call order.
     *
     * @param profile the complete visibility snapshot
     * @throws before `ready`, or when the profile omits a layer,
     *   names an unknown layer, or names an unknown terrain source
     */
    applyVisibilityProfile(profile: Viewer.VisibilityProfile): this {

        this.assertAlive();
        this.map_.applyVisibilityProfile(profile);
        return this;
    }

    /**
     * Captures the current visibility state as a complete profile:
     * the active terrain stack and every layer's terrain list. The
     * result reapplies exactly through `applyVisibilityProfile`.
     *
     * @throws before `ready`
     */
    getVisibilityProfile(): Viewer.VisibilityProfile {

        this.assertAlive();
        return this.map_.getVisibilityProfile();
    }

    /**
     * Replaces the active terrain stack, preserving the caller's
     * back-to-front order. Layer terrain lists are unchanged and may
     * name currently inactive terrain sources in preparation for a
     * later terrain switch.
     *
     * @param sourceIds terrain source ids in stack order
     * @throws before `ready` or on an id that is not a terrain source
     */
    setTerrainSources(sourceIds: string[]): this {

        this.assertAlive();
        this.map_.setTerrainSources(sourceIds);
        return this;
    }

    /**
     * Returns a copy of the current active terrain stack.
     *
     * @throws before `ready`
     */
    getTerrainSources(): string[] {

        this.assertAlive();
        return this.map_.getTerrainSources();
    }

    /**
     * Replaces one layer's active terrain-source list. An empty array
     * makes the layer inactive on every terrain. Applies to every
     * layer type; lettering rules are active exactly when their list
     * intersects the active terrain stack.
     *
     * @param layerId id of the layer to change
     * @param terrainIds terrain source ids
     * @throws before `ready`, on an unknown layer id, or on an id
     *   that is not a terrain source
     */
    setLayerTerrainSources(layerId: string, terrainIds: string[]): this {

        this.assertAlive();
        this.map_.setLayerTerrainSources(layerId, terrainIds);
        return this;
    }

    /**
     * Returns a copy of one layer's current terrain-source list.
     * An omitted authored `terrain` resolves to every declared
     * terrain source when queried.
     *
     * @param layerId id of the layer to query
     * @throws before `ready` or on an unknown layer id
     */
    getLayerTerrainSources(layerId: string): string[] {

        this.assertAlive();
        return this.map_.getLayerTerrainSources(layerId);
    }

    // -------------------------------------------------------------------------
    // Rendering
    // -------------------------------------------------------------------------

    /** Marks the scene dirty, triggering a re-render on the next frame. */
    redraw(): this {

        this.assertAlive();
        this.legacyMap?.markDirty();
        return this;
    }

    /**
     * Sets the illumination definition (light direction, shading weights, etc.)
     *
     * @param spec illumination definition
     */
    setIllumination(spec: Renderer.IlluminationDef): void {

        this.assertAlive();
        this.renderer.setIllumination(spec);
    }

    /** Returns the current illumination definition. */
    getIllumination(): Renderer.IlluminationDef | null {

        this.assertAlive();
        return this.renderer.getIllumination();
    }

    /**
     * Sets the vertical exaggeration spec (elevation ramp and scale ramp).
     *
     * @param spec vertical exaggeration specification
     */
    setVerticalExaggeration(spec: VerticalExaggeration.Spec): void {

        this.assertAlive();
        this.map_.setVerticalExaggeration(spec);
    }

    /** Returns the current vertical exaggeration specification. */
    getVerticalExaggeration(): VerticalExaggeration.Spec | null {

        this.assertAlive();
        return this.map_.getVerticalExaggeration();
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

        return this.map_.getVeScaleFactor(currentPosition);
    }

    /**
     * Sets the runtime atmosphere parameters.
     *
     * Fields omitted from `spec` are cleared. Atmosphere visibility is
     * controlled separately by the `useAtmosphere` rendering option.
     *
     * @param spec runtime atmosphere parameters
     */
    setAtmosphere(spec: Atmosphere.RuntimeParameters): void {

        this.assertAlive();
        this.map_.setAtmosphere(spec);
    }

    /** Returns the current runtime atmosphere rendering parameters. */
    getAtmosphere(): Atmosphere.RuntimeParameters | null {

        this.assertAlive();
        return this.map_.getAtmosphere();
    }

    /**
     * Sets rendering feature flags (lighting, normal maps, atmosphere, etc.)
     *
     * @param options rendering options
     */
    setRenderingOptions(options: Renderer.RenderingOptions): void {

        this.assertAlive();
        this.renderer.setRenderingOptions(options);
    }

    /** Returns the current rendering options. */
    getRenderingOptions(): Renderer.RenderingOptions | null {

        this.assertAlive();
        return this.renderer.getRenderingOptions();
    }

    // -------------------------------------------------------------------------
    // Config params
    // -------------------------------------------------------------------------

    /**
     * Sets a single runtime configuration parameter.
     *
     * Valid keys and their value types are defined by
     * `Viewer.PublicRuntimeConfig`. The value is normalized
     * (coerced, clamped) before it is stored; the change takes
     * effect at the next frame boundary.
     *
     * @param key parameter key
     * @param value parameter value
     * @throws when `key` is not a public runtime parameter
     */
    setParam<K extends keyof Viewer.PublicRuntimeConfig>(
        key: K,
        value: Viewer.PublicRuntimeConfig[K],
    ): this {

        this.assertAlive();

        if (!viewerConfig.isPublicRuntimeConfigKey(key)) {

            throw new Error(
                `'${String(key)}' is not a public runtime parameter.`);
        }

        const patch = viewerConfig.normalizeConfigPatch(key, value);
        if (patch) this.configStore.set(patch);
        return this;
    }

    /**
     * Returns the current value of a runtime configuration parameter.
     *
     * Valid keys and the key-specific return types are defined by
     * `Viewer.PublicRuntimeConfig`.
     *
     * @param key parameter key
     * @throws when `key` is not a public runtime parameter
     */
    getParam<K extends keyof Viewer.PublicRuntimeConfig>(
        key: K,
    ): Viewer.PublicRuntimeConfig[K] {

        this.assertAlive();

        if (!viewerConfig.isPublicRuntimeConfigKey(key)) {

            throw new Error(
                `'${String(key)}' is not a public runtime parameter.`);
        }

        return this.configStore.get(key) as
            Viewer.PublicRuntimeConfig[K];
    }

    // -------------------------------------------------------------------------
    // Coordinate conversion
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

    // -------------------------------------------------------------------------
    // Hit testing
    // -------------------------------------------------------------------------

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

    // -------------------------------------------------------------------------
    // Depth and visibility
    // -------------------------------------------------------------------------

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

    /**
     * Returns whether a public-space point is visible in the current
     * terrain view.
     *
     * A point is reported occluded when the terrain drawn at the pixel
     * it projects to is nearer to the camera than the point itself.
     * Both distances are taken in the rendered domain, so vertical
     * exaggeration is applied to the point before its distance is
     * measured, matching the exaggerated surface the depth pass drew.
     *
     * This uses the cached hitmap/depth-map path. Occlusion can lag
     * while the camera is moving because hitmap copies are throttled by
     * `mapDMapCopyIntervalMs`; a point can therefore be tested against
     * terrain depths up to that interval old.
     *
     * Terrain-anchored points are not reliable. A `'float'` height comes
     * from the navigation height field, which sits some way off the mesh
     * being drawn, and on steep ground that error moves the projection
     * across a silhouette onto terrain much nearer, reporting occlusion
     * that is not real. No application should depend on this method for
     * such points; see the backlog entry "terrain-anchored points near
     * silhouettes".
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
        const renderer = this.renderer;

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

        // The depth pass writes the distance to the surface as drawn,
        // which carries vertical exaggeration, so the point is
        // exaggerated the same way before its distance is measured.
        const physCoords = this.convertCoordsFromNavToPhys(
            navCoords, navMode, undefined, true
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

        // Dilation off: the sample is the terrain in the single texel
        // the point falls in.
        const screenDepth = map.getScreenDepth(
            screenX, screenY, 0, false, 'apparent');

        if (!screenDepth || !screenDepth[0]) {
            return true;
        }

        // A depth-map sample is the terrain depth somewhere inside a
        // texel rather than exactly under the point, which spreads the
        // two depths by up to 0.4% of the view distance.
        const tolerance = 0.01;

        return (pointDepth - screenDepth[1]) <= (tolerance * pointDepth);
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

        return this.map_.getScaleDenominator(currentExtent);
    }

    // -------------------------------------------------------------------------
    // Legacy shims — pending promotion to flat Viewer methods
    //
    // These three getters expose Viewer sub-objects directly. They exist
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
    get ui(): InstanceType<typeof UI> {

        this.assertAlive();
        return this.ui_;
    }

    /**
     * The autopilot (camera animation) controller.
     *
     * @deprecated Direct sub-object access. Use a flat `Viewer` method
     *   once the relevant capability is promoted.
     */
    get autopilot(): InstanceType<typeof Autopilot> {

        this.assertAlive();
        return this.autopilot_;
    }

    /**
     * The presenter (tour / flythrough) controller.
     *
     * @deprecated Direct sub-object access. Use a flat `Viewer` method
     *   once the relevant capability is promoted.
     */
    get presenter(): InstanceType<typeof Presenter> {

        this.assertAlive();
        return this.presenter_;
    }

    // -------------------------------------------------------------------------
    // Legacy / compat
    // -------------------------------------------------------------------------

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
    setControlMode(mode: InstanceType<typeof ControlMode>): this {

        this.assertAlive();
        this.controlMode = mode;
        return this;
    }

    /**
     * Returns the current navigation control mode.
     *
     * See `setControlMode()` for the built-in mode semantics.
     */
    getControlMode(): InstanceType<typeof ControlMode> | null {

        this.assertAlive();
        return this.controlMode;
    }

    // -------------------------------------------------------------------------
    // Metadata
    // -------------------------------------------------------------------------

    /** The cartolina-js library version string. */
    version(): string {

        return getVersion();
    }

    // -------------------------------------------------------------------------
    // Private implementation
    // -------------------------------------------------------------------------

    /**
     * Internal event-emitter owner used by residual JS children.
     * This property is private to the typed public surface.
     */
    private get map(): Map {

        return this.map_;
    }

    private get legacyMap(): LegacyMap | null {

        return this.map_.legacyMap;
    }

    private get renderer(): Renderer {

        return this.map_.renderer;
    }

    /** Whether a map is loaded and ready. Read by UI controls. */
    private get mapLoaded(): boolean {

        return this.map_.loaded;
    }

    /** Throws if the viewer has been destroyed. */
    private assertAlive(): void {

        if (this.disposed_) {
            throw new Error('Viewer has been destroyed.');
        }
    }

    /** Applies normalized construction options to the shared config store. */
    private applyOptions(options: object): void {

        for (const [key, value] of Object.entries(options))
            this.applyOption(key, value);
    }

    /** Normalizes and applies one raw shared option. */
    private applyOption(key: string, value: unknown): void {

        const patch = viewerConfig.normalizeConfigPatch(key, value);
        if (!patch) {

            if (viewerConfig.looksLikeConfigKey(key)) {
                console.warn(
                    `Unknown configuration key '${key}'; ignored.`);
            }
            return;
        }

        this.configStore.set(patch);
    }

    /** Registers Viewer-owned map-event reactions. */
    private subscribeToMapEvents(): void {

        const updatePositionInUrl = () => {

            if (this.config.positionInUrl) this.updatePosInUrl_ = true;
        };

        const markMapInteracted = () => {

            this.mapInteracted_ = true;
        };

        this.unsubscribes_.push(
            this.on('map-loaded', () => {

                this.autopilot_.setAutorotate(this.config.autoRotate);
                this.autopilot_.setAutopan(
                    this.config.autoPan[0], this.config.autoPan[1]);
            }),
            this.on('map-update', () => {

                this.dirty_ = true;
            }),
            this.on('map-position-changed', updatePositionInUrl),
            this.on(
                'map-position-fixed-height-changed',
                updatePositionInUrl,
            ),
            this.on('map-position-panned', markMapInteracted),
            this.on('map-position-rotated', markMapInteracted),
            this.on('map-position-zoomed', markMapInteracted),
            this.on('tick', () => this.handleTick()),
        );
    }

    /** Registers Viewer-owned configuration reactions. */
    private watchConfig(): void {

        for (const key of uiControlKeys) {

            this.unsubscribes_.push(this.configStore.watch(
                [key],
                () => this.ui_.setParam(key),
            ));
        }

        this.unsubscribes_.push(this.configStore.watch(
            ['autoRotate', 'autoPan'],
            (values) => {

                if (this.legacyMap) {
                    this.autopilot_.setAutorotate(values.autoRotate);
                    this.autopilot_.setAutopan(
                        values.autoPan[0], values.autoPan[1]);
                }
            },
        ));
    }

    private handleTick(): void {

        if (this.disposed_) return;

        this.autopilot_.tick();
        this.ui_.tick(this.dirty_);
        this.dirty_ = false;

        if (!this.updatePosInUrl_) return;

        const timer = performance.now();
        if (timer - this.lastUrlUpdateTime_ <= 1000) return;

        if (window.history.replaceState) {
            window.history.replaceState(
                {},
                '',
                this.getLinkWithCurrentPos(),
            );
        }

        this.updatePosInUrl_ = false;
        this.lastUrlUpdateTime_ = timer;
    }

    /**
     * Internal map-model accessor used by residual JS Viewer children.
     */
    private getMap(): LegacyMap | null {

        return this.legacyMap;
    }

    /**
     * Internal renderer accessor used by residual JS Viewer children.
     */
    private getRenderer(): Renderer {

        return this.renderer;
    }

    /**
     * Internal URL helper used by the link and measurement controls.
     */
    private getLinkWithCurrentPos(): string {

        const map = this.legacyMap;
        if (!map) return '';

        const params = utils.getParamsFromUrl(
            window.location.href) as Record<string, string>;
        let position = map.getPosition();
        position = map.convertPositionHeightMode(position, 'fix', true);

        const coords = position.getCoords();
        const orientation = position.getOrientation();
        const serialized = [
            position.getViewMode(),
            coords[0].toFixed(6),
            coords[1].toFixed(6),
            position.getHeightMode(),
            coords[2].toFixed(2),
            orientation[0].toFixed(2),
            orientation[1].toFixed(2),
            orientation[2].toFixed(2),
            position.getViewExtent().toFixed(2),
            position.getFov().toFixed(2),
        ].join(',');

        params.pos = serialized;

        if (this.mapInteracted_) {

            if (params.rotate || this.configStore.get('autoRotate'))
                params.rotate = '0';

            const pan = this.configStore.get('autoPan');
            if (params.pan || pan[0] || pan[1]) params.pan = '0,0';
        }

        const query = Object.entries(params)
            .map(([key, value]) => `${key}=${value}`)
            .join('&');
        const urlParts = window.location.href.split('?');
        if (urlParts.length > 1) {

            const extraParts = urlParts[1].split('#');
            return `${urlParts[0]}?${query}${extraParts[1] || ''}`;
        }

        return `${urlParts[0]}?${query}`;
    }

    // -------------------------------------------------------------------------
    // Private state
    // -------------------------------------------------------------------------

    private readonly configStore:
        ConfigStore<viewerConfig.ViewerConfig>;

    /**
     * Shared normalized configuration read by the remaining legacy
     * UI and navigation modules.
     */
    private readonly config: Readonly<viewerConfig.ViewerConfig>;

    private readonly map_: Map;
    private readonly ui_: InstanceType<typeof UI>;
    private readonly autopilot_: InstanceType<typeof Autopilot>;
    private controlMode: InstanceType<typeof ControlMode>;
    private readonly presenter_: InstanceType<typeof Presenter>;
    private unsubscribes_: (() => void)[] = [];

    private updatePosInUrl_ = false;
    private lastUrlUpdateTime_ = 0;
    private mapInteracted_ = false;
    private dirty_ = false;
    private disposed_ = false;

}

// The complete public construction shape. Keeping this guard beside
// Viewer.Config prevents the factory and constructor contracts from
// drifting apart.
const configKeys = new Set([
    'container', 'style', 'position', 'options',
    'transformRequest', 'interactive',
]);

const uiControlKeys: (keyof viewerConfig.ViewerConfig)[] = [
    'controlCompass', 'controlZoom', 'controlMeasure', 'controlScale',
    'controlLayers', 'controlSpace', 'controlSearch', 'controlLink',
    'controlLogo', 'controlFullscreen', 'controlCredits',
];

namespace Viewer {

    /** Complete construction configuration accepted by `map()`. */
    export type Config = {

        /** The HTML element in which cartolina renders the map. */
        container: HTMLElement | string;

        /** A parsed map style or the URL of one. */
        style: string | StyleSchema.StyleSpecification;

        /** Initial ten-component position; omitted to use the style default. */
        position?: Map.PositionInput;

        /** Public store-backed runtime and construction values. */
        options?: viewerConfig.PublicConstructionConfig;

        /** Rewrites resource URLs or adds request headers. */
        transformRequest?: utils.TransformRequestCallback;

        /**
         * Enables mouse, keyboard, and touch interaction. Defaults to
         * `true`.
         */
        interactive?: boolean;
    };

    /**
     * A complete visibility snapshot: the active terrain stack plus
     * the active terrain-source list of every style layer. A runtime
     * value applied through `applyVisibilityProfile`; never part of
     * the authored style.
     */
    export type VisibilityProfile = Map.VisibilityProfile;

    /**
     * The public runtime configuration map accepted and returned by
     * `setParam` and `getParam`: a deliberate subset of the config
     * catalogue restricted to live, application-facing keys.
     */
    export type PublicRuntimeConfig =
        import('../viewer-config').PublicRuntimeConfig;

    /**
     * Public member types, surfaced here so consumers name them through
     * the `Map` alias (`Map.PositionInput`, `Map.OverlaySpec`, …). Each
     * forwards to the module that owns the type.
     */
    export type PositionInput = import('../map/types').PositionInput;
    export type OverlaySpec = Map.OverlaySpec;
    export type ViewerEventMap = Map.ViewerEventMap;
    export type VerticalExaggerationSpec = Map.VerticalExaggerationSpec;
}

export default Viewer;
