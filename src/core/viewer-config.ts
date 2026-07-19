/*
 * viewer-config.ts - single-source catalogue of runtime config keys
 */

import type MapPosition from './map/position';
import type MapStyle from './map/style';
import type { PositionInput, TransformRequestCallback } from './types';
import * as utils from './utils/utils';


/**
 * Where a config key is visible (rfc1-config-store.md §4.5):
 *
 * - `runtime` — public through `Viewer.setParam` / `getParam` and
 *   the factory option bags; a change after construction takes
 *   effect.
 * - `construction` — public through the factory option bags only;
 *   read once at construction, at map or style load, or when the
 *   key's UI control is built.
 * - `structural` — command-like keys with dedicated methods or
 *   construction options (`style`, `position`, `transformRequest`);
 *   on neither public bag surface.
 * - `internal` — tuning and diagnostics reachable through URL
 *   parameters and legacy ingestion, not through the typed public
 *   surfaces.
 * - `debug` — inspector switches reachable through URL parameters.
 */
export type ConfigKeyVisibility =
    'runtime' | 'construction' | 'structural' | 'internal' | 'debug';


/**
 * How the URL layer turns a query-string value into the raw value
 * handed to normalization. `none` keeps the string untouched
 * (`position` has a dedicated parser in `url-config.ts`).
 */
export type UrlParseKind =
    'boolean' | 'number' | 'numberArray' | 'position' | 'string'
    | 'none';


/**
 * One catalogue entry: everything the system knows about a config
 * key. `produce` returns the default — a fresh allocation for
 * array values, an environment read for the environment-dependent
 * keys — and doubles as the invalid-input fallback inside
 * `normalize`, so the default and the fallback cannot diverge.
 */
interface ConfigSpec<T, V extends ConfigKeyVisibility
    = ConfigKeyVisibility> {

    readonly produce: () => T;
    readonly normalize: (value: unknown) => T;
    readonly urlKind: UrlParseKind;
    readonly visibility: V;
}


// --- environment-dependent defaults ------------------------------
//
// Pure reads of stable environment state, so a fallback produced
// during normalization equals the value selected when the store
// was constructed. Guarded so the unit build loads under node.

const browserLanguage = (): string => {

    if (typeof navigator === 'undefined') return 'en';

    return navigator.languages
        ? navigator.languages[0]
        : (navigator.language
            || (navigator as { userLanguage?: string }).userLanguage
            || 'en');
};

const metricUnits = (): boolean => {

    const lang = browserLanguage();
    return !(lang == 'en' || lang.indexOf('en-') == 0);
};

const asyncImageDecode = (): boolean =>
    typeof createImageBitmap !== 'undefined';


// --- value-level guards -------------------------------------------

const toStringOrNull = (value: unknown): string | null =>
    typeof value === 'string' ? value : null;

const toRecordOrNull = (
    value: unknown,
): Record<string, unknown> | null => {

    // plain objects only: reject arrays, class instances, DOM
    // objects, and similar values
    if (value === null || typeof value !== 'object') return null;

    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null
        ? value as Record<string, unknown> : null;
};

const toStringOrRecord = (
    value: unknown,
): string | Record<string, unknown> | null =>
    typeof value === 'string' ? value : toRecordOrNull(value);

const toDebugValue = (value: unknown): string | boolean | null =>
    typeof value === 'string' || typeof value === 'boolean'
        ? value : null;


// --- spec constructors --------------------------------------------
//
// Each constructor fixes a spec's value type, clamp bounds, and
// URL parse kind; the fallback for invalid input is always the
// catalogue default.

const MAX = Number.MAX_SAFE_INTEGER;

const bool = <V extends ConfigKeyVisibility>(
    dflt: boolean,
    visibility: V,
): ConfigSpec<boolean, V> => ({
    produce: () => dflt,
    normalize: (value) => utils.validateBool(value, dflt),
    urlKind: 'boolean',
    visibility,
});

const num = <V extends ConfigKeyVisibility>(
    min: number,
    max: number,
    dflt: number,
    visibility: V,
): ConfigSpec<number, V> => ({
    produce: () => dflt,
    normalize: (value) => utils.validateNumber(value, min, max, dflt),
    urlKind: 'number',
    visibility,
});

const str = <V extends ConfigKeyVisibility>(
    dflt: string,
    visibility: V,
): ConfigSpec<string, V> => ({
    produce: () => dflt,
    normalize: (value) => utils.validateString(value, dflt),
    urlKind: 'string',
    visibility,
});

const strOrNull = <V extends ConfigKeyVisibility>(
    visibility: V,
): ConfigSpec<string | null, V> => ({
    produce: () => null,
    normalize: toStringOrNull,
    urlKind: 'string',
    visibility,
});

const pair = <V extends ConfigKeyVisibility>(
    min: number[],
    max: number[],
    dflt: [number, number],
    visibility: V,
): ConfigSpec<[number, number], V> => ({
    produce: () => [dflt[0], dflt[1]],
    normalize: (value) => utils.validateNumberArray(
        value, 2, min, max, [dflt[0], dflt[1]]) as [number, number],
    urlKind: 'numberArray',
    visibility,
});

