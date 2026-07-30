/*
 * style-schema.test.js - static source/layer correspondence tests
 */

'use strict';

const assert = require('assert');

const { validateAndNormalizeStyle } =
    require('../../tmp/unit-build/src/map/style-schema');


function style(layer, sources = {}) {

    return {
        version: 2,
        sources: {
            terrain: {
                type: 'cartolina-surface',
                url: 'https://maps.example.com/mapConfig.json',
            },
            imagery: {
                type: 'cartolina-tms',
                data: {
                    url: 'tiles/{lod}-{x}-{y}.jpg',
                    lodRange: [0, 4],
                    tileRange: [[0, 0], [0, 0]],
                    id: 12,
                    dataType: 'classification',
                },
                baseUrl: 'https://maps.example.com/imagery/',
            },
            ...sources,
        },
        terrain: { sources: ['terrain'] },
        layers: [layer],
    };
}


describe('style raster source correspondence', function() {

    it('accepts an inline TMS definition with ignored legacy fields',
        function() {

        const normalized = validateAndNormalizeStyle(style({
            id: 'imagery-layer',
            type: 'diffuse-map',
            source: 'imagery',
        }));

        assert.strictEqual(
            normalized.sources.imagery.data.dataType,
            'classification');
    });

    it('rejects a missing raster source', function() {

        assert.throws(() => validateAndNormalizeStyle(style({
            id: 'missing-layer',
            type: 'diffuse-map',
            source: 'missing',
        })), /not a cartolina-tms source/);
    });

    it('rejects a raster layer that references a terrain source',
        function() {

        assert.throws(() => validateAndNormalizeStyle(style({
            id: 'wrong-kind',
            type: 'bump-map',
            source: 'terrain',
        })), /not a cartolina-tms source/);
    });

    it('retains the existing constant and lettering source rules',
        function() {

        assert.doesNotThrow(() => validateAndNormalizeStyle(style({
            id: 'constant-layer',
            type: 'constant',
            source: [1, 1, 1],
        })));

        assert.doesNotThrow(() => validateAndNormalizeStyle(style({
            id: 'labels-layer',
            type: 'labels',
            source: 'labels',
        }, {
            labels: {
                type: 'cartolina-freelayer',
                url: 'https://maps.example.com/freelayer.json',
            },
        })));
    });
});
