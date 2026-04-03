/**
 * Interactive test for diagnostic mode overlay + position copy/paste shortcuts.
 *
 * Requires the dev server to be running (http://localhost:8080).
 *
 * Usage:
 *   node test/diagnostic-shortcuts.js
 */

'use strict';

const { chromium } = require('playwright');

const DEV_URL = 'http://localhost:8080/demos/map/?style=https://cdn.tspl.re/libs/cartolina/tests/styles/simple.json&pos=obj,-118.302348,36.560197,fix,3313.32,-133.38,-25.09,0.00,33347.92,45.00';
const IDLE_MS = 2000;
const MAX_WAIT_MS = 40000;
const POST_NAV_HOLD_MS = 1200;
const WORKER_GUARD_MS = 5000;


async function waitForIdle(context, page, url) {
    let inflight = 0;
    let seenAny = false;
    let workerSeen = false;
    let lastActivityTs = 0;
    let tracking = false;
    const navStart = Date.now();
    const networkErrors = [];

    await context.route('**/*', async (route) => {
        const req = route.request();
        const rt = (req.resourceType() || '').toLowerCase();
        const fromWorker = !req.frame();
        const persistent = rt === 'websocket' || rt === 'eventsource';

        if (!tracking && req.isNavigationRequest() && rt === 'document') {
            tracking = true;
            lastActivityTs = Date.now();
        }

        const count = tracking && !persistent;
        if (count) {
            inflight++;
            seenAny = true;
            if (fromWorker) workerSeen = true;
            lastActivityTs = Date.now();
        }

        try {
            const resp = await route.fetch();
            if (resp.status() >= 400) networkErrors.push(`${resp.status()} ${req.url()}`);
            const body = await resp.body().catch(() => null);
            await route.fulfill({ response: resp, body });
        } catch (e) {
            networkErrors.push(`fetch error: ${req.url()}`);
            try { await route.abort(); } catch {}
        } finally {
            if (count) {
                inflight = Math.max(0, inflight - 1);
                lastActivityTs = Date.now();
            }
        }
    });

    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('load').catch(() => {});
    await page.waitForTimeout(200);

    await new Promise(resolve => {
        const start = Date.now();
        const tick = setInterval(() => {
            const now = Date.now();
            if (now - start > MAX_WAIT_MS) { clearInterval(tick); resolve(); return; }
            const sinceNav = now - navStart;
            const workerOk = workerSeen || sinceNav >= WORKER_GUARD_MS;
            const allowIdle = workerOk && sinceNav >= POST_NAV_HOLD_MS;
            if (allowIdle && inflight === 0 && seenAny && (now - lastActivityTs) >= IDLE_MS) {
                clearInterval(tick);
                resolve();
            }
        }, 100);
    });

    await page.waitForTimeout(500);
    return networkErrors;
}


function pass(msg) { console.log(`  PASS  ${msg}`); }
function fail(msg) { console.log(`  FAIL  ${msg}`); }
function check(condition, msg) { condition ? pass(msg) : fail(msg); return condition; }


