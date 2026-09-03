/*
 * config-normalization.test.js - configuration adjustment diagnostics
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

global.document = {
    createElement() {

        return {
            set href(value) {

                const parsed = new URL(value);
                this.search = parsed.search;
            },
        };
    },
};

const viewerConfig = require('../tmp/unit-build/src/viewer-config');
const {
    runtimeOptionsFromUrl,
} = require('../tmp/unit-build/src/viewer/url-config');


test('normalization reports values the catalogue changes', () => {

    const invalid = viewerConfig.normalizeConfigInput(
        'mapHeightcoding', 'bs');
    const clamped = viewerConfig.normalizeConfigInput(
        'mapElevationStoreGPUCache', -1);
    const alias = viewerConfig.normalizeConfigInput('rotate', 12);
    const accepted = viewerConfig.normalizeConfigInput(
        'mapHeightcoding', 'store');

    assert.deepStrictEqual(
        [
            invalid.key,
            invalid.effectiveValue,
            invalid.adjusted,
        ],
        ['mapHeightcoding', 'legacy', true]);
    assert.deepStrictEqual(
        [clamped.effectiveValue, clamped.adjusted], [0, true]);
    assert.deepStrictEqual(
        [alias.key, alias.effectiveValue, alias.adjusted],
        ['autoRotate', 12, false]);
    assert.strictEqual(accepted.adjusted, false);
});


test('URL configuration warns once for an unused value', () => {

    const warnings = [];
    const warn = console.warn;
    console.warn = (message) => warnings.push(message);

    try {

        const options = runtimeOptionsFromUrl(
            undefined,
            'http://example.test/?mapHeightcoding=bs'
                + '&mapElevationStoreGPUCache=48'
                + '&mapFlagLighting=bs'
                + '&autoPan=1,nope',
        );

        assert.strictEqual(options.mapHeightcoding, 'legacy');
        assert.strictEqual(options.mapElevationStoreGPUCache, 48);
        assert.strictEqual(options.mapFlagLighting, true);
        assert.deepStrictEqual(options.autoPan, [1, 0]);
        assert.deepStrictEqual(warnings, [
            "Configuration value for 'mapHeightcoding' in "
                + 'runtimeOptionsFromUrl() was not used; supplied "bs", '
                + 'using "legacy".',
            "Configuration value for 'mapFlagLighting' in "
                + 'runtimeOptionsFromUrl() was not used; supplied "bs", '
                + 'using true.',
            "Configuration value for 'autoPan' in "
                + 'runtimeOptionsFromUrl() was not used; supplied [1,"nope"], '
                + 'using [1,0].',
        ]);

    } finally {

        console.warn = warn;
    }
});
