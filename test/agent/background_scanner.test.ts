import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { BackgroundScanner } from '../../src/agent/backgroundScanner';
import { SkillGenerator } from '../../src/agent/skillGenerator';
import { IndexScope } from '../../src/ingestion/indexScope';
import { GraphStats } from '../../src/types';
import { TestWorkspace, SCAN_OPTIONS } from '../helpers';
import { FakeHome, read } from './sandbox';

// Lets queued promise work and setImmediate yields run without touching
// setTimeout (which is mocked in the skill-regeneration tests).
async function until(condition: () => boolean, maxTurns = 5000): Promise<void> {
  for (let i = 0; !condition(); i++) {
    if (i > maxTurns) { throw new Error('condition never became true'); }
    await new Promise<void>(resolve => setImmediate(resolve));
  }
}

describe('BackgroundScanner', () => {
  let home: FakeHome;
  let ws: TestWorkspace;
  let bg: BackgroundScanner;
  let scope: IndexScope;
  let selectedIdes: string[] | undefined;
  let statuses: string[];
  let completed: GraphStats[];
  let persists: number;
  let resolves: Array<{ files: string[]; symbols: string[] }>;
  let scans: number;

  beforeEach(() => {
    home = new FakeHome();
    ws = new TestWorkspace();
    mock.method(console, 'log', () => {});
    mock.method(console, 'error', () => {});
    mock.method(console, 'warn', () => {});
  });

  afterEach(async () => {
    bg?.dispose();
    await bg?.whenIdle();
    ws.close();
    home.restore();
    mock.restoreAll();
  });

  // Opens the index over the files written so far and wires a scanner with
  // spies on the DB writes it triggers.
  async function start(ides: string[] | undefined = undefined): Promise<void> {
    await ws.open();
    scope = { workspaceRoot: ws.root, folders: [] };
    selectedIdes = ides;
    statuses = [];
    completed = [];
    persists = 0;
    resolves = [];
    scans = 0;

    const persist = ws.db.persist.bind(ws.db);
    ws.db.persist = () => { persists++; persist(); };
    const resolve = ws.db.resolveWorkspaceRelationships.bind(ws.db);
    ws.db.resolveWorkspaceRelationships = async (files?: string | string[], symbols: string[] = []) => {
      resolves.push({ files: ([] as string[]).concat(files ?? []), symbols });
      return resolve(files, symbols);
    };
    const scanWorkspace = ws.scanner.scanWorkspace.bind(ws.scanner);
    ws.scanner.scanWorkspace = async (s, o) => { scans++; return scanWorkspace(s, o); };

    bg = new BackgroundScanner(ws.db, ws.scanner, new SkillGenerator(ws.db), () => selectedIdes);
    bg.onStatus(s => statuses.push(s));
    bg.onComplete(s => completed.push(s));
  }

  // Starts and runs the initial scan, then clears the recorded calls.
  async function startScanned(ides?: string[]): Promise<void> {
    await start(ides);
    bg.setAcceptingChanges(true);
    assert.ok(await bg.runFullScan(scope, SCAN_OPTIONS));
    await bg.whenIdle();
    statuses.length = 0;
    completed.length = 0;
    persists = 0;
    resolves.length = 0;
  }

  const indexed = () => ws.db.getAllFiles('all').map(f => path.relative(ws.root, f).split(path.sep).join('/')).sort();
  const hasSymbol = (name: string) => ws.db.searchNodes(name, 50, 'all').some(n => n.name === name && n.type !== 'import');
  const packageNames = () => ws.db.getPackages().map(p => p.name);

  describe('full scans', () => {
    it('indexes the workspace, reports scanning then ready, and hands back the stats', async () => {
      ws.write('src/a.ts', 'export function alpha() { return beta(); }\n');
      ws.write('src/b.ts', 'export function beta() { return 1; }\n');
      await start();

      const stats = await bg.runFullScan(scope, SCAN_OPTIONS);

      assert.ok(stats);
      assert.deepEqual(statuses, ['scanning', 'ready']);
      assert.deepEqual(completed, [stats]);
      assert.equal(bg.getLastStats(), stats);
      assert.equal(stats.fileCount, 2);
      assert.ok(stats.totalNodes >= 4);
      assert.ok(stats.lastBuilt > 0);
      assert.equal(typeof stats.buildDurationMs, 'number');
      assert.deepEqual(indexed(), ['src/a.ts', 'src/b.ts']);
      assert.ok(hasSymbol('alpha') && hasSymbol('beta'));
    });

    it('shares one queued scan between concurrent requests', async () => {
      ws.write('a.ts', 'export const a = 1;\n');
      await start();

      const first = bg.runFullScan(scope, SCAN_OPTIONS);
      const second = bg.runFullScan(scope, SCAN_OPTIONS);
      assert.equal(second, first);
      await Promise.all([first, second]);

      assert.equal(scans, 1);
      assert.deepEqual(statuses, ['scanning', 'ready']);
    });

    it('runs a forced scan separately, and a new scan once the previous one finished', async () => {
      ws.write('a.ts', 'export const a = 1;\n');
      await start();

      const first = bg.runFullScan(scope, SCAN_OPTIONS);
      const forced = bg.runFullScan(scope, { ...SCAN_OPTIONS, force: true });
      assert.notEqual(forced, first);
      await Promise.all([first, forced]);
      assert.equal(scans, 2);

      await bg.runFullScan(scope, SCAN_OPTIONS);
      assert.equal(scans, 3);
      assert.deepEqual(statuses, ['scanning', 'ready', 'scanning', 'ready', 'scanning', 'ready']);
    });

    it('reports an error and resolves null when the scan fails, without blocking later work', async () => {
      ws.write('a.ts', 'export const a = 1;\n');
      await start();
      const realScan = ws.scanner.scanWorkspace;
      ws.scanner.scanWorkspace = async () => { throw new Error('disk on fire'); };

      assert.equal(await bg.runFullScan(scope, SCAN_OPTIONS), null);
      assert.deepEqual(statuses, ['scanning', 'error']);
      assert.deepEqual(completed, []);
      assert.equal(bg.getLastStats(), null);

      ws.scanner.scanWorkspace = realScan;
      assert.ok(await bg.runFullScan(scope, SCAN_OPTIONS));
      assert.deepEqual(statuses.slice(2), ['scanning', 'ready']);
    });

    it('runs queued work one job at a time', async () => {
      ws.write('package.json', JSON.stringify({ dependencies: { 'left-pad': '^1.0.0' } }));
      await start();
      const events: string[] = [];
      const scanWorkspace = ws.scanner.scanWorkspace;
      ws.scanner.scanWorkspace = async (s, o) => {
        events.push('scan:start');
        const result = await scanWorkspace(s, o);
        events.push('scan:end');
        return result;
      };
      const replacePackages = ws.db.replacePackages.bind(ws.db);
      ws.db.replacePackages = packages => { events.push('manifest'); return replacePackages(packages); };

      const scan = bg.runFullScan(scope, SCAN_OPTIONS);
      const refresh = bg.refreshDependencies(ws.root);
      await Promise.all([scan, refresh]);

      assert.deepEqual(events, ['scan:start', 'scan:end', 'manifest', 'manifest']);
    });

    it('counts the files a scan would index without parsing anything', async () => {
      ws.write('src/a.ts', 'export const a = 1;\n');
      ws.write('src/nested/b.py', 'def b():\n    pass\n');
      ws.write('lib/c.js', 'module.exports = 1;\n');
      ws.write('top.ts', 'export const top = 1;\n');
      ws.write('notes.txt', 'not code');
      ws.write('node_modules/dep/index.js', 'module.exports = 1;\n');
      await start();

      assert.equal(await bg.countIndexableFiles(scope, SCAN_OPTIONS), 4);
      // Selected folders plus the files directly in the workspace root.
      assert.equal(await bg.countIndexableFiles({ workspaceRoot: ws.root, folders: ['src'] }, SCAN_OPTIONS), 3);
      assert.deepEqual(indexed(), []);
    });
  });

  describe('skill files after a scan', () => {
    const agentFiles = ['CLAUDE.md', '.cursor/rules/codelens.mdc', '.vscode/mcp.json', '.agents/AGENTS.md', '.windsurfrules'];

    it('writes only .codelens/ files until the user has chosen which agents to configure', async () => {
      ws.write('a.ts', 'export const a = 1;\n');
      await start(undefined);
      await bg.runFullScan(scope, SCAN_OPTIONS);

      for (const rel of ['.codelens/README.md', '.codelens/mcp.json', '.codelens/instructions.md', '.codelens/.gitignore']) {
        assert.ok(fs.existsSync(ws.path(rel)), rel);
      }
      for (const rel of agentFiles) { assert.equal(fs.existsSync(ws.path(rel)), false, rel); }
      assert.deepEqual(fs.readdirSync(ws.root).sort(), ['.codelens', 'a.ts']);
    });

    it('writes the selected agents\' files, and removes them once deselected', async () => {
      ws.write('a.ts', 'export const a = 1;\n');
      await start(['Claude', 'cursor']);
      await bg.runFullScan(scope, SCAN_OPTIONS);
      assert.ok(fs.existsSync(ws.path('CLAUDE.md')));
      assert.ok(fs.existsSync(ws.path('.cursor/rules/codelens.mdc')));
      assert.equal(fs.existsSync(ws.path('.vscode/mcp.json')), false);

      selectedIdes = [];
      await bg.runFullScan(scope, SCAN_OPTIONS);
      for (const rel of agentFiles) { assert.equal(fs.existsSync(ws.path(rel)), false, rel); }
    });

    it('instructions.md reflects the scanned graph', async () => {
      ws.write('a.ts', 'export function one() {}\nexport function two() {}\n');
      await start();
      const stats = await bg.runFullScan(scope, SCAN_OPTIONS);
      assert.ok(stats);
      assert.ok(read(ws.path('.codelens/instructions.md'))
        .includes(`**${stats.totalNodes} symbols** across **${stats.fileCount} files**`));
    });

    it('a failure while writing skills does not fail the scan', async () => {
      ws.write('a.ts', 'export const a = 1;\n');
      await start();
      bg = new BackgroundScanner(ws.db, ws.scanner, new SkillGenerator(ws.db), () => { throw new Error('no state'); });
      bg.onStatus(s => statuses.push(s));

      assert.ok(await bg.runFullScan(scope, SCAN_OPTIONS));
      assert.deepEqual(statuses, ['scanning', 'ready']);
      assert.equal(fs.existsSync(ws.path('.codelens/instructions.md')), false);
    });
  });

  describe('dependency manifest', () => {
    it('a full scan stores the direct dependencies of package.json', async () => {
      ws.write('package.json', JSON.stringify({ dependencies: { 'left-pad': '^1.0.0' }, devDependencies: { typescript: '^5.0.0' } }));
      await start();
      await bg.runFullScan(scope, SCAN_OPTIONS);
      assert.deepEqual(packageNames(), ['left-pad', 'typescript']);
    });

    it('refreshDependencies picks up manifest edits and persists only when something changed', async () => {
      ws.write('package.json', JSON.stringify({ dependencies: { 'left-pad': '^1.0.0' } }));
      ws.write('packages/web/package.json', JSON.stringify({ dependencies: { react: '^18.0.0' } }));
      ws.write('node_modules/left-pad/package.json', JSON.stringify({ name: 'left-pad', version: '1.3.0', dependencies: { ignored: '1' } }));
      await startScanned();
      assert.deepEqual(packageNames(), ['left-pad', 'react']);
      assert.equal(ws.db.getPackages().find(p => p.name === 'left-pad')?.version, '1.3.0');

      ws.write('package.json', JSON.stringify({ dependencies: { 'left-pad': '^1.0.0', lodash: '^4.0.0' } }));
      await bg.refreshDependencies(ws.root);
      assert.deepEqual(packageNames(), ['left-pad', 'lodash', 'react']);
      assert.equal(persists, 1);

      await bg.refreshDependencies(ws.root);
      assert.equal(persists, 1, 'unchanged manifest is not written again');
    });

    it('a failed refresh is logged and does not block the queue', async () => {
      ws.write('package.json', JSON.stringify({ dependencies: { 'left-pad': '^1.0.0' } }));
      await startScanned();
      const replacePackages = ws.db.replacePackages;
      ws.db.replacePackages = () => { throw new Error('locked'); };

      await assert.doesNotReject(bg.refreshDependencies(ws.root));
      ws.db.replacePackages = replacePackages;
      assert.ok(await bg.runFullScan(scope, SCAN_OPTIONS));
    });
  });

  describe('file-change events', () => {
    it('applies a burst of changes as one batch: one resolve and one write', async () => {
      ws.write('src/a.ts', 'export function alpha() {}\n');
      ws.write('src/b.ts', 'export function beta() {}\n');
      await startScanned();

      ws.write('src/a.ts', 'export function alpha() {}\nexport function alphaTwo() {}\n');
      ws.write('src/b.ts', 'export function betaRenamed() {}\n');
      ws.write('src/c.ts', 'export function gamma() { return alphaTwo(); }\n');
      for (const rel of ['src/a.ts', 'src/b.ts', 'src/c.ts']) { bg.queueFileChange(ws.path(rel), 'change', ws.root); }
      await bg.whenIdle();

      assert.equal(resolves.length, 1);
      assert.equal(persists, 1);
      assert.deepEqual(resolves[0].files.map(f => path.basename(f)).sort(), ['a.ts', 'b.ts', 'c.ts']);
      for (const symbol of ['alphaTwo', 'beta', 'betaRenamed', 'gamma']) {
        assert.ok(resolves[0].symbols.includes(symbol), `${symbol} in affected symbols`);
      }
      assert.deepEqual(statuses, ['updating', 'ready']);
      assert.ok(hasSymbol('alphaTwo') && hasSymbol('betaRenamed') && hasSymbol('gamma'));
      assert.equal(hasSymbol('beta'), false);
    });

    it('the latest event for a path wins', async () => {
      ws.write('src/a.ts', 'export function alpha() {}\n');
      await startScanned();

      bg.queueFileChange(ws.path('src/a.ts'), 'change', ws.root);
      bg.queueFileChange(ws.path('src/a.ts'), 'delete', ws.root);
      await bg.whenIdle();

      assert.deepEqual(indexed(), []);
      assert.equal(resolves.length, 1);
    });

    it('a change event for a file that is gone removes it', async () => {
      ws.write('src/a.ts', 'export function alpha() {}\n');
      ws.write('src/b.ts', 'export function beta() {}\n');
      await startScanned();

      fs.rmSync(ws.path('src/a.ts'));
      bg.queueFileChange(ws.path('src/a.ts'), 'change', ws.root);
      await bg.whenIdle();

      assert.deepEqual(indexed(), ['src/b.ts']);
      assert.equal(hasSymbol('alpha'), false);
    });

    it('deleting something that was never indexed changes nothing and announces nothing', async () => {
      ws.write('src/a.ts', 'export function alpha() {}\n');
      await startScanned();

      bg.queueFileChange(ws.path('dist/out.js'), 'delete', ws.root);
      bg.queueFileChange(ws.path('dist'), 'delete', ws.root);
      await bg.whenIdle();

      assert.deepEqual(statuses, []);
      assert.equal(persists, 0);
      assert.equal(resolves.length, 0);
      assert.deepEqual(indexed(), ['src/a.ts']);
    });

    it('one delete event for a folder removes every indexed file under it', async () => {
      ws.write('src/lib/a.ts', 'export function alpha() {}\n');
      ws.write('src/lib/deep/b.ts', 'export function beta() {}\n');
      ws.write('src/library/c.ts', 'export function gamma() {}\n');
      await startScanned();

      fs.rmSync(ws.path('src/lib'), { recursive: true });
      bg.queueFileChange(ws.path('src/lib'), 'delete', ws.root);
      await bg.whenIdle();

      assert.deepEqual(indexed(), ['src/library/c.ts']);
      assert.equal(persists, 1);
      assert.deepEqual(statuses, ['updating', 'ready']);
      assert.ok(resolves[0].symbols.includes('alpha') && resolves[0].symbols.includes('beta'));
    });

    it('a folder path with a trailing separator works too', async () => {
      ws.write('src/lib/a.ts', 'export function alpha() {}\n');
      ws.write('other.ts', 'export const o = 1;\n');
      await startScanned();

      fs.rmSync(ws.path('src/lib'), { recursive: true });
      bg.queueFileChange(ws.path('src/lib') + path.sep, 'delete', ws.root);
      await bg.whenIdle();
      assert.deepEqual(indexed(), ['other.ts']);
    });

    it('matches deleted paths case-insensitively on Windows', { skip: process.platform !== 'win32' && 'Windows-only path semantics' }, async () => {
      ws.write('src/Lib/a.ts', 'export function alpha() {}\n');
      ws.write('src/Keep.ts', 'export function keep() {}\n');
      await startScanned();

      fs.rmSync(ws.path('src/Lib'), { recursive: true });
      bg.queueFileChange(ws.path('src/Lib').toUpperCase(), 'delete', ws.root);
      bg.queueFileChange(ws.path('src/keep.TS'), 'delete', ws.root);
      await bg.whenIdle();
      assert.deepEqual(indexed(), []);
    });

    it('matches deleted paths case-sensitively elsewhere', { skip: process.platform === 'win32' && 'POSIX-only path semantics' }, async () => {
      ws.write('src/Lib/a.ts', 'export function alpha() {}\n');
      await startScanned();

      bg.queueFileChange(ws.path('src/lib'), 'delete', ws.root);
      await bg.whenIdle();
      assert.deepEqual(indexed(), ['src/Lib/a.ts']);
    });

    it('ignores events until changes are accepted', async () => {
      ws.write('src/a.ts', 'export function alpha() {}\n');
      await start();
      await bg.runFullScan(scope, SCAN_OPTIONS);
      statuses.length = 0;
      persists = 0;

      ws.write('src/a.ts', 'export function alphaChanged() {}\n');
      bg.queueFileChange(ws.path('src/a.ts'), 'change', ws.root);
      await bg.whenIdle();

      assert.equal(hasSymbol('alphaChanged'), false);
      assert.deepEqual(statuses, []);
      assert.equal(persists, 0);
    });

    it('turning changes off drops the batch that was waiting', async () => {
      ws.write('src/a.ts', 'export function alpha() {}\n');
      await startScanned();

      ws.write('src/a.ts', 'export function alphaChanged() {}\n');
      bg.queueFileChange(ws.path('src/a.ts'), 'change', ws.root);
      bg.setAcceptingChanges(false);
      await bg.whenIdle();

      assert.equal(hasSymbol('alphaChanged'), false);
      assert.equal(persists, 0);

      bg.setAcceptingChanges(true);
      bg.queueFileChange(ws.path('src/a.ts'), 'change', ws.root);
      await bg.whenIdle();
      assert.ok(hasSymbol('alphaChanged'));
    });

    it('keeps applying the rest of a batch when one file fails', async () => {
      ws.write('src/a.ts', 'export function alpha() {}\n');
      ws.write('src/b.ts', 'export function beta() {}\n');
      await startScanned();
      const updateFile = ws.scanner.updateFile.bind(ws.scanner);
      ws.scanner.updateFile = async (filePath, resolve) => {
        if (filePath.endsWith('a.ts')) { throw new Error('parse exploded'); }
        return updateFile(filePath, resolve);
      };

      ws.write('src/b.ts', 'export function betaTwo() {}\n');
      bg.queueFileChange(ws.path('src/a.ts'), 'change', ws.root);
      bg.queueFileChange(ws.path('src/b.ts'), 'change', ws.root);
      await bg.whenIdle();

      assert.ok(hasSymbol('betaTwo'));
      assert.deepEqual(resolves[0].files.map(f => path.basename(f)), ['b.ts']);
      assert.deepEqual(statuses, ['updating', 'ready']);
    });
  });

  describe('skill regeneration after changes settle', () => {
    afterEach(() => mock.timers.reset());

    const symbolsLine = () => /\*\*(\d+) symbols\*\*/.exec(read(ws.path('.codelens/instructions.md')))?.[1];

    it('rewrites the skill files 5 s after the last applied batch', async () => {
      ws.write('src/a.ts', 'export function alpha() {}\n');
      await startScanned();
      const before = symbolsLine();

      mock.timers.enable({ apis: ['setTimeout'] });
      ws.write('src/a.ts', 'export function alpha() {}\nexport function more() {}\nexport function evenMore() {}\n');
      bg.queueFileChange(ws.path('src/a.ts'), 'change', ws.root);
      mock.timers.tick(400);
      await until(() => statuses.includes('ready'));
      assert.ok(hasSymbol('more'));

      mock.timers.tick(4_999);
      assert.equal(symbolsLine(), before, 'not regenerated before the debounce elapses');
      mock.timers.tick(1);
      await until(() => symbolsLine() !== before);
      assert.equal(Number(symbolsLine()), ws.db.getStats().totalNodes);
    });

    it('dispose cancels a pending regeneration', async () => {
      ws.write('src/a.ts', 'export function alpha() {}\n');
      await startScanned();
      const before = symbolsLine();

      mock.timers.enable({ apis: ['setTimeout'] });
      ws.write('src/a.ts', 'export function alpha() {}\nexport function more() {}\n');
      bg.queueFileChange(ws.path('src/a.ts'), 'change', ws.root);
      mock.timers.tick(400);
      await until(() => statuses.includes('ready'));

      bg.dispose();
      mock.timers.tick(10_000);
      await new Promise<void>(resolve => setImmediate(resolve));
      assert.equal(symbolsLine(), before);
    });
  });

  describe('handleAgentRunComplete', () => {
    it('re-indexes the files an agent touched, in one batch, then regenerates skills', async () => {
      ws.write('src/a.ts', 'export function alpha() {}\n');
      ws.write('src/b.ts', 'export function beta() {}\n');
      await startScanned(['Claude']);
      fs.rmSync(ws.path('CLAUDE.md'));

      ws.write('src/a.ts', 'export function alphaByAgent() {}\n');
      fs.rmSync(ws.path('src/b.ts'));
      ws.write('node_modules/dep/index.js', 'module.exports = 1;\n');
      ws.write('notes.txt', 'text');

      await bg.handleAgentRunComplete(
        ['src/a.ts', ws.path('src/b.ts'), 'node_modules/dep/index.js', 'notes.txt'], scope, SCAN_OPTIONS);

      assert.deepEqual(indexed(), ['src/a.ts']);
      assert.ok(hasSymbol('alphaByAgent'));
      assert.equal(resolves.length, 1);
      assert.equal(persists, 1);
      assert.deepEqual(statuses, ['updating', 'ready']);
      assert.equal(completed.length, 1);
      assert.equal(completed[0].fileCount, 1);
      assert.equal(completed[0].buildDurationMs, 0);
      assert.equal(bg.getLastStats(), completed[0]);
      assert.ok(fs.existsSync(ws.path('CLAUDE.md')), 'skills regenerated for the selected agents');
    });

    it('with no allowed files still reports completion without writing the index', async () => {
      ws.write('src/a.ts', 'export function alpha() {}\n');
      await startScanned();

      await bg.handleAgentRunComplete(['README.txt'], scope, SCAN_OPTIONS);

      assert.equal(persists, 0);
      assert.deepEqual(statuses, []);
      assert.equal(completed.length, 1);
    });
  });

  describe('dispose', () => {
    it('stops scans, batches and refreshes', async () => {
      ws.write('src/a.ts', 'export function alpha() {}\n');
      ws.write('package.json', JSON.stringify({ dependencies: { 'left-pad': '^1.0.0' } }));
      await start();
      bg.setAcceptingChanges(true);

      bg.dispose();
      assert.equal(await bg.runFullScan(scope, SCAN_OPTIONS), null);
      bg.queueFileChange(ws.path('src/a.ts'), 'change', ws.root);
      await bg.refreshDependencies(ws.root);
      await bg.whenIdle();

      assert.deepEqual(statuses, []);
      assert.equal(scans, 0);
      assert.equal(persists, 0);
      assert.deepEqual(indexed(), []);
    });

    it('a scan queued before dispose does not run', async () => {
      ws.write('src/a.ts', 'export function alpha() {}\n');
      await start();
      const scan = bg.runFullScan(scope, SCAN_OPTIONS);
      bg.dispose();
      assert.equal(await scan, null);
      assert.equal(scans, 0);
    });

    it('drops a batch that was already queued when disposed', async () => {
      ws.write('src/a.ts', 'export function alpha() {}\n');
      await startScanned();
      // Hold the queue with a manifest refresh so the batch is queued behind it.
      let release!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      const ensureInit = ws.db.ensureInit.bind(ws.db);
      ws.db.ensureInit = async () => { await gate; return ensureInit(); };
      const refresh = bg.refreshDependencies(ws.root);

      mock.timers.enable({ apis: ['setTimeout'] });
      try {
        ws.write('src/a.ts', 'export function alphaChanged() {}\n');
        bg.queueFileChange(ws.path('src/a.ts'), 'change', ws.root);
        mock.timers.tick(400); // batch flushed into the queue, behind the refresh
      } finally {
        mock.timers.reset();
      }
      bg.dispose();
      release();
      await refresh;
      await bg.whenIdle();

      assert.equal(hasSymbol('alphaChanged'), false);
      assert.deepEqual(statuses, []);
    });
  });
});
