/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

/* ----------------------------------------------------------------------------
   LCP collector (inject)
   ------------------------------------------------------------------------- */
function injectLcpObserver() {
  return `
  (function () {
    window.__vtsPerf = window.__vtsPerf || {};
    window.__vtsPerf.lcp = 0;
    try {
      const po = new PerformanceObserver((list) => {
        for (const e of list.getEntries()) {
          window.__vtsPerf.lcp = e.startTime; // ms
        }
      });
      po.observe({ type: 'largest-contentful-paint', buffered: true });
    } catch (e) {}
  })();`;
}

/* ----------------------------------------------------------------------------
   Viewer capture (inject) - cartolina factory functions are
   non-configurable getters, so wrap Object.defineProperty to record the
   Viewer they return.
   ------------------------------------------------------------------------- */
function injectViewerCapture() {
  return `
  (function () {
    const define = Object.defineProperty;
    Object.defineProperty = function (target, prop, descr) {
      try {
        if ((prop === 'map' || prop === 'browser') && descr
            && typeof descr.get === 'function' && !descr.__viewerWrapped) {
          const get = descr.get;
          descr.get = function () {
            const factory = get.call(this);
            if (typeof factory !== 'function') return factory;
            return function () {
              const viewer = factory.apply(this, arguments);
              window.__viewer = viewer;
              return viewer;
            };
          };
          descr.__viewerWrapped = true;
        }
      } catch (e) {}
      return define.call(Object, target, prop, descr);
    };
  })();`;
}

/* ----------------------------------------------------------------------------
   FPS helper (inject) - drive continuous redraw so frames actually render,
   then read the engine's FrameProfiler result (window.__vtsPerf.frame).
   ------------------------------------------------------------------------- */
function injectFpsHelper() {
  return `
  (function () {
    window.__vtsPerf = window.__vtsPerf || {};

    function percentile(arr, p) {
      if (!arr.length) return 0;
      const a = arr.slice().sort((x,y)=>x-y);
      const idx = (a.length - 1) * p;
      const lo = Math.floor(idx), hi = Math.ceil(idx);
      const h = idx - lo;
      return a[lo] + (a[hi] - a[lo]) * h;
    }

    window.__vtsPerf.startFps = function startFps(warmupMs, measureMs) {
      const samples = [];      // limitFps readings from the engine profiler
      let stop = false;

      // Force the map to redraw every frame so the profiler measures real
      // rendering rather than the idle loop.
      function pump() {
        if (stop) return;
        try { if (window.__viewer) window.__viewer.redraw(); } catch (e) {}
        requestAnimationFrame(pump);
      }

      return new Promise(resolve => {
        setTimeout(() => {
          requestAnimationFrame(pump);

          const sampleId = setInterval(() => {
            const f = window.__vtsPerf.frame;
            if (f && typeof f.limitFps === 'number' && f.limitFps > 0) {
              samples.push(f.limitFps);
            }
          }, 250);

          setTimeout(() => {
            clearInterval(sampleId);
            stop = true;

            const last = window.__vtsPerf.frame || {};
            const stats = {
              avg: (samples.reduce((s,x)=>s+x,0) / (samples.length || 1)) || 0,
              p10: percentile(samples, 0.10) || 0,
              p50: percentile(samples, 0.50) || 0,
              p90: percentile(samples, 0.90) || 0,
              cpuMs: last.cpuMs ? last.cpuMs.median : 0,
              gpuMs: (last.gpuMs && last.gpuMs.available)
                ? last.gpuMs.median : null,
              rafFps: last.rafFps || null,
              drawCalls: last.drawCalls || 0,
              textureBinds: last.textureBinds || 0,
              fboSwitches: last.fboSwitches || 0
            };
            window.__vtsPerf.fpsStats = stats;
            resolve(stats);
          }, measureMs + 100);
        }, warmupMs);
      });
    };
  })();`;
}

/* ----------------------------------------------------------------------------
   Log helpers
   ------------------------------------------------------------------------- */
function trimUrl(u, max = 160) {
  try {
    const url = new URL(u);
    const short = url.origin + url.pathname + (url.search ? '?…' : '');
    return short.length <= max ? short : short.slice(0, max - 1) + '…';
  } catch {
    return (u.length <= max) ? u : (u.slice(0, max - 1) + '…');
  }
}
function ts() {
  const d = new Date();
  return d.toISOString().split('T')[1].replace('Z', '');
}

function withQueryParam(url, key, value) {
  try {
    const parsed = new URL(url);
    if (!parsed.searchParams.has(key)) parsed.searchParams.set(key, value);
    return parsed.href;
  } catch (_) {
    const parts = url.split('#');
    const base = parts[0];
    const hash = parts.length > 1 ? '#' + parts.slice(1).join('#') : '';
    if (new RegExp('([?&])' + key + '=').test(base)) return url;
    return base + (base.includes('?') ? '&' : '?') + key + '=' + value + hash;
  }
}

