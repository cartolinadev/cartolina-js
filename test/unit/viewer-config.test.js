/*
 * viewer-config.test.js - unit tests for the config normalization in
 * src/viewer-config.ts
 *
 * Run with `npm run test:unit`, which compiles the module under test
 * to tmp/unit-build before mocha executes this file. Values are
 * passed the way an untyped JavaScript call site would: arbitrary
 * runtime values with no compile-time checking.
 */

const assert = require('assert');

const {
    assertConstructionConfigKeys,
    canonicalConfigKey,
    defaultViewerConfig,
    isPublicRuntimeConfigKey,
    looksLikeConfigKey,
    normalizeConfigPatch,
    normalizeConfigValue,
    publicConstructionConfigKeys,
    publicRuntimeConfigKeys,
    urlParseKind,
} = require('../../tmp/unit-build/src/viewer-config');

describe('viewer-config normalization', function() {

    it('uses the native style-map interaction and control defaults',
        function() {

        const defaults = defaultViewerConfig();

        assert.deepStrictEqual({
            controlMeasure: defaults.controlMeasure,
            jumpAllowed: defaults.jumpAllowed,
            controlSearch: defaults.controlSearch,
            controlZoom: defaults.controlZoom,
            controlSpace: defaults.controlSpace,
            controlCompass: defaults.controlCompass,
        }, {
            controlMeasure: false,
            jumpAllowed: true,
            controlSearch: false,
            controlZoom: false,
            controlSpace: false,
            controlCompass: false,
        });
    });

    it('resolves the legacy key aliases', function() {

        assert.strictEqual(canonicalConfigKey('pos'), null);
        assert.strictEqual(canonicalConfigKey('rotate'), 'autoRotate');
        assert.strictEqual(canonicalConfigKey('pan'), 'autoPan');
        assert.strictEqual(canonicalConfigKey('mapCache'), 'mapCache');
        assert.strictEqual(canonicalConfigKey('noSuchKey'), null);
    });

    it('returns null patches for unknown keys', function() {

        assert.strictEqual(normalizeConfigPatch('noSuchKey', 1), null);
        assert.strictEqual(normalizeConfigPatch('container', 'map'), null);
    });

    it('coerces invalid booleans and clamps numbers', function() {

        assert.strictEqual(
            normalizeConfigValue('mapFlagLighting', 'yes'), true);
        assert.strictEqual(
            normalizeConfigValue('mapCache', 'bogus'), 1100);
        assert.strictEqual(
            normalizeConfigValue('rendererCssDpi', 5000), 1200);
    });

    it('falls back to the catalogue default on invalid input',
        function() {

        // reconciled keys whose legacy switch fallback diverged
        // from the catalogue default (rfc1-config-store.md, step 7)
        const defaults = defaultViewerConfig();
        const reconciled = {
            mapCache: 'bogus',
            mapDownloadThreads: null,
            mapMaxProcessingTime: {},
            minViewExtent: 'x',
            controlSpace: 7,
            controlSearch: 7,
            controlSearchFilter: 7,
            controlFullscreen: 7,
            mapFeaturesReduceMode: 42,
            mapDefaultFont: false,
        };

        for (const key of Object.keys(reconciled)) {
            assert.deepStrictEqual(
                normalizeConfigValue(key, reconciled[key]),
                defaults[key],
                key);
        }
    });

    it('produces fresh array allocations per store and per '
        + 'fallback', function() {

        const first = defaultViewerConfig();
        const second = defaultViewerConfig();

        assert.notStrictEqual(first.sensitivity, second.sensitivity);
        assert.notStrictEqual(
            first.mapFeaturesReduceParams,
            second.mapFeaturesReduceParams);

        const fallback1 = normalizeConfigValue('sensitivity', 'x');
        const fallback2 = normalizeConfigValue('sensitivity', 'x');

        assert.deepStrictEqual(fallback1, first.sensitivity);
        assert.notStrictEqual(fallback1, fallback2);
        assert.notStrictEqual(fallback1, first.sensitivity);
    });

    it('throws from programmatic normalization for malformed '
        + 'geojsonStyle JSON', function() {

        assert.throws(
            () => normalizeConfigValue('geojsonStyle', '{bad json'));
    });

    it('resolves URL parse kinds through the catalogue', function() {

        assert.strictEqual(urlParseKind('mapFlagLighting'), 'boolean');
        assert.strictEqual(urlParseKind('mapCache'), 'number');
        assert.strictEqual(urlParseKind('sensitivity'), 'numberArray');
        assert.strictEqual(urlParseKind('mapLanguage'), 'string');
        assert.strictEqual(urlParseKind('pos'), null);
        assert.strictEqual(urlParseKind('rotate'), 'number');
        assert.strictEqual(urlParseKind('pan'), 'numberArray');
        assert.strictEqual(urlParseKind('transformRequest'), null);
        assert.strictEqual(urlParseKind('noSuchKey'), null);
        assert.strictEqual(urlParseKind('toString'), null);
    });

    it('flags config-prefixed keys as config-like, exempting '
        + 'mapConfig', function() {

        assert.strictEqual(
            looksLikeConfigKey('mapStructuralDescentBreak'), true);
        assert.strictEqual(looksLikeConfigKey('rendererFoo'), true);
        assert.strictEqual(looksLikeConfigKey('controlFoo'), true);
        assert.strictEqual(looksLikeConfigKey('debugFoo'), true);
        assert.strictEqual(looksLikeConfigKey('mapConfig'), false);
        assert.strictEqual(looksLikeConfigKey('utm_source'), false);
        assert.strictEqual(looksLikeConfigKey('container'), false);
    });

    it('keeps the audited public subset sizes', function() {

        // 61 runtime keys since RFC 11 promoted the corpus
        // browserOptions destinations (mapFeaturesReduceMode,
        // mapFeaturesReduceParams, mapSoftViewSwitch); the
        // construction set lost the geojson / geodata / geojsonStyle
        // startup options removed with the mapConfig runtime
        assert.strictEqual(publicRuntimeConfigKeys.length, 61);
        assert.strictEqual(publicConstructionConfigKeys.length, 70);
    });

    it('expands the mapNoTextures coupling', function() {

        assert.deepStrictEqual(
            normalizeConfigPatch('mapNoTextures', true),
            { mapNoTextures: true, mapDisableCulling: true });
    });

    it('rejects malformed mapFeaturesReduceParams', function() {

        const fallback = [0.05, 0.17, 11, 1, 1000];

        assert.deepStrictEqual(
            normalizeConfigValue('mapFeaturesReduceParams', 'x'),
            fallback);
        assert.deepStrictEqual(
            normalizeConfigValue('mapFeaturesReduceParams', [1, 'x']),
            fallback);
        assert.deepStrictEqual(
            normalizeConfigValue('mapFeaturesReduceParams', [NaN, 2]),
            fallback);
        assert.deepStrictEqual(
            normalizeConfigValue(
                'mapFeaturesReduceParams', [1, Infinity]),
            fallback);
        assert.deepStrictEqual(
            normalizeConfigValue('mapFeaturesReduceParams', [1, 2, 3]),
            [1, 2, 3]);
    });

    it('keeps debug values as strings or booleans only', function() {

        assert.strictEqual(normalizeConfigValue('debugBBox', 'LP'), 'LP');
        assert.strictEqual(normalizeConfigValue('debugLBox', true), true);
        assert.strictEqual(normalizeConfigValue('debugRadar', 7), null);
    });

    it('accepts only canonical catalogued keys as public runtime '
        + 'keys', function() {

        assert.strictEqual(
            isPublicRuntimeConfigKey('mapFlagLighting'), true);
        assert.strictEqual(
            isPublicRuntimeConfigKey('rendererCssDpi'), true);

        // a misspelled key
        assert.strictEqual(
            isPublicRuntimeConfigKey('mapFlagLigthing'), false);

        // catalogued keys outside the public subset
        assert.strictEqual(
            isPublicRuntimeConfigKey('rendererAntialiasing'), false);
        assert.strictEqual(
            isPublicRuntimeConfigKey('mapProfileGpu'), false);
        assert.strictEqual(isPublicRuntimeConfigKey('debugMode'), false);
        assert.strictEqual(isPublicRuntimeConfigKey('position'), false);

        // keys consumed only when their UI control is built
        assert.strictEqual(
            isPublicRuntimeConfigKey('controlLoading'), false);
        assert.strictEqual(
            isPublicRuntimeConfigKey('controlSearchElement'), false);

        // keys removed from the catalogue as dead configuration
        assert.strictEqual(
            canonicalConfigKey('mapFeaturesPerSquareInch'), null);
        assert.strictEqual(
            canonicalConfigKey('positionUrlHistory'), null);
        assert.strictEqual(canonicalConfigKey('controlGithub'), null);

        // legacy aliases stay confined to compatibility ingestion
        assert.strictEqual(isPublicRuntimeConfigKey('pos'), false);
        assert.strictEqual(isPublicRuntimeConfigKey('rotate'), false);
        assert.strictEqual(isPublicRuntimeConfigKey('pan'), false);
    });

    it('lists only canonical catalogued keys as public', function() {

        for (const key of publicRuntimeConfigKeys) {
            assert.strictEqual(canonicalConfigKey(key), key);
        }

        for (const key of publicConstructionConfigKeys) {
            assert.strictEqual(canonicalConfigKey(key), key);
        }
    });

    it('factory bags reject unknown keys and accept the '
        + 'catalogue while rejecting dedicated inputs', function() {

        assert.throws(
            () => assertConstructionConfigKeys({
                mapFlagLigthing: false,
            }),
            /not a known configuration key/);
        assert.throws(
            () => assertConstructionConfigKeys({
                entirelyInvented: true,
            }),
            /not a known configuration key/);
        assert.throws(
            () => assertConstructionConfigKeys({
                transformRequest: () => undefined,
            }),
            /top-level map\(\) option/);
        assert.throws(
            () => assertConstructionConfigKeys({
                interactive: false,
            }),
            /top-level map\(\) option/);

        // catalogued internals and aliases flow through the factory
        assert.doesNotThrow(() => assertConstructionConfigKeys({
            mapFlagLighting: false,
            mapExposeFpsToWindow: true,
            rotate: 1,
        }));
    });

    it('treats inherited object-property names as unknown '
        + 'keys', function() {

        const inheritedNames =
            ['toString', 'constructor', '__proto__', 'hasOwnProperty'];

        for (const name of inheritedNames) {

            assert.strictEqual(canonicalConfigKey(name), null);
            assert.throws(
                () => assertConstructionConfigKeys({ [name]: true }),
                /not a known configuration key/);
        }
    });
});
