/*
 * viewer-config.test.js - unit tests for the config normalization in
 * src/core/viewer-config.ts
 *
 * Run with `npm run test:unit`, which compiles the module under test
 * to tmp/unit-build before mocha executes this file. Values are
 * passed the way an untyped JavaScript call site would: arbitrary
 * runtime values with no compile-time checking.
 */

const assert = require('assert');

const {
    assertCataloguedConfigKeys,
    canonicalConfigKey,
    isPublicRuntimeConfigKey,
    normalizeConfigPatch,
    normalizeConfigValue,
    publicConstructionConfigKeys,
    publicRuntimeConfigKeys,
} = require('../../tmp/unit-build/src/core/viewer-config');

describe('viewer-config normalization', function() {

    it('resolves the legacy key aliases', function() {

        assert.strictEqual(canonicalConfigKey('pos'), 'position');
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
            normalizeConfigValue('mapCache', 'bogus'), 900);
        assert.strictEqual(
            normalizeConfigValue('rendererCssDpi', 5000), 1200);
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

    it('accepts only strings and plain objects for view, geojson, '
        + 'geodata, and style', function() {

        for (const key of ['view', 'geojson', 'geodata', 'style']) {

            assert.strictEqual(
                normalizeConfigValue(key, 'value'), 'value');
            assert.deepStrictEqual(
                normalizeConfigValue(key, { a: 1 }), { a: 1 });
            assert.strictEqual(normalizeConfigValue(key, 42), null);
            assert.strictEqual(
                normalizeConfigValue(key, [1, 2]), null);
            assert.strictEqual(
                normalizeConfigValue(key, new Date(0)), null);
        }
    });

    it('routes both geojsonStyle forms through the plain-object '
        + 'check', function() {

        assert.deepStrictEqual(
            normalizeConfigValue('geojsonStyle', '{"a": 1}'), { a: 1 });
        assert.deepStrictEqual(
            normalizeConfigValue('geojsonStyle', { a: 1 }), { a: 1 });
        assert.strictEqual(
            normalizeConfigValue('geojsonStyle', '42'), null);
        assert.strictEqual(
            normalizeConfigValue('geojsonStyle', '[]'), null);
        assert.strictEqual(
            normalizeConfigValue('geojsonStyle', [1]), null);
        assert.strictEqual(
            normalizeConfigValue('geojsonStyle', new Date(0)), null);
    });

    it('accepts position arrays and MapPosition-like objects for '
        + 'position', function() {

        const positionArray =
            ['obj', 15, 50, 'fix', 0, 0, 0, 0, 10000, 45];
        const positionLike = { toArray: () => positionArray };

        assert.deepStrictEqual(
            normalizeConfigValue('position', positionArray),
            positionArray);
        assert.strictEqual(
            normalizeConfigValue('position', positionLike),
            positionLike);
        assert.strictEqual(normalizeConfigValue('position', 42), null);
        assert.strictEqual(
            normalizeConfigValue('position', { lon: 15 }), null);
        assert.strictEqual(
            normalizeConfigValue('position', [{}]), null);
        assert.strictEqual(
            normalizeConfigValue('position', ['obj', NaN, 50]), null);
    });

    it('drops non-function transformRequest values', function() {

        const hook = () => ({ url: 'https://tiles.example.com/' });

        assert.strictEqual(
            normalizeConfigValue('transformRequest', hook), hook);
        assert.strictEqual(
            normalizeConfigValue('transformRequest', 'hook'), null);
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
        + 'catalogue', function() {

        assert.throws(
            () => assertCataloguedConfigKeys({ mapFlagLigthing: false }),
            /not a known configuration key/);
        assert.throws(
            () => assertCataloguedConfigKeys({ entirelyInvented: true }),
            /not a known configuration key/);

        // catalogued internals and aliases flow through the factory
        assert.doesNotThrow(() => assertCataloguedConfigKeys({
            mapFlagLighting: false,
            mapExposeFpsToWindow: true,
            rotate: 1,
        }));
    });
});
