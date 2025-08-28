/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');
const { runOne } = require('./run-one');

// /test/perf/run-bundle.js:1–78
(async () => {
  const urlsPath = process.env.VTS_PERF_URLS || path.join(__dirname, 'urls.json');
  if (!fs.existsSync(urlsPath)) {
    const example = path.join(__dirname, 'urls.example.json');
    console.error(`[perf] Missing ${urlsPath}. Copy and edit ${example}.`);
    process.exit(1);
  }
  const urls = JSON.parse(fs.readFileSync(urlsPath, 'utf8'));
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const outDir = path.join(__dirname, 'results', ts);
  fs.mkdirSync(outDir, { recursive: true });

  const results = [];
  for (const cfg of urls) {
    // serialize runs for stability
    const r = await runOne(cfg, outDir); // eslint-disable-line no-await-in-loop
    results.push(r);
  }

  const summaryPath = path.join(outDir, 'summary.json');
  fs.writeFileSync(summaryPath, JSON.stringify(results, null, 2));

  const csv = [
    'name,url,FPS_avg,FPS_p10,FPS_p50,FPS_p90,LCP_ms,Finish_ms,Transferred_bytes,Requests',
    ...results.map(r => [
      JSON.stringify(r.name),
      JSON.stringify(r.url),
      r.fps.avg.toFixed(2),
      r.fps.p10.toFixed(2),
      r.fps.p50.toFixed(2),
      r.fps.p90.toFixed(2),
      Math.round(r.lcp),
      Math.round(r.finish),
      r.transferred,
      r.requests
    ].join(','))
  ].join('\n');
  fs.writeFileSync(path.join(outDir, 'summary.csv'), csv);
  console.log(`[perf] Wrote ${summaryPath}`);
})();

