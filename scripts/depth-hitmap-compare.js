#!/usr/bin/env node
/*
 * Capture and compare screen-depth hitmap readings.
 *
 * Output files are written wherever --out points; use a gitignored path such
 * as tmp/depth-readings/. The script intentionally does not start a dev
 * server so the same file can be stashed and replayed across commits.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const DefaultStyle =
    'https://cdn.tspl.re/libs/cartolina/tests/styles/simple.json';
const DefaultPosition =
    'obj,-118.302348,36.560197,fix,3313.32,-133.38,-25.09,0.00,33347.92,45.00';

function usage() {

    console.log(`
Usage:
  node scripts/depth-hitmap-compare.js capture \\
      --base-url http://127.0.0.1:8080 \\
      --out tmp/depth-readings/head.json

  node scripts/depth-hitmap-compare.js compare \\
      --a tmp/depth-readings/head.json \\
      --b tmp/depth-readings/head-1.json

Options for capture:
  --base-url URL      Dev server root URL.
  --out PATH         JSON output file.
  --style URL        Style URL. Defaults to the simple terrain test style.
  --pos POSITION     Cartolina position string.
  --grid WxH         Sample grid size. Default: 33x21.
  --margin N         Screen margin in CSS pixels. Default: 32.
  --width N          Viewport width. Default: 1280.
  --height N         Viewport height. Default: 800.
  --wait-ms N        Wait after viewer.ready before sampling. Default: 2500.
`);
}

function parseArgs(argv) {

    const args = {};
    const rest = argv.slice(3);

    for (let i = 0; i < rest.length; i++) {

        const arg = rest[i];
        if (!arg.startsWith('--')) throw new Error(`Unexpected arg: ${arg}`);

        const key = arg.slice(2);
        const value = rest[++i];
        if (value == null) throw new Error(`Missing value for --${key}`);
        args[key] = value;
    }

    return args;
}

function parseGrid(raw) {

    const match = /^(\d+)x(\d+)$/.exec(raw || '33x21');
    if (!match) throw new Error(`Invalid grid size: ${raw}`);

    return [Number(match[1]), Number(match[2])];
}

function parsePosition(raw) {

    return raw.split(',').map((value, index) => {

        if (index === 0 || index === 3) return value;
        return Number(value);
    });
}

function finiteDepth(sample) {

    return sample.hit && Number.isFinite(sample.depth);
}

async function capture(args) {

    const baseUrl = args['base-url'];
    const outPath = args.out;

    if (!baseUrl) throw new Error('--base-url is required');
    if (!outPath) throw new Error('--out is required');

    const style = args.style || DefaultStyle;
    const position = parsePosition(args.pos || DefaultPosition);
    const [gridX, gridY] = parseGrid(args.grid);
    const width = Number(args.width || 1280);
    const height = Number(args.height || 800);
    const margin = Number(args.margin || 32);
    const waitMs = Number(args['wait-ms'] || 2500);

    const browser = await chromium.launch({
        headless: true,
        args: ['--ignore-gpu-blocklist', '--enable-gpu', '--use-angle=gl'],
    });

    const page = await browser.newPage({ viewport: { width, height } });
    const errors = [];

    page.on('console', message => {

        if (message.type() === 'error') errors.push(message.text());
    });
    page.on('pageerror', error => errors.push(error.message));
    page.on('requestfailed', request => errors.push(request.url()));

    await page.route('**/demos/map/**', async route => {

        const response = await route.fetch();
        const body = await response.text();
        const patched = body.replace(
            'cartolina.map({',
            'window.__depthViewer = cartolina.map({',
        );

        await route.fulfill({
            response,
            body: patched,
            headers: {
                ...response.headers(),
                'content-type': 'text/html; charset=UTF-8',
            },
        });
    });

    const url = new URL('/demos/map/', baseUrl);
    url.searchParams.set('style', style);
    url.searchParams.set('pos', position.join(','));
    url.searchParams.set('mapExposeFpsToWindow', '1');

    await page.goto(url.href, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__depthViewer);
    await page.evaluate(() => window.__depthViewer.ready);
    await page.waitForTimeout(waitMs);

    const payload = await page.evaluate(({ gridX, gridY, margin }) => {

        const viewer = window.__depthViewer;
        const width = window.innerWidth;
        const height = window.innerHeight;
        const samples = [];

        for (let gy = 0; gy < gridY; gy++) {

            const y = margin +
                ((height - margin * 2) * (gy + 0.5) / gridY);

            for (let gx = 0; gx < gridX; gx++) {

                const x = margin +
                    ((width - margin * 2) * (gx + 0.5) / gridX);
                const depth = viewer.getScreenDepth(x, y, 0);

                samples.push({
                    gx,
                    gy,
                    x,
                    y,
                    hit: !!(depth && depth[0]),
                    depth: depth ? depth[1] : null,
                });
            }
        }

        return { width, height, samples };
    }, { gridX, gridY, margin });

    await browser.close();

    const result = {
        kind: 'depth-hitmap-readings',
        capturedAt: new Date().toISOString(),
        baseUrl,
        style,
        position,
        grid: [gridX, gridY],
        margin,
        waitMs,
        errors,
        ...payload,
    };

    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify(result, null, 2) + '\n');

    const hitCount = result.samples.filter(finiteDepth).length;
    console.log(`${outPath}: ${hitCount}/${result.samples.length} hits`);

    if (errors.length) {

        console.error(errors.join('\n'));
        process.exitCode = 1;
    }
}

function compare(args) {

    const aPath = args.a;
    const bPath = args.b;

    if (!aPath) throw new Error('--a is required');
    if (!bPath) throw new Error('--b is required');

    const a = JSON.parse(fs.readFileSync(aPath, 'utf8'));
    const b = JSON.parse(fs.readFileSync(bPath, 'utf8'));

    if (a.samples.length !== b.samples.length) {
        throw new Error('sample counts differ');
    }

    const diffs = [];
    let hitMismatch = 0;
    let bothMiss = 0;

    for (let i = 0; i < a.samples.length; i++) {

        const as = a.samples[i];
        const bs = b.samples[i];

        if (as.gx !== bs.gx || as.gy !== bs.gy) {
            throw new Error(`sample grid mismatch at ${i}`);
        }

        if (as.hit !== bs.hit) {
            hitMismatch++;
            continue;
        }

        if (!as.hit) {
            bothMiss++;
            continue;
        }

        diffs.push(bs.depth - as.depth);
    }

    const n = diffs.length;
    const mean = diffs.reduce((sum, d) => sum + d, 0) / n;
    const meanAbs = diffs.reduce((sum, d) => sum + Math.abs(d), 0) / n;
    const absDiffs = diffs.map(Math.abs).sort((left, right) => left - right);
    const variance = diffs.reduce((sum, d) => {

        const centered = d - mean;
        return sum + centered * centered;
    }, 0) / n;
    const stdev = Math.sqrt(variance);
    const rmse = Math.sqrt(
        diffs.reduce((sum, d) => sum + d * d, 0) / n);
    const maxAbs = absDiffs[absDiffs.length - 1];

    function quantile(q) {

        return absDiffs[Math.floor((absDiffs.length - 1) * q)];
    }

    const result = {
        a: aPath,
        b: bPath,
        comparedHits: n,
        bothMiss,
        hitMismatch,
        meanError: mean,
        meanAbsError: meanAbs,
        stdev,
        rmse,
        maxAbsError: maxAbs,
        absErrorQuantiles: {
            median: quantile(0.5),
            p90: quantile(0.9),
            p95: quantile(0.95),
            p99: quantile(0.99),
        },
        absErrorCounts: {
            gt1m: absDiffs.filter(value => value > 1).length,
            gt10m: absDiffs.filter(value => value > 10).length,
            gt100m: absDiffs.filter(value => value > 100).length,
            gt1000m: absDiffs.filter(value => value > 1000).length,
        },
    };

    console.log(JSON.stringify(result, null, 2));
}

async function main() {

    const command = process.argv[2];

    if (command == null || command === '--help' || command === '-h') {
        usage();
        return;
    }

    const args = parseArgs(process.argv);

    if (command === 'capture') {
        await capture(args);
        return;
    }

    if (command === 'compare') {
        compare(args);
        return;
    }

    throw new Error(`Unknown command: ${command}`);
}

main().catch(error => {

    console.error(error);
    process.exit(1);
});
