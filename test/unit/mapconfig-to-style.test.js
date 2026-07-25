/*
 * mapconfig-to-style.test.js - unit tests for
 * src/compat/mapconfig-to-style.ts and the stylesheet linker
 *
 * Run with `npm run test:unit`, which compiles the module under test
 * to tmp/unit-build before mocha executes this file. All fetches go
 * through the converter's loadJson test seam; no network is used.
 */

const assert = require('assert');

const { mapConfigToStyle } =
    require('../../tmp/unit-build/src/compat/mapconfig-to-style');

const DOC_URL = 'https://maps.example.com/map/mapConfig.json';
const mapConfigViewerDefaults = {
    controlMeasure: false,
    jumpAllowed: false,
    controlSearch: true,
    controlZoom: true,
    controlSpace: true,
    controlCompass: true,
};

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function baseMapConfig() {

    return {
        referenceFrame: { id: 'melown2015', division: {} },
        srses: {
            'geographic-wgs84': {
                type: 'geographic',
                geoidGrid: { definition: 'grid.jpg' },
            },
        },
        bodies: { Earth: {} },
        credits: { c1: { id: 1, notice: 'credit one' } },
        services: { atmdensity: { url: 'atmdensity.png?def={param(0)}' } },
        surfaces: [{
            id: 'terrain-a',
            lodRange: [1, 15],
            meshUrl: '//cdn.example.com/a/{lod}-{x}-{y}.bin',
            metaUrl: '/meta/{lod}-{x}-{y}.meta',
            navUrl: 'nav/{lod}-{x}-{y}.nav',
            tileRange: [[0, 0], [1, 1]],
        }],
        boundLayers: {
            imagery: 'https://cdn.example.com/bl/imagery/boundlayer.json',
        },
        freeLayers: {},
        view: {
            surfaces: { 'terrain-a': ['imagery'] },
            freeLayers: {},
        },
        namedViews: {},
        position: ['obj', 15, 50, 'float', 0, 0, -90, 0, 1e6, 45],
        browserOptions: {},
        glue: [],
        virtualSurfaces: [],
        params: {},
        rois: [],
        version: 1,
        textureAtlasReady: false,
    };
}

function boundLayerDefinition() {

    return {
        id: 100,
        type: 'raster',
        url: '{lod}-{x}-{y}.jpg',
        lodRange: [1, 21],
        tileRange: [[0, 0], [0, 0]],
    };
}

function baseFixtures(doc) {

    return {
        [DOC_URL]: doc,
        'https://cdn.example.com/bl/imagery/boundlayer.json':
            boundLayerDefinition(),
    };
}

function loaderFor(fixtures) {

    return async (url) => {

        if (!(url in fixtures)) {
            throw new Error(`no fixture for ${url}`);
        }

        return structuredClone(fixtures[url]);
    };
}

function convert(doc, fixtures, options) {

    return mapConfigToStyle(DOC_URL, {
        loadJson: loaderFor(fixtures ?? baseFixtures(doc)),
        ...options,
    });
}

// ---------------------------------------------------------------------------

