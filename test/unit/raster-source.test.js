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
const TileMatch = RasterSource.TileMatch;


function fakeMap() {

    const credits = new Map();

    const creditMap = {
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
    };

    return {
        map: { legacyMap: creditMap },
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
        const source = RasterSource.fromMetadata(
            map, 'imagery', definition({
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
            RasterSource.fromMetadata(
                map, 'relative', definition(), base).url,
            'https://maps.example.com/metadata/tiles/'
                + '{lod}-{x}-{y}.jpg');
        assert.strictEqual(
            RasterSource.fromMetadata(map, 'protocol', definition({
                url: '//cdn.example.com/{lod}/{x}/{y}.png',
            }), base).url,
            'https://cdn.example.com/{lod}/{x}/{y}.png');
        assert.strictEqual(
            RasterSource.fromMetadata(map, 'root', definition({
                url: '/tiles/{lod}/{x}/{y}.png',
            }), base).url,
            'https://maps.example.com/tiles/{lod}/{x}/{y}.png');
        assert.strictEqual(
            RasterSource.fromMetadata(map, 'absolute', definition({
                url: 'http://cdn.example.com/{lod}/{x}/{y}.png',
            }), base).url,
            'http://cdn.example.com/{lod}/{x}/{y}.png');
    });

    it('expands URLs and classifies static tile-range matches',
        function() {

        const { map } = fakeMap();
        const source = RasterSource.fromMetadata(
            map, 'imagery', definition(),
            'https://maps.example.com/metadata/');

        assert.strictEqual(source.getUrl([3, 2, 3]),
            'https://maps.example.com/metadata/tiles/3-2-3.jpg');
        assert.strictEqual(source.matchTile([0, 0, 0]), TileMatch.None);
        assert.strictEqual(source.matchTile([1, 0, 0]), TileMatch.Direct);
        assert.strictEqual(source.matchTile([4, 7, 7]), TileMatch.Direct);
        assert.strictEqual(source.matchTile([5, 14, 14]),
            TileMatch.Ancestor);
        assert.strictEqual(source.matchTile([5, 32, 32]),
            TileMatch.None);
    });

    it('uses its typed map owner for runtime URL expansion', function() {

        const { map } = fakeMap();
        const source = RasterSource.fromMetadata(
            map, 'imagery', definition(),
            'https://maps.example.com/metadata/');

        map.legacyMap = {
            url: {
                makeUrl() {
                    return 'expanded-by-owner';
                },
            },
        };

        assert.strictEqual(source.getUrl([3, 2, 3]),
            'expanded-by-owner');
    });

    it('enables only paired metatile and mask coverage', function() {

        const { map } = fakeMap();
        const base = 'https://maps.example.com/metadata/';
        const paired = RasterSource.fromMetadata(
            map, 'paired', definition({
                metaUrl: 'coverage/{lod}-{x}-{y}.png',
                maskUrl: '/masks/{lod}-{x}-{y}.png',
            }), base);
        const maskOnly = RasterSource.fromMetadata(
            map, 'mask-only', definition({
                maskUrl: 'masks/{lod}-{x}-{y}.png',
            }), base);
        const plain = RasterSource.fromMetadata(
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

        assert.throws(() => RasterSource.fromMetadata(
            map, 'meta-only',
            definition({ metaUrl: 'meta.png' }), base),
        /metaUrl without maskUrl/);
        assert.throws(() => RasterSource.fromMetadata(
            map, 'empty-meta',
            definition({ metaUrl: '' }), base),
        /empty metaUrl/);
        assert.throws(() => RasterSource.fromMetadata(
            map, 'bad-range',
            definition({ lodRange: [1] }), base),
        /invalid metadata/);
        assert.throws(() => RasterSource.fromMetadata(
            map, 'missing-url', {
                lodRange: [1, 4],
                tileRange: [[0, 0], [1, 1]],
            }, base),
        /invalid metadata/);
        assert.throws(() => RasterSource.fromMetadata(
            map, 'bad-credits',
            definition({ credits: [17] }), base),
        /invalid metadata/);
        assert.throws(() => RasterSource.fromMetadata(
            map, 'external-credits',
            definition({ credits: 'credits.json' }), base),
        /invalid metadata/);
        assert.throws(() => RasterSource.fromMetadata(
            map, 'fractional-range', definition({
                lodRange: [1, 4.5],
            }), base),
        /non-negative safe integers/);
        assert.throws(() => RasterSource.fromMetadata(
            map, 'descending-lod', definition({
                lodRange: [4, 1],
            }), base),
        /descending lodRange/);
        assert.throws(() => RasterSource.fromMetadata(
            map, 'descending-tiles', definition({
                tileRange: [[2, 0], [1, 1]],
            }), base),
        /descending tileRange/);
    });
});
