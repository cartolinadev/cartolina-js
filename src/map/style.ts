/*
 * style.ts - define style data and apply it to a map
 */

import type LegacyMap from './legacy-map';

import * as viewerConfig from '../viewer-config';
import MapRefFrame from './refframe';
import MapSrs from './srs';
import MapBody from './body';
import Atmosphere from './atmosphere';
import MapFreeLayer from './free-layer';
import MapCredit from './credit';
import RasterSource from './raster-source';
import TerrainSource from './terrain-source';
import type Map from './map';
import { utilsUrl } from '../utils/url';

import type * as StyleSchema from './style-schema';
import * as StyleValidation from './style-validation';


import * as utils from '../utils/utils';



// Legacy VTS stylesheet compiled for geodata free-layer rendering.

type VtsStylesheetLayer =
    Omit<StyleSchema.LetteringLayer, 'id' | 'type' | 'source' | 'terrain'>;

type VtsStylesheet = {

    constants?: Record<string, StyleSchema.Expression>;
    bitmaps?: Record<string, StyleSchema.BitmapSpecification>;
    fonts?: Record<string, string>;
    layers?: Record<string, VtsStylesheetLayer>;
};

/**
 * Loads map resources from a style and owns its current mutable runtime state.
 */
export class MapStyle {

    /**
     * Loads source definitions and installs the prepared style on the map.
     *
     * @param map the map being loaded
     * @param styleSpec the style specification
     */