const triple = <V extends ConfigKeyVisibility>(
    min: number[],
    max: number[],
    dflt: [number, number, number],
    visibility: V,
): ConfigSpec<[number, number, number], V> => ({
    produce: () => [dflt[0], dflt[1], dflt[2]],
    normalize: (value) => utils.validateNumberArray(
        value, 3, min, max, [dflt[0], dflt[1], dflt[2]]) as
            [number, number, number],
    urlKind: 'numberArray',
    visibility,
});

const quad = <V extends ConfigKeyVisibility>(
    min: number[],
    max: number[],
    dflt: [number, number, number, number],
    visibility: V,
): ConfigSpec<[number, number, number, number], V> => ({
    produce: () => [dflt[0], dflt[1], dflt[2], dflt[3]],
    normalize: (value) => utils.validateNumberArray(
        value, 4, min, max, [dflt[0], dflt[1], dflt[2], dflt[3]]) as
            [number, number, number, number],
    urlKind: 'numberArray',
    visibility,
});

const numberArray = <V extends ConfigKeyVisibility>(
    dflt: number[],
    visibility: V,
): ConfigSpec<number[], V> => ({
    produce: () => [...dflt],
    normalize: (value) =>
        Array.isArray(value) && value.length > 0
            && value.every((element) => Number.isFinite(element))
                ? value as number[] : [...dflt],
    urlKind: 'numberArray',
    visibility,
});

const debug = (): ConfigSpec<string | boolean | null, 'debug'> => ({
    produce: () => null,
    normalize: toDebugValue,
    urlKind: 'string',
    visibility: 'debug',
});

// identity helper that keeps the literal visibility type of an
// inline (custom) spec
const spec = <T, V extends ConfigKeyVisibility>(
    entry: ConfigSpec<T, V>,
): ConfigSpec<T, V> => entry;


/**
 * The catalogue: one entry per config key, each carrying the key's
 * documentation, default, normalization, URL parse kind, and
 * visibility. Every other per-key artifact in this module derives
 * from this object; no key exists unless it is declared here
 * (rfc1-config-store.md §4.5).
 *
 * Values stored under these keys are already normalized. Watchers
 * and readers may treat them as valid. Two entries are stored with
 * shallow or no checks: `style` (object shape validated at style
 * load) and `mapSplitSpace` (unchecked legacy payload).
 */