async function main() {
    let anyFail = false;

    const browser = await chromium.launch({
        headless: true,
        args: ['--ignore-gpu-blocklist', '--enable-gpu', '--use-angle=gl'],
    });
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();

    // Mock navigator.clipboard so writes from synthetic keyboard events work reliably.
    // Headless browser treats synthetic keyboard events as non-user-gestures, which causes
    // clipboard.writeText to fail silently from event handlers. The mock bypasses that.
    await page.addInitScript(() => {
        window.__clipboard = '';
        Object.defineProperty(navigator, 'clipboard', {
            value: {
                writeText: (text) => { window.__clipboard = text; return Promise.resolve(); },
                readText: () => Promise.resolve(window.__clipboard),
            },
            configurable: true,
            writable: true,
        });
    });

    const consoleErrors = [];
    page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });
    page.on('pageerror', e => consoleErrors.push('pageerror: ' + e.message));

    console.log('Loading map...');
    const networkErrors = await waitForIdle(context, page, DEV_URL);
    if (!check(networkErrors.length === 0, 'no network errors on load')) {
        networkErrors.forEach(e => console.log(`         ${e}`));
        anyFail = true;
    }

    await page.waitForTimeout(100);

    // --- Test 1: Shift+D activates diagnostic mode and shows overlay ---
    console.log('\n[1] Shift+D — activate diagnostic mode');
    await page.keyboard.press('Shift+KeyD');
    await page.waitForTimeout(300);

    const notifText1 = await page.$eval('#vts-notification', el => el.textContent).catch(() => null);
    const notifOpacity1 = await page.$eval('#vts-notification', el => el.style.opacity).catch(() => null);
    if (!check(notifText1 === 'Diagnostic mode activated', `notification text: "${notifText1}"`)) anyFail = true;
    if (!check(notifOpacity1 === '1', `notification visible (opacity=${notifOpacity1})`)) anyFail = true;

    // --- Test 2: Shift+1 copies position to clipboard ---
    console.log('\n[2] Shift+1 — copy position');
    await page.keyboard.press('Shift+Digit1');
    await page.waitForTimeout(500); // clipboard.writeText resolves async

    const notifText2 = await page.$eval('#vts-notification', el => el.textContent).catch(() => null);
    if (!check(notifText2 === 'Position copied to clipboard', `notification text: "${notifText2}"`)) anyFail = true;

    const clipboard1 = await page.evaluate(() => window.__clipboard);
    if (!check(clipboard1.startsWith('pos='), `clipboard starts with "pos=": "${clipboard1.slice(0, 60)}"`)) anyFail = true;

    // Validate clipboard value has expected comma-separated structure (10 fields)
    const posValue = clipboard1.replace(/^pos=/, '');
    const fields = posValue.split(',');
    if (!check(fields.length === 10, `clipboard pos has 10 fields (got ${fields.length})`)) anyFail = true;

    // --- Test 3: Shift+2 pastes position from clipboard ---
    console.log('\n[3] Shift+2 — paste position (valid clipboard)');
    await page.keyboard.press('Shift+Digit2');
    await page.waitForTimeout(500);

    const notifText3 = await page.$eval('#vts-notification', el => el.textContent).catch(() => null);
    if (!check(notifText3 === 'Position applied from clipboard', `notification text: "${notifText3}"`)) anyFail = true;

    // --- Test 4: Shift+2 with non-position clipboard ---
    console.log('\n[4] Shift+2 — paste position (no pos= in clipboard)');
    await page.evaluate(() => { window.__clipboard = 'hello world'; });
    await page.keyboard.press('Shift+Digit2');
    await page.waitForTimeout(500);

    const notifText4 = await page.$eval('#vts-notification', el => el.textContent).catch(() => null);
    if (!check(notifText4 === 'No position found in clipboard', `notification text: "${notifText4}"`)) anyFail = true;

    // --- Test 5: notification fades out after 2 s ---
    console.log('\n[5] notification fades out after 2 s');
    await page.waitForTimeout(2800); // 2000ms timeout + 0.5s CSS transition + buffer
    const notifOpacityFaded = await page.$eval('#vts-notification', el => el.style.opacity).catch(() => null);
    if (!check(notifOpacityFaded === '0', `notification faded (opacity=${notifOpacityFaded})`)) anyFail = true;

    // --- Test 6: no console errors during the whole run ---
    console.log('\n[6] console errors during run');
    if (!check(consoleErrors.length === 0, `no console errors (${consoleErrors.length} found)`)) {
        consoleErrors.forEach(e => console.log(`         ${e}`));
        anyFail = true;
    }

    await browser.close();

    console.log(anyFail ? '\nResult: FAIL' : '\nResult: PASS');
    process.exit(anyFail ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(2); });
