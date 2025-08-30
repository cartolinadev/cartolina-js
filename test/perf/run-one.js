/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

// -------------------- LCP collector (inject) --------------------
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

// -------------------- FPS helper (inject) ----------------------
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
      const samples = [];
      let frames = 0;
      let collecting = false;
      let endAt = 0;

      let externalFps = null;
      try { if (typeof window.__vtsFps === 'number') externalFps = () => window.__vtsFps; } catch (e) {}

      function rafStep(now) {
        frames++;
        if (collecting && now >= endAt) {
          const dur = measureMs;
          const fps = (frames * 1000) / dur;
          samples.push(fps);
          collecting = false;
        }
        requestAnimationFrame(rafStep);
      }
      requestAnimationFrame(rafStep);

      return new Promise(resolve => {
        setTimeout(() => {
          frames = 0;
          collecting = true;
          endAt = performance.now() + measureMs;

          let intervalId = null;
          if (externalFps) {
            intervalId = setInterval(() => {
              const v = externalFps();
              if (typeof v === 'number' && v > 0) samples.push(v);
            }, 500);
          }

          setTimeout(() => {
            if (intervalId) clearInterval(intervalId);
            const avg = samples.reduce((s,x)=>s+x,0) / (samples.length || 1);
            const stats = {
              avg: avg || 0,
              p10: percentile(samples, 0.10) || 0,
              p50: percentile(samples, 0.50) || 0,
              p90: percentile(samples, 0.90) || 0
            };
            window.__vtsPerf.fpsStats = stats;
            resolve(stats);
          }, measureMs + 100);
        }, warmupMs);
      });
    };
  })();`;
}

// -------------------- main runner -------------------------------
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
  let transferred = 0;          // bytes (decoded body length) across page + workers
  let requests = 0;             // count (page + workers)
  let inflight = 0;             // inflight count
  let seenAny = false;          // seen at least one request after main doc
  const idleMs = Number(cfg.idleMs ?? 1000);
  const maxIdleWaitMs = Number(cfg.maxIdleWaitMs ?? 30000);
  let tracking = false;         // start counting after main Document req

  // -------------------- one route to capture *everything* --------------------
  // This sees requests from the page, subframes, *and* workers/service-workers.
  await context.route('**/*', async (route) => {
    const req = route.request();

    // flip tracking on the main navigation document
    if (!tracking && req.isNavigationRequest() && req.resourceType() === 'document') {
      tracking = true;
      // fall through and count this request too
    }

    // Optionally disable caching by modifying request headers here
    let headers = req.headers();
    if (cfg.disableCache) {
      headers = { ...headers, 'Cache-Control': 'no-cache' };
    }

    // Before we fetch, decide if we count this one
    const persistent = req.resourceType() === 'websocket' || req.resourceType() === 'eventsource';
    const shouldCount = tracking && !persistent;

    // Start
    if (shouldCount) { inflight++; seenAny = true; }

    try {
      // Perform the request ourselves and get its body
      const resp = await route.fetch({ headers });
      let body = null;
      try {
        body = await resp.body();       // Buffer
      } catch (_) {
        body = null;
      }

      if (shouldCount && body) {
        transferred += body.length;     // decoded bytes
        requests++;
      }

      // Fulfill with the original response (and the body we already read)
      await route.fulfill({ response: resp, body });

    } catch (e) {
      // Network error — surface it to the page
      try { await route.abort(); } catch (_) {}
    } finally {
      if (shouldCount) inflight = Math.max(0, inflight - 1);
    }
  });

  // -------------------- optional page-level logging only --------------------
  page.on('request', (r) => {
    if (!tracking && r.isNavigationRequest() && r.resourceType() === 'document') {
      tracking = true;
      console.log('[route] main navigation seen, starting capture.');
    }
  });

  // inject our observers before any app code runs
  await page.addInitScript(injectLcpObserver());
  await page.addInitScript(injectFpsHelper());

  const t0 = Date.now();
  await page.goto(cfg.url, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('load').catch(() => {});
  await page.waitForTimeout(200); // small buffer

  // ----- Wait for NETWORK IDLE (no requests for idleMs) -----
  const idleReached = await (async () => {
    let timer = null;
    let resolveIdle;
    const idlePromise = new Promise(res => { resolveIdle = res; });
    const start = Date.now();

    function maybeArmIdle() {
      if (!seenAny) return;                // wait until we actually saw traffic
      if (inflight !== 0) { if (timer) { clearTimeout(timer); timer = null; } return; }
      if (!timer) {
        timer = setTimeout(() =>  {
          timer = null;
          console.log('Idle timeout complete, finished loading page.');
          resolveIdle({ idleTs: Date.now() - idleMs, transferredAtIdle: transferred, requestsAtIdle: requests });
        }, idleMs);
      }
    }

    const bail = setInterval(() => {
      if (Date.now() - start > maxIdleWaitMs) {
        console.log(`Bailing out, maxIdleWaitMs reached.`);
        if (timer) clearTimeout(timer);
        clearInterval(bail);
        resolveIdle({ idleTs: Date.now(), transferredAtIdle: transferred, requestsAtIdle: requests });
      } else {
        maybeArmIdle();
      }
    }, 50);

    maybeArmIdle();
    const res = await idlePromise;
    if (timer) clearTimeout(timer);
    clearInterval(bail);
    return res;
  })();

  // ----- Start FPS measurement only AFTER idle -----
  const warm = Number(cfg.warmupMs || 0);
  const meas = Number(cfg.measureMs || 2000);
  const fps = await page.evaluate(([w, m]) => window.__vtsPerf.startFps(w, m), [warm, meas]);

  const lcp = await page.evaluate(() =>
    (window.__vtsPerf && window.__vtsPerf.lcp) || 0
  );

  const finish = idleReached.idleTs ? (idleReached.idleTs - t0) : 0;

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
    lcp: { value: lcp, unit: "ms" },
    finish: { value: finish, unit: "ms" },
    transferred: { value: transferred, unit: "bytes" },
    requests
  };

  const safe = (cfg.name || 'page').replace(/[^a-z0-9\-_.]+/gi,'_');
  const outFile = path.join(outDir, `${safe}.json`);
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify(result, null, 2));
  console.log(`[perf] ${cfg.name || cfg.url} ->`, result);

  await browser.close();
  return result;
}

// CLI usage (manual run)
if (require.main === module) {
  const cfg = {
    url: process.argv[2],
    name: process.argv[3] || process.argv[2],
    warmupMs: Number(process.argv[4] || 2000),
    measureMs: Number(process.argv[5] || 5000),
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