const catalogue = {

    // --- UI controls and navigation (browser layer) ---

    /** Registers the map's mouse, touch, and keyboard handlers.
     *  With `false` the map renders but ignores input. */
    interactive: bool(true, 'construction'),

    /** Allows the left-drag pan gesture. */
    panAllowed: bool(true, 'runtime'),

    /** Allows the rotation gestures (right or middle drag,
     *  two-finger pan). */
    rotationAllowed: bool(true, 'runtime'),

    /** Allows wheel and pinch zoom. */
    zoomAllowed: bool(true, 'runtime'),

    /** Allows the double-click jump to the clicked point. */
    jumpAllowed: bool(false, 'runtime'),

    /** Gesture speed factors: `[0]` mouse pan, `[1]` rotation,
     *  `[2]` wheel-zoom step. */
    sensitivity: triple(
        [0, 0, 0], [10, 10, 10], [1, 0.06, 0.05], 'runtime'),

    /** Per-frame motion decay after a gesture ends: `[0]` pan,
     *  `[1]` rotation, `[2]` zoom. Higher values glide longer. */
    inertia: triple(
        [0, 0, 0], [0.99, 0.99, 0.99], [0.81, 0.9, 0.7], 'runtime'),

    /** Scales inertia decay by frame time, making the glide
     *  frame-rate independent. */
    timeNormalizedInertia: bool(false, 'internal'),

    /** Applies motion deltas immediately during the gesture (the
     *  legacy behavior) instead of on the frame tick. */
    legacyInertia: bool(false, 'internal'),

    /** Keeps the current position in the page URL as the camera
     *  moves. */
    positionInUrl: bool(false, 'runtime'),

    /** Enables the camera constraint that clamps tilt (and reduces
     *  floating height) at large view extents. */
    constrainCamera: bool(true, 'runtime'),

    /** Camera heading behavior: `azimuthal` keeps north up while
     *  panning, `free` leaves the heading unconstrained
     *  (`azimuthal2` is the transient state the observer and the
     *  compass control switch through). */
    navigationMode: str('azimuthal', 'runtime'),

    /** Shows the compass control. */
    controlCompass: bool(true, 'runtime'),

    /** Shows the zoom control. */
    controlZoom: bool(true, 'runtime'),

    /** Shows the space (vertical-exaggeration) control. */
    controlSpace: bool(true, 'runtime'),

    /** Shows the search control. */
    controlSearch: bool(true, 'runtime'),

    /** SRS override for search-result coordinates; `null` uses the
     *  control's built-in SRS. */
    controlSearchSrs: strOrNull('runtime'),

    /** Search endpoint URL template; with `null` the built-in
     *  template is used and search stays enabled only for the
     *  melown2015 reference frame. */
    controlSearchUrl: strOrNull('runtime'),

    /** Filters search results by the control's relevance rules. */
    controlSearchFilter: bool(false, 'runtime'),

    /** External element (or its id) that hosts the search input
     *  instead of the built-in one. */
    controlSearchElement: spec({
        produce: (): string | HTMLElement | null => null,
        normalize: (value) => {

            if (typeof value === 'string') return value;
            if (typeof HTMLElement !== 'undefined'
                    && value instanceof HTMLElement)
                return value;
            return null;
        },
        urlKind: 'string',
        visibility: 'construction',
    }),

    /** Initial text placed in the search input. */
    controlSearchValue: strOrNull('construction'),

    /** Shows the measure control. */
    controlMeasure: bool(false, 'runtime'),

    /** Shows the lite measure control. */
    controlMeasureLite: bool(false, 'construction'),

    /** Shows the link (share URL) control. */
    controlLink: bool(false, 'runtime'),

    /** Shows the scale control. */
    controlScale: bool(true, 'runtime'),

    /** Shows the layers control. */
    controlLayers: bool(false, 'runtime'),

    /** Shows the credits control. */
    controlCredits: bool(true, 'runtime'),

    /** Shows the fullscreen control. */
    controlFullscreen: bool(false, 'runtime'),

    /** Shows the loading screen while the map loads. */
    controlLoading: bool(true, 'construction'),

    /** Shows the logo control. The control itself is currently not
     *  constructed (`ui.js`), so the flag has no visible effect. */
    controlLogo: bool(false, 'runtime'),

    /** Switches the observer's height handling to walk mode:
     *  height follows the terrain while panning. */
    walkMode: bool(false, 'runtime'),

    /** When nonzero, forces this fixed camera height on every
     *  observed position. */
    fixedHeight: num(-MAX, MAX, 0, 'runtime'),

    /** `[min, max]` band of the horizon-visibility factor within
     *  which the maximum camera tilt interpolates from -20° down
     *  to -90°. */
    tiltConstrainThreshold: pair(
        [0.5, 1], [Infinity, Infinity], [0.5, 1], 'runtime'),

    /** Enlarged control margins for big-screen layouts, applied
     *  when a control's visibility next changes. */
    bigScreenMargins: bool(false, 'construction'),

    /** Smallest view extent the navigation allows, in meters. */
    minViewExtent: num(0.01, MAX, 20, 'runtime'),

    /** Largest view extent the navigation allows, in meters. */
    maxViewExtent: num(0.01, MAX, MAX, 'runtime'),

    /** Autopilot rotation speed; `0` stops the rotation. */
    autoRotate: num(-Infinity, Infinity, 0, 'runtime'),

    /** Autopilot pan `[speed, azimuth]`; the azimuth clamps to
     *  ±360°. `[0, 0]` stops the pan. */
    autoPan: spec({
        produce: (): [number, number] => [0, 0],
        normalize: (value): [number, number] => {

            if (Array.isArray(value) && value.length == 2) {

                return [
                    utils.validateNumber(
                        value[0], -Infinity, Infinity, 0),
                    utils.validateNumber(value[1], -360, 360, 0),
                ];
            }
            return [0, 0];
        },
        urlKind: 'numberArray',
        visibility: 'runtime',
    }),

    // --- Cross-cutting (map loading and shared services) ---

    /** Style to load: a style URL string or an inline
     *  specification object. Normalized to a string or plain
     *  object only; the object's spec shape is validated at style
     *  load, not here. */
    style: spec({
        produce: ():
            string | MapStyle.StyleSpecification | null => null,
        normalize: (value) => toStringOrRecord(value) as
            string | MapStyle.StyleSpecification | null,
        urlKind: 'string',
        visibility: 'structural',
    }),

    /** Initial position: a legacy position array (mode strings and
     *  finite numbers) or a `MapPosition` instance. */
    position: spec({
        produce: (): PositionInput | null => null,
        normalize: (value) => {

            // a legacy position array: mode strings and finite
            // numbers
            if (Array.isArray(value) && value.every((item) =>
                    typeof item === 'string' || Number.isFinite(item)))
                return value as (number | string)[];

            // a MapPosition instance, identified structurally so
            // this module stays free of runtime map imports
            if (value !== null && typeof value === 'object'
                    && !Array.isArray(value)
                    && typeof (value as MapPosition).toArray
                        === 'function')
                return value as MapPosition;

            return null;
        },
        urlKind: 'position',
        visibility: 'structural',
    }),

    /** Request hook invoked before each resource fetch; may
     *  rewrite the URL and add headers or credentials (see
     *  `request-transform.md`). */
    transformRequest: spec({
        produce: (): TransformRequestCallback | null => null,
        normalize: (value) => typeof value === 'function'
            ? value as TransformRequestCallback : null,
        urlKind: 'none',
        visibility: 'structural',
    }),

    /** Enables the built-in inspector: debug keyboard shortcuts
     *  and diagnostics overlays. */
    inspector: bool(true, 'internal'),

    // --- Renderer ---

    /** Construction-only: the GPU device reads the level once at
     *  renderer creation and bakes it into each texture's sampling
     *  parameters; a change takes effect when the renderer is
     *  recreated. */
    rendererAnisotropic: num(-1, 2048, 0, 'construction'),

    /** Construction-only: WebGL context creation flag. */
    rendererAntialiasing: bool(true, 'construction'),

    /** Construction-only: sets `preserveDrawingBuffer` at WebGL
     *  context creation. */
    rendererAllowScreenshots: bool(false, 'construction'),

    /** Live: read per frame by the scale computations. */
    rendererCssDpi: num(1, 1200, 96, 'runtime'),

    // --- Inspector diagnostics (URL parameters) ---

    /** Enables the inspector diagnostic mode. */
    debugMode: debug(),

    /** String of capital letters enabling tile bounding-box
     *  overlays (see `inspector/input.js`). */
    debugBBox: debug(),

    /** Draws label boxes. */
    debugLBox: debug(),

    /** Disables earth drawing. */
    debugNoEarth: debug(),

    /** Draws the label grid cells. */
    debugGridCells: debug(),

    /** Enables the radar diagnostic overlay. */
    debugRadar: debug(),

    // --- Map (map* keys) ---

    /** In-memory resource cache budget in megabytes. */
    mapCache: num(10, MAX, 1100, 'runtime'),

    /** GPU resource cache budget in megabytes. */
    mapGPUCache: num(10, MAX, 600, 'runtime'),

    /** Metatile cache budget in megabytes. */
    mapMetatileCache: num(10, MAX, 60, 'runtime'),

    /** Screen-space texel-size budget: tiles refine until the
     *  projected texel size fits this factor (see
     *  `lod-selection.md`). */
    mapTexelSizeFit: num(0.0001, MAX, 1.1, 'runtime'),

    /** Limits how many extra hires LOD levels the surface tree
     *  descends ahead of the optimal LOD. */
    mapMaxHiresLodLevels: num(0, MAX, 2, 'internal'),

    /** Concurrent resource downloads the loader runs. */
    mapDownloadThreads: num(1, MAX, 20, 'runtime'),

    /** Per-frame budget in milliseconds for building render
     *  resources; processing yields once exceeded. */
    mapMaxProcessingTime: num(1, MAX, 10, 'runtime'),

    /** Per-frame budget in milliseconds for geodata view
     *  processing. */
    mapMaxGeodataProcessingTime: num(1, MAX, 10, 'runtime'),

    /** Forces the mobile rendering profile. */
    mapMobileMode: bool(false, 'runtime'),

    /** Autodetects the mobile profile from the user agent when
     *  `mapMobileMode` is off. The key name carries the historic
     *  misspelling. */
    mapMobileModeAutodect: bool(true, 'internal'),

    /** In mobile mode, degrades detail and cache budgets by this
     *  power of two. */
    mapMobileDetailDegradation: num(0, MAX, 0, 'runtime'),

    /** Sampling density used when picking the terrain-height
     *  measurement LOD for a view extent. */
    mapNavSamplesPerViewExtent:
        num(0.00000000001, MAX, 4, 'internal'),

    /** Skips navtile sampling in height measurement; heights come
     *  from metanode data only. */
    mapIgnoreNavtiles: bool(false, 'internal'),

    /** Legacy hires-surface toggle; nothing reads it in the
     *  current tree. */
    mapAllowHires: bool(true, 'internal'),

    /** Legacy lowres-surface toggle; nothing reads it in the
     *  current tree. */
    mapAllowLowres: bool(true, 'internal'),

    /** Legacy smart-switching toggle; nothing reads it in the
     *  current tree. */
    mapAllowSmartSwitching: bool(true, 'internal'),

    /** Skips the per-tile geometric visibility test. Also driven
     *  by the `mapNoTextures` coupling. */
    mapDisableCulling: bool(false, 'internal'),

    /** Culls pre-v4 metatiles in the division-node SRS, the way
     *  v4+ metatiles always are culled. */
    mapPreciseCulling: bool(true, 'internal'),

    /** Blends measured terrain heights between LODs. */
    mapHeightLodBlend: bool(true, 'internal'),

    /** Blends measured terrain heights between neighbor nodes. */
    mapHeightNodeBlend: bool(true, 'internal'),

    /** Its only reader is commented out (`surface-tree.js`);
     *  currently no effect. */
    mapBasicTileSequence: bool(false, 'internal'),

    /** Uses the precise bounding-box visibility test for pre-v4
     *  metatiles on geocentric frames. */
    mapPreciseBBoxTest: bool(false, 'internal'),

    /** Uses the precise tile distance computation for pre-v4
     *  metatiles on geocentric frames. */
    mapPreciseDistanceTest: bool(false, 'internal'),

    /** Forces pre-v5 metatiles to parse as version 3. */
    mapForceMetatileV3: bool(false, 'internal'),

    /** Its only reader is commented out (`metanode.js`); currently
     *  no effect. */
    mapSmartNodeParsing: bool(true, 'internal'),

    /** Delay in milliseconds before a failed resource load is
     *  retried. */
    mapLoadErrorRetryTime: num(0, MAX, 3000, 'runtime'),

    /** Retry limit for failed resource loads. */
    mapLoadErrorMaxRetryCount: num(0, MAX, 3, 'runtime'),

    /** Margin applied in the renderer's tile-split test. */
    mapSplitMargin: num(-MAX, MAX, 0.0025, 'internal'),

    /** Side length in pixels of the traversal coverage-mask
     *  textures; must be a power of two. */
    mapTraversalMaskResolution: spec({
        produce: () => 256,
        normalize: (value) => {

            // Mask textures must be power-of-two; fall back to the
            // default when the supplied value would need silent
            // rounding.
            const resolution =
                utils.validateNumber(value, 16, 4096, 256);
            const isPowerOfTwo =
                (resolution & (resolution - 1)) === 0;
            return isPowerOfTwo ? resolution : 256;
        },
        urlKind: 'number',
        visibility: 'internal',
    }),

    /** Coverage fraction below which a tile's traversal mask
     *  counts as insufficient (see `rfc3-draw-traversal.md`). */
    mapTraversalMaskThreshold: num(0, 1, 0.5, 'internal'),

    /** Erosion strength applied to traversal masks before the
     *  coverage test. */
    mapTraversalMaskErosion: num(0, 1, 1, 'internal'),

    /** Cadence, in traversal passes, of the fallback-LOD refresh
     *  in the draw traversal. */
    mapFallbackCadence: num(1, MAX, 3, 'internal'),

    /** Brake on descending through geometry-less metanode chains:
     *  the allowed cell-span growth per structural step (see
     *  `rfc9-metadata-first-traversal.md`). */
    mapStructuralDescentBrake: num(0, 1, 0.25, 'internal'),

    /** Unchecked legacy payload (octant-splitting demo hook). */
    mapSplitSpace: spec({
        produce: (): unknown => null,
        normalize: (value) => value,
        urlKind: 'numberArray',
        visibility: 'internal',
    }),

    /** Fallback-grid rendering mode: `linear` (grid with glue
     *  stitching), `flat`, or `none`. */
    mapGridMode: str('linear', 'internal'),

    /** Nothing reads it in the current tree. */
    mapGridSurrogatez: bool(false, 'internal'),

    /** Nothing reads it in the current tree. */
    mapGridTextureLevel: num(-MAX, MAX, -1, 'internal'),

    /** Nothing reads it in the current tree. */
    mapGridTextureLayer: strOrNull('internal'),

    /** Loads tile images through XHR (enabling the fast header
     *  check) instead of plain `Image` elements. */
    mapXhrImageLoad: bool(true, 'internal'),

    /** Extra frames the map keeps drawing after the last dirty
     *  frame. */
    mapRefreshCycles: num(0, MAX, 3, 'internal'),

    /** Keeps the previous metanodes while a view switch loads,
     *  avoiding a blank frame. */
    mapSoftViewSwitch: bool(true, 'internal'),

    /** Applies hysteresis when resorting geodata draw jobs. */
    mapSortHysteresis: bool(true, 'internal'),

    /** Delay in milliseconds before the geodata job hysteresis
     *  resort applies. */
    mapHysteresisWait: num(0, MAX, 0, 'internal'),

    /** Runs the resource loader in a dedicated worker. */
    mapSeparateLoader: bool(true, 'internal'),

    /** Fetches geodata as binary instead of text. */
    mapGeodataBinaryLoad: bool(true, 'internal'),

    /** Batches loader worker messages into packed events. */
    mapPackLoaderEvents: bool(true, 'internal'),

    /** Parses meshes in the loader worker instead of the main
     *  thread. */
    mapParseMeshInWorker: bool(true, 'internal'),

    /** Forwarded to the workers with the loader flags; nothing
     *  reads it in the current tree. */
    mapPackGeodataEvents: bool(true, 'internal'),

    /** Its only reader is commented out (`subtexture.js`);
     *  currently no effect. */
    mapCheckTextureSize: bool(false, 'internal'),

    /** Nothing reads it in the current tree. */
    mapNormalizeOctantTexelSize: bool(true, 'internal'),

    /** Label stick parameters; slot `0` equal to `2` also makes
     *  the surface tree scan free-layer tile extents during
     *  feature collection (`renderer/draw.js`,
     *  `surface-tree.js`). */
    mapFeatureStickMode: pair(
        [0, 1], [Infinity, Infinity], [1, 1], 'internal'),

    /** Quantizes mesh vertices to 16-bit buffers. */
    map16bitMeshes: bool(true, 'internal'),

    /** Builds indexed mesh buffers where the submesh layout allows
     *  it. */
    mapIndexBuffers: bool(true, 'internal'),

    /** Decodes tile images asynchronously via `createImageBitmap`;
     *  forced off where the API is unavailable. */
    mapAsyncImageDecode: spec({
        produce: asyncImageDecode,
        normalize: (value) =>
            utils.validateBool(value, asyncImageDecode())
                && asyncImageDecode(),
        urlKind: 'boolean',
        visibility: 'internal',
    }),

    /** Nothing reads it in the current tree; the live label grid
     *  size comes from `mapFeaturesReduceParams[1]`
     *  (`renderer/gmap.js`). */
    mapFeatureGridCells: num(-MAX, MAX, 31, 'internal'),

    /** Sorts collected label features top-first; the geodata
     *  processor overwrites it per reduce mode. */
    mapFeaturesSortByTop: bool(false, 'internal'),

    /** Label-density reduce algorithm (`scr-count*`); the legacy
     *  names `auto`, `legacy`, `gridcells`, `singlepass`, and
     *  `margin` map onto their `scr-count*` equivalents. */
    mapFeaturesReduceMode: spec({
        produce: () => 'scr-count7',
        normalize: (value) => {

            let mode = utils.validateString(value, 'scr-count7');
            if (mode == 'auto') mode = 'scr-count2';
            if (mode == 'legacy') mode = 'scr-count2';
            if (mode == 'gridcells') mode = 'scr-count4';
            if (mode == 'singlepass') mode = 'scr-count5';
            if (mode == 'margin') mode = 'scr-count6';
            return mode;
        },
        urlKind: 'string',
        visibility: 'runtime',
    }),

    /** Parameters of the label-density reduce algorithm; slot
     *  meanings depend on `mapFeaturesReduceMode`, and the geodata
     *  processor pads missing slots with per-mode defaults. */
    mapFeaturesReduceParams:
        numberArray([0.05, 0.17, 11, 1, 1000], 'runtime'),

    /** Distance weighting in label reduction; the geodata
     *  processor derives it from `mapFeaturesReduceParams[2]`. */
    mapFeaturesReduceFactor: num(0, MAX, 1, 'internal'),

    /** Nonzero enables the label depth test; the geodata
     *  processor derives it from `mapFeaturesReduceParams[3]`. */
    mapFeaturesReduceFactor2: num(0, MAX, 1, 'internal'),

    /** Publishes the FPS counter to `window` (used by the
     *  regression test URLs). */
    mapExposeFpsToWindow: bool(false, 'internal'),

    /** Enables per-frame GPU profiling; the inspector toggles it
     *  while its stats panel is open. */
    mapProfileGpu: bool(false, 'internal'),

    /** Linear size in pixels of the depth (hit) map the renderer
     *  keeps for `getDepth` queries. */
    mapDMapSize: num(16, MAX, 512, 'internal'),

    /** Depth-map operating mode; governs `getDepth` behavior
     *  (`renderer.ts`). */
    mapDMapMode: num(1, MAX, 3, 'internal'),

    /** Minimum interval in milliseconds between depth-map
     *  copies. */
    mapDMapCopyIntervalMs: num(0, MAX, 1500, 'internal'),

    /** Dilation radius in pixels applied to depth-map hit
     *  tests. */
    mapDMapDilatePx: num(0, 8, 2, 'internal'),

    /** Coarsens tile LOD toward the horizon, controlled by
     *  `mapDegradeHorizonParams`. */
    mapDegradeHorizon: bool(false, 'runtime'),

    /** Horizon degrade parameters: `[0]` strength (scaled ×200
     *  into the degrade factor), `[1]` fade start and `[2]` fade
     *  end distances. */
    mapDegradeHorizonParams: quad(
        [0, 1, 1, 1],
        [Infinity, Infinity, Infinity, Infinity],
        [1, 1500, 97500, 3500], 'runtime'),

    /** Font file URL registered as the stylesheet's `#default`
     *  font. */
    mapDefaultFont: str(
        'https://cdn.tspl.re/libs/vtsjs/fonts/noto-extended/'
        + '1.0.0/noto.fnt', 'construction'),

    /** Legacy flag whose only effect is the coupling that also
     *  sets `mapDisableCulling`; nothing reads the flag itself. */
    mapNoTextures: bool(false, 'internal'),

    /** Disables normal-map render targets in the tile render
     *  rig. */
    mapNoNormalMaps: bool(false, 'internal'),

    /** Collapses the bump-layer stack into one normal map in the
     *  tile render rig (see `normal-encoding.md`). */
    mapCollapseBumps: bool(true, 'internal'),

    /** Metric (`true`) or imperial (`false`) units in label text;
     *  the default follows the browser language. */
    mapMetricUnits: spec({
        produce: metricUnits,
        normalize: (value) =>
            utils.validateBool(value, metricUnits()),
        urlKind: 'boolean',
        visibility: 'runtime',
    }),

    /** Label text language; the default follows the browser
     *  language. */
    mapLanguage: spec({
        produce: browserLanguage,
        normalize: (value) =>
            utils.validateString(value, browserLanguage()),
        urlKind: 'string',
        visibility: 'runtime',
    }),

    /** Consume-once override of the frame time fed to time-based
     *  animations; the renderer applies it and resets the key to
     *  `-1`. */
    mapForceFrameTime: num(-1, MAX, 0, 'internal'),

    /** Makes the geodata worker log stylesheet processing. */
    mapLogGeodataStyles: bool(true, 'internal'),

    /** Relaxes the renderer's label overlap margins. */
    mapBenevolentMargins: bool(false, 'internal'),

    /** Screen-edge margins in pixels kept free of labels. */
    mapLabelFreeMargins: quad(
        [0, 0, 0, 0],
        [Infinity, Infinity, Infinity, Infinity],
        [30, 30, 30, 30], 'runtime'),

    /** Lambertian shading term of the terrain lighting. */
    mapShadingLambertian: bool(true, 'runtime'),

    /** Slope-based shading term of the terrain lighting. */
    mapShadingSlope: bool(false, 'runtime'),

    /** Aspect-based shading term of the terrain lighting. */
    mapShadingAspect: bool(false, 'runtime'),

    /** Terrain lighting; a style draw flag can override it. */
    mapFlagLighting: bool(true, 'runtime'),

    /** Normal-map sampling; a style draw flag can override it. */
    mapFlagNormalMaps: bool(true, 'runtime'),

    /** Diffuse-map sampling; a style draw flag can override it. */
    mapFlagDiffuseMaps: bool(true, 'runtime'),

    /** Specular-map sampling; a style draw flag can override
     *  it. */
    mapFlagSpecularMaps: bool(true, 'runtime'),

    /** Bump-map sampling; a style draw flag can override it. */
    mapFlagBumpMaps: bool(true, 'runtime'),

    /** The atmosphere; a style draw flag can override it. */
    mapFlagAtmosphere: bool(true, 'runtime'),

    /** Shadows; a style draw flag can override it. */
    mapFlagShadows: bool(true, 'runtime'),

    /** Label rendering; a style draw flag can override it. */
    mapFlagLabels: bool(true, 'runtime'),
};


