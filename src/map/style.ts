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

                // process the definition
                if (result.status === 'fulfilled') {

                    const [definitionValue, path] = result.value;

                    const definition =
                        StyleValidation.validateSurfaceDefinition(
                            id, definitionValue);

                    if (!mapMetadataInitialized) {

                        // the first terain source initializes the map's 
                        // reference frame, SRSes, bodies, and credits.
                        MapStyle.initializeMapMetadata(
                            map, spec, definition, path);
                        mapMetadataInitialized = true;

                    } else {

                        // verify that later terrain uses the same reference 
                        // frame as the first
                        const frameId = definition.referenceFrame.id;

                        if (frameId !== legacyMap.referenceFrame!.id)
                            utils.warnOnce(`Terrain source "${id}" declares `
                                + `reference frame "${frameId}"; the map uses `
                                + `"${legacyMap.referenceFrame!.id}" from the `
                                + `first terrain source.`);
                    }

                    // a terrain source must define exactly one surface.
                    if (definition.surfaces.length != 1)
                        throw Error(`The url for source ${id} does not define `
                            + `exactly one surface, bailing out.`);

                    // initialize and register the terrain source.
                    // note that terrain source constructor currently does 
                    // not work with per-surface credits - credits are based
                    // on metanode content. This is the legacy VTS data model
                    // to be replaced with per-surface credit definition.
                    const surfaceDefinition = definition.surfaces[0];
                    const source = TerrainSource.fromMetadata(
                        map, id, surfaceDefinition, path);

                    terrainSources.set(id, source);

                    // update the global credit lookup table
                    MapStyle.registerCreditDefinitions(
                        legacyMap, definition.credits);

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

                        // initialize and register the raster source
                        const source = RasterSource.fromMetadata(
                            map, id, definition, path);

                        // update the global credit lookup table
                        MapStyle.registerCreditDefinitions(
                            legacyMap,
                            (definition as StyleSchema.TmsSourceDefinition)
                                .credits,
                        );

                        // publish the entry after every step that can fail
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
            legacyMap.renderer.setSuperElevationState(true);

            if ('elevationRamp' in veSpec || 'scaleRamp' in veSpec)
                legacyMap.renderer.setVerticalExaggeration(veSpec);
            else
                // @deprecated legacy heightRamp / viewExtentProgression format
                legacyMap.renderer.setSuperElevation(veSpec as any);
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
        const style = new MapStyle(legacyMap, spec);
        map.assertRasterSourcesAvailable(style.style());
        legacyMap.style = style;
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
     * Rebuilds the legacy map free-layer sequence and its lettering styles.
     *
     * @internal Called after style changes and by legacy free-layer callbacks.
     */
    refreshFreeLayerSequence(): void {

        const map = this.map;
        const spec = this.spec_;

        // Every active terrain source must resolve before lettering is
        // compiled; resolveTerrainSource throws when one does not.
        spec.terrain.sources.forEach((sourceId: string) =>
            map.outerMap.resolveTerrainSource(sourceId));

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
        map.freeLayerSequence = [];

        for (const [id, stylesheet] of Object.entries(freeLayerStyles)) {

            const freeLayer = map.getFreeLayer(id);
            if (!freeLayer) continue;

            map.freeLayerSequence.push(freeLayer);
            freeLayer.setStyle(stylesheet);
        }
    }

    /**
     * Creates the style owner after source loading has prepared the style.
     * 
     * Not called directly, invoked by the loadStyle() factory method.
     *
     * @param map legacy map receiving the style-derived free-layer sequence
     * @param spec current style with a runtime id on every layer
     */
    private constructor(map: LegacyMap, spec: StyleSchema.StyleSpecification) {

        this.map = map;
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

        this.map.outerMap.assertRasterSourcesAvailable(spec);
        this.spec_ = spec;
        this.layersById_ = layersById;
        this.refresh(clearLetteringHysteresis);
    }

    /** Rebuilds derived state and schedules a complete redraw. */
    private refresh(clearLetteringHysteresis: boolean): void {

        // Recompiled lettering must not inherit the previous rules' fades.
        if (clearLetteringHysteresis)
            this.map.renderer.draw.clearJobHBuffer();

        // Rebuild the free-layer sequence before the next rendered frame.
        this.map.viewCounter++;
        this.refreshFreeLayerSequence();
        this.map.dirty = true;
        this.map.hitMapDirty = true;
        this.map.geoHitMapDirty = true;
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

    /** Legacy map receiving the style-derived free-layer sequence. */
    map: LegacyMap;

    /** The current mutable style. */
    private spec_: StyleSchema.StyleSpecification;

    /** Current layers keyed by runtime id. */
    private layersById_: globalThis.Map<
        string, StyleSchema.LayerSpecification>;

    /** Declared `cartolina-surface` ids in source order. */
    private surfaceSourceIds_: string[] = [];
}


export default MapStyle;
