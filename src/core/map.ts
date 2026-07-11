/*
 * map.ts — typed map data model and frame-loop owner
 */

import { Core } from './core';
import Atmosphere from './map/atmosphere';
import type Renderer from './renderer/renderer';
import MapPosition from './map/position';
import EventBus from './event-bus';
import type {
    CoreConfig,
    HeightMode,
    Lod,
    OverlayContext,
    OverlaySpec,
    ViewerEventMap,
} from './types';
import type { vec3 } from './utils/math';
import * as utils from './utils/utils';
import { grayPngDecodeAvailable } from './utils/gray-png';
import LegacyMap from './map/map';
import FreezeCameraState from './map/freeze-camera-state';
import { defaultOverrides, type Overrides } from './map/overrides';
import FrameProfiler from './map/frame-profiler';
import MapStyle from './map/style';
import MapDraw from './map/draw';
import MapConvert from './map/convert';
import MapMeasure from './map/measure';
import MapSurfaceTree from './map/surface-tree';
import type MapSurface from './map/surface';
import MapConfig from './map/config';
import MapView from './map/view';
import DrawTraversalMaskPool from './map/draw-traversal-mask';
import { drawTerrainTraversal } from './map/draw-traversal';


/**
 * The map data model — cartolina's central object. The typed,
 * graphics-library- and UI-independent representation of a loaded
 * map together with the logic that operates on it. Holds the
 * reference frame, surfaces, free layers, atmosphere, named views,
 * current position, and registered overlays; exposes the per-frame
 * tick, the canvas-target draw, coordinate conversion, and hit-
 * testing.
 *
 * The other two layers are built around `Map`. UI-facing concerns
 * live on `Viewer` (`src/browser/viewer.ts`); the GPU and shader
 * layer lives on `Renderer` (`src/core/renderer/renderer.ts`).
 * `Map` is neither — it is the model both of them work with.
 *
 * Map-model state and behaviour that still lives in JavaScript
 * sit on `LegacyMap` (`src/core/map/map.js`); they absorb into
 * `Map` as feature work touches them.
 *
 * Public types are re-exported under `Map.*` via declaration
 * merging at the bottom of this file. Consumers should write
 * `Map.OverlaySpec`, `Map.ViewerEventMap`, etc.
 */
class Map {

    // -----------------------------------------------------------------
    // Fields
    // -----------------------------------------------------------------

    private core_: Core;
    private disposed_ = false;

    /**
     * The event bus behind `on`, `once`, and `emit`. Handed to the
     * legacy emitters (`Core`, `LegacyMap`, `GpuDevice`) at their
     * construction; they publish through it directly.
     */
    private bus_: EventBus<ViewerEventMap> = new EventBus();

    /**
     * Runtime rendering overrides: diagnostic draw flags and per-frame
     * render-flag overrides. `Renderer.initFrame` caches a reference to
     * this object; all flag reads in a frame see the same snapshot.
     *
     * `draw*` fields default to `false`. `flag*` fields default to
     * `undefined`, which defers to the corresponding `CoreConfig` value.
     * See `Overrides` in `src/core/map/overrides.ts` for the full list.
     */
    overrides: Overrides = { ...defaultOverrides };

    /**
     * Camera-state swapper for diagnostic freeze mode. `null` while no
     * map is loaded and between loads. Created by `createMapFromMapConfig`
     * and `createMapFromStyle`. JS callers that still hold a `LegacyMap`
     * reference access this through `legacyMap.outerMap.freeze`.
     *
     * See `FreezeCameraState` in
     * `src/core/map/freeze-camera-state.ts`.
     */
    freeze: FreezeCameraState | null = null;

    /**
     * Active rendering channel for the current frame.
     *
     * - `'color'`: visual canvas pass.
     * - `'depth'`: depth / hit pass that feeds the hitmap.
     */
    drawChannel: 'color' | 'depth' = 'color';

    /**
     * Registered overlays in registration order. `onAdd` fires the
     * first time an entry runs through `runOverlays_`; `onRemove`
     * fires when the entry is removed or when the `Map` is disposed.
     */
    private overlays_: OverlayEntry[] = [];

    /** Did the one-time `map-loaded` completion fire for the loaded
     * map already? Reset implicitly by replacing the typed `Map`. */
    private mapLoadedFired_ = false;

    /**
     * UV-space mask pool used by the recursive terrain traversal.
     * Lazily allocated on first use by `drawTerrainRecursive` and
     * disposed on map unload and `[Symbol.dispose]()`. Removal
     * target in phase 8 alongside the legacy traversal.
     */
    private terrainMaskPool_: DrawTraversalMaskPool | null = null;

