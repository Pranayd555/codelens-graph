import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { GraphDB } from '../../src/graph/graphDB';
import {
  GraphFixture, makeNode, fileNode, edge, callRef, rawQuery, openRawDb, writeLegacyDb,
  tempDir, removeDir, quietly,
} from './graphFixtures';

describe('GraphDB storage layout (schema v2)', () => {
  let fx: GraphFixture;
  afterEach(() => fx.close());

  it('derives the workspace root from a .codelens storage dir, and none otherwise', () => {
    fx = new GraphFixture();
    assert.equal(new GraphDB(fx.storage).getWorkspaceRoot(), fx.root);
    assert.equal(new GraphDB(path.join(fx.root, 'global-storage')).getWorkspaceRoot(), null);
  });

  it('stores integer keys and workspace-relative paths, and rebuilds absolute ids on read', async () => {
    fx = new GraphFixture();
    const db = await fx.open();
    const file = fx.path('src/a.ts');
    const fn = makeNode(file, 'alpha', 'function', 3);
    db.upsertNodes([fileNode(file), fn]);
    db.upsertEdges([edge(fileNode(file), fn)]);
    db.persist();

    const files = await rawQuery(fx.dbFile, 'SELECT path FROM files');
    assert.deepEqual(files, [[path.join('src', 'a.ts')]]);
    const keys = await rawQuery(fx.dbFile, 'SELECT key, typeof(nid), typeof(file_id) FROM nodes ORDER BY line');
    assert.deepEqual(keys, [['__file__::0', 'integer', 'integer'], ['alpha::3', 'integer', 'integer']]);
    const edgeCols = await rawQuery(fx.dbFile, 'SELECT typeof(from_nid), typeof(to_nid), origin FROM edges');
    assert.deepEqual(edgeCols, [['integer', 'integer', 0]]);
    assert.deepEqual(await rawQuery(fx.dbFile, `SELECT value FROM meta WHERE key = 'schema_version'`), [['2']]);

    const read = db.getNode(fn.id)!;
    assert.equal(read.id, `${file}::alpha::3`);
    assert.equal(read.filePath, file);
  });

  it('keeps absolute paths for files outside the workspace', async () => {
    fx = new GraphFixture();
    const outside = tempDir('codelens-outside-');
    try {
      const db = await fx.open();
      const file = path.join(outside, 'lib.ts');
      db.upsertNodes([makeNode(file, 'ext')]);
      db.persist();
      assert.deepEqual(await rawQuery(fx.dbFile, 'SELECT path FROM files'), [[file]]);
      assert.equal(db.getNodesByFile(file)[0].id, `${file}::ext::1`);
    } finally {
      removeDir(outside);
    }
  });

  it('stores absolute paths when the DB is not under .codelens', async () => {
    const dir = tempDir();
    try {
      const db = new GraphDB(path.join(dir, 'storage'));
      await db.init();
      const file = path.join(dir, 'x.ts');
      db.upsertNodes([makeNode(file, 'x')]);
      db.persist();
      db.close();
      const stored = await rawQuery(path.join(dir, 'storage', 'codelens-graph.db'), 'SELECT path FROM files');
      assert.deepEqual(stored, [[file]]);
      assert.equal(fs.existsSync(path.join(dir, 'storage', '.gitignore')), false);
    } finally {
      removeDir(dir);
    }
  });

  it('round-trips ids that do not start with their file path', {
    todo: 'BUG: RAW_ID_MARKER is "\\u0000" and sql.js truncates text at NUL, so such keys are stored as "" (ids read back as "<file>::" and collide)',
  }, async () => {
    fx = new GraphFixture();
    const db = await fx.open();
    const file = fx.path('a.ts');
    const odd1 = makeNode(file, 'odd1', 'variable', 2, { id: 'custom-id::odd1' });
    const odd2 = makeNode(file, 'odd2', 'variable', 3, { id: 'custom-id::odd2' });
    const fn = makeNode(file, 'fn');
    db.upsertNodes([odd1, odd2, fn]);
    db.upsertEdges([edge(fn, odd1, 'references')]);
    db.upsertCallRefs([
      { id: 'raw-ref-1', fromId: fn.id, filePath: file, symbolName: 'odd1', line: 1 },
      { id: 'raw-ref-2', fromId: fn.id, filePath: file, symbolName: 'odd2', line: 2 },
    ]);
    db.persist();
    db.close();

    const again = await fx.open();
    assert.equal(again.getNodesByFile(file).length, 3);
    assert.equal(again.getNode('custom-id::odd1')?.id, 'custom-id::odd1');
    assert.equal(again.getNode('custom-id::odd2')?.name, 'odd2');
    assert.deepEqual(again.getEdgesFrom(fn.id).map(e => e.toId), ['custom-id::odd1']);
    assert.equal((await rawQuery(fx.dbFile, 'SELECT COUNT(*) FROM call_refs'))[0][0], 2);
  });

  it('resolves node ids against a moved workspace', async () => {
    fx = new GraphFixture();
    const db = await fx.open();
    db.upsertNodes([makeNode(fx.path('m/a.ts'), 'moved')]);
    db.persist();
    db.close();

    const other = new GraphFixture();
    try {
      fs.mkdirSync(other.storage, { recursive: true });
      fs.copyFileSync(fx.dbFile, other.dbFile);
      const movedDb = await other.open();
      const [node] = movedDb.getNodesByType('function');
      assert.equal(node.filePath, other.path('m/a.ts'));
      assert.equal(node.id, `${other.path('m/a.ts')}::moved::1`);
    } finally {
      other.close();
    }
  });
});

