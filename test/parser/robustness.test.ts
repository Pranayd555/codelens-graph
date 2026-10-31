import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { PARSER_VERSION, makeNodeId, makeEdgeId } from '../../src/ingestion/astParser';
import { ParserFixture, find, get, namesOf, fileNode, callsFrom, refsOf } from './fixtures';

describe('Parser API basics', () => {
  const fx = new ParserFixture();
  after(() => fx.cleanup());

  it('exports a PARSER_VERSION string', () => {
    assert.equal(typeof PARSER_VERSION, 'string');
    assert.match(PARSER_VERSION, /^\d+$/);
  });

  it('builds ids from their parts', () => {
    assert.equal(makeNodeId('/a/b.ts', 'fn', 3), '/a/b.ts::fn::3');
    assert.equal(makeEdgeId('x', 'calls', 'y'), 'x--calls-->y');
  });

  it('maps extensions to languages, case-insensitively', () => {
    const exts = fx.parser.getSupportedExtensions();
    for (const ext of ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.py', '.go', '.rs', '.java', '.cs', '.cpp', '.cc', '.c', '.h', '.rb', '.php', '.swift', '.kt']) {
      assert.ok(exts.includes(ext), ext);
    }
    assert.equal(fx.parser.getLanguageForFile('src/App.TSX'), 'tsx');
    assert.equal(fx.parser.getLanguageForFile('x.py'), 'python');
    assert.equal(fx.parser.getLanguageForFile('README.md'), null);
    assert.equal(fx.parser.canParse('main.go'), true);
    assert.equal(fx.parser.canParse('notes.txt'), false);
  });

  it('reports files that cannot be read', async () => {
    const p = await fx.parser.parseFileAsync(fx.path('does-not-exist.ts'));
    assert.equal(p.language, 'typescript');
    assert.deepEqual(p.nodes, []);
    assert.equal(p.parseErrors.length, 1);
    assert.match(p.parseErrors[0], /^Cannot read/);
  });
});