type Catalogue = typeof catalogue;

// iteration order of the derived key arrays follows the catalogue
const configKeys =
    Object.keys(catalogue) as readonly (keyof Catalogue)[];


/**
 * Every valid runtime configuration key and its normalized value
 * shape, derived from the catalogue. Doc comments on the catalogue
 * entries carry over to these properties.
 */
export type ViewerConfig = {
    -readonly [K in keyof Catalogue]:
        ReturnType<Catalogue[K]['produce']>;
};


/**
 * Builds the initial, fully populated `ViewerConfig` value set.
 *
 * A function rather than a constant for two reasons: three
 * defaults depend on the environment (`mapLanguage` and
 * `mapMetricUnits` on the browser language, `mapAsyncImageDecode`
 * on `createImageBitmap` availability), and array defaults are
 * produced fresh per call so no two stores share an allocation.
 */
export function defaultViewerConfig(): ViewerConfig {

    const defaults: Record<string, unknown> = {};

    for (const key of configKeys) {
        defaults[key] = catalogue[key].produce();
    }

    return defaults as ViewerConfig;
}


// visibility-filtered key subsets, at the type level ...

type KeysWithVisibility<V extends ConfigKeyVisibility> = {
    [K in keyof Catalogue]:
        Catalogue[K]['visibility'] extends V ? K : never;
}[keyof Catalogue];

