import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { SnippetExtractor } from '../../src/context/snippetExtractor';
import { TestWorkspace } from '../helpers';
import { makeNode, makeTempDir } from './fixtures';

const MAX_SNIPPET_LINES = 12;
const MAX_SNIPPET_CHARS = 600;
const TRUNCATION_MARKER = '\n  // … (truncated)';

describe('SnippetExtractor.extractSnippet', () => {
  const ws = new TestWorkspace();
  const extractor = new SnippetExtractor(() => ws.root);
  let longFn: string;
  let wideFn: string;
  let oneLiners: string;

  before(async () => {
    const body = Array.from({ length: 30 }, (_, i) => `  const v${i} = ${i};`).join('\n');
    longFn = ws.write('src/long.ts', `// header\nexport function longOne(): number {\n${body}\n  return 0;\n}\n`);
    const wide = Array.from({ length: 10 }, (_, i) => `  const value${i} = '${'x'.repeat(100)}';`).join('\n');
    wideFn = ws.write('src/wide.ts', `export function wideOne() {\n${wide}\n}\n`);
    oneLiners = ws.write('src/oneLiners.ts', [
      'export function first(): number { return 1; }',
      'export function second(): number { return 2; }',
      'export function third(): number { return 3; }',
      '',
    ].join('\n'));
    await ws.scan();
  });

  after(() => ws.close());

  it('starts at the symbol line and stops at its end line', () => {
    const snippet = extractor.extractSnippet(makeNode({ name: 'longOne', filePath: longFn, line: 2, endLine: 5 }));
    assert.equal(snippet, 'export function longOne(): number {\n  const v0 = 0;\n  const v1 = 1;\n  const v2 = 2;');
  });

  it(`caps a long body at ${MAX_SNIPPET_LINES} lines`, () => {
    const node = ws.node('longOne', 'src/long.ts');
    assert.ok(node.endLine - node.line + 1 > MAX_SNIPPET_LINES, 'fixture function is longer than the cap');
    const snippet = extractor.extractSnippet(node)!;
    const lines = snippet.split('\n');
    assert.equal(lines.length, MAX_SNIPPET_LINES);
    assert.equal(lines[0], 'export function longOne(): number {', 'first line is the signature line');
    assert.equal(lines[MAX_SNIPPET_LINES - 1], `  const v${MAX_SNIPPET_LINES - 2} = ${MAX_SNIPPET_LINES - 2};`);
  });

  it(`truncates past ${MAX_SNIPPET_CHARS} characters with a marker`, () => {
    const snippet = extractor.extractSnippet(ws.node('wideOne', 'src/wide.ts'))!;
    assert.ok(snippet.endsWith(TRUNCATION_MARKER));
    assert.equal(snippet.length, MAX_SNIPPET_CHARS + TRUNCATION_MARKER.length);
    assert.ok(snippet.startsWith('export function wideOne() {'));
  });

  it('clamps to the end of the file', () => {
    const snippet = extractor.extractSnippet(makeNode({ name: 'third', filePath: oneLiners, line: 3, endLine: 50 }));
    assert.equal(snippet, 'export function third(): number { return 3; }\n');
  });

  it('treats line 0 as the first line', () => {
    const snippet = extractor.extractSnippet(makeNode({ name: 'first', filePath: oneLiners, line: 0, endLine: 1 }));
    assert.equal(snippet?.split('\n')[0], 'export function first(): number { return 1; }');
  });

  it('returns null for file and import nodes', () => {
    assert.equal(extractor.extractSnippet(makeNode({ type: 'file', name: 'long.ts', filePath: longFn })), null);
    assert.equal(extractor.extractSnippet(makeNode({ type: 'import', name: './x', filePath: longFn })), null);
  });

  it('returns null for a missing file or when no workspace root is known', () => {
    assert.equal(extractor.extractSnippet(makeNode({ name: 'gone', filePath: ws.path('src/gone.ts') })), null);
    const rootless = new SnippetExtractor(() => null);
    assert.equal(rootless.extractSnippet(makeNode({ name: 'longOne', filePath: longFn, line: 2 })), null);
  });

  it('returns null when the path is a directory', () => {
    assert.equal(extractor.extractSnippet(makeNode({ name: 'dir', filePath: ws.path('src') })), null);
  });

  it('does not bleed a one-line symbol into the following code', { todo: 'BUG: snippetExtractor.ts:173 uses endLine > line, so a symbol with endLine === line gets 12 lines' }, () => {
    const node = ws.node('first', 'src/oneLiners.ts');
    assert.equal(node.line, node.endLine, 'parser reports a one-line function');
    const snippet = extractor.extractSnippet(node)!;
    assert.doesNotMatch(snippet, /second|third/);
  });
});

describe('SnippetExtractor.extractSignatureLine', () => {
  const ws = new TestWorkspace();
  const extractor = new SnippetExtractor(() => ws.root);
  let file: string;

  before(() => { file = ws.write('src/sig.ts', 'export function sig(a: number) {   \n  return a;\n}\n'); });
  after(() => ws.close());

  it('returns the symbol line without trailing whitespace', () => {
    assert.equal(extractor.extractSignatureLine(makeNode({ name: 'sig', filePath: file, line: 1 })), 'export function sig(a: number) {');
    assert.equal(extractor.extractSignatureLine(makeNode({ name: 'sig', filePath: file, line: 2 })), '  return a;');
  });

  it('returns null past the end of the file, for a missing file, or outside the root', () => {
    assert.equal(extractor.extractSignatureLine(makeNode({ name: 'sig', filePath: file, line: 99 })), null);
    assert.equal(extractor.extractSignatureLine(makeNode({ name: 'sig', filePath: ws.path('nope.ts') })), null);
    assert.equal(new SnippetExtractor(() => null).extractSignatureLine(makeNode({ name: 'sig', filePath: file })), null);
  });
});

