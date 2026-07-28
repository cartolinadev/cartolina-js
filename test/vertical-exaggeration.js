/**
 * Vertical-exaggeration coordinate-conversion regression gate.
 *
 * Requires the development server on http://localhost:8080.
 */

'use strict';

const { chromium } = require('playwright');

const URL = 'http://localhost:8080/demos/map/?style='
    + encodeURIComponent(
        'https://cdn.tspl.re/libs/cartolina/tests/styles/simple.json')
    + '&pos='
    + encodeURIComponent(
        'obj,-118.302348,36.560197,fix,3313.32,-133.38,-25.09,'
        + '0.00,33347.92,45.00');

const VIEWPORT = { width: 1200, height: 800 };

async function main() {

    const browser = await chromium.launch({
        headless: true,
        args: ['--ignore-gpu-blocklist', '--enable-gpu', '--use-angle=gl'],
    });
    const page = await browser.newPage({ viewport: VIEWPORT });
    const errors = [];

    page.on('console', message => {

        if (message.type() === 'error') errors.push(message.text());
    });
    page.on('pageerror', error => errors.push(error.message));
    page.on('requestfailed', request => {

        const failure = request.failure();
        errors.push(
            `requestfailed: ${request.url()} :: `
            + (failure?.errorText ?? 'unknown error')
        );
    });

    try {

        await page.goto(URL, {
            waitUntil: 'domcontentloaded',
            timeout: 60000,
        });
        await page.waitForFunction(
            () => globalThis.v,
            { timeout: 10000 },
        );
        await page.evaluate(() => globalThis.v.ready);

        const result = await page.evaluate(() => {

            const viewer = globalThis.v;
            const legacyMap = viewer.legacyMap;
            const renderer = viewer.renderer;

            viewer.setVerticalExaggeration({
                elevationRamp: {
                    min: [0, 1.2],
                    max: [4000, 2.4],
                },
                scaleRamp: {
                    min: [100000, 1],
                    max: [1000000, 3],
                },
            });

            const roundTrips = [];
            for (const extent of [33000, 80000, 500000]) {
                for (const height of [-200, 0, 500, 2000, 4000, 6000]) {
                    const elevated = renderer.getSuperElevatedHeight(
                        height, extent);
                    const restored = renderer.getUnsuperElevatedHeight(
                        elevated, extent);
                    roundTrips.push({
                        extent,
                        height,
                        error: Math.abs(restored - height),
                    });
                }
            }

            const positions = [];
            const getSuperElevatedHeight =
                renderer.getSuperElevatedHeight.bind(renderer);
            renderer.getSuperElevatedHeight = (height, position) => {

                positions.push(position === legacyMap.position);
                return getSuperElevatedHeight(height, position);
            };

            const coords = legacyMap.position.getCoords();
            legacyMap.convertCoordsFromNavToPhys(
                coords, 'fix', undefined, true);
            legacyMap.convertCoordsFromNavToCanvas(coords, 'fix');

            return {
                maxRoundTripError: Math.max(
                    ...roundTrips.map(item => item.error)),
                conversionsUseCurrentPosition:
                    positions.length === 2 && positions.every(Boolean),
            };
        });

        if (result.maxRoundTripError > 1e-9) {
            errors.push(
                'vertical-exaggeration round-trip error: '
                + result.maxRoundTripError
            );
        }
        if (!result.conversionsUseCurrentPosition) {
            errors.push(
                'coordinate conversion did not use the current map position'
            );
        }

        console.log(JSON.stringify(result, null, 2));

    } finally {

        await browser.close();
    }

    if (errors.length) {
        throw new Error(errors.join('\n'));
    }
}

main().catch(error => {

    console.error(error);
    process.exit(1);
});
