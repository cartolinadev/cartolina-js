/*
 * mapconfig-to-style.ts - convert a legacy VTS mapConfig into a
 * Cartolina style plus construction values
 */

import type { MapStyle } from '../core/map/style';
import { validateAndNormalizeStyle } from '../core/map/style-schema';
import type { PositionInput } from '../core/types';
import * as utils from '../core/utils/utils';
import type Viewer from '../browser/viewer';
import * as viewerConfig from '../core/viewer-config';
import * as linker from './vts-stylesheet-linker';


/** A mapConfig URL, or the parsed aggregate document. */
export type MapConfigInput = string | Record<string, unknown>;

/**
 * A recovered conversion: a deterministic fallback produced a usable
 * result that may differ from the legacy rendering.
 */
export interface MapConfigConversionWarning {
    code: string;
    path: string;
    message: string;
    recovery: string;
}

/**
 * An informational diagnostic about an exact conversion, such as a
 * deterministic symbol rename or a dropped construct the current
 * client already ignores.
 */
export interface MapConfigConversionNote {
    code: string;
    path: string;
    message: string;
}

/**
 * The conversion result: the style plus the construction values a
 * mapConfig carries beside authored rendering state.
 */
export interface MapConfigConversion {

    style: MapStyle.StyleSpecification;

    /** Converted initial position for the `map()` factory. */
    position: PositionInput | null;

    /** Viewer construction defaults from `browserOptions`; caller
     *  configuration merges above them. */
    viewerOptions: viewerConfig.PublicConstructionConfig;

    /** Named views translated into plain visibility profiles. */
    profiles: Record<string, Viewer.VisibilityProfile>;

    warnings: MapConfigConversionWarning[];
    notes: MapConfigConversionNote[];
}

/**
 * The validated legacy view input accepted by `options.view`. Owned
 * by the converter; not part of the map or style API.
 */
export type MapConfigViewDefinition = {
    surfaces?: string[] | Record<string, unknown[]>;
    freeLayers?: string[] | Record<string, Record<string, unknown>>;
    options?: Record<string, unknown>;
};

export interface MapConfigToStyleOptions {

    /** Base URL for relative references of an object input. */
    baseUrl?: string;

    /** Overrides the mapConfig's initial view: a named-view id or a
     *  legacy view definition. */
    view?: string | MapConfigViewDefinition;

    /** Applied to conversion-time fetches; changes transport details
     *  only, never the logical URLs stored in the emitted style. */
    transformRequest?: utils.TransformRequestCallback;

    /** Promotes every recoverable warning to an error. */
    strict?: boolean;

    /** @internal Test seam replacing network fetches. */
    loadJson?: (
        url: string, kind: utils.RequestResourceType) => Promise<unknown>;
}


/**
 * Converts a legacy VTS mapConfig into a Cartolina style and the
 * construction values that travel beside it: initial position,
 * viewer options, and named views as visibility profiles.
 *
 * The function fetches referenced bound-layer and free-layer
 * definitions and the effective VTS stylesheets, reconciles their
 * symbols, and emits a fully normalized style: inline sources with
 * absolute embedded URLs. Fields and grammar forms outside the
 * conversion corpus produce structured diagnostics — warnings when
 * the current client reads them, notes when it ignores them — and no
 * new style or runtime representation.
 *
 * @param input mapConfig URL or parsed document
 * @param options conversion options
 * @returns the conversion result; rejects on fatal input problems,
 *   and in strict mode on any warning
 */
export async function mapConfigToStyle(
    input: MapConfigInput,
    options: MapConfigToStyleOptions = {},
): Promise<MapConfigConversion> {

    const context = await ConversionContext.create(input, options);
    const conversion = await context.convert();

    if (options.strict && conversion.warnings.length > 0) {

        const listed = conversion.warnings.map(
            (warning) => `[${warning.code}] ${warning.path}: `
                + `${warning.message}`).join('\n');

        throw new Error(
            `mapConfigToStyle: strict mode rejects `
            + `${conversion.warnings.length} warning(s):\n${listed}`);
    }

    return conversion;
}


// ---------------------------------------------------------------------------
// URL resolution (no DOM; templates like {lod}-{x}-{y} stay verbatim)
// ---------------------------------------------------------------------------

type UrlContext = {
    base: string;
    origin: string;
    schema: string;
} | null;

function urlContextOf(documentUrl: string): UrlContext {

    const url = new URL(documentUrl);
    const base = documentUrl
        .split('?')[0].split('#')[0].replace(/[^/]*$/, '');

    return { base, origin: url.origin, schema: url.protocol };
}

function isAbsoluteUrl(url: string): boolean {

    return /^[a-z][a-z0-9+.-]*:\/\//i.test(url);
}

/*
 * Resolves one URL against a document context using the legacy
 * prefix rules, keeping brace templates untouched. A relative URL
 * without a context is ambiguous and fatal: it must never resolve
 * against the current page.
 */
function resolveAgainst(
    context: UrlContext,
    url: string,
    path: string,
): string {

    if (isAbsoluteUrl(url)) return url;

    if (context === null) {

        throw new Error(`mapConfigToStyle: relative URL "${url}" at `
            + `${path} is ambiguous for an object input; pass `
            + `options.baseUrl.`);
    }

    if (url.startsWith('//')) return context.schema + url;
    if (url.startsWith('/')) return context.origin + url;
    return context.base + url;
}

/* Absolutizes the named string fields of a record in place. */
function absolutizeFields(
    record: Record<string, unknown>,
    fields: string[],
    context: UrlContext,
    path: string,
): void {

    for (const field of fields) {

        const value = record[field];
        if (typeof value !== 'string' || value === '') continue;
        record[field] = resolveAgainst(context, value, `${path}.${field}`);
    }
}


// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {

    return typeof value === 'object' && value !== null
        && !Array.isArray(value);
}

function canonicalJson(value: unknown): string {

    if (Array.isArray(value)) {
        return '[' + value.map(canonicalJson).join(',') + ']';
    }

    if (value !== null && typeof value === 'object') {

        const record = value as Record<string, unknown>;
        const keys = Object.keys(record).sort();

        return '{' + keys.map(
            (key) => JSON.stringify(key) + ':'
                + canonicalJson(record[key])).join(',') + '}';
    }

    return JSON.stringify(value) ?? 'undefined';
}

function fatal(message: string): never {

    throw new Error(`mapConfigToStyle: ${message}`);
}


