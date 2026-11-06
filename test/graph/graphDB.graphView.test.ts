import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { GraphDB } from '../../src/graph/graphDB';
import { GraphNode } from '../../src/types';
import { GraphFixture, makeNode, fileNode, importNode, edge, callRef } from './graphFixtures';

// GraphDB.getGraphView: what the graph panel draws.
describe('GraphDB.getGraphView', () => {
  let fx: GraphFixture;
  let db: GraphDB;
  beforeEach(async () => { fx = new GraphFixture(); db = await fx.open(); });
  afterEach(() => fx.close());

  const names = (nodes: GraphNode[]) => nodes.map(n => n.name).sort();

  // a.ts: hub is called by four functions; lone has no edges. A config file,
  // a node_modules file and an import node are also indexed.
  function seed() {
    const a = fx.path('src/a.ts');
    const fa = fileNode(a);
    const hub = makeNode(a, 'hub', 'function', 1);
    const callers = [2, 3, 4, 5].map(i => makeNode(a, 'caller' + i, 'function', i * 10));
    const lone = makeNode(a, 'lone', 'function', 90, { undefinedRefs: ['missing'] });
    const Shape = makeNode(a, 'Shape', 'class', 100);
    const imp = importNode(a, 'fs', "import * as fs from 'fs'");
    const cfgFile = fx.path('vite.config.ts');
    const fc = fileNode(cfgFile);
    const cfg = makeNode(cfgFile, 'config', 'variable', 1);
    const dep = fx.path('node_modules/lib/index.js');
    const fd = fileNode(dep);
    const libFn = makeNode(dep, 'libFn', 'function', 1);
    db.upsertNodes([fa, hub, ...callers, lone, Shape, imp, fc, cfg, fd, libFn]);
    db.upsertEdges([
      ...callers.map(c => edge(c, hub, 'calls')),
      edge(fa, hub, 'contains'), edge(fa, lone, 'contains'),
      edge(hub, libFn, 'calls'),
    ]);
    return { hub, callers, lone, Shape, fa };
  }

  it('returns every symbol outside node_modules, without import nodes, when the graph fits', () => {
    const { hub, callers, fa, lone } = seed();
    const view = db.getGraphView(100);
    assert.equal(view.complete, true);
    assert.deepEqual(names(view.nodes), ['Shape', 'a.ts', 'caller2', 'caller3', 'caller4', 'caller5', 'config', 'hub', 'lone', 'vite.config.ts']);
    assert.equal(view.total, 10);
    // Edges between included symbols only (hub -> libFn is dropped), with ids and metadata like getEdgesFrom.
    const got = view.edges.map(e => `${e.fromId} ${e.type} ${e.toId}`).sort();
    const want = [...callers.map(c => `${c.id} calls ${hub.id}`), `${fa.id} contains ${hub.id}`, `${fa.id} contains ${lone.id}`].sort();
    assert.deepEqual(got, want);
    const viaQuery = db.getEdgesFrom(callers[0].id)[0];
    assert.deepEqual(view.edges.find(e => e.fromId === callers[0].id), viaQuery);
    // Full nodes, as the rest of the extension reads them.
    assert.deepEqual(view.nodes.find(n => n.name === 'lone'), db.getNode(lone.id));
  });

  it('keeps only the most connected symbols when the graph is larger than the limit', () => {
    const { hub } = seed();
    const view = db.getGraphView(3);
    assert.equal(view.complete, false);
    assert.equal(view.total, 8, 'symbols matching the "all" filter: not configs, imports or node_modules');
    assert.equal(view.nodes.length, 3);
    // hub has 4 calls; each caller has 1; "contains" edges don't count.
    assert.ok(view.nodes.some(n => n.id === hub.id));
    assert.deepEqual(names(view.nodes), ['caller2', 'caller3', 'hub'], 'ties broken by name');
    assert.ok(view.edges.every(e => view.nodes.some(n => n.id === e.fromId) && view.nodes.some(n => n.id === e.toId)));
    assert.equal(view.edges.length, 2);
  });

  it('ranks by members when there are no calls yet (before linking), keeping each hub with its neighbours', () => {
    const big = fx.path('src/big.ts');
    const small = fx.path('src/small.ts');
    const fb = fileNode(big);
    const fs = fileNode(small);
    const K = makeNode(big, 'K', 'class', 1);
    const kids = [2, 3, 4].map(i => makeNode(big, 'm' + i, 'method', i));
    const s1 = makeNode(small, 's1', 'function', 1);
    db.upsertNodes([fb, fs, K, ...kids, s1]);
    db.upsertEdges([edge(fb, K), ...kids.map(k => edge(K, k)), edge(fb, kids[0]), edge(fs, s1)]);
    // members: K 3, big.ts 2, small.ts 1, the rest 0. K comes first, with its
    // best-ranked neighbours (big.ts, then m2) rather than the unrelated small.ts.
    const view = db.getGraphView(3);
    assert.deepEqual(names(view.nodes), ['K', 'big.ts', 'm2']);
    assert.equal(view.edges.length, 3, 'big.ts contains K and m2; K contains m2');
  });

  it('brings a hub\'s neighbours along, up to 20 each', () => {
    const file = fx.path('src/x.ts');
    const fx1 = fileNode(file);
    const hubA = makeNode(file, 'hubA', 'function', 1);
    const hubB = makeNode(file, 'hubB', 'function', 2);
    const fansA = Array.from({ length: 25 }, (_, i) => makeNode(file, `a${String(i).padStart(2, '0')}`, 'function', 10 + i));
    const fansB = Array.from({ length: 3 }, (_, i) => makeNode(file, `b${i}`, 'function', 50 + i));
    db.upsertNodes([fx1, hubA, hubB, ...fansA, ...fansB]);
    db.upsertEdges([...fansA.map(f => edge(f, hubA, 'calls')), ...fansB.map(f => edge(f, hubB, 'calls'))]);
    const view = db.getGraphView(25);
    const got = new Set(view.nodes.map(n => n.name));
    assert.ok(got.has('hubA') && got.has('hubB'), 'both hubs');
    assert.equal(fansA.filter(f => got.has(f.name)).length, 20, 'hubA brings 20 of its 25 callers');
    assert.equal(fansB.filter(f => got.has(f.name)).length, 3, 'hubB brings all of its callers');
    assert.equal(view.edges.length, 23);
  });

  it('applies the panel filter and search when the graph is larger than the limit', () => {
    seed();
    assert.deepEqual(names(db.getGraphView(3, 'class').nodes), ['Shape']);
    assert.deepEqual(names(db.getGraphView(3, 'configs').nodes), ['config', 'vite.config.ts']);
    assert.deepEqual(names(db.getGraphView(3, 'issues').nodes), ['lone']);
    const search = db.getGraphView(3, 'all', ' CALLER ');
    assert.equal(search.total, 4);
    assert.deepEqual(names(search.nodes), ['caller2', 'caller3', 'caller4']);
    assert.deepEqual(db.getGraphView(3, 'function', 'nothing').nodes, []);
  });

  it('ignores the filter when the graph fits, since the panel filters itself', () => {
    seed();
    const view = db.getGraphView(100, 'class', 'x');
    assert.equal(view.complete, true);
    assert.equal(view.nodes.length, 10);
  });

  it('draws one edge per pair and type, though each call site is its own edge', async () => {
    const a = fx.write('src/a.ts', '// fixture\n');
    const main = makeNode(a, 'main', 'function', 1);
    const helper = makeNode(a, 'helper', 'function', 20);
    db.upsertNodes([fileNode(a), main, helper]);
    db.upsertCallRefs([callRef(main, 'helper', 2), callRef(main, 'helper', 3), callRef(main, 'helper', 4)]);
    await db.resolveWorkspaceRelationships();
    assert.equal(db.getEdgesFrom(main.id, 'calls').length, 3, 'three call sites');
    assert.deepEqual(db.getGraphView(10).edges.map(e => `${e.fromId} ${e.type} ${e.toId}`), [`${main.id} calls ${helper.id}`]);
  });

  it('handles an empty graph', () => {
    assert.deepEqual(db.getGraphView(10), { nodes: [], edges: [], total: 0, complete: true });
    assert.deepEqual(db.getGraphView(0, 'all', 'x'), { nodes: [], edges: [], total: 0, complete: true });
  });

  it('builds a large graph quickly', () => {
    const nodes: GraphNode[] = [];
    for (let f = 0; f < 200; f++) {
      const file = fx.path(`src/f${f}.ts`);
      nodes.push(fileNode(file));
      for (let i = 1; i <= 100; i++) { nodes.push(makeNode(file, `fn${f}_${i}`, 'function', i)); }
    }
    db.upsertNodes(nodes);
    const fns = nodes.filter(n => n.type === 'function');
    db.upsertEdges(fns.map((n, i) => edge(n, fns[(i * 7 + 1) % fns.length], 'calls')));
    const start = Date.now();
    const view = db.getGraphView(1500);
    const ms = Date.now() - start;
    assert.equal(view.total, 20_200);
    assert.equal(view.nodes.length, 1500);
    assert.ok(ms < 5000, `took ${ms}ms`);
  });
});
