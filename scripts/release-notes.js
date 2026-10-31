#!/usr/bin/env node
// Prints the changelog section for one version (used as GitHub Release notes).
// Usage: node scripts/release-notes.js <version>   e.g. 0.3.2
'use strict';
const fs = require('fs');
const path = require('path');

const version = (process.argv[2] || '').replace(/^v/, '');
if (!version) {
  console.error('Usage: node scripts/release-notes.js <version>');
  process.exit(2);
}
const changelog = fs.readFileSync(path.join(__dirname, '..', 'changelog.md'), 'utf8').replace(/\r\n/g, '\n');
const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const match = new RegExp(`^## \\[${escaped}\\][^\\n]*\\n([\\s\\S]*?)(?=^## \\[|(?![\\s\\S]))`, 'm').exec(changelog);
if (!match) {
  console.error(`changelog.md has no "## [${version}]" section`);
  process.exit(1);
}
process.stdout.write(match[1].replace(/\n---\s*$/, '').trim() + '\n');
