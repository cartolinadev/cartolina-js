/*
 * Raster-source loading and failure-lifecycle regression gate.
 *
 * Requires the development server on http://localhost:8080.
 */

'use strict';

const { chromium } = require('playwright');

const PAGE_URL = 'http://localhost:8080/demos/map/?style=complex';
const VIEWPORT = { width: 1200, height: 800 };


async function main() {

    const browser = await chromium.launch({
        headless: true,
        args: [
            '--ignore-gpu-blocklist',
            '--enable-gpu',
            '--use-angle=gl',
        ],
    });
    const page = await browser.newPage({ viewport: VIEWPORT });
    const errors = [];

    page.on('console', message => {

        if (message.type() === 'error') errors.push(message.text());
    });
    page.on('pageerror', error => errors.push(error.message));
    page.on('requestfailed', request => {

        const failure = request.failure();

        if (failure?.errorText !== 'net::ERR_ABORTED') {

            errors.push(
                `requestfailed: ${request.url()} :: `
                + (failure?.errorText ?? 'unknown error'));
        }
    });

    try {

        await page.goto(PAGE_URL, {
            waitUntil: 'domcontentloaded',
            timeout: 60000,
        });
        await page.waitForFunction(
            () => globalThis.v,
            { timeout: 10000 },
        );
        await page.evaluate(() => globalThis.v.ready);

        let results;

        try {

            results = await page.evaluate(async () => {

            const out = [];
            const check = (name, condition) => {

                out.push([name, Boolean(condition)]);
            };
            const addContainer = () => {

                const element = document.createElement('div');
                element.style.cssText =
                    'position:absolute;width:8px;height:8px;'
                    + 'left:-100px;top:-100px';
                document.body.appendChild(element);
                return element;
            };
            const jsonResponse = (value, status = 200) =>
                new Response(JSON.stringify(value), {
                    status,
                    headers: { 'content-type': 'application/json' },
                });
            const waitWithTimeout = (promise, label) =>
                Promise.race([
                    promise,
                    new Promise((_, reject) => {

                        setTimeout(
                            () => reject(new Error(
                                `${label} timed out`)),
                            5000);
                    }),
                ]);

            const primary = globalThis.v;
            const terrainSourceId = primary.getTerrainSources()[0];
            const terrainSpec =
                primary.legacyMap.style.style().sources[terrainSourceId];
            const terrainUrl =
                new URL('mapConfig.json', terrainSpec.url).href;
            const terrainResponse = await fetch(terrainUrl);
            const terrainDocument = await terrainResponse.json();
            const testTerrain = structuredClone({
                referenceFrame: terrainDocument.referenceFrame,
                srses: terrainDocument.srses,
                bodies: terrainDocument.bodies,
                services: terrainDocument.services,
                surfaces: terrainDocument.surfaces,
                credits: terrainDocument.credits,
            });

            testTerrain.referenceFrame.model.publicSrs =
                testTerrain.referenceFrame.model.navigationSrs;
            testTerrain.services = {};

            const bodyId = testTerrain.referenceFrame.body;

            if (bodyId && testTerrain.bodies?.[bodyId]) {

                delete testTerrain.bodies[bodyId].atmosphere;
            }

            testTerrain.surfaces[0] = {
                ...testTerrain.surfaces[0],
                id: 'raster-test-terrain',
                lodRange: [1, 1],
                tileRange: [[0, 0], [0, 0]],
            };

            const readyDefinition = {
                url: 'tiles/{lod}-{x}-{y}.jpg',
                lodRange: [0, 3],
                tileRange: [[0, 0], [0, 0]],
                credits: {
                    'raster-test-credit': {
                        id: 9001,
                        notice: 'Raster test credit',
                    },
                },
                id: 20,
                type: 'raster',
                tileSize: [512, 512],
                dataType: 'classification',
                availability: {
                    type: 'negative-code',
                    codes: [404],
                },
                options: { shaderFilter: 'retired' },
            };
            const pairedDefinition = {
                url: 'tiles/{lod}-{x}-{y}.jpg',
                lodRange: [0, 3],
                tileRange: [[0, 0], [0, 0]],
                metaUrl: 'coverage/{lod}-{x}-{y}.png',
                maskUrl: '/masks/{lod}-{x}-{y}.png',
            };
            const maskOnlyDefinition = {
                url: 'tiles/{lod}-{x}-{y}.jpg',
                lodRange: [0, 3],
                tileRange: [[0, 0], [0, 0]],
                maskUrl: 'masks/{lod}-{x}-{y}.png',
            };
            const metaOnlyDefinition = {
                url: 'tiles/{lod}-{x}-{y}.jpg',
                lodRange: [0, 3],
                tileRange: [[0, 0], [0, 0]],
                metaUrl: 'coverage/{lod}-{x}-{y}.png',
            };

            const urls = {
                terrain: 'https://raster.example/terrain.json',
                ready: 'https://raster.example/definitions/ready.json',
                failed: 'https://raster.example/failed.json',
                trailing:
                    'https://raster.example/trailing/boundlayer.json',
            };
            const calls = [];
            const pending = new Map();
            const originalFetch = globalThis.fetch.bind(globalThis);
            let concurrentDispatch = false;
            let rasterRequestsOverlap = false;
            let rasterAndTerrainOverlap = false;
            let loadingFirstViewer = true;

            const releaseConcurrentLoads = () => {

                const required = [
                    urls.terrain,
                    urls.ready,
                    urls.failed,
                ];

                if (!required.every(url => pending.has(url))) return;

                concurrentDispatch = true;
                pending.get(urls.terrain)(jsonResponse(testTerrain));
                pending.get(urls.ready)(jsonResponse(readyDefinition));
                pending.get(urls.failed)(
                    jsonResponse({ message: 'unavailable' }, 503));
                pending.clear();
                loadingFirstViewer = false;
            };

            globalThis.fetch = (input, init) => {

                const requestUrl = typeof input === 'string'
                    ? input
                    : input.url;

                if (!requestUrl.startsWith('https://raster.example/')) {

                    return originalFetch(input, init);
                }

                calls.push(requestUrl);

                if (requestUrl === urls.trailing) {

                    return Promise.resolve(
                        jsonResponse(readyDefinition));
                }

                if (loadingFirstViewer) {

                    return new Promise(resolve => {

                        if (requestUrl === urls.terrain) {

                            rasterAndTerrainOverlap ||=
                                pending.has(urls.ready)
                                || pending.has(urls.failed);

                        } else if (requestUrl === urls.ready
                            || requestUrl === urls.failed) {

                            rasterAndTerrainOverlap ||= pending.has(
                                urls.terrain);
                            const other = requestUrl === urls.ready
                                ? urls.failed
                                : urls.ready;
                            rasterRequestsOverlap ||= pending.has(other);
                        }

                        pending.set(requestUrl, resolve);
                        releaseConcurrentLoads();
                    });
                }

                if (requestUrl === urls.failed) {

                    return Promise.resolve(
                        jsonResponse({ message: 'unavailable' }, 503));
                }

                return Promise.resolve(jsonResponse(testTerrain));
            };

            const inactiveTerrain = structuredClone(testTerrain);
            inactiveTerrain.surfaces[0].id =
                'raster-test-terrain-inactive';

            const healthyStyle = {
                version: 2,
                sources: {
                    'terrain-active': {
                        type: 'cartolina-surface',
                        url: urls.terrain,
                    },
                    'terrain-inactive': {
                        type: 'cartolina-surface',
                        data: inactiveTerrain,
                        baseUrl: 'https://raster.example/terrain/',
                    },
                    ready: {
                        type: 'cartolina-tms',
                        url: urls.ready,
                    },
                    failed: {
                        type: 'cartolina-tms',
                        url: urls.failed,
                    },
                    trailing: {
                        type: 'cartolina-tms',
                        url: 'https://raster.example/trailing/',
                    },
                    paired: {
                        type: 'cartolina-tms',
                        data: pairedDefinition,
                        baseUrl:
                            'https://raster.example/paired/source.json',
                    },
                    'mask-only': {
                        type: 'cartolina-tms',
                        data: maskOnlyDefinition,
                        baseUrl:
                            'https://raster.example/mask-only/',
                    },
                    'meta-only': {
                        type: 'cartolina-tms',
                        data: metaOnlyDefinition,
                        baseUrl:
                            'https://raster.example/meta-only/',
                    },
                },
                terrain: { sources: ['terrain-active'] },
                layers: [
                    {
                        id: 'ready-layer',
                        type: 'diffuse-map',
                        source: 'ready',
                        terrain: ['terrain-active'],
                    },
                    {
                        id: 'failed-layer',
                        type: 'diffuse-map',
                        source: 'failed',
                        terrain: [],
                        necessity: 'optional',
                    },
                    {
                        id: 'meta-only-layer',
                        type: 'diffuse-map',
                        source: 'meta-only',
                        terrain: [],
                    },
                ],
            };

            const healthyContainer = addContainer();
            const healthy = cartolina.map({
                container: healthyContainer,
                style: healthyStyle,
            });
            let healthyLoaded = 0;
            healthy.on('map-loaded', () => {

                healthyLoaded++;

                // This gate exercises source lifecycle, not rendering.
                // Suppress the dirty-gated draw in this same tick before
                // synthetic terrain URLs can enter the binary loader.
                healthy.legacyMap.outerMap.renderer
                    .ensureCanvasRenderTarget = () => false;
                healthy.legacyMap.dirty = false;
                healthy.legacyMap.dirtyCountdown = 0;
            });

            await waitWithTimeout(
                healthy.ready, 'inactive-failure viewer.ready');

            check('raster metadata dispatch is concurrent',
                concurrentDispatch && rasterRequestsOverlap);
            check('raster metadata overlaps terrain metadata',
                rasterAndTerrainOverlap);
            check('mixed allSettled results allow readiness',
                healthyLoaded === 1);
            check('trailing slash appends boundlayer.json',
                calls.includes(urls.trailing));

            const map = healthy.legacyMap.outerMap;
            const ready = map.getRasterSource('ready');
            const paired = map.getRasterSource('paired');
            const maskOnly = map.getRasterSource('mask-only');

            check('URL metadata resolves the tile template',
                ready.url ===
                    'https://raster.example/definitions/'
                    + 'tiles/{lod}-{x}-{y}.jpg');
            check('retired metadata is absent at runtime',
                ready.dataType === undefined
                    && ready.availability === undefined
                    && ready.options === undefined
                    && ready.tileSize === undefined);
            check('credits are registered and retained',
                ready.credits[0] === 'raster-test-credit'
                    && healthy.legacyMap.getCreditById(
                        'raster-test-credit') !== undefined);
            check('paired coverage resolves both URLs',
                paired.coverage.metaUrl ===
                    'https://raster.example/paired/'
                    + 'coverage/{lod}-{x}-{y}.png'
                    && paired.coverage.maskUrl ===
                    'https://raster.example/masks/'
                    + '{lod}-{x}-{y}.png');
            check('mask-only coverage is ignored',
                maskOnly.coverage === undefined);

            const originalProfile =
                JSON.stringify(healthy.getVisibilityProfile());
            let failedActivationError = '';

            try {

                healthy.setLayerTerrainSources(
                    'failed-layer', ['terrain-active']);

            } catch (error) {

                failedActivationError = error.message;
            }

            check('failed-source layer activation throws',
                failedActivationError.includes('failed-layer')
                    && failedActivationError.includes('failed')
                    && failedActivationError.includes('HTTP 503'));
            check('failed activation is atomic',
                JSON.stringify(healthy.getVisibilityProfile())
                    === originalProfile);

            healthy.setLayerTerrainSources(
                'failed-layer', ['terrain-inactive']);
            const inactiveProfile =
                JSON.stringify(healthy.getVisibilityProfile());
            let terrainActivationError = '';

            try {

                healthy.setTerrainSources(['terrain-inactive']);

            } catch (error) {

                terrainActivationError = error.message;
            }

            check('inactive failed source assignment is allowed',
                inactiveProfile !== originalProfile);
            check('later terrain activation throws atomically',
                terrainActivationError.includes('failed-layer')
                    && JSON.stringify(healthy.getVisibilityProfile())
                        === inactiveProfile);

            const failedRequestsBeforeRetryCheck =
                calls.filter(url => url === urls.failed).length;
            let metaOnlyError = '';

            try {

                healthy.setLayerTerrainSources(
                    'meta-only-layer', ['terrain-active']);

            } catch (error) {

                metaOnlyError = error.message;
            }

            check('meta-only source is recorded as failed',
                metaOnlyError.includes('meta-only-layer')
                    && metaOnlyError.includes(
                        'metaUrl without maskUrl'));
            check('failed source is not retried',
                calls.filter(url => url === urls.failed).length
                    === failedRequestsBeforeRetryCheck);

            healthy[Symbol.dispose]();
            healthyContainer.remove();

            const badStyle = {
                version: 2,
                sources: {
                    terrain: {
                        type: 'cartolina-surface',
                        data: testTerrain,
                        baseUrl:
                            'https://raster.example/bad-terrain/',
                    },
                    failed: {
                        type: 'cartolina-tms',
                        url: urls.failed,
                    },
                },
                terrain: { sources: ['terrain'] },
                layers: [{
                    id: 'failed-active',
                    type: 'diffuse-map',
                    source: 'failed',
                    terrain: ['terrain'],
                }],
            };
            const badContainer = addContainer();
            const bad = cartolina.map({
                container: badContainer,
                style: badStyle,
            });
            let badLoaded = 0;
            bad.on('map-loaded', () => badLoaded++);
            let readinessError = '';

            try {

                await waitWithTimeout(
                    bad.ready, 'active-failure viewer.ready');

            } catch (error) {

                readinessError = error.message;
            }

            check('initial active failure rejects viewer.ready',
                readinessError.includes('failed-active')
                    && readinessError.includes('failed')
                    && readinessError.includes('HTTP 503'));
            check('failed construction emits no map-loaded',
                badLoaded === 0);
            check('failed construction disposes partial map state',
                bad.legacyMap === null);

            bad[Symbol.dispose]();
            badContainer.remove();
            globalThis.fetch = originalFetch;

                return out;
            });

        } catch (error) {

            const detail = errors.length > 0
                ? `\nBrowser errors:\n${errors.join('\n')}`
                : '';
            throw new Error(error.message + detail);
        }

        for (const [name, passed] of results) {

            console.log(`${passed ? 'PASS' : 'FAIL'} ${name}`);

            if (!passed) errors.push(`failed check: ${name}`);
        }

    } finally {

        await browser.close();
    }

    if (errors.length > 0) {

        throw new Error(errors.join('\n'));
    }
}


main().catch(error => {

    console.error(error);
    process.exit(1);
});