    static async loadStyle(
        map: Map,
        styleSpec: StyleSchema.StyleSpecification,
    ): Promise<void> {

        // validate style and test for consistency
        StyleValidation.validateSpecification(styleSpec);

        // clone style, creating ids for anonymous layers
        const spec = MapStyle.prepareStyle(styleSpec);
        const legacyMap = map.legacyMap;

        if (!legacyMap)
            throw new Error('A style loads only into a map under '
                + 'construction.');

        // wipe map clean
        legacyMap.referenceFrame = null;
        legacyMap.srses = {};
        legacyMap.bodies = {};
        legacyMap.credits = {};
        legacyMap.freeLayers = {};
        legacyMap.stylesheets = {};
        legacyMap.services = {};

        // load every source definition, terrain and raster, in parallel
        const sourceLoads: Array<{
            id: string,
            spec: StyleSchema.CartolinaSurfaceSource
                | StyleSchema.CartolinaTmsSource,
            load: Promise<[unknown, string]>,
        }> = [];

        for (const [id, sourceSpec] of Object.entries(spec.sources)) {

            if (sourceSpec.type === 'cartolina-surface') {

                // terrain-definition request.
                sourceLoads.push({
                    id,
                    spec: sourceSpec,
                    load: MapStyle.resolveSourceDefinition(
                        map, sourceSpec, 'mapConfig.json', 'MapConfig'),
                });
            }

            if (sourceSpec.type === 'cartolina-tms') {

                // raster-definition request.
                sourceLoads.push({
                    id,
                    spec: sourceSpec,
                    load: MapStyle.resolveSourceDefinition(
                        map, sourceSpec, 'boundlayer.json', 'Source'),
                });
            }
        }

        // wait for all requests to settle
        const sourceResults = await Promise.allSettled(
            sourceLoads.map(({ load }) => load));

        // terrain and rester sources are treated differently. A terrain
        // failure is fatal; a raster failure is retained until an active layer 
        // requests it.
        const terrainSources = new globalThis.Map<string, TerrainSource>();
        const rasterEntries =
            new globalThis.Map<string, Map.RasterSourceEntry>();


        // iterate through source results
        let mapMetadataInitialized = false;

        for (let index = 0; index < sourceResults.length; index++) {

            const result = sourceResults[index];
            const { id, spec: sourceSpec } = sourceLoads[index];

            // terrain source
            if (sourceSpec.type === 'cartolina-surface') {

                // a failed terrain source makes the style unusable.
                if (result.status === 'rejected')
                    throw result.reason;

                // process the definition. The first terrain source
                // initializes the reference frame, SRSes, and bodies.
                if (result.status === 'fulfilled') {

                    const [definitionValue, path] = result.value;

                    const source = MapStyle.buildTerrainSource_(
                        map, id, spec, definitionValue, path,
                        !mapMetadataInitialized);

                    mapMetadataInitialized = true;
                    terrainSources.set(id, source);

                } // result.status === 'fulfilled'

            } // sourceSpec.type === 'cartolina-surface'

            // raster source
            if (sourceSpec.type === 'cartolina-tms') {

                // a failed raster source is retained and not fatal until
                // an active layer requests it.
                if (result.status === 'rejected') {

                    const error = result.reason instanceof Error
                        ? result.reason
                        : new Error(String(result.reason));
                    rasterEntries.set(id, { status: 'failed', error });
                }

                // process the definition
                if (result.status === 'fulfilled') {

                    const [definition, path] = result.value;

                    try {

                        // publish the entry after every step that can fail
                        const source = MapStyle.buildRasterSource_(
                            map, id, definition, path);

                        rasterEntries.set(
                            id, { status: 'ready', source });

                    } catch (reason) {

                        const error = reason instanceof Error
                            ? reason
                            : new Error(String(reason));
                        rasterEntries.set(id, { status: 'failed', error });
                    }

                } // result.status === 'fulfilled'

            } // sourceSpec.type === 'cartolina-tms'

        } // iterate sourceResults

        // pass the completed source registries to the map.
        map.setTerrainSourceEntries(terrainSources);
        map.setRasterSourceEntries(rasterEntries);

        // load legacy geodata free layers 
        for (const [id, sourceSpec] of Object.entries(spec.sources)) {

            if (sourceSpec.type !== 'cartolina-freelayer') continue;

            legacyMap.addFreeLayer(id, 'definition' in sourceSpec
                ? new MapFreeLayer(
                    legacyMap, sourceSpec.definition,
                    legacyMap.url.baseUrl)
                : new MapFreeLayer(legacyMap, MapStyle.slapResource(
                    legacyMap.url.processUrl(sourceSpec.url),
                    'freelayer.json')));
        }

        // illumination
        if (spec.illumination)
            legacyMap.renderer.setIllumination(spec.illumination);

        // vertical exaggeration
        const veSpec = spec['vertical-exaggeration'];

        if (veSpec) {

            if ('heightRamp' in veSpec || 'viewExtentProgression' in veSpec) {

                // @deprecated legacy heightRamp / viewExtentProgression
                // format, applied as authored
                map.verticalExaggeration.setDeprecated(veSpec);

            } else {

                // the body carries the ramps; a ramp the style names of
                // its own replaces the body's
                const body = map.legacyMap!.referenceFrame?.body;

                map.verticalExaggeration.set({
                    ...body?.verticalExaggeration,
                    ...veSpec,
                });
            }
        }

        // options
        if (spec.config) {

            for (const [key, value] of Object.entries(spec.config)) {

                const patch = viewerConfig.normalizeConfigPatch(key, value);
                if (patch) legacyMap.core.configStore.set(patch);
            }
        }

        // a style with no atmosphere section starts with atmosphere
        // rendering off; an explicit config value takes precedence
        if (spec.config?.mapFlagAtmosphere === undefined) {

            const patch = viewerConfig.normalizeConfigPatch(
                'mapFlagAtmosphere', spec.atmosphere !== undefined);
            if (patch) legacyMap.core.configStore.set(patch);
        }

        // Install the style and its free-layer sequence as one completed load.
        const style = new MapStyle(map, spec);
        map.assertRasterSourcesAvailable(style.style());
        map.style = style;
        style.refresh(false);
    }

    /**
     * Returns the current runtime style.
     */
    style(): StyleSchema.StyleSpecification {

        return this.spec_;
    }

    /**
     * Applies a complete visibility profile atomically.
     *
     * @param profile active terrain sources and every layer's terrain list
     * @throws when the profile is invalid or would activate an unavailable
     *   raster source
     */
    applyVisibilityProfile(profile: Map.VisibilityProfile): void {

        // Validate profile completeness before preparing any new state.
        const profileIds = new Set(Object.keys(profile.layers));

        for (const layer of this.spec_.layers ?? []) {

            const id = layer.id as string;

            if (!profileIds.has(id))
                throw new Error(`Visibility profile omits layer "${id}".`);

            profileIds.delete(id);
        }

        if (profileIds.size > 0) {

            throw new Error(`Visibility profile names unknown layer(s): `
                + `${[...profileIds].join(', ')}.`);
        }

        this.validateTerrainIds(profile.terrain);

        for (const terrainIds of Object.values(profile.layers))
            this.validateTerrainIds(terrainIds);

        // Prepare the complete profile on a clone of the current style.
        const nextSpec = structuredClone(this.spec_);
        const nextLayersById = MapStyle.indexLayers(nextSpec);

        nextSpec.terrain.sources = [...profile.terrain];

        for (const [id, terrainIds] of Object.entries(profile.layers))
            nextLayersById.get(id)!.terrain = [...terrainIds];

        // Commit only after every prospective raster source is available.
        this.commitCandidate(
            nextSpec, nextLayersById, this.hasLetteringLayers());
    }

