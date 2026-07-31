/*
 * terrain-source-lifecycle.js - terrain-source loading and registry
 * regression gate. Requires the development server on
 * http://localhost:8080.
 */

'use strict';

const { chromium } = require('playwright');

const BASE = 'http://localhost:8080';
const STYLE_URL = BASE + '/demos/map/?style=complex';


async function main() {

    const browser = await chromium.launch({
        headless: true,
        args: ['--use-angle=gl', '--ignore-gpu-blocklist'],
    });

    const page = await browser.newPage({
        viewport: { width: 1200, height: 800 },
    });

    const failures = [];

    page.on('pageerror', (error) => {
        failures.push('pageerror: ' + error.message);
    });

    page.on('console', (message) => {
        if (message.type() === 'error')
            failures.push('console: ' + message.text());
    });

    page.on('requestfailed', (request) => {

        const failure = request.failure();
        if (failure && !/ERR_ABORTED/.test(failure.errorText))
            failures.push('network: ' + request.url());
    });

    await page.goto(STYLE_URL, { waitUntil: 'load', timeout: 90000 });
    await page.waitForFunction(() => globalThis.v, null, { timeout: 60000 });
    await page.evaluate(() => globalThis.v.ready);

    const results = await page.evaluate(async () => {

        const out = [];
        const check = (name, condition) => out.push([name, !!condition]);

        const viewer = globalThis.v;
        const map = viewer.map;
        const legacy = map.map;

        // --- registry population -------------------------------------

        const styleSpec = legacy.style.style();
        const terrainIds = styleSpec.terrain.sources;

        check('style declares terrain sources', terrainIds.length > 0);

        const sources = map.surfaceList();

        check('surfaceList resolves every terrain source',
            sources.length === terrainIds.length);

        check('terrain source id is the style source id',
            sources.every((source, index) =>
                source.id === terrainIds[index]));

        check('an unregistered source id throws', (() => {
            try {
                map.resolveTerrainSource('no-such-source');
                return false;
            } catch (error) {
                return /no surface was loaded/.test(error.message);
            }
        })());

        // --- immutable resolved state --------------------------------

        const first = sources[0];

        check('terrain source is frozen', Object.isFrozen(first));
        check('lodRange is frozen', Object.isFrozen(first.lodRange));

        check('resource templates are absolute',
            first.metaUrl.startsWith('http')
            && first.navUrl.startsWith('http')
            && first.meshUrl.startsWith('http'));

        check('retired surface metadata is absent at runtime',
            first.tileRange === undefined
            && first.displaySize === undefined
            && first.metaBinaryOrder === undefined
            && first.styleSourceId === undefined
            && first.type === undefined
            && first.hmapUrl === undefined
            && first.style === undefined);

        check('the legacy surface array is gone',
            legacy.surfaces === undefined);

        // --- URL expansion -------------------------------------------

        const metaUrl = first.getMetaUrl([3, 4, 5]);

        check('metatile URL expands the tile address',
            metaUrl.includes('3') && !metaUrl.includes('{lod}'));

        check('absent optional resources throw', (() => {

            if (first.normalsUrl !== undefined) return true;

            try {
                first.getNormalsUrl([3, 4, 5], 0);
                return false;
            } catch (error) {
                return /has no normal maps/.test(error.message);
            }
        })());

        // --- helper trees --------------------------------------------

        const trees = map.surfaceTreesForQuery();

        check('one helper tree per terrain source',
            trees.length === sources.length);

        check('each helper tree binds its terrain source',
            trees.every((tree, index) =>
                tree.freeLayerSurface === sources[index]));

        // --- tiles bind the terrain source ---------------------------

        const rootTile = trees[0].surfaceTree;

        check('tiles bind the resolved terrain source',
            rootTile.surface === sources[0]);

        // --- credits -------------------------------------------------

        check('surface document credits stay registered',
            Object.keys(legacy.credits).length > 0);

        // the visible set fills as tiles draw, not at readiness
        const visibleCredits = async () => {

            for (let attempt = 0; attempt < 40; attempt++) {

                const visible = Object.keys(legacy.visibleCredits.imagery)
                    .concat(Object.keys(legacy.visibleCredits.mapdata));

                if (visible.length > 0) return visible;

                await new Promise((resolve) => setTimeout(resolve, 250));
            }

            return [];
        };

        const visible = await visibleCredits();

        check('every visible credit resolves',
            visible.length > 0 && visible.every((id) =>
                legacy.getCreditInfo(id).html !== undefined));

        // --- inline construction and malformed metadata --------------

        const addContainer = () => {

            const element = document.createElement('div');
            element.style.cssText =
                'position:absolute;width:8px;height:8px;'
                + 'left:-100px;top:-100px';
            document.body.appendChild(element);
            return element;
        };

        const waitWithTimeout = (promise, label) =>
            Promise.race([
                promise,
                new Promise((_, reject) => {

                    setTimeout(
                        () => reject(new Error(`${label} timed out`)),
                        8000);
                }),
            ]);

        // the live surface document supplies the shared metadata an
        // inline source needs; only its surface entry is varied
        const terrainSpec = styleSpec.sources[terrainIds[0]];
        const terrainUrl = new URL('mapConfig.json', terrainSpec.url).href;
        const terrainDocument = await (await fetch(terrainUrl)).json();

        const inlineDocument = (surface) => {

            const document_ = structuredClone({
                referenceFrame: terrainDocument.referenceFrame,
                srses: terrainDocument.srses,
                bodies: terrainDocument.bodies,
                surfaces: terrainDocument.surfaces,
                credits: terrainDocument.credits,
            });

            document_.referenceFrame.model.publicSrs =
                document_.referenceFrame.model.navigationSrs;
            document_.services = {};

            const bodyId = document_.referenceFrame.body;
            if (bodyId && document_.bodies?.[bodyId])
                delete document_.bodies[bodyId].atmosphere;

            document_.surfaces[0] = {
                ...document_.surfaces[0], ...surface,
            };

            return document_;
        };

        const buildViewer = async (surface) => {

            const container = addContainer();
            const viewer_ = cartolina.map({
                container,
                style: {
                    version: 2,
                    sources: {
                        terrain: {
                            type: 'cartolina-surface',
                            data: inlineDocument(surface),
                            baseUrl: 'https://terrain.example/inline/',
                        },
                    },
                    terrain: { sources: ['terrain'] },
                },
            });

            let error = '';

            try {
                await waitWithTimeout(viewer_.ready, 'viewer.ready');
            } catch (caught) {
                error = caught.message;
            }

            return { viewer: viewer_, container, error };
        };

        const inline = await buildViewer({
            lodRange: [1, 1],
            tileRange: [[0, 0], [0, 0]],
        });

        check('an inline surface document loads', inline.error === '');

        check('the inline source resolves against its own base', (() => {

            if (inline.error !== '') return false;

            const source = inline.viewer.map.resolveTerrainSource('terrain');
            return source.id === 'terrain'
                && source.meshUrl.startsWith('https://terrain.example/inline/');
        })());

        inline.viewer[Symbol.dispose]();
        inline.container.remove();

        const descending = await buildViewer({ lodRange: [9, 4] });

        check('a descending lodRange rejects viewer.ready',
            /descending lodRange/.test(descending.error));

        descending.container.remove();

        const missing = await buildViewer({ meshUrl: undefined });

        check('a surface entry without a mesh URL rejects viewer.ready',
            /invalid metadata|needs a metatile/.test(missing.error));

        missing.container.remove();

        return out;
    });

    await browser.close();

    let failed = 0;

    for (const [name, passed] of results) {

        console.log((passed ? 'PASS ' : 'FAIL ') + name);
        if (!passed) failed++;
    }

    for (const failure of failures) {

        console.log('FAIL ' + failure);
        failed++;
    }

    if (failed > 0) {

        console.log(`\n${failed} check(s) failed.`);
        process.exit(1);
    }
}

main().catch((error) => {

    console.error(error);
    process.exit(1);
});
