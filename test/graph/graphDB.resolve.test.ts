import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { GraphDB } from '../../src/graph/graphDB';
import { GraphNode } from '../../src/types';
import { SharedParserWorkspace } from './graphFixtures';
import { GraphFixture, makeNode, fileNode, importNode, callRef, dumpEdges, withClock } from './graphFixtures';

// ─── Import edges (hand-built nodes, real files on disk) ─────────────────────

describe('Import edge resolution', () => {
  const fx = new GraphFixture();
  let db: GraphDB;
  const importer = fx.path('src/app.ts');

  // Writes the file and stores its file node.
  const addFile = (rel: string, language = 'typescript') => {
    const f = fx.write(rel, '// fixture\n');
    db.upsertNode(fileNode(f, { language }));
    return f;
  };
  const importTargets = (from: string) =>
    db.getEdgesFrom(`${from}::__file__::0`).map(e => [path.relative(fx.root, e.toId.split('::')[0]).split(path.sep).join('/'), e.type, e.metadata?.source]);

  before(async () => {
    db = await fx.open();
    addFile('src/app.ts');
    addFile('src/util.ts');
    addFile('src/lib/index.ts');
    addFile('src/both.ts');
    addFile('src/both/index.ts');
    addFile('shared/x.js', 'javascript');
    addFile('node_modules/dep/index.js', 'javascript');
    addFile('node_modules/dep/inner.js', 'javascript');
    addFile('node_modules/peer/main.js', 'javascript');
    addFile('main.py', 'python');
    addFile('pkg/mod.py', 'python');
    addFile('pkg/sub/__init__.py', 'python');

    db.upsertNodes([
      importNode(importer, './util', "import { u } from './util'", 1),
      importNode(importer, '../shared/x.js', "import x from '../shared/x.js'", 2),
      importNode(importer, '../node_modules/dep/index.js', "import d from '../node_modules/dep/index.js'", 3),
      importNode(importer, './missing', "import m from './missing'", 4),
      importNode(importer, 'react', "import React from 'react'", 5),
      importNode(fx.path('node_modules/dep/index.js'), './inner', "require('./inner')", 1, 'javascript'),
      importNode(fx.path('node_modules/dep/index.js'), '../peer/main.js', "require('../peer/main.js')", 2, 'javascript'),
      importNode(fx.path('main.py'), 'pkg.mod', 'import pkg.mod', 1, 'python'),
      importNode(fx.path('main.py'), 'pkg.sub', 'import pkg.sub', 2, 'python'),
    ]);
    await db.resolveWorkspaceRelationships();
  });
  after(() => fx.close());

  it('resolves relative imports with or without an extension and records the source', () => {
    assert.deepEqual(importTargets(importer), [
      ['src/util.ts', 'imports', './util'],
      ['shared/x.js', 'imports', '../shared/x.js'],
      ['node_modules/dep/index.js', 'depends-on', '../node_modules/dep/index.js'],
    ]);
  });

  it('only resolves imports of workspace files (dependency files are not importers)', () => {
    // resolveImportEdges only walks workspace importers, so its 'peer-dependency'
    // branch (dependency file importing a dependency file) is never reached.
    assert.deepEqual(importTargets(fx.path('node_modules/dep/index.js')), []);
  });

  it('resolves Python dotted imports to modules', () => {
    assert.deepEqual(importTargets(fx.path('main.py'))[0], ['pkg/mod.py', 'imports', 'pkg.mod']);
  });

  it('resolves an import of a directory to its index file', {
    todo: 'BUG: resolveImportPath tries the bare base path first and fs.existsSync() is true for a directory, so "./lib" or Python "pkg.sub" resolves to the folder and no edge is made',
  }, async () => {
    db.upsertNodes([
      importNode(importer, './lib', "import { l } from './lib'", 6),
      importNode(importer, './both', "import { b } from './both'", 7),
    ]);
    await db.resolveWorkspaceRelationships();
    const targets = importTargets(importer).map(t => t[0]);
    assert.ok(targets.includes('src/lib/index.ts'), `got ${targets}`);
    assert.ok(targets.includes('src/both.ts'), 'a file wins over a same-named folder');
    assert.deepEqual(importTargets(fx.path('main.py'))[1], ['pkg/sub/__init__.py', 'imports', 'pkg.sub']);
  });
});