    /** Returns a complete copy of the current visibility state. */
    getVisibilityProfile(): Map.VisibilityProfile {

        const layers: Record<string, string[]> = {};

        for (const layer of this.spec_.layers ?? [])
            layers[layer.id as string] =
                [...this.terrainSourcesForLayer(layer)];

        return {
            terrain: this.getTerrainSources(),
            layers,
        };
    }

    /**
     * Replaces the active terrain stack.
     *
     * @param sourceIds terrain source ids in stack order
     * @throws on an invalid terrain source id or an unavailable raster source
     */
    setTerrainSources(sourceIds: string[]): void {

        this.validateTerrainIds(sourceIds);

        const nextSpec = structuredClone(this.spec_);
        const nextLayersById = MapStyle.indexLayers(nextSpec);

        nextSpec.terrain.sources = [...sourceIds];
        this.commitCandidate(
            nextSpec, nextLayersById, this.hasLetteringLayers());
    }

    /** Returns a copy of the current active terrain stack. */
    getTerrainSources(): string[] {

        return [...this.spec_.terrain.sources];
    }

    /**
     * Replaces one layer's active terrain-source list.
     *
     * @param layerId id of the layer to change
     * @param terrainIds terrain source ids
     * @throws on an unknown layer, an invalid terrain source id, or an
     *   unavailable raster source
     */
    setLayerTerrainSources(layerId: string, terrainIds: string[]): void {

        if (!this.layersById_.has(layerId))
            throw new Error(`Unknown style layer id "${layerId}".`);

        this.validateTerrainIds(terrainIds);

        const nextSpec = structuredClone(this.spec_);
        const nextLayersById = MapStyle.indexLayers(nextSpec);

        nextLayersById.get(layerId)!.terrain = [...terrainIds];
        this.commitCandidate(
            nextSpec, nextLayersById, this.isLetteringLayer(layerId));
    }

    /**
     * Returns a copy of one layer's current terrain-source list.
     * An omitted list resolves to every declared terrain source.
     *
     * @param layerId id of the layer to query
     * @throws on an unknown layer id
     */
    getLayerTerrainSources(layerId: string): string[] {

        const layer = this.layersById_.get(layerId);
        if (!layer) {
            throw new Error(`Unknown style layer id "${layerId}".`);
        }

        return [...this.terrainSourcesForLayer(layer)];
    }

    /**
     * Registers a data source of any type at runtime. Resolves once the
     * source has loaded and is part of the usable map state — only then
     * may a layer reference it or `setTerrainSources` select it — and
     * rejects if it fails to load. A source draws nothing on its own; a
     * subsequent `addLayer` referencing it by id is what draws it.
     *
     * A URL source (any type) fetches its definition first; an inline
     * (`definition`) source resolves without a fetch. Await the returned
     * promise before adding a layer that references the source.
     *
     * @param id source identifier a layer references by `source`
     * @param sourceSpec any cartolina source (surface, tms, or freelayer)
     * @throws on a duplicate id, an unknown source type, or a load failure
     */
    async addSource(
        id: string,
        sourceSpec: StyleSchema.SourceSpecification,
    ): Promise<void> {

        if (id in this.spec_.sources
                || this.map_.legacyMap!.getFreeLayer(id)
                || this.pendingSources_.has(id))
            throw new Error(`Source id "${id}" already exists.`);

        // Load and validate off to the side; the helpers register only on
        // success. Until then the source does not exist — this pending id
        // just rejects a concurrent second add of the same id.
        this.pendingSources_.add(id);

        try {

            switch (sourceSpec.type) {

                case 'cartolina-freelayer':
                    await this.addFreeLayerSource_(id, sourceSpec);
                    return;

                case 'cartolina-surface':
                    await this.addTerrainSource_(id, sourceSpec);
                    return;

                case 'cartolina-tms':
                    await this.addRasterSource_(id, sourceSpec);
                    return;

                default:
                    throw new Error(`Source "${id}" has an unknown type.`);
            }

        } finally {

            this.pendingSources_.delete(id);
        }
    }

