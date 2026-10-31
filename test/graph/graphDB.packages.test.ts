import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { GraphDB } from '../../src/graph/graphDB';
import { PackageInfo } from '../../src/ingestion/dependencyManifest';
import { GraphFixture, makeNode, fileNode, importNode, rawQuery } from './graphFixtures';

describe('GraphDB dependency manifest', () => {
  let fx: GraphFixture;
  let db: GraphDB;
  beforeEach(async () => { fx = new GraphFixture(); db = await fx.open(); });
  afterEach(() => fx.close());

  const pkg = (name: string, extra: Partial<PackageInfo> = {}): PackageInfo => ({
    name, declaredRange: '^1.0.0', kind: 'dependencies' as PackageInfo['kind'],
    declaredIn: [fx.path('package.json')], installed: true, version: '1.2.3',
    dir: fx.path(`node_modules/${name}`), types: fx.path(`node_modules/${name}/index.d.ts`),
    main: fx.path(`node_modules/${name}/index.js`), readme: null,
    ...extra,
  });

  it('round-trips packages, storing their paths workspace-relative', async () => {
    const packages = [pkg('zod'), pkg('@scope/pkg', { installed: false, version: null, dir: null, types: null, main: null, declaredRange: 'workspace:*' })];
    assert.equal(db.replacePackages(packages), true);
    assert.deepEqual(db.getPackages(), [packages[1], packages[0]], 'ordered by name');

    db.persist();
    const stored = await rawQuery(fx.dbFile, `SELECT declared_in, dir, main FROM packages WHERE name = 'zod'`);
    assert.deepEqual(stored, [['["package.json"]', 'node_modules/zod', 'node_modules/zod/index.js']]);
  });

  it('returns false and writes nothing when the manifest is unchanged', () => {
    assert.equal(db.replacePackages([pkg('b'), pkg('a')]), true);
    db.persist();
    assert.equal(db.replacePackages([pkg('a'), pkg('b')]), false);
    assert.equal(db.replacePackages([pkg('a'), pkg('b', { version: '2.0.0' })]), true);
    assert.deepEqual(db.getPackages().map(p => p.version), ['1.2.3', '2.0.0']);
    assert.equal(db.replacePackages([]), true);
    assert.deepEqual(db.getPackages(), []);
    assert.equal(db.replacePackages([]), false);
  });

  it('detects an unchanged manifest whatever the package-name casing and punctuation', {
    todo: 'BUG: replacePackages compares SQLite\'s binary ORDER BY name with JS localeCompare order, so e.g. "JSONStream" + "axios" always reports a change and rewrites the DB',
  }, () => {
    const packages = [pkg('JSONStream'), pkg('axios'), pkg('a_b'), pkg('a.b')];
    assert.equal(db.replacePackages(packages), true);
    assert.equal(db.replacePackages(packages), false);
  });

  it('keeps absolute paths for packages outside the workspace', () => {
    const outside = path.join(path.parse(fx.root).root, 'elsewhere', 'pkg');
    db.replacePackages([pkg('up', { dir: outside })]);
    assert.equal(db.getPackages()[0].dir, outside, 'a path above the workspace root survives the round trip');

    const dbNoRoot = new GraphDB(path.join(fx.root, 'not-codelens'));
    return dbNoRoot.init().then(() => {
      try {
        const info = pkg('far', { dir: outside, declaredIn: [path.join(outside, 'package.json')] });
        dbNoRoot.replacePackages([info]);
        assert.deepEqual(dbNoRoot.getPackages()[0].dir, outside);
        assert.deepEqual(dbNoRoot.getPackages()[0].declaredIn, [path.join(outside, 'package.json')]);
      } finally {
        dbNoRoot.close();
      }
    });
  });

  it('getFilesImporting finds files importing a package or one of its subpaths only', () => {
    const add = (rel: string, source: string) => {
      const f = fx.path(rel);
      db.upsertNodes([fileNode(f), importNode(f, source, `import x from '${source}'`)]);
      return f;
    };
    const a = add('src/a.ts', 'lodash');
    const b = add('src/b.ts', 'lodash/merge');
    add('src/c.ts', 'lodash-es');
    add('src/d.ts', 'lodash.merge');
    const e = add('src/e.ts', '@scope/pkg/deep/path');
    db.upsertNode(makeNode(fx.path('src/f.ts'), 'lodash', 'function')); // not an import

    assert.deepEqual(db.getFilesImporting('lodash'), [a, b]);
    assert.deepEqual(db.getFilesImporting('@scope/pkg'), [e]);
    assert.deepEqual(db.getFilesImporting('nothing'), []);
  });
});