describe('GraphDB lifecycle', () => {
  let fx: GraphFixture;
  afterEach(() => fx.close());

  it('reports initialization, shares one init promise and bumps the version', async () => {
    fx = new GraphFixture();
    const db = new GraphDB(fx.storage);
    assert.equal(db.isInitialized(), false);
    assert.equal(db.getVersion(), 0);
    await Promise.all([db.init(), db.init(), db.ensureInit()]);
    assert.equal(db.isInitialized(), true);
    assert.equal(db.getVersion(), 1);
    db.upsertNodes([makeNode(fx.path('a.ts'), 'a')]);
    db.persist();
    assert.equal(db.getVersion(), 2);
    db.close();
    assert.equal(db.isInitialized(), false);
    db.close(); // closing twice is harmless
  });

  it('ensureInit() initializes a DB that was never initialized', async () => {
    fx = new GraphFixture();
    const db = new GraphDB(fx.storage);
    await db.ensureInit();
    assert.equal(db.isInitialized(), true);
    db.close();
  });

  it('throws a clear error when used before init()', () => {
    fx = new GraphFixture();
    const db = new GraphDB(fx.storage);
    assert.throws(() => db.getNode('x'), /not initialized/);
    assert.throws(() => db.upsertNodes([]), /not initialized/);
  });

  it('does not write the DB file on init()', async () => {
    fx = new GraphFixture();
    await fx.open();
    assert.equal(fs.existsSync(fx.dbFile), false);
  });

  it('persist() writes the DB and a .codelens/.gitignore, without overwriting an existing one', async () => {
    fx = new GraphFixture();
    const db = await fx.open();
    db.persist();
    assert.ok(fs.existsSync(fx.dbFile));
    const ignore = path.join(fx.storage, '.gitignore');
    assert.equal(fs.readFileSync(ignore, 'utf-8'), '*\n');

    fs.writeFileSync(ignore, 'custom\n');
    db.persist();
    assert.equal(fs.readFileSync(ignore, 'utf-8'), 'custom\n');
  });

  it('round-trips nodes, edges, call refs and snapshots through persist() and init()', async () => {
    fx = new GraphFixture();
    const db = await fx.open();
    const file = fx.path('a.ts');
    const caller = makeNode(file, 'caller', 'function', 1, {
      signature: 'caller(x: number): string', returnType: 'string',
      params: [{ name: 'x', type: 'number' }], modifiers: ['export', 'async'],
      docComment: 'doc', undefinedRefs: ['missing'], localVars: ['y'], instantiates: ['Thing'],
      size: 10, lastModified: 12345, hash: 'abc', updatedAt: 99,
    });
    const callee = makeNode(file, 'callee', 'function', 5);
    db.upsertNodes([fileNode(file), caller, callee]);
    db.upsertEdges([edge(caller, callee, 'references', { why: 'test' })]);
    db.upsertCallRefs([callRef(caller, 'callee', 2)]);
    await db.resolveWorkspaceRelationships();
    db.saveSnapshot({ id: 's1', timestamp: 5, nodeCount: 3, edgeCount: 2, changedNodeIds: ['c'], addedNodeIds: [], removedNodeIds: [] });
    db.persist();
    db.close();

    const again = await fx.open();
    assert.deepEqual(again.getNode(caller.id), caller);
    assert.deepEqual(
      again.getEdgesFrom(caller.id).map(e => [e.toId, e.type, e.metadata]),
      [[callee.id, 'references', { why: 'test' }], [callee.id, 'calls', { symbolName: 'callee', resolution: 'same-file' }]]
    );
    assert.equal(again.getSnapshots()[0].id, 's1');
    assert.equal(again.needsRelationshipResolve(), false);
  });

  it('close() saves unsaved writes', async () => {
    fx = new GraphFixture();
    const db = await fx.open();
    db.upsertNodes([makeNode(fx.path('a.ts'), 'unsaved')]);
    db.close();
    const again = await fx.open();
    assert.equal(again.getNodesByType('function')[0]?.name, 'unsaved');
  });

  it('starts fresh from an unreadable DB file', async () => {
    fx = new GraphFixture();
    fs.mkdirSync(fx.storage, { recursive: true });
    fs.writeFileSync(fx.dbFile, 'this is not a sqlite database at all, just text that is long enough');
    const db = await quietly(() => fx.open());
    assert.deepEqual(db.getAllFiles('all'), []);
    db.upsertNodes([makeNode(fx.path('a.ts'), 'a')]);
    assert.equal(db.getStats('all').totalNodes, 1);
  });
});

