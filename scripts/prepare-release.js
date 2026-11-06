#!/usr/bin/env node
// Prepares a release on dev: turns `## [Unreleased]` in changelog.md into
// `## [x.y.z] - YYYY-MM-DD` (with a fresh, empty Unreleased section above it)
// and sets the version in package.json, package-lock.json and the README.
// Usage: npm run release:prepare -- 0.4.0
'use strict';
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8');
const write = (rel, text) => fs.writeFileSync(path.join(root, rel), text);
const fail = message => { console.error(message); process.exit(1); };

const version = (process.argv[2] || '').replace(/^v/, '');
if (!/^\d+\.\d+\.\d+$/.test(version)) { fail('Usage: npm run release:prepare -- <x.y.z>'); }

const pkg = JSON.parse(read('package.json'));
const parse = v => v.split('.').map(Number);
const newer = (a, b) => { for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) { return a[i] > b[i]; } } return false; };
if (!newer(parse(version), parse(pkg.version))) { fail(`${version} is not newer than the current version ${pkg.version}`); }

// changelog.md: the Unreleased notes become the release's notes.
const rawChangelog = read('changelog.md');
const eol = rawChangelog.includes('\r\n') ? '\r\n' : '\n';
const changelog = rawChangelog.replace(/\r\n/g, '\n');
const start = changelog.indexOf('## [Unreleased]');
if (start < 0) { fail('changelog.md has no "## [Unreleased]" section'); }
const bodyStart = changelog.indexOf('\n', start) + 1;
const next = changelog.slice(bodyStart).search(/^## \[/m);
const bodyEnd = next < 0 ? changelog.length : bodyStart + next;
const notes = changelog.slice(bodyStart, bodyEnd).replace(/\n---\s*$/, '').trim();
if (!notes) { fail('The Unreleased section of changelog.md is empty: nothing to release.'); }
if (changelog.includes(`## [${version}]`)) { fail(`changelog.md already has a ${version} section`); }
const date = new Date().toISOString().slice(0, 10);
const released = `## [Unreleased]\n\n---\n\n## [${version}] - ${date}\n\n${notes}\n\n---\n\n`;
write('changelog.md', (changelog.slice(0, start) + released + changelog.slice(bodyEnd)).replace(/\n/g, eol));

// package.json: change only the version line, keeping the file's formatting.
const rawPkg = read('package.json');
const pkgOut = rawPkg.replace(/("version":\s*")[^"]+(")/, `$1${version}$2`);
write('package.json', pkgOut);

// package-lock.json: the root package's version, in both places npm keeps it.
const rawLock = read('package-lock.json');
const lock = JSON.parse(rawLock);
lock.version = version;
if (lock.packages && lock.packages['']) { lock.packages[''].version = version; }
const lockEol = rawLock.includes('\r\n') ? '\r\n' : '\n';
write('package-lock.json', (JSON.stringify(lock, null, 2) + '\n').replace(/\n/g, lockEol));

// README install line.
const readme = read('README.md');
write('README.md', readme.replace(/codelens-graph-\d+\.\d+\.\d+\.vsix/g, `codelens-graph-${version}.vsix`));

console.log(`Prepared ${version}:`);
console.log(`  changelog.md       Unreleased → [${version}] - ${date}`);
console.log(`  package.json       ${pkg.version} → ${version}`);
console.log('  package-lock.json, README.md');
console.log('\nNext: review the notes, commit "Release ' + version + '", and open a pull request from dev to main.');
