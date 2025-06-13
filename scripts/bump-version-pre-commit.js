const fs = require('fs');
const { execSync } = require('child_process');

const pkgPath = 'package.json';
const versionPath = 'src/core/version.js';

const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));

// Bump patch
let [major, minor, patch] = pkg.version.split('.').map(Number);
patch++;

// Git metadata
let branch = execSync('git branch --show-current').toString().trim() || 'detached';
let commit = execSync('git rev-parse --short HEAD').toString().trim();

let metadata = (branch === 'main' || branch === 'master')
  ? `+${commit}`
  : `+${branch.replace(/[^\w-]/g, '_')}_${commit}`;

const newVersion = `${major}.${minor}.${patch}${metadata}`;

// Update package.json (only base version)
pkg.version = `${major}.${minor}.${patch}`;
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8');

// Write version.js
const output = `// This file is auto-generated. Do not edit manually.\n` +
               `// Use scripts/bump-patch.js to update version.\n\n` +
               `export function getVersion() {\n  return '${newVersion}';\n}\n`;

fs.writeFileSync(versionPath, output, 'utf8');