// ... and at the runtime level

const keysWithVisibility = (
    ...visibilities: ConfigKeyVisibility[]
): readonly (keyof Catalogue)[] =>
    configKeys.filter((key) =>
        visibilities.indexOf(catalogue[key].visibility) !== -1);


/**
 * The public runtime configuration map: the subset of
 * `ViewerConfig` accepted and returned by `Viewer.setParam` and
 * `Viewer.getParam`. A key carries `runtime` visibility when it is
 * live — a change after construction takes effect, through a
 * watcher or a read of the store's value map at time of use — and
 * application-facing: interaction, UI controls, cartographic
 * appearance, units and language, or resource budgets.
 *
 * Deliberately absent: `construction` keys (read once at
 * construction, at load, or when their UI control is built),
 * `structural` command keys with dedicated methods (`style`,
 * `position`, `transformRequest`), `internal` tuning and
 * diagnostics, `debug` switches, and the `pos` / `rotate` / `pan`
 * aliases, which remain compatibility ingestion only.
 */
export type PublicRuntimeConfig =
    Pick<ViewerConfig, KeysWithVisibility<'runtime'>>;


/** The `runtime`-visibility keys of the catalogue. */
export const publicRuntimeConfigKeys =
    keysWithVisibility('runtime') as
        readonly KeysWithVisibility<'runtime'>[];