    /**
     * Per-drawn-frame timing (cpu, gpu, draw-call and FBO-switch counts),
     * feeding the inspector panel and `window.__vtsPerf`. Lazily created
     * on the first drawn frame once the GPU device exists.
     */
    private frameProfiler_: FrameProfiler | null = null;

    /** Throttle for publishing profiler results (every Nth drawn frame). */
    private profileWrite_ = 0;

    /**
     * Per-surface helper trees used by the recursive draw traversal
     * (rfc-draw-traversal.md §2.1). Keyed by surface id. Each tree is
     * a single-surface `MapSurfaceTree` constructed with the surface
     * as its `freeLayerSurface`, so every tile binds directly to that
     * surface. The cache is refreshed against
     * the current `surfaceList()` on every draw; entries for surfaces
     * that have left the view are dropped.
     */
    private surfaceTrees_: globalThis.Map<string, MapSurfaceTree>
        = new globalThis.Map();

    // -----------------------------------------------------------------
    // Lifecycle
    // -----------------------------------------------------------------

    /**
     * @param element canvas element to render into
     * @param config map configuration
     */
    constructor(element: HTMLElement, config: Partial<CoreConfig>) {

        this.core_ = new Core(element, config, this.bus_);
        this.core_.outerMap = this;
    }

    /**
     * Destroys the map and releases all owned resources. `onRemove`
     * fires for every added overlay before teardown so overlays can
     * still draw through the live renderer.
     *
     * Prefer the `using` statement with `[Symbol.dispose]()` in new
     * code.
     */
    [Symbol.dispose](): void {

        if (this.disposed_) return;
        this.disposeOverlays();
        this.disposeTerrainMaskPool();
        this.core_.destroy();
        this.disposed_ = true;
    }

    /**
     * @deprecated Use `[Symbol.dispose]()` / `using` instead.
     */
    destroy(): void {

        __DEV__ && utils.warnOnce(
            '[Map] destroy() is deprecated. Use Symbol.dispose instead.', 1);
        this[Symbol.dispose]();
    }

    /** Resolves once the map is fully loaded and ready to render. */
    get ready(): Promise<void> {

        this.assertAlive();
        return this.core_.ready;
    }

    /**
     * Loads a map from a mapConfig URL.
     *
     * @param path URL to the mapConfig.json resource
     */
    loadMap(path: string): void {

        this.assertAlive();
        this.mapLoadedFired_ = false;
        this.core_.loadMap(path);
    }

    /**
     * Unloads the currently loaded map. The `Map` instance stays
     * alive and a new map can be loaded afterwards.
     */
    unloadMap(): void {

        this.assertAlive();
        this.mapLoadedFired_ = false;
        this.disposeTerrainMaskPool();
        this.core_.destroyMap();
    }

    // -----------------------------------------------------------------
    // Events
    // -----------------------------------------------------------------

    /**
     * Subscribes to a named map event.
     *
     * @param eventName event to subscribe to
     * @param callback invoked each time the event fires
     * @returns unsubscribe function
     */
    on<K extends keyof ViewerEventMap & string>(
        eventName: K,
        callback: (event: ViewerEventMap[K]) => void,
    ): (() => void) {

        this.assertAlive();
        return this.bus_.on(eventName, callback);
    }

    /**
     * Subscribes to a named map event for a single invocation.
     *
     * @param eventName event to subscribe to
     * @param callback invoked once when the event fires
     * @returns unsubscribe function
     */
    once<K extends keyof ViewerEventMap & string>(
        eventName: K,
        callback: (event: ViewerEventMap[K]) => void,
    ): (() => void) {

        this.assertAlive();
        return this.bus_.once(eventName, callback);
    }

    /**
     * Fires a named map event to all subscribed listeners.
     *
     * @internal Emission is reserved for the library; applications
     *   only subscribe.
     * @param eventName event to fire
     * @param event payload passed to each listener
     */
    emit<K extends keyof ViewerEventMap & string>(
        eventName: K,
        event: ViewerEventMap[K],
    ): void {

        this.bus_.emit(eventName, event);
    }

    // -----------------------------------------------------------------
    // Rendering controls
    // -----------------------------------------------------------------

    /**
     * Sets the renderer feature flags (labels, atmosphere, shading).
     *
     * @param options rendering feature flags
     */
    setRenderingOptions(options: Renderer.RenderingOptions): void {

        this.assertAlive();
        this.core_.renderer.setRenderingOptions(options);
    }

    /** Returns the current renderer feature flags. */
    getRenderingOptions(): Renderer.RenderingOptions | null {

        this.assertAlive();
        return this.core_.renderer.getRenderingOptions();
    }

    /**
     * Sets the renderer illumination definition.
     *
     * @param spec illumination definition
     */
    setIllumination(spec: Renderer.IlluminationDef): void {

        this.assertAlive();
        this.core_.renderer.setIllumination(spec);
    }