/* Default document loader over the global fetch. */
async function defaultLoadJson(
    url: string,
    kind: utils.RequestResourceType,
    transformRequest: utils.TransformRequestCallback | undefined,
): Promise<unknown> {

    let requestUrl = url;
    const init: RequestInit = {};

    if (transformRequest) {

        const transformed = transformRequest(url, kind);

        if (transformed) {

            if (transformed.url) requestUrl = transformed.url;
            if (transformed.headers) init.headers = transformed.headers;
            if (transformed.credentials)
                init.credentials = transformed.credentials;
        }
    }

    const response = await fetch(requestUrl, init);

    if (!response.ok) {
        throw new Error(`${response.status} ${response.statusText} `
            + `for ${url}`);
    }

    return response.json();
}


// ---------------------------------------------------------------------------
// browserOptions classification
// ---------------------------------------------------------------------------

/*
 * Catalogued keys that nothing in the current client reads: applying
 * them stores a value no code consumes, so dropping them is an exact
 * no-op. Verified against the source when added here.
 */
const provenNoOpOptions = new Set(['mapGridTextureLayer']);

/*
 * Catalogued keys that gate console diagnostics only and cannot
 * affect rendering. Dropping them preserves the rendered map
 * exactly; the note names the consumer. Verified against the source
 * when added here.
 */
const diagnosticOnlyOptions: Record<string, string> = {

    // gates stylesheet-processing console logging in the geodata
    // worker (worker-style.js via processor.js)
    mapLogGeodataStyles: 'geodata-worker stylesheet logging',
};

const publicOptionKeys: ReadonlySet<string> =
    new Set(viewerConfig.publicConstructionConfigKeys);


// ---------------------------------------------------------------------------
// View normalization (the legacy array forms become dictionaries)
// ---------------------------------------------------------------------------

type NormalizedView = {
    surfaces: Record<string, unknown[]>;
    freeLayers: Record<string, Record<string, unknown>>;
    options: Record<string, unknown>;
};

function normalizeViewInput(raw: unknown): NormalizedView {

    const view = isRecord(raw) ? raw : {};

    const surfaces: Record<string, unknown[]> = {};
    const rawSurfaces = view['surfaces'];

    if (Array.isArray(rawSurfaces)) {

        for (const id of rawSurfaces)
            if (typeof id === 'string') surfaces[id] = [];

    } else if (isRecord(rawSurfaces)) {

        for (const [id, layers] of Object.entries(rawSurfaces))
            surfaces[id] = Array.isArray(layers) ? layers : [];
    }

    const freeLayers: Record<string, Record<string, unknown>> = {};
    const rawFreeLayers = view['freeLayers'];

    if (Array.isArray(rawFreeLayers)) {

        for (const id of rawFreeLayers)
            if (typeof id === 'string') freeLayers[id] = {};

    } else if (isRecord(rawFreeLayers)) {

        for (const [id, overrides] of Object.entries(rawFreeLayers))
            freeLayers[id] = isRecord(overrides) ? overrides : {};
    }

    return {
        surfaces,
        freeLayers,
        options: isRecord(view['options']) ? view['options'] : {},
    };
}


// ---------------------------------------------------------------------------
// Raster-entry translation (mirrors the retired legacy generator)
// ---------------------------------------------------------------------------

type RasterPresentation = {
    boundLayerId: string;
    spec: Record<string, unknown>;
};

/*
 * Translates one view raster entry (a bound-layer id string or a
 * parameter object) into the style-layer property set, without id,
 * source, or terrain. Unsupported parameter values are conversion
 * errors; keys the current client ignores produce notes.
 */
function convertRasterEntry(
    item: unknown,
    path: string,
    notes: MapConfigConversionNote[],
): RasterPresentation {

    if (typeof item === 'string') {

        return {
            boundLayerId: item,
            spec: {
                type: 'diffuse-map',
                blendMode: 'overlay',
                alpha: { mode: 'constant', value: 1.0 },
            },
        };
    }

    if (!isRecord(item)) fatal(`invalid raster entry at ${path}`);

    const id = item['id'];
    if (typeof id !== 'string') fatal(`missing raster id at ${path}`);

    // layer type
    const typeMap: Record<string, string> = {
        'diffuse': 'diffuse-map', 'diffuse-map': 'diffuse-map',
        'specular': 'specular-map', 'specular-map': 'specular-map',
        'bump': 'bump-map', 'bump-map': 'bump-map',
    };

    const rawType = item['type'] ?? 'diffuse-map';
    const type = typeMap[rawType as string];
    if (!type) fatal(`unsupported raster type "${rawType}" at ${path}`);

    const spec: Record<string, unknown> = { type };
    const optionsBag = isRecord(item['options']) ? item['options'] : item;

    if (type === 'diffuse-map') {

        // blend mode; the legacy "normal" spelling means overlay
        let mode = item['mode'] ?? 'overlay';
        if (mode === 'normal') mode = 'overlay';

        if (!['overlay', 'add', 'multiply'].includes(mode as string))
            fatal(`unsupported raster mode "${mode}" at ${path}`);

        spec['blendMode'] = mode;

        // alpha: number, or structured constant / view-dependent
        const alpha: Record<string, unknown> =
            { mode: 'constant', value: 1.0 };
        const rawAlpha = item['alpha'];

        if (typeof rawAlpha === 'number') alpha['value'] = rawAlpha;

        if (isRecord(rawAlpha)) {

            if (typeof rawAlpha['value'] === 'number')
                alpha['value'] = rawAlpha['value'];

            const alphaMode = rawAlpha['mode'];
            if (alphaMode !== undefined) {

                if (!['constant', 'viewdep', 'view-dependent']
                    .includes(alphaMode as string)) {
                    fatal(`unsupported alpha mode "${alphaMode}" `
                        + `at ${path}`);
                }

                if (alphaMode !== 'constant') alpha['mode'] = 'viewdep';
            }

            const illumination = rawAlpha['illumination'];
            if (illumination !== undefined) {

                if (!Array.isArray(illumination)
                    || illumination.length !== 2
                    || typeof illumination[0] !== 'number'
                    || typeof illumination[1] !== 'number') {
                    fatal(`invalid alpha illumination at ${path}`);
                }

                alpha['illumination'] =
                    [illumination[0], illumination[1]];
            }

            if (alpha['mode'] === 'viewdep'
                && alpha['illumination'] === undefined) {
                fatal(`view-dependent alpha without illumination `
                    + `at ${path}`);
            }
        }

        spec['alpha'] = alpha;

        const whitewash = optionsBag['whitewash'];
        spec['whitewash'] =
            typeof whitewash === 'number' ? whitewash : 0.0;

    } else {

        // specular and bump: overlay blend, plain numeric alpha
        spec['blendMode'] = 'overlay';

        const rawAlpha = item['alpha'];
        let alpha = 1.0;

        if (rawAlpha !== undefined) {

            if (typeof rawAlpha !== 'number')
                fatal(`non-numeric ${type} alpha at ${path}`);
            alpha = rawAlpha;
        }

        spec['alpha'] = alpha;
    }

    // every other entry key is ignored by the current client;
    // dropping it preserves rendering exactly
    const consumed = new Set(['id', 'type', 'mode', 'alpha', 'options',
        'whitewash']);

    const noteIgnored = (bag: Record<string, unknown>,
        bagPath: string, keep: Set<string>) => {

        for (const key of Object.keys(bag)) {

            if (keep.has(key)) continue;

            notes.push({
                code: 'ignored-field',
                path: `${bagPath}.${key}`,
                message: `The current client ignores raster entry `
                    + `key "${key}"; dropped with rendering `
                    + `unchanged.`,
            });
        }
    };

    noteIgnored(item, path, consumed);
    if (optionsBag !== item)
        noteIgnored(optionsBag, `${path}.options`, new Set(['whitewash']));

    return { boundLayerId: id, spec };
}


