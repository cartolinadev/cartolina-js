/**
 * Screenshot helper — captures dev and prod renders of test URLs for visual comparison.
 *
 * Usage:
 *   node test/screenshot.js [id]        # one entry by id, or all if omitted
 *
 * Output: sandbox/tmp/screenshots/<id>-dev.png
 *     and sandbox/tmp/screenshots/<id>-prod.png
 * Prints a summary of console errors and network errors per URL.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const URLS_FILE = path.join(__dirname, 'urls.json');
const OUT_DIR = path.join('sandbox', 'tmp', 'screenshots');

const IDLE_MS = 2000;
const MAX_WAIT_MS = 40000;
const POST_NAV_HOLD_MS = 1200;
const WORKER_GUARD_MS = 5000;

// ---------------------------------------------------------------------------
// Build a concrete URL from a urls.json entry and template name ('dev'|'prod')
// ---------------------------------------------------------------------------
function buildUrl(entry, templates, side) {
  let templateName;
  if (!entry.template) {
    templateName = 'default';
  } else if (typeof entry.template === 'string') {
    templateName = entry.template;
  } else {
    templateName = entry.template[side] ?? null;
  }
  if (templateName == null) return null;
  const tmpl = (templates[templateName] ?? {})[side] ?? null;
  if (tmpl == null) return null;
  const extras = entry.extras || '';
  return tmpl
    .replace('${style}', encodeURIComponent(entry.style || ''))
    .replace('${pos}', encodeURIComponent(entry.pos || ''))
    .replace('${url}', entry.url || '')
    .replace('${config}', encodeURIComponent(entry.config || ''))
    .replace('${extras}', extras);
}

// ---------------------------------------------------------------------------
// Wait for network idle using the same quiet-window strategy as run-one.js
// ---------------------------------------------------------------------------
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
      if (resp.status() >= 400) {
        networkErrors.push(`${resp.status()} ${req.url()}`);
      }
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

  await page.waitForTimeout(1000);
  return networkErrors;
}

// ---------------------------------------------------------------------------
// Screenshot one URL (dev or prod)
// ---------------------------------------------------------------------------
async function screenshotOne(url, outFile) {
  const browser = await chromium.launch({
    headless: true,
    args: ['--ignore-gpu-blocklist', '--enable-gpu', '--use-angle=gl'],
  });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();

  const consoleErrors = [];
  page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });

  const networkErrors = await waitForIdle(context, page, url);

  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  await page.screenshot({ path: outFile });
  await browser.close();

  return { consoleErrors, networkErrors };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const filterId = process.argv[2] || null;
  const { templates, urls } = JSON.parse(fs.readFileSync(URLS_FILE, 'utf8'));

  const entries = filterId ? urls.filter(u => u.id === filterId) : urls;
  if (entries.length === 0) {
    console.error(`No entry found for id "${filterId}"`);
    process.exit(1);
  }

  let anyError = false;

  for (const entry of entries) {
    for (const side of ['dev', 'prod']) {
      const url = buildUrl(entry, templates, side);
      if (url == null) {
        console.log(`[${entry.id}] ${side} ... skipped (no template)`);
        continue;
      }
      const outFile = path.join(OUT_DIR, `${entry.id}-${side}.png`);
      process.stdout.write(`[${entry.id}] ${side} ... `);

      const { consoleErrors, networkErrors } = await screenshotOne(url, outFile);
      const ok = consoleErrors.length === 0 && networkErrors.length === 0;
      console.log(ok ? `ok  -> ${outFile}` : `ERRORS -> ${outFile}`);

      if (consoleErrors.length) {
        anyError = true;
        consoleErrors.forEach(e => console.log(`  console: ${e}`));
      }
      if (networkErrors.length) {
        anyError = true;
        networkErrors.forEach(e => console.log(`  network: ${e}`));
      }
    }
  }

  process.exit(anyError ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(2); });
