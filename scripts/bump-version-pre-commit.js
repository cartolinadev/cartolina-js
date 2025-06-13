
const fs = require('fs');
const { execSync } = require('child_process');

const pkgPath = 'package.json';
const versionPath = 'src/core/version.js';

// Load package.json
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));

// Parse base version
let [major, minor, patchWithTag] = pkg.version.split('.');
let patch = parseInt(patchWithTag, 10);

// Git branch and commit
let branch = execSync('git branch --show-current').toString().trim() || 'detached';
let commit = execSync('git rev-parse --short HEAD').toString().trim();

// Sanitize branch: replace non-word chars with underscores
let safeBranch = branch.replace(/[^\w]/g, '_');

// Compose prerelease
let prerelease = (branch === 'main' || branch === 'master')
  ? ''
  : `-${safeBranch}.${commit}`;

// Increment base patch
patch++;

// Compose versions
const newBaseVersion = `${major}.${minor}.${patch}`;
const fullVersion = `${newBaseVersion}${prerelease}`;

// Update package.json
pkg.version = fullVersion;
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8');

// Write version.js
const versionFileContent =
  `// This file is auto-generated. Do not edit manually.\n` +
  `// Use scripts/bump-patch.js to update version.\n\n` +
  `export default function getVersion() {\n  return '${fullVersion}';\n}\n`;

fs.writeFileSync(versionPath, versionFileContent, 'utf8');