// ---------------------------------------------------------------------------
// Lettering rule classification
// ---------------------------------------------------------------------------

/*
 * Chooses the lettering discriminator for a linked rule: `lines` for
 * line-drawing properties, `labels` otherwise. A rule enabling both
 * line drawing and point or label drawing is mixed and unsupported.
 */
function classifyRule(
    rule: Record<string, unknown>,
): 'labels' | 'lines' | 'mixed' {

    let hasLine = false;
    let hasPoint = false;

    for (const key of Object.keys(rule)) {

        if (key === 'line' || key.startsWith('line-')) hasLine = true;

        if (['label', 'point', 'icon'].includes(key)
            || key.startsWith('label-')
            || key.startsWith('point-')
            || key.startsWith('icon-')) {

            hasPoint = true;
        }
    }

    if (hasLine && hasPoint) return 'mixed';
    return hasLine ? 'lines' : 'labels';
}


// ---------------------------------------------------------------------------
// The conversion pipeline
// ---------------------------------------------------------------------------

/* Ignored top-level mapConfig fields: nothing in the current client
 * reads them, so dropping non-empty content is an exact outcome with
 * a note. */
const ignoredTopLevelFields =
    ['glue', 'virtualSurfaces', 'rois', 'params', 'textureAtlasReady'];

/* Consumed top-level fields; anything else is unknown to the parser
 * and dropped with a note. */
const consumedTopLevelFields = new Set([
    'referenceFrame', 'srses', 'bodies', 'services', 'credits',
    'surfaces', 'boundLayers', 'freeLayers', 'stylesheets', 'view',
    'namedViews', 'position', 'browserOptions', 'version',
    ...ignoredTopLevelFields,
]);

/* One resolved VTS stylesheet for one free layer. One free layer can
 * yield several of these sharing one freeLayerKey, when it selects a
 * different stylesheet in different named views. */
type ResolvedVtsStylesheet = {
    freeLayerKey: string;
    sourceId: string;
    stylesheetUrl: string;
    viewIds: Set<string>;
    data: linker.VtsStylesheetData;
};

/* One view's raster-entry sequence on one surface: the ordering
 * constraint it contributes to the canonical layer order. The viewId
 * is null for the initial view. */
type ViewSequence = {
    viewId: string | null;
    path: string;
    keys: string[];
};

/* One raster presentation with its output id and terrain sets. */
type PresentationEntry = {
    id: string;
    sourceId: string;
    spec: Record<string, unknown>;

    /** Terrain source ids active in the initial view. */
    initialTerrain: Set<string>;

    /** Terrain source ids per named view id. */
    viewTerrain: Map<string, Set<string>>;

    /** First-seen order within the initial view, or -1. */
    initialOrder: number;
};

class ConversionContext {

    private doc!: Record<string, unknown>;
    private documentContext: UrlContext = null;
    private options!: MapConfigToStyleOptions;
    private loadJson!: (
        url: string, kind: utils.RequestResourceType) => Promise<unknown>;

    private warnings: MapConfigConversionWarning[] = [];
    private notes: MapConfigConversionNote[] = [];

    // legacy id -> style source id, per source kind
    private surfaceSourceIds = new Map<string, string>();
    private boundSourceIds = new Map<string, string>();
    private freeSourceIds = new Map<string, string>();
    private takenSourceIds = new Set<string>();

    private sources: Record<string, unknown> = {};

    // fetched free-layer definitions, keyed by free-layer key
    private freeLayerDefinitions =
        new Map<string, Record<string, unknown> | null>();

    static async create(
        input: MapConfigInput,
        options: MapConfigToStyleOptions,
    ): Promise<ConversionContext> {

        const context = new ConversionContext();
        context.options = options;
        context.loadJson = options.loadJson
            ?? ((url, kind) =>
                defaultLoadJson(url, kind, options.transformRequest));

        if (typeof input === 'string') {

            if (!isAbsoluteUrl(input) && !options.baseUrl) {
                fatal(`the mapConfig URL "${input}" is not absolute; `
                    + `pass an absolute URL or options.baseUrl.`);
            }

            const documentUrl = isAbsoluteUrl(input)
                ? input
                : resolveAgainst(
                    urlContextOf(options.baseUrl as string), input,
                    'input');

            context.documentContext = urlContextOf(documentUrl);

            const doc = await context.loadJson(documentUrl, 'MapConfig');
            if (!isRecord(doc)) fatal('the mapConfig is not an object.');
            context.doc = doc;

        } else {

            if (!isRecord(input)) fatal('the mapConfig is not an object.');
            context.doc = input;
            context.documentContext = options.baseUrl
                ? urlContextOf(options.baseUrl) : null;
        }

        return context;
    }

