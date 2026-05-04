'use strict';

const fs = require('fs');
const { chromium } = require('playwright');

const DEFAULT_URL = 'http://localhost:3000/#/30';
const DEFAULT_VIEWPORT = '1200x800';
const DEFAULT_WAIT_MS = 35000;

function usage() {

    console.error(
        'Usage: node test/diagnostics/label-pipeline.js <output.json> ' +
        '[url] [label] [viewport] [waitMs]'
    );
    console.error(
        'Example: node test/diagnostics/label-pipeline.js ' +
        'tmp/labels.json http://localhost:3000/#/30 Brennkogel 1200x800'
    );
}


function parseViewport(value) {

    const match = /^([1-9][0-9]*)x([1-9][0-9]*)$/.exec(value);
    if (!match) {
        throw new Error('Invalid viewport. Expected WIDTHxHEIGHT.');
    }

    return {
        width: Number(match[1]),
        height: Number(match[2])
    };
}


function includesLabel(item, label) {

    if (!label) return false;

    const text = `${item.name || ''} ${item.jobId || ''} ${item.id || ''}`;
    return text.includes(label);
}


const outputPath = process.argv[2];
const url = process.argv[3] || DEFAULT_URL;
const label = process.argv[4] || '';
const viewportText = process.argv[5] || DEFAULT_VIEWPORT;
const waitMs = Number(process.argv[6] || DEFAULT_WAIT_MS);

if (!outputPath) {
    usage();
    process.exit(2);
}

const viewport = parseViewport(viewportText);

(async () => {

    const browser = await chromium.launch({
        headless: true,
        args: ['--ignore-gpu-blocklist', '--enable-gpu', '--use-angle=gl'],
    });
    const page = await browser.newPage({
        viewport,
        deviceScaleFactor: 1,
    });

    let last = null;
    const errors = [];

    page.on('console', message => {

        const text = message.text();

        if (text.startsWith('LABEL_PIPELINE ')) {
            last = text.slice('LABEL_PIPELINE '.length);
        }

        if (message.type() === 'error') {
            errors.push(text);
        }
    });

    page.on('pageerror', error => {
        errors.push(String(error));
    });

    page.on('requestfailed', request => {
        const failure = request.failure();
        errors.push(
            'requestfailed: ' + request.url() + ' :: ' +
            (failure && failure.errorText)
        );
    });

    await page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: 60000,
    });
    await page.waitForTimeout(waitMs);
    await browser.close();

    if (!last) {
        console.error('NO_LABEL_PIPELINE');
        console.error(errors.join('\n'));
        process.exit(2);
    }

    fs.writeFileSync(outputPath, last + '\n');

    const data = JSON.parse(last);
    const summary = {
        url,
        viewport,
        waitMs,
        frame: data.frame,
        apparentSize: data.apparentSize,
        counts: Object.fromEntries(
            Object.entries(data.pipeline).map(([key, value]) => [
                key, value.length
            ])
        ),
        errors: errors.slice(0, 5),
    };

    if (label) {
        summary.label = label;
        summary.labelStages = Object.fromEntries(
            Object.entries(data.pipeline).map(([key, value]) => [
                key,
                value.filter(item => includesLabel(item, label))
            ])
        );
    }

    console.log(JSON.stringify(summary, null, 2));

})().catch(error => {
    console.error(error);
    process.exit(1);
});
