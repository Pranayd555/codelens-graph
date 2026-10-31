#!/usr/bin/env node
// Checks a packaged VSIX: the runtime files are present and nothing that
// shouldn't ship (source maps, sources, tests, node_modules) slipped in.
// Usage: node scripts/check-vsix.js <file.vsix>
'use strict';
const fs = require('fs');

const REQUIRED = [
  'extension/package.json',
  'extension/dist/extension.js',
  'extension/dist/mcp.js',
  'extension/dist/mcp-run.js',
  'extension/dist/wasm/sql-wasm.wasm',
  'extension/dist/wasm/tree-sitter.wasm',
  'extension/dist/node_modules/d3/dist/d3.min.js',
];
const FORBIDDEN = [
  [/\.map$/, 'source map'],
  [/^extension\/src\//, 'TypeScript source'],
  [/^extension\/test\//, 'test file'],
  [/^extension\/scripts\//, 'build script'],
  [/^extension\/node_modules\//, 'node_modules (dist/ bundles everything)'],
  [/^extension\/\.codelens\//, 'local CodeLens index'],
  [/\.vsix$/, 'nested VSIX'],
];
const MAX_BYTES = 25 * 1024 * 1024;

// File names from the zip's central directory (no dependencies needed).
function zipEntries(buffer) {
  let end = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65557); i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) { end = i; break; }
  }
  if (end < 0) { throw new Error('not a zip file (no end of central directory)'); }
  const count = buffer.readUInt16LE(end + 10);
  let offset = buffer.readUInt32LE(end + 16);
  const names = [];
  for (let n = 0; n < count; n++) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) { throw new Error('corrupt central directory'); }
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    names.push(buffer.toString('utf8', offset + 46, offset + 46 + nameLength));
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return names;
}

const file = process.argv[2];
if (!file) {
  console.error('Usage: node scripts/check-vsix.js <file.vsix>');
  process.exit(2);
}
const buffer = fs.readFileSync(file);
const names = zipEntries(buffer).filter(name => !name.endsWith('/'));
const problems = [];

for (const required of REQUIRED) {
  if (!names.includes(required)) { problems.push(`missing ${required}`); }
}
if (!names.some(name => /^extension\/dist\/wasm\/tree-sitter-.+\.wasm$/.test(name))) {
  problems.push('missing language grammars (extension/dist/wasm/tree-sitter-*.wasm)');
}
for (const name of names) {
  for (const [pattern, what] of FORBIDDEN) {
    if (pattern.test(name)) { problems.push(`unexpected ${what}: ${name}`); }
  }
}
if (buffer.length > MAX_BYTES) {
  problems.push(`package is ${(buffer.length / 1048576).toFixed(1)} MB (limit ${MAX_BYTES / 1048576} MB)`);
}

console.log(`${file}: ${names.length} files, ${(buffer.length / 1048576).toFixed(1)} MB`);
if (problems.length) {
  for (const problem of problems) { console.error(`  ✗ ${problem}`); }
  process.exit(1);
}
console.log('  ✓ contents look right');