describe('GraphDB upgrade from an older storage format', () => {
  let fx: GraphFixture;
  afterEach(() => fx.close());

  it('discards an old-schema file and reports wasRebuiltForUpgrade()', async () => {
    fx = new GraphFixture();
    await writeLegacyDb(fx.dbFile, fx.path('a.ts'));
    const db = await quietly(() => fx.open());
    assert.equal(db.wasRebuiltForUpgrade(), true);
    assert.equal(fs.existsSync(fx.dbFile), false, 'old file removed until the next persist');
    assert.equal(db.getStats('all').totalNodes, 0);
    assert.equal(db.needsRelationshipResolve(), false);

    db.persist();
    db.close();
    const again = await fx.open();
    assert.equal(again.wasRebuiltForUpgrade(), false);
  });

  it('accepts an existing file that has no graph tables yet', async () => {
    fx = new GraphFixture();
    const raw = await openRawDb();
    raw.run('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)');
    raw.run(`INSERT INTO meta VALUES ('custom', 'kept')`);
    fs.mkdirSync(fx.storage, { recursive: true });
    fs.writeFileSync(fx.dbFile, raw.export());
    raw.close();

    const db = await fx.open();
    assert.equal(db.wasRebuiltForUpgrade(), false);
    assert.equal(db.getMetaValue('custom'), 'kept');
    assert.equal(db.getMetaValue('schema_version'), '2');
  });
});

