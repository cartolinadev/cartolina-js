/*
 * raster-source.test.js - deterministic metadata parsing and URL tests
 *
 * Run with `npm run test:unit`, which compiles RasterSource to
 * tmp/unit-build before mocha executes this file.
 */

'use strict';

const assert = require('assert');

global.document = {
    createElement() {

        let parsed = new URL('http://localhost/');

        return {
            set href(value) {
                parsed = new URL(value, 'http://localhost/');
            },
            get href() { return parsed.href; },
            get protocol() { return parsed.protocol; },
            get hostname() { return parsed.hostname; },
            get port() { return parsed.port; },
            get origin() { return parsed.origin; },
        };
    },
};

const RasterSource =
    require('../../tmp/unit-build/src/map/raster-source').default;


function fakeMap() {

    const credits = new Map();

    return {
        map: {
            url: {
                makeUrl(template, vars) {
                    return template
                        .replace('{lod}', vars.lod)
                        .replace('{x}', vars.ix)
                        .replace('{y}', vars.iy);
                },
            },
            addCredit(id, credit) {
                credits.set(id, credit);
            },
        },
        credits,
    };
}


function definition(overrides = {}) {

    return {
        url: 'tiles/{lod}-{x}-{y}.jpg',
        lodRange: [1, 4],
        tileRange: [[0, 0], [1, 1]],
        ...overrides,
    };
}


describe('RasterSource', function() {

    it('normalizes supported fields and ignores retired metadata',
        function() {

        const { map, credits } = fakeMap();
        const source = new RasterSource(map, 'imagery', definition({
            credits: {
                imagery: { id: 17, notice: 'Imagery credit' },
            },
            isTransparent: true,
            id: 99,
            type: 'raster',
            tileSize: [512, 512],
            currentAlpha: 0.25,
            dataType: 'classification',
            availability: { type: 'negative-code', codes: [404] },
            options: { shaderFilter: 'retired' },
        }), 'https://maps.example.com/metadata/source.json');

        assert.strictEqual(source.id, 'imagery');
        assert.strictEqual(source.url,
            'https://maps.example.com/metadata/tiles/'
            + '{lod}-{x}-{y}.jpg');
        assert.deepStrictEqual(source.lodRange, [1, 4]);
        assert.deepStrictEqual(source.tileRange, [[0, 0], [1, 1]]);
        assert.deepStrictEqual(source.credits, ['imagery']);
        assert.strictEqual(source.specificity, 18);
        assert.strictEqual(source.isTransparent, true);
        assert.ok(credits.has('imagery'));

        for (const key of [
            'numberId', 'type', 'tileSize', 'currentAlpha', 'dataType',
            'availability', 'options', 'shaderFilter', 'shaderFilters',
        ]) {
            assert.strictEqual(source[key], undefined);
        }

        assert.ok(Object.isFrozen(source));
        assert.ok(Object.isFrozen(source.lodRange));
        assert.ok(Object.isFrozen(source.tileRange));
        assert.ok(Object.isFrozen(source.credits));
    });

    it('resolves relative, protocol-relative, root and absolute URLs',
        function() {

        const { map } = fakeMap();
        const base = 'https://maps.example.com/metadata/source.json';

        assert.strictEqual(
            new RasterSource(map, 'relative', definition(), base).url,
            'https://maps.example.com/metadata/tiles/'
                + '{lod}-{x}-{y}.jpg');
        assert.strictEqual(
            new RasterSource(map, 'protocol', definition({
                url: '//cdn.example.com/{lod}/{x}/{y}.png',
            }), base).url,
            'https://cdn.example.com/{lod}/{x}/{y}.png');
        assert.strictEqual(
            new RasterSource(map, 'root', definition({
                url: '/tiles/{lod}/{x}/{y}.png',
            }), base).url,
            'https://maps.example.com/tiles/{lod}/{x}/{y}.png');
        assert.strictEqual(
            new RasterSource(map, 'absolute', definition({
                url: 'http://cdn.example.com/{lod}/{x}/{y}.png',
            }), base).url,
            'http://cdn.example.com/{lod}/{x}/{y}.png');
    });

    it('expands URLs and preserves tile-range influence tests',
        function() {

        const { map } = fakeMap();
        const source = new RasterSource(
            map, 'imagery', definition(),
            'https://maps.example.com/metadata/');

        assert.strictEqual(source.getUrl([3, 2, 3]),
            'https://maps.example.com/metadata/tiles/3-2-3.jpg');
        assert.strictEqual(source.hasTileOrInfluence([0, 0, 0]), 0);
        assert.strictEqual(source.hasTileOrInfluence([1, 0, 0]), 2);
        assert.strictEqual(source.hasTileOrInfluence([4, 7, 7]), 2);
        assert.strictEqual(source.hasTileOrInfluence([5, 14, 14]), 1);
        assert.strictEqual(source.hasTileOrInfluence([5, 32, 32]), 0);
    });

    it('enables only paired metatile and mask coverage', function() {

        const { map } = fakeMap();
        const base = 'https://maps.example.com/metadata/';
        const paired = new RasterSource(map, 'paired', definition({
            metaUrl: 'coverage/{lod}-{x}-{y}.png',
            maskUrl: '/masks/{lod}-{x}-{y}.png',
        }), base);
        const maskOnly = new RasterSource(map, 'mask-only', definition({
            maskUrl: 'masks/{lod}-{x}-{y}.png',
        }), base);
        const plain = new RasterSource(
            map, 'plain', definition(), base);

        assert.deepStrictEqual(paired.coverage, {
            metaUrl:
                'https://maps.example.com/metadata/coverage/'
                    + '{lod}-{x}-{y}.png',
            maskUrl:
                'https://maps.example.com/masks/{lod}-{x}-{y}.png',
        });
        assert.strictEqual(paired.getMetatileUrl([2, 1, 0]),
            'https://maps.example.com/metadata/coverage/2-1-0.png');
        assert.strictEqual(paired.getMaskUrl([2, 1, 0]),
            'https://maps.example.com/masks/2-1-0.png');
        assert.strictEqual(maskOnly.coverage, undefined);
        assert.strictEqual(plain.coverage, undefined);
        assert.throws(
            () => plain.getMaskUrl([1, 0, 0]),
            /has no coverage/);
    });

    it('rejects meta-only and malformed definitions', function() {

        const { map } = fakeMap();
        const base = 'https://maps.example.com/metadata/';

        assert.throws(() => new RasterSource(
            map, 'meta-only', definition({ metaUrl: 'meta.png' }), base),
        /metaUrl without maskUrl/);
        assert.throws(() => new RasterSource(
            map, 'empty-meta', definition({ metaUrl: '' }), base),
        /invalid metaUrl/);
        assert.throws(() => new RasterSource(
            map, 'bad-range', definition({ lodRange: [1] }), base),
        /invalid lodRange/);
        assert.throws(() => new RasterSource(
            map, 'missing-url', {
                lodRange: [1, 4],
                tileRange: [[0, 0], [1, 1]],
            }, base),
        /no tile URL/);
    });
});