    async convert(): Promise<MapConfigConversion> {

        const doc = this.doc;

        // structural validation before any output is produced
        if (!isRecord(doc['referenceFrame']))
            fatal('missing referenceFrame.');
        if (!isRecord(doc['srses'])) fatal('missing srses.');

        const surfaces = doc['surfaces'];
        if (!Array.isArray(surfaces) || surfaces.length === 0)
            fatal('no usable terrain surface in surfaces.');

        this.allocateSourceIds();
        this.reportIgnoredTopLevel();

        this.convertSurfaces();
        await this.convertBoundLayers();
        await this.convertFreeLayers();

        // resolve the initial view and the named views
        const initialView = this.resolveInitialView();
        const namedViews = this.resolveNamedViews();

        // raster presentations and resolved stylesheets across all views
        const { presentations, sequences } =
            this.collectPresentations(initialView, namedViews);
        const orderedPresentations =
            this.orderPresentations(presentations, sequences);
        const stylesheets = await this.collectResolvedStylesheets(
            initialView, namedViews);

        // link resolved stylesheets into one symbol space, in
        // deterministic source-id then stylesheet order
        const ordered = [...stylesheets.values()].sort(
            (a, b) => a.sourceId === b.sourceId
                ? a.stylesheetUrl.localeCompare(b.stylesheetUrl)
                : a.sourceId.localeCompare(b.sourceId));

        // raster presentation ids are allocated before linking and
        // share the same explicit layer-id space as lettering rules.
        // The linker assigns and consumes its own symbol-qualification
        // identity internally; this caller pairs its emitted layers
        // back to `ordered` by input position, via
        // `linked.layerIdsByInput`.
        const linked = linker.linkStylesheets(
            ordered.map((stylesheet) => ({
                sourceId: stylesheet.sourceId,
                path: `freeLayers.${stylesheet.freeLayerKey}.style`,
                data: stylesheet.data,
            })),
            orderedPresentations.map((entry) => entry.id));

        this.notes.push(...linked.notes);
        this.warnings.push(...linked.warnings);

        // assemble the layers array
        const layers =
            this.assembleLayers(orderedPresentations, ordered, linked);

        // root style
        const style: Record<string, unknown> = {
            version: 2,
            sources: this.sources,
            terrain: {
                sources: this.terrainStackOf(initialView),
            },
            layers,
        };

        if (Object.keys(linked.constants).length > 0)
            style['constants'] = linked.constants;
        if (Object.keys(linked.fonts).length > 0)
            style['fonts'] = linked.fonts;
        if (Object.keys(linked.bitmaps).length > 0)
            style['bitmaps'] = linked.bitmaps;

        this.convertViewOptions(initialView, style);

        // atmosphere: the legacy runtime enabled the body's
        // atmosphere with its fixed visibility. The style loader
        // adds eye-distance-driven defaults on top of the body
        // values, so the explicit zeros disable the eye-distance
        // terms and the large cap neutralizes the clamp; the body's
        // own visibility then applies, matching the legacy render.
        style['atmosphere'] = {
            visibilityToEyeDistance: 0,
            edgeDistanceToEyeDistance: 0,
            maxVisibility: 1e12,
        };

        // named views become plain visibility profiles
        const profiles = this.buildProfiles(
            namedViews, orderedPresentations, ordered,
            linked.layerIdsByInput, layers);

        // construction values beside the style
        const position = Array.isArray(doc['position'])
            ? doc['position'] as (number | string)[]
            : null;

        const viewerOptions = this.convertBrowserOptions();

        // an invalid assembled style (a schema violation, or a
        // duplicate explicit layer id from a raster/lettering
        // collision) is fatal at conversion time, in both normal and
        // strict mode; the caller must not receive an unloadable style
        validateAndNormalizeStyle(
            style as unknown as MapStyle.StyleSpecification);

        return {
            style: style as unknown as MapStyle.StyleSpecification,
            position,
            viewerOptions,
            profiles,
            warnings: this.warnings,
            notes: this.notes,
        };
    }

    // -----------------------------------------------------------------
    // Source conversion
    // -----------------------------------------------------------------

    /* MapConfig ids become style source ids where unique; collisions
     * across the three id namespaces get deterministic data-type
     * prefixes. */
    private allocateSourceIds(): void {

        const allocate = (
            target: Map<string, string>,
            legacyId: string,
            prefix: string,
        ) => {

            let candidate = legacyId;
            if (this.takenSourceIds.has(candidate))
                candidate = `${prefix}-${legacyId}`;
            while (this.takenSourceIds.has(candidate)) candidate += '-x';

            this.takenSourceIds.add(candidate);
            target.set(legacyId, candidate);
        };

        for (const surface of this.doc['surfaces'] as unknown[]) {

            if (!isRecord(surface) || typeof surface['id'] !== 'string')
                fatal('surface without an id.');
            allocate(this.surfaceSourceIds, surface['id'], 'surface');
        }

        const boundLayers = this.doc['boundLayers'];
        if (isRecord(boundLayers))
            for (const key of Object.keys(boundLayers))
                allocate(this.boundSourceIds, key, 'tms');

        const freeLayers = this.doc['freeLayers'];
        if (isRecord(freeLayers))
            for (const key of Object.keys(freeLayers))
                allocate(this.freeSourceIds, key, 'freelayer');
    }

    /* Notes for ignored and unknown top-level fields. */
    private reportIgnoredTopLevel(): void {

        const nonEmpty = (value: unknown): boolean => {

            if (Array.isArray(value)) return value.length > 0;
            if (isRecord(value)) return Object.keys(value).length > 0;
            return value === true;
        };

        for (const field of ignoredTopLevelFields) {

            if (!nonEmpty(this.doc[field])) continue;

            this.notes.push({
                code: 'ignored-field',
                path: field,
                message: `The current client ignores "${field}"; `
                    + `dropped with rendering unchanged.`,
            });
        }

        for (const field of Object.keys(this.doc)) {

            if (consumedTopLevelFields.has(field)) continue;

            this.notes.push({
                code: 'ignored-field',
                path: field,
                message: `The current client ignores the unknown `
                    + `mapConfig field "${field}"; dropped with `
                    + `rendering unchanged.`,
            });
        }

        const stylesheets = this.doc['stylesheets'];
        if (nonEmpty(stylesheets)) {

            this.warnings.push({
                code: 'unsupported-field',
                path: 'stylesheets',
                message: `Top-level mapConfig stylesheets are outside `
                    + `the conversion corpus and were not converted.`,
                recovery: `Free-layer stylesheets referenced by URL `
                    + `from views still convert; only the named `
                    + `stylesheet table entries were dropped.`,
            });
        }
    }

    /* One inline cartolina-surface source per mapConfig surface, each
     * carrying the shared reference metadata. */
    private convertSurfaces(): void {

        const doc = this.doc;

        // shared metadata, absolutized once and reused per surface
        const srses = structuredClone(doc['srses']) as
            Record<string, unknown>;

        for (const [srsId, srs] of Object.entries(srses)) {

            if (!isRecord(srs)) continue;
            const geoidGrid = srs['geoidGrid'];

            if (isRecord(geoidGrid))
                absolutizeFields(geoidGrid, ['definition'],
                    this.documentContext, `srses.${srsId}.geoidGrid`);
        }

        const services = structuredClone(doc['services'] ?? {}) as
            Record<string, unknown>;

        for (const [serviceId, service] of Object.entries(services)) {

            if (!isRecord(service)) continue;
            absolutizeFields(service, ['url'],
                this.documentContext, `services.${serviceId}`);
        }

        const shared = {
            referenceFrame: structuredClone(doc['referenceFrame']),
            srses,
            bodies: structuredClone(doc['bodies'] ?? {}),
            services,
            credits: structuredClone(doc['credits'] ?? {}),
        };

        const surfaceUrlFields = ['meshUrl', 'metaUrl', 'navUrl',
            'hmapUrl', 'normalsUrl', 'textureUrl', 'geodataUrl'];

        for (const rawSurface of doc['surfaces'] as unknown[]) {

            const surface =
                structuredClone(rawSurface) as Record<string, unknown>;
            const legacyId = surface['id'] as string;
            const sourceId =
                this.surfaceSourceIds.get(legacyId) as string;

            absolutizeFields(surface, surfaceUrlFields,
                this.documentContext, `surfaces.${legacyId}`);

            this.sources[sourceId] = {
                type: 'cartolina-surface',
                data: {
                    ...structuredClone(shared),
                    surfaces: [surface],
                },
                baseUrl: this.requireBase(`surfaces.${legacyId}`),
            };
        }
    }

