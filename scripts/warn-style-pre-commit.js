/*
 * warn-style-pre-commit.js - warn about changed-hunk style violations
 */

const fs = require('fs');


const diff = fs.readFileSync(0, 'utf8');

const changedHunks = new Map();
let path = null;
let nextLine = 0;
let hunk = null;

for (const line of diff.split('\n')) {

    if (line.startsWith('+++ ')) {

        path = line.startsWith('+++ b/') ? line.slice(6) : null;
        hunk = null;
        continue;
    }

    if (line.startsWith('@@ ')) {

        const match = /\+(\d+)(?:,\d+)?/.exec(line);
        nextLine = match ? Number(match[1]) : 0;
        hunk = [];

        if (path && isSource(path)) {

            const hunks = changedHunks.get(path) ?? [];
            hunks.push(hunk);
            changedHunks.set(path, hunks);
        }

        continue;
    }

    if (line.startsWith('+') && !line.startsWith('+++ ') && path && hunk) {

        if (isSource(path)) {

            hunk.push({
                lineNumber: nextLine,
                text: line.slice(1),
                added: true,
            });
        }

        checkAddedLine(path, nextLine, line.slice(1));
        nextLine++;
        continue;
    }

    if (line.startsWith(' ') && path && hunk && isSource(path)) {

        hunk.push({ lineNumber: nextLine, text: line.slice(1), added: false });
    }

    if (!line.startsWith('-') && !line.startsWith('\\')) nextLine++;
}

for (const [changedPath, hunks] of changedHunks)
    for (const changedHunk of hunks)
        checkSingleStatementIfs(changedPath, changedHunk);


function isSource(candidate) {

    return candidate.endsWith('.ts') || candidate.endsWith('.js');
}


function checkAddedLine(changedPath, lineNumber, line) {

    if (!isSource(changedPath)) return;

    if (line.length > 80) {

        warn(changedPath, lineNumber,
            `line has ${line.length} columns (maximum is 80)`);
    }

    if (/\belse\s+if\b/.test(line)) {

        warn(changedPath, lineNumber,
            'else if chain; use nested or independent if blocks');
    }
}


function checkSingleStatementIfs(changedPath, lines) {

    for (let index = 0; index < lines.length; index++) {

        if (!/\bif\s*\(/.test(lines[index].text)) continue;

        const openingIndex = openingBrace(lines, index);
        if (openingIndex === null) continue;

        const closingIndex = closingBrace(lines, openingIndex);
        if (closingIndex === null
            || closingIndex !== openingIndex + 2) continue;

        const affected = lines.slice(index, closingIndex + 1).some(
            (line) => line.added);
        if (!affected) continue;

        const body = lines[openingIndex + 1].text.trim();
        if (!/^(?:return|throw\b|[\w.]+\(.*\);)/.test(body)) continue;

        warn(changedPath, lines[index].lineNumber,
            'single-statement if block; omit braces');
    }
}


function openingBrace(lines, ifIndex) {

    for (let index = ifIndex; index < lines.length; index++) {

        if (lines[index].text.includes('{')) return index;
        if (lines[index].text.includes(';')) return null;
    }

    return null;
}


function closingBrace(lines, openingIndex) {

    let depth = 0;

    for (let index = openingIndex; index < lines.length; index++) {

        for (const character of lines[index].text) {

            if (character === '{') depth++;
            if (character === '}') depth--;
        }

        if (depth === 0) return index;
    }

    return null;
}


function warn(changedPath, lineNumber, message) {

    console.warn(
        `pre-commit: style warning: ${changedPath}:${lineNumber}: ${message}`);
}