describe('GraphDB meta values and relationship freshness', () => {
  let fx: GraphFixture;
  afterEach(() => fx.close());

  it('gets and sets meta values', async () => {
    fx = new GraphFixture();
    const db = await fx.open();
    assert.equal(db.getMetaValue('parser_version'), null);
    db.setMetaValue('parser_version', '7');
    assert.equal(db.getMetaValue('parser_version'), '7');
    db.setMetaValue('parser_version', '8');
    assert.equal(db.getMetaValue('parser_version'), '8');
    db.persist();
    db.close();
    assert.equal((await fx.open()).getMetaValue('parser_version'), '8');
  });

  it('flags relationships stale after writes and clears the flag after a full resolve', async () => {
    fx = new GraphFixture();
    const db = await fx.open();
    assert.equal(db.needsRelationshipResolve(), false);
    db.upsertNodes([makeNode(fx.path('a.ts'), 'a')]);
    assert.equal(db.needsRelationshipResolve(), true);

    db.persist();
    assert.deepEqual(await rawQuery(fx.dbFile, `SELECT value FROM meta WHERE key = 'relationships_stale'`), [['1']]);
    db.close();

    // The flag survives a restart (e.g. a scan interrupted after an intermediate save).
    const again = await fx.open();
    assert.equal(again.needsRelationshipResolve(), true);
    // An incremental resolve does not satisfy a pending full resolve.
    await again.resolveWorkspaceRelationships([fx.path('a.ts')]);
    assert.equal(again.needsRelationshipResolve(), true);
    await again.resolveWorkspaceRelationships();
    assert.equal(again.needsRelationshipResolve(), false);
    again.persist();
    assert.deepEqual(await rawQuery(fx.dbFile, `SELECT value FROM meta WHERE key = 'relationships_stale'`), [['0']]);
  });

  it('an incremental resolve clears writes made since the last resolve', async () => {
    fx = new GraphFixture();
    const db = await fx.open();
    db.upsertNodes([makeNode(fx.path('a.ts'), 'a')]);
    await db.resolveWorkspaceRelationships();
    db.upsertNodes([makeNode(fx.path('b.ts'), 'b')]);
    assert.equal(db.needsRelationshipResolve(), true);
    await db.resolveWorkspaceRelationships(fx.path('b.ts'));
    assert.equal(db.needsRelationshipResolve(), false);
  });

  it('deleting a file without nodes, or upserting nothing, does not flag relationships stale', async () => {
    fx = new GraphFixture();
    const db = await fx.open();
    assert.equal(db.deleteNodesByFile(fx.path('never.ts')), false);
    db.upsertNodes([]);
    db.upsertEdges([]);
    db.upsertCallRefs([]);
    assert.equal(db.needsRelationshipResolve(), false);
  });

  it('resolves once when a DB from a version without the stale flag has data', async () => {
    fx = new GraphFixture();
    const db = await fx.open();
    db.upsertNodes([makeNode(fx.path('a.ts'), 'a')]);
    await db.resolveWorkspaceRelationships();
    db.persist();
    db.close();

    const raw = await openRawDb(fs.readFileSync(fx.dbFile));
    raw.run(`DELETE FROM meta WHERE key = 'relationships_stale'`);
    fs.writeFileSync(fx.dbFile, raw.export());
    raw.close();
    assert.equal((await fx.open()).needsRelationshipResolve(), true);
  });

  it('an empty DB without the stale flag needs no resolve', async () => {
    fx = new GraphFixture();
    const raw = await openRawDb();
    raw.run('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)');
    fs.mkdirSync(fx.storage, { recursive: true });
    fs.writeFileSync(fx.dbFile, raw.export());
    raw.close();
    assert.equal((await fx.open()).needsRelationshipResolve(), false);
  });

  it('closing during a resolve rolls back the open chunk and keeps relationships stale', async () => {
    fx = new GraphFixture();
    const db = await fx.open();
    const file = fx.path('a.ts');
    const caller = makeNode(file, 'caller');
    const callee = makeNode(file, 'callee', 'function', 5);
    db.upsertNodes([fileNode(file), caller, callee]);
    db.upsertCallRefs([callRef(caller, 'callee', 2)]);

    const pending = db.resolveWorkspaceRelationships();
    db.close();
    await assert.rejects(pending);

    const again = await fx.open();
    assert.equal(again.needsRelationshipResolve(), true);
    assert.equal(again.getNodesByFile(file).length, 3, 'writes made before the resolve were saved');
    assert.deepEqual(again.getEdgesFrom(caller.id, 'calls'), []);
  });
});