describe('mapConfigToStyle', function() {

    it('converts a single-surface mapConfig', async function() {

        const doc = baseMapConfig();
        const conversion = await convert(doc);

        // one inline surface source with absolute embedded URLs
        const surfaceSource = conversion.style.sources['terrain-a'];
        assert.strictEqual(surfaceSource.type, 'cartolina-surface');
        assert.strictEqual(
            surfaceSource.baseUrl, 'https://maps.example.com/map/');

        const surface = surfaceSource.data.surfaces[0];
        assert.strictEqual(surface.meshUrl,
            'https://cdn.example.com/a/{lod}-{x}-{y}.bin');
        assert.strictEqual(surface.metaUrl,
            'https://maps.example.com/meta/{lod}-{x}-{y}.meta');
        assert.strictEqual(surface.navUrl,
            'https://maps.example.com/map/nav/{lod}-{x}-{y}.nav');

        // shared metadata absolutized
        assert.strictEqual(
            surfaceSource.data.srses['geographic-wgs84']
                .geoidGrid.definition,
            'https://maps.example.com/map/grid.jpg');
        assert.strictEqual(
            surfaceSource.data.services.atmdensity.url,
            'https://maps.example.com/map/atmdensity.png'
            + '?def={param(0)}');

        // inline bound layer with absolute tile template
        const tms = conversion.style.sources['imagery'];
        assert.strictEqual(tms.type, 'cartolina-tms');
        assert.strictEqual(tms.data.url,
            'https://cdn.example.com/bl/imagery/{lod}-{x}-{y}.jpg');

        // terrain stack and the translated raster layer
        assert.deepStrictEqual(
            conversion.style.terrain.sources, ['terrain-a']);
        // string entries translate without a whitewash field,
        // matching the legacy generator
        assert.deepStrictEqual(conversion.style.layers, [{
            id: 'imagery',
            source: 'imagery',
            type: 'diffuse-map',
            blendMode: 'overlay',
            alpha: { mode: 'constant', value: 1.0 },
            terrain: ['terrain-a'],
        }]);

        // construction values beside the style
        assert.deepStrictEqual(conversion.position, doc.position);
        assert.deepStrictEqual(
            conversion.viewerOptions, mapConfigViewerDefaults);
        assert.deepStrictEqual(conversion.profiles, {});
        assert.deepStrictEqual(conversion.warnings, []);
        assert.deepStrictEqual(conversion.notes, []);
    });

    it('does not mutate an object input', async function() {

        const doc = baseMapConfig();
        const original = JSON.stringify(doc);

        await mapConfigToStyle(doc, {
            baseUrl: DOC_URL,
            loadJson: loaderFor(baseFixtures(doc)),
        });

        assert.strictEqual(JSON.stringify(doc), original);
    });

    it('rejects a relative URL of an object input without baseUrl',
        async function() {

        const doc = baseMapConfig();

        await assert.rejects(
            mapConfigToStyle(doc, {
                loadJson: loaderFor(baseFixtures(doc)),
            }),
            /ambiguous|base URL/);
    });

    it('translates raster parameters and alpha forms',
        async function() {

        const doc = baseMapConfig();
        doc.view.surfaces['terrain-a'] = [
            {
                id: 'imagery', type: 'diffuse-map', mode: 'normal',
                options: { whitewash: 0.15 },
            },
            {
                id: 'imagery', type: 'diffuse-map', mode: 'multiply',
                alpha: {
                    mode: 'view-dependent', value: 0.5,
                    illumination: [45, 45],
                },
            },
            { id: 'imagery', type: 'bump-map', alpha: 0.2 },
        ];

        const conversion = await convert(doc);
        const layers = conversion.style.layers;

        assert.strictEqual(layers.length, 3);

        // legacy "normal" becomes overlay; whitewash carried
        assert.strictEqual(layers[0].blendMode, 'overlay');
        assert.strictEqual(layers[0].whitewash, 0.15);

        // structured view-dependent alpha
        assert.deepStrictEqual(layers[1].alpha, {
            mode: 'viewdep', value: 0.5, illumination: [45, 45],
        });
        assert.strictEqual(layers[1].blendMode, 'multiply');

        // distinct presentations of one source get suffixed ids
        assert.strictEqual(layers[0].id, 'imagery');
        assert.strictEqual(layers[1].id, 'imagery-2');
        assert.strictEqual(layers[2].id, 'imagery-3');
        assert.strictEqual(layers[2].type, 'bump-map');
        assert.strictEqual(layers[2].alpha, 0.2);
    });

    it('notes raster entry keys the client ignores', async function() {

        const doc = baseMapConfig();
        doc.view.surfaces['terrain-a'] = [{
            id: 'imagery',
            type: 'diffuse-map',
            options: { shaderFilter: 'x', whitewash: 0.1 },
        }];

        const conversion = await convert(doc);

        const note = conversion.notes.find(
            (entry) => entry.path.endsWith('options.shaderFilter'));
        assert.ok(note);
        assert.strictEqual(note.code, 'ignored-field');
        assert.deepStrictEqual(conversion.warnings, []);
    });

    it('rejects unsupported raster parameter values', async function() {

        const doc = baseMapConfig();
        doc.view.surfaces['terrain-a'] = [
            { id: 'imagery', type: 'shadow-map' },
        ];

        await assert.rejects(convert(doc), /unsupported raster type/);
    });

    it('converts view options into root style fields', async function() {

        const doc = baseMapConfig();
        doc.view.options = {
            illumination: {
                ambientCoef: 0.25,
                light: ['tracking', 315, 45],
                useLighting: false,
            },
            superelevation: {
                heightRamp: [[0, 4000], [1.5, 1.3]],
                viewExtentProgression: [12.3, 13e6, 1.38, 1, 13.5],
            },
        };

        const conversion = await convert(doc);

        assert.deepStrictEqual(conversion.style.illumination,
            doc.view.options.illumination);
        assert.deepStrictEqual(
            conversion.style['vertical-exaggeration'],
            doc.view.options.superelevation);
    });

    it('normalizes the bare superelevation ramp array',
        async function() {

        const doc = baseMapConfig();
        doc.view.options = {
            superelevation: [[0, 4000], [1.5, 1.3]],
        };

        const conversion = await convert(doc);

        assert.deepStrictEqual(
            conversion.style['vertical-exaggeration'],
            { heightRamp: [[0, 4000], [1.5, 1.3]] });
    });

    it('rejects unknown options on the selected view', async function() {

        const doc = baseMapConfig();
        doc.view.options = { mystery: 1 };

        await assert.rejects(convert(doc), /unknown option "mystery"/);
    });

    it('classifies browser options into the three outcomes',
        async function() {

        const doc = baseMapConfig();
        doc.browserOptions = {
            // public catalogued keys: typed destinations
            controlMeasure: true,
            mapCache: 1000,
            mapFeaturesReduceMode: 'scr-count7',
            mapSoftViewSwitch: false,
            // proven current-client no-op: note
            mapGridTextureLayer: 'x',
            // diagnostics-only key: note
            mapLogGeodataStyles: false,
            // uncatalogued: the client drops it, note
            mapLoadMode: 'fitonly',
            // catalogued internal and still read: warning
            mapSplitMargin: 0.1,
        };

        const conversion = await convert(doc);

        assert.strictEqual(conversion.viewerOptions.controlMeasure, true);
        assert.strictEqual(conversion.viewerOptions.mapCache, 1000);
        assert.strictEqual(
            conversion.viewerOptions.mapFeaturesReduceMode,
            'scr-count7');
        assert.strictEqual(
            conversion.viewerOptions.mapSoftViewSwitch, false);

        const noteKeys = conversion.notes
            .filter((note) => note.code === 'ignored-browser-option')
            .map((note) => note.path);
        assert.deepStrictEqual(noteKeys.sort(), [
            'browserOptions.mapGridTextureLayer',
            'browserOptions.mapLoadMode',
            'browserOptions.mapLogGeodataStyles',
        ]);

        const warning = conversion.warnings.find((entry) =>
            entry.code === 'unsupported-browser-option');
        assert.ok(warning);
        assert.strictEqual(warning.path, 'browserOptions.mapSplitMargin');
    });

    it('applies valid browser options without accepting malformed overrides',
        async function() {

        const doc = baseMapConfig();
        doc.browserOptions = {
            jumpAllowed: true,
            controlSearch: false,
            controlZoom: 'invalid',
        };

        const conversion = await convert(doc);

        assert.deepStrictEqual(conversion.viewerOptions, {
            ...mapConfigViewerDefaults,
            jumpAllowed: true,
            controlSearch: false,
        });
    });

    it('merges per-surface layer orders topologically',
        async function() {

        const doc = baseMapConfig();
        doc.surfaces.push({
            id: 'terrain-b',
            lodRange: [1, 15],
            meshUrl: 'b/{lod}-{x}-{y}.bin',
            metaUrl: 'b/{lod}-{x}-{y}.meta',
            navUrl: 'b/{lod}-{x}-{y}.nav',
            tileRange: [[0, 0], [1, 1]],
        });

        doc.boundLayers = {
            'bl-x': 'https://cdn.example.com/bl/x/boundlayer.json',
            'bl-y': 'https://cdn.example.com/bl/y/boundlayer.json',
            'bl-z': 'https://cdn.example.com/bl/z/boundlayer.json',
        };

        // surface a omits bl-y; surface b needs it between x and z.
        // first-seen order would emit y after z and break surface b.
        doc.view.surfaces = {
            'terrain-a': ['bl-x', 'bl-z'],
            'terrain-b': ['bl-x', 'bl-y', 'bl-z'],
        };

        const fixtures = baseFixtures(doc);
        for (const key of ['x', 'y', 'z']) {
            fixtures[`https://cdn.example.com/bl/${key}/boundlayer.json`]
                = boundLayerDefinition();
        }

        const conversion = await convert(doc, fixtures);

        assert.deepStrictEqual(
            conversion.style.layers.map((layer) => layer.id),
            ['bl-x', 'bl-y', 'bl-z']);
        assert.deepStrictEqual(conversion.warnings, []);
    });

    it('slots named-view-only layers where their order demands',
        async function() {

        const doc = baseMapConfig();
        doc.boundLayers = {
            'bl-p': 'https://cdn.example.com/bl/p/boundlayer.json',
            'bl-q': 'https://cdn.example.com/bl/q/boundlayer.json',
            'bl-r': 'https://cdn.example.com/bl/r/boundlayer.json',
        };

        // r is used only by the named view, which needs it before q;
        // appending named-only layers after the initial order would
        // break that sequence
        doc.view.surfaces = { 'terrain-a': ['bl-p', 'bl-q'] };
        doc.namedViews = {
            other: { surfaces: { 'terrain-a': ['bl-r', 'bl-q'] } },
        };

        const fixtures = baseFixtures(doc);
        for (const key of ['p', 'q', 'r']) {
            fixtures[`https://cdn.example.com/bl/${key}/boundlayer.json`]
                = boundLayerDefinition();
        }

        const conversion = await convert(doc, fixtures);
        const ids = conversion.style.layers.map((layer) => layer.id);

        assert.ok(ids.indexOf('bl-r') < ids.indexOf('bl-q'));
        assert.ok(ids.indexOf('bl-p') < ids.indexOf('bl-q'));
        assert.deepStrictEqual(conversion.warnings, []);

        // named-only layers start inactive; the profile activates r
        const layerR = conversion.style.layers.find(
            (layer) => layer.id === 'bl-r');
        assert.deepStrictEqual(layerR.terrain, []);
        assert.deepStrictEqual(
            conversion.profiles.other.layers['bl-r'], ['terrain-a']);
    });

    it('warns on a genuinely irreproducible named-view order',
        async function() {

        const doc = baseMapConfig();
        doc.boundLayers = {
            'bl-x': 'https://cdn.example.com/bl/x/boundlayer.json',
            'bl-y': 'https://cdn.example.com/bl/y/boundlayer.json',
        };

        doc.view.surfaces = { 'terrain-a': ['bl-x', 'bl-y'] };
        doc.namedViews = {
            flipped: { surfaces: { 'terrain-a': ['bl-y', 'bl-x'] } },
        };

        const fixtures = baseFixtures(doc);
        for (const key of ['x', 'y']) {
            fixtures[`https://cdn.example.com/bl/${key}/boundlayer.json`]
                = boundLayerDefinition();
        }

        const conversion = await convert(doc, fixtures);

        // the initial view keeps its order; only the named view warns
        assert.deepStrictEqual(
            conversion.style.layers.map((layer) => layer.id),
            ['bl-x', 'bl-y']);

        const warnings = conversion.warnings.filter((entry) =>
            entry.code === 'layer-order-conflict');
        assert.strictEqual(warnings.length, 1);
        assert.strictEqual(warnings[0].path,
            'namedViews.flipped.surfaces.terrain-a');
    });

    it('notes non-empty ignored top-level fields', async function() {

        const doc = baseMapConfig();
        doc.glue = [{ id: ['terrain-a', 'other'] }];

        const conversion = await convert(doc);

        const note = conversion.notes.find(
            (entry) => entry.path === 'glue');
        assert.ok(note);
        assert.strictEqual(note.code, 'ignored-field');

        // empty declarations stay silent
        assert.ok(!conversion.notes.find(
            (entry) => entry.path === 'virtualSurfaces'));
    });

    it('keeps multi-surface stack order from the surfaces array',
        async function() {

        const doc = baseMapConfig();
        doc.surfaces.push({
            id: 'terrain-b',
            lodRange: [17, 22],
            meshUrl: 'b/{lod}-{x}-{y}.bin',
            metaUrl: 'b/{lod}-{x}-{y}.meta',
            navUrl: 'b/{lod}-{x}-{y}.nav',
            tileRange: [[0, 0], [1, 1]],
        });

        // dictionary order deliberately reversed: the array decides
        doc.view.surfaces = {
            'terrain-b': [],
            'terrain-a': ['imagery'],
        };

        const conversion = await convert(doc);

        assert.deepStrictEqual(conversion.style.terrain.sources,
            ['terrain-a', 'terrain-b']);

        // both surfaces carry the same shared metadata inline
        assert.ok(conversion.style.sources['terrain-b'].data);
        assert.deepStrictEqual(conversion.warnings, []);
    });

    it('translates named views into complete profiles',
        async function() {

        const doc = baseMapConfig();
        doc.namedViews = {
            bare: { surfaces: { 'terrain-a': [] }, freeLayers: {} },
        };

        const conversion = await convert(doc);
        const profile = conversion.profiles['bare'];

        assert.ok(profile);
        assert.deepStrictEqual(profile.terrain, ['terrain-a']);
        assert.deepStrictEqual(profile.layers, { imagery: [] });
    });

    it('warns on rendering options carried by a named view',
        async function() {

        const doc = baseMapConfig();
        doc.namedViews = {
            lit: {
                surfaces: { 'terrain-a': ['imagery'] },
                options: { superelevation: [[0, 1], [1, 1]] },
            },
        };

        const conversion = await convert(doc);

        const warning = conversion.warnings.find((entry) =>
            entry.code === 'unsupported-view-option');
        assert.ok(warning);
        assert.strictEqual(warning.path,
            'namedViews.lit.options.superelevation');
    });

    it('applies an explicit construction view', async function() {

        const doc = baseMapConfig();
        doc.namedViews = {
            empty: { surfaces: { 'terrain-a': [] }, freeLayers: {} },
        };

        const conversion = await convert(doc, undefined, {
            view: 'empty',
        });

        assert.deepStrictEqual(conversion.style.layers, []);

        await assert.rejects(
            convert(doc, undefined, { view: 'missing' }),
            /unknown view/);
    });

    it('fails strict mode on warnings but not on notes',
        async function() {

        const doc = baseMapConfig();
        doc.glue = [{ id: ['a', 'b'] }];          // note only
        const conversion = await convert(doc, undefined, {
            strict: true,
        });
        assert.ok(conversion.notes.length > 0);

        const doc2 = baseMapConfig();
        doc2.browserOptions = { mapSplitMargin: 0.1 };  // warning

        await assert.rejects(
            convert(doc2, undefined, { strict: true }),
            /strict mode rejects/);
    });

    it('warns on depthOffset and maxLod free-layer overrides',
        async function() {

        const doc = baseMapConfig();
        doc.freeLayers = {
            geo: 'https://cdn.example.com/fl/geo/freelayer.json',
        };
        doc.view.freeLayers = {
            geo: { style: 'override.style', depthOffset: -0.1 },
        };

        const fixtures = baseFixtures(doc);
        fixtures['https://cdn.example.com/fl/geo/freelayer.json'] = {
            type: 'geodata',
            geodata: 'geo?viewspec={viewspec}',
            style: 'style.json',
        };
        fixtures['https://maps.example.com/map/override.style'] = {
            layers: { peaks: { label: true } },
        };

        const conversion = await convert(doc, fixtures);

        const warning = conversion.warnings.find((entry) =>
            entry.path === 'view.freeLayers.geo.depthOffset');
        assert.ok(warning);
        assert.strictEqual(warning.code, 'unsupported-field');
    });
});

