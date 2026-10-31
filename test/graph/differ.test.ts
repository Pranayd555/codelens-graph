import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { GraphDB } from '../../src/graph/graphDB';
import { GraphDiffer } from '../../src/graph/differ';
import { GraphFixture, makeNode, fileNode, edge, quietly } from './graphFixtures';

describe('GraphDiffer', () => {
  let fx: GraphFixture;
  let db: GraphDB;
  let differ: GraphDiffer;
  beforeEach(async () => { fx = new GraphFixture(); db = await fx.open(); differ = new GraphDiffer(db); });
  afterEach(() => fx.close());

  it('reports added, changed and removed nodes since the baseline and saves the snapshot', async () => {
    const a = fx.path('src/a.ts');
    const keep = makeNode(a, 'keep', 'function', 1, { hash: 'k1' });
    const change = makeNode(a, 'change', 'function', 5, { hash: 'c1' });
    const remove = makeNode(a, 'remove', 'function', 9, { hash: 'r1' });
    db.upsertNodes([fileNode(a, { hash: 'f1' }), keep, change, remove]);
    await quietly(() => differ.captureBaseline('run-1'));

    db.deleteNodesByFile(a);
    const added = makeNode(a, 'added', 'function', 20, { hash: 'a1' });
    db.upsertNodes([fileNode(a, { hash: 'f1' }), keep, { ...change, hash: 'c2' }, added]);
    db.upsertEdges([edge(keep, added, 'calls')]);

    const before = Date.now();
    const snap = differ.computeDiff('run-1');
    assert.deepEqual(snap.addedNodeIds, [added.id]);
    assert.deepEqual(snap.changedNodeIds, [change.id]);
    assert.deepEqual(snap.removedNodeIds, [remove.id]);
    assert.equal(snap.agentRunId, 'run-1');
    assert.equal(snap.nodeCount, 4);
    assert.equal(snap.edgeCount, 1);
    assert.match(snap.id, /^[0-9a-f]{32}$/);
    assert.ok(snap.timestamp >= before);
    assert.deepEqual(db.getSnapshots(), [snap]);
  });

  it('hashes nodes without a stored hash from name, signature and line', async () => {
    const a = fx.path('a.ts');
    const plain = makeNode(a, 'plain', 'function', 1, { signature: 'plain()' });
    const moved = makeNode(a, 'moved', 'function', 3);
    const resigned = makeNode(a, 'resigned', 'function', 7, { signature: 'resigned()' });
    db.upsertNodes([fileNode(a), plain, moved, resigned]);
    await quietly(() => differ.captureBaseline('r'));

    // plain: same name/signature/line → unchanged even though other fields differ.
    // moved: a node at a new line has a new id → removed + added.
    db.deleteNodesByFile(a);
    db.upsertNodes([
      fileNode(a), { ...plain, endLine: 99, docComment: 'new docs' },
      makeNode(a, 'moved', 'function', 4), { ...resigned, signature: 'resigned(x)' },
    ]);

    const snap = differ.computeDiff('r');
    assert.deepEqual(snap.changedNodeIds, [resigned.id]);
    assert.deepEqual(snap.removedNodeIds, [moved.id]);
    assert.deepEqual(snap.addedNodeIds, [`${a}::moved::4`]);
  });

  it('only diffs workspace files', async () => {
    await quietly(() => differ.captureBaseline('ws'));
    db.upsertNodes([fileNode(fx.path('node_modules/x/index.js')), makeNode(fx.path('node_modules/x/index.js'), 'dep')]);
    db.upsertNodes([fileNode(fx.path('package.json'))]);
    const snap = differ.computeDiff('ws');
    assert.deepEqual(snap.addedNodeIds, []);
    assert.equal(snap.nodeCount, 0);
  });

  it('treats an unknown run as an empty baseline and forgets a baseline once diffed', async () => {
    const a = fx.path('a.ts');
    db.upsertNodes([fileNode(a), makeNode(a, 'x')]);
    assert.equal(differ.computeDiff('never-captured').addedNodeIds.length, 2);

    await quietly(() => differ.captureBaseline('once'));
    assert.deepEqual(differ.computeDiff('once').addedNodeIds, []);
    assert.equal(differ.computeDiff('once').addedNodeIds.length, 2, 'baseline was consumed');
  });

  it('formats a readable summary', () => {
    const summary = differ.formatDiffSummary({
      id: 's', timestamp: Date.UTC(2026, 0, 1, 12, 0, 0), agentRunId: 'r',
      nodeCount: 10, edgeCount: 4, addedNodeIds: ['a', 'b'], changedNodeIds: ['c'], removedNodeIds: [],
    });
    const lines = summary.split('\n');
    assert.match(lines[0], /^Agent run diff \(.+\)$/);
    assert.deepEqual(lines.slice(1), [
      '  Added:   2 symbols',
      '  Changed: 1 symbols',
      '  Removed: 0 symbols',
      '  Total graph: 10 nodes, 4 edges',
    ]);
  });
});
