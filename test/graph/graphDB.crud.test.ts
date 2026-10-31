import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { GraphDB } from '../../src/graph/graphDB';
import { GraphNode } from '../../src/types';
import { GraphFixture, makeNode, fileNode, edge, callRef, rawQuery } from './graphFixtures';

describe('GraphDB nodes', () => {
  let fx: GraphFixture;
  let db: GraphDB;
  beforeEach(async () => { fx = new GraphFixture(); db = await fx.open(); });
  afterEach(() => fx.close());

  it('upserts by id: a second write updates the node in place', () => {
    const file = fx.path('a.ts');
    const v1 = makeNode(file, 'fn', 'function', 1, { signature: 'fn()', modifiers: ['export'] });
    db.upsertNode(v1);
    const v2 = { ...v1, signature: 'fn(x)', modifiers: undefined, endLine: 9, hash: 'h2' };
    db.upsertNode(v2);
    const [stored, ...rest] = db.getNodesByFile(file);
    assert.equal(rest.length, 0);
    assert.equal(stored.id, v1.id);
    assert.equal(stored.signature, 'fn(x)');
    assert.equal(stored.endLine, 9);
    assert.equal(stored.hash, 'h2');
    assert.equal(stored.modifiers, undefined);
  });

  it('getNode returns null for unknown ids and ids of unknown files', () => {
    db.upsertNode(makeNode(fx.path('a.ts'), 'fn'));
    assert.equal(db.getNode(`${fx.path('a.ts')}::nope::1`), null);
    assert.equal(db.getNode(`${fx.path('missing.ts')}::fn::1`), null);
    assert.equal(db.getNode('not-an-id'), null);
  });

  it('getNodesByFile orders by line; getNodesByType orders by name', () => {
    const a = fx.path('a.ts');
    const b = fx.path('b.ts');
    db.upsertNodes([makeNode(a, 'zeta', 'function', 9), makeNode(a, 'alpha', 'function', 4), makeNode(b, 'mid', 'function', 1), makeNode(a, 'K', 'class', 2)]);
    assert.deepEqual(db.getNodesByFile(a).map(n => n.name), ['K', 'alpha', 'zeta']);
    assert.deepEqual(db.getNodesByType('function').map(n => n.name), ['alpha', 'mid', 'zeta']);
    assert.deepEqual(db.getNodesByType('enum'), []);
    assert.deepEqual(db.getNodesByFile(fx.path('none.ts')), []);
  });

  it('getAllFiles lists files that have a file node, filtered by scope', () => {
    const files = ['src/a.ts', 'node_modules/pkg/index.js', 'package.json', 'vite.config.ts', 'README.md', 'src/b.ts'];
    for (const rel of files) { db.upsertNode(fileNode(fx.path(rel))); }
    db.upsertNode(makeNode(fx.path('src/nofile.ts'), 'orphan')); // no file node

    assert.deepEqual(db.getAllFiles(), [fx.path('src/a.ts'), fx.path('src/b.ts')]);
    assert.deepEqual(db.getAllFiles('workspace'), db.getAllFiles());
    assert.deepEqual(new Set(db.getAllFiles('deps')), new Set([
      fx.path('node_modules/pkg/index.js'), fx.path('package.json'), fx.path('vite.config.ts'), fx.path('README.md'),
    ]));
    assert.equal(db.getAllFiles('all').length, files.length);
  });

  it('deleteNodesByFile removes the file\'s nodes, edges in both directions, call refs and text lines', async () => {
    const a = fx.path('a.ts');
    const b = fx.path('b.ts');
    const fa = makeNode(a, 'fa');
    const fb = makeNode(b, 'fb');
    const gb = makeNode(b, 'gb', 'function', 5);
    db.upsertNodes([fileNode(a), fa, fileNode(b), fb, gb]);
    db.upsertEdges([edge(fa, fb, 'references'), edge(fb, fa, 'references'), edge(fb, gb, 'references')]);
    db.upsertCallRefs([callRef(fa, 'fb', 1), callRef(fb, 'fa', 1)]);
    db.addFileLines([{ filePath: b, line: 1, rawText: 'function fb() {}', tokenType: 'symbol' }]);

    assert.equal(db.deleteNodesByFile(b), true);
    assert.deepEqual(db.getNodesByFile(b), []);
    assert.deepEqual(db.getEdgesFrom(fa.id), []);
    assert.deepEqual(db.getEdgesTo(fa.id), []);
    assert.deepEqual(db.searchFileLines('function fb'), []);
    db.persist();
    assert.deepEqual(await rawQuery(fx.dbFile, 'SELECT symbol_name FROM call_refs'), [['fb']]);
    assert.deepEqual(await rawQuery(fx.dbFile, 'SELECT path FROM files'), [['a.ts']], 'unused path row dropped');

    assert.equal(db.deleteNodesByFile(b), false, 'nothing left to delete');
  });

  it('a file deleted and re-added gets its nodes back under the same ids', () => {
    const a = fx.path('a.ts');
    db.upsertNodes([fileNode(a), makeNode(a, 'fn')]);
    db.deleteNodesByFile(a);
    db.upsertNodes([fileNode(a), makeNode(a, 'fn')]);
    assert.equal(db.getNode(`${a}::fn::1`)?.name, 'fn');
    assert.deepEqual(db.getAllFiles(), [a]);
  });

  it('upsertNodes rolls back the whole batch when one node is invalid', () => {
    const a = fx.path('a.ts');
    db.upsertNodes([makeNode(a, 'existing', 'function', 50)]);
    const bad = { ...makeNode(a, 'bad'), name: null } as unknown as GraphNode;
    assert.throws(() => db.upsertNodes([makeNode(a, 'good'), bad]));
    assert.deepEqual(db.getNodesByFile(a).map(n => n.name), ['existing']);
    db.upsertNodes([makeNode(a, 'good')]);
    assert.deepEqual(db.getNodesByFile(a).map(n => n.name), ['good', 'existing']);
  });

  it('a file whose first write was rolled back can be written again', {
    todo: 'BUG: the rollback in upsertNodes leaves the new files row id in the fileIds cache, so later nodes point at a missing files row and are invisible',
  }, () => {
    const a = fx.path('fresh.ts');
    const bad = { ...makeNode(a, 'bad'), name: null } as unknown as GraphNode;
    assert.throws(() => db.upsertNodes([makeNode(a, 'good'), bad]));
    db.upsertNodes([fileNode(a), makeNode(a, 'good')]);
    assert.deepEqual(db.getNodesByFile(a).map(n => n.name), ['fresh.ts', 'good']);
    assert.deepEqual(db.getAllFiles(), [a]);
  });
});

