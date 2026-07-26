/*
 * url-config.test.js - unit tests for the URL ingestion boundary in
 * src/viewer/url-config.ts
 *
 * Run with `npm run test:unit`. The URL is always passed explicitly,
 * so the module never touches `window` here.
 */

const assert = require('assert');

const {
    runtimeOptionsFromUrl,
} = require('../../tmp/unit-build/src/viewer/url-config');

describe('url-config runtime options', function() {

    // utils/url.js parses URLs through a document anchor element;
    // node has no document, so the anchor is backed by the URL class
    before(function() {
        global.document = {
            createElement: () => {
                let parsed;
                return {
                    set href(value) { parsed = new URL(value); },
                    get search() { return parsed.search; },
                };
            },
        };
    });

    after(function() {
        delete global.document;
    });

    let warnings;
    let originalWarn;

    beforeEach(function() {
        warnings = [];
        originalWarn = console.warn;
        console.warn = (message) => warnings.push(String(message));
    });

    afterEach(function() {
        console.warn = originalWarn;
    });

    it('keeps catalogued keys, parsed by their URL kinds', function() {

        const options = runtimeOptionsFromUrl({},
            'http://localhost/?mapCache=500&mapFlagLighting=1'
            + '&sensitivity=1,0.06,0.05');

        assert.strictEqual(options.mapCache, 500);
        assert.strictEqual(options.mapFlagLighting, true);
        assert.deepStrictEqual(options.sensitivity, [1, 0.06, 0.05]);
        assert.strictEqual(warnings.length, 0);
    });

    it('warns once for a dropped config-prefixed unknown key',
        function() {

        const options = runtimeOptionsFromUrl({},
            'http://localhost/?mapStructuralDescentBreak=0.5');

        assert.strictEqual('mapStructuralDescentBreak' in options,
            false);
        assert.strictEqual(warnings.length, 1);
        assert.ok(warnings[0].indexOf(
            'mapStructuralDescentBreak') !== -1);
    });

    it('drops unprefixed unknown keys silently', function() {

        const options = runtimeOptionsFromUrl({},
            'http://localhost/?utm_source=z&foo=1');

        assert.strictEqual('utm_source' in options, false);
        assert.strictEqual('foo' in options, false);
        assert.strictEqual(warnings.length, 0);
    });

    it('excludes dedicated factory inputs and mapConfig without warning',
        function() {

        const options = runtimeOptionsFromUrl({},
            'http://localhost/?mapConfig=x/mapConfig.json'
            + '&pos=obj,15,50,fix,0,0,0,0,1000,45&style=y.json'
            + '&interactive=false');

        assert.strictEqual('mapConfig' in options, false);
        assert.strictEqual('pos' in options, false);
        assert.strictEqual('style' in options, false);
        assert.strictEqual('interactive' in options, false);
        assert.strictEqual(warnings.length, 0);
    });

    it('resolves the historic query-key misspellings', function() {

        const options = runtimeOptionsFromUrl({},
            'http://localhost/?zoomAlowed=true');

        assert.strictEqual(options.zoomAllowed, true);
        assert.strictEqual(warnings.length, 0);
    });

    it('drops an uncatalogued unprefixed query key silently',
        function() {

        const options = runtimeOptionsFromUrl({},
            'http://localhost/?geojsonStyle={x}&mapCache=500');

        assert.strictEqual('geojsonStyle' in options, false);
        assert.strictEqual(options.mapCache, 500);
        assert.strictEqual(warnings.length, 0);
    });
});
