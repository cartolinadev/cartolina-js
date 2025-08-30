/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');
const { runOne } = require('./run-one');

// ---------- helpers: template expansion & URL cleanup (same logic as your HTML) ----------
function expandTemplate(template, item) {
  return template.replace(/\$\{(\w+)\}/g, (_, key) => {
    return item[key] != null ? String(item[key]) : '';
  });
}

function sanitizeUrl(href) {
  // remove accidental double slashes but keep protocol //
  return href.replace(/([^:]\/)\/+/g, '$1');
}

function humanBytes(n) {
  if (n == null || !isFinite(n)) return '—';
  const units = ['B','KB','MB','GB','TB'];
  let i = 0; let v = Number(n);
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return (i === 0 ? Math.round(v) : v.toFixed(2)) + '\n' + units[i];
}

function humanMs(n) {
  if (n == null || !isFinite(n)) return '—';
  return Math.round(n) + '\nms';
}

function humanFps(n) {
  if (n == null || !isFinite(n)) return '—';
  return Number(n).toFixed(1) + '\nfps';
}


function forceSymlink(target, linkPath, type = 'file') {
  try {
    // If symlink already exists and points correctly, do nothing
    if (fs.existsSync(linkPath)) {
      const real = fs.realpathSync(linkPath);
      if (real === path.resolve(target)) {
        return; // already correct
      }
      fs.unlinkSync(linkPath); // remove existing file/symlink
    }
    fs.symlinkSync(target, linkPath, type);
  } catch (err) {
    console.error(`Failed to create symlink: ${err.message}`);
    throw err;
  }
}