    /* Bound layers become inline cartolina-tms sources; a definition
     * that cannot be fetched falls back to a URL source. */
    private async convertBoundLayers(): Promise<void> {

        const boundLayers = this.doc['boundLayers'];
        if (!isRecord(boundLayers)) return;

        for (const [key, value] of Object.entries(boundLayers)) {

            const sourceId = this.boundSourceIds.get(key) as string;
            const path = `boundLayers.${key}`;

            if (typeof value === 'string') {

                const url = resolveAgainst(
                    this.documentContext, value, path);

                try {

                    const definition =
                        await this.loadJson(url, 'Source');
                    if (!isRecord(definition))
                        throw new Error('not an object');

                    const definitionContext = urlContextOf(url);
                    absolutizeFields(definition,
                        ['url', 'metaUrl', 'maskUrl'],
                        definitionContext, path);

                    this.sources[sourceId] = {
                        type: 'cartolina-tms',
                        data: definition,
                        baseUrl: definitionContext!.base,
                    };

                } catch (error) {

                    this.warnings.push({
                        code: 'source-unavailable',
                        path,
                        message: `The bound-layer definition at `
                            + `${url} could not be fetched `
                            + `(${(error as Error).message}).`,
                        recovery: `Emitted a URL source; the runtime `
                            + `retries the fetch at load time.`,
                    });

                    this.sources[sourceId] =
                        { type: 'cartolina-tms', url };
                }

            } else if (isRecord(value)) {

                const definition = structuredClone(value);
                absolutizeFields(definition,
                    ['url', 'metaUrl', 'maskUrl'],
                    this.documentContext, path);

                this.sources[sourceId] = {
                    type: 'cartolina-tms',
                    data: definition,
                    baseUrl: this.requireBase(path),
                };

            } else {

                fatal(`invalid bound layer at ${path}`);
            }
        }
    }

    /* Free layers become inline cartolina-freelayer sources with the
     * monolithic-or-tiled definition union. */
    private async convertFreeLayers(): Promise<void> {

        const freeLayers = this.doc['freeLayers'];
        if (!isRecord(freeLayers)) return;

        for (const [key, value] of Object.entries(freeLayers)) {

            const sourceId = this.freeSourceIds.get(key) as string;
            const path = `freeLayers.${key}`;

            let definition: Record<string, unknown> | null = null;
            let definitionContext: UrlContext = this.documentContext;
            let fallbackUrl: string | null = null;

            if (typeof value === 'string') {

                fallbackUrl = resolveAgainst(
                    this.documentContext, value, path);

                try {

                    const fetched =
                        await this.loadJson(fallbackUrl, 'Source');
                    if (!isRecord(fetched))
                        throw new Error('not an object');

                    definition = structuredClone(fetched);
                    definitionContext = urlContextOf(fallbackUrl);

                } catch (error) {

                    this.warnings.push({
                        code: 'source-unavailable',
                        path,
                        message: `The free-layer definition at `
                            + `${fallbackUrl} could not be fetched `
                            + `(${(error as Error).message}).`,
                        recovery: `Emitted a URL source; the runtime `
                            + `retries the fetch at load time.`,
                    });
                }

            } else if (isRecord(value)) {

                definition = structuredClone(value);

            } else {

                fatal(`invalid free layer at ${path}`);
            }

            if (definition === null) {

                this.sources[sourceId] = {
                    type: 'cartolina-freelayer',
                    url: fallbackUrl,
                };
                this.freeLayerDefinitions.set(key, null);
                continue;
            }

            absolutizeFields(definition,
                ['geodataUrl', 'geodata', 'metaUrl', 'style'],
                definitionContext, path);

            const type = definition['type'];

            if (type !== 'geodata' && type !== 'geodata-tiles') {

                this.warnings.push({
                    code: 'unsupported-field',
                    path: `${path}.type`,
                    message: `Free-layer type "${type}" is outside `
                        + `the conversion corpus.`,
                    recovery: fallbackUrl
                        ? `Emitted a URL source; the runtime decides `
                            + `at load time.`
                        : `The free layer was dropped.`,
                });

                if (fallbackUrl) {
                    this.sources[sourceId] = {
                        type: 'cartolina-freelayer',
                        url: fallbackUrl,
                    };
                }

                this.freeLayerDefinitions.set(key, null);
                continue;
            }

            // "style" is the free layer's own legacy default
            // stylesheet pointer. The convert-time resolution below
            // still needs it (this.freeLayerDefinitions keeps the
            // original), but the runtime must not see it: MapSurface
            // reads a free-layer source's own "style" field and
            // independently fetches it as a legacy per-surface
            // stylesheet — a fetch made redundant by this RFC, since
            // lettering is driven entirely by style.layers, and one
            // that fails loudly whenever a manifest's declared
            // default happens to be stale.
            const sourceData: Record<string, unknown> = { ...definition };
            delete sourceData['style'];

            this.sources[sourceId] = {
                type: 'cartolina-freelayer',
                data: sourceData,
                baseUrl: definitionContext
                    ? definitionContext.base
                    : this.requireBase(path),
            };

            this.freeLayerDefinitions.set(key, definition);
        }
    }

    // -----------------------------------------------------------------
    // Views
    // -----------------------------------------------------------------

    private resolveInitialView(): NormalizedView {

        const override = this.options.view;

        if (typeof override === 'string') {

            const namedViews = this.doc['namedViews'];
            const named = isRecord(namedViews)
                ? namedViews[override] : undefined;

            if (!isRecord(named))
                fatal(`options.view names unknown view "${override}".`);

            return normalizeViewInput(named);
        }

        if (isRecord(override)) return normalizeViewInput(override);

        const view = this.doc['view'];
        if (!isRecord(view)) {
            fatal('the mapConfig has no view; pass options.view.');
        }

        return normalizeViewInput(view);
    }

    private resolveNamedViews(): Map<string, NormalizedView> {

        const result = new Map<string, NormalizedView>();
        const namedViews = this.doc['namedViews'];
        if (!isRecord(namedViews)) return result;

        for (const [name, raw] of Object.entries(namedViews)) {

            const view = normalizeViewInput(raw);

            // rendering options on a non-initial view have no
            // profile representation
            for (const key of Object.keys(view.options)) {

                this.warnings.push({
                    code: 'unsupported-view-option',
                    path: `namedViews.${name}.options.${key}`,
                    message: `Rendering option "${key}" on named view `
                        + `"${name}" has no visibility-profile `
                        + `representation.`,
                    recovery: `The option was dropped; the profile `
                        + `carries visibility only.`,
                });
            }

            result.set(name, view);
        }

        return result;
    }