describe('GraphDB edges and call refs', () => {
  let fx: GraphFixture;
  let db: GraphDB;
  beforeEach(async () => { fx = new GraphFixture(); db = await fx.open(); });
  afterEach(() => fx.close());

  it('stores edges with metadata and filters by type in both directions', () => {
    const a = fx.path('a.ts');
    const cls = makeNode(a, 'C', 'class', 1);
    const m = makeNode(a, 'm', 'method', 2);
    const base = makeNode(fx.path('b.ts'), 'Base', 'class', 1);
    db.upsertNodes([cls, m, base]);
    db.upsertEdges([edge(cls, m, 'contains'), edge(cls, base, 'inherits', { via: 'extends' })]);

    assert.deepEqual(db.getEdgesFrom(cls.id).map(e => [e.toId, e.type]), [[m.id, 'contains'], [base.id, 'inherits']]);
    assert.deepEqual(db.getEdgesFrom(cls.id, 'inherits').map(e => e.metadata), [{ via: 'extends' }]);
    assert.deepEqual(db.getEdgesFrom(cls.id, 'calls'), []);
    assert.deepEqual(db.getEdgesTo(base.id).map(e => e.fromId), [cls.id]);
    assert.deepEqual(db.getEdgesTo(base.id, 'contains'), []);
    assert.deepEqual(db.getEdgesTo(m.id, 'contains').map(e => e.fromId), [cls.id]);
    assert.deepEqual(db.getEdgesFrom('unknown'), []);
    assert.deepEqual(db.getEdgesTo('unknown'), []);
  });

  it('re-upserting an edge replaces it rather than duplicating it', () => {
    const a = makeNode(fx.path('a.ts'), 'a');
    const b = makeNode(fx.path('a.ts'), 'b', 'function', 4);
    db.upsertNodes([a, b]);
    db.upsertEdge(edge(a, b, 'references', { n: '1' }));
    db.upsertEdge(edge(a, b, 'references', { n: '2' }));
    const edges = db.getEdgesFrom(a.id);
    assert.equal(edges.length, 1);
    assert.deepEqual(edges[0].metadata, { n: '2' });
    assert.equal(edges[0].id, db.getEdgesTo(b.id)[0].id, 'edge ids are stable');
  });

  it('skips edges whose endpoints are not stored', () => {
    const a = makeNode(fx.path('a.ts'), 'a');
    db.upsertNode(a);
    db.upsertEdges([edge(a, makeNode(fx.path('a.ts'), 'ghost')), edge(makeNode(fx.path('z.ts'), 'ghost'), a)]);
    assert.deepEqual(db.getEdgesFrom(a.id), []);
    assert.deepEqual(db.getEdgesTo(a.id), []);
  });

  it('skips call refs whose caller is not stored, and keeps a ref\'s identity on re-upsert', async () => {
    const a = fx.path('a.ts');
    const caller = makeNode(a, 'caller');
    const target1 = makeNode(a, 't1', 'function', 5);
    const target2 = makeNode(a, 't2', 'function', 9);
    db.upsertNodes([fileNode(a), caller, target1, target2]);
    db.upsertCallRefs([callRef(makeNode(a, 'ghost'), 't1', 1)]);
    db.persist();
    assert.deepEqual(await rawQuery(fx.dbFile, 'SELECT COUNT(*) FROM call_refs'), [[0]]);

    const ref = callRef(caller, 't1', 2);
    db.upsertCallRefs([ref]);
    await db.resolveWorkspaceRelationships();
    assert.deepEqual(db.getEdgesFrom(caller.id, 'calls').map(e => e.toId), [target1.id]);

    // Same call site now names another symbol: the ref is updated, not duplicated.
    db.upsertCallRefs([{ ...ref, symbolName: 't2' }]);
    await db.resolveWorkspaceRelationships(a);
    assert.deepEqual(db.getEdgesFrom(caller.id, 'calls').map(e => e.toId), [target2.id]);
    db.persist();
    assert.deepEqual(await rawQuery(fx.dbFile, 'SELECT COUNT(*) FROM call_refs'), [[1]]);
  });
});