    /**
     * Removes a source registered through `addSource` from every
     * registry it reached, and cancels any in-flight load so it cannot
     * install after removal.
     *
     * @param id source identifier passed to `addSource`
     * @throws on an unknown id, or when a style layer still references
     *   the source (remove the dependent layers first)
     */
    removeSource(id: string): void {

        if (!(id in this.spec_.sources))
            throw new Error(`Unknown source id "${id}".`);

        const dependent = (this.spec_.layers ?? [])
            .find((layer) => layer.source === id);

        if (dependent)
            throw new Error(`Cannot remove source "${id}": layer `
                + `"${dependent.id}" still references it.`);

        this.map_.legacyMap!.removeFreeLayer(id);
        this.map_.removeTerrainSourceEntry(id);
        this.map_.removeRasterSourceEntry(id);
        this.surfaceSourceIds_ =
            this.surfaceSourceIds_.filter((source) => source !== id);

        const nextSpec = structuredClone(this.spec_);
        delete nextSpec.sources[id];
        this.spec_ = nextSpec;

        this.refreshFreeLayerSequence();
    }

    /**
     * Adds a style layer at runtime and re-commits the style.
     *
     * Accepts any layer type. A lettering layer renders once its
     * `source` names a registered free-layer source (see `addSource`).
     *
     * @param layerSpec a complete style layer carrying an explicit id
     * @throws on a missing id or a spec the validator rejects
     */
    addLayer(layerSpec: StyleSchema.LayerSpecification): void {

        if (layerSpec.id === undefined)
            throw new Error('addLayer requires an explicit layer id.');

        const nextSpec = structuredClone(this.spec_);
        (nextSpec.layers ??= []).push(structuredClone(layerSpec));

        StyleValidation.validateSpecification(nextSpec);

        const nextLayersById = MapStyle.indexLayers(nextSpec);
        const lettering = ['labels', 'lines'].includes(layerSpec.type ?? '');

        this.commitCandidate(nextSpec, nextLayersById, lettering);
    }

    /**
     * Removes a style layer added through `addLayer` and re-commits.
     *
     * @param id layer identifier passed to `addLayer`
     * @throws on an unknown layer id
     */
    removeLayer(id: string): void {

        const layers = this.spec_.layers ?? [];
        const removed = layers.find((layer) => layer.id === id);

        if (!removed)
            throw new Error(`Unknown style layer id "${id}".`);

        const nextSpec = structuredClone(this.spec_);
        nextSpec.layers = (nextSpec.layers ?? [])
            .filter((layer) => layer.id !== id);

        const nextLayersById = MapStyle.indexLayers(nextSpec);
        const lettering = ['labels', 'lines'].includes(removed.type ?? '');

        this.commitCandidate(nextSpec, nextLayersById, lettering);
    }

    /**
     * Rebuilds the legacy map free-layer sequence and its lettering styles.
     *
     * @internal Called after style changes and by legacy free-layer callbacks.
     */
    refreshFreeLayerSequence(): void {

        const legacyMap = this.map_.legacyMap!;
        const spec = this.spec_;

        // Every active terrain source must resolve before lettering is
        // compiled; resolveTerrainSource throws when one does not.
        spec.terrain.sources.forEach((sourceId: string) =>
            this.map_.resolveTerrainSource(sourceId));

        // Compile the lettering rules selected by the active terrain stack.
        const freeLayerStyles: Record<string, VtsStylesheet> = {};
        const activeTerrain = spec.terrain.sources;

        for (const layer of spec.layers ?? []) {

            if (!['labels', 'lines'].includes(layer.type ?? '')) continue;

            const ruleTerrain = this.terrainSourcesForLayer(layer);
            if (!ruleTerrain.some((id) => activeTerrain.includes(id)))
                continue;

            const freeLayerId = layer.source as string;
            let stylesheet = freeLayerStyles[freeLayerId];

            if (!stylesheet) {

                // Copy shared style values into a new VTS stylesheet.
                stylesheet = freeLayerStyles[freeLayerId] = {};
                if (spec.fonts) stylesheet.fonts = spec.fonts;
                if (spec.constants) stylesheet.constants = spec.constants;
                if (spec.bitmaps) stylesheet.bitmaps = spec.bitmaps;
                stylesheet.layers = {};
            }

            // Remove Cartolina-only fields from the lettering rule.
            const clonedLayer = structuredClone(
                layer) as StyleSchema.LetteringLayer;
            const { id, type, source, terrain, ...stylesheetLayer }
                = clonedLayer;

            stylesheet.layers![id as string] = stylesheetLayer;
        }

        // Install the compiled stylesheets in draw and hit-test order.
        legacyMap.freeLayerSequence = [];

        for (const [id, stylesheet] of Object.entries(freeLayerStyles)) {

            const freeLayer = legacyMap.getFreeLayer(id);
            if (!freeLayer) continue;

            legacyMap.freeLayerSequence.push(freeLayer);
            freeLayer.setStyle(stylesheet);
        }
    }

