/*
 * viewer.ts — the public API object for cartolina-js
 */

import Map from '../map/map';
import Atmosphere from '../map/atmosphere';
import Renderer from '../renderer/renderer';
import ConfigStore from '../config-store';
import { GpuDevice } from '../renderer/gpu/device';
import * as viewerConfig from '../viewer-config';
import MapStyle from '../map/style';
import MapPosition from '../map/position';
import type LegacyMap from '../map/legacy-map';
import * as utils from '../utils/utils';
import getVersion from '../version';
import UI from './ui/ui';
import Autopilot from './autopilot/autopilot';
import ControlMode from './control-mode/control-mode';
import Presenter from './presenter/presenter';

import type { vec3 } from '../utils/math';


// The complete public construction shape. Keeping this guard beside
// Viewer.Options prevents the factory and constructor contracts from
// drifting apart.
const optionKeys = new Set([
    'container', 'style', 'position', 'options',
    'transformRequest', 'interactive',
]);

const uiControlKeys: (keyof viewerConfig.ViewerConfig)[] = [
    'controlCompass', 'controlZoom', 'controlMeasure', 'controlScale',
    'controlLayers', 'controlSpace', 'controlSearch', 'controlLink',
    'controlLogo', 'controlFullscreen', 'controlCredits',
];


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
    private mapLoaded = false;
    private mapInteracted_ = false;
    private dirty_ = false;
    private disposed_ = false;

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

    private get _renderer(): Renderer {

        return this.map_.renderer;
    }


    /** Throws if the viewer has been destroyed. */
    private assertAlive(): void {

        if (this.disposed_) {
            throw new Error('Viewer has been destroyed.');
        }
    }

    /**
     * Do not construct directly — use the `map()` factory function
     * exported from this package.
     *
     * @param options the same public options accepted by `map()`
     */
    constructor(options: Viewer.Options) {

        for (const key of Object.keys(options)) {

            if (!optionKeys.has(key)) {
                throw new Error(`'${key}' is not a valid map() option.`);
            }
        }

        // Reject typos and invented keys loudly; catalogued keys
        // outside the typed surface pass (query-string vocabulary).
        if (options.options)
            viewerConfig.assertCataloguedConfigKeys(options.options);

        const constructionConfig = {
            style: options.style,
            ...options.options,
            position: options.position,
            transformRequest: options.transformRequest,
            interactive: options.interactive ?? true,
        };

        this.configStore = new ConfigStore(
            viewerConfig.defaultViewerConfig());
        this.config = this.configStore.values;
        this.applyConfigParams(constructionConfig);

        if (!GpuDevice.checkSupport()) {
            throw new Error('cartolina-js requires WebGL2.');
        }

        const element = typeof options.container === 'string'
            ? document.getElementById(options.container)
            : options.container;

        if (element
            && window.getComputedStyle(element).position === 'static') {

            element.style.position = 'relative';
        }

        this.ui_ = new UI(this, element);
        let map: Map | null = null;

        try {

            const mapElement = this.ui_.getMapControl()!
                .getMapElement().getElement();

            map = new Map(mapElement, this.configStore);
            this.map_ = map;
            this.autopilot_ = new Autopilot(this);
            this.controlMode = new ControlMode(this);
            this.presenter_ = new Presenter(this, constructionConfig);

            this.unsubscribes_ = [
                this.on('map-loaded', this.onMapLoaded_.bind(this)),
                this.on('map-unloaded', this.onMapUnloaded_.bind(this)),
                this.on('map-update', this.onMapUpdate_.bind(this)),
                this.on(
                    'map-position-changed',
                    this.onMapPositionChanged_.bind(this),
                ),
                this.on(
                    'map-position-fixed-height-changed',
                    this.onMapPositionFixedHeightChanged_.bind(this),
                ),
                this.on(
                    'map-position-panned',
                    this.onMapPositionPanned_.bind(this),
                ),
                this.on(
                    'map-position-rotated',
                    this.onMapPositionRotated_.bind(this),
                ),
                this.on(
                    'map-position-zoomed',
                    this.onMapPositionZoomed_.bind(this),
                ),
                this.on('tick', this.onTick_.bind(this)),
            ];

            this.watchConfig_();
        } catch (error) {

            map?.[Symbol.dispose]();
            this.ui_.kill();
            this.disposed_ = true;
            throw error;
        }
    }

    /** Applies normalized construction input to the shared config store. */
    private applyConfigParams(params: object): void {

        for (const [key, value] of Object.entries(params))
            this.applyConfigParam_(key, value);
    }

    /** Applies one raw config input and its immediate position command. */
    private applyConfigParam_(key: string, value: unknown): void {

        const patch = viewerConfig.normalizeConfigPatch(key, value);
        if (!patch) {

            if (viewerConfig.looksLikeConfigKey(key)) {
                console.warn(
                    `Unknown configuration key '${key}'; ignored.`);
            }
            return;
        }

        this.configStore.set(patch);

        const legacyMap = this.map_?.legacyMap;
        if (legacyMap && 'position' in patch && patch.position != null)
            legacyMap.setPosition(patch.position);
    }

    /** Registers Viewer-owned configuration reactions. */
    private watchConfig_(): void {

        for (const key of uiControlKeys) {

            this.unsubscribes_.push(this.configStore.watch(
                [key],
                () => this.updateUI_(key),
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

    private updateUI_(key: keyof viewerConfig.ViewerConfig): void {

        this.ui_.setParam(key);
    }

    private onMapLoaded_(): void {

        this.mapLoaded = true;
        this.autopilot_.setAutorotate(this.config.autoRotate);
        this.autopilot_.setAutopan(
            this.config.autoPan[0], this.config.autoPan[1]);
    }

    private onMapUnloaded_(): void {
    }

    private onMapUpdate_(): void {

        this.dirty_ = true;
    }

    private onMapPositionChanged_(): void {

        if (this.config.positionInUrl) this.updatePosInUrl_ = true;
    }

    private onMapPositionFixedHeightChanged_(): void {

        if (this.config.positionInUrl) this.updatePosInUrl_ = true;
    }

    private onMapPositionPanned_(): void {

        this.mapInteracted_ = true;
    }

    private onMapPositionRotated_(): void {

        this.mapInteracted_ = true;
    }

    private onMapPositionZoomed_(): void {

        this.mapInteracted_ = true;
    }

    private onTick_(): void {

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
                this.getLinkWithCurrentPos_(),
            );
        }

        this.updatePosInUrl_ = false;
        this.lastUrlUpdateTime_ = timer;
    }

    private getLinkWithCurrentPos_(): string {

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

        return this._renderer;
    }

    /**
     * Internal URL helper used by the link and measurement controls.
     */
    private getLinkWithCurrentPos(): string {

        return this.getLinkWithCurrentPos_();
    }

    /** The cartolina-js library version string. */
    version(): string {

        return getVersion();
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

        this.map_[Symbol.dispose]();
        this.ui_.kill();
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

    // -------------------------------------------------------------------------
    // Layer terrain applicability and visibility profiles
    //
    // All six methods require style readiness: they throw before the
    // `ready` promise resolves. There is no pending-operation queue.
    // -------------------------------------------------------------------------

    /**
     * Replaces one layer's active terrain-source list. An empty array
     * makes the layer inactive on every terrain. Applies to every
     * layer type; lettering rules are active exactly when their list
     * intersects the active terrain stack.
     *
     * @param layerId id of the layer to mutate
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
     * Returns a copy of one layer's effective terrain-source list.
     * Always an explicit array: an omitted authored `terrain`
     * expanded at validation to every declared terrain source.
     *
     * @param layerId id of the layer to query
     * @throws before `ready` or on an unknown layer id
     */
    getLayerTerrainSources(layerId: string): string[] {

        this.assertAlive();
        return this.map_.getLayerTerrainSources(layerId);
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
     * Returns a copy of the effective active terrain stack.
     *
     * @throws before `ready`
     */
    getTerrainSources(): string[] {

        this.assertAlive();
        return this.map_.getTerrainSources();
    }

    /**
     * Applies a complete visibility snapshot atomically: the active
     * terrain stack plus the active terrain list of every style
     * layer. The profile is fully validated first; an invalid
     * profile changes nothing. Applying a profile is a one-time
     * write of ordinary visibility state — later direct mutations
     * and later profiles follow normal call order.
     *
     * @param profile the complete visibility snapshot
     * @throws before `ready`, or when the profile omits a layer,
     *   names an unknown layer, or names an unknown terrain source
     */
    applyVisibilityProfile(profile: Viewer.VisibilityProfile): this {

        this.assertAlive();

        // completeness: the profile must cover exactly the style's
        // layers, so reapplying a captured profile restores all state
        const layerIds = this.map_.getStyleLayerIds();
        const profileIds = new Set(Object.keys(profile.layers));

        for (const id of layerIds) {

            if (!profileIds.has(id)) {
                throw new Error(`Visibility profile omits layer `
                    + `"${id}".`);
            }

            profileIds.delete(id);
        }

        if (profileIds.size > 0) {
            throw new Error(`Visibility profile names unknown `
                + `layer(s): ${[...profileIds].join(', ')}.`);
        }

        // expand into the same primitives as the direct methods; the
        // batch validates terrain ids and commits atomically
        const mutations: MapStyle.StyleMutation[] = [
            { kind: 'terrain-sources', sources: profile.terrain },
        ];

        for (const id of layerIds) {
            mutations.push({
                kind: 'layer-terrain',
                layerId: id,
                terrain: profile.layers[id],
            });
        }

        this.map_.mutateStyle(mutations);
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

        const layers: Record<string, string[]> = {};

        for (const id of this.map_.getStyleLayerIds()) {
            layers[id] = this.map_.getLayerTerrainSources(id);
        }

        return {
            terrain: this.map_.getTerrainSources(),
            layers,
        };
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

}

namespace Viewer {

    /** Options accepted by the public `map()` factory. */
    export type Options = {

        /** The HTML element in which cartolina renders the map. */
        container: HTMLElement | string;

        /** A parsed map style or the URL of one. */
        style: string | MapStyle.StyleSpecification;

        /** Initial ten-component position; omitted to use the style default. */
        position?: Map.PositionInput;

        /** Public runtime and construction configuration values. */
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
    export interface VisibilityProfile {
        terrain: string[];
        layers: Record<string, string[]>;
    }

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
    export type OverlaySpec = import('../map/map').OverlaySpec;
    export type ViewerEventMap = import('../map/map').ViewerEventMap;
}

export default Viewer;
