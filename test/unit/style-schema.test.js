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
                definition: {
                    url: 'tiles/{lod}-{x}-{y}.jpg',
                    lodRange: [0, 4],
                    tileRange: [[0, 0], [0, 0]],
                    id: 12,
                    dataType: 'classification',
                },
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
            normalized.sources.imagery.definition.dataType,
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


describe('inline style sources', function() {

    const credit = (notice) => ({ id: notice, notice });
    const terrainDefinition = (outerCredits, surfaceCredits) => ({
        referenceFrame: { id: 'test-frame' },
        srses: {},
        surfaces: [{ credits: surfaceCredits }],
        credits: outerCredits,
    });
    const rasterDefinition = (credits) => ({
        url: 'tiles/{lod}-{x}-{y}.jpg',
        lodRange: [0, 4],
        tileRange: [[0, 0], [0, 0]],
        credits,
    });

    it('requires exactly one of url and definition', function() {

        const both = style({ type: 'constant', source: [1, 1, 1] }, {
            broken: {
                type: 'cartolina-tms',
                url: 'https://maps.example.com/source.json',
                definition: rasterDefinition(),
            },
        });
        const neither = style({ type: 'constant', source: [1, 1, 1] }, {
            broken: { type: 'cartolina-freelayer' },
        });

        assert.throws(() => validateAndNormalizeStyle(both), /Invalid style/);
        assert.throws(
            () => validateAndNormalizeStyle(neither), /Invalid style/);
    });

    it('accepts equal inline credit definitions across source kinds',
        function() {

        const shared = credit('shared');
        const input = style({ type: 'constant', source: [1, 1, 1] }, {
            surface: {
                type: 'cartolina-surface',
                definition: terrainDefinition({ shared }),
            },
            raster: {
                type: 'cartolina-tms',
                definition: rasterDefinition({ shared }),
            },
            free: {
                type: 'cartolina-freelayer',
                definition: { type: 'geodata', credits: { shared } },
            },
        });

        assert.doesNotThrow(() => validateAndNormalizeStyle(input));
    });

    it('rejects conflicting inline non-terrain credits', function() {

        const input = style({ type: 'constant', source: [1, 1, 1] }, {
            raster: {
                type: 'cartolina-tms',
                definition: rasterDefinition({
                    shared: credit('raster'),
                }),
            },
            free: {
                type: 'cartolina-freelayer',
                definition: {
                    type: 'geodata',
                    credits: { shared: credit('free') },
                },
            },
        });

        assert.throws(() => validateAndNormalizeStyle(input),
            /"raster" and "free"/);
    });

    it('uses a terrain entry credit over its outer definition', function() {

        const effective = credit('surface entry');
        const input = style({ type: 'constant', source: [1, 1, 1] }, {
            surface: {
                type: 'cartolina-surface',
                definition: terrainDefinition(
                    { shared: credit('outer') }, { shared: effective }),
            },
            raster: {
                type: 'cartolina-tms',
                definition: rasterDefinition({ shared: effective }),
            },
        });

        assert.doesNotThrow(() => validateAndNormalizeStyle(input));
    });
});