    /**
     * Creates the style owner after source loading has prepared the style.
     * 
     * Not called directly, invoked by the loadStyle() factory method.
     *
     * @param map the map receiving the style-derived free-layer sequence
     * @param spec current style with a runtime id on every layer
     */
    private constructor(map: Map, spec: StyleSchema.StyleSpecification) {

        this.map_ = map;
        this.spec_ = spec;
        this.layersById_ = MapStyle.indexLayers(spec);

        for (const [id, sourceSpec] of Object.entries(spec.sources)) {

            if (sourceSpec.type === 'cartolina-surface')
                this.surfaceSourceIds_.push(id);
        }
    }

    /** Clones an authored style and assigns missing runtime layer ids. */
    private static prepareStyle(
        styleSpec: StyleSchema.StyleSpecification,
    ): StyleSchema.StyleSpecification {

        const spec = structuredClone(styleSpec);
        const layers = spec.layers ?? [];

        // Reserve every explicit authored id before assigning any ids.
        const ids = new Set<string>();

        for (const layer of layers) {

            if (layer.id !== undefined) ids.add(layer.id);
        }

        // Assign anonymous layers deterministic runtime identity.
        layers.forEach((layer, index) => {

            if (layer.id !== undefined) return;

            const type = layer.type ?? 'diffuse-map';
            let candidate = `${type}-${index}`;

            while (ids.has(candidate)) candidate += '-anon';

            layer.id = candidate;
        });

        return spec;
    }

    /** Builds the layer-id index for one prepared style. */
    private static indexLayers(
        spec: StyleSchema.StyleSpecification,
    ): globalThis.Map<string, StyleSchema.LayerSpecification> {

        const layersById = new globalThis.Map<
            string, StyleSchema.LayerSpecification>();

        for (const layer of spec.layers ?? [])
            layersById.set(layer.id as string, layer);

        return layersById;
    }

    /**
     * Reads the shared map metadata from the first terrain source.
     *
     * @param map the map being loaded
     * @param spec the style being loaded
     * @param mc the mapConfig carrying the metadata
     * @param path the URL the mapConfig came from
     */
    private static initializeMapMetadata(
        map: Map,
        spec: StyleSchema.StyleSpecification,
        mc: StyleSchema.SurfaceSourceDefinition,
        path: string,
    ): void {

        const legacyMap = map.legacyMap!;

        // Install the coordinate and body definitions.
        for (const key in mc.srses)
            legacyMap.addSrs(key,
                new MapSrs(legacyMap, key, mc.srses[key], path));

        for (const key in mc.bodies)
            legacyMap.addBody(key, new MapBody(
                legacyMap, mc.bodies[key] as MapBody.Configuration));

        legacyMap.referenceFrame =
            new MapRefFrame(legacyMap, mc.referenceFrame);
        legacyMap.services = mc.services ?? {};

        // Create atmosphere state only when its two inputs exist.
        const body = legacyMap.referenceFrame.body;
        const services = legacyMap.services;

        if (!body?.atmosphere || !services?.atmdensity) return;

        const atmoSpec: Atmosphere.Specification = {
            visibilityToEyeDistance: 5.0,
            edgeDistanceToEyeDistance: 1.0,
            maxVisibility: 1e6,
            ...body.atmosphere,
            ...spec.atmosphere
        };

        legacyMap.atmosphere = new Atmosphere(
            atmoSpec, legacyMap.getPhysicalSrs(),
            utilsUrl.getProcessUrl(services.atmdensity.url, path),
            legacyMap);
    }

