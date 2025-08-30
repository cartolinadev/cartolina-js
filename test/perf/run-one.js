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
   FPS helper (inject)
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
  const idleMs = Number(cfg.idleMs ?? 1000);
  const maxIdleWaitMs = Number(cfg.maxIdleWaitMs ?? 30000);
  const postNavHoldMs = Number(cfg.postNavHoldMs ?? 1200);     // don’t finish too soon after nav
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
  await page.addInitScript(injectLcpObserver());
  await page.addInitScript(injectFpsHelper());

  const navStart = Date.now();
  const t0 = navStart;
  await page.goto(cfg.url, { waitUntil: 'domcontentloaded' });
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
      // also: don’t even consider idle before postNavHoldMs
      return workerOk && sinceNav >= postNavHoldMs;
    }

            console.log(maxIdleWaitMs);


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
          console.log(`[${ts()}] [IDLE] quiet ${quietFor}ms ≥ idleMs=${idleMs}, inflight=0, finishing.`);
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
  const meas = Number(cfg.measureMs || 2000);

  console.log(`[${ts()}] [FPS] measuring`);
  console.log(warm, meas);
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