    /** Returns the current renderer illumination definition. */
    getIllumination(): Renderer.IlluminationDef | null {

        this.assertAlive();
        return this.core_.renderer.getIllumination();
    }

    /**
     * Sets the vertical exaggeration ramps used by the renderer.
     *
     * @param spec vertical exaggeration ramp specification
     */
    setVerticalExaggeration(
        spec: Renderer.VerticalExaggerationSpec,
    ): void {

        this.assertAlive();
        this.core_.renderer.setVerticalExaggeration(spec);
    }

    /** Returns the current vertical exaggeration ramps. */
    getVerticalExaggeration(): Renderer.VerticalExaggerationSpec | null {

        this.assertAlive();
        return this.core_.renderer.getVerticalExaggeration();
    }

    /**
     * Sets live atmosphere parameters on the loaded map.
     *
     * @param spec atmosphere runtime parameters
     */
    setAtmosphere(spec: Atmosphere.RuntimeParameters): void {

        this.assertAlive();
        this.core_.map?.atmosphere?.setRuntimeParameters(spec);
    }

    /** Returns live atmosphere parameters from the loaded map. */
    getAtmosphere(): Atmosphere.RuntimeParameters | null {

        this.assertAlive();
        return this.core_.map?.atmosphere?.getRuntimeParameters() ?? null;
    }

    /**
     * Switches to a named legacy mapConfig view, or to a supplied view
     * definition. Only valid for mapConfig-initialized maps.
     *
     * @param view named view id or legacy view definition
     * @returns this map
     */
    setView(view: string | Record<string, unknown>): this {

        this.assertAlive();
        const legacyMap = this.core_.map;
        if (!legacyMap) {
            throw new Error('No map is loaded.');
        }

        legacyMap.setView(view);
        return this;
    }

    /**
     * Returns the current legacy mapConfig view definition, or `null`
     * when no map is loaded.
     */
    getView(): Record<string, unknown> | null {

        this.assertAlive();
        const view = this.core_.map?.getView();
        return view ? view as Record<string, unknown> : null;
    }

    /**
     * Returns the named legacy mapConfig view ids available on the
     * loaded map.
     */
    getNamedViews(): string[] {

        this.assertAlive();
        return this.core_.map?.getNamedViews() ?? [];
    }

    // -----------------------------------------------------------------
    // Coordinate conversion and hit-testing
    // -----------------------------------------------------------------

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

        this.assertAlive();
        return this.core_.map?.convertCoordsFromPublicToNav(
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

        this.assertAlive();
        return this.core_.map?.convertCoordsFromNavToCanvas(
            pos, mode, lod) ?? null;
    }

    /**
     * Converts navigation coordinates to public (lon/lat/height)
     * coordinates.
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

        this.assertAlive();
        return this.core_.map?.convertCoordsFromNavToPublic(
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

        this.assertAlive();
        return this.core_.map?.convertCoordsFromNavToPhys(
            pos, mode, lod, includeSE) ?? null;
    }

    /**
     * Converts physical (ECEF) coordinates to camera space.
     *
     * @param pos `[x, y, z]` in physical space
     */
    convertCoordsFromPhysToCameraSpace(pos: vec3): vec3 | null {

        this.assertAlive();
        return this.core_.map?.convertCoordsFromPhysToCameraSpace(pos) ?? null;
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

        this.assertAlive();
        return this.core_.map?.getHitCoords(
            screenX, screenY, mode, lod) ?? null;
    }

    /**
     * Returns terrain distance at a 2D position in the current screen
     * view.
     *
     * @param screenX horizontal coordinate in the selected space
     * @param screenY vertical coordinate in the selected space
     * @param dilate depth-map dilation radius in hitmap pixels
     * @param useGeometricIntersection compute a geometric ray
     *   intersection instead of sampling the depth hitmap. Geocentric
     *   maps intersect the ellipsoid; projected maps intersect the
     *   base plane.
     * @param coordinateSpace coordinate space of `screenX` / `screenY`
     * @returns `[hit, distance]`, or null when the map is not ready.
     *   `distance` is the Euclidean distance from the viewer to the
     *   terrain surface at the selected position. When `hit` is false,
     *   no terrain covers the position and `distance` is a sentinel
     *   value.
     */
    getScreenDepth(
        screenX: number,
        screenY: number,
        dilate = 0,
        useGeometricIntersection = false,
        coordinateSpace: Renderer.CoordinateSpace = 'layout',
    ): [boolean, number] | null {

        this.assertAlive();
        return this.core_.map?.getScreenDepth(
            screenX,
            screenY,
            dilate,
            useGeometricIntersection,
            coordinateSpace,
        ) ?? null;
    }

