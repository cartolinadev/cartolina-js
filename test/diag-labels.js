'use strict';

/**
 * Captures console output from complex-terrain on dev and prod,
 * filtering for processGMap6 diagnostic lines.
 * Usage: node test/diag-labels.js
 */

const { chromium } = require('playwright');

const URLS = {
    dev: 'http://localhost:8080/demos/map/?style=https://cdn.tspl.re/libs/cartolina/tests/styles/complex.json&pos=obj,12.721290,47.084420,fix,2727.44,-46.93,-44.97,0.00,12643.36,30.00&mapExposeFpsToWindow=1',
    prod: 'https://cdn.tspl.re/libs/cartolina/tests/?style=https://cdn.tspl.re/libs/cartolina/tests/styles/complex.json&pos=obj,12.721290,47.084420,fix,2727.44,-46.93,-44.97,0.00,12643.36,30.00&mapExposeFpsToWindow=1',
};

const WAIT_MS = 12000;

async function capture(name, url) {

    const browser = await chromium.launch({
        headless: true,
        args: ['--ignore-gpu-blocklist', '--enable-gpu', '--use-angle=gl'],
    });
    const context = await browser.newContext({
        viewport: { width: 1280, height: 800 }
    });
    const page = await context.newPage();

    const logs = [];
    page.on('console', m => logs.push({ type: m.type(), text: m.text() }));
    page.on('pageerror', e => logs.push({ type: 'pageerror', text: String(e) }));

    await page.goto(url);
    await page.waitForTimeout(WAIT_MS);
    await browser.close();

    console.log(`\n=== ${name} ===`);
    for (const e of logs) {
        if (e.type === 'pageerror') {
            console.log('  PAGE ERROR:', e.text);
        } else if (e.text.includes('processGMap6') || e.text.includes('gmap')) {
            console.log(' ', e.text);
        }
    }
}

(async () => {
    await capture('dev', URLS.dev);
    await capture('prod', URLS.prod);
})().catch(e => { console.error(e); process.exit(1); });
