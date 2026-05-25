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

import type MapPosition from './map/position';
import type {
    CoreConfig,
    CoreEventMap,
    HeightMode,
    Lod,
    OverlayContext,
    OverlaySpec,
} from './types';
import type { vec3 } from './utils/math';


type OverlayEntry = {
    name: string;
    spec: OverlaySpec;
    enabled: boolean;
    added: boolean;
};


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
     * Active rendering channel for the current frame.
     *
     * - `'color'`: visual canvas pass.
     * - `'depth'`: depth / hit pass that feeds the hitmap.
     */
    drawChannel: 'color' | 'depth' = 'color';

    /**
     * Registered overlays in registration order. `onAdd` fires the first
     * time each entry runs through `runOverlays_`; `onRemove` fires when
     * the entry is removed or when the `Map` is disposed.
     */
    private overlays_: OverlayEntry[] = [];

    /**
     * @param element canvas element to render into
     * @param config engine configuration
     */
    constructor(element: HTMLElement, config: Partial<CoreConfig>) {

        this.core_ = new Core(element, config);
        this.core_.outerMap = this;
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
        this.disposeOverlays_();
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
     * Registers a custom overlay that runs as the explicit last step of
     * every canvas-target frame, after the engine has drawn terrain,
     * free layers, and label / icon jobs. Idempotent: a second call with
     * the same name is ignored.
     *
     * @param name unique overlay id
     * @param spec lifecycle callbacks; only `render` is required
     */
    addOverlay(name: string, spec: OverlaySpec): void {

        this.assertAlive_();
        if (this.findOverlayIndex_(name) !== -1) return;

        this.overlays_.push({
            name, spec, enabled: true, added: false,
        });
    }

    /**
     * Removes the overlay registered under `name` and fires its
     * `onRemove` callback if `onAdd` had run.
     */
    removeOverlay(name: string): void {

        this.assertAlive_();
        const index = this.findOverlayIndex_(name);
        if (index === -1) return;

        const entry = this.overlays_[index];
        this.overlays_.splice(index, 1);

        if (entry.added && entry.spec.onRemove)
            entry.spec.onRemove(this.overlayContext_());
    }

    /**
     * Toggles whether the overlay's `render` callback runs each frame.
     * Does not fire `onAdd` or `onRemove`.
     */
    setOverlayEnabled(name: string, enabled: boolean): void {

        this.assertAlive_();
        const index = this.findOverlayIndex_(name);
        if (index === -1) return;

        this.overlays_[index].enabled = enabled;
    }

    private findOverlayIndex_(name: string): number {

        for (let i = 0; i < this.overlays_.length; i++) {

            if (this.overlays_[i].name === name) return i;
        }
        return -1;
    }

    private overlayContext_(): OverlayContext {

        return { renderer: this.core_.renderer };
    }

    /**
     * Runs every registered overlay's `render` callback. Called as the
     * explicit last step of the canvas-target frame; must not be called
     * for any auxiliary pass.
     */
    private runOverlays_(): void {

        if (this.overlays_.length === 0) return;

        const ctx = this.overlayContext_();

        for (let i = 0; i < this.overlays_.length; i++) {

            const entry = this.overlays_[i];
            if (!entry.enabled) continue;

            if (!entry.added) {

                if (entry.spec.onAdd) entry.spec.onAdd(ctx);
                entry.added = true;
            }

            entry.spec.render(ctx);
        }
    }

    /**
     * Fires `onRemove` for every added overlay in registration-reverse
     * order. Called from `[Symbol.dispose]` before tearing down `Core`
     * so overlays can still draw through the live renderer.
     */
    private disposeOverlays_(): void {

        const ctx = this.overlayContext_();
        for (let i = this.overlays_.length - 1; i >= 0; i--) {

            const entry = this.overlays_[i];
            if (entry.added && entry.spec.onRemove)
                entry.spec.onRemove(ctx);
        }
        this.overlays_.length = 0;
    }

    // -------------------------------------------------------------------
    // Frame loop
    // -------------------------------------------------------------------

    /** Was `LegacyMap.srsReady` already true at the previous tick? */
    private mapLoadedFired_ = false;

    /**
     * Per-frame entry point. Called by `Core.onUpdate` once per
     * animation frame. Owns the public `tick` event, the `map-loaded`
     * first-load completion, position-change dispatch, canvas-target
     * sync, the dirty-gated draw, and the post-frame stats close.
     *
     * The two narrow callbacks `LegacyMap.tickBefore` and
     * `LegacyMap.tickDeferredEvents` carry residual JS work that has
     * not been promoted to TypeScript yet.
     */
    tick(): void {

        if (this.disposed_) return;

        const core = this.core_;
        const legacyMap = core.map;

        // No map loaded (async style load or post-`destroyMap`).
        if (legacyMap == null) {

            core.callListener('tick', {});
            return;
        }

        // First-load completion: fires once per map load.
        if (!this.mapLoadedFired_ && legacyMap.isReferenceFrameReady()) {

            legacyMap.srsReady = true;
            this.mapLoadedFired_ = true;
            core.callListener(
                'map-loaded', { browserOptions: legacyMap.browserOptions });
            core.markReady_({ browserOptions: legacyMap.browserOptions });
        }

        // Reference frame still loading: only let the loader make
        // progress, emit `tick`, and bail out before opening a stats
        // frame. Mirrors the legacy `LegacyMap.update` not-ready branch.
        if (!legacyMap.srsReady) {

            legacyMap.loader.update();
            core.callListener('tick', {});
            return;
        }

        // Position-change events.
        const position = legacyMap.position;
        const lastPosition = legacyMap.lastPosition;
        if (!position.isSame(lastPosition)) {

            core.callListener('map-position-changed', {
                'position': position.toArray(),
                'last-position': lastPosition.toArray(),
            });
        }

        const camera = legacyMap.camera;
        if (camera.lastTerrainHeight !== camera.terrainHeight) {

            core.callListener('map-position-fixed-height-changed', {
                'height': camera.terrainHeight,
                'last-height': camera.lastTerrainHeight,
            });
        }

        legacyMap.lastPosition = position.clone();
        camera.lastTerrainHeight = camera.terrainHeight;

        // Canvas size change forces a redraw.
        if (core.renderer.ensureCanvasRenderTarget()) {
            legacyMap.dirty = true;
        }

        const dirty = legacyMap.dirty || legacyMap.dirtyCountdown > 0;

        legacyMap.stats.begin(dirty);
        legacyMap.tickBefore();

        if (dirty) {

            if (legacyMap.dirty) {
                legacyMap.dirtyCountdown = legacyMap.config.mapRefreshCycles;
            } else {
                legacyMap.dirtyCountdown--;
            }

            legacyMap.dirty = false;
            legacyMap.bestMeshTexelSize = 0;
            legacyMap.bestGeodataTexelSize = 0;

            this.draw();
            this.runOverlays_();

            /* Post-draw loader promotion: requests discovered during
             * traversal enter the loader the same frame instead of
             * waiting one extra animation frame. */
            legacyMap.loader.update();

            core.callListener('map-update', {});
        }

        legacyMap.tickDeferredEvents();
        legacyMap.stats.end(dirty);
        core.callListener('tick', {});
    }

    /**
     * Reset map-owned per-frame state. Called at the top of `Map.draw`.
     */
    private initFrame(): void {

        const legacyMap = this.core_.map!;

        if (this.drawChannel !== 'depth') {

            legacyMap.visibleCredits = {
                imagery: {}, glueImagery: {}, mapdata: {},
            };
        }

        legacyMap.loader.setChannel(0); // 0 = hires channel
        legacyMap.stats.renderBuild = 0;
    }

    /**
     * Returns the navigation position — the position driving the live
     * camera. In freeze mode this is the unfrozen navigation context;
     * outside freeze mode it equals `getSelectionPosition()`. Returns
     * `null` before the map is loaded.
     *
     * Internal: not promoted to `Viewer`. Public callers should use
     * `Viewer.getPosition()`.
     */
    getNavigationPosition(): MapPosition | null {

        const legacyMap = this.core_.map;
        if (legacyMap == null) return null;
        return legacyMap.freeze
            ? (legacyMap.freeze.getNavigationPosition() ?? legacyMap.position)
            : legacyMap.position;
    }

    /**
     * Returns the selection position — the position driving terrain
     * selection (culling, texel-size choice, depth sampling). In freeze
     * mode this is the frozen view; outside freeze mode it equals
     * `getNavigationPosition()`. Returns `null` before the map is
     * loaded.
     *
     * Internal: not promoted to `Viewer`.
     */
    getSelectionPosition(): MapPosition | null {

        const legacyMap = this.core_.map;
        if (legacyMap == null) return null;
        return legacyMap.freeze
            ? (legacyMap.freeze.getSelectionPosition() ?? legacyMap.position)
            : legacyMap.position;
    }

    /**
     * Draws one frame against the current render target. Called from
     * `Map.tick` for the canvas frame and from `MapDraw.drawHitmap` for
     * the depth pass. The body relocates from the legacy
     * `MapDraw.drawMap`; the per-channel decisions still flow through
     * `this.drawChannel`.
     */
    draw(): void {

        const legacyMap = this.core_.map!;
        const renderer = this.core_.renderer;
        const mapDraw = legacyMap.draw;
        const gpu = renderer.gpu;
        const channel = this.drawChannel;

        // Reset owner-specific frame state before issuing draw work.
        this.initFrame();
        renderer.initFrame();
        mapDraw.initFrame();

        /* Depth-channel color was cleared in
         * `switchToFramebuffer('depth')`; only depth is reset here. */
        if (channel !== 'depth')
            gpu.clearColorAndDepth();
        else
            gpu.clearDepth();

        // draw background (skydome)
        if (channel === 'color' && legacyMap.isAtmospheric())
            renderer.drawBackground();

        // runtime label override falls back to the map configuration.
        const labelsEnabled = legacyMap.overrides.flagLabels
            ?? legacyMap.config.mapFlagLabels;

        // clear queued geodata jobs
        if (labelsEnabled
            && legacyMap.freeLayersHaveGeodata
            && channel === 'color') {

            renderer.draw.clearJobBuffer();
        }

        // draw surfaces and free layers
        gpu.setState(mapDraw.drawTileState);

        if (legacyMap.overrides.drawEarth) {

            legacyMap.withSelectionCamera(() => {

                // todo: remove this
                for (let i = 0; i < mapDraw.tileBuffer.length; i++) {
                    mapDraw.tileBuffer[i] = null;
                }

                // draw mesh tiles
                if (legacyMap.tree.surfaceSequence.length > 0) {
                    legacyMap.tree.draw(false);
                }

                // draw free layers
                for (
                    let i = 0;
                    i < legacyMap.freeLayerSequence.length;
                    i++
                ) {

                    const layer = legacyMap.freeLayerSequence[i];

                    if (!labelsEnabled
                        && (layer.type === 'geodata' || layer.geodata)) {
                        continue;
                    }

                    if (layer.ready && layer.tree
                        && (!layer.geodata
                            || (layer.stylesheet
                                && layer.stylesheet.isReady()))
                        && channel === 'color') {

                        if (layer.zFactor) {
                            mapDraw.zbufferOffset = layer.zFactor;
                        }

                        if (layer.type === 'geodata') {
                            // monolithic geodata job collection
                            mapDraw.drawMonoliticGeodata(layer);
                        } else {
                            /* Tiled free-layer traversal. Surface tiles
                             * draw directly; geodata tiles only
                             * collect jobs. */
                            layer.tree.draw();
                        }

                        mapDraw.zbufferOffset = null;
                    }
                }
            });

        } // if (legacyMap.overrides.drawEarth)

        // draw freeze frustum, if applicable
        const inspector = this.core_.inspector;
        if (channel === 'color'
                && inspector
                && inspector.hasFreezeFrustum()) {

            legacyMap.withNavigationCamera(() => {
                inspector.drawFreezeFrustum();
            });
        }

        // draw queued geodata labels and icons
        if (legacyMap.overrides.drawEarth
                && labelsEnabled
                && legacyMap.freeLayersHaveGeodata
                && channel === 'color') {

            renderer.drawnGeodataTiles =
                legacyMap.stats.drawnGeodataTilesPerLayer;
            renderer.drawnGeodataTilesFactor =
                legacyMap.stats.drawnGeodataTilesFactor;

            legacyMap.withNavigationCamera(() => {
                renderer.draw.drawGpuJobs(this.getSelectionPosition()!);
            });
        }

        // done
    }
}


export default Map;
