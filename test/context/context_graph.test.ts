import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ContextBuilder } from '../../src/context/contextBuilder';
import { TestWorkspace } from '../helpers';
import { insertFile, makeTempDir, symbolsOf } from './fixtures';

// One scanned workspace per test file: a second tree-sitter init in the same
// process silently falls back to the regex parser.
const ws = new TestWorkspace();
const outside = makeTempDir('codelens-outside-');
let cb: ContextBuilder;

before(async () => {
  ws.write('src/invoices.ts', [
    '/** Sends the invoice to the customer */',
    'export function dispatch() { return 1; }',
    'export function invoiceTotal() { return 2; }',
    'export class InvoiceStore {}',
    'function buildInvoice(): string { return ""; }',
    '',
  ].join('\n'));
  ws.write('chain/a.ts', "import { betaStep } from './b';\nexport function alphaStart() { return betaStep(); }\n");
  ws.write('chain/b.ts', "import { gammaStep } from './c';\nexport function betaStep() { return gammaStep(); }\n");
  ws.write('chain/c.ts', "import { deltaStep } from './d';\nexport function gammaStep() { return deltaStep(); }\n");
  ws.write('chain/d.ts', 'export function deltaStep() { return 4; }\n');
  ws.write('src/inside.ts', 'export function leakCheckInside() {\n  return 1;\n}\n');
  await ws.scan();

  // A pre-built index could point anywhere, including outside the workspace.
  const secretFile = path.join(outside.dir, 'secret.ts');
  fs.writeFileSync(secretFile, 'export function leakCheckOutside() { return "TOP-SECRET"; }\n');
  insertFile(ws.db, secretFile, [{ name: 'leakCheckOutside', line: 1, endLine: 1 }]);

  cb = new ContextBuilder(ws.db);
});

after(() => { ws.close(); outside.cleanup(); });

describe('ContextBuilder relevance scoring', () => {
  it('orders by name match, then type and export, then signature/doc matches', () => {
    const ctx = cb.build('invoice', 0, 5000);
    // name match (+20) + function (15) + export (8) = 43; class 40; unexported 35; doc-only 28; file last.
    assert.deepEqual(ctx.subgraph.nodes.map(n => n.name), ['invoiceTotal', 'InvoiceStore', 'buildInvoice', 'dispatch', 'invoices.ts']);
  });

  it('a symbol named verbatim in the task ranks first', () => {
    const ctx = cb.build('rename dispatch to send invoice', 0, 5000);
    assert.equal(ctx.subgraph.nodes[0].name, 'dispatch');
  });
});

describe('ContextBuilder depth expansion', () => {
  it('follows the call chain one hop per depth level', () => {
    const fns = (depth: number) => cb.build('alphaStart', depth, 5000).subgraph.nodes.filter(n => n.type === 'function').map(n => n.name).sort();
    assert.deepEqual(fns(0), ['alphaStart']);
    assert.deepEqual(fns(1), ['alphaStart', 'betaStep']);
    assert.deepEqual(fns(2), ['alphaStart', 'betaStep', 'gammaStep']);
    assert.deepEqual(fns(3), ['alphaStart', 'betaStep', 'deltaStep', 'gammaStep']);
  });

  it('keeps only edges between included nodes', () => {
    const ctx = cb.build('alphaStart', 3, 5000);
    const ids = new Set(ctx.subgraph.nodes.map(n => n.id));
    assert.ok(ctx.subgraph.edges.some(e => e.type === 'calls'));
    assert.ok(ctx.subgraph.edges.every(e => ids.has(e.fromId) && ids.has(e.toId)));
  });
});

describe('ContextBuilder never reads sources outside the workspace', () => {
  it('lists an out-of-root symbol but shows no snippet for it', () => {
    const ctx = cb.build('leakCheck', 0, 5000, 'deep', 'all');
    assert.ok(symbolsOf(ctx).includes('leakCheckOutside'));
    const out = cb.buildSystemPromptInjection(ctx, 'deep');
    assert.match(out, /return 1;/, 'in-root snippet is shown');
    assert.doesNotMatch(out, /TOP-SECRET/);
  });
});
