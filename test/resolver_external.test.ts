import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { TestWorkspace } from './helpers';

// A call bound to an npm package or Node built-in must not be linked to an
// unrelated same-named symbol elsewhere in the workspace — while workspace
// packages and unresolved aliases keep resolving by name.
describe('Calls bound to packages outside the workspace', () => {
  const ws = new TestWorkspace();

  before(async () => {
    // Unrelated symbols that share names with package exports.
    ws.write('other/buffer.js', 'const equal = (a, b) => a === b;\nfunction leftPad(s) { return s; }\nfunction join() { return 1; }\nfunction readFile() { return 2; }\nmodule.exports = { equal, leftPad, join, readFile };\n');

    // Installed package (node_modules/fast-deep-equal).
    ws.write('node_modules/fast-deep-equal/package.json', '{"name":"fast-deep-equal","version":"3.1.3","main":"index.js"}');
    ws.write('node_modules/fast-deep-equal/index.js', 'module.exports = function equal(a, b) { return a === b; };\n');
    ws.write('cjs/resolve.js', "const equal = require('fast-deep-equal');\nfunction checkRef(a, b) { return equal(a, b); }\nmodule.exports = { checkRef };\n");
    ws.write('esm/resolve.mjs', "import equal from 'fast-deep-equal';\nexport function checkRefEsm(a, b) { return equal(a, b); }\n");

    // Declared in package.json but not installed.
    ws.write('package.json', JSON.stringify({
      name: 'fixture', version: '1.0.0',
      dependencies: { 'fast-deep-equal': '^3.1.3', 'left-pad': '^1.3.0', '@acme/shared': 'workspace:*' },
    }));
    ws.write('cjs/pad.js', "const leftPad = require('left-pad');\nfunction pad(s) { return leftPad(s); }\nmodule.exports = { pad };\n");

    // Node built-ins, with and without the node: prefix.
    ws.write('cjs/paths.js', "const { join } = require('path');\nfunction joinAll(a) { return join(a); }\nmodule.exports = { joinAll };\n");
    ws.write('esm/read.mjs', "import { readFile } from 'node:fs';\nexport function readIt(p) { return readFile(p); }\n");

    // A monorepo package symlinked into node_modules stays a workspace target.
    ws.write('packages/shared/index.js', 'function sharedFn() { return 1; }\nmodule.exports = { sharedFn };\n');
    fs.mkdirSync(ws.path('node_modules/@acme'), { recursive: true });
    fs.symlinkSync(ws.path('packages/shared'), ws.path('node_modules/@acme/shared'), 'junction');
    ws.write('app/useShared.js', "const { sharedFn } = require('@acme/shared');\nfunction useShared() { return sharedFn(); }\nmodule.exports = { useShared };\n");

    // An unresolved path alias keeps name-based resolution.
    ws.write('src/utils/helper.ts', 'export function aliasHelper() { return 1; }\n');
    ws.write('src/feature.ts', "import { aliasHelper } from '@/utils/helper';\nexport function feature() { return aliasHelper(); }\n");

    // A package path mentioning a local name does not bind that name.
    ws.write('src/merge.js', 'function merge(a, b) { return a; }\nmodule.exports = { merge };\n');
    ws.write('src/useMerge.js', "const deepMerge = require('fast-deep-equal/merge');\nconst { merge } = require('./merge');\nfunction combine(a, b) { return merge(a, b); }\nmodule.exports = { combine };\n");

    await ws.scan();
  });

  after(() => ws.close());

  it('does not link a CommonJS call into an installed package to a same-named local symbol', () => {
    assert.deepStrictEqual(ws.callsFrom('checkRef'), []);
  });

  it('does not link an ES-module call into an installed package to a same-named local symbol', () => {
    assert.deepStrictEqual(ws.callsFrom('checkRefEsm'), []);
  });

  it('treats a package declared in package.json but not installed as external', () => {
    assert.deepStrictEqual(ws.callsFrom('pad'), []);
  });

  it('treats Node built-ins as external, with or without the node: prefix', () => {
    assert.deepStrictEqual(ws.callsFrom('joinAll'), []);
    assert.deepStrictEqual(ws.callsFrom('readIt'), []);
  });

  it('still links into a workspace package symlinked into node_modules', () => {
    assert.deepStrictEqual(ws.callsFrom('useShared'), ['sharedFn@packages/shared/index.js']);
  });

  it('still links through an unresolved path alias by name', () => {
    assert.deepStrictEqual(ws.callsFrom('feature'), ['aliasHelper@src/utils/helper.ts']);
  });

  it('does not treat a name inside a package path as bound to that package', () => {
    assert.deepStrictEqual(ws.callsFrom('combine'), ['merge@src/merge.js']);
  });
});