    private terrainStackOf(view: NormalizedView): string[] {

        const stack: string[] = [];

        // the canonical stack order is the mapConfig surfaces array;
        // a view only selects members
        for (const surface of this.doc['surfaces'] as unknown[]) {

            const legacyId = String(
                (surface as Record<string, unknown>)['id']);

            if (legacyId in view.surfaces) {
                stack.push(this.surfaceSourceIds.get(legacyId) as string);
            }
        }

        for (const legacyId of Object.keys(view.surfaces)) {

            if (!this.surfaceSourceIds.has(legacyId))
                fatal(`view references unknown surface "${legacyId}".`);
        }

        return stack;
    }

    // -----------------------------------------------------------------
    // Raster presentations
    // -----------------------------------------------------------------

    /*
     * Collects the distinct raster presentations of all views. Equal
     * source, type, and styling properties share one layer whose
     * terrain list carries the union of assigned surfaces; different
     * properties become separate layers selected by profiles. Also
     * records every view's per-surface presentation sequence for the
     * canonical-order merge.
     */
    private collectPresentations(
        initialView: NormalizedView,
        namedViews: Map<string, NormalizedView>,
    ): {
        presentations: Map<string, PresentationEntry>;
        sequences: ViewSequence[];
    } {

        const presentations = new Map<string, PresentationEntry>();
        const sequences: ViewSequence[] = [];
        const idCounters = new Map<string, number>();
        let initialOrder = 0;

        const visit = (
            view: NormalizedView,
            viewId: string | null,
            pathPrefix: string,
        ) => {

            for (const [legacySurfaceId, entries]
                of Object.entries(view.surfaces)) {

                const terrainId =
                    this.surfaceSourceIds.get(legacySurfaceId);
                if (!terrainId) {
                    fatal(`view references unknown surface `
                        + `"${legacySurfaceId}".`);
                }

                const sequence: ViewSequence = {
                    viewId,
                    path: `${pathPrefix}.surfaces.${legacySurfaceId}`,
                    keys: [],
                };

                sequences.push(sequence);

                entries.forEach((entry, index) => {

                    const path = `${pathPrefix}.surfaces.`
                        + `${legacySurfaceId}[${index}]`;

                    const presentation = convertRasterEntry(
                        entry, path, this.notes);

                    const sourceId = this.boundSourceIds.get(
                        presentation.boundLayerId);

                    if (!sourceId) {
                        fatal(`view references unknown bound layer `
                            + `"${presentation.boundLayerId}" at `
                            + `${path}.`);
                    }

                    const key = canonicalJson(
                        { sourceId, spec: presentation.spec });

                    sequence.keys.push(key);

                    let existing = presentations.get(key);

                    if (!existing) {

                        // stable id: the bound-layer id, suffixed per
                        // additional distinct presentation
                        const count =
                            (idCounters.get(sourceId) ?? 0) + 1;
                        idCounters.set(sourceId, count);

                        const id = count === 1
                            ? sourceId : `${sourceId}-${count}`;

                        existing = {
                            id,
                            sourceId,
                            spec: presentation.spec,
                            initialTerrain: new Set(),
                            viewTerrain: new Map(),
                            initialOrder: -1,
                        };

                        presentations.set(key, existing);
                    }

                    if (viewId === null) {

                        existing.initialTerrain.add(terrainId);
                        if (existing.initialOrder === -1)
                            existing.initialOrder = initialOrder++;

                    } else {

                        let terrain = existing.viewTerrain.get(viewId);
                        if (!terrain) {
                            terrain = new Set();
                            existing.viewTerrain.set(viewId, terrain);
                        }
                        terrain.add(terrainId);
                    }
                });
            }
        };

        visit(initialView, null, 'view');
        for (const [name, view] of namedViews)
            visit(view, name, `namedViews.${name}`);

        return { presentations, sequences };
    }

    /*
     * Chooses the canonical raster-layer order: a deterministic
     * topological merge of every view's per-surface sequences. The
     * initial view is the backbone — its first-seen order breaks
     * ties — and layers used only by named views slot where their
     * ordering constraints demand. A view surface whose sequence the
     * final order cannot reproduce (a genuine ordering cycle across
     * views) gets a layer-order-conflict warning.
     */
    private orderPresentations(
        presentations: Map<string, PresentationEntry>,
        sequences: ViewSequence[],
    ): PresentationEntry[] {

        // precedence edges from consecutive sequence pairs
        const successors = new Map<string, Set<string>>();
        const indegree = new Map<string, number>();

        for (const key of presentations.keys()) {
            successors.set(key, new Set());
            indegree.set(key, 0);
        }

        for (const sequence of sequences) {

            for (let i = 0; i + 1 < sequence.keys.length; i++) {

                const from = sequence.keys[i];
                const to = sequence.keys[i + 1];
                if (from === to) continue;

                const set = successors.get(from) as Set<string>;
                if (set.has(to)) continue;

                set.add(to);
                indegree.set(to, (indegree.get(to) as number) + 1);
            }
        }

        // Kahn's algorithm; among ready nodes, initial-view layers go
        // in their first-seen order, named-only layers by id
        const sortKey = (key: string): [number, string] => {

            const entry = presentations.get(key) as PresentationEntry;
            return [
                entry.initialOrder === -1
                    ? Number.MAX_SAFE_INTEGER : entry.initialOrder,
                entry.id,
            ];
        };

        const ready: string[] = [];

        for (const [key, degree] of indegree)
            if (degree === 0) ready.push(key);

        const ordered: string[] = [];

        while (ready.length > 0) {

            let best = 0;

            for (let i = 1; i < ready.length; i++) {

                const [aOrder, aId] = sortKey(ready[i]);
                const [bOrder, bId] = sortKey(ready[best]);

                if (aOrder < bOrder
                    || (aOrder === bOrder && aId < bId)) {
                    best = i;
                }
            }

            const key = ready.splice(best, 1)[0];
            ordered.push(key);

            for (const next of successors.get(key) as Set<string>) {

                const degree = (indegree.get(next) as number) - 1;
                indegree.set(next, degree);
                if (degree === 0) ready.push(next);
            }
        }

        // a cycle means genuinely incompatible per-surface orders;
        // emit the rest deterministically and let the check below
        // name the affected view surfaces
        if (ordered.length < presentations.size) {

            const emitted = new Set(ordered);
            const remaining = [...presentations.keys()]
                .filter((key) => !emitted.has(key));

            remaining.sort((a, b) => {

                const [aOrder, aId] = sortKey(a);
                const [bOrder, bId] = sortKey(b);
                if (aOrder !== bOrder) return aOrder - bOrder;
                return aId < bId ? -1 : 1;
            });

            ordered.push(...remaining);
        }

        const positions = new Map<string, number>();
        ordered.forEach((key, index) => positions.set(key, index));

        // per-view reproducibility check: every sequence must be
        // non-decreasing in the final order
        for (const sequence of sequences) {

            let last = -1;

            for (const key of sequence.keys) {

                const position = positions.get(key) as number;

                if (position < last) {

                    this.warnings.push({
                        code: 'layer-order-conflict',
                        path: sequence.path,
                        message: `The relative layer order at `
                            + `${sequence.path} cannot be reproduced `
                            + `by visibility changes over the `
                            + `canonical layer order.`,
                        recovery: `The merged canonical order `
                            + `applies.`,
                    });

                    break;
                }

                last = position;
            }
        }

        return ordered.map(
            (key) => presentations.get(key) as PresentationEntry);
    }

