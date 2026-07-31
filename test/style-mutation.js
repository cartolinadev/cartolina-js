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

const STYLE_URL = 'http://localhost:8080/demos/map/?style=complex'
  + '&pos=obj,12.721290,47.084420,fix,2727.44,-46.93,-44.97,0.00,'
  + '12643.36,30.00';
const MAPCONFIG_SOURCE_URL =
  'https://cdn.tspl.re/store/a-3d-mountain-map/map-config/map/'
  + 'mapConfig.json';
const MAPCONFIG_URL = 'http://localhost:8080/demos/map/?mapConfig='
  + MAPCONFIG_SOURCE_URL;

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
  const requests = [];
  page.on('request', request => requests.push(request.url()));
  page.on('console', m => {
    if (m.type() === 'error') consoleErrors.push(m.text());
  });
  page.on('pageerror', e => consoleErrors.push(e.message));
  page.on('requestfailed', request => {
    const errorText = request.failure()?.errorText;
    if (errorText !== 'net::ERR_ABORTED') {
      consoleErrors.push(
        `request failed: ${request.url()} (${errorText})`);
    }
  });

  await page.goto(STYLE_URL, { waitUntil: 'domcontentloaded' });

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

    // an active-to-empty profile change drops the legacy free-layer
    // draw/hit-test sequence, and the runtime skips drawing and
    // hit-testing based on the sequence itself: no residual geodata
    // type predicate in the style path (RFC 11 review round 7,
    // finding 2)
    const vectorLayerIds = ids.filter(
      (id) => Object.keys(v.getVisibilityProfile().layers).includes(id)
        && ['places', 'peaks',
          'country-boundaries', 'state-boundaries'].includes(id));
    check('all four osm-openfreemap lettering layers found',
      vectorLayerIds.length === 4);

    for (const id of vectorLayerIds) v.setLayerTerrainSources(id, []);

    check('free-layer draw/hit-test sequence is empty',
      v.legacyMap.freeLayerSequence.length === 0);

    const emptyHit = v.legacyMap.hitTestGeoLayers(600, 400, 'click');
    check('hit test short-circuits on the empty sequence',
      emptyHit[0] === null && emptyHit[1] === false
        && Array.isArray(emptyHit[2]) && emptyHit[2].length === 0);

    v.applyVisibilityProfile(profile);
    check('free-layer sequence restored after reapplying the profile',
      v.legacyMap.freeLayerSequence.length > 0);

    // Inline surface constructors receive their own URL context
    // without changing the style-level LegacyMap.url object. Use the
    // live constructors so this exercises the browser bundle rather
    // than a duplicate URL-resolution helper.
    const surfaceSource = v.legacyMap.style.style().sources[TERRAIN];
    const mapConfigUrl = new URL('mapConfig.json', surfaceSource.url);
    const response = await fetch(mapConfigUrl);
    const sourceDocument = await response.json();

    const sharedDocument = structuredClone({
      referenceFrame: sourceDocument.referenceFrame,
      srses: sourceDocument.srses,
      bodies: sourceDocument.bodies,
      services: sourceDocument.services,
      credits: sourceDocument.credits,
      surfaces: sourceDocument.surfaces,
    });
    const srsId = Object.keys(sharedDocument.srses)[0];
    sharedDocument.srses[srsId].geoidGrid = {
      definition: 'grids/test-grid.png',
    };
    sharedDocument.services.atmdensity = {
      url: 'atmosphere/density.png?def={param(0)}',
    };
    sharedDocument.bodies[sharedDocument.referenceFrame.body].atmosphere = {};

    const sourceA = structuredClone(sharedDocument);
    const sourceB = structuredClone(sharedDocument);
    sourceA.surfaces = [{
      ...sourceDocument.surfaces[0],
      id: 'inline-a',
      meshUrl: 'mesh/a-{lod}-{x}-{y}.bin',
    }];
    sourceB.surfaces = [{
      ...sourceDocument.surfaces[0],
      id: 'inline-b',
      meshUrl: 'mesh/b-{lod}-{x}-{y}.bin',
    }];

    const baseA = 'http://localhost:8080/test/inline-a/';
    const baseB = 'http://localhost:8080/test/inline-b/';
    const inlineStyle = {
      version: 2,
      sources: {
        'inline-a': {
          type: 'cartolina-surface', data: sourceA, baseUrl: baseA,
        },
        'inline-b': {
          type: 'cartolina-surface', data: sourceB, baseUrl: baseB,
        },
      },
      terrain: { sources: [] },
      atmosphere: {},
    };

    const LegacyMap = v.legacyMap.constructor;
    const MapStyle = v.legacyMap.style.constructor;
    const makeTestMap = () => {
      const map = new LegacyMap(
        v.legacyMap.core,
        'http://localhost:8080/style-context/style.json',
        v.legacyMap.config,
        v.legacyMap.bus,
      );
      const terrainSources = new Map();
      map.outerMap = {
        setRasterSourceEntries() {},
        assertRasterSourcesAvailable() {},
        setTerrainSourceEntries(sources) {
          terrainSources.clear();
          for (const [id, source] of sources)
            terrainSources.set(id, source);
        },
        resolveTerrainSource(id) {
          const source = terrainSources.get(id);
          if (!source)
            throw new Error(`terrain.sources references "${id}" but `
              + 'no surface was loaded for that source');
          return source;
        },
      };
      map.terrainSources = terrainSources;
      return map;
    };

    const inlineMap = makeTestMap();
    const styleUrlObject = inlineMap.url;
    await MapStyle.loadStyle(inlineMap, inlineStyle);

    const inlineSources = [...inlineMap.terrainSources.values()];
    check('inline surface bases resolve independently',
      inlineSources[0].meshUrl.startsWith(baseA)
        && inlineSources[1].meshUrl.startsWith(baseB));
    check('inline SRS and atmosphere use the first source base',
      inlineMap.srses[srsId].geoidGridMap.mapLoaderUrl
        === baseA + 'grids/test-grid.png'
      && inlineMap.atmosphere.atmDensityTexture.mapLoaderUrl
        .startsWith(baseA + 'atmosphere/density.png?def='));
    check('inline construction preserves style URL context',
      inlineMap.url === styleUrlObject);
    inlineMap.kill();

    const brokenMap = makeTestMap();
    const brokenUrlObject = brokenMap.url;
    const brokenStyle = structuredClone(inlineStyle);
    const brokenSrsId = Object.keys(
      brokenStyle.sources['inline-a'].data.srses)[0];
    brokenStyle.sources['inline-a'].data.srses[brokenSrsId].srsDef =
      '+proj=not-a-real-projection';
    brokenStyle.sources['inline-b'].data.srses[brokenSrsId].srsDef =
      '+proj=not-a-real-projection';

    let constructionFailed = false;
    try {
      await MapStyle.loadStyle(brokenMap, brokenStyle);
    } catch (_) {
      constructionFailed = true;
    }
    check('constructor failure preserves style URL context',
      constructionFailed && brokenMap.url === brokenUrlObject);
    brokenMap.kill();

    return out;
  }, TERRAIN);

  const compatRequest = url =>
    new URL(url).pathname.endsWith('/build/cartolina-compat.js');

  results.push([
    'style route does not request compatibility bundle',
    !requests.some(compatRequest),
  ]);

  const requestsBeforeMapConfig = requests.length;
  await page.goto(MAPCONFIG_URL, { waitUntil: 'domcontentloaded' });
  const mapConfigRendered = await page.evaluate(async () => {
    while (!window.v) await new Promise(resolve => setTimeout(resolve, 5));
    await window.v.ready;
    await new Promise(resolve => requestAnimationFrame(
      () => requestAnimationFrame(resolve)));
    const canvas = document.querySelector('#map canvas');
    return window.v.legacyMap !== null
      && canvas instanceof HTMLCanvasElement
      && canvas.width > 0 && canvas.height > 0;
  });

  results.push([
    'mapConfig route requests compatibility bundle',
    requests.slice(requestsBeforeMapConfig).some(compatRequest),
  ]);
  results.push(['mapConfig route renders', mapConfigRendered]);

  // A linked mixed rule is intentionally absent from the emitted
  // style. Verify that a named-view profile excludes it and applies
  // through the real Viewer completeness check (RFC 11 review round
  // 8). The injected rule changes no emitted layer, so the profile
  // applies to the viewer created from the same public mapConfig.
  const mixedRuleProfileApplies = await page.evaluate(
    async (mapConfigUrl) => {

      const mapConfigResponse = await fetch(mapConfigUrl);
      if (!mapConfigResponse.ok) {
        throw new Error(`mapConfig probe failed: ${mapConfigResponse.status}`);
      }

      const mapConfig = await mapConfigResponse.json();
      mapConfig.namedViews = {
        'round8-detail': structuredClone(mapConfig.view),
      };

      const loadJson = async (url, kind) => {
        const response = await fetch(url);
        if (!response.ok) {
          throw new Error(`probe fetch failed: ${response.status} ${url}`);
        }

        const data = await response.json();
        if (kind === 'Style') {
          data.layers = data.layers || {};
          data.layers['round8-mixed'] = { label: true, line: true };
        }
        return data;
      };

      const conversion = await cartolinaCompat.mapConfigToStyle(
        mapConfig, { baseUrl: mapConfigUrl, loadJson });
      const profile = conversion.profiles['round8-detail'];
      const styleIds = conversion.style.layers.map(layer => layer.id);
      const profileIds = Object.keys(profile.layers);

      if (!conversion.warnings.some(
        warning => warning.code === 'unsupported-rule')) return false;
      if (JSON.stringify(profileIds) !== JSON.stringify(styleIds)) return false;

      window.v.applyVisibilityProfile(profile);
      return JSON.stringify(window.v.getVisibilityProfile())
        === JSON.stringify(profile);
    }, MAPCONFIG_SOURCE_URL);

  results.push([
    'converted mixed-rule profile applies without an unknown layer',
    mixedRuleProfileApplies,
  ]);

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
