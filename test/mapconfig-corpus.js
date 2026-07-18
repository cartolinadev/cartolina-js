/*
 * mapconfig-corpus.js - strict conversion of the public mapConfig
 * corpus (RFC 11 phase-3 closure gate)
 *
 * Usage:
 *   node test/mapconfig-corpus.js
 *
 * Converts every mapConfig-based entry of test/urls.json with
 * mapConfigToStyle() in strict mode, prints the notes, and writes
 * each converted style to tmp/mapconfig-corpus/<id>.json for
 * snapshot review and browser rendering. Requires the compiled unit
 * build (npm run test:unit compiles it) and network access to the
 * corpus URLs. Exits non-zero when any input fails strict
 * conversion.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const { mapConfigToStyle } =
    require('../tmp/unit-build/src/compat/mapconfig-to-style');

const URLS_FILE = path.join(__dirname, 'urls.json');
const OUT_DIR = path.join('tmp', 'mapconfig-corpus');

async function main() {

    const { urls } = JSON.parse(fs.readFileSync(URLS_FILE, 'utf8'));

    // every mapConfig-based entry is a public conversion input
    const entries = urls.filter((entry) => entry.url);
    fs.mkdirSync(OUT_DIR, { recursive: true });

    let failed = 0;

    for (const entry of entries) {

        const mapConfigUrl =
            entry.url.replace(/\/+$/, '') + '/mapConfig.json';
        process.stdout.write(`[${entry.id}] ${mapConfigUrl}\n`);

        try {

            const conversion = await mapConfigToStyle(
                mapConfigUrl, { strict: true });

            for (const note of conversion.notes) {
                console.log(`  note [${note.code}] ${note.path}: `
                    + note.message);
            }

            const outFile = path.join(OUT_DIR, `${entry.id}.json`);
            fs.writeFileSync(outFile, JSON.stringify({
                style: conversion.style,
                position: conversion.position,
                viewerOptions: conversion.viewerOptions,
                profiles: conversion.profiles,
            }, null, 2));

            console.log(`  ok -> ${outFile} `
                + `(${conversion.notes.length} notes)`);

        } catch (error) {

            failed++;
            console.log(`  FAIL ${error.message}`);
        }
    }

    process.exit(failed ? 1 : 0);
}

main().catch((error) => { console.error(error); process.exit(2); });