describe('Robustness', () => {
  const fx = new ParserFixture();
  after(() => fx.cleanup());

  it('returns no nodes for an empty file', async () => {
    const p = await fx.parse('empty.ts', '');
    assert.equal(p.language, 'typescript');
    assert.deepEqual(p.nodes, []);
    assert.deepEqual(p.edges, []);
    assert.deepEqual(p.parseErrors, []);
  });

  it('returns no nodes for a whitespace-only file', async () => {
    const p = await fx.parse('ws.py', '  \n\t\r\n  ');
    assert.equal(p.language, 'python');
    assert.deepEqual(p.nodes, []);
    assert.deepEqual(p.parseErrors, []);
  });

  it('skips files over 1,000,000 characters entirely', async () => {
    const p = await fx.parse('huge.ts', `// ${'x'.repeat(1_000_001)}\nexport function hidden() {}\n`);
    assert.deepEqual(p.nodes, []);
    assert.deepEqual(p.edges, []);
    assert.deepEqual(p.parseErrors, []);
  });

  it('still parses a file just under the size limit', async () => {
    const p = await fx.parse('big.ts', `export function edge() {}\n// ${'y'.repeat(990_000)}\n`);
    assert.ok(find(p, 'edge', 'function'));
  });

  it('does not throw on TS syntax errors and keeps the valid declarations', async () => {
    const p = await fx.parse('bad.ts', 'export function broken( {\n  return 1 +;\n}\nfunction ok() { return 2; }\nclass {\n');
    assert.equal(p.language, 'typescript');
    assert.ok(find(p, 'ok', 'function'));
    assert.equal(get(p, 'ok').line, 4);
  });

  it('does not throw on garbage input in every tree-sitter language', async () => {
    const garbage = '}{)(][ <<< >>> ::: @@@ \u0000 "unterminated\n';
    for (const ext of ['ts', 'tsx', 'js', 'py', 'go', 'rs', 'java', 'cs', 'rb']) {
      const p = await fx.parse(`garbage.${ext}`, garbage);
      assert.ok(Array.isArray(p.nodes), ext);
      assert.equal(fileNode(p).name, `garbage.${ext}`);
    }
  });

  it('handles unicode identifiers with correct names, signatures and refs', async () => {
    const p = await fx.parse('uni.ts', [
      'export function café(ñ: number) { return ñ; }',
      'export const 名前 = 1;',
      'function αβ() { return café(1) + 未定義(); }',
      "const s = '😀😀'; export function afterEmoji() { return s; }",
      '',
    ].join('\n'));
    assert.equal(get(p, 'café', 'function').signature, 'function café(ñ: number) { return ñ; }');
    assert.ok(find(p, '名前', 'variable'));
    assert.deepEqual(refsOf(get(p, 'αβ')), ['未定義']);
    assert.deepEqual(callsFrom(p, 'αβ'), ['café', '未定義']);
    // Offsets after astral-plane characters still line up.
    assert.equal(get(p, 'afterEmoji').signature, 'function afterEmoji() { return s; }');
  });

  it('keeps non-ASCII parameter names', { todo: 'BUG: params must match /^\\w+$/ (ASCII only), so `café(ñ: number)` has no params (astParser.ts:816)' }, async () => {
    const p = await fx.parse('uni-params.ts', 'export function café(ñame: number, größe: string) { return ñame; }\n');
    assert.deepEqual(get(p, 'café').params?.map(x => x.name), ['ñame', 'größe']);
  });

  it('handles very long lines and caps signatures at 200 chars', async () => {
    const values = Array.from({ length: 20_000 }, (_, i) => i).join(',');
    const p = await fx.parse('long.ts', `export function longLine() { return [${values}]; }\nexport function second() { return longLine(); }\n`);
    const longLine = get(p, 'longLine', 'function');
    assert.ok((longLine.signature?.length ?? 0) <= 200);
    assert.equal(get(p, 'second').line, 2);
    assert.deepEqual(callsFrom(p, 'second'), ['longLine']);
  });

  it('handles a UTF-8 BOM', async () => {
    const p = await fx.parse('bom.ts', Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from('import { dep } from "./dep";\nexport function bom() { return dep(); }\n'),
    ]));
    const bom = get(p, 'bom', 'function');
    assert.equal(bom.line, 2);
    assert.equal(bom.signature, 'function bom() { return dep(); }');
    assert.deepEqual(p.nodes.filter(n => n.type === 'import').map(n => [n.name, n.line]), [['./dep', 1]]);
    assert.deepEqual(refsOf(bom), []);
  });

  it('handles CRLF line endings without leaking \\r into names, signatures or docs', async () => {
    const p = await fx.parse('crlf.ts', [
      'import { dep } from "./dep";',
      '',
      '// doc line',
      'export function crlf(x: number): number {',
      '  return dep(x);',
      '}',
      'export class K {',
      '  m() { return 1; }',
      '}',
      '',
    ].join('\r\n'));
    const fn = get(p, 'crlf', 'function');
    assert.equal(fn.line, 4);
    assert.equal(fn.endLine, 6);
    assert.equal(fn.signature, 'function crlf(x: number): number {');
    assert.equal(fn.docComment, 'doc line');
    assert.deepEqual(fn.params?.map(x => [x.name, x.type]), [['x', 'number']]);
    assert.deepEqual(p.nodes.filter(n => n.type === 'import').map(n => n.name), ['./dep']);
    assert.deepEqual(refsOf(fn), []);
    assert.deepEqual(callsFrom(p, 'crlf'), ['dep']);
    assert.ok(!p.nodes.some(n => n.name.includes('\r') || n.signature?.includes('\r')));
    assert.equal(fileNode(p).endLine, 10);
  });

  it('handles CRLF Python files', async () => {
    const p = await fx.parse('crlf.py', 'import os\r\n\r\ndef run(a):\r\n    return a\r\n');
    assert.equal(get(p, 'run').line, 3);
    assert.equal(get(p, 'run').signature, 'def run(a):');
    assert.deepEqual(p.nodes.filter(n => n.type === 'import').map(n => n.name), ['os']);
  });
});

describe('Files under node_modules', () => {
  const fx = new ParserFixture();
  after(() => fx.cleanup());

  it('emits no import, function, method or variable nodes, but keeps the file and classes', async () => {
    const p = await fx.parse('node_modules/pkg/index.js', [
      'import x from "y";',
      "const cjs = require('z');",
      'export function f() { return x(); }',
      'export const v = 1;',
      'export class K { m() { return 1; } }',
      'export default K;',
      '',
    ].join('\n'));
    assert.equal(p.language, 'javascript');
    assert.deepEqual(p.nodes.map(n => n.type).sort(), ['class', 'file']);
    assert.deepEqual(namesOf(p, 'class'), ['K']);
    assert.ok(!p.edges.some(e => e.type === 'imports'));
  });

  it('applies to nested node_modules and Python packages too', async () => {
    const p = await fx.parse('app/node_modules/@scope/lib/node_modules/dep/mod.py', 'import os\nclass Dep:\n    def go(self):\n        return os.getcwd()\n');
    assert.deepEqual(p.nodes.map(n => n.type).sort(), ['class', 'file']);
  });
});
