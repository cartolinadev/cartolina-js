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
function injectFpsSampler(warmupMs, measureMs) {
  return `
  (function () {
    window.__vtsPerf = window.__vtsPerf || {};
    const samples = [];
    let frames = 0;
    let collecting = false;
    let endAt = 0;

    // prefer page-provided FPS
    let externalFps = null;
    try { if (typeof window.__vtsFps === 'number') externalFps = () => window.__vtsFps; } catch (e) {}

    function rafStep(now) {
      frames++;
      if (collecting && now >= endAt) {
        const dur = ${measureMs};
        const fps = (frames * 1000) / dur;
        samples.push(fps);
        collecting = false;
      }
      requestAnimationFrame(rafStep);
    }
    requestAnimationFrame(rafStep);

    setTimeout(() => {
      frames = 0;
      collecting = true;
      endAt = performance.now() + ${measureMs};

      if (externalFps) {
        const id = setInterval(() => {
          const v = externalFps();
          if (typeof v === 'number' && v > 0) samples.push(v);
        }, 500);
        setTimeout(() => clearInterval(id), ${measureMs});
      }
    }, ${warmupMs});

    window.__vtsPerf.fpsPromise = new Promise(resolve => {
      setTimeout(() => {
        function p(arr, q) {
          if (!arr.length) return 0;
          const a = arr.slice().sort((x,y)=>x-y);
          const idx = (a.length - 1) * q;
          const lo = Math.floor(idx), hi = Math.ceil(idx);
          const h = idx - lo;
          return a[lo] + (a[hi] - a[lo]) * h;
        }
        const avg = samples.reduce((s,x)=>s+x,0) / (samples.length || 1);
        window.__vtsPerf.fpsStats = { avg: avg||0, p10: p(samples,0.10)||0, p50: p(samples,0.50)||0, p90: p(samples,0.90)||0 };
        resolve(window.__vtsPerf.fpsStats);
      }, ${warmupMs + measureMs + 100});
    });
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
  
  // CDP for network metrics (Transferred bytes, Requests, Finish time)
  const cdp = await context.newCDPSession(page);
  await cdp.send('Network.enable');

  let transferred = 0;
  let requests = 0;
  let lastFinishedTs = 0;
  let mainLoaderId = null;

  // Map requestId -> loaderId so we can filter loadingFinished events
  const reqToLoader = new Map();
  
  // capture the loaderId for the main navigation
  cdp.on('Network.requestWillBeSent', (e) => {
    if (e.requestId && e.loaderId)  {
      reqToLoader.set(e.requestId, e.loaderId);
    }

    if (!mainLoaderId && e.type === 'Document') {
       mainLoaderId = e.loaderId; // scope to the current navigation
    }
  });

  // track last request completion time for this loaderId
  cdp.on('Network.loadingFinished', (e) => {

   const lid = reqToLoader.get(e.requestId);
   if (!mainLoaderId || lid !== mainLoaderId) return;

    transferred += e.encodedDataLength || 0;
    lastFinishedTs = Date.now();
    requests++;
  });

  // inject our observers before any app code runs
  await page.addInitScript(injectLcpObserver());
  await page.addInitScript(injectFpsSampler(cfg.warmupMs || 2000, cfg.measureMs || 5000));

  const t0 = Date.now();
  await page.goto(cfg.url, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('load').catch(() => {});
  await page.waitForTimeout(500); // small buffer

  // wait until the FPS promise produces stats
  await page.waitForFunction(() => window.__vtsPerf && window.__vtsPerf.fpsStats, null, {
    timeout: (cfg.warmupMs || 2000) + (cfg.measureMs || 5000) + 2000
  });

  const lcp = await page.evaluate(() =>
    (window.__vtsPerf && window.__vtsPerf.lcp) || 0
  );
  const fps = await page.evaluate(() =>
    (window.__vtsPerf && window.__vtsPerf.fpsStats) ||
    { avg: 0, p10: 0, p50: 0, p90: 0 }
  );
  const finish = lastFinishedTs ? (lastFinishedTs - t0) : 0;

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
