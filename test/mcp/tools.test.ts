import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { McpClient, TempDir, filesIndexed } from './_client';

// Contract tests: every tool's happy path, through a real server process
// indexing a small multi-file workspace in the background.

const EXPECTED_TOOLS: Record<string, string[]> = {
  codelens_triage:       ['task'],
  codelens_search:       ['query'],
  codelens_context:      ['task'],
  codelens_relations:    ['symbol'],
  codelens_impact:       ['symbol'],
  codelens_node:         ['symbol'],
  codelens_files:        [],
  codelens_dependencies: [],
  codelens_status:       [],
  codelens_text_search:  ['query'],
  codelens_clear_config: [],
};

function writeFixture(t: TempDir): void {
  t.write('ws/package.json', JSON.stringify({
    name: 'fixture', version: '1.0.0',
    dependencies: { fakepkg: '^1.2.0' },
    devDependencies: { 'missing-pkg': '^2.0.0' },
  }, null, 2));
  t.write('ws/node_modules/fakepkg/package.json', JSON.stringify({ name: 'fakepkg', version: '1.2.3', types: 'index.d.ts', main: 'index.js' }));
  t.write('ws/node_modules/fakepkg/index.d.ts', [
    'export declare function fakeHelper(x: number): string;',
    'export interface FakeOptions { verbose: boolean }',
    'export type FakeId = string;',
    '',
  ].join('\n'));
  t.write('ws/node_modules/fakepkg/index.js', 'exports.fakeHelper = x => String(x);\n');
  t.write('ws/node_modules/fakepkg/README.md', '# fakepkg\n');

  t.write('ws/src/math.ts', [
    'export function add(a: number, b: number): number {',
    '  return a + b;',
    '}',
    '',
    'export function multiply(a: number, b: number): number {',
    '  let r = 0;',
    '  for (let i = 0; i < b; i++) { r = add(r, a); }',
    '  return r;',
    '}',
    '',
  ].join('\n'));
  t.write('ws/src/calculator.ts', [
    "import { add, multiply } from './math';",
    "import { fakeHelper } from 'fakepkg';",
    '',
    '// TODO: handle overflow in compute',
    'const ERROR_MESSAGE = "division by zero is not allowed";',
    '',
    'export class Calculator {',
    '  total = 0;',
    '  compute(x: number): string {',
    '    this.total = multiply(add(x, 1), 2);',
    '    return fakeHelper(this.total);',
    '  }',
    '}',
    '',
  ].join('\n'));
  t.write('ws/src/app.ts', [
    "import { Calculator } from './calculator';",
    '',
    'export function runApp(): string {',
    '  const c = new Calculator();',
    '  return c.compute(3);',
    '}',
    '',
  ].join('\n'));
  t.write('ws/lib/legacy.js', [
    'function legacyGreet(name) {',
    "  return 'hi ' + name;",
    '}',
    'module.exports = { legacyGreet };',
    '',
  ].join('\n'));
}