// ---------------------------------------------------------------------------

describe('mapConfigToStyle stylesheet linking', function() {

    function letteringMapConfig() {

        const doc = baseMapConfig();

        doc.freeLayers = {
            'alpha-source': 'https://cdn.example.com/fl/a/freelayer.json',
            'beta-source': 'https://cdn.example.com/fl/b/freelayer.json',
        };

        doc.view.freeLayers = {
            'alpha-source': {},
            'beta-source': {},
        };

        const fixtures = baseFixtures(doc);

        fixtures['https://cdn.example.com/fl/a/freelayer.json'] = {
            type: 'geodata-tiles',
            geodataUrl: '{lod}-{x}-{y}.geo',
            metaUrl: '{lod}-{x}-{y}.meta',
            lodRange: [1, 15],
            style: 'a.style',
        };

        fixtures['https://cdn.example.com/fl/b/freelayer.json'] = {
            type: 'geodata',
            geodata: 'geo?viewspec={viewspec}',
            style: 'b.style',
        };

        fixtures['https://cdn.example.com/fl/a/a.style'] = {
            constants: {
                '@name': { uppercase: '$name' },
                '@shared': 42,
            },
            fonts: {
                'noto': '//fonts.example.com/noto.fnt',
            },
            layers: {
                'labels-a': {
                    label: true,
                    'label-source': '{@name} ({@shared})',
                    'label-font': ['noto'],
                },
                'lines-a': { line: true, 'line-width': 2 },
            },
        };

        fixtures['https://cdn.example.com/fl/b/b.style'] = {
            constants: {
                '@name': { lowercase: '$name' },
                '@shared': 42,
            },
            fonts: {
                'noto': 'https://fonts.example.com/noto.fnt',
            },
            layers: {
                'labels-b': {
                    label: true,
                    'label-source': '@name',
                    'label-font': ['noto'],
                },
            },
        };

        return { doc, fixtures };
    }

    it('links resolved stylesheets: coalesce, qualify, and rewrite',
        async function() {

        const { doc, fixtures } = letteringMapConfig();
        const conversion = await convert(doc, fixtures);

        // equal symbols coalesce: one @shared, one noto font (the
        // protocol-relative URL absolutizes to the equal https form)
        assert.strictEqual(conversion.style.constants['@shared'], 42);
        assert.deepStrictEqual(conversion.style.fonts,
            { noto: 'https://fonts.example.com/noto.fnt' });

        // conflicting @name: the first resolved stylesheet keeps the
        // name, the later one gets a qualified name with rewritten
        // references
        assert.ok('@name' in conversion.style.constants);
        assert.ok('@name--beta-source' in conversion.style.constants);

        const layers = conversion.style.layers;
        const labelsA = layers.find((layer) => layer.id === 'labels-a');
        const linesA = layers.find((layer) => layer.id === 'lines-a');
        const labelsB = layers.find((layer) => layer.id === 'labels-b');

        // resolved-stylesheet order is source-id order: alpha-source
        // first, so its symbols keep their names and beta's
        // references are rewritten
        assert.strictEqual(
            labelsA['label-source'], '{@name} ({@shared})');
        assert.strictEqual(
            labelsB['label-source'], '@name--beta-source');

        // discriminators from the enabled properties
        assert.strictEqual(labelsA.type, 'labels');
        assert.strictEqual(linesA.type, 'lines');
        assert.strictEqual(labelsB.type, 'labels');
        assert.strictEqual(labelsB.source, 'beta-source');

        // the rename is an exact outcome: a note, never a warning
        const renameNotes = conversion.notes.filter(
            (note) => note.code === 'symbol-renamed');
        assert.strictEqual(renameNotes.length, 1);
        assert.deepStrictEqual(conversion.warnings, []);

        // strict mode passes with notes only
        await mapConfigToStyle(DOC_URL, {
            loadJson: loaderFor(fixtures),
            strict: true,
        });
    });

    it('rewrites layer references through null-target '
        + 'visibility-switch pairs', async function() {

        const { doc, fixtures } = letteringMapConfig();

        // both resolved stylesheets define "peaks" differently, so
        // the second one's family is renamed; its references must
        // follow, and the null-target pair must not warn
        fixtures['https://cdn.example.com/fl/a/a.style'].layers.peaks =
            { label: true, 'label-size': 10 };

        fixtures['https://cdn.example.com/fl/b/b.style'].layers.peaks =
            { label: true, 'label-size': 20 };
        fixtures['https://cdn.example.com/fl/b/b.style'].layers
            ['peaks-switch'] = {
                label: true,
                'visibility-switch':
                    [['@z7', null], ['@z6', 'peaks']],
                inherit: 'peaks',
            };

        const conversion = await convert(doc, fixtures);

        const renamed = conversion.style.layers.find(
            (layer) => layer.id === 'peaks--beta-source');
        assert.ok(renamed);

        const switcher = conversion.style.layers.find(
            (layer) => layer.id === 'peaks-switch');
        assert.deepStrictEqual(switcher['visibility-switch'],
            [['@z7', null], ['@z6', 'peaks--beta-source']]);
        assert.strictEqual(switcher.inherit, 'peaks--beta-source');

        assert.ok(!conversion.warnings.find((entry) =>
            entry.code === 'unresolved-reference'));
    });

    it('rejects mixed rules with an unsupported-rule warning',
        async function() {

        const { doc, fixtures } = letteringMapConfig();
        doc.namedViews = {
            detail: structuredClone(doc.view),
        };
        fixtures['https://cdn.example.com/fl/a/a.style'].layers.mixed = {
            label: true,
            line: true,
        };

        const conversion = await convert(doc, fixtures);

        const warning = conversion.warnings.find((entry) =>
            entry.code === 'unsupported-rule');
        assert.ok(warning);
        assert.ok(!conversion.style.layers.find(
            (layer) => layer.id === 'mixed'));

        const emittedIds = conversion.style.layers.map(
            (layer) => layer.id);
        assert.deepStrictEqual(
            Object.keys(conversion.profiles.detail.layers), emittedIds);
        assert.ok(!('mixed' in conversion.profiles.detail.layers));
    });

    it('falls back to the default stylesheet and then degrades',
        async function() {

        const { doc, fixtures } = letteringMapConfig();

        // view override points nowhere; the default remains usable
        doc.view.freeLayers['alpha-source'] =
            { style: 'missing.style' };

        const conversion = await convert(doc, fixtures);

        assert.ok(conversion.style.layers.find(
            (layer) => layer.id === 'labels-a'));
        assert.ok(conversion.warnings.find((entry) =>
            entry.code === 'stylesheet-unavailable'));

        // neither loads: the source survives without style layers
        delete fixtures['https://cdn.example.com/fl/a/a.style'];
        const degraded = await convert(doc, fixtures);

        assert.ok(degraded.style.sources['alpha-source']);
        assert.ok(!degraded.style.layers.find(
            (layer) => layer.id === 'labels-a'));
    });

    it('keeps the monolithic geodata definition inline',
        async function() {

        const { doc, fixtures } = letteringMapConfig();
        const conversion = await convert(doc, fixtures);

        const source = conversion.style.sources['beta-source'];
        assert.strictEqual(source.type, 'cartolina-freelayer');
        assert.strictEqual(source.data.type, 'geodata');
        assert.strictEqual(source.data.geodata,
            'https://cdn.example.com/fl/b/geo?viewspec={viewspec}');
    });

    it('activates the named view\'s own stylesheet when a free '
        + 'layer selects a different one per view', async function() {

        const doc = baseMapConfig();

        doc.freeLayers = {
            'solo-source': 'https://cdn.example.com/fl/solo/freelayer.json',
        };
        doc.view.freeLayers = { 'solo-source': {} };
        doc.namedViews = {
            alt: {
                surfaces: { 'terrain-a': ['imagery'] },
                freeLayers: {
                    'solo-source': {
                        style: 'https://cdn.example.com/fl/solo/b.style',
                    },
                },
            },
        };

        const fixtures = baseFixtures(doc);

        fixtures['https://cdn.example.com/fl/solo/freelayer.json'] = {
            type: 'geodata',
            geodata: 'geo?viewspec={viewspec}',
            style: 'https://cdn.example.com/fl/solo/a.style',
        };
        fixtures['https://cdn.example.com/fl/solo/a.style'] = {
            layers: { 'rule-a': { label: true, 'label-size': 10 } },
        };
        fixtures['https://cdn.example.com/fl/solo/b.style'] = {
            layers: { 'rule-b': { label: true, 'label-size': 20 } },
        };

        const conversion = await convert(doc, fixtures);
        const profile = conversion.profiles.alt;

        // "alt" selects b.style: its rule is active in that profile...
        assert.deepStrictEqual(profile.layers['rule-b'], ['terrain-a']);

        // ...and a.style's rule, which "alt" does not select, is not
        assert.deepStrictEqual(profile.layers['rule-a'], []);
    });

    it('does not let a qualified constant collide with the same '
        + 'resolved stylesheet\'s own conflicting symbol',
        async function() {

        const { doc, fixtures } = letteringMapConfig();

        fixtures['https://cdn.example.com/fl/a/a.style']
            .constants['@dup'] = 1;
        fixtures['https://cdn.example.com/fl/b/b.style']
            .constants['@dup'] = 2;
        fixtures['https://cdn.example.com/fl/b/b.style']
            .constants['@dup--beta-source'] = 99;

        const conversion = await convert(doc, fixtures);

        // all three survive under distinct keys: no silent overwrite
        assert.strictEqual(conversion.style.constants['@dup'], 1);
        assert.strictEqual(
            conversion.style.constants['@dup--beta-source'], 99);
        assert.strictEqual(
            conversion.style.constants['@dup--beta-source-x'], 2);
    });

    it('does not let a qualified layer id collide with the same '
        + 'resolved stylesheet\'s own conflicting layer',
        async function() {

        const { doc, fixtures } = letteringMapConfig();

        fixtures['https://cdn.example.com/fl/a/a.style'].layers.ridge =
            { label: true, 'label-size': 1 };
        fixtures['https://cdn.example.com/fl/b/b.style'].layers.ridge =
            { label: true, 'label-size': 2 };
        fixtures['https://cdn.example.com/fl/b/b.style'].layers
            ['ridge--beta-source'] = { label: true, 'label-size': 99 };

        const conversion = await convert(doc, fixtures);
        const byId = (id) =>
            conversion.style.layers.find((layer) => layer.id === id);

        // three distinct layers survive; no id is emitted twice
        assert.strictEqual(byId('ridge').type, 'labels');
        assert.strictEqual(byId('ridge--beta-source')['label-size'], 99);
        assert.strictEqual(byId('ridge--beta-source-x')['label-size'], 2);
    });

    it('keeps raster and lettering layer ids in one global space',
        async function() {

        const { doc, fixtures } = letteringMapConfig();

        // "imagery" is already a raster presentation id (the bound
        // layer of the same name); a same-named lettering rule must
        // be qualified, not collide
        fixtures['https://cdn.example.com/fl/a/a.style'].layers.imagery =
            { label: true, 'label-size': 5 };

        const conversion = await convert(doc, fixtures);
        const ids = conversion.style.layers.map((layer) => layer.id);

        assert.strictEqual(ids.filter((id) => id === 'imagery').length, 1);
        assert.ok(ids.includes('imagery--alpha-source'));

        const raster = conversion.style.layers.find(
            (layer) => layer.id === 'imagery');
        assert.strictEqual(raster.type, 'diffuse-map');
    });
});