describe('GraphDB reading a file another process writes', () => {
  let fx: GraphFixture;
  afterEach(() => fx.close());

  async function writerAndReader() {
    const writer = await fx.open({ followExternalWrites: false });
    writer.upsertNodes([makeNode(fx.path('a.ts'), 'first')]);
    writer.persist();
    fx.bumpDbMtime();
    const reader = await fx.open({ followExternalWrites: true });
    return { writer, reader };
  }

  it('a reader follows the writer\'s saves', async () => {
    fx = new GraphFixture();
    const { writer, reader } = await writerAndReader();
    assert.deepEqual(reader.searchNodes('first').map(n => n.name), ['first']);
    assert.equal(reader.refreshFromDiskIfChanged(), false, 'nothing changed since init');

    writer.upsertNodes([makeNode(fx.path('b.ts'), 'second')]);
    writer.persist();
    fx.bumpDbMtime();
    const before = reader.getVersion();
    assert.deepEqual(reader.searchNodes('second').map(n => n.name), ['second']);
    assert.ok(reader.getVersion() > before);
    assert.equal(reader.refreshFromDiskIfChanged(), false);
  });

  it('a reader reloads before writing and does not reload while it has unsaved writes', async () => {
    fx = new GraphFixture();
    const { writer, reader } = await writerAndReader();
    writer.upsertNodes([makeNode(fx.path('b.ts'), 'second')]);
    writer.persist();
    fx.bumpDbMtime();

    reader.upsertNodes([makeNode(fx.path('c.ts'), 'third')]); // reloads first, then writes
    assert.deepEqual(reader.getNodesByType('function').map(n => n.name), ['first', 'second', 'third']);

    writer.upsertNodes([makeNode(fx.path('d.ts'), 'fourth')]);
    writer.persist();
    fx.bumpDbMtime();
    assert.equal(reader.refreshFromDiskIfChanged(), false, 'dirty reader keeps its own state');
    assert.deepEqual(reader.searchNodes('fourth'), []);
  });

  it('an owner ignores files written by other processes', async () => {
    fx = new GraphFixture();
    const owner = await fx.open({ followExternalWrites: false });
    owner.upsertNodes([makeNode(fx.path('a.ts'), 'mine')]);
    owner.persist();

    const other = await fx.open({ followExternalWrites: false });
    other.upsertNodes([makeNode(fx.path('b.ts'), 'theirs')]);
    other.persist();
    fx.bumpDbMtime();

    assert.equal(owner.refreshFromDiskIfChanged(), false);
    assert.deepEqual(owner.searchNodes('theirs'), []);
    owner.persist();
    other.close();
    const reopened = await fx.open();
    assert.deepEqual(reopened.getNodesByType('function').map(n => n.name), ['mine']);
  });

  it('a reader rejects a file rewritten in an older format', async () => {
    fx = new GraphFixture();
    const { reader } = await writerAndReader();
    await writeLegacyDb(fx.dbFile, fx.path('a.ts'));
    fx.bumpDbMtime();
    const before = reader.getVersion();
    assert.equal(await quietly(() => reader.refreshFromDiskIfChanged()), false);
    assert.equal(reader.getVersion(), before);
    assert.deepEqual(reader.searchNodes('first').map(n => n.name), ['first']);
    // The rejected version is remembered rather than re-read on every call.
    assert.equal(reader.refreshFromDiskIfChanged(), false);
  });

  it('a reader keeps its graph when the file disappears or becomes unreadable', async () => {
    fx = new GraphFixture();
    const { reader } = await writerAndReader();
    fs.writeFileSync(fx.dbFile, Buffer.alloc(4096, 7));
    fx.bumpDbMtime();
    assert.equal(await quietly(() => reader.refreshFromDiskIfChanged()), false);
    assert.deepEqual(reader.searchNodes('first').map(n => n.name), ['first']);

    fs.unlinkSync(fx.dbFile);
    assert.equal(reader.refreshFromDiskIfChanged(), false);
    assert.deepEqual(reader.searchNodes('first').map(n => n.name), ['first']);
  });
});