    // -----------------------------------------------------------------
    // Resolved lettering stylesheets
    // -----------------------------------------------------------------

    private async collectResolvedStylesheets(
        initialView: NormalizedView,
        namedViews: Map<string, NormalizedView>,
    ): Promise<Map<string, ResolvedVtsStylesheet>> {

        const stylesheets = new Map<string, ResolvedVtsStylesheet>();

        const visit = async (
            view: NormalizedView,
            viewId: string,
            pathPrefix: string,
        ) => {

            for (const [key, overrides]
                of Object.entries(view.freeLayers)) {

                const sourceId = this.freeSourceIds.get(key);
                if (!sourceId) {
                    fatal(`view references unknown free layer `
                        + `"${key}".`);
                }

                const path = `${pathPrefix}.freeLayers.${key}`;

                // overrides beyond the stylesheet are outside the
                // conversion corpus
                for (const overrideKey of Object.keys(overrides)) {

                    if (overrideKey === 'style') continue;

                    this.warnings.push({
                        code: 'unsupported-field',
                        path: `${path}.${overrideKey}`,
                        message: `Free-layer view override `
                            + `"${overrideKey}" is outside the `
                            + `conversion corpus.`,
                        recovery: `The override was dropped.`,
                    });
                }

                const definition =
                    this.freeLayerDefinitions.get(key) ?? null;

                // effective stylesheet: the view override, then the
                // definition default
                const overrideUrl =
                    typeof overrides['style'] === 'string'
                        ? resolveAgainst(this.documentContext,
                            overrides['style'], `${path}.style`)
                        : null;

                const defaultUrl = definition
                    && typeof definition['style'] === 'string'
                        ? definition['style'] : null;

                const data = await this.loadStylesheet(
                    overrideUrl, defaultUrl, path);

                if (data === null) continue;

                const stylesheetKey = `${key}\\u0000${data.url}`;
                let stylesheet = stylesheets.get(stylesheetKey);

                if (!stylesheet) {

                    stylesheet = {
                        freeLayerKey: key,
                        sourceId,
                        stylesheetUrl: data.url,
                        viewIds: new Set(),
                        data: data.stylesheet,
                    };

                    stylesheets.set(stylesheetKey, stylesheet);
                }

                stylesheet.viewIds.add(viewId);
            }
        };

        await visit(initialView, '', 'view');
        for (const [name, view] of namedViews)
            await visit(view, name, `namedViews.${name}`);

        return stylesheets;
    }

    /* Loads the effective stylesheet, falling back from the view
     * override to the definition default, and absolutizes its font
     * URLs. Returns null with a warning when neither loads. */
    private async loadStylesheet(
        overrideUrl: string | null,
        defaultUrl: string | null,
        path: string,
    ): Promise<{
        url: string;
        stylesheet: linker.VtsStylesheetData;
    } | null> {

        const candidates = [overrideUrl, defaultUrl]
            .filter((url): url is string => url !== null);

        for (const url of candidates) {

            try {

                const data = await this.loadJson(url, 'Style');
                if (!isRecord(data)) throw new Error('not an object');

                const stylesheet = structuredClone(data) as
                    linker.VtsStylesheetData;
                const stylesheetContext = urlContextOf(url);

                if (stylesheet.fonts) {

                    for (const [alias, fontUrl]
                        of Object.entries(stylesheet.fonts)) {

                        stylesheet.fonts[alias] = resolveAgainst(
                            stylesheetContext, fontUrl,
                            `${path}:fonts.${alias}`);
                    }
                }

                return { url, stylesheet };

            } catch (error) {

                this.warnings.push({
                    code: 'stylesheet-unavailable',
                    path,
                    message: `The stylesheet at ${url} could not be `
                        + `loaded (${(error as Error).message}).`,
                    recovery: candidates.indexOf(url)
                        < candidates.length - 1
                        ? `Falling back to the next stylesheet `
                            + `candidate.`
                        : `The free layer keeps its source but emits `
                            + `no style layers and will not render.`,
                });
            }
        }

        return null;
    }

    // -----------------------------------------------------------------
    // Layer assembly
    // -----------------------------------------------------------------

    private assembleLayers(
        orderedPresentations: PresentationEntry[],
        orderedStylesheets: ResolvedVtsStylesheet[],
        linked: linker.LinkerResult,
    ): Record<string, unknown>[] {

        const layers: Record<string, unknown>[] = [];

        // raster layers in the merged canonical order
        for (const entry of orderedPresentations) {

            layers.push({
                id: entry.id,
                source: entry.sourceId,
                ...entry.spec,
                terrain: [...entry.initialTerrain],
            });
        }

        // the linker pairs its output to `orderedStylesheets` by input
        // position (`layerIdsByInput`), not by an identity of its own;
        // recover the per-layer resolved-stylesheet record from that
        // pairing, keyed by the already-unique emitted layer id
        const stylesheetByLayerId = new Map<string, ResolvedVtsStylesheet>();
        linked.layerIdsByInput.forEach((ids, index) => {
            for (const id of ids)
                stylesheetByLayerId.set(id, orderedStylesheets[index]);
        });

        // lettering layers in linked order; rules from stylesheets the
        // initial view selects apply to every terrain, named-only
        // rules start inactive
        for (const linkedLayer of linked.layers) {

            const rule = linkedLayer.rule;
            const cls = classifyRule(rule);

            const stylesheet = stylesheetByLayerId.get(linkedLayer.id);
            const freeLayerKey = stylesheet?.freeLayerKey ?? linkedLayer.id;

            if (cls === 'mixed') {

                this.warnings.push({
                    code: 'unsupported-rule',
                    path: `freeLayers.${freeLayerKey}.style:`
                        + `layers.${linkedLayer.id}`,
                    message: `Rule "${linkedLayer.id}" mixes line `
                        + `drawing with point or label drawing; no `
                        + `discriminator accepts it cleanly.`,
                    recovery: `The rule was not emitted.`,
                });

                continue;
            }

            const inInitialView =
                stylesheet !== undefined && stylesheet.viewIds.has('');

            const layer: Record<string, unknown> = {
                id: linkedLayer.id,
                type: cls,
                source: linkedLayer.sourceId,
                ...rule,
            };

            // active rules keep an omitted terrain list (expands to
            // every declared terrain source at validation)
            if (!inInitialView) layer['terrain'] = [];

            layers.push(layer);
        }

        return layers;
    }

