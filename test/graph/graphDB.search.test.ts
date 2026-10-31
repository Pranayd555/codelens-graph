import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { GraphDB, FileLine } from '../../src/graph/graphDB';
import { GraphFixture, makeNode, fileNode, withClock } from './graphFixtures';

describe('GraphDB.searchNodes', () => {
  const fx = new GraphFixture();
  let db: GraphDB;

  before(async () => {
    db = await fx.open();
    const a = fx.path('src/a.ts');
    db.upsertNodes([
      fileNode(a),
      makeNode(a, 'parseConfigFile', 'function', 1),
      makeNode(a, 'parse', 'function', 5),
      makeNode(a, 'ConfigParser', 'class', 9),
      makeNode(a, 'loadAll', 'function', 20, { signature: 'loadAll(parseOptions: Options)' }),
      makeNode(a, 'helper', 'function', 30, { docComment: 'Used to PARSE things' }),
      makeNode(a, 'x', 'variable', 40),
      makeNode(fx.path('node_modules/lib/index.js'), 'parseLib', 'function', 1),
      makeNode(fx.path('package.json'), 'parseScript', 'property', 1),
      makeNode(fx.path('docs/guide.md'), 'parseHeading', 'property', 1),
    ]);
  });
  after(() => fx.close());

  const names = (q: string, limit?: number, scope?: 'workspace' | 'deps' | 'all') => db.searchNodes(q, limit, scope).map(n => n.name);

  it('ranks an exact name first, then prefix matches, then other matches by name', () => {
    assert.deepEqual(names('parse'), ['parse', 'parseConfigFile', 'ConfigParser', 'helper', 'loadAll']);
  });

  it('matches case-insensitively on name, signature and doc comment', () => {
    assert.deepEqual(names('PARSEOPTIONS'), ['loadAll']);
    assert.deepEqual(names('things'), ['helper']);
  });

  it('accepts pipe-separated alternatives, ranking by the first', () => {
    assert.deepEqual(names('loadAll|ConfigParser'), ['loadAll', 'ConfigParser']);
  });

  it('decodes URI-encoded queries and tolerates malformed encodings', () => {
    assert.deepEqual(names('load%41ll'), ['loadAll']);
    assert.deepEqual(names('%E0%A4%A'), []);
  });

  it('drops tokens shorter than 2 characters or without word characters', () => {
    assert.deepEqual(names('x'), []);
    assert.deepEqual(names('  '), []);
    assert.deepEqual(names('--'), []);
    assert.deepEqual(names('x|loadAll'), ['loadAll']);
  });

  it('applies the limit after scope filtering', () => {
    assert.deepEqual(names('parse', 2), ['parse', 'parseConfigFile']);
  });

  it('scopes results: workspace excludes deps and config files, deps only those, all everything', () => {
    assert.ok(!names('parse').some(n => ['parseLib', 'parseScript', 'parseHeading'].includes(n)));
    assert.deepEqual(names('parse', 20, 'deps').sort(), ['parseHeading', 'parseLib', 'parseScript']);
    assert.equal(names('parse', 20, 'all').length, 8);
  });
});

