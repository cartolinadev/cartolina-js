/**
 * Runtime tests for the layer terrain-applicability and visibility
 * profile API (RFC 11 phase 2).
 *
 * Usage:
 *   node test/style-mutation.js
 *
 * Loads the complex-terrain style in the demo app on the local dev
 * server and exercises the six Viewer methods through `window.v`:
 * pre-readiness throws, generated layer ids, profile round-trips,
 * direct mutation composition, and validation failures. Prints one
 * PASS/FAIL line per check and exits non-zero on any failure.
 */

'use strict';

const { chromium } = require('playwright');

const URL = 'http://localhost:8080/demos/map/?style=complex'
  + '&pos=obj,12.721290,47.084420,fix,2727.44,-46.93,-44.97,0.00,'
  + '12643.36,30.00';

const TERRAIN = 'topoearth-copernicus-dem-glo30';

async function main() {

  const browser = await chromium.launch({
    headless: true,
    args: ['--ignore-gpu-blocklist', '--enable-gpu', '--use-angle=gl'],
  });
  const context = await browser.newContext({
    viewport: { width: 1200, height: 800 },
  });
  const page = await context.newPage();

  const consoleErrors = [];
  page.on('console', m => {
    if (m.type() === 'error') consoleErrors.push(m.text());
  });
  page.on('pageerror', e => consoleErrors.push(e.message));

  await page.goto(URL, { waitUntil: 'domcontentloaded' });

  const results = await page.evaluate(async (TERRAIN) => {

    const out = [];
    const check = (name, cond) => out.push([name, !!cond]);
    const throws = (fn) => {
      try { fn(); return false; } catch (e) { return true; }
    };

    // wait for the demo to assign the viewer handle
    while (!window.v) {
      await new Promise(r => setTimeout(r, 5));
    }
    const v = window.v;

    // pre-readiness contract: all six methods throw before `ready`
    // resolves; skipped (reported as null) when readiness already
    // arrived before this script saw the handle
    let preReady = null;
    let ready = false;
    v.ready.then(() => { ready = true; });
    await Promise.resolve();

    if (!ready) {
      preReady = throws(() => v.getTerrainSources())
        && throws(() => v.setTerrainSources([TERRAIN]))
        && throws(() => v.getLayerTerrainSources('places'))
        && throws(() => v.setLayerTerrainSources('places', []))
        && throws(() => v.getVisibilityProfile())
        && throws(() => v.applyVisibilityProfile(
            { terrain: [], layers: {} }));
    }
    out.push(['pre-ready methods throw',
      preReady === null ? 'skipped' : preReady]);

    await v.ready;

    // active terrain stack
    const terrain = v.getTerrainSources();
    check('initial terrain stack',
      terrain.length === 1 && terrain[0] === TERRAIN);

    // complete profile with generated and explicit ids
    const profile = v.getVisibilityProfile();
    const ids = Object.keys(profile.layers);
    check('profile is complete (10 layers)', ids.length === 10);
    check('generated id for anonymous bump layer',
      ids.includes('bump-map-0'));
    check('generated id applies diffuse type default',
      ids.includes('diffuse-map-1'));
    check('generated id for constant layer', ids.includes('constant-3'));
    check('explicit lettering ids kept',
      ids.includes('places') && ids.includes('peaks'));

    // omitted terrain expanded to the declared terrain source
    check('omitted terrain expands to declared surfaces',
      profile.layers['bump-map-0'].length === 1
      && profile.layers['bump-map-0'][0] === TERRAIN);

    // validation failures change nothing
    check('unknown layer id throws',
      throws(() => v.setLayerTerrainSources('nope', [])));
    check('non-terrain source id throws',
      throws(() => v.setLayerTerrainSources('places', ['ne1v6plcw'])));
    check('unknown terrain in stack throws',
      throws(() => v.setTerrainSources(['nope'])));
    check('incomplete profile throws',
      throws(() => v.applyVisibilityProfile(
        { terrain: [TERRAIN], layers: { places: [] } })));
    check('unknown profile layer throws',
      throws(() => v.applyVisibilityProfile({
        terrain: [TERRAIN],
        layers: { ...profile.layers, nope: [] },
      })));
    check('state unchanged after failed mutations',
      JSON.stringify(v.getVisibilityProfile())
        === JSON.stringify(profile));

    // direct mutation, then capture, then restore via profile
    v.setLayerTerrainSources('places', []);
    check('direct mutation reflected in getter',
      v.getLayerTerrainSources('places').length === 0);

    const modified = v.getVisibilityProfile();
    check('captured profile sees direct mutation',
      modified.layers['places'].length === 0
      && modified.layers['peaks'].length === 1);

    v.applyVisibilityProfile(profile);
    check('reapplied profile overwrites direct edit',
      v.getLayerTerrainSources('places').length === 1);

    // profile round-trip is exact
    check('profile round-trips exactly',
      JSON.stringify(v.getVisibilityProfile())
        === JSON.stringify(profile));

    // terrain stack mutation and restore
    v.setTerrainSources([]);
    check('empty terrain stack accepted',
      v.getTerrainSources().length === 0);
    v.setTerrainSources([TERRAIN]);
    check('terrain stack restored',
      v.getTerrainSources()[0] === TERRAIN);

    return out;
  }, TERRAIN);

  let failed = 0;

  for (const [name, ok] of results) {

    if (ok === 'skipped') {
      console.log(`SKIP ${name}`);
      continue;
    }
    console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`);
    if (!ok) failed++;
  }

  if (consoleErrors.length) {
    console.log('console/page errors:');
    consoleErrors.forEach(e => console.log('  ' + e));
    failed++;
  }

  await browser.close();
  process.exit(failed ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(2); });