describe('GraphDB traversal and snapshots', () => {
  let fx: GraphFixture;
  let db: GraphDB;
  before(async () => { fx = new GraphFixture(); db = await fx.open(); });
  after(() => fx.close());

  it('bfsExpand walks edges in both directions up to the given depth', () => {
    const f = fx.path('a.ts');
    const [a, b, c, d] = ['a', 'b', 'c', 'd'].map((n, i) => makeNode(f, n, 'function', i + 1));
    db.upsertNodes([a, b, c, d]);
    db.upsertEdges([edge(a, b, 'calls'), edge(c, b, 'calls'), edge(c, d, 'calls')]);

    const names = (r: { nodes: GraphNode[] }) => r.nodes.map(n => n.name).sort();
    assert.deepEqual(names(db.bfsExpand([a.id], 0)), ['a']);
    assert.deepEqual(names(db.bfsExpand([a.id], 1)), ['a', 'b']);
    assert.deepEqual(names(db.bfsExpand([a.id], 2)), ['a', 'b', 'c']);
    const all = db.bfsExpand([a.id], 10);
    assert.deepEqual(names(all), ['a', 'b', 'c', 'd']);
    assert.equal(all.edges.length, 3);
    assert.deepEqual(db.bfsExpand(['missing'], 2), { nodes: [], edges: [] });
  });

  it('saves snapshots and lists them newest first, limited', () => {
    for (const [id, ts] of [['s1', 10], ['s2', 30], ['s3', 20]] as const) {
      db.saveSnapshot({ id, timestamp: ts, agentRunId: 'run-' + id, nodeCount: 1, edgeCount: 2, changedNodeIds: ['c'], addedNodeIds: ['a'], removedNodeIds: [] });
    }
    assert.deepEqual(db.getSnapshots().map(s => s.id), ['s2', 's3', 's1']);
    assert.deepEqual(db.getSnapshots(1), [{
      id: 's2', timestamp: 30, agentRunId: 'run-s2', nodeCount: 1, edgeCount: 2,
      changedNodeIds: ['c'], addedNodeIds: ['a'], removedNodeIds: [],
    }]);
  });
});

