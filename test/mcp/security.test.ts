import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { McpClient, TempDir, filesIndexed, linkDir, linkFile } from './_client';
import { emptyIndex, parser as sharedParser } from './_index';
import { GraphDB } from '../../src/graph/graphDB';
import { WorkspaceScanner } from '../../src/ingestion/workspaceScanner';
import { SCAN_OPTIONS } from '../helpers';

// The `workspace` argument and the graph DB are both untrusted: an agent can be
// prompt-injected, and a cloned repo can ship a pre-built .codelens/ DB whose
// paths point outside the workspace. These tests play both attackers.

const SECRET_DIRECT = 'TOP_SECRET_DIRECT_7f3a';
const SECRET_LINK = 'TOP_SECRET_LINK_91c2';
const SECRET_FILELINK = 'TOP_SECRET_FILELINK_55d0';
const SECRET_SCAN = 'TOP_SECRET_SCAN_e4b8';

// Pre-built index for <root>/ws: the workspace's own files are scanned
// normally, then nodes for files outside it (directly, or through a link
// inside it) are added the way a tampered DB would carry them.
async function buildTamperedIndex(t: TempDir, outsideFiles: string[]): Promise<void> {
  const parser = sharedParser();
  const db = new GraphDB(t.path('ws/.codelens'), { followExternalWrites: false });
  await db.init();
  await new WorkspaceScanner(parser, db).scanWorkspace({ workspaceRoot: t.path('ws'), folders: [] }, SCAN_OPTIONS);
  for (const file of outsideFiles) {
    const parsed = await parser.parseFileAsync(file);
    db.upsertNodes(parsed.nodes);
    db.upsertEdges(parsed.edges);
  }
  db.replacePackages([{
    name: 'evil-types', declaredRange: '^1.0.0', kind: 'dependencies',
    declaredIn: [t.path('ws/package.json')], installed: true, version: '1.0.0',
    dir: t.path('outside'), types: t.path('outside/evil.d.ts'), main: null, readme: null,
  }]);
  db.persist();
  db.close();
}