// ─── Call edges (hand-built nodes) ───────────────────────────────────────────

describe('Call resolution rules', () => {
  let fx: GraphFixture;
  let db: GraphDB;
  beforeEach(async () => { fx = new GraphFixture(); db = await fx.open(); });
  afterEach(() => fx.close());

  // Stores a file (on disk and as a file node) with the given symbols and imports.
  function file(rel: string, symbols: GraphNode[] = [], imports: Array<[string, string]> = [], language = 'typescript'): string {
    const f = fx.write(rel, '// fixture\n');
    db.upsertNodes([
      fileNode(f, { language }),
      ...imports.map(([source, sig], i) => importNode(f, source, sig, 100 + i, language)),
      ...symbols.map(s => ({ ...s, filePath: f, id: `${f}::${s.name}::${s.line}`, language })),
    ]);
    return f;
  }
  const fn = (name: string, line = 1, extra: Partial<GraphNode> = {}) => makeNode('', name, 'function', line, extra);
  const callsOf = (filePath: string, name: string, line = 1) =>
    db.getEdgesFrom(`${filePath}::${name}::${line}`, 'calls').map(e => {
      const target = db.getNode(e.toId)!;
      return `${target.name}@${path.relative(fx.root, target.filePath).split(path.sep).join('/')}:${e.metadata?.resolution}`;
    });
  async function call(caller: string, callerName: string, symbol: string, qualifier?: string) {
    db.upsertCallRefs([callRef(db.getNode(`${caller}::${callerName}::1`)!, symbol, 2, qualifier)]);
    await db.resolveWorkspaceRelationships();
  }

  it('prefers a definition in the same file', async () => {
    file('b.ts', [fn('helper', 1, { modifiers: ['export'] })]);
    const a = file('a.ts', [fn('main'), fn('helper', 10)]);
    await call(a, 'main', 'helper');
    assert.deepEqual(callsOf(a, 'main'), ['helper@a.ts:same-file']);
  });

  it('prefers the imported file over other same-named definitions', async () => {
    file('b.ts', [fn('helper')]);
    file('c.ts', [fn('helper', 1, { modifiers: ['export'] })]);
    const a = file('a.ts', [fn('main')], [['./b', "import { helper } from './b'"]]);
    await call(a, 'main', 'helper');
    assert.deepEqual(callsOf(a, 'main'), ['helper@b.ts:workspace']);
  });

  it('follows `as` aliases and CommonJS destructuring aliases', async () => {
    file('b.ts', [fn('helper')]);
    file('c.ts', [fn('other')]);
    const a = file('a.ts', [fn('main')], [['./b', "import { helper as h } from './b'"]]);
    await call(a, 'main', 'h');
    assert.deepEqual(callsOf(a, 'main'), ['helper@b.ts:workspace']);

    const d = file('d.js', [fn('run')], [['./c', "const { other: o } = require('./c')"]], 'javascript');
    await call(d, 'run', 'o');
    assert.deepEqual(callsOf(d, 'run'), ['other@c.ts:workspace']);
  });

  it('links a default import with a different local name to the default export', async () => {
    file('b.ts', [fn('realName', 1, { modifiers: ['export', 'default'] }), fn('notDefault', 5)]);
    const a = file('a.ts', [fn('main')], [['./b', "import localName from './b'"]]);
    await call(a, 'main', 'localName');
    assert.deepEqual(callsOf(a, 'main'), ['realName@b.ts:workspace']);
  });

  it('links a lone candidate anywhere, but not an ambiguous unscored one', async () => {
    file('b.ts', [makeNode('', 'onlyOne', 'variable', 1)]);
    file('c.ts', [makeNode('', 'twice', 'variable', 1)]);
    file('d.ts', [makeNode('', 'twice', 'variable', 1)]);
    const a = file('a.ts', [fn('main')]);
    db.upsertCallRefs([callRef(db.getNode(`${a}::main::1`)!, 'onlyOne', 2), callRef(db.getNode(`${a}::main::1`)!, 'twice', 3)]);
    await db.resolveWorkspaceRelationships();
    assert.deepEqual(callsOf(a, 'main'), ['onlyOne@b.ts:workspace']);
  });

  it('breaks ties between equally scored candidates by file path', async () => {
    file('z.ts', [fn('dup', 1, { modifiers: ['export'] })]);
    file('m.ts', [fn('dup', 1, { modifiers: ['export'] })]);
    const a = file('a.ts', [fn('main')]);
    await call(a, 'main', 'dup');
    assert.deepEqual(callsOf(a, 'main'), ['dup@m.ts:workspace']);
  });

  it('does not link a recursive call to itself, nor to import or file nodes', async () => {
    const a = file('a.ts', [fn('main')], [['main', "import main from 'main'"]]);
    await call(a, 'main', 'main');
    assert.deepEqual(callsOf(a, 'main'), []);
  });

  it('treats a qualified call through a built-in namespace import as external', async () => {
    file('b.ts', [fn('readFile')]);
    const a = file('a.ts', [fn('main')], [['fs', "import * as fs from 'fs'"]]);
    await call(a, 'main', 'readFile', 'fs');
    assert.deepEqual(callsOf(a, 'main'), []);
  });

  it('keeps name-based resolution for file:/link: packages and non-JS imports', async () => {
    db.replacePackages([
      { name: 'local-lib', declaredRange: 'file:../local-lib', kind: 'dependencies' as any, declaredIn: [], installed: false, version: null, dir: null, types: null, main: null, readme: null },
      { name: 'linked', declaredRange: 'link:../linked', kind: 'dependencies' as any, declaredIn: [], installed: false, version: null, dir: null, types: null, main: null, readme: null },
      { name: 'remote', declaredRange: '^1.0.0', kind: 'dependencies' as any, declaredIn: [], installed: false, version: null, dir: null, types: null, main: null, readme: null },
    ]);
    file('lib.ts', [fn('fromLocal'), fn('fromLinked'), fn('fromRemote'), fn('fromPy')]);
    const a = file('a.ts', [fn('useLocal'), fn('useLinked', 1), fn('useRemote', 1)], [
      ['local-lib', "import { fromLocal } from 'local-lib'"],
      ['linked', "import { fromLinked } from 'linked'"],
      ['remote', "import { fromRemote } from 'remote'"],
    ]);
    const node = (n: string) => db.getNode(`${a}::${n}::1`)!;
    const py = file('p.py', [fn('usePy')], [['requests', 'from requests import fromPy']], 'python');
    db.upsertCallRefs([
      callRef(node('useLocal'), 'fromLocal', 2), callRef(node('useLinked'), 'fromLinked', 3),
      callRef(node('useRemote'), 'fromRemote', 4), callRef(db.getNode(`${py}::usePy::1`)!, 'fromPy', 2),
    ]);
    await db.resolveWorkspaceRelationships();
    assert.deepEqual(callsOf(a, 'useLocal'), ['fromLocal@lib.ts:workspace']);
    assert.deepEqual(callsOf(a, 'useLinked'), ['fromLinked@lib.ts:workspace']);
    assert.deepEqual(callsOf(a, 'useRemote'), []);
    assert.deepEqual(callsOf(py, 'usePy'), ['fromPy@lib.ts:workspace']);
  });

  it('finds packages installed in a node_modules folder above the importer', async () => {
    fx.write('node_modules/@org/tool/package.json', '{"name":"@org/tool"}');
    file('b.ts', [fn('tool')]);
    const a = file('deep/er/a.ts', [fn('main')], [['@org/tool/sub', "import { tool } from '@org/tool/sub'"]]);
    await call(a, 'main', 'tool');
    assert.deepEqual(callsOf(a, 'main'), []);
  });

  it('yields to the event loop during a long resolve and still produces every edge', async () => {
    const target = file('t.ts', [fn('target', 1, { modifiers: ['export'] })]);
    const callers: string[] = [];
    for (let i = 0; i < 5; i++) {
      callers.push(file(`c${i}.ts`, [fn('caller')], [['./t', "import { target } from './t'"]]));
    }
    db.upsertCallRefs(callers.map(c => callRef(db.getNode(`${c}::caller::1`)!, 'target', 2)));
    let t = 0;
    // Every clock read is 100 ms later, so the resolver commits and yields at each step.
    await withClock(() => (t += 100), () => db.resolveWorkspaceRelationships());
    for (const c of callers) { assert.deepEqual(callsOf(c, 'caller'), ['target@t.ts:workspace']); }
    assert.equal(db.getEdgesTo(`${target}::__file__::0`, 'imports').length, 5);
  });
});