/**
 * The public construction configuration map: the typed shape of
 * the factory option bags (`MapOptions.options` and the
 * `browser()` config) — every `runtime` key plus the
 * `construction` keys.
 */
export type PublicConstructionConfig = Partial<Pick<ViewerConfig,
    KeysWithVisibility<'runtime' | 'construction'>>>;


/** The `runtime` and `construction` keys of the catalogue. */
export const publicConstructionConfigKeys =
    keysWithVisibility('runtime', 'construction') as
        readonly KeysWithVisibility<'runtime' | 'construction'>[];


/**
 * Throws when a factory option bag contains a key that is not in
 * the config catalogue (after alias resolution), so a JavaScript
 * typo in `map()` options fails loudly instead of disappearing.
 * Catalogued keys outside the typed factory surface pass: the
 * query-string vocabulary documented on `runtimeOptionsFromUrl`
 * flows through the factory at runtime.
 */
export function assertCataloguedConfigKeys(
    bag: Record<string, unknown>,
): void {

    for (const key of Object.keys(bag)) {

        if (canonicalConfigKey(key) === null) {

            throw new Error(
                `'${key}' is not a known configuration key.`);
        }
    }
}


// backs the runtime membership guard below
const publicRuntimeKeySet: ReadonlySet<string> =
    new Set(publicRuntimeConfigKeys);