    /**
     * Validates and constructs one terrain source from a resolved
     * definition. Shared by `loadStyle` and runtime `addSource`.
     *
     * @param initializeMetadata true for the first terrain source, which
     *   establishes the reference frame; later sources must share it.
     */
    private static buildTerrainSource_(
        map: Map,
        id: string,
        spec: StyleSchema.StyleSpecification,
        definitionValue: unknown,
        path: string,
        initializeMetadata: boolean,
    ): TerrainSource {

        const legacyMap = map.legacyMap!;

        const definition = StyleValidation.validateSurfaceDefinition(
            id, definitionValue);

        if (initializeMetadata) {

            MapStyle.initializeMapMetadata(map, spec, definition, path);

        } else {

            const frameId = definition.referenceFrame.id;

            if (frameId !== legacyMap.referenceFrame!.id)
                utils.warnOnce(`Terrain source "${id}" declares reference `
                    + `frame "${frameId}"; the map uses `
                    + `"${legacyMap.referenceFrame!.id}".`);
        }

        if (definition.surfaces.length !== 1)
            throw Error(`The url for source ${id} does not define exactly `
                + `one surface, bailing out.`);

        const source = TerrainSource.fromMetadata(
            map, id, definition.surfaces[0], path);

        // Credits are per-metanode in the legacy VTS model, not
        // per-surface; this registers the global credit definitions.
        MapStyle.registerCreditDefinitions(legacyMap, definition.credits);

        return source;
    }

    /**
     * Constructs one raster source from a resolved definition and
     * registers its credits. Shared by `loadStyle` and `addSource`.
     */
    private static buildRasterSource_(
        map: Map,
        id: string,
        definition: unknown,
        path: string,
    ): RasterSource {

        const source = RasterSource.fromMetadata(map, id, definition, path);

        MapStyle.registerCreditDefinitions(
            map.legacyMap!,
            (definition as StyleSchema.TmsSourceDefinition).credits);

        return source;
    }

    /**
     * Loads one free-layer source and registers it; rejects on a fetch
     * or validation failure. An inline definition registers without a
     * fetch. The caller (`addSource`) holds the pending-id slot.
     */
    private async addFreeLayerSource_(
        id: string,
        sourceSpec: StyleSchema.CartolinaFreeLayerSource,
    ): Promise<void> {

        const legacyMap = this.map_.legacyMap!;

        // Fetch the definition for a URL source; inline resolves now.
        const [definition, baseUrl] = await MapStyle.resolveSourceDefinition(
            this.map_, sourceSpec, 'freelayer.json', 'Source');

        const freeLayer = new MapFreeLayer(legacyMap, definition, baseUrl);

        if (!freeLayer.geodata)
            throw new Error(`Free-layer source "${id}" resolved to `
                + `unsupported type "${freeLayer.type}".`);

        legacyMap.addFreeLayer(id, freeLayer);
        this.installSource_(id, sourceSpec);
    }

    /** Loads one terrain source and registers it; rejects on failure. */
    private async addTerrainSource_(
        id: string,
        sourceSpec: StyleSchema.CartolinaSurfaceSource,
    ): Promise<void> {

        const [definitionValue, path] =
            await MapStyle.resolveSourceDefinition(
                this.map_, sourceSpec, 'mapConfig.json', 'MapConfig');

        const source = MapStyle.buildTerrainSource_(
            this.map_, id, this.spec_, definitionValue, path, false);

        this.map_.addTerrainSourceEntry(id, source);
        this.surfaceSourceIds_.push(id);
        this.installSource_(id, sourceSpec);
    }

    /** Loads one raster source and registers it; rejects on failure. */
    private async addRasterSource_(
        id: string,
        sourceSpec: StyleSchema.CartolinaTmsSource,
    ): Promise<void> {

        const [definition, path] = await MapStyle.resolveSourceDefinition(
            this.map_, sourceSpec, 'boundlayer.json', 'Source');

        const source = MapStyle.buildRasterSource_(
            this.map_, id, definition, path);

        this.map_.addRasterSourceEntry(id, { status: 'ready', source });
        this.installSource_(id, sourceSpec);
    }

    /** Registers a resolved source in the style, atomically. */
    private installSource_(
        id: string,
        sourceSpec: StyleSchema.SourceSpecification,
    ): void {

        const nextSpec = structuredClone(this.spec_);
        nextSpec.sources[id] = sourceSpec;
        this.spec_ = nextSpec;

        this.map_.legacyMap!.dirty = true;
    }

    /** Resolves an omitted list to every declared terrain source. */
    private terrainSourcesForLayer(
        layer: StyleSchema.LayerSpecification,
    ): readonly string[] {

        return layer.terrain ?? this.surfaceSourceIds_;
    }