(async () => {
  const urlsPath = process.env.VTS_PERF_URLS || path.join(__dirname, '../urls.json');
  if (!fs.existsSync(urlsPath)) {
    console.error(`[perf] Missing ${urlsPath}.`);
    process.exit(1);
  }

  // ----- read new schema -----
  const cfg = JSON.parse(fs.readFileSync(urlsPath, 'utf8'));
  if (!cfg || !cfg.templates || !cfg.urls || !Array.isArray(cfg.urls)) {
    console.error('[perf] Invalid urls.json format: expected { templates: {...}, urls: [...] }');
    process.exit(1);
  }

  const templates = cfg.templates;                         // e.g. { dev: "...", prod: "..." }
  const templateNames = Object.keys(templates);            // preserve declared order
  if (templateNames.length === 0) {
    console.error('[perf] No templates declared in urls.json.');
    process.exit(1);
  }

  // ----- output dir -----
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const outDir = path.join(__dirname, 'results', ts);
  fs.mkdirSync(outDir, { recursive: true });

  // ----- run all (serialize for stability) -----
  const flatResults = []; // array of { id, description, template, url, result }
  for (const item of cfg.urls) {
    for (const tName of templateNames) {
      const tpl = templates[tName];
      const url = sanitizeUrl(expandTemplate(tpl, item));

      // per-run config: pass optional perf knobs through
      const runCfg = {
        url,
        // Distinguish outputs by template; run-one uses this name for file stem
        name: `${item.id} (${tName})`,
        warmupMs: item.warmupMs,
        measureMs: item.measureMs,
        idleMs: item.idleMs,
        maxIdleWaitMs: item.maxIdleWaitMs,
        disableCache: item.disableCache
      };

      console.log(`[perf] Running: id=${item.id} template=${tName}`);
      try {
        // eslint-disable-next-line no-await-in-loop
        const r = await runOne(runCfg, outDir);
        flatResults.push({ id: item.id, description: item.description || '', template: tName, url, result: r });
      } catch (e) {
        console.error(`[perf] FAILED id=${item.id} template=${tName}: ${e && e.message ? e.message : e}`);
        flatResults.push({
          id: item.id,
          description: item.description || '',
          template: tName,
          url,
          result: {
            name: `${item.id} (${tName})`,
            url,
            error: String(e && e.message ? e.message : e),
            fps: { avg: NaN, p10: NaN, p50: NaN, p90: NaN },
            lcp: { value: NaN, unit: 'ms' },
            finish: { value: NaN, unit: 'ms' },
            transferred: { value: NaN, unit: 'bytes' },
            requests: NaN
          }
        });
      }
    }
  }

  // ----- save raw summary.json -----
  const summaryJson = {
    generatedAt: new Date().toISOString(),
    templates: templateNames,
    results: flatResults
  };
  const summaryPath = path.join(outDir, 'summary.json');
  fs.writeFileSync(summaryPath, JSON.stringify(summaryJson, null, 2));

  // ----- build CSV (simple, one row per (id,template)) -----
  const csv = [
    'id,template,url,FPS_avg,FPS_p10,FPS_p50,FPS_p90,LCP_ms,Finish_ms,Transferred_bytes,Requests,Error',
    ...flatResults.map(({ id, template, url, result }) => {
      const fps = result.fps || {};
      const lcp = result.lcp || {};
      const finish = result.finish || {};
      const transferred = result.transferred || {};
      const err = result.error ? JSON.stringify(result.error) : '';
      return [
        JSON.stringify(id),
        JSON.stringify(template),
        JSON.stringify(url),
        isFinite(fps.avg) ? fps.avg.toFixed(2) : '',
        isFinite(fps.p10) ? fps.p10.toFixed(2) : '',
        isFinite(fps.p50) ? fps.p50.toFixed(2) : '',
        isFinite(fps.p90) ? fps.p90.toFixed(2) : '',
        isFinite(lcp.value) ? Math.round(lcp.value) : '',
        isFinite(finish.value) ? Math.round(finish.value) : '',
        isFinite(transferred.value) ? transferred.value : '',
        isFinite(result.requests) ? result.requests : '',
        err
      ].join(',');
    })
  ].join('\n');
  fs.writeFileSync(path.join(outDir, 'summary.csv'), csv);

  // ----- build HTML report (styled like your manual-tests page) -----
  // Group by id -> template -> metrics
  const byId = new Map();
  for (const row of flatResults) {
    if (!byId.has(row.id)) byId.set(row.id, { description: row.description, templates: {} });
    byId.get(row.id).templates[row.template] = row.result;
  }

  function getVal(res, metric) {
    if (!res) return NaN;
    switch (metric) {
      case 'finish':      return res.finish && isFinite(res.finish.value) ? res.finish.value : NaN;
      case 'transferred': return res.transferred && isFinite(res.transferred.value) ? res.transferred.value : NaN;
      case 'lcp':         return res.lcp && isFinite(res.lcp.value) ? res.lcp.value : NaN;
      case 'fps':         return res.fps && isFinite(res.fps.avg) ? res.fps.avg : NaN;
      default:            return NaN;
    }
  }

  function fmt(res, metric) {
    const v = getVal(res, metric);
    switch (metric) {
      case 'finish':      return humanMs(v);
      case 'transferred': return humanBytes(v);
      case 'lcp':         return humanMs(v);
      case 'fps':         return humanFps(v);
      default:            return '—';
    }
  }

  // coloring rule: compare dev vs prod if both exist
  function cellClass(idData, metric, tName) {
    const dev = idData.templates['dev'];
    const prod = idData.templates['prod'];
    if (!dev || !prod) return '';
    const dv = getVal(dev, metric);
    const pv = getVal(prod, metric);
    if (!isFinite(dv) || !isFinite(pv)) return '';
    const lowerIsBetter = (metric === 'finish' || metric === 'transferred' || metric === 'lcp');
    if (tName !== 'dev') return ''; // tint dev only per spec
    const devBetter = lowerIsBetter ? (dv < pv) : (dv > pv);
    return devBetter ? 'good' : 'bad';
  }

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>vts-browser-js — perf summary</title>
<style>
  :root { --fg:#111; --muted:#666; --rule:#e5e7eb; --link:#1a73e8; --bg:#fff; }
  html, body { margin:0; padding:0; background:var(--bg); color:var(--fg);
    font:14px/1.5 system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, "Apple Color Emoji", "Segoe UI Emoji"; }
  .wrap { max-width:980px; margin:32px auto 64px; padding:0 16px; }
  h1 { font-size:20px; font-weight:600; margin:0 0 16px; }
  p.note { color:var(--muted); margin:0 0 24px; }
  table { width:100%; border-collapse:separate; border-spacing:0; }
  thead th { text-align:left; font-weight:600; padding:10px 8px; border-bottom:1px solid var(--rule); background:#fafafa; }
  tbody td { padding:10px 8px; border-bottom:1px solid var(--rule); vertical-align:top; }
  tbody tr:last-child td { border-bottom:0; }
  a { color:var(--link); text-decoration:none; }
  a:hover { text-decoration:underline; }
  .idcell { white-space:nowrap; }
  .error { color:#b00020; background:#fff2f2; border:1px solid #ffd6d6; padding:10px 12px; border-radius:6px; margin:12px 0; }
  /* tinting */
  .good { color: #137333; font-weight: 600; }
  .bad  { color: #b00020; font-weight: 600; }
  .mono { font-variant-numeric: tabular-nums; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace; }
  .muted { color: var(--muted); }
  /* group headers */
  .g { text-align:center; }
  .sub { font-weight:600; color:var(--muted); font-size:12px; }
</style>
</head>
<body>
  <div class="wrap">
    <h1>vts-browser-js — performance summary</h1>
    <p class="note">Each row is an <strong>id</strong> from <code>urls.json</code>. For each metric, there is one column per template (${templateNames.join(', ')}). Dev values are tinted <span class="good">green</span> when better than prod, <span class="bad">red</span> when worse.</p>
    <table aria-describedby="title">
      <thead>
        <tr>
          <th rowspan="2" style="width:18%">ID</th>
          <th colspan="${templateNames.length}" class="g">Finish</th>
          <th colspan="${templateNames.length}" class="g">Transferred</th>
          <th colspan="${templateNames.length}" class="g">LCP</th>
          <th colspan="${templateNames.length}" class="g">FPS average</th>
          <th rowspan="2">Comment</th>
        </tr>
        <tr>
          ${['finish','transferred','lcp','fps'].map(() =>
            templateNames.map(n => `<th class="sub">${n}</th>`).join('')
          ).join('')}
        </tr>
      </thead>
      <tbody>
        ${
          Array.from(byId.entries()).map(([id, data]) => {
            const cellsFinish = templateNames.map(n => {
              const res = data.templates[n];
              const cls = cellClass(data, 'finish', n);
              return `<td class="mono ${cls}">${fmt(res,'finish')}</td>`;
            }).join('');
            const cellsBytes = templateNames.map(n => {
              const res = data.templates[n];
              const cls = cellClass(data, 'transferred', n);
              return `<td class="mono ${cls}">${fmt(res,'transferred')}</td>`;
            }).join('');
            const cellsLcp = templateNames.map(n => {
              const res = data.templates[n];
              const cls = cellClass(data, 'lcp', n);
              return `<td class="mono ${cls}">${fmt(res,'lcp')}</td>`;
            }).join('');
            const cellsFps = templateNames.map(n => {
              const res = data.templates[n];
              const cls = cellClass(data, 'fps', n);
              return `<td class="mono ${cls}">${fmt(res,'fps')}</td>`;
            }).join('');

            const comment = data.templates.dev && data.templates.dev.error
              ? `<div class="error">dev: ${data.templates.dev.error}</div>`
              : data.templates.prod && data.templates.prod.error
                ? `<div class="error">prod: ${data.templates.prod.error}</div>`
                : '';

            return `<tr>
              <td class="idcell"><div><strong>${id}</strong></div>${
                data.description ? `<div class="muted">${data.description}</div>` : ''
              }</td>
              ${cellsFinish}
              ${cellsBytes}
              ${cellsLcp}
              ${cellsFps}
              <td>${comment}</td>
            </tr>`;
          }).join('\n')
        }
      </tbody>
    </table>
    <p class="note" style="margin-top:12px">Raw files: <code>${path.basename(summaryPath)}</code>, <code>summary.csv</code></p>
  </div>
</body>
</html>`;

  const htmlPath = path.join(outDir, 'summary.html');
  fs.writeFileSync(htmlPath, html, 'utf8');

  console.log(`[perf] Wrote ${summaryPath}`);
  console.log(`[perf] Wrote ${path.join(outDir, 'summary.csv')}`);
  console.log(`[perf] Wrote ${htmlPath}`);

  // 'latest' symlink
  forceSymlink(ts, path.join(__dirname, 'results', 'latest'));
  console.log(`[perf] Updated symlink: ${path.join('results', 'latest')} -> ${path.join('results', ts)}`);

  console.log('[perf]--- DONE ---');

})();