// ─── Full vs incremental resolve (real parser) ───────────────────────────────

// After an incremental update, a full resolve over the same graph must not
// change any call or import edge.
describe('Incremental resolve matches a full resolve', () => {
  let ws: SharedParserWorkspace;
  beforeEach(() => { ws = new SharedParserWorkspace(); });
  afterEach(() => ws.close());

  async function seed() {
    ws.write('src/util.ts', 'export function helper() { return 1; }\nexport function other() { return 2; }\n');
    ws.write('src/dup.ts', 'export function helper() { return 3; }\n');
    ws.write('src/app.ts', "import { helper, other } from './util';\nimport { lateFn } from './late';\nexport function main() { helper(); other(); return lateFn(); }\n");
    ws.write('src/local.ts', 'function helper() { return 0; }\nexport function useLocal() { return helper(); }\n');
    ws.write('src/lib/index.ts', 'export function libFn() { return 1; }\n');
    ws.write('src/useLib.ts', "import { libFn } from './lib/index';\nexport function useLib() { return libFn(); }\n");
    ws.write('py/pkg/mod.py', 'def py_fn():\n    return 1\n');
    ws.write('py/main.py', 'import pkg.mod\n\ndef run():\n    return py_fn()\n');
    await ws.scan();
  }

  const edges = () => dumpEdges(ws.db, ws.root, true);
  async function assertMatchesFull(label: string) {
    const incremental = edges();
    await ws.db.resolveWorkspaceRelationships();
    assert.deepEqual(incremental, edges(), label);
  }
  // Mirrors BackgroundScanner: re-parse or delete each file, then resolve the batch once.
  async function applyBatch(changes: Array<[string, string | null]>) {
    const files: string[] = [];
    const symbols = new Set<string>();
    const collect = (f: string) => {
      for (const n of ws.db.getNodesByFile(f)) { if (n.type !== 'file' && n.type !== 'import') { symbols.add(n.name); } }
    };
    for (const [rel, text] of changes) {
      const f = ws.path(rel);
      collect(f);
      if (text === null) {
        fs.rmSync(f);
        ws.db.deleteNodesByFile(f);
      } else {
        ws.write(rel, text);
        const parsed = await ws.scanner.updateFile(f, false);
        for (const n of parsed.nodes) { if (n.type !== 'file' && n.type !== 'import') { symbols.add(n.name); } }
      }
      files.push(f);
    }
    await ws.db.resolveWorkspaceRelationships(files, [...symbols]);
  }

  it('after the initial scan', async () => {
    await seed();
    assert.ok(ws.callsFrom('main').includes('helper@src/util.ts'));
    assert.deepEqual(ws.callsFrom('useLocal'), ['helper@src/local.ts']);
    await assertMatchesFull('initial scan');
  });

  it('after editing a callee without changing its symbols', async () => {
    await seed();
    ws.write('src/util.ts', '// edited\nexport function helper() { return 10; }\nexport function other() { return 20; }\n');
    await ws.scanner.updateFile(ws.path('src/util.ts'));
    assert.ok(ws.callsFrom('main').includes('helper@src/util.ts'));
    await assertMatchesFull('callee edited');
  });

  it('after renaming a callee', async () => {
    await seed();
    ws.write('src/util.ts', 'export function helperRenamed() { return 1; }\nexport function other() { return 2; }\n');
    await ws.scanner.updateFile(ws.path('src/util.ts'));
    await assertMatchesFull('callee renamed');
    ws.write('src/util.ts', 'export function helper() { return 1; }\nexport function other() { return 2; }\n');
    await ws.scanner.updateFile(ws.path('src/util.ts'));
    await assertMatchesFull('callee renamed back');
  });

  it('after editing a caller', async () => {
    await seed();
    ws.write('src/app.ts', "import { other } from './util';\nexport function main() { return other(); }\nexport function second() { return helper(); }\n");
    await ws.scanner.updateFile(ws.path('src/app.ts'));
    assert.deepEqual(ws.callsFrom('main'), ['other@src/util.ts']);
    await assertMatchesFull('caller edited');
  });

  it('after creating a file an importer was waiting for', async () => {
    await seed();
    assert.ok(!ws.callsFrom('main').some(c => c.startsWith('lateFn')));
    await applyBatch([['src/late.ts', 'export function lateFn() { return 1; }\n']]);
    assert.ok(ws.callsFrom('main').includes('lateFn@src/late.ts'));
    assert.ok(ws.db.getEdgesFrom(ws.db.getNodesByFile(ws.path('src/app.ts'))[0].id, 'imports')
      .some(e => e.toId.startsWith(ws.path('src/late.ts'))));
    await assertMatchesFull('file created');
  });

  it('after deleting an imported file', async () => {
    await seed();
    await applyBatch([['src/util.ts', null]]);
    assert.deepEqual(ws.callsFrom('main'), ['helper@src/dup.ts']);
    await assertMatchesFull('file deleted');
  });

  it('after moving a symbol between files in one batch', async () => {
    await seed();
    await applyBatch([
      ['src/util.ts', 'export function other() { return 2; }\n'],
      ['src/moved.ts', 'export function helper() { return 1; }\n'],
    ]);
    await assertMatchesFull('symbol moved');
  });

  it('after changing an index file and a Python module', async () => {
    await seed();
    await applyBatch([
      ['src/lib/index.ts', 'export function libFn() { return 2; }\nexport function libFn2() { return 3; }\n'],
      ['py/pkg/mod.py', 'def py_fn():\n    return 2\n\ndef extra():\n    return 3\n'],
    ]);
    assert.deepEqual(ws.callsFrom('useLib'), ['libFn@src/lib/index.ts']);
    assert.deepEqual(ws.callsFrom('run'), ['py_fn@py/pkg/mod.py']);
    await assertMatchesFull('index and python module changed');
  });

  it('after an empty change batch', async () => {
    await seed();
    await ws.db.resolveWorkspaceRelationships([], []);
    await assertMatchesFull('empty batch');
  });

  it('after a batch too large to filter in SQL', async () => {
    await seed();
    const extra = Array.from({ length: 950 }, (_, i) => ws.path(`virtual/f${i}.ts`));
    await ws.db.resolveWorkspaceRelationships([ws.path('src/app.ts'), ...extra], ['helper']);
    await assertMatchesFull('large batch');
  });

  it('after editing a callee that is called through an alias', {
    todo: 'BUG: incremental resolve re-resolves only refs named after the changed symbols; a ref through an alias ("h" for helper) loses its edge when the callee file is re-parsed',
  }, async () => {
    await seed();
    ws.write('src/alias.ts', "import { helper as h } from './util';\nexport function viaAlias() { return h(); }\n");
    await ws.scanner.updateFile(ws.path('src/alias.ts'));
    assert.deepEqual(ws.callsFrom('viaAlias'), ['helper@src/util.ts']);

    ws.write('src/util.ts', '// touched\nexport function helper() { return 1; }\nexport function other() { return 2; }\n');
    await ws.scanner.updateFile(ws.path('src/util.ts'));
    assert.deepEqual(ws.callsFrom('viaAlias'), ['helper@src/util.ts']);
    await assertMatchesFull('aliased callee edited');
  });
});