/* ----------------------------------------------------------------------------
   Main runner
   ------------------------------------------------------------------------- */
async function runOne(cfg, outDir) {
  const browser = await chromium.launch({
    headless: !process.env.PWDEBUG,
    args: [
      '--disable-extensions',
      '--enable-precise-memory-info',
      '--ignore-gpu-blocklist',
      '--enable-gpu',
      '--enable-gpu-rasterization',
      '--enable-zero-copy',
      '--use-angle=gl'
    ],
  });

  const context = await browser.newContext({ bypassCSP: false });
  const page = await context.newPage();

  // -------------------- aggregate metrics --------------------
  let requests = 0;                 // count (page + workers)
  let bytesDecoded = 0;             // Buffer length
  let bytesByHeader = 0;            // Content-Length (if present)
  let inflight = 0;                 // in-flight count
  let seenAny = false;              // seen at least one counted request
  let workerSeen = false;           // saw any request coming from worker
  let tracking = false;             // start counting after main Document request
  let lastActivityTs = 0;           // updated on every start/finish we count

  // idle params
  const idleMs = Number(cfg.idleMs ?? 2000);
  const maxIdleWaitMs = Number(cfg.maxIdleWaitMs ?? 30000);
  const postNavHoldMs = Number(cfg.postNavHoldMs ?? 1200);     // do not finish too soon after nav
  const workerGuardMs = Number(cfg.workerGuardMs ?? 5000);     // if no worker seen after 5s, allow idle anyway

  // -------------------- one route to capture *everything* --------------------
  await context.route('**/*', async (route) => {
    const req = route.request();
    const rt = (req.resourceType() || '').toLowerCase();
    const fromWorker = !req.frame(); // Workers have no Frame
    const tag = fromWorker ? 'worker' : 'page';
    const url = req.url();
    const method = req.method();

    // start tracking at the main navigation document
    if (!tracking && req.isNavigationRequest() && rt === 'document') {
      tracking = true;
      lastActivityTs = Date.now();
      console.log(`[${ts()}] [route] main navigation -> start counting`);
    }

    // Optionally disable caching - commented out: this is a client side test, we do not want to bust cdn caches
    let headers = req.headers();
    /*if (cfg.disableCache) {
      headers = { ...headers, 'Cache-Control': 'no-cache', Pragma: 'no-cache' };
    }*/

    // Decide if we count this one
    const persistent = (rt === 'websocket' || rt === 'eventsource');
    const shouldCount = tracking && !persistent;

    // Log start
    const willInflight = shouldCount ? inflight + 1 : inflight;
    //console.log(`[${ts()}] [ROUTE→] ${method} ${trimUrl(url)} (type=${rt}, src=${tag}) inflight-> ${willInflight}${persistent ? ' [persistent-skip]' : ''}`);

    if (shouldCount) {
      inflight++;
      seenAny = true;
      if (fromWorker) workerSeen = true;
      lastActivityTs = Date.now();
    }

    const t0req = Date.now();
    try {
      const resp = await route.fetch({ headers });

      // read the body buffer (decoded size)
      let body = null;
      try { body = await resp.body(); } catch (_) {}

      // update metrics
      let decoded = 0;
      let headerCL = null;
      if (shouldCount) {
        if (body) {
          decoded = body.length;
          bytesDecoded += decoded;
        }
        // prefer Content-Length as "encoded" byte approximation
        const h = resp.headers();
        const clHeader = h['content-length'] || h['Content-Length'];
        if (clHeader) {
          const v = Array.isArray(clHeader) ? clHeader[0] : clHeader;
          const n = Number(v);
          if (!Number.isNaN(n) && n >= 0) {
            headerCL = n;
            bytesByHeader += n;
          }
        }
        requests++;
      }

      const status = resp.status();
      const dur = Date.now() - t0req;

      // Log finish
      const willInflightDown = shouldCount ? Math.max(0, inflight - 1) : inflight;
      /*console.log(
        `[${ts()}] [ROUTE←] ${status} ${trimUrl(url)} (type=${rt}, src=${tag}) ` +
        `decoded=${decoded}` + (headerCL != null ? ` headerCL=${headerCL}` : '') +
        ` dur=${dur}ms inflight-> ${willInflightDown}`
      );*/

      // fulfill back to the browser with the already-buffered body
      await route.fulfill({ response: resp, body });
    } catch (e) {
      //console.log(`[${ts()}] [ROUTE×] ${method} ${trimUrl(url)} (type=${rt}, src=${tag}) ERROR: ${e?.message || e}`);
      try { await route.abort(); } catch (_) {}
    } finally {
      if (shouldCount) {
        inflight = Math.max(0, inflight - 1);
        lastActivityTs = Date.now();
      }
    }
  });

  // -------------------- inject observers before any app code runs --------------------
  await page.addInitScript(injectViewerCapture());
  await page.addInitScript(injectLcpObserver());
  await page.addInitScript(injectFpsHelper());

  // Ask the engine to publish FrameProfiler data and include GPU timer
  // queries. Performance runs are diagnostic measurements, so they report
  // the CPU/GPU bottleneck instead of CPU submission alone.
  const measureUrl = withQueryParam(
    withQueryParam(cfg.url, 'mapExposeFpsToWindow', '1'),
    'mapProfileGpu',
    '1'
  );

  const navStart = Date.now();
  const t0 = navStart;
  await page.goto(measureUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('load').catch(() => {});
  await page.waitForTimeout(200); // small buffer

  // ----- robust NETWORK IDLE (quiet-window + worker guard + post-nav hold) -----
  const idleReached = await (async () => {
    let idleStart = 0;
    const start = Date.now();

    function allowIdleNow() {
      const sinceNav = Date.now() - navStart;
      // require: either we saw worker activity OR we gave it some time
      const workerOk = workerSeen || sinceNav >= workerGuardMs;
      // also: do not even consider idle before postNavHoldMs
      return workerOk && sinceNav >= postNavHoldMs;
    }



    return new Promise(resolve => {
      const tick = setInterval(() => {
        const now = Date.now();


        // Bailout hard cap
        if (now - start > maxIdleWaitMs) {
          console.log(`[${ts()}] [IDLE] bailout: maxIdleWaitMs=${maxIdleWaitMs} exceeded (inflight=${inflight})`);
          clearInterval(tick);
          resolve({ idleTs: now, transferredAtIdle: Math.max(bytesByHeader, bytesDecoded), requestsAtIdle: requests });
          return;
        }

        // Keep re-arming idle window based on last activity & inflight
        const quietFor = now - lastActivityTs;
        if (allowIdleNow() && inflight === 0 && seenAny && quietFor >= idleMs) {
          console.log(`[${ts()}] [IDLE] quiet ${quietFor}ms >= idleMs=${idleMs}, inflight=0, finishing.`);
          clearInterval(tick);
          resolve({ idleTs: now, transferredAtIdle: Math.max(bytesByHeader, bytesDecoded), requestsAtIdle: requests });
          return;
        }

        // For visibility
        if (idleStart === 0 && inflight === 0 && seenAny && allowIdleNow()) {
          idleStart = now;
          console.log(`[${ts()}] [IDLE] arming quiet window (idleMs=${idleMs})… inflight=${inflight}`);
        }
        if ((inflight > 0 || !allowIdleNow()) && idleStart) {
          console.log(`[${ts()}] [IDLE] disarming quiet window (inflight=${inflight}, allow=${allowIdleNow()})`);
          idleStart = 0;
        }
      }, 100);
    });
  })();

  // ----- Start FPS measurement only AFTER idle -----
  const warm = Number(cfg.warmupMs || 0);
  const meas = Number(cfg.measureMs || 3000);

  console.log(`[${ts()}] [FPS] measuring`);
  const fps = await page.evaluate(([w, m]) => window.__vtsPerf.startFps(w, m), [warm, meas]);

  console.log(`[${ts()}] [FPS] retrieving`);
  const lcp = await page.evaluate(() =>
    (window.__vtsPerf && window.__vtsPerf.lcp) || 0
  );

  const finish = idleReached.idleTs ? (idleReached.idleTs - t0) : 0;
  const transferred = Math.max(bytesByHeader, bytesDecoded);

  console.log(`[${ts()}] --- Done. ---`);

  const result = {
    name: cfg.name || cfg.url,
    url: cfg.url,
    fps: {
      avg: fps.avg,
      p10: fps.p10,
      p50: fps.p50,
      p90: fps.p90,
      unit: "frames/second"
    },
    frame: {
      cpuMs: fps.cpuMs,
      gpuMs: fps.gpuMs,
      rafFps: fps.rafFps,
      drawCalls: fps.drawCalls,
      textureBinds: fps.textureBinds,
      fboSwitches: fps.fboSwitches
    },
    lcp: { value: lcp, unit: "ms" },
    finish: { value: finish, unit: "ms" },
    transferred: { value: transferred, unit: "bytes" },
    requests
  };

  const safe = (cfg.name || 'page').replace(/[^a-z0-9\-_.]+/gi,'_');
  const outFile = path.join(outDir, `${safe}.json`);
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify(result, null, 2));
  console.log(`[${ts()}] ${cfg.name || cfg.url} ->`, result);

  await browser.close();
  return result;
}

// CLI usage (manual run)
if (require.main === module) {
  const cfg = {
    url: process.argv[2],
    name: process.argv[3] || process.argv[2]
  };
  if (!cfg.url) {
    console.error('Usage: node test/perf/run-one.js <url> [name] [warmupMs] [measureMs]');
    process.exit(1);
  }
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const outDir = path.join(__dirname, 'results', ts);
  runOne(cfg, outDir).then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(2); });
}

module.exports = { runOne };