/**
 * Returns whether `key` belongs to the public runtime subset of
 * `ViewerConfig`. The public accessors use this to reject unknown
 * or non-public keys from untyped callers.
 */
export function isPublicRuntimeConfigKey(
    key: string,
): key is keyof PublicRuntimeConfig {

    return publicRuntimeKeySet.has(key);
}


// own-property lookup: `in` would also find inherited
// Object.prototype names such as `toString` or `constructor`
const hasOwn = (dict: object, key: string): boolean =>
    Object.prototype.hasOwnProperty.call(dict, key);


const keyAliases: Record<string, keyof ViewerConfig> = {
    pos: 'position',
    rotate: 'autoRotate',
    pan: 'autoPan',
};


/**
 * Resolves a public config key to its canonical `ViewerConfig` key.
 *
 * Handles the legacy aliases (`pos` for `position`, `rotate` for
 * `autoRotate`, `pan` for `autoPan`) and returns `null` for keys
 * that are not catalogued, so untyped callers can be filtered at
 * runtime. Inherited object-property names (`toString`,
 * `constructor`, `__proto__`, ...) are not catalogued keys.
 */
export function canonicalConfigKey(
    key: string,
): keyof ViewerConfig | null {

    if (hasOwn(keyAliases, key)) return keyAliases[key];
    return hasOwn(catalogue, key)
        ? key as keyof ViewerConfig : null;
}


