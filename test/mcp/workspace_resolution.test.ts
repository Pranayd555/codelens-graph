import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { McpClient, TempDir, filesIndexed, writeRegistry, writeDisabled, delay } from './_client';
import { buildIndex } from './_index';

// Which workspace the standalone server serves, and when it indexes one.

// Asserts that for `ms` the workspace stays unindexed (no graph DB written).
async function assertStaysUnindexed(client: McpClient, dbFile: string, ms: number): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    assert.equal(filesIndexed((await client.call('codelens_status')).text), 0);
    assert.ok(!fs.existsSync(dbFile), dbFile + ' was written');
    await delay(100);
  }
}

describe('--auto: workspace from the VS Code window registry', { timeout: 120000 }, () => {
  const t = new TempDir();
  let client: McpClient;
  let home: string;

  before(async () => {
    t.write('old/src/old.ts', 'export function oldOnlySymbol() { return 1; }\n');
    await buildIndex(t.path('old'));
    t.write('new/src/new.ts', 'export function newOnlySymbol() { return 2; }\n');
    home = t.mkdir('home');
    writeRegistry(home, {
      111: { path: t.path('old'), lastActive: 1000 },
      222: { path: t.path('new'), lastActive: 2000 },
    });
    client = await McpClient.start({ arg: '--auto', cwd: t.mkdir('elsewhere'), home });
  });

  after(async () => {
    await client?.close();
    t.cleanup();
  });

  it('serves the most recently active window', async () => {
    const search = await client.call('codelens_search', { query: 'oldOnlySymbol' });
    assert.match(search.text, /^No symbols found/);
    // Tool calls are logged under the served workspace.
    assert.ok(t.exists('new/.codelens/mcp-usage.jsonl'));
    assert.ok(!t.exists('old/.codelens/mcp-usage.jsonl'));
    assert.ok(!t.exists('elsewhere/.codelens'));
  });

  it('does not index a workspace that is open in VS Code (the extension owns its DB)', async () => {
    await assertStaysUnindexed(client, t.path('new/.codelens/codelens-graph.db'), 1500);
    assert.match(client.stderr.join(''), /is open in VS Code; the CodeLens extension builds the graph/);
  });

  it('accepts a workspace override for another registered window', async () => {
    const res = await client.call('codelens_search', { query: 'oldOnlySymbol', workspace: t.path('old') });
    assert.equal(res.isError, false);
    assert.match(res.text, /\[function\] oldOnlySymbol @ src\/old\.ts:1/);
  });

  it('follows the registry when another window becomes active', async () => {
    writeRegistry(home, {
      111: { path: t.path('old'), lastActive: 3000 },
      222: { path: t.path('new'), lastActive: 2000 },
    });
    assert.match((await client.call('codelens_search', { query: 'oldOnlySymbol' })).text, /oldOnlySymbol @ src\/old\.ts:1/);
    // A registered window without a DB is still a valid override.
    const res = await client.call('codelens_status', { workspace: t.path('new') });
    assert.equal(res.isError, false);
    assert.equal(filesIndexed(res.text), 0);
  });

  it('skips registry entries without a path; an unreadable registry falls back to cwd', async () => {
    fs.writeFileSync(`${home}/.codelens/active-workspaces.json`, JSON.stringify({ windows: {
      1: { lastActive: 9999 }, 2: { path: t.path('old'), lastActive: 5 },
    } }));
    assert.match((await client.call('codelens_search', { query: 'oldOnlySymbol' })).text, /oldOnlySymbol @/);
    // Unreadable registry: falls back to the working directory.
    fs.writeFileSync(`${home}/.codelens/active-workspaces.json`, '{ not json');
    const res = await client.call('codelens_status');
    assert.equal(res.isError, false);
    assert.ok(t.exists('elsewhere/.codelens/mcp-usage.jsonl'));
  });
});

describe('explicit workspace argument', { timeout: 120000 }, () => {
  const t = new TempDir();
  let client: McpClient;
  let home: string;

  before(async () => {
    t.write('proj/src/a.ts', 'export function projFn() { return 1; }\n');
    t.write('proj/src/b.ts', "import { projFn } from './a';\nexport function useProj() { return projFn(); }\n");
    t.write('other/src/o.ts', 'export function otherFn() { return 3; }\n');
    await buildIndex(t.path('other'));
    home = t.mkdir('home');
    client = await McpClient.start({ arg: t.path('proj'), cwd: t.mkdir('elsewhere'), home });
  });

  after(async () => {
    await client?.close();
    t.cleanup();
  });

  it('indexes and serves the given workspace when no VS Code window is registered', async () => {
    await client.waitForIndex(t.path('proj'), 2);
    assert.match((await client.call('codelens_relations', { symbol: 'projFn', direction: 'callers' })).text, /useProj @ src\/b\.ts:2/);
    assert.match(client.stderr.join(''), /starting background index/);
    assert.ok(!t.exists('elsewhere/.codelens'));
  });

  it('keeps serving the given workspace when a VS Code window for another folder registers',
    { todo: 'BUG: resolveActiveWorkspace (mcpServer.ts:166-194) consults the registry and cwd before the explicit start() path, so <workspace-path> is ignored' }, async () => {
      writeRegistry(home, { 1: { path: t.path('other'), lastActive: Date.now() } });
      const { text } = await client.call('codelens_search', { query: 'projFn' });
      assert.match(text, /projFn @ src\/a\.ts:1/);
    });
});

