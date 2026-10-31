import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { GraphDB } from '../../src/graph/graphDB';
import { TextIndex } from '../../src/indexing/textIndex';
import { GraphFixture, quietly } from './graphFixtures';

describe('TextIndex', () => {
  let fx: GraphFixture;
  let db: GraphDB;
  let index: TextIndex;
  beforeEach(async () => { fx = new GraphFixture(); db = await fx.open(); index = new TextIndex(db); });
  afterEach(() => fx.close());

  const SOURCE = [
    '// leading comment about Widgets',  // 1 comment
    '',                                  // 2 skipped
    '/* block Widget */',                // 3 comment
    ' * continued Widget docs',          // 4 comment
    '# hash Widget comment',             // 5 comment
    'render("Widget")',                  // 6 string_literal
    "const label = 'Widget';",           // 7 symbol (const wins over quotes)
    'export function makeWidget() {',    // 8 symbol
    '  widgetCount = 3',                 // 9 identifier
    '  widgetMap: true,',                // 10 identifier
    '  return buildWidget();',           // 11 unknown
    '}\r',                               // 12 unknown (CRLF)
  ].join('\n');

  it('indexes non-empty trimmed lines with 1-based numbers and a token type', async () => {
    const f = fx.write('src/w.ts', SOURCE);
    await index.buildForFile(f, 'typescript');
    const results = index.search('widget', { limit: 100 });
    const byLine = new Map(results.map(r => [r.line, r]));
    assert.deepEqual([...byLine.keys()].sort((x, y) => x - y), [1, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    assert.deepEqual(
      [...byLine.entries()].sort((x, y) => x[0] - y[0]).map(([line, r]) => `${line}:${r.tokenType}`),
      ['1:comment', '3:comment', '4:comment', '5:comment', '6:string_literal', '7:symbol', '8:symbol', '9:identifier', '10:identifier', '11:unknown']
    );
    assert.deepEqual(byLine.get(9), {
      filePath: f, line: 9, text: 'widgetcount = 3', rawText: 'widgetCount = 3', tokenType: 'identifier',
    });
    assert.deepEqual(index.search('}', {}).map(r => [r.line, r.rawText, r.tokenType]), [[12, '}', 'unknown']]);
  });

  it('replaces a file\'s previous entries when rebuilt, and clears them when the file becomes empty', async () => {
    const f = fx.write('a.ts', 'oldToken = 1\n');
    await index.buildForFile(f, 'typescript');
    assert.equal(index.search('oldToken').length, 1);

    fx.write('a.ts', 'newToken = 1\n');
    await index.buildForFile(f, 'typescript');
    assert.deepEqual(index.search('oldToken'), []);
    assert.equal(index.search('newToken').length, 1);

    fx.write('a.ts', '\n   \n');
    await index.buildForFile(f, 'typescript');
    assert.deepEqual(index.search('newToken'), []);
  });

  it('logs and keeps going when the file cannot be read', async () => {
    await quietly(() => index.buildForFile(fx.path('missing.ts'), 'typescript'));
    assert.deepEqual(index.search('anything'), []);
  });

  it('filters by comment or string token type, by file pattern, and limits results', async () => {
    await index.buildForFile(fx.write('src/w.ts', SOURCE), 'typescript');
    await index.buildForFile(fx.write('lib/w.py', '# Widget in python\n'), 'python');

    assert.deepEqual(index.search('widget', { tokenType: 'comment', limit: 50 }).map(r => r.tokenType), Array(5).fill('comment'));
    assert.deepEqual(index.search('widget', { tokenType: 'string_literal' }).map(r => r.line), [6]);
    assert.deepEqual(index.search('widget', { fileFilter: '.py' }).map(r => r.rawText), ['# Widget in python']);
    assert.equal(index.search('widget', { limit: 3 }).length, 3);
    assert.equal(index.search('widget').length, 11, 'default limit 20');
  });

  it('supports regex queries', async () => {
    await index.buildForFile(fx.write('src/w.ts', SOURCE), 'typescript');
    assert.deepEqual(index.search('^export\\s+function').map(r => r.line), [8]);
  });

  it('filters by the symbol and identifier token types too', {
    todo: 'BUG: TextIndex.search only forwards comment/string_literal filters to searchFileLines; tokenType "symbol"/"identifier"/"unknown" is ignored',
  }, async () => {
    await index.buildForFile(fx.write('src/w.ts', SOURCE), 'typescript');
    assert.deepEqual(index.search('widget', { tokenType: 'symbol', limit: 50 }).map(r => r.line), [7, 8]);
    assert.deepEqual(index.search('widget', { tokenType: 'identifier', limit: 50 }).map(r => r.line), [9, 10]);
  });
});