describe('GraphDB stats', () => {
  let fx: GraphFixture;
  let db: GraphDB;
  beforeEach(async () => { fx = new GraphFixture(); db = await fx.open(); });
  afterEach(() => fx.close());

  function seed() {
    const a = fx.path('src/a.ts');
    const dep = fx.path('node_modules/dep/index.js');
    const cfg = fx.path('package.json');
    const fa = makeNode(a, 'fa');
    const ca = makeNode(a, 'Ca', 'class', 3);
    const fdep = makeNode(dep, 'fdep');
    db.upsertNodes([fileNode(a), fa, ca, fileNode(dep), fdep, fileNode(cfg)]);
    db.upsertEdges([edge(fileNode(a), fa), edge(fa, ca, 'references'), edge(fa, fdep, 'calls')]);
    return { a, fa };
  }

  it('workspace stats count only workspace files and edges between them', () => {
    seed();
    assert.deepEqual(db.getStats(), { totalNodes: 3, totalEdges: 2, fileCount: 1, byType: { file: 1, function: 1, class: 1 } });
    assert.deepEqual(db.getStats('all'), { totalNodes: 6, totalEdges: 3, fileCount: 3, byType: { file: 3, function: 2, class: 1 } });
  });

  it('stats on an empty graph are zero', () => {
    assert.deepEqual(db.getStats('all'), { totalNodes: 0, totalEdges: 0, fileCount: 0, byType: {} });
    assert.deepEqual(db.getStats(), { totalNodes: 0, totalEdges: 0, fileCount: 0, byType: {} });
  });

  it('cached stats are refreshed after every kind of write and are not shared by reference', async () => {
    const { a, fa } = seed();
    const first = db.getStats();
    first.byType.function = 999;
    assert.equal(db.getStats().byType.function, 1, 'mutating a result does not touch the cache');

    db.upsertNode(makeNode(a, 'extra', 'function', 20));
    assert.equal(db.getStats().totalNodes, 4);

    db.upsertCallRefs([callRef(fa, 'extra', 2)]);
    await db.resolveWorkspaceRelationships();
    assert.equal(db.getStats().totalEdges, 3, 'resolved call edge counted');

    db.deleteNodesByFile(a);
    assert.deepEqual(db.getStats(), { totalNodes: 0, totalEdges: 0, fileCount: 0, byType: {} });
  });

  it('stats are recomputed after a reload from disk', async () => {
    const writer = db;
    seed();
    writer.persist();
    fx.bumpDbMtime();
    const reader = await fx.open({ followExternalWrites: true });
    assert.equal(reader.getStats('all').totalNodes, 6);
    writer.upsertNode(makeNode(fx.path('src/b.ts'), 'fb'));
    writer.persist();
    fx.bumpDbMtime();
    assert.equal(reader.getStats('all').totalNodes, 7);
  });

  it('counts nodes with undefined refs, ignoring names defined anywhere and deps/config files', () => {
    const a = fx.path('src/a.ts');
    const b = fx.path('src/b.ts');
    db.upsertNodes([
      makeNode(a, 'usesMissing', 'function', 1, { undefinedRefs: ['missingThing'] }),
      makeNode(a, 'usesDefined', 'function', 5, { undefinedRefs: ['helper'] }),
      makeNode(a, 'usesNothing', 'function', 9, { undefinedRefs: [] }),
      makeNode(fx.path('node_modules/x/i.js'), 'depFn', 'function', 1, { undefinedRefs: ['nope'] }),
      makeNode(fx.path('eslint.config.js'), 'cfgFn', 'function', 1, { undefinedRefs: ['nope'] }),
      makeNode(b, 'helper'),
      makeNode(b, 'importedOnly', 'import', 1),
      makeNode(b, 'usesImportOnly', 'function', 4, { undefinedRefs: ['importedOnly', 'helper'] }),
    ]);
    assert.equal(db.countNodesWithUndefinedRefs(), 2);
    assert.deepEqual(db.getNodesWithUndefinedRefs().map(n => [n.name, n.undefinedRefs]), [
      ['usesMissing', ['missingThing']], ['usesImportOnly', ['importedOnly']],
    ]);
    assert.equal(db.getNodesWithUndefinedRefs('all').length, 4);
    assert.equal(db.countNodesWithUndefinedRefs(), db.getNodesWithUndefinedRefs('workspace').length);

    // Cached until the next write; defining the missing name clears it.
    db.upsertNode(makeNode(b, 'missingThing', 'variable', 9));
    assert.equal(db.countNodesWithUndefinedRefs(), 1);
  });
});