    // -----------------------------------------------------------------
    // View options
    // -----------------------------------------------------------------

    private convertViewOptions(
        view: NormalizedView,
        style: Record<string, unknown>,
    ): void {

        for (const [key, value] of Object.entries(view.options)) {

            if (key === 'illumination') {

                if (!isRecord(value))
                    fatal('invalid view illumination options.');

                const known = ['light', 'ambientCoef', 'useLighting',
                    'shadingLambertianWeight', 'shadingSlopeWeight',
                    'shadingAspectWeight'];

                for (const optionKey of Object.keys(value))
                    if (!known.includes(optionKey))
                        fatal(`unknown illumination option `
                            + `"${optionKey}" on the selected view.`);

                style['illumination'] = structuredClone(value);
                continue;
            }

            if (key === 'superelevation') {

                style['vertical-exaggeration'] =
                    this.convertSuperelevation(value);
                continue;
            }

            fatal(`unknown option "${key}" on the selected view.`);
        }
    }

    /* Normalizes the legacy superelevation forms: a bare ramp array
     * or the heightRamp / viewExtentProgression object. */
    private convertSuperelevation(value: unknown): unknown {

        if (Array.isArray(value)) {
            return { heightRamp: structuredClone(value) };
        }

        if (isRecord(value)) {

            for (const key of Object.keys(value))
                if (!['heightRamp', 'viewExtentProgression']
                    .includes(key))
                    fatal(`unknown superelevation key "${key}" on `
                        + `the selected view.`);

            return structuredClone(value);
        }

        fatal('invalid superelevation on the selected view.');
    }

    // -----------------------------------------------------------------
    // Profiles
    // -----------------------------------------------------------------

    private buildProfiles(
        namedViews: Map<string, NormalizedView>,
        orderedPresentations: PresentationEntry[],
        orderedStylesheets: ResolvedVtsStylesheet[],
        layerIdsByInput: string[][],
        layers: Record<string, unknown>[],
    ): Record<string, Viewer.VisibilityProfile> {

        const profiles: Record<string, Viewer.VisibilityProfile> = {};
        const allTerrainIds = [...this.surfaceSourceIds.values()];

        for (const [name, view] of namedViews) {

            const profileLayers: Record<string, string[]> = {};
            const emittedLayerIds = new Set<string>();

            for (const layer of layers) {

                const id = layer['id'] as string;
                profileLayers[id] = [];
                emittedLayerIds.add(id);
            }

            // raster layers active in this view
            for (const entry of orderedPresentations) {

                const terrain = entry.viewTerrain.get(name);
                if (terrain) profileLayers[entry.id] = [...terrain];
            }

            // lettering rules of stylesheets this view selects apply
            // to every declared terrain source. Paired to
            // orderedStylesheets by input position (layerIdsByInput),
            // not by an identity the linker exports: a free layer that
            // selects different stylesheets across views yields
            // several resolved stylesheets sharing one freeLayerKey
            // but each with its own emitted rule ids.
            orderedStylesheets.forEach((stylesheet, index) => {

                if (!stylesheet.viewIds.has(name)) return;

                // layerIdsByInput describes linked rules. A mixed
                // rule is linked but deliberately omitted during
                // assembly, so only activate ids present in the
                // emitted style.
                for (const id of layerIdsByInput[index]) {
                    if (emittedLayerIds.has(id))
                        profileLayers[id] = [...allTerrainIds];
                }
            });

            profiles[name] = {
                terrain: this.terrainStackOf(view),
                layers: profileLayers,
            };
        }

        return profiles;
    }

    // -----------------------------------------------------------------
    // browserOptions
    // -----------------------------------------------------------------

    /*
     * Classifies every browserOptions key: a public catalogued key
     * gets its typed viewerOptions destination, a proven no-op or
     * uncatalogued key is dropped with an exact-outcome note, and a
     * catalogued internal key that the client still reads produces a
     * warning.
     */
    private convertBrowserOptions():
        viewerConfig.PublicConstructionConfig {

        const viewerOptions: viewerConfig.PublicConstructionConfig = {};
        const browserOptions = this.doc['browserOptions'];
        if (!isRecord(browserOptions)) return viewerOptions;

        for (const [key, value] of Object.entries(browserOptions)) {

            const path = `browserOptions.${key}`;
            const canonical = viewerConfig.canonicalConfigKey(key);

            if (canonical === null) {

                // the current client drops uncatalogued keys
                this.notes.push({
                    code: 'ignored-browser-option',
                    path,
                    message: `The current client ignores browser `
                        + `option "${key}"; dropped with behavior `
                        + `unchanged.`,
                });

                continue;
            }

            if (provenNoOpOptions.has(canonical)) {

                this.notes.push({
                    code: 'ignored-browser-option',
                    path,
                    message: `Nothing in the current client reads `
                        + `"${canonical}"; dropped with behavior `
                        + `unchanged.`,
                });

                continue;
            }

            if (canonical in diagnosticOnlyOptions) {

                this.notes.push({
                    code: 'ignored-browser-option',
                    path,
                    message: `"${canonical}" gates console `
                        + `diagnostics only `
                        + `(${diagnosticOnlyOptions[canonical]}); `
                        + `dropped with rendering unchanged.`,
                });

                continue;
            }

            if (!publicOptionKeys.has(canonical)) {

                this.warnings.push({
                    code: 'unsupported-browser-option',
                    path,
                    message: `Browser option "${key}" is internal `
                        + `and has no public construction `
                        + `destination.`,
                    recovery: `The option was dropped; the catalogue `
                        + `default applies.`,
                });

                continue;
            }

            const patch =
                viewerConfig.normalizeConfigPatch(canonical, value);
            if (patch) Object.assign(viewerOptions, patch);
        }

        return viewerOptions;
    }

    // -----------------------------------------------------------------
    // Misc
    // -----------------------------------------------------------------

    private requireBase(path: string): string {

        if (this.documentContext === null) {

            throw new Error(`mapConfigToStyle: inline data at ${path} `
                + `needs a base URL; pass options.baseUrl for object `
                + `input.`);
        }

        return this.documentContext.base;
    }
}
