import { describe, it, before, after, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { FileWatcher } from '../../src/ingestion/fileWatcher';
import { WorkspaceScanner } from '../../src/ingestion/workspaceScanner';
import { TempDir } from './tmp';
import { newWorkspace } from './workspace';

type Event = { file: string; type: 'change' | 'add' | 'unlink' };

const DEBOUNCE_MS = 500;
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// Records events and lets a test await the first one matching a predicate.
function recorder(watcher: FileWatcher) {
  const events: Event[] = [];
  const waiters: Array<{ match: (e: Event) => boolean; resolve: (e: Event) => void }> = [];
  watcher.onChange((file, type) => {
    const e = { file, type };
    events.push(e);
    for (const w of [...waiters]) {
      if (w.match(e)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(e); }
    }
  });
  const next = (match: (e: Event) => boolean, timeoutMs = 5000) => {
    const seen = events.find(match);
    if (seen) { return Promise.resolve(seen); }
    return new Promise<Event>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out waiting for a watcher event')), timeoutMs);
      waiters.push({ match, resolve: e => { clearTimeout(timer); resolve(e); } });
    });
  };
  return { events, next };
}

function fakeScanner(updateFile: (filePath: string) => Promise<unknown>) {
  return { updateFile } as unknown as WorkspaceScanner;
}

describe('FileWatcher: VS Code event handlers', () => {
  let errorSpy: ReturnType<typeof mock.method>;
  beforeEach(() => { errorSpy = mock.method(console, 'error', () => {}); });
  afterEach(() => errorSpy.mock.restore());

  it('handleFileChange updates the file, then notifies every listener with "change"', async () => {
    const updated: string[] = [];
    const watcher = new FileWatcher(fakeScanner(async f => { updated.push(f); }));
    const a: Event[] = [];
    const b: Event[] = [];
    watcher.onChange((file, type) => a.push({ file, type }));
    watcher.onChange((file, type) => b.push({ file, type }));

    await watcher.handleFileChange('/w/x.ts');
    assert.deepEqual(updated, ['/w/x.ts']);
    assert.deepEqual(a, [{ file: '/w/x.ts', type: 'change' }]);
    assert.deepEqual(b, a);
  });

  it('handleFileCreate updates the file and notifies with "add"', async () => {
    const updated: string[] = [];
    const watcher = new FileWatcher(fakeScanner(async f => { updated.push(f); }));
    const { events } = recorder(watcher);
    await watcher.handleFileCreate('/w/new.ts');
    assert.deepEqual(updated, ['/w/new.ts']);
    assert.deepEqual(events, [{ file: '/w/new.ts', type: 'add' }]);
  });

  it('handleFileDelete notifies with "unlink" without touching the scanner', () => {
    const watcher = new FileWatcher(fakeScanner(async () => { throw new Error('must not be called'); }));
    const { events } = recorder(watcher);
    watcher.handleFileDelete('/w/old.ts');
    assert.deepEqual(events, [{ file: '/w/old.ts', type: 'unlink' }]);
  });

  it('logs scanner failures instead of throwing, and does not notify', async () => {
    const watcher = new FileWatcher(fakeScanner(async () => { throw new Error('boom'); }));
    const { events } = recorder(watcher);
    await assert.doesNotReject(watcher.handleFileChange('/w/x.ts'));
    await assert.doesNotReject(watcher.handleFileCreate('/w/y.ts'));
    assert.deepEqual(events, []);
    assert.equal(errorSpy.mock.callCount(), 2);
    assert.match(String(errorSpy.mock.calls[0].arguments[0]), /x\.ts.*boom/);
  });

  it('dispose drops listeners', () => {
    const watcher = new FileWatcher(fakeScanner(async () => {}));
    const { events } = recorder(watcher);
    watcher.dispose();
    watcher.handleFileDelete('/w/old.ts');
    assert.deepEqual(events, []);
  });

  it('indexes the file through a real scanner', async () => {
    const ws = newWorkspace();
    try {
      await ws.open();
      const file = ws.write('src/fresh.js', 'function freshlyAdded() { return 1; }\n');
      await new FileWatcher(ws.scanner).handleFileCreate(file);
      assert.doesNotThrow(() => ws.node('freshlyAdded', 'src/fresh.js'));
    } finally {
      ws.close();
    }
  });
});

describe('FileWatcher.watchRoots', () => {
  const tmp = new TempDir();
  let watcher: FileWatcher;
  let rec: ReturnType<typeof recorder>;
  let warnSpy: ReturnType<typeof mock.method>;

  before(() => {
    warnSpy = mock.method(console, 'warn', () => {});
    tmp.mkdir('root/sub');
    watcher = new FileWatcher(fakeScanner(async () => {}));
    rec = recorder(watcher);
    watcher.watchRoots([tmp.path('missing-root'), tmp.path('root')], ['.TS']);
  });

  after(() => {
    watcher.dispose();
    warnSpy.mock.restore();
    tmp.remove();
  });

  it('warns about a root it cannot watch and keeps watching the others', () => {
    assert.equal(warnSpy.mock.callCount(), 1);
    assert.match(String(warnSpy.mock.calls[0].arguments[0]), /Could not watch .*missing-root/);
  });

  it('reports a new file with a supported extension (debounced), ignoring other extensions', async () => {
    const ignored = tmp.write('root/notes.txt', 'x');
    const file = tmp.write('root/a.ts', 'export const a = 1;');
    const started = Date.now();
    const e = await rec.next(ev => ev.file === file);
    assert.ok(['add', 'change'].includes(e.type), e.type);
    assert.ok(Date.now() - started >= DEBOUNCE_MS - 50, 'events are debounced');
    assert.ok(!rec.events.some(ev => ev.file === ignored), 'unsupported extension is not reported');
  });

  it('watches subfolders recursively', async () => {
    const file = tmp.write('root/sub/b.ts', 'export const b = 1;');
    await rec.next(ev => ev.file === file);
  });

  it('coalesces rapid saves of one file into a single event', async () => {
    const file = tmp.path('root/burst.ts');
    for (let i = 0; i < 5; i++) { fs.writeFileSync(file, `export const v = ${i};`); }
    await rec.next(ev => ev.file === file);
    await delay(DEBOUNCE_MS + 150);
    assert.equal(rec.events.filter(ev => ev.file === file).length, 1);
  });

  it('reports a deleted file as "unlink"', async () => {
    const file = tmp.write('root/doomed.ts', 'x');
    await rec.next(ev => ev.file === file);
    fs.rmSync(file);
    await rec.next(ev => ev.file === file && ev.type === 'unlink');
  });

  it('stops reporting after dispose', async () => {
    watcher.dispose();
    const late: Event[] = [];
    watcher.onChange((file, type) => late.push({ file, type }));
    tmp.write('root/late.ts', 'x');
    await delay(DEBOUNCE_MS + 150);
    assert.deepEqual(late, []);
    assert.ok(!rec.events.some(ev => path.basename(ev.file) === 'late.ts'));
  });
});