describe('MCP server security', { timeout: 120000 }, () => {
  const t = new TempDir();
  let client: McpClient;
  let dirLinked = false;
  let fileLinked = false;

  before(async () => {
    t.write('outside/secret.ts', `export function leakDirect() {\n  return "${SECRET_DIRECT}";\n}\n`);
    t.write('outside/linked/secret2.ts', `export function leakViaLink() {\n  return "${SECRET_LINK}";\n}\n`);
    t.write('outside/secret3.ts', `export function leakViaFileLink() {\n  return "${SECRET_FILELINK}";\n}\n`);
    t.write('outside/scan/secret4.ts', `export function leakViaScan() {\n  return "${SECRET_SCAN}";\n}\n`);
    t.write('outside/evil.d.ts', 'export declare const OUTSIDE_EXPORT_NAME: string;\n');

    t.write('ws/package.json', JSON.stringify({ name: 'ws', dependencies: { 'evil-types': '^1.0.0' } }));
    t.write('ws/src/app.ts', [
      'export function hello(): number {',
      '  return 1;',
      '}',
      'export const PAD = "' + 'a'.repeat(60) + '!";',
      '',
    ].join('\n'));

    dirLinked = linkDir(t.path('outside/linked'), t.path('ws/link'));
    fileLinked = linkFile(t.path('outside/secret3.ts'), t.path('ws/src/filelink.ts'));
    const outsideNodes = [t.path('outside/secret.ts')];
    if (dirLinked) { outsideNodes.push(t.path('ws/link/secret2.ts')); }
    if (fileLinked) { outsideNodes.push(t.path('ws/src/filelink.ts')); }
    await buildTamperedIndex(t, outsideNodes);

    // A second known workspace (empty DB, so the server indexes it) holding a
    // link to a directory outside it.
    t.write('known/src/k.ts', 'export function knownFn() { return 2; }\n');
    linkDir(t.path('outside/scan'), t.path('known/linked'));
    await emptyIndex(t.path('known'));

    // Directories that are not CodeLens workspaces.
    t.mkdir('unknown');
    t.write('victim/.codelens/keep.txt', 'not yours');
    t.write('victim/.vscode/mcp.json', JSON.stringify({ servers: { codelens: { command: 'node' } } }));

    client = await McpClient.start({ arg: t.path('ws'), cwd: t.path('ws'), home: t.mkdir('home') });
  });

  after(async () => {
    await client?.close();
    t.cleanup();
  });

  const leaks = (text: string) => [SECRET_DIRECT, SECRET_LINK, SECRET_FILELINK, SECRET_SCAN].filter(s => text.includes(s));

  describe('workspace override', () => {
    it('is rejected for a directory that is not a CodeLens workspace, for every tool', async () => {
      const unknown = t.path('unknown');
      const calls: Array<[string, Record<string, unknown>]> = [
        ['codelens_triage', { task: 'x' }], ['codelens_search', { query: 'x' }], ['codelens_context', { task: 'x' }],
        ['codelens_relations', { symbol: 'x' }], ['codelens_impact', { symbol: 'x' }], ['codelens_node', { symbol: 'x' }],
        ['codelens_files', {}], ['codelens_dependencies', {}], ['codelens_status', {}],
        ['codelens_text_search', { query: 'x' }], ['codelens_clear_config', {}],
      ];
      for (const [name, args] of calls) {
        const res = await client.call(name, { ...args, workspace: unknown });
        assert.equal(res.isError, true, name);
        assert.match(res.text, /Workspace override rejected: ".*unknown" is not a CodeLens workspace/, name);
      }
      assert.deepStrictEqual(fs.readdirSync(unknown), [], 'nothing was created in the unknown directory');
    });

    it('is rejected for a path that escapes via ".." to an unknown directory', async () => {
      const res = await client.call('codelens_status', { workspace: path.join(t.path('ws'), '..', 'unknown') });
      assert.equal(res.isError, true);
      assert.ok(!t.exists('unknown/.codelens'));
    });

    it('status on an unknown directory does not create .codelens there', async () => {
      const res = await client.call('codelens_status', { workspace: t.path('unknown') });
      assert.equal(res.isError, true);
      assert.ok(!t.exists('unknown/.codelens'));
    });

    it('clear_config cannot delete another directory\'s .codelens or MCP config', async () => {
      const res = await client.call('codelens_clear_config', { workspace: t.path('victim') });
      assert.equal(res.isError, true);
      assert.match(res.text, /Workspace override rejected/);
      assert.equal(fs.readFileSync(t.path('victim/.codelens/keep.txt'), 'utf-8'), 'not yours');
      assert.ok(fs.readFileSync(t.path('victim/.vscode/mcp.json'), 'utf-8').includes('codelens'));
    });

    it('rejected calls are not logged; the next accepted call is', async () => {
      // Every call so far in this file was rejected.
      await client.call('codelens_status');
      const entries = fs.readFileSync(t.path('ws/.codelens/mcp-usage.jsonl'), 'utf-8').split('\n').filter(Boolean).map(l => JSON.parse(l));
      assert.deepStrictEqual(entries.map(e => e.tool), ['codelens_status']);
    });

    it('is accepted for a directory with a CodeLens DB, which is then indexed', async () => {
      const known = t.path('known');
      const text = await client.waitForIndex(known, 1, known);
      assert.equal(filesIndexed(text), 1);
      const res = await client.call('codelens_search', { query: 'knownFn', workspace: known });
      assert.equal(res.isError, false);
      assert.match(res.text, /\[function\] knownFn @ src\/k\.ts:1/);
      // The default workspace is unaffected.
      assert.match((await client.call('codelens_search', { query: 'knownFn' })).text, /^No symbols found/);
    });
  });

  describe('never reads files outside the workspace', () => {
    it('the tampered index does list the outside symbols (precondition)', async () => {
      const { text } = await client.call('codelens_node', { symbol: 'leakDirect' });
      assert.match(text, /- File: \.\.\/outside\/secret\.ts:1/);
    });

    it('codelens_node with_snippet omits the body of a file outside the workspace', async () => {
      const { text } = await client.call('codelens_node', { symbol: 'leakDirect', with_snippet: true });
      assert.match(text, /## \[function\] leakDirect/);
      assert.ok(!text.includes('```'), text);
      assert.deepStrictEqual(leaks(text), []);
    });

    it('codelens_node with_snippet omits the body behind a directory link inside the workspace', async (ctx) => {
      if (!dirLinked) { ctx.skip('directory links are not available on this platform'); return; }
      const { text } = await client.call('codelens_node', { symbol: 'leakViaLink', with_snippet: true });
      assert.match(text, /- File: link\/secret2\.ts:1/);
      assert.deepStrictEqual(leaks(text), []);
    });

    it('codelens_node with_snippet omits the body behind a file symlink inside the workspace', async (ctx) => {
      if (!fileLinked) { ctx.skip('file symlinks need extra privileges on this platform'); return; }
      const { text } = await client.call('codelens_node', { symbol: 'leakViaFileLink', with_snippet: true });
      assert.match(text, /- File: src\/filelink\.ts:1/);
      assert.deepStrictEqual(leaks(text), []);
    });

    it('codelens_text_search does not read outside files to verify graph hits', async () => {
      for (const query of ['leakDirect', 'leakViaLink', 'leakViaFileLink', 'TOP_SECRET', 'return "TOP']) {
        const { text } = await client.call('codelens_text_search', { query });
        assert.deepStrictEqual(leaks(text), [], query);
        assert.match(text, /^No matches found/, query);
      }
    });

    it('codelens_context deep mode includes no outside snippets', async () => {
      const { text } = await client.call('codelens_context', { task: 'leakDirect leakViaLink leakViaFileLink', mode: 'deep' });
      assert.match(text, /`leakDirect`/);
      assert.deepStrictEqual(leaks(text), []);
    });

    it('background indexing does not follow a directory link out of the workspace', async () => {
      const known = t.path('known');
      for (const query of [SECRET_SCAN, 'leakViaScan']) {
        const res = await client.call('codelens_text_search', { query, workspace: known });
        assert.match(res.text, /^No matches found/, query);
      }
      const files = await client.call('codelens_files', { workspace: known });
      assert.ok(!files.text.includes('secret4'), files.text);
    });

    it('codelens_dependencies does not read type definitions outside the workspace',
      { todo: 'BUG: readDeclaredExports(pkg.types) at mcpServer.ts:760 has no isPathInside check; a pre-built DB can point it anywhere' }, async () => {
        const { text } = await client.call('codelens_dependencies', { packageName: 'evil-types', queryType: 'exports' });
        assert.ok(!text.includes('OUTSIDE_EXPORT_NAME'), text);
      });
  });

  describe('agent-supplied regex', () => {
    for (const query of ['(a+)+$', '^(a|aa)+$', '(a*)*b', '(\\w+\\s?)+$', 'a.*a.*a.*a.*!', '(a)\\1+']) {
      it(`backtracking-prone pattern ${query} returns promptly and the server stays responsive`, async () => {
        const t0 = Date.now();
        const res = await client.call('codelens_text_search', { query }, 5000);
        assert.ok(Date.now() - t0 < 3000, `took ${Date.now() - t0} ms`);
        assert.equal(res.isError, false);
        assert.match(res.text, /searched as literal text|Regex not used/);
        assert.equal(filesIndexed((await client.call('codelens_status')).text) >= 1, true);
      });
    }

    it('a safe regex still matches a long line', async () => {
      const { text } = await client.call('codelens_text_search', { query: 'PAD = "a+!' });
      assert.match(text, /src\/app\.ts:4/);
    });

    it('an invalid regex falls back to literal search instead of erroring', async () => {
      const res = await client.call('codelens_text_search', { query: 'hello(' });
      assert.equal(res.isError, false);
      assert.match(res.text, /^No matches found|Text Search Results/);
    });
  });
});