describe('MCP server tools (contract)', { timeout: 120000 }, () => {
  const t = new TempDir();
  let ws: string;
  let client: McpClient;

  before(async () => {
    writeFixture(t);
    ws = t.path('ws');
    client = await McpClient.start({ arg: ws, cwd: ws, home: t.mkdir('home') });
    await client.waitForIndex(ws, 4);
    // The dependency manifest is stored right after the scan's final write.
    await client.waitFor('codelens_dependencies', {}, text => text.includes('fakepkg@1.2.3'));
  });

  after(async () => {
    await client?.close();
    t.cleanup();
  });

  it('tools/list returns all 11 tools, each with a description and an object schema', async () => {
    const tools = await client.listTools();
    assert.deepStrictEqual(tools.map(tool => tool.name).sort(), Object.keys(EXPECTED_TOOLS).sort());
    for (const tool of tools) {
      assert.ok(tool.description && tool.description.length > 20, tool.name + ' has a description');
      assert.equal(tool.inputSchema.type, 'object', tool.name);
      assert.ok(tool.inputSchema.properties.workspace, tool.name + ' accepts a workspace override');
      assert.deepStrictEqual([...(tool.inputSchema.required ?? [])].sort(), EXPECTED_TOOLS[tool.name].sort(), tool.name + ' required args');
    }
    const search = tools.find(tool => tool.name === 'codelens_search')!;
    assert.deepStrictEqual(search.inputSchema.properties.scope.enum, ['workspace', 'deps', 'all']);
  });

  it('a tool call with a missing required argument is an error, not a crash', async () => {
    const res = await client.call('codelens_search', {});
    assert.equal(res.isError, true);
    assert.match((await client.call('codelens_status')).text, /Files indexed: 4/);
  });

  describe('codelens_triage', () => {
    const cases: Array<[string, RegExp, RegExp]> = [
      ['fix typo in comment',            /Tier 1 — Local edit/,         /No CodeLens call needed/],
      ['where is the add function',      /Tier 2 — Search & Lookup/,    /→ Next: codelens_search$/m],
      ['find the error message text',    /Tier 2 — Search & Lookup/,    /→ Next: codelens_text_search/],
      ['refactor add everywhere',        /Tier 4 — Cross-file refactor/, /→ Next: codelens_context \+ codelens_impact/],
      ['add caching to the calculator',  /Tier 3 — Feature \/ bug fix/,  /→ Next: codelens_context$/m],
    ];
    for (const [task, tier, next] of cases) {
      it(`classifies "${task}"`, async () => {
        const { text, isError } = await client.call('codelens_triage', { task });
        assert.equal(isError, false);
        assert.match(text, tier);
        assert.match(text, next);
        assert.ok(text.includes('Task: "' + task + '"'));
        assert.match(text, /Graph: 14 symbols · 4 files indexed/);
      });
    }
  });

  describe('codelens_search', () => {
    it('finds a definition with file:line and signature (workspace scope by default)', async () => {
      const { text } = await client.call('codelens_search', { query: 'multiply' });
      assert.match(text, /inside scope workspace/);
      assert.match(text, /\[function\] multiply @ src\/math\.ts:5 {2}-> {2}function multiply\(a: number, b: number\): number/);
    });

    it('honors limit', async () => {
      const { text } = await client.call('codelens_search', { query: 'add', limit: 1 });
      assert.match(text, /^Found 1 symbol\(s\)/);
    });

    it('scope "deps" lists matching dependencies; "workspace" does not', async () => {
      const deps = await client.call('codelens_search', { query: 'fakepkg', scope: 'deps' });
      assert.match(deps.text, /Matching dependencies:\n {2}- fakepkg@1\.2\.3/);
      const all = await client.call('codelens_search', { query: 'missing', scope: 'all' });
      assert.match(all.text, /missing-pkg@\^2\.0\.0 \(not installed\)/);
      const wsScope = await client.call('codelens_search', { query: 'fakepkg' });
      assert.ok(!wsScope.text.includes('Matching dependencies'), wsScope.text);
    });

    it('scope "deps" finds config files such as package.json but "workspace" excludes them', async () => {
      const deps = await client.call('codelens_search', { query: 'package.json', scope: 'deps' });
      assert.match(deps.text, /@ package\.json:/);
      const wsScope = await client.call('codelens_search', { query: 'package.json' });
      assert.ok(!/@ package\.json:/.test(wsScope.text), wsScope.text);
    });

    it('reports an empty result as safe to create, with a deps hint for deps/all scopes', async () => {
      const none = await client.call('codelens_search', { query: 'zzzNothingHere' });
      assert.equal(none.text, 'No symbols found matching "zzzNothingHere" within scope workspace. Safe to create.');
      const noneAll = await client.call('codelens_search', { query: 'zzzNothingHere', scope: 'all' });
      assert.match(noneAll.text, /within scope all\./);
      assert.match(noneAll.text, /Dependency symbols are not indexed; use codelens_dependencies/);
      assert.match(noneAll.text, /Safe to create\.$/);
    });
  });

  describe('codelens_context', () => {
    it('short mode maps relevant symbols with locations and relationships, without snippets', async () => {
      const { text } = await client.call('codelens_context', { task: 'change how Calculator compute works' });
      assert.match(text, /^## CodeLens Context: "change how Calculator compute works" \(short mode\)/);
      assert.match(text, /Symbols: \d+ \| ~\d+ tokens/);
      assert.match(text, /\[class\] `Calculator`/);
      assert.match(text, /src\/calculator\.ts:7/);
      assert.match(text, /\*\*Calls:\*\* multiply, add/);
      assert.ok(!text.includes('**Snippet:**'), 'short mode has no snippets');
    });

    it('deep mode includes implementation snippets', async () => {
      const { text } = await client.call('codelens_context', { task: 'change how Calculator compute works', mode: 'deep' });
      assert.match(text, /\(deep mode\)/);
      assert.match(text, /\*\*Snippet:\*\*/);
      assert.ok(text.includes('this.total = multiply(add(x, 1), 2);'), text);
    });

    it('max_tokens bounds the estimate', async () => {
      const small = await client.call('codelens_context', { task: 'change how Calculator compute works', mode: 'deep', max_tokens: 200 });
      const big = await client.call('codelens_context', { task: 'change how Calculator compute works', mode: 'deep' });
      const est = (text: string) => Number(/~(\d+) tokens/.exec(text)![1]);
      assert.ok(est(small.text) < est(big.text), `${est(small.text)} < ${est(big.text)}`);
    });
  });

  describe('codelens_node', () => {
    it('returns signature, params, return type, caller count and an ES import hint without a snippet by default', async () => {
      const { text } = await client.call('codelens_node', { symbol: 'add' });
      assert.match(text, /^## \[function\] add\n- File: src\/math\.ts:1\n/);
      assert.match(text, /- Signature: function add\(a: number, b: number\): number \{/);
      assert.match(text, /- Params: a: number, b: number/);
      assert.match(text, /- Returns: : number/);
      assert.match(text, /- Import as: import \{ add \} from '\.\/src\/math'; \(path from workspace root\)/);
      assert.match(text, /- Callers: 2 \(run codelens_relations/);
      assert.ok(!text.includes('```'), 'no snippet unless asked');
    });

    it('with_snippet=true includes the body', async () => {
      const { text } = await client.call('codelens_node', { symbol: 'add', with_snippet: true });
      assert.ok(text.includes('```typescript\nexport function add(a: number, b: number): number {\n  return a + b;\n}\n```'), text);
    });

    it('uses a require() import hint for a CommonJS file', async () => {
      const { text } = await client.call('codelens_node', { symbol: 'legacyGreet' });
      assert.match(text, /- Import as: const \{ legacyGreet \} = require\('\.\/lib\/legacy'\);/);
    });

    it('filePath narrows by suffix; a non-matching filePath reports not found', async () => {
      const hit = await client.call('codelens_node', { symbol: 'multiply', filePath: 'src/math.ts' });
      assert.match(hit.text, /File: src\/math\.ts:5/);
      const miss = await client.call('codelens_node', { symbol: 'multiply', filePath: 'other.ts' });
      assert.equal(miss.text, '"multiply" not found inside file matching other.ts.');
      const unknown = await client.call('codelens_node', { symbol: 'doesNotExist' });
      assert.equal(unknown.text, '"doesNotExist" not found.');
    });

    it('does not suggest importing a class method as a module export',
      { todo: 'BUG: buildImportStmt (mcpServer.ts:1061-1064) emits "import { compute } from ..." for a method' }, async () => {
        const { text } = await client.call('codelens_node', { symbol: 'compute' });
        assert.match(text, /^## \[method\] compute/);
        assert.ok(!text.includes('import { compute }'), text);
      });
  });

  describe('codelens_relations', () => {
    it('callers', async () => {
      const { text } = await client.call('codelens_relations', { symbol: 'add', direction: 'callers' });
      assert.match(text, /## Symbol: add @ src\/math\.ts:1/);
      assert.match(text, /### Callers \(Incoming\):\n {2}- \[method\] compute @ src\/calculator\.ts:9.*\n {2}- \[function\] multiply @ src\/math\.ts:5/);
      assert.ok(!text.includes('Callees'), text);
    });

    it('callees', async () => {
      const { text } = await client.call('codelens_relations', { symbol: 'compute', direction: 'callees' });
      assert.match(text, /### Callees \(Outgoing\):/);
      assert.match(text, /\[function\] multiply @ src\/math\.ts:5/);
      assert.match(text, /\[function\] add @ src\/math\.ts:1/);
      assert.ok(!text.includes('Callers'), text);
    });

    it('both (default), including the empty cases', async () => {
      const { text } = await client.call('codelens_relations', { symbol: 'runApp' });
      assert.match(text, /### Callers \(Incoming\):\n {2}No callers found in indexed codebase\./);
      assert.match(text, /### Callees \(Outgoing\):\n {2}- \[method\] compute/);
      const leaf = await client.call('codelens_relations', { symbol: 'add', direction: 'callees' });
      assert.match(leaf.text, /No outgoing calls found\./);
      const missing = await client.call('codelens_relations', { symbol: 'nope' });
      assert.equal(missing.text, '"nope" not found in graph.');
    });
  });

  describe('codelens_impact', () => {
    it('lists the transitive impact radius', async () => {
      const { text } = await client.call('codelens_impact', { symbol: 'add' });
      assert.match(text, /^## Impact: "add"\nDefinition: src\/math\.ts:1\nSignature: function add/);
      assert.match(text, /\d+ affected symbol\(s\):/);
      assert.match(text, /- \[method\] compute @ src\/calculator\.ts:9/);
      assert.match(text, /- \[function\] runApp @ src\/app\.ts:3/);
    });

    it('depth limits the radius, and an unknown symbol is reported', async () => {
      const count = (text: string) => Number(/(\d+) affected symbol/.exec(text)![1]);
      const shallow = await client.call('codelens_impact', { symbol: 'add', depth: 1 });
      const deep = await client.call('codelens_impact', { symbol: 'add', depth: 3 });
      assert.ok(count(shallow.text) < count(deep.text), shallow.text);
      assert.equal((await client.call('codelens_impact', { symbol: 'nope' })).text, '"nope" not found.');
    });
  });

  describe('codelens_files', () => {
    it('groups workspace files by category, excluding configs and node_modules', async () => {
      const { text } = await client.call('codelens_files');
      assert.match(text, /^## Workspace \(4 files, scope: workspace\)/);
      for (const f of ['src/app.ts', 'src/calculator.ts', 'src/math.ts', 'lib/legacy.js']) {
        assert.ok(text.includes('  - ' + f), f);
      }
      assert.ok(!text.includes('package.json') && !text.includes('node_modules'), text);
    });

    it('scope "deps" lists configs and dependencies', async () => {
      const { text } = await client.call('codelens_files', { scope: 'deps' });
      assert.match(text, /scope: deps/);
      assert.match(text, /### Dependencies \(2\) — see codelens_dependencies\n {2}- fakepkg@1\.2\.3\n {2}- missing-pkg@\^2\.0\.0/);
      assert.ok(text.includes('  - package.json'), text);
    });

    it('filter keeps only groups with a matching file or label', async () => {
      const { text } = await client.call('codelens_files', { filter: 'legacy' });
      assert.ok(text.includes('lib/legacy.js'), text);
      assert.ok(!text.includes('src/math.ts'), text);
    });
  });

  describe('codelens_text_search', () => {
    it('finds a literal string through the graph layer', async () => {
      const { text } = await client.call('codelens_text_search', { query: 'division by zero' });
      assert.match(text, /^## Text Search Results for "division by zero" \(1 matches\):/);
      assert.match(text, /### \[variable\] src\/calculator\.ts:5 \(graph\)/);
      assert.ok(text.includes('const ERROR_MESSAGE = "division by zero is not allowed";'));
    });

    it('supports regex queries', async () => {
      const { text } = await client.call('codelens_text_search', { query: 'div[a-z]+ by \\w+' });
      assert.match(text, /src\/calculator\.ts:5/);
      assert.ok(!text.includes('Regex not used'), text);
    });

    it('inComments restricts to comment lines', async () => {
      const { text } = await client.call('codelens_text_search', { query: 'TODO', inComments: true });
      assert.match(text, /### \[comment\] src\/calculator\.ts:4 \(database\)/);
      assert.ok(text.includes('// TODO: handle overflow in compute'));
      const notComment = await client.call('codelens_text_search', { query: 'ERROR_MESSAGE', inComments: true });
      assert.match(notComment.text, /^No matches found/);
    });

    it('fileFilter narrows by extension', async () => {
      const js = await client.call('codelens_text_search', { query: 'legacyGreet', fileFilter: '.js' });
      assert.match(js.text, /lib\/legacy\.js:1/);
      const ts = await client.call('codelens_text_search', { query: 'legacyGreet', fileFilter: '.ts' });
      assert.match(ts.text, /^No matches found/);
    });

    it('does not search inside node_modules', async () => {
      const { text } = await client.call('codelens_text_search', { query: 'fakeHelper = x' });
      assert.match(text, /^No matches found for "fakeHelper = x"\.\n\nGraph may be stale/);
    });

    it('reports an empty query', async () => {
      assert.equal((await client.call('codelens_text_search', { query: '   ' })).text, 'Empty search query.');
    });
  });

  describe('codelens_dependencies', () => {
    it('lists direct dependencies and configuration files', async () => {
      const { text } = await client.call('codelens_dependencies');
      assert.match(text, /### Direct dependencies \(2\):\n {2}- fakepkg@1\.2\.3\n {2}- missing-pkg@\^2\.0\.0 \(not installed\) \[devDependencies\]/);
      assert.match(text, /### Configurations:\n {2}- package\.json/);
    });

    it('info', async () => {
      const { text } = await client.call('codelens_dependencies', { packageName: 'fakepkg' });
      assert.equal(text, [
        '## Package: fakepkg',
        '',
        '- Installed version: 1.2.3',
        '- Declared: ^1.2.0 (dependencies) in package.json',
        '- Path: node_modules/fakepkg',
        '- Type definitions: node_modules/fakepkg/index.d.ts',
        '- Main entry: node_modules/fakepkg/index.js',
        '- Readme: node_modules/fakepkg/README.md',
      ].join('\n'));
    });

    for (const queryType of ['exports', 'types']) {
      it(queryType + ' reads the .d.ts entry on demand', async () => {
        const { text } = await client.call('codelens_dependencies', { packageName: 'fakepkg', queryType });
        assert.match(text, /Type definitions: node_modules\/fakepkg\/index\.d\.ts/);
        assert.match(text, / {2}- \[function\] fakeHelper @ line 1\n {2}- \[interface\] FakeOptions @ line 2\n {2}- \[type\] FakeId @ line 3/);
      });
    }

    it('dependents lists workspace files importing the package', async () => {
      const { text } = await client.call('codelens_dependencies', { packageName: 'fakepkg', queryType: 'dependents' });
      assert.match(text, /Workspace files importing this package \(1\):\n {2}- src\/calculator\.ts/);
      const none = await client.call('codelens_dependencies', { packageName: 'missing-pkg', queryType: 'dependents' });
      assert.match(none.text, /No indexed workspace files import "missing-pkg"\./);
    });

    it('handles a package that is not installed, and an unknown package with suggestions', async () => {
      const notInstalled = await client.call('codelens_dependencies', { packageName: 'missing-pkg', queryType: 'exports' });
      assert.match(notInstalled.text, /No type definitions found for this package \(it is not installed\)\./);
      const info = await client.call('codelens_dependencies', { packageName: 'MISSING-PKG' });
      assert.match(info.text, /- Installed version: not installed/);
      const unknown = await client.call('codelens_dependencies', { packageName: 'fake' });
      assert.equal(unknown.text, 'Package "fake" is not a direct dependency of this workspace. Similar: fakepkg');
    });
  });

  describe('codelens_status', () => {
    it('reports graph statistics', async () => {
      const { text } = await client.call('codelens_status');
      assert.equal(filesIndexed(text), 4);
      assert.match(text, /- Total symbols: 14/);
      assert.match(text, /- Relationships: \d+/);
      assert.match(text, /- Symbols with undefined refs: \d+/);
      assert.match(text, /- By type: .*function:4/);
    });

    it('accepts its own workspace as an explicit override', async () => {
      const res = await client.call('codelens_status', { workspace: ws });
      assert.equal(res.isError, false);
      assert.equal(filesIndexed(res.text), 4);
    });
  });

  describe('usage logging', () => {
    it('appends one JSONL entry per tool call under <workspace>/.codelens/', async () => {
      const logFile = t.path('ws/.codelens/mcp-usage.jsonl');
      const before = fs.readFileSync(logFile, 'utf-8').split('\n').filter(Boolean).length;
      const longTask = 'x'.repeat(300);
      const triage = await client.call('codelens_triage', { task: longTask });
      await client.call('codelens_search', { query: 'add', scope: 'all' });

      const entries = fs.readFileSync(logFile, 'utf-8').split('\n').filter(Boolean).map(l => JSON.parse(l));
      assert.equal(entries.length, before + 2);
      const [first, second] = entries.slice(-2);
      assert.equal(first.tool, 'codelens_triage');
      assert.equal(first.input.task, 'x'.repeat(200) + '…', 'long inputs are truncated');
      assert.equal(first.outputLen, triage.text.length);
      assert.equal(first.tokensEst, Math.ceil(triage.text.length / 4));
      assert.equal(typeof first.durationMs, 'number');
      assert.ok(!Number.isNaN(Date.parse(first.ts)));
      assert.equal(second.tool, 'codelens_search');
      assert.deepStrictEqual(second.input, { query: 'add', scope: 'all', limit: 10 });
      // One session id for the whole server run.
      assert.equal(new Set(entries.map(e => e.sessionId)).size, 1);
      // Every tool exercised above was logged.
      const logged = new Set(entries.map(e => e.tool));
      for (const name of Object.keys(EXPECTED_TOOLS).filter(n => n !== 'codelens_clear_config')) {
        assert.ok(logged.has(name), name + ' logged');
      }
    });
  });

  // Destructive: runs last in this file.
  describe('codelens_clear_config', () => {
    it('removes the CodeLens MCP entry and generated files but keeps user content', async () => {
      t.write('ws/.vscode/mcp.json', JSON.stringify({ servers: { codelens: { command: 'node' }, other: { command: 'x' } } }));
      t.write('ws/CLAUDE.md', '# Mine\n\n<!-- CODELENS_MANAGED_START -->\ngenerated\n<!-- CODELENS_MANAGED_END -->\n');
      const res = await client.call('codelens_clear_config');
      assert.equal(res.text, 'CodeLens Graph: Configurations and directories cleared successfully.');
      assert.deepStrictEqual(JSON.parse(fs.readFileSync(t.path('ws/.vscode/mcp.json'), 'utf-8')), { servers: { other: { command: 'x' } } });
      assert.equal(fs.readFileSync(t.path('ws/CLAUDE.md'), 'utf-8').trim(), '# Mine');
      assert.ok(t.exists('ws/src/math.ts'));
    });

    it('leaves no .codelens folder behind',
      { todo: 'BUG: the logging wrapper (mcpServer.ts:402) calls getWorkspaceContext after clear_config, recreating .codelens and re-indexing' }, async () => {
        await client.call('codelens_clear_config');
        assert.ok(!t.exists('ws/.codelens'), 'ws/.codelens should be gone after clear_config');
      });
  });
});