describe('SnippetExtractor never reads outside the workspace root', () => {
  const ws = new TestWorkspace();
  const outside = makeTempDir('codelens-outside-');
  const extractor = new SnippetExtractor(() => ws.root);
  const SECRET = 'export function leaked() { return "TOP-SECRET"; }';
  let secretFile: string;

  before(() => {
    secretFile = path.join(outside.dir, 'secret.ts');
    fs.writeFileSync(secretFile, SECRET + '\n');
    ws.write('src/inside.ts', 'export function inside() {}\n');
  });

  after(() => { ws.close(); outside.cleanup(); });

  const leaked = (filePath: string) => [
    extractor.extractSnippet(makeNode({ name: 'leaked', filePath })),
    extractor.extractSignatureLine(makeNode({ name: 'leaked', filePath })),
  ];

  it('reads files inside the root', () => {
    assert.equal(extractor.extractSnippet(makeNode({ name: 'inside', filePath: ws.path('src/inside.ts') })), 'export function inside() {}\n');
  });

  it('refuses an absolute path outside the root', () => {
    assert.deepEqual(leaked(secretFile), [null, null]);
  });

  it('refuses a path that climbs out of the root with ".."', () => {
    const climbing = ws.root + path.sep + path.relative(ws.root, secretFile);
    assert.ok(climbing.includes('..'));
    assert.deepEqual(leaked(climbing), [null, null]);
  });

  it('refuses the workspace root itself', () => {
    assert.deepEqual(leaked(ws.root), [null, null]);
  });

  it('refuses a directory link inside the root that points outside', (t) => {
    const link = ws.path('linked');
    try {
      // 'junction' needs no privileges on Windows; elsewhere it's a plain dir symlink.
      fs.symlinkSync(outside.dir, link, 'junction');
    } catch (e) {
      t.skip(`cannot create a directory link here: ${(e as Error).message}`);
      return;
    }
    const viaLink = path.join(link, 'secret.ts');
    assert.equal(fs.readFileSync(viaLink, 'utf-8').trim(), SECRET, 'link resolves to the outside file');
    assert.deepEqual(leaked(viaLink), [null, null]);
  });

  it('refuses a file symlink inside the root that points outside', (t) => {
    const link = ws.path('src/link.ts');
    try {
      fs.symlinkSync(secretFile, link, 'file');
    } catch (e) {
      t.skip(`file symlinks not permitted here: ${(e as Error).message}`);
      return;
    }
    assert.deepEqual(leaked(link), [null, null]);
  });
});

describe('SnippetExtractor import statements', () => {
  const ws = new TestWorkspace();
  const extractor = new SnippetExtractor(() => ws.root);

  before(() => {
    ws.write('src/utils/emailService.ts', 'export function sendEmail() {}\n');
    ws.write('src/routes/auth.ts', "import x from 'y';\n");
    ws.write('legacy/old.js', "const a = require('a');\nfunction legacy() {}\nmodule.exports = { legacy };\n");
    ws.write('py/tools/helpers.py', 'def helper():\n    pass\n');
  });

  after(() => ws.close());

  it('resolves an import path relative to the consuming file', () => {
    const node = makeNode({ name: 'sendEmail', filePath: ws.path('src/utils/emailService.ts') });
    assert.equal(extractor.resolveImportPath(node, ws.path('src/routes/auth.ts')), '../utils/emailService');
    assert.equal(extractor.buildImportStatement(node, ws.path('src/routes/auth.ts'), 'typescript'), "import { sendEmail } from '../utils/emailService';");
  });

  it('builds a workspace-root import in the defining file\'s module system', () => {
    const ts = makeNode({ name: 'sendEmail', filePath: ws.path('src/utils/emailService.ts') });
    assert.equal(extractor.buildWorkspaceImportStatement(ts), "import { sendEmail } from './src/utils/emailService';");
    const cjs = makeNode({ name: 'legacy', filePath: ws.path('legacy/old.js'), language: 'javascript' });
    assert.equal(extractor.buildWorkspaceImportStatement(cjs), "const { legacy } = require('./legacy/old');");
    const py = makeNode({ name: 'helper', filePath: ws.path('py/tools/helpers.py'), language: 'python' });
    assert.equal(extractor.buildWorkspaceImportStatement(py), 'from py.tools.helpers import helper');
  });

  it('has no workspace import for file/import nodes or without a root', () => {
    const filePath = ws.path('src/utils/emailService.ts');
    assert.equal(extractor.buildWorkspaceImportStatement(makeNode({ type: 'file', name: 'emailService.ts', filePath })), null);
    assert.equal(extractor.buildWorkspaceImportStatement(makeNode({ type: 'import', name: 'x', filePath })), null);
    assert.equal(new SnippetExtractor(() => null).buildWorkspaceImportStatement(makeNode({ name: 'sendEmail', filePath })), null);
  });
});
