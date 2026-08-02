/*
 * terrain-source.test.js - deterministic surface metadata parsing and
 * URL tests
 *
 * Run with `npm run test:unit`, which compiles TerrainSource to
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

const TerrainSource =
    require('../../tmp/unit-build/src/map/terrain-source').default;


function fakeMap() {

    const credits = new Map();

    const legacyMap = {
        url: {
            makeUrl(template, vars, subId) {
                return template
                    .replace('{lod}', vars.lod)
                    .replace('{x}', vars.ix)
                    .replace('{y}', vars.iy)
                    .replace('{sub}', subId);
            },
        },
        addCredit(id, credit) {
            credits.set(id, credit);
        },
    };

    return {
        map: { legacyMap },
        credits,
    };
}


function definition(overrides = {}) {

    return {
        lodRange: [1, 15],
        tileRange: [[0, 0], [1, 1]],
        metaUrl: '{lod}-{x}-{y}.meta',
        navUrl: '{lod}-{x}-{y}.nav',
        meshUrl: '{lod}-{x}-{y}.bin',
        ...overrides,
    };
}


describe('TerrainSource', function() {

    it('normalizes supported fields and ignores retired metadata',
        function() {

        const { map } = fakeMap();
        const source = TerrainSource.fromMetadata(
            map, 'topoearth', definition({
            normalsUrl: '{lod}-{x}-{y}-{sub}.nm',

            // present in real surface documents, read by nothing
            id: 'topoearth-viewfinder-dem3',
            metaBinaryOrder: 5,
            metaDepth: 1,
            displaySize: 1024,
            textureLayer: 3,
            navDelta: 8,
            '2d': { metaUrl: 'x.meta', maskUrl: 'x.mask' },
        }), 'https://example.com/surface/');

        // the style source id is the source identity
        assert.strictEqual(source.id, 'topoearth');

        assert.deepStrictEqual(source.lodRange, [1, 15]);
        assert.strictEqual(
            source.metaUrl, 'https://example.com/surface/{lod}-{x}-{y}.meta');
        assert.strictEqual(
            source.meshUrl, 'https://example.com/surface/{lod}-{x}-{y}.bin');
        assert.strictEqual(source.specificity, Math.pow(2, 15) + 1);

        // tileRange is validated at the boundary but never exposed
        assert.strictEqual(source.tileRange, undefined);

        for (const retired of ['metaBinaryOrder', 'metaDepth', 'displaySize',
            'textureLayer', 'navDelta', '2d', 'type', 'hmapUrl',
            'styleSourceId', 'free', 'tree', 'style', 'stylesheet']) {

            assert.strictEqual(source[retired], undefined, retired);
        }

        assert.ok(Object.isFrozen(source));
        assert.ok(Object.isFrozen(source.lodRange));
    });

    it('omits absent optional resources', function() {

        const { map } = fakeMap();
        const source = TerrainSource.fromMetadata(
            map, 'dem', definition(), 'https://example.com/surface/');

        assert.strictEqual(source.textureUrl, undefined);
        assert.strictEqual(source.normalsUrl, undefined);
        assert.deepStrictEqual(source.credits, []);

        assert.throws(() => source.getTextureUrl([3, 1, 2], 0),
            /has no internal texture/);
        assert.throws(() => source.getNormalsUrl([3, 1, 2], 0),
            /has no normal maps/);
    });

    it('resolves relative, rooted, and absolute templates', function() {

        const { map } = fakeMap();
        const base = 'https://example.com/store/surface/mapConfig.json';

        const source = TerrainSource.fromMetadata(map, 'dem', definition({
            metaUrl: '//cdn.example.com/a.meta',
            navUrl: '/rooted/a.nav',
            meshUrl: 'https://other.example.com/a.bin',
            textureUrl: 'relative/a.jpg',
        }), base);

        assert.strictEqual(source.metaUrl, 'https://cdn.example.com/a.meta');
        assert.strictEqual(
            source.navUrl, 'https://example.com/rooted/a.nav');
        assert.strictEqual(
            source.meshUrl, 'https://other.example.com/a.bin');
        assert.strictEqual(source.textureUrl,
            'https://example.com/store/surface/relative/a.jpg');
    });

    it('expands tile and submesh placeholders', function() {

        const { map } = fakeMap();
        const source = TerrainSource.fromMetadata(map, 'dem', definition({
            textureUrl: '{lod}-{x}-{y}-{sub}.jpg',
            normalsUrl: '{lod}-{x}-{y}-{sub}.nm',
        }), 'https://example.com/s/');

        assert.strictEqual(source.getMetaUrl([3, 4, 5]),
            'https://example.com/s/3-4-5.meta');
        assert.strictEqual(source.getNavUrl([3, 4, 5]),
            'https://example.com/s/3-4-5.nav');
        assert.strictEqual(source.getMeshUrl([3, 4, 5]),
            'https://example.com/s/3-4-5.bin');
        assert.strictEqual(source.getTextureUrl([3, 4, 5], 2),
            'https://example.com/s/3-4-5-2.jpg');
        assert.strictEqual(source.getNormalsUrl([3, 4, 5], 0),
            'https://example.com/s/3-4-5-0.nm');
    });

    it('binds the owner map late for URL expansion', function() {

        const owner = { map: { legacyMap: null } };
        const source = TerrainSource.fromMetadata(
            owner.map, 'dem', definition(), 'https://example.com/s/');

        assert.throws(() => source.getMeshUrl([1, 0, 0]),
            /without a loaded map/);

        owner.map.legacyMap = fakeMap().map.legacyMap;

        assert.strictEqual(source.getMeshUrl([1, 0, 0]),
            'https://example.com/s/1-0-0.bin');
    });

    it('retains credit ids without registering definitions',
        function() {

        const inline = fakeMap();
        const withTable = TerrainSource.fromMetadata(
            inline.map, 'dem', definition({
                credits: { usgs: { id: 2, notice: 'USGS/NASA' } },
            }), 'https://example.com/s/');

        assert.deepStrictEqual(withTable.credits, ['usgs']);
        assert.strictEqual(inline.credits.size, 0);

        const listed = fakeMap();
        const withList = TerrainSource.fromMetadata(
            listed.map, 'dem', definition({ credits: ['usgs', 'jonathan'] }),
            'https://example.com/s/');

        assert.deepStrictEqual(withList.credits, ['usgs', 'jonathan']);
        assert.strictEqual(listed.credits.size, 0);
        assert.ok(Object.isFrozen(withList.credits));
    });

    it('rejects malformed definitions', function() {

        const { map } = fakeMap();
        const build = (overrides) => TerrainSource.fromMetadata(
            map, 'dem', definition(overrides), 'https://example.com/s/');

        assert.throws(() => build({ metaUrl: undefined }),
            /invalid metadata/);
        assert.throws(() => build({ lodRange: undefined }),
            /invalid metadata/);
        assert.throws(() => build({ lodRange: [1, 2, 3] }),
            /invalid metadata/);
        assert.throws(() => build({ credits: 'credits.json' }),
            /invalid metadata/);

        assert.throws(() => build({ meshUrl: '   ' }),
            /needs a metatile, navigation tile, and mesh URL/);
        assert.throws(() => build({ textureUrl: ' ' }),
            /empty textureUrl/);
        assert.throws(() => build({ normalsUrl: ' ' }),
            /empty normalsUrl/);

        assert.throws(() => build({ lodRange: [1, 1.5] }),
            /non-negative safe integers/);
        assert.throws(() => build({ lodRange: [-1, 4] }),
            /non-negative safe integers/);
        assert.throws(() => build({ lodRange: [9, 4] }),
            /descending lodRange/);
        assert.throws(() => build({ tileRange: [[4, 0], [1, 1]] }),
            /descending tileRange/);
    });
});
