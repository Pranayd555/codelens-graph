import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { ContextBuilder } from '../../src/context/contextBuilder';
import { GraphDB } from '../../src/graph/graphDB';
import { TestWorkspace } from '../helpers';
import { renderedSymbols, scanNested, section } from './fixtures';

describe('ContextBuilder token budget', () => {
  const ws = new TestWorkspace();
  let cb: ContextBuilder;

  before(async () => {
    for (let i = 0; i < 20; i++) {
      const body = Array.from({ length: 30 }, (_, j) => `  const v${j} = order${i} + ${j}; // order processing step`).join('\n');
      ws.write(`src/orders/order${i}.ts`, `export function processOrder${i}(order${i}: number): number {\n${body}\n  return order${i};\n}\nexport function helperOrder${i}() { return processOrder${i}(1); }\n`);
    }
    await ws.scan();
    cb = new ContextBuilder(ws.db);
  });

  after(() => ws.close());

  it('caps entry points at 10', () => {
    const ctx = cb.build('process order totals', 1, 100000);
    assert.equal(ctx.entryPoints.length, 10);
  });

  it('a smaller budget keeps a prefix of the ranked nodes', () => {
    const full = cb.build('process order totals', 2, 100000).subgraph.nodes.map(n => n.id);
    // Node sizes include absolute paths (much longer under the Windows temp
    // folder), so find the smallest power-of-two budget that fits every node
    // instead of hard-coding budgets; half of it is then guaranteed to trim.
    let fitsAll = 30;
    while (cb.build('process order totals', 2, fitsAll).subgraph.nodes.length < full.length) { fitsAll *= 2; }
    assert.ok(fitsAll > 30, 'the fixture needs more than the smallest budget');
    let previous = -1;
    for (const budget of [0, 30, fitsAll / 8, fitsAll / 4, fitsAll / 2]) {
      const ctx = cb.build('process order totals', 2, budget);
      const ids = ctx.subgraph.nodes.map(n => n.id);
      assert.deepEqual(ids, full.slice(0, ids.length), `budget ${budget}`);
      assert.ok(ids.length >= previous, 'more budget never means fewer nodes');
      previous = ids.length;
      const included = new Set(ids);
      assert.ok(ctx.subgraph.edges.every(e => included.has(e.fromId) && included.has(e.toId)));
    }
    assert.ok(previous < full.length, 'the largest tested budget still trims');
  });

  it('a zero budget keeps no symbols', () => {
    const ctx = cb.build('process order totals', 2, 0);
    assert.deepEqual(ctx.subgraph.nodes, []);
    assert.deepEqual(ctx.subgraph.edges, []);
    assert.equal(renderedSymbols(cb.buildSystemPromptInjection(ctx)).length, 0);
  });

  it('collapses long file lists in the overview', () => {
    const ctx = cb.build('process order totals', 0, 2000);
    const all = section(cb.buildSystemPromptInjection(ctx), 'All workspace files')!;
    const line = all.split('\n').find(l => l.startsWith('**Other:**'))!;
    assert.match(line, /\(\+ 5 more\)$/);
    assert.equal(line.split(', ').length, 15);
  });

  it('the rendered context stays within maxTokenBudget', { todo: 'BUG: trimToBudget (contextBuilder.ts:140-161) budgets only compact node JSON; snippets, warnings and file lists are not counted (deep mode: ~3.8k tokens for a 2k budget)' }, () => {
    for (const mode of ['short', 'deep'] as const) {
      const ctx = cb.build('process order totals', 2, 2000, mode);
      assert.ok(ctx.tokenEstimate <= 2000, `${mode}: ${ctx.tokenEstimate} tokens for a 2000 budget`);
    }
  });
});

describe('ContextBuilder on an empty workspace', () => {
  const ws = new TestWorkspace();
  before(async () => { await ws.scan(); });
  after(() => ws.close());

  it('renders headers without a file map', () => {
    const cb = new ContextBuilder(ws.db);
    const ctx = cb.build('anything at all', 2, 2000);
    assert.deepEqual(ctx.existingFiles, []);
    const out = cb.buildSystemPromptInjection(ctx);
    assert.equal(section(out, 'File map'), null);
    assert.ok(section(out, 'Relevant symbols') !== null);
    assert.equal(section(out, 'All workspace files')?.trim(), '');
  });
});

describe('ContextBuilder file categories', () => {
  const ws = new TestWorkspace();
  let db: GraphDB | undefined;
  let cb: ContextBuilder;
  before(async () => {
    // The project root sits in a folder named "lib" (e.g. ~/src/lib/app).
    ws.write('lib/app/src/server.ts', 'export function startServer() {}\n');
    ws.write('lib/app/src/main.ts', 'export function main() {}\n');
    db = await scanNested(ws, 'lib/app');
    cb = new ContextBuilder(db);
  });
  after(() => { db?.close(); ws.close(); });

  it('classifies files by their path inside the workspace, not its parent folders', { todo: 'BUG: contextBuilder.ts:205,289,412 classify absolute paths, so a parent folder of the root (lib/, api/, services/...) decides every file\'s category' }, () => {
    const out = cb.buildSystemPromptInjection(cb.build('startServer', 0, 2000));
    const all = section(out, 'All workspace files')!;
    assert.match(all, /^\*\*Other:\*\* main\.ts, server\.ts$/m, all);
  });
});
