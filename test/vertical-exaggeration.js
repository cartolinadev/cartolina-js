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

            // the map owns the exaggeration; the renderer only forwards
            // to it, so probing the renderer would prove nothing beyond
            // the forwarder being reached
            const outerMap = legacyMap.outerMap;
            const exaggeration = outerMap.verticalExaggeration;

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
                    const elevated = exaggeration.apply(height, extent);
                    const restored = exaggeration.unapply(elevated, extent);
                    roundTrips.push({
                        extent,
                        height,
                        error: Math.abs(restored - height),
                    });
                }
            }

            // applyPhys2 must move a point the way the tile vertex
            // shader moves a vertex, or terrain and the things drawn on
            // it drift apart. This transcribes
            // applyVerticalExaggeration from
            // shaders/includes/frame.inc.glsl, independently of the
            // implementation under test.
            const shaderApply = (point, extent) => {

                const majorAxis = outerMap.bodyMajorAxis;
                const majorToMinor = outerMap.bodyMajorToMinor;
                const va = exaggeration.vaParams(extent);
                const h1 = va[0], f1 = va[1], h2 = va[2], f2 = va[3];

                const geo = [point[0], point[1], point[2] * majorToMinor];

                const ll = Math.sqrt(geo[0] * geo[0]
                    + geo[1] * geo[1] + geo[2] * geo[2]);

                const height = ll - majorAxis;
                const clamped = Math.min(Math.max(height, h1), h2);

                const factor = f1 + (clamped - h1) / (h2 - h1) * (f2 - f1);
                const raised = height * factor;

                const normal = [geo[0], geo[1], geo[2] * majorToMinor];

                const length = Math.sqrt(normal[0] * normal[0]
                    + normal[1] * normal[1] + normal[2] * normal[2]);

                return normal.map((component, axis) =>
                    point[axis] + component / length * (raised - height));
            };

            // physical points over a spread of latitudes: the direction
            // correction vanishes at the equator and at the pole, and
            // peaks in between
            const samples = [];

            const sampleRamps = () => {

                for (const latitude of [0, 15, 30, 45, 60, 75, 89.5]) {
                    for (const height of [-100, 0, 1500, 5000]) {

                        const point = legacyMap.convertCoordsFromNavToPhys(
                            [14.5, latitude, height], 'fix');

                        const extent = legacyMap.position.pos[8];
                        const expected = shaderApply(point, extent);
                        const got = exaggeration.applyPhys2(point, extent);
                        const simple = exaggeration.applyPhys(point, extent);

                        samples.push({
                            latitude,
                            height,

                            // agreement with the shader
                            shaderError: Math.max(...expected.map(
                                (value, axis) =>
                                    Math.abs(value - got.point[axis]))),

                            // the displacement is what actually moved it
                            displacementError: Math.max(...got.point.map(
                                (value, axis) =>
                                    Math.abs(value - point[axis]
                                        - got.displacement[axis]))),

                            // the simple form is the other one's point
                            simpleError: Math.max(...simple.map(
                                (value, axis) =>
                                    Math.abs(value - got.point[axis]))),
                        });
                    }
                }
            };

            sampleRamps();

            // again with a scale ramp and no elevation ramp, a shape a
            // body may declare: there `apply` is a plain factor
            viewer.setVerticalExaggeration({
                scaleRamp: {
                    min: [100000, 1],
                    max: [1000000, 3],
                },
            });

            sampleRamps();

            const worst = key => Math.max(
                ...samples.map(sample => sample[key]));

            // the axes the shader reads come from the physical srs; the
            // legacy geodata path reads them for the same points, so
            // the two srs must describe the same ellipsoid
            const navigationInfo = legacyMap.getNavigationSrs().getSrsInfo();
            const physicalInfo = legacyMap.getPhysicalSrs().getSrsInfo();

            const positions = [];
            const apply = exaggeration.apply.bind(exaggeration);
            exaggeration.apply = (height, position) => {

                positions.push(position === legacyMap.position);
                return apply(height, position);
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

                maxShaderError: worst('shaderError'),
                maxDisplacementError: worst('displacementError'),
                maxSimpleFormError: worst('simpleError'),

                sameEllipsoid:
                    navigationInfo.a === physicalInfo.a
                    && navigationInfo.b === physicalInfo.b,
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
        if (result.maxShaderError > 1e-6) {
            errors.push(
                'applyPhys2 disagrees with the tile vertex shader by '
                + result.maxShaderError + ' m'
            );
        }
        if (result.maxDisplacementError > 1e-9) {
            errors.push(
                'applyPhys2 displacement does not account for the move: '
                + result.maxDisplacementError + ' m'
            );
        }
        if (result.maxSimpleFormError > 0) {
            errors.push(
                'applyPhys and applyPhys2 returned different points: '
                + result.maxSimpleFormError + ' m'
            );
        }
        if (!result.sameEllipsoid) {
            errors.push(
                'navigation and physical srs describe different ellipsoids, '
                + 'so the legacy geodata exaggeration path changed body'
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