    /** Commits a prepared style and refreshes its derived render state. */
    private commitCandidate(
        spec: StyleSchema.StyleSpecification,
        layersById:
            globalThis.Map<string, StyleSchema.LayerSpecification>,
        clearLetteringHysteresis: boolean,
    ): void {

        this.map_.assertRasterSourcesAvailable(spec);
        this.spec_ = spec;
        this.layersById_ = layersById;
        this.refresh(clearLetteringHysteresis);
    }

    /** Rebuilds derived state and schedules a complete redraw. */
    private refresh(clearLetteringHysteresis: boolean): void {

        // Recompiled lettering must not inherit the previous rules' fades.
        if (clearLetteringHysteresis)
            this.map_.renderer.draw.clearJobHBuffer();

        const legacyMap = this.map_.legacyMap!;

        // Rebuild the free-layer sequence before the next rendered frame.
        legacyMap.viewCounter++;
        this.refreshFreeLayerSequence();
        legacyMap.dirty = true;
        legacyMap.hitMapDirty = true;
        legacyMap.geoHitMapDirty = true;
    }

    /** Returns whether the style contains a lettering layer. */
    private hasLetteringLayers(): boolean {

        return (this.spec_.layers ?? []).some(
            (layer) => ['labels', 'lines'].includes(layer.type ?? ''));
    }

    /** Returns whether an id names a lettering layer. */
    private isLetteringLayer(layerId: string): boolean {

        const layer = this.layersById_.get(layerId);
        return layer !== undefined
            && ['labels', 'lines'].includes(layer.type ?? '');
    }

    /** Validates terrain-source identity and uniqueness. */
    private validateTerrainIds(sourceIds: string[]): void {

        const seen = new Set<string>();

        for (const id of sourceIds) {

            if (!this.surfaceSourceIds_.includes(id)) {
                throw new Error(
                    `"${id}" is not a terrain (cartolina-surface) `
                    + `source of this style.`);
            }

            if (seen.has(id))
                throw new Error(`Duplicate terrain source id "${id}".`);

            seen.add(id);
        }
    }

    private static slapResource(path: string, resource: string): string {

        if (path.endsWith('/')) return path + resource;
        return path;
    }

    private static registerCreditDefinitions(
        map: LegacyMap,
        credits: Record<string, MapCredit.Definition> | string[] | undefined,
    ): void {

        if (!credits || Array.isArray(credits)) return;

        for (const [id, definition] of Object.entries(credits))
            map.addCredit(id, new MapCredit(map, definition));
    }

    /**
     * Resolves a source definition from its URL or inline form.
     *
     * Called before any await in `loadStyle`, so the request starts as
     * the source loop reaches it. Being async also turns a synchronous
     * failure on an inline definition into a rejected promise.
     *
     * @param map map whose URL context resolves a relative source URL
     * @param sourceSpec the URL or inline form of one source
     * @param filename default document filename, appended to a trailing slash
     * @param resourceType resource kind reported to the request hook
     * @returns the definition and the path its relative URLs resolve against
     */
    private static async resolveSourceDefinition<T>(
        map: Map,
        sourceSpec: { url: string } | { definition: T },
        filename: string,
        resourceType: utils.RequestResourceType,
    ): Promise<[T, string]> {

        const legacyMap = map.legacyMap!;

        if ('definition' in sourceSpec)
            return [sourceSpec.definition, legacyMap.url.baseUrl];

        const path = MapStyle.slapResource(
            legacyMap.url.processUrl(sourceSpec.url), filename);

        const definition = await utils.loadJson(
            path, legacyMap.core.transformRequest, resourceType) as T;

        return [definition, path];
    }

    /** The map this style is installed on. */
    private map_: Map;

    /** The current mutable style. */
    private spec_: StyleSchema.StyleSpecification;

    /** Current layers keyed by runtime id. */
    private layersById_: globalThis.Map<
        string, StyleSchema.LayerSpecification>;

    /** Declared `cartolina-surface` ids in source order. */
    private surfaceSourceIds_: string[] = [];

    /**
     * Ids whose `addSource` load is in flight. Rejects a concurrent
     * second add of the same id; private to `addSource`, never observed
     * by lookup, terrain selection, or the render path.
     */
    private pendingSources_ = new Set<string>();
}


export default MapStyle;