// ---------------------------------------------------------------------------

describe('mapConfigToStyle transformRequest', function() {

    it('resolves logically and transports through the hook',
        async function() {

        const doc = baseMapConfig();

        // the hook rewrites transport to a proxy; fixtures exist at
        // the proxied URLs only
        const proxied = (url) =>
            url.replace('https://', 'https://proxy.example.com/');

        const fixtures = {
            [proxied(DOC_URL)]: doc,
            [proxied('https://cdn.example.com/bl/imagery/'
                + 'boundlayer.json')]: boundLayerDefinition(),
        };

        const requested = [];

        global.fetch = async (url) => {

            requested.push(url);

            if (!(url in fixtures)) {
                return { ok: false, status: 404, statusText: 'missing' };
            }

            return {
                ok: true,
                json: async () => structuredClone(fixtures[url]),
            };
        };

        try {

            const conversion = await mapConfigToStyle(DOC_URL, {
                transformRequest: (url) => ({ url: proxied(url) }),
            });

            // transport went through the proxy
            assert.ok(requested.every((url) =>
                url.startsWith('https://proxy.example.com/')));

            // the emitted style stores logical URLs: the relative
            // dependency resolved against the logical document URL
            assert.strictEqual(
                conversion.style.sources['imagery'].data.url,
                'https://cdn.example.com/bl/imagery/'
                + '{lod}-{x}-{y}.jpg');
            assert.strictEqual(
                conversion.style.sources['terrain-a'].data
                    .surfaces[0].navUrl,
                'https://maps.example.com/map/nav/{lod}-{x}-{y}.nav');

        } finally {

            delete global.fetch;
        }
    });
});
