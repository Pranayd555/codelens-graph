import { FakeWebviewView, CancellationTokenSource, commands, fakeExtensionContext, resetVscodeStub } from './_vscode';
import { describe, it, beforeEach, TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type * as vscodeTypes from 'vscode';
import type { GraphDB } from '../../src/graph/graphDB';
import { StatsViewProvider } from '../../src/ui/statsView';
import { scriptTags, cspDirectives, runWebviewScript, WebviewRun } from './_webview';

// ─── Fakes ───────────────────────────────────────────────────────────────────

const STATS = { totalNodes: 1500, totalEdges: 20, fileCount: 7, byType: { function: 1000, class: 500, import: 0 } };

// Records every call; stats are only available once "initialized".
class FakeDB {
  readonly calls: string[] = [];
  constructor(public initialized: boolean, public stats: object = STATS, public issues = 3) {}
  isInitialized(): boolean { this.calls.push('isInitialized'); return this.initialized; }
  async ensureInit(): Promise<void> { this.calls.push('ensureInit'); this.initialized = true; }
  getStats(): object {
    this.calls.push('getStats');
    if (!this.initialized) { throw new Error('getStats before init'); }
    return this.stats;
  }
  countNodesWithUndefinedRefs(): number { this.calls.push('countNodesWithUndefinedRefs'); return this.issues; }
}

// The extension dir is never read or written by the provider; keep it test-owned anyway.
const context = fakeExtensionContext(path.join(os.tmpdir(), 'codelens-fake-extension'));
const flush = () => new Promise<void>(resolve => setImmediate(resolve));

interface Setup { db: FakeDB; provider: StatsViewProvider; view: FakeWebviewView }

function create(db: FakeDB): StatsViewProvider {
  return new StatsViewProvider(db as unknown as GraphDB, context as unknown as vscodeTypes.ExtensionContext);
}

function resolve(provider: StatsViewProvider, view: FakeWebviewView): void {
  const token = new CancellationTokenSource().token;
  provider.resolveWebviewView(
    view as unknown as vscodeTypes.WebviewView,
    { state: undefined } as vscodeTypes.WebviewViewResolveContext,
    token as unknown as vscodeTypes.CancellationToken
  );
}

// Fake timers so the provider's deferred sends run only when a test ticks.
function setup(t: TestContext, opts: { initialized?: boolean; status?: string; visible?: boolean; stats?: object; issues?: number } = {}): Setup {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const db = new FakeDB(opts.initialized ?? false, opts.stats, opts.issues);
  const provider = create(db);
  if (opts.status) { provider.setStatus(opts.status); }
  const view = new FakeWebviewView(opts.visible ?? true);
  resolve(provider, view);
  return { db, provider, view };
}

const updates = (view: FakeWebviewView) => view.webview.posted.filter(m => m.command === 'update');

const EXPECTED_COMMANDS: Record<string, string> = {
  buildGraph:       'codelens-graph.buildGraph',
  showGraph:        'codelens-graph.showGraph',
  searchSymbol:     'codelens-graph.searchSymbol',
  copyMcpConfig:    'codelens-graph.copyMcpConfig',
  showContext:      'codelens-graph.showContext',
  showMcpUsage:     'codelens-graph.showMcpUsage',
  addConfig:        'codelens-graph.regenerateSkills',
  clearConfig:      'codelens-graph.clearConfig',
  enableWorkspace:  'codelens-graph.enableWorkspace',
  disableWorkspace: 'codelens-graph.disableWorkspace',
};

beforeEach(() => resetVscodeStub());

// ─── HTML ────────────────────────────────────────────────────────────────────

describe('StatsViewProvider HTML', () => {
  it('enables scripts with the extension dir as the only local resource root', (t) => {
    const { view } = setup(t);
    assert.equal(view.webview.options.enableScripts, true);
    assert.deepEqual(view.webview.options.localResourceRoots, [context.extensionUri]);
  });

  it('has a nonce-based CSP and every script carries the nonce', (t) => {
    const { view } = setup(t);
    const html = view.webview.html;
    const scripts = scriptTags(html);
    assert.equal(scripts.length, 1);
    const nonce = scripts[0].nonce;
    assert.match(nonce ?? '', /^[0-9a-f]{32}$/);
    assert.equal(scripts[0].src, null);
    assert.equal((html.match(/<script\b/gi) ?? []).length, 1);
    assert.deepEqual(cspDirectives(html), {
      'default-src': ["'none'"],
      'script-src': [`'nonce-${nonce}'`],
      'style-src': ["'unsafe-inline'"],
    });
    assert.ok(html.indexOf('Content-Security-Policy') < html.indexOf('<script'));
  });

  it('uses a fresh nonce for each resolved view', (t) => {
    const a = setup(t).view.webview.html;
    const b = new FakeWebviewView();
    resolve(create(new FakeDB(false)), b);
    assert.notEqual(scriptTags(a)[0].nonce, scriptTags(b.webview.html)[0].nonce);
  });

  it('loads nothing remotely and has no inline event handlers', (t) => {
    const markup = setup(t).view.webview.html.replace(/<script\b[\s\S]*?<\/script>/gi, '');
    assert.doesNotMatch(markup, /\s(?:src|href|action|srcset)\s*=/i);
    assert.doesNotMatch(markup, /<(?:link|iframe|img|object|embed|base|form)\b/i);
    assert.doesNotMatch(markup, /\son[a-z]+\s*=/i);
  });

  it('every button data-cmd maps to a contributed codelens-graph.* command', (t) => {
    const html = setup(t).view.webview.html;
    const cmds = new Set([...html.matchAll(/data-cmd="([^"]+)"/g)].map(m => m[1]));
    assert.deepEqual([...cmds].sort(), Object.keys(EXPECTED_COMMANDS).sort());
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8'));
    const contributed = new Set((pkg.contributes.commands as { command: string }[]).map(c => c.command));
    for (const id of Object.values(EXPECTED_COMMANDS)) {
      assert.ok(contributed.has(id), `${id} is contributed in package.json`);
    }
  });
});

// ─── Messages from the webview ───────────────────────────────────────────────

describe('StatsViewProvider webview messages', () => {
  for (const [cmd, id] of Object.entries(EXPECTED_COMMANDS)) {
    it(`${cmd} runs ${id}`, (t) => {
      const { view } = setup(t);
      view.webview.receive({ command: cmd });
      assert.deepEqual(commands.executed, [{ command: id, args: [] }]);
    });
  }

  it('a button click in the webview reaches executeCommand with the mapped id', (t) => {
    const { view } = setup(t);
    const page = runPage(view.webview.html);
    for (const cmd of ['enableWorkspace', 'disableWorkspace', 'addConfig']) {
      page.clickCommand(cmd);
      view.webview.receive(page.posted.at(-1));
    }
    assert.deepEqual(commands.executed.map(c => c.command),
      ['codelens-graph.enableWorkspace', 'codelens-graph.disableWorkspace', 'codelens-graph.regenerateSkills']);
  });

  it('ignores unknown commands', (t) => {
    const { view } = setup(t);
    for (const command of ['nope', '', 'codelens-graph.buildGraph', 'regenerateSkills', 'BUILDGRAPH', undefined, 42]) {
      view.webview.receive({ command });
    }
    view.webview.receive({});
    assert.deepEqual(commands.executed, []);
  });

  it('ignores Object.prototype names as commands',
    { todo: 'BUG: statsView.ts:37-49 looks commands up in a plain object, so toString/constructor/__proto__ call executeCommand with a function/object' },
    (t) => {
      const { view } = setup(t);
      for (const command of ['toString', 'constructor', '__proto__', 'hasOwnProperty', 'valueOf']) {
        view.webview.receive({ command });
      }
      assert.deepEqual(commands.executed, []);
    });

  it("'ready' sends the current data and runs no command", async (t) => {
    const { view } = setup(t, { initialized: true, status: 'ready' });
    view.webview.receive({ command: 'ready' });
    await flush();
    assert.deepEqual(commands.executed, []);
    assert.deepEqual(updates(view), [{ command: 'update', stats: STATS, issues: 3, status: 'ready' }]);
  });
});

// ─── Status and data ─────────────────────────────────────────────────────────

describe('StatsViewProvider status and data', () => {
  it('disabled: posts the status with no stats and never touches the DB', async (t) => {
    const { db, provider, view } = setup(t, { status: 'disabled', initialized: true });
    view.webview.receive({ command: 'ready' });
    t.mock.timers.tick(200);
    await provider.refresh();
    view.setVisible(true);
    t.mock.timers.tick(150);
    await flush();
    assert.deepEqual(db.calls, []);
    const posted = updates(view);
    assert.ok(posted.length >= 3);
    for (const msg of posted) { assert.deepEqual(msg, { command: 'update', stats: null, issues: 0, status: 'disabled' }); }
  });

  it('idle with an uninitialized DB: posts no stats and does not open the DB', async (t) => {
    const { db, provider, view } = setup(t, { initialized: false });
    view.webview.receive({ command: 'ready' });
    t.mock.timers.tick(200);
    await provider.refresh();
    await flush();
    assert.deepEqual(db.calls.filter(c => c !== 'isInitialized'), []);
    assert.deepEqual(updates(view), [
      { command: 'update', stats: null, issues: 0, status: 'idle' },
      { command: 'update', stats: null, issues: 0, status: 'idle' },
    ]);
  });

  it('idle with an initialized DB posts its stats', async (t) => {
    const { db, view } = setup(t, { initialized: true });
    view.webview.receive({ command: 'ready' });
    await flush();
    assert.deepEqual(updates(view), [{ command: 'update', stats: STATS, issues: 3, status: 'idle' }]);
    assert.deepEqual(db.calls, ['isInitialized', 'ensureInit', 'getStats', 'countNodesWithUndefinedRefs']);
  });

  for (const status of ['scanning', 'updating', 'ready', 'error', 'needsFolders']) {
    it(`${status}: initializes the DB if needed and posts stats with the status`, async (t) => {
      const { db, view } = setup(t, { initialized: false, status });
      view.webview.receive({ command: 'ready' });
      await flush();
      assert.ok(db.calls.includes('ensureInit'));
      assert.ok(db.calls.indexOf('ensureInit') < db.calls.indexOf('getStats'));
      assert.deepEqual(updates(view), [{ command: 'update', stats: STATS, issues: 3, status }]);
    });
  }

  it('setStatus posts right away with the new status', async (t) => {
    const { view, provider } = setup(t, { initialized: true });
    provider.setStatus('scanning');
    await flush();
    provider.setStatus('disabled');
    await flush();
    assert.deepEqual(updates(view).map(m => m.status), ['scanning', 'disabled']);
  });

  it('sends data once 200 ms after resolving, without waiting for the webview', async (t) => {
    const { view } = setup(t, { initialized: true });
    t.mock.timers.tick(199);
    await flush();
    assert.equal(updates(view).length, 0);
    t.mock.timers.tick(1);
    await flush();
    assert.equal(updates(view).length, 1);
  });

  it('resends 150 ms after the view becomes visible, not when it is hidden', async (t) => {
    const { view } = setup(t, { initialized: true });
    t.mock.timers.tick(200);
    await flush();
    view.setVisible(false);
    t.mock.timers.tick(1000);
    await flush();
    assert.equal(updates(view).length, 1);
    view.setVisible(true);
    t.mock.timers.tick(149);
    await flush();
    assert.equal(updates(view).length, 1);
    t.mock.timers.tick(1);
    await flush();
    assert.equal(updates(view).length, 2);
  });

  it('refresh while hidden reads the stats but posts nothing; while visible it posts', async (t) => {
    const { db, provider, view } = setup(t, { initialized: true, status: 'ready', visible: false });
    await provider.refresh();
    assert.deepEqual(updates(view), []);
    assert.ok(db.calls.includes('getStats'));
    view.visible = true;
    await provider.refresh();
    assert.deepEqual(updates(view), [{ command: 'update', stats: STATS, issues: 3, status: 'ready' }]);
  });

  it('before a view is resolved: nothing is posted and nothing throws', async () => {
    const db = new FakeDB(false);
    const provider = create(db);
    provider.setStatus('disabled');
    provider.updateSavings(10, 1);
    await provider.refresh();
    provider.setStatus('idle');
    await provider.refresh();
    assert.deepEqual(db.calls.filter(c => c !== 'isInitialized'), []);
  });

  it('updateSavings posts tokens and calls', (t) => {
    const { provider, view } = setup(t);
    provider.updateSavings(2500, 4);
    assert.deepEqual(view.webview.posted.filter(m => m.command === 'updateSavings'),
      [{ command: 'updateSavings', tokens: 2500, calls: 4 }]);
  });
});

// ─── The webview script ──────────────────────────────────────────────────────

function runPage(html: string): WebviewRun {
  const inline = scriptTags(html).find(s => !s.src);
  assert.ok(inline);
  return runWebviewScript(html, inline.body);
}

function shown(page: WebviewRun): string[] {
  return ['off-state', 'skeleton', 'empty-state', 'main'].filter(id => {
    const display = page.elements.get(id)!.style.display;
    return display !== 'none';
  });
}

describe('StatsViewProvider webview script', () => {
  const html = (() => {
    const view = new FakeWebviewView();
    resolve(create(new FakeDB(false)), view);
    return view.webview.html;
  })();

  it("starts on the skeleton and posts 'ready'", () => {
    const page = runPage(html);
    assert.deepEqual(page.posted, [{ command: 'ready' }]);
    assert.deepEqual(shown(page), ['skeleton']);
  });

  it('click delegation posts the button command', () => {
    const page = runPage(html);
    page.clickCommand('buildGraph');
    assert.deepEqual(page.posted.at(-1), { command: 'buildGraph' });
  });

  const cases: [string, object | null, string][] = [
    ['disabled', STATS, 'off-state'],
    ['disabled', null, 'off-state'],
    ['scanning', null, 'skeleton'],
    ['updating', { ...STATS, totalNodes: 0 }, 'skeleton'],
    ['idle', null, 'empty-state'],
    ['error', null, 'empty-state'],
    ['needsFolders', null, 'empty-state'],
    ['ready', { ...STATS, totalNodes: 0 }, 'empty-state'],
    ['ready', STATS, 'main'],
    ['scanning', STATS, 'main'],
    ['error', STATS, 'main'],
  ];
  for (const [status, stats, section] of cases) {
    it(`${status} with ${stats ? `${(stats as { totalNodes: number }).totalNodes} nodes` : 'no stats'} shows ${section}`, () => {
      const page = runPage(html);
      page.dispatch({ command: 'update', stats, issues: 0, status });
      assert.deepEqual(shown(page), [section]);
    });
  }

  it('end to end: what the provider posts for each status renders the right section', async (t) => {
    const expected: Record<string, string> = {
      disabled: 'off-state', idle: 'empty-state', scanning: 'main', ready: 'main', error: 'main', needsFolders: 'main',
    };
    for (const [status, section] of Object.entries(expected)) {
      const { view } = setup(t, { status, initialized: false });
      view.webview.receive({ command: 'ready' });
      await flush();
      const page = runPage(view.webview.html);
      page.dispatch(updates(view).at(-1));
      assert.deepEqual(shown(page), [section], status);
      t.mock.timers.reset();
    }
  });

  it('fills the stat cards and marks issues', () => {
    const page = runPage(html);
    page.dispatch({ command: 'update', stats: STATS, issues: 3, status: 'ready' });
    const text = (id: string) => page.elements.get(id)!.textContent;
    assert.deepEqual([text('v-nodes'), text('v-edges'), text('v-files'), text('v-issues')], ['1.5k', '20', '7', '3']);
    assert.equal(page.elements.get('card-issues')!.className, 'stat-card warn');
    page.dispatch({ command: 'update', stats: STATS, issues: 0, status: 'ready' });
    assert.equal(page.elements.get('card-issues')!.className, 'stat-card ok');
  });

  it('lists types by count, drops zero counts and escapes type names', () => {
    const page = runPage(html);
    const evil = '<img src=x onerror=alert(1)>';
    page.dispatch({
      command: 'update', issues: 0, status: 'ready',
      stats: { ...STATS, byType: { function: 5, [evil]: 9, '"\'&': 2, __proto__x: 0, constructor: 1, import: 0 } },
    });
    const list = page.elements.get('type-list')!.innerHTML;
    const names = [...list.matchAll(/<span class="type-name">([^<]*)<\/span>/g)].map(m => m[1]);
    assert.deepEqual(names, ['&lt;img src=x onerror=alert(1)&gt;', 'function', '&quot;&#39;&amp;', 'constructor']);
    assert.ok(!list.includes('<img'));
    // Colours only ever come from the built-in table.
    const colours = [...list.matchAll(/background:([^;"]+)/g)].map(m => m[1]);
    assert.ok(colours.every(c => /^#[0-9a-f]{3,6}$/i.test(c)), colours.join(','));
    assert.ok(!list.includes('function Object'), 'constructor does not resolve to Object');
  });

  it('esc() escapes &, <, >, " and \'', () => {
    const page = runPage(html);
    const esc = page.context.esc as (s: unknown) => string;
    assert.equal(esc(`<a href="x" title='y'>&amp;</a>`),
      '&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;amp;&lt;/a&gt;');
    assert.equal(esc('C:\\repo\\src'), 'C:\\repo\\src');
    assert.equal(esc(42), '42');
  });

  it('shows token savings only once tokens were saved', () => {
    const page = runPage(html);
    const savings = page.elements.get('savings-section')!;
    page.dispatch({ command: 'updateSavings', tokens: 0, calls: 0 });
    assert.equal(savings.style.display, 'none');
    page.dispatch({ command: 'updateSavings', tokens: 2500, calls: 4 });
    assert.equal(savings.style.display, 'block');
    assert.equal(page.elements.get('sav-tokens')!.textContent, '2.5k');
    assert.equal(page.elements.get('sav-calls')!.textContent, '4');
    assert.equal(page.elements.get('sav-bar')!.style.width, '25%');
    page.dispatch({ command: 'updateSavings', tokens: 1_000_000, calls: 9 });
    assert.equal(page.elements.get('sav-bar')!.style.width, '100%');
  });

  it('ignores unknown messages', () => {
    const page = runPage(html);
    page.dispatch({ command: 'somethingElse', status: 'disabled' });
    assert.deepEqual(shown(page), ['skeleton']);
  });
});
