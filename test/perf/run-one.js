/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

// -------------------- LCP collector (inject) --------------------
// /test/perf/run-one.js:11–33
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

// -------------------- FPS sampler (inject) ----------------------
// /test/perf/run-one.js:35–94
// -------------------- FPS helper (inject) ----------------------
// Defines window.__vtsPerf.startFps(warmupMs, measureMs) -> Promise<stats>
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

      // prefer app-provided FPS if present
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
// /test/perf/run-one.js:96–210
async function runOne(cfg, outDir) {
  const browser = await chromium.launch({
    headless: !process.env.PWDEBUG,
    args: [
      '--disable-extensions', 
      '--enable-precise-memory-info',
      '--ignore-gpu-blocklist',     // allow GPU on VMs/CI
      '--enable-gpu',               // don’t auto-disable
      '--enable-gpu-rasterization',
      '--enable-zero-copy',
      '--use-angle=gl'    
      // '--use=gl=egl'      
    ],
  });
  const context = await browser.newContext({ bypassCSP: false });
  const page = await context.newPage();
  
  // routing override to disable caching
  if (cfg.disableCache) {
    await context.route('**/*', route => {
      route.continue({
        headers: {
          ...route.request().headers(),
          'Cache-Control': 'no-cache'
        }
      });
   });
  }
  
  // CDP for network metrics (Transferred bytes, Requests, Finish via network-idle)
  const cdp = await context.newCDPSession(page);
  await cdp.send('Network.enable');

  let transferred = 0;          // bytes (for main loader)
  let requests = 0;             // count (for main loader)
  let lastFinishedTs = 0;       // last loadingFinished time (any for main loader)
  let mainLoaderId = null;      // loaderId of the current navigation
  let inflight = 0;             // inflight count (for main loader)
  let seenAny = false;          // seen at least one request for main loader
  const idleMs = Number(cfg.idleMs ?? 1000);
  const maxIdleWaitMs = Number(cfg.maxIdleWaitMs ?? 30000);

  // Map requestId -> loaderId so we can filter loadingFinished events
  const reqToLoader = new Map();
  
  // capture the loaderId for the main navigation
  cdp.on('Network.requestWillBeSent', (e) => {
    if (e.requestId && e.loaderId)  {
      reqToLoader.set(e.requestId, e.loaderId);
    }

    if (!mainLoaderId && e.type === 'Document') {
       mainLoaderId = e.loaderId; // scope to the current navigation
       console.log(`[CDP] Set mainLoaderId: ${mainLoaderId}`);
    }
    if (mainLoaderId && e.loaderId === mainLoaderId) {
      if (e.type !== 'WebSocket' && e.type !== 'EventSource') {
        console.log(`[CDP] Inflight incremented to ${inflight} for type=${e.type}`);
        inflight++;
      } else {
        console.log(`[CDP] Skipping inflight for persistent type=${e.type}`);
      }
      seenAny = true;
    }
  });

  // track last request completion time for this loaderId
  cdp.on('Network.loadingFinished', (e) => {

   const lid = reqToLoader.get(e.requestId);
   if (!mainLoaderId || lid !== mainLoaderId) return;

    transferred += e.encodedDataLength || 0;
    lastFinishedTs = Date.now();
    requests++;
    inflight = Math.max(0, inflight - 1);
    console.log(`[CDP] Loading finished: requestId=${e.requestId}, inflight now ${inflight}`)
  });


  // also handle failed requests as completions
  cdp.on('Network.loadingFailed', (e) => {
    const lid = reqToLoader.get(e.requestId);
    if (!mainLoaderId || lid !== mainLoaderId) return;
    lastFinishedTs = Date.now();
    inflight = Math.max(0, inflight - 1);
    console.log(`[CDP] Loading failed: requestId=${e.requestId}, inflight now ${inflight}`);
  });

  // inject our observers before any app code runs
  await page.addInitScript(injectLcpObserver());
  await page.addInitScript(injectFpsHelper());

  const t0 = Date.now();
  await page.goto(cfg.url, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('load').catch(() => {});
  await page.waitForTimeout(500); // small buffer

 // ----- Wait for NETWORK IDLE (no requests for idleMs) -----
  const idleReached = await (async () => {
    //if (!maxIdleWaitMs) return { idleTs: Date.now(), transferredAtIdle: transferred, requestsAtIdle: requests };
    let timer = null;
    let resolveIdle;
    const idlePromise = new Promise(res => { resolveIdle = res; });
    const start = Date.now();

    function maybeArmIdle() {
      if (!seenAny) return;                // wait until we actually saw traffic
      if (inflight !== 0)  {
          if (timer) clearTimeout(timer); timer = null;
      }

      if (!timer) {
        console.log('Arming idle timeout');
        timer = setTimeout(() =>  {
          timer = null,
          console.log('Idle timeout complete, finished loading page.');
          resolveIdle({ idleTs: Date.now() - idleMs, transferredAtIdle: transferred, requestsAtIdle: requests });
        }, idleMs);
      }
    }


    // poller for timeout/bailout
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

    // kick initial check
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
// /test/perf/run-one.js:212–236
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