describe('GraphDB text lines', () => {
  const fx = new GraphFixture();
  let db: GraphDB;
  const a = fx.path('src/a.ts');
  const b = fx.path('lib/b.py');

  before(async () => {
    db = await fx.open();
    const lines: FileLine[] = [
      { filePath: a, line: 1, rawText: '// TODO: fix the Widget cache', tokenType: 'comment' },
      { filePath: a, line: 2, rawText: 'const label = "Widget title";', tokenType: 'symbol' },
      { filePath: a, line: 3, rawText: 'render("Widget")', tokenType: 'string_literal' },
      { filePath: a, line: 4, rawText: 'value = computeTotal(items)', tokenType: 'identifier' },
      { filePath: a, line: 5, rawText: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa!', tokenType: 'unknown' },
      { filePath: a, line: 6, rawText: 'pattern = "(a+)+$"', tokenType: 'string_literal' },
      { filePath: a, line: 7, rawText: 'user_id = 1', tokenType: 'identifier' },
      { filePath: a, line: 8, rawText: 'userXid = 2', tokenType: 'identifier' },
    ];
    db.addFileLines(lines);
    db.addFileLines([{ filePath: b, line: 1, rawText: '# Widget helpers', tokenType: 'comment' }]);
    db.addFileLines([{ filePath: fx.path('node_modules/w/index.js'), line: 1, rawText: 'Widget()', tokenType: 'unknown' }]);
    db.addFileLines([]);
  });
  after(() => fx.close());

  const hits = (r: Array<{ filePath: string; line: number }>) => r.map(x => `${x.filePath === a ? 'a' : 'b'}:${x.line}`);

  it('finds literal text case-insensitively and skips node_modules', () => {
    assert.deepEqual(hits(db.searchFileLines('widget', undefined, false, false, 50)).sort(), ['a:1', 'a:2', 'a:3', 'b:1']);
  });

  it('filters to comments or string literals', () => {
    assert.deepEqual(hits(db.searchFileLines('widget', undefined, true, false, 50)).sort(), ['a:1', 'b:1']);
    assert.deepEqual(hits(db.searchFileLines('widget', undefined, false, true, 50)), ['a:3']);
  });

  it('filters by file pattern, relative to the workspace root', () => {
    assert.deepEqual(hits(db.searchFileLines('widget', '.py', false, false, 50)), ['b:1']);
    assert.deepEqual(hits(db.searchFileLines('widget', 'src/**', false, false, 50, fx.root)).sort(), ['a:1', 'a:2', 'a:3']);
  });

  it('honours the limit', () => {
    assert.equal(db.searchFileLines('widget', undefined, false, false, 2).length, 2);
    assert.equal(db.searchFileLines('widget').length, 4, 'default limit is 10');
  });

  it('treats queries with regex syntax as case-insensitive regular expressions', () => {
    assert.deepEqual(hits(db.searchFileLines('compute\\w+\\(', undefined, false, false, 50)), ['a:4']);
    assert.deepEqual(hits(db.searchFileLines('^render|^value', undefined, false, false, 50)).sort(), ['a:3', 'a:4']);
  });

  it('falls back to a literal search for backtracking-prone or invalid patterns', () => {
    // (a+)+$ would backtrack catastrophically on line 5; it only matches its literal text.
    assert.deepEqual(hits(db.searchFileLines('(a+)+$', undefined, false, false, 50)), ['a:6']);
    assert.deepEqual(db.searchFileLines('render((', undefined, false, false, 50), []);
    assert.deepEqual(hits(db.searchFileLines('render(', undefined, false, false, 50)), ['a:3']);
  });

  it('literal search does not treat _ or % as wildcards', {
    todo: 'BUG: literal searchFileLines/getTextEntriesByWord use LIKE without ESCAPE and no JS re-check, so "_" and "%" match any characters',
  }, () => {
    assert.deepEqual(hits(db.searchFileLines('user_id', undefined, false, false, 50)), ['a:7']);
    assert.deepEqual(db.getTextEntriesByWord('user_id', true).map(e => e.line), [7]);
  });

  it('stops a long regex scan once the time budget is spent', async () => {
    const fx2 = new GraphFixture();
    try {
      const db2 = await fx2.open();
      const f = fx2.path('big.ts');
      db2.addFileLines(Array.from({ length: 1200 }, (_, i) => ({ filePath: f, line: i + 1, rawText: `item${i} = ${i}`, tokenType: 'identifier' })));
      let calls = 0;
      // The first call sets the deadline; every later call is far past it.
      const found = await withClock(() => (calls++ === 0 ? 0 : 1e12), () => db2.searchFileLines('item\\d+', undefined, false, false, 5000));
      assert.equal(found.length, 499, 'the deadline is checked every 500 rows');
      assert.equal(db2.searchFileLines('item\\d+', undefined, false, false, 5000).length, 1200);
    } finally {
      fx2.close();
    }
  });

  it('getTextEntriesByWord matches substrings case-insensitively, including node_modules', () => {
    const entries = db.getTextEntriesByWord('WIDGET', false);
    assert.equal(entries.length, 5);
    const first = entries.find(e => e.filePath === a && e.line === 1);
    assert.deepEqual(first, {
      word: 'WIDGET', filePath: a, line: 1,
      text: '// todo: fix the widget cache', rawText: '// TODO: fix the Widget cache', tokenType: 'comment',
    });
  });

  it('addFileLines keeps the first text for a line; deleteFileLinesByFile clears a file', async () => {
    const fx2 = new GraphFixture();
    try {
      const db2 = await fx2.open();
      const f = fx2.path('c.ts');
      db2.addFileLines([{ filePath: f, line: 1, rawText: 'first', tokenType: 'unknown' }]);
      db2.addFileLines([{ filePath: f, line: 1, rawText: 'second', tokenType: 'unknown' }]);
      assert.deepEqual(db2.searchFileLines('first').map(r => r.rawText), ['first']);
      assert.deepEqual(db2.searchFileLines('second'), []);

      db2.deleteFileLinesByFile(f);
      assert.deepEqual(db2.searchFileLines('first'), []);
      db2.deleteFileLinesByFile(fx2.path('never.ts'));
    } finally {
      fx2.close();
    }
  });

  it('legacy addTextEntries/deleteTextEntriesByFile map onto file lines, de-duplicating by file and line', async () => {
    const fx2 = new GraphFixture();
    try {
      const db2 = await fx2.open();
      const f = fx2.path('d.ts');
      db2.addTextEntries([
        { filePath: f, line: 1, rawText: 'legacy one', tokenType: 'unknown', word: 'legacy' },
        { filePath: f, line: 1, rawText: 'legacy one', tokenType: 'unknown', word: 'one' },
        { filePath: f, line: 2, rawText: 'legacy two', tokenType: 'comment', word: 'legacy' },
      ]);
      assert.deepEqual(db2.getTextEntriesByWord('legacy', true).map(e => e.line).sort(), [1, 2]);
      db2.deleteTextEntriesByFile(f);
      assert.deepEqual(db2.getTextEntriesByWord('legacy', true), []);
    } finally {
      fx2.close();
    }
  });

  it('addTextEntries keeps entries from different files apart', {
    todo: 'BUG: addFileLines stores every line under lines[0].filePath, so a multi-file batch is attributed to the first file',
  }, async () => {
    const fx2 = new GraphFixture();
    try {
      const db2 = await fx2.open();
      const f1 = fx2.path('one.ts');
      const f2 = fx2.path('two.ts');
      db2.addTextEntries([
        { filePath: f1, line: 1, rawText: 'shared alpha', tokenType: 'unknown' },
        { filePath: f2, line: 1, rawText: 'shared beta', tokenType: 'unknown' },
      ]);
      assert.deepEqual(
        db2.getTextEntriesByWord('shared', true).map(e => [e.filePath, e.rawText]).sort(),
        [[f1, 'shared alpha'], [f2, 'shared beta']]
      );
    } finally {
      fx2.close();
    }
  });
});