    // -----------------------------------------------------------------
    // Position accessors (internal, not promoted to Viewer)
    // -----------------------------------------------------------------

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
        return this.freeze
            ? (this.freeze.getNavigationPosition() ?? legacyMap.position)
            : legacyMap.position;
    }

    /**
     * Returns the selection position — the position driving terrain
     * selection (culling, texel-size choice, depth sampling). In
     * freeze mode this is the frozen view; outside freeze mode it
     * equals `getNavigationPosition()`. Returns `null` before the map
     * is loaded.
     *
     * Internal: not promoted to `Viewer`.
     */
    getSelectionPosition(): MapPosition | null {

        const legacyMap = this.core_.map;
        if (legacyMap == null) return null;
        return this.freeze
            ? (this.freeze.getSelectionPosition() ?? legacyMap.position)
            : legacyMap.position;
    }

    // -----------------------------------------------------------------
    // Camera scope
    // -----------------------------------------------------------------

    /**
     * Runs `callback` with the live navigation camera installed.
     *
     * In freeze mode the selection context is frozen while navigation
     * moves. Call this for draw code that must render from the live
     * position while tile selection still uses the frozen position.
     * When freeze mode is inactive, calls `callback` with no swap.
     *
     * @param callback  code to run under the live camera
     * @returns the value returned by `callback`
     */
    withNavigationCamera<T>(callback: () => T): T {

        return this.freeze
            ? this.freeze.withNavigationCamera(callback)
            : callback();
    }

    /**
     * Runs `callback` with the frozen selection camera installed.
     *
     * Use for draw code that must operate in the selection context:
     * culling, texel-size choice, and depth sampling. When freeze mode
     * is inactive, calls `callback` with no swap.
     *
     * @param callback  code to run under the selection camera
     * @returns the value returned by `callback`
     */
    withSelectionCamera<T>(callback: () => T): T {

        return this.freeze
            ? this.freeze.withSelectionCamera(callback)
            : callback();
    }

    // -----------------------------------------------------------------
    // Geodata free layers
    // -----------------------------------------------------------------

    /**
     * Creates a legacy geodata builder for constructing vector free layers.
     *
     * Return type is `unknown` pending promotion of the full geodata
     * builder type surface.
     */
    createGeodata(): unknown {

        this.assertAlive();
        return this.core_.map?.createGeodata() ?? null;
    }

    /**
     * Adds a free layer to the map under the given id.
     *
     * @param id layer identifier
     * @param layer free-layer specification or existing legacy surface
     */
    addFreeLayer(id: string, layer: unknown): void {

        this.assertAlive();
        this.core_.map?.addFreeLayer(id, layer);
    }

    /**
     * Removes the free layer registered under the given id.
     *
     * @param id layer identifier
     */
    removeFreeLayer(id: string): void {

        this.assertAlive();
        this.core_.map?.removeFreeLayer(id);
    }

    // -----------------------------------------------------------------
    // Overlays
    // -----------------------------------------------------------------

    /**
     * Registers a custom overlay that runs as the explicit last step
     * of every canvas-target frame, after terrain, free layers, and
     * label / icon jobs have been drawn. Idempotent: a second call
     * with the same name is ignored.
     *
     * @param name unique overlay id
     * @param spec lifecycle callbacks; only `render` is required
     */
    addOverlay(name: string, spec: OverlaySpec): void {

        this.assertAlive();
        if (this.findOverlayIndex(name) !== -1) return;

        this.overlays_.push({
            name, spec, enabled: true, added: false,
        });
    }

    /**
     * Removes the overlay registered under `name` and fires its
     * `onRemove` callback if `onAdd` had run.
     */
    removeOverlay(name: string): void {

        this.assertAlive();
        const index = this.findOverlayIndex(name);
        if (index === -1) return;

        const entry = this.overlays_[index];
        this.overlays_.splice(index, 1);

        if (entry.added && entry.spec.onRemove)
            entry.spec.onRemove(this.overlayContext());
    }

    /**
     * Toggles whether the overlay's `render` callback runs each frame.
     * Does not fire `onAdd` or `onRemove`.
     */
    setOverlayEnabled(name: string, enabled: boolean): void {

        this.assertAlive();
        const index = this.findOverlayIndex(name);
        if (index === -1) return;

        this.overlays_[index].enabled = enabled;
    }

    // -----------------------------------------------------------------
    // Frame loop
    // -----------------------------------------------------------------

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

            this.bus_.emit('tick', {});
            return;
        }

        // First-load completion: fires once per map load.
        if (!this.mapLoadedFired_ && legacyMap.isReferenceFrameReady()) {

            legacyMap.srsReady = true;
            this.mapLoadedFired_ = true;
            this.bus_.emit('map-loaded',
                { browserOptions: legacyMap.browserOptions ?? {} });
            core.markReady_({ browserOptions: legacyMap.browserOptions });
        }

        // Reference frame still loading: only let the loader make
        // progress, emit `tick`, and bail out before opening a stats
        // frame. Mirrors the legacy `LegacyMap.update` not-ready
        // branch.
        if (!legacyMap.srsReady) {

            legacyMap.loader.update();
            this.bus_.emit('tick', {});
            return;
        }

        // Position-change events.
        const position = legacyMap.position;
        const lastPosition = legacyMap.lastPosition;
        if (!position.isSame(lastPosition)) {

            this.bus_.emit('map-position-changed', {
                'position': position.toArray(),
                'last-position': lastPosition.toArray(),
            });
        }

        const camera = legacyMap.camera;
        if (camera.lastTerrainHeight !== camera.terrainHeight) {

            this.bus_.emit('map-position-fixed-height-changed', {
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

        // fps clock starts
        legacyMap.stats.begin(dirty);
        legacyMap.tickBefore();

        // prepare and/or draw if dirty
        if (dirty) {

            if (legacyMap.dirty) {
                /* `mapRefreshCycles` always resolves to a number at
                 * runtime (Core ctor seeds it with 3); the cast is
                 * needed because the CoreConfig index signature
                 * widens reads to the full union. */
                legacyMap.dirtyCountdown =
                    (legacyMap.config.mapRefreshCycles ?? 3) as number;
            } else {
                legacyMap.dirtyCountdown--;
            }

            legacyMap.dirty = false;
            legacyMap.bestMeshTexelSize = 0;
            legacyMap.bestGeodataTexelSize = 0;

            // Time only the rendering (draw + overlays); the loader and
            // event work below is not part of the frame's GPU cost.
            const profiler = this.frameProfiler();
            profiler.setGpuEnabled(legacyMap.config.mapProfileGpu === true);

            profiler.beginFrame();

            // draw
            this.draw();

            // overlays
            this.runOverlays();

            profiler.endFrame();
            this.publishFrameProfile();

            /* Post-draw loader promotion: requests discovered during
             * traversal enter the loader the same frame instead of
             * waiting one extra animation frame. */
            legacyMap.loader.update();

            this.bus_.emit('map-update', {});
        }

        legacyMap.tickDeferredEvents();
        // fps clock stops
        legacyMap.stats.end(dirty);
        this.bus_.emit('tick', {});
    }

    /** The frame profiler, created on first use once the device exists. */
    private frameProfiler(): FrameProfiler {

        if (!this.frameProfiler_) {

            this.frameProfiler_ = new FrameProfiler(this.core_.renderer.gpu);
        }

        return this.frameProfiler_;
    }

    /**
     * Publish the profiler result to the inspector stats and (when
     * `mapExposeFpsToWindow` is set) to `window`. Throttled because each
     * result sorts the sample windows; medians move slowly so a few
     * updates per second suffice.
     */
    private publishFrameProfile(): void {

        if ((this.profileWrite_++ % 15) !== 0) return;

        const legacyMap = this.core_.map;
        if (!legacyMap) return;

        const profile = this.frameProfiler_!.result();
        legacyMap.stats.frameProfile = profile;

        if (legacyMap.config.mapExposeFpsToWindow
                && typeof window !== 'undefined') {

            const target = window as unknown as {
                __vtsFps?: number | null;
                __vtsPerf?: { frame?: FrameProfiler.Result };
            };

            target.__vtsFps = profile.limitFps;
            target.__vtsPerf = target.__vtsPerf ?? {};
            target.__vtsPerf.frame = profile;
        }
    }

    /**
     * Draws one frame against the current render target. Called from
     * `Map.tick` for the canvas frame and from `MapDraw.drawHitmap`
     * for the depth pass. The body relocates from the legacy
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

        // runtime atmosphere override falls back to the map
        // configuration.
        const atmosphereEnabled = this.overrides.flagAtmosphere
            ?? legacyMap.config.mapFlagAtmosphere;

        // iOS color-manages decoded PNG pixels, which corrupts the
        // density texture encoding (it rendered as concentric rings).
        // The gray-png decoder returns the stored bytes verbatim;
        // suppress the atmosphere only where that decoder cannot run
        // (iOS before 16.4).
        const atmosphereSupported = !utils.isIos()
            || grayPngDecodeAvailable();

        // draw background (skydome)
        if (channel === 'color' && atmosphereEnabled && atmosphereSupported
            && legacyMap.atmosphere)
            renderer.drawBackground();

        // runtime label override falls back to the map configuration.
        const labelsEnabled = this.overrides.flagLabels
            ?? legacyMap.config.mapFlagLabels;

        // clear queued geodata jobs
        if (labelsEnabled
            && legacyMap.freeLayersHaveGeodata
            && channel === 'color') {

            renderer.draw.clearJobBuffer();
        }

        // draw surfaces and free layers
        gpu.setState(mapDraw.drawTileState);

        if (this.overrides.drawEarth) {

            this.withSelectionCamera(() => {

                // todo: remove this
                for (let i = 0; i < mapDraw.tileBuffer.length; i++) {
                    mapDraw.tileBuffer[i] = null;
                }

                // draw mesh tiles
                if (this.surfaceList().length > 0) {
                    this.drawTerrainRecursive();
                }

                // draw free layers
                const freeLayers = legacyMap.freeLayerSequence;
                for (let i = 0; i < freeLayers.length; i++) {

                    const layer = freeLayers[i];

                    if (!labelsEnabled) continue;

                    if (layer.ready && layer.tree
                        && layer.stylesheet
                        && layer.stylesheet.isReady()
                        && channel === 'color') {

                        if (layer.zFactor) {
                            mapDraw.zbufferOffset = layer.zFactor;
                        }

                        if (layer.type === 'geodata') {
                            // monolithic geodata job collection
                            mapDraw.drawMonoliticGeodata(layer);
                        } else {
                            // Tiled geodata only collects jobs; labels and
                            // icons are drawn after terrain.
                            layer.tree.draw();
                        }

                        mapDraw.zbufferOffset = null;
                    }
                }
            });

        } // if (this.overrides.drawEarth)

        // draw freeze frustum, if applicable
        const inspector = this.core_.inspector;
        if (channel === 'color'
                && inspector
                && inspector.hasFreezeFrustum()) {

            this.withNavigationCamera(() => {
                inspector.drawFreezeFrustum();
            });
        }

        // draw queued geodata labels and icons
        if (this.overrides.drawEarth
                && labelsEnabled
                && legacyMap.freeLayersHaveGeodata
                && channel === 'color') {

            renderer.drawnGeodataTiles =
                legacyMap.stats.drawnGeodataTilesPerLayer;
            renderer.drawnGeodataTilesFactor =
                legacyMap.stats.drawnGeodataTilesFactor;

            this.withNavigationCamera(() => {
                renderer.draw.drawGpuJobs(this.getSelectionPosition()!);
            });
        }

        // done
    }

    // -----------------------------------------------------------------
    // LegacyMap factories
    // -----------------------------------------------------------------

    private async createMapFromStyle(
        style: unknown,
        path: string,
    ): Promise<void> {

        const configStorage = (this.core_ as any).configStorage;
        const legacyMap = new LegacyMap(
            this.core_, path, this.core_.config, configStorage, this.bus_);
        legacyMap.outerMap = this;

        legacyMap.setLoaderParams(null, configStorage);

        // load style
        await MapStyle.loadStyle(legacyMap,
            style as MapStyle.StyleSpecification);

        // no clue what these are
        const conv = new MapConvert(legacyMap);
        legacyMap.convert = conv;
        const meas = new MapMeasure(legacyMap);
        legacyMap.measure = meas;
        conv.measure = meas;

        legacyMap.isGeocent =
            !legacyMap.getNavigationSrs().isProjected();

        // generate sequences
        legacyMap.refreshView();

        // force update
        legacyMap.dirty = true;
        legacyMap.hitMapDirty = true;
        legacyMap.geoHitMapDirty = true;

        legacyMap.draw = new MapDraw(legacyMap);
        this.freeze = new FreezeCameraState(legacyMap);
        legacyMap.draw.setupDetailDegradation();  // probably not needed

        this.core_.map = legacyMap;
    }

    private createMapFromMapConfig(
        mapConfig: unknown,
        path: string,
    ): void {

        const configStorage = (this.core_ as any).configStorage;
        const legacyMap = new LegacyMap(
            this.core_, path, this.core_.config, configStorage, this.bus_);
        legacyMap.outerMap = this;

        legacyMap.setLoaderParams(mapConfig, configStorage);

        // most of initialization happens here
        const mapCfg = new MapConfig(legacyMap, mapConfig);
        legacyMap.mapConfig = mapCfg;

        const conv = new MapConvert(legacyMap);
        legacyMap.convert = conv;
        const meas = new MapMeasure(legacyMap);
        legacyMap.measure = meas;
        conv.measure = meas;

        legacyMap.isGeocent =
            !legacyMap.getNavigationSrs().isProjected();

        legacyMap.currentView_ = new MapView(legacyMap, {});

        mapCfg.afterConfigParsed();

        legacyMap.updateCoutner = 0;

        legacyMap.dirty = true;
        legacyMap.dirtyCountdown = 0;
        legacyMap.hitMapDirty = true;
        legacyMap.geoHitMapDirty = true;

        legacyMap.draw = new MapDraw(legacyMap);
        this.freeze = new FreezeCameraState(legacyMap);
        legacyMap.draw.setupDetailDegradation();

        const body = legacyMap.referenceFrame?.body;
        const services = legacyMap.services;

        // atmosphere
        if (body && body.atmosphere && services && services.atmdensity) {

            legacyMap.atmosphere = new Atmosphere(
                body.atmosphere,
                legacyMap.getPhysicalSrs(),
                legacyMap.url.makeUrl(services.atmdensity.url, {}),
                legacyMap);
        }

        this.core_.map = legacyMap;
    }

    // -----------------------------------------------------------------
    // Private helpers
    // -----------------------------------------------------------------

    /** Throws if the map has been disposed. */
    private assertAlive(): void {

        if (this.disposed_) {
            throw new Error('Map has been destroyed.');
        }
    }

    /** Resets map-owned per-frame state. Called at the top of `draw`. */
    private initFrame(): void {

        const legacyMap = this.core_.map!;

        if (this.drawChannel !== 'depth') {

            legacyMap.visibleCredits = {
                imagery: {}, mapdata: {},
            };
        }

        legacyMap.loader.setChannel(0); // 0 = hires channel
        legacyMap.stats.renderBuild = 0;
    }

    private findOverlayIndex(name: string): number {

        for (let i = 0; i < this.overlays_.length; i++) {

            if (this.overlays_[i].name === name) return i;
        }
        return -1;
    }

    private overlayContext(): OverlayContext {

        return { renderer: this.core_.renderer };
    }

    /**
     * Runs every registered overlay's `render` callback. Called as the
     * explicit last step of the canvas-target frame; must not be
     * called for any auxiliary pass.
     */
    private runOverlays(): void {

        if (this.overlays_.length === 0) return;

        const ctx = this.overlayContext();

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
    private disposeOverlays(): void {

        const ctx = this.overlayContext();
        for (let i = this.overlays_.length - 1; i >= 0; i--) {

            const entry = this.overlays_[i];
            if (entry.added && entry.spec.onRemove)
                entry.spec.onRemove(ctx);
        }
        this.overlays_.length = 0;
    }

    /**
     * Releases the recursive terrain traversal mask pool. Safe to call
     * when no pool has been allocated. Invoked on map unload and from
     * `[Symbol.dispose]()`; the renderer's GL context stays alive
     * across unloads, so the pool's textures are valid to release.
     */
    private disposeTerrainMaskPool(): void {

        if (!this.terrainMaskPool_) return;

        this.terrainMaskPool_.dispose();
        this.terrainMaskPool_ = null;
    }

    /**
     * Recursive terrain draw — the only surface traversal path. Feeds
     * the combined-descent traversal in `draw-traversal.ts` with the
     * current `surfaceList()` and the cached per-surface helper trees.
     * Glues and virtual surfaces are excluded — see
     * `rfc-draw-traversal.md` §7.
     */
    private drawTerrainRecursive(): void {

        const resolution = resolveMaskResolution(
            this.core_.map?.config.mapTraversalMaskResolution);

        if (this.terrainMaskPool_
                && this.terrainMaskPool_.resolution !== resolution) {

            // Config changed at runtime; rebuild for the new size.
            this.terrainMaskPool_.dispose();
            this.terrainMaskPool_ = null;
        }

        if (!this.terrainMaskPool_) {
            this.terrainMaskPool_ = new DrawTraversalMaskPool(
                this.core_.renderer, resolution);
        }

        const trees = this.resolveSurfaceTrees();
        if (trees.length === 0) return;

        drawTerrainTraversal(this, trees, this.terrainMaskPool_!);
    }

    /**
     * Returns the per-surface helper trees the recursive draw
     * traversal will descend this frame, in `surfaceList()` order.
     * Allocates the trees on demand and drops stale cache entries.
     *
     * Intended for terrain queries such as
     * `MapMeasure.getSurfaceHeight`: they should iterate this list
     * front-to-back (last index first) and return the first tree whose
     * trace yields data.
     *
     * Returns an empty array when the recursive path is not active or
     * when no surface is in view.
     */
    surfaceTreesForQuery(): MapSurfaceTree[] {
        return this.resolveSurfaceTrees();
    }

    /**
     * Returns the surfaces the recursive draw traversal should render,
     * in back-to-front order (front surface at the last index). Plain
     * surfaces only — glues and virtual surfaces are skipped.
     *
     * For map-config maps the stack order is fixed by the top-level
     * `surfaces` array; the active view's `surfaces` is a dictionary and
     * carries no order (a vts-vtsd legacy where glue stitching enforced
     * a single server-side order, so views could never reorder). We
     * therefore walk `surfaces` in array order and keep those the active
     * view selects. For style-based maps the order comes from the style
     * spec's terrain sources array.
     */
    surfaceList(): MapSurface[] {

        const legacyMap = this.core_.map;
        if (!legacyMap) return [];

        let surfaces: MapSurface[];

        if (legacyMap.style) {

            // terrain.sources order: back-to-front, front at last index
            const sources = legacyMap.style.style().terrain?.sources
                ?? [];

            surfaces = sources.map(sourceId => {

                const surface = legacyMap.surfaces.find(
                    s => s.styleSourceId === sourceId);

                if (!surface) {
                    throw new Error(`terrain.sources references `
                        + `"${sourceId}" but no surface was loaded `
                        + `for that source`);
                }

                return surface;
            });

        } else {

            // Map-config maps: the canonical `surfaces` array fixes the
            // stack order; the view's `surfaces` dictionary only selects
            // which of them are active (its key order is meaningless).
            const view = legacyMap.getCurrentView();
            const selected = view.surfaces ?? {};

            surfaces = legacyMap.surfaces.filter(
                (s: MapSurface) => s.id in selected);
        }

        return surfaces;
    }

    /**
     * Resolves `surfaceList()` to per-surface helper trees, allocating
     * new ones on demand and dropping cache entries whose surface has
     * left the view. Returns the trees in `surfaceList()` order.
     */
    private resolveSurfaceTrees(): MapSurfaceTree[] {

        const legacyMap = this.core_.map;
        if (!legacyMap) return [];

        const cache = this.surfaceTrees_;
        const surfaces = this.surfaceList();
        const result: MapSurfaceTree[] = [];
        const live = new Set<string>();

        for (const surface of surfaces) {

            const id = surface.id;
            live.add(id);

            let surfaceTree = cache.get(id);
            if (!surfaceTree) {

                // Construct a single-surface tree by passing the
                // surface as `freeLayerSurface`; every tile then binds
                // directly to that surface, giving the tree direct,
                // per-surface metatile lookups.
                surfaceTree = new MapSurfaceTree(legacyMap, true, surface);
                cache.set(id, surfaceTree);
            }

            result.push(surfaceTree);
        }

        // Drop helper trees for surfaces that are no longer in view.
        for (const id of cache.keys()) {

            if (!live.has(id)) {

                cache.get(id)!.surfaceTree?.kill();
                cache.delete(id);
            }
        }

        return result;
    }

    // -----------------------------------------------------------------
    // Migration shim
    // -----------------------------------------------------------------

    /**
     * Migration shim exposing legacy JS internals to code that has
     * not been promoted to the `Map` public surface yet.
     *
     * @internal
     * @deprecated Access internals through `Map` public methods
     *   instead. This getter goes away when `LegacyMap` is fully
     *   absorbed into `Map`.
     */
    get core(): Core {

        __DEV__ && utils.warnOnce(
            '[Map] .core is a migration shim and will be removed. '
            + 'Access internals through Map public methods instead.',
            1,
        );
        this.assertAlive();
        return this.core_;
    }

    /**
     * The underlying legacy map, or `null` before a map has loaded.
     *
     * @internal Internal browser infrastructure (inspector, control
     *   modes) still drives the full legacy map surface. Unlike `.core`,
     *   this does not warn, because these call sites are migration
     *   scaffolding rather than external consumers. Goes away with the
     *   legacy map.
     */
    get legacyMap(): LegacyMap | null {

        this.assertAlive();
        return this.core_.map;
    }
}


// Local non-exported types used by the class above.

type OverlayEntry = {
    name: string;
    spec: OverlaySpec;
    enabled: boolean;
    added: boolean;
};


/**
 * Resolves the configured mask resolution. The config setter enforces
 * power-of-two and bounds; this only guards startup-race / undefined.
 */
function resolveMaskResolution(value: CoreConfig[string]): number {

    return typeof value === 'number' ? value : 256;
}


/* Declaration merging: re-export public types under `Map.*`. Consumers
 * (`Viewer`, demos) should reference them as `Map.OverlaySpec`,
 * `Map.ViewerEventMap`, etc. rather than reaching into `core/types`.
 * Same-name namespace pattern is documented in AGENTS.md. */
namespace Map {

    export type CoreConfig = import('./types').CoreConfig;
    export type ViewerEventMap = import('./types').ViewerEventMap;
    export type HeightMode = import('./types').HeightMode;
    export type Lod = import('./types').Lod;
    export type OverlayContext = import('./types').OverlayContext;
    export type OverlaySpec = import('./types').OverlaySpec;
}


export default Map;