/**
 * Normalizes a raw authored value for one config key: type
 * coercion, range clamping, and JSON parsing. The returned value
 * satisfies the `ViewerConfig` type of the key and is safe to
 * write to the store; invalid input falls back to the key's
 * catalogue default (produced fresh for array values).
 */
export function normalizeConfigValue<K extends keyof ViewerConfig>(
    key: K,
    value: unknown,
): ViewerConfig[K] {

    return catalogue[key].normalize(value) as ViewerConfig[K];
}


/**
 * Builds the store patch for one public config key: alias
 * resolution, value normalization, and the coupled-key expansion
 * (`mapNoTextures` also drives `mapDisableCulling`).
 *
 * @returns the patch to pass to `ConfigStore.set`, or `null` when
 *   the key is not catalogued
 */
export function normalizeConfigPatch(
    key: string,
    value: unknown,
): Partial<ViewerConfig> | null {

    const canonical = canonicalConfigKey(key);
    if (!canonical) return null;

    const patch: Partial<ViewerConfig> = {
        [canonical]: normalizeConfigValue(canonical, value),
    };

    // legacy coupling: disabling textures also disables culling
    if (canonical === 'mapNoTextures')
        patch.mapDisableCulling = patch.mapNoTextures;

    return patch;
}


/**
 * Returns how the URL layer parses a query value for `key` (after
 * alias resolution), or `null` for keys that are not catalogued.
 */
export function urlParseKind(key: string): UrlParseKind | null {

    const canonical = canonicalConfigKey(key);
    return canonical === null ? null : catalogue[canonical].urlKind;
}


// the catalogue's key-name prefixes; `mapConfig` is exempt because
// the demo applications read that query parameter themselves
const CONFIG_KEY_PREFIXES = ['map', 'renderer', 'control', 'debug'];


/**
 * Returns whether an uncatalogued key looks like a config key — it
 * carries one of the catalogue's name prefixes. The permissive
 * ingestion boundaries use this to log dropped keys that are
 * probably misspellings while unrelated query-string or option-bag
 * entries stay silent.
 */
export function looksLikeConfigKey(key: string): boolean {

    if (key === 'mapConfig') return false;

    return CONFIG_KEY_PREFIXES.some(
        (prefix) => key.startsWith(prefix));
}