describe('index scope from .vscode/settings.json', { timeout: 120000 }, () => {
  const t = new TempDir();
  const clients: McpClient[] = [];

  after(async () => {
    await Promise.all(clients.map(c => c.close()));
    t.cleanup();
  });

  it('honors codeLensGraph.includeFolders, written with comments and trailing commas', async () => {
    t.write('inc/.vscode/settings.json', [
      '{',
      '  // Index only src',
      '  "codeLensGraph.includeFolders": [',
      '    "src", /* selected in the Indexed Folders view */',
      '  ],',
      '  "editor.someUrl": "http://example.com//not-a-comment",',
      '  "files.someGlob": "**/*.ts",',
      '}',
    ].join('\n'));
    t.write('inc/src/keep.ts', 'export function keptFn() { return 1; }\n');
    t.write('inc/other/skip.ts', 'export function skippedFn() { return 2; }\n');
    t.write('inc/index.ts', 'export function rootFn() { return 3; }\n');
    const client = await McpClient.start({ arg: t.path('inc'), cwd: t.path('inc'), home: t.mkdir('home-inc') });
    clients.push(client);

    await client.waitForIndex(t.path('inc'), 2);
    const files = (await client.call('codelens_files')).text;
    assert.match(files, /^## Workspace \(2 files/);
    assert.ok(files.includes('src/keep.ts') && files.includes('index.ts'), files);
    assert.ok(!files.includes('skip.ts'), files);
    assert.match((await client.call('codelens_search', { query: 'skippedFn' })).text, /^No symbols found/);
  });

  it('honors codeLensGraph.largeWorkspaceThreshold: too many files means no index until folders are chosen', async () => {
    t.write('big/.vscode/settings.json', '{\n  "codeLensGraph.largeWorkspaceThreshold": 2, // tiny, for the test\n}\n');
    t.write('big/a.ts', 'export const a = 1;\n');
    t.write('big/lib/b.ts', 'export const b = 2;\n');
    t.write('big/lib/c.ts', 'export const c = 3;\n');
    const client = await McpClient.start({ arg: t.path('big'), cwd: t.path('big'), home: t.mkdir('home-big') });
    clients.push(client);

    const status = await client.waitFor('codelens_status', {}, text => text.includes('Not indexed yet'));
    assert.match(status, /this workspace has 3 indexable files, above the large-workspace threshold/);
    assert.match(status, /codeLensGraph\.includeFolders/);
    assert.match((await client.call('codelens_triage', { task: 'add a feature' })).text, /Graph: 0 symbols · 0 files indexed/);
    assert.ok(!t.exists('big/.codelens/codelens-graph.db'));
  });
});

describe('workspace turned off by the user', { timeout: 120000 }, () => {
  const t = new TempDir();
  const clients: McpClient[] = [];
  let home: string;

  const ARGS: Record<string, Record<string, unknown>> = {
    codelens_triage: { task: 'x' }, codelens_search: { query: 'offFn' }, codelens_context: { task: 'x' },
    codelens_relations: { symbol: 'offFn' }, codelens_impact: { symbol: 'offFn' }, codelens_node: { symbol: 'offFn' },
    codelens_files: {}, codelens_dependencies: {}, codelens_status: {}, codelens_text_search: { query: 'offFn' },
    codelens_clear_config: {},
  };

  before(() => {
    t.write('off/src/a.ts', 'export function offFn() { return 1; }\n');
    t.write('off/.vscode/mcp.json', JSON.stringify({ servers: { codelens: { command: 'node' } } }));
    t.write('on/src/b.ts', 'export function onFn() { return 1; }\n');
    home = t.mkdir('home');
    // The opt-out list matches case-insensitively on Windows.
    const listed = process.platform === 'win32' ? t.path('off').toUpperCase() : t.path('off');
    writeDisabled(home, [listed]);
  });

  after(async () => {
    await Promise.all(clients.map(c => c.close()));
    t.cleanup();
  });

  it('answers "turned off" for every tool and writes nothing to the workspace', async () => {
    const client = await McpClient.start({ arg: t.path('off'), cwd: t.path('off'), home });
    clients.push(client);
    const tools = await client.listTools();
    assert.equal(tools.length, Object.keys(ARGS).length);
    for (const tool of tools) {
      const res = await client.call(tool.name, ARGS[tool.name]);
      assert.equal(res.isError, false, tool.name);
      assert.match(res.text, /^CodeLens Graph is turned off for .*off, so it has no graph for this workspace\./i, tool.name);
    }
    assert.ok(!t.exists('off/.codelens'), 'no .codelens created');
    assert.ok(fs.readFileSync(t.path('off/.vscode/mcp.json'), 'utf-8').includes('codelens'), 'clear_config did not run');
    assert.match(client.stderr.join(''), /turned off/);
  });

  it('--auto from a subfolder of a turned-off workspace answers "turned off" even when another window is active', async () => {
    writeRegistry(home, { 7: { path: t.path('on'), lastActive: Date.now() } });
    const client = await McpClient.start({ arg: '--auto', cwd: t.path('off/src'), home });
    clients.push(client);
    assert.match((await client.call('codelens_status')).text, /^CodeLens Graph is turned off for /);
    assert.match((await client.call('codelens_search', { query: 'onFn' })).text, /turned off/);
    assert.ok(!t.exists('off/.codelens'));
    assert.ok(!t.exists('on/.codelens'), 'the other window was not touched');
  });
});
