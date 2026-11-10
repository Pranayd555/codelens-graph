import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'node:os';
import * as path from 'node:path';
import { detectModuleSystem, formatImport, importSpecifier } from '../src/context/importHints';
import { ContextBuilder } from '../src/context/contextBuilder';
import { GraphNode } from '../src/types';
import { TestWorkspace } from './helpers';

const node = (name: string, language: string, modifiers?: string[]): GraphNode => ({
  id: name, type: 'function', name, filePath: '/x', line: 1, endLine: 1, language, updatedAt: 0, modifiers,
});

describe('Import hints follow the importing file', () => {
  const ws = new TestWorkspace();

  before(async () => {
    ws.write('cjs/package.json', '{"name":"cjs-pkg"}');
    ws.write('cjs/requires.js', "const fs = require('fs');\nfunction a() {}\n");
    ws.write('cjs/exportsOnly.js', 'function b() {}\nmodule.exports = { b };\n');
    ws.write('cjs/plain.js', 'function c() {}\n');
    ws.write('esm/package.json', '{"name":"esm-pkg","type":"module"}');
    ws.write('esm/imports.js', "import fs from 'fs';\nexport function d() {}\n");
    ws.write('esm/plain.js', 'function e() {}\n');
    ws.write('esm/dynamic.js', "import('./x.js').then(() => {});\nmodule.exports = {};\n");
    ws.write('ts/plain.ts', 'function f() {}\n');
    ws.write('ext/a.mjs', 'function g() {}\n');
    ws.write('ext/b.cjs', 'function h() {}\n');
  });

  after(() => ws.close());

  it('detects the module system from imports, extension, then package.json "type"', () => {
    const at = (rel: string) => detectModuleSystem(ws.path(rel), ws.root);
    assert.equal(at('cjs/requires.js'), 'cjs');
    assert.equal(at('cjs/exportsOnly.js'), 'cjs');
    assert.equal(at('cjs/plain.js'), 'cjs', 'package.json without "type" means CommonJS');
    assert.equal(at('esm/imports.js'), 'esm');
    assert.equal(at('esm/plain.js'), 'esm', '"type": "module"');
    assert.equal(at('esm/dynamic.js'), 'cjs', 'import() is not an import statement');
    assert.equal(at('ts/plain.ts'), 'esm');
    assert.equal(at('ext/a.mjs'), 'esm');
    assert.equal(at('ext/b.cjs'), 'cjs');
  });

  it('never reads files outside the workspace', () => {
    assert.equal(detectModuleSystem(path.join(os.tmpdir(), 'elsewhere', 'x.js'), ws.root), 'esm');
  });

  it('formats named and default imports for each module system', () => {
    assert.equal(formatImport(node('dbAll', 'javascript'), '../utils/db', 'javascript', 'cjs'), "const { dbAll } = require('../utils/db');");
    assert.equal(formatImport(node('App', 'javascript', ['default']), './App', 'javascript', 'cjs'), "const App = require('./App');");
    assert.equal(formatImport(node('dbAll', 'typescript'), '../utils/db', 'typescript', 'esm'), "import { dbAll } from '../utils/db';");
    assert.equal(formatImport(node('App', 'tsx', ['default']), './App', 'tsx', 'esm'), "import App from './App';");
    assert.equal(formatImport(node('helper', 'python'), './pkg/utils', 'python', 'esm'), 'from pkg.utils import helper');
    assert.equal(formatImport(node('Service', 'java'), './Service', 'java', 'esm'), null);
  });

  it('builds specifiers without source extensions', () => {
    assert.equal(importSpecifier(ws.path('src/utils/db.js'), ws.path('src/services')), '../utils/db');
    assert.equal(importSpecifier(ws.path('src/a.ts'), ws.root), './src/a');
    assert.equal(importSpecifier(ws.path('pkg/utils.py'), ws.root), './pkg/utils');
  });
});

describe('Agent context for a CommonJS project', () => {
  const ws = new TestWorkspace();
  let context = '';

  before(async () => {
    ws.write('package.json', '{"name":"cjs-app","version":"1.0.0"}');
    ws.write('src/utils/date.js', 'function formatDate(d) { return String(d); }\nmodule.exports = { formatDate };\n');
    ws.write('src/utils/db.js', 'function dbAll() { return []; }\nmodule.exports = { dbAll };\n');
    // formatDate is used without being required: the diagnosis should say how to add it.
    ws.write('src/services/report.js', "const { dbAll } = require('../utils/db');\nfunction buildReport() { return formatDate(dbAll()); }\nmodule.exports = { buildReport };\n");
    await ws.scan();
    const builder = new ContextBuilder(ws.db);
    context = builder.buildSystemPromptInjection(builder.build('fix buildReport date formatting', 2, 4000, 'deep'), 'deep');
  });

  after(() => ws.close());

  it('suggests a require() relative to the file that needs it', () => {
    assert.match(context, /Add: const \{ formatDate \} = require\('\.\.\/utils\/date'\);/);
  });

  it('shows require() hints with workspace-root paths, never ES-module syntax', () => {
    assert.match(context, /Import as:\*\* `const \{ buildReport \} = require\('\.\/src\/services\/report'\);`/);
    assert.doesNotMatch(context, /import \{ \w+ \} from/);
  });
});
