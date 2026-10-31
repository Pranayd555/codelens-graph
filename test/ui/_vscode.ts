// A small fake of the `vscode` module, enough to load and drive the UI
// providers under plain Node. Importing this file installs it: afterwards
// `require('vscode')` (and so `import * as vscode from 'vscode'` in src/)
// returns the `vscode` object below. Import it BEFORE any src/ module that
// imports vscode.
//
// Only what the code under test uses is implemented. To extend it for another
// module (e.g. extension.ts), add members to `vscode` here, or assign them on
// the exported object at runtime before importing the module under test.
import Module = require('node:module');
import * as path from 'node:path';

// ─── Basics ──────────────────────────────────────────────────────────────────

export class Disposable {
  private disposed = false;
  constructor(private readonly callOnDispose: () => unknown = () => undefined) {}
  static from(...items: { dispose(): unknown }[]): Disposable {
    return new Disposable(() => { for (const item of items) { item.dispose(); } });
  }
  dispose(): void {
    if (this.disposed) { return; }
    this.disposed = true;
    this.callOnDispose();
  }
}

export type Listener<T> = (e: T) => unknown;
export type Event<T> = (listener: Listener<T>, thisArgs?: unknown, disposables?: { dispose(): unknown }[]) => Disposable;

export class EventEmitter<T> {
  private listeners: Listener<T>[] = [];
  // Every value passed to fire(), for assertions.
  readonly fired: T[] = [];

  readonly event: Event<T> = (listener, thisArgs, disposables) => {
    const bound: Listener<T> = thisArgs === undefined ? listener : listener.bind(thisArgs);
    this.listeners.push(bound);
    const disposable = new Disposable(() => { this.listeners = this.listeners.filter(l => l !== bound); });
    disposables?.push(disposable);
    return disposable;
  };

  fire(data: T): void {
    this.fired.push(data);
    for (const listener of [...this.listeners]) { listener(data); }
  }

  get listenerCount(): number { return this.listeners.length; }

  dispose(): void { this.listeners = []; }
}

export class Uri {
  private constructor(
    readonly scheme: string,
    readonly authority: string,
    readonly path: string,
    readonly query = '',
    readonly fragment = ''
  ) {}

  static file(fsPath: string): Uri {
    let p = fsPath.replace(/\\/g, '/');
    if (!p.startsWith('/')) { p = '/' + p; }
    return new Uri('file', '', p);
  }

  static parse(value: string): Uri {
    const m = /^([a-zA-Z][\w+.-]*):(?:\/\/([^/?#]*))?([^?#]*)(?:\?([^#]*))?(?:#(.*))?$/.exec(value);
    if (!m) { throw new Error(`Uri.parse: cannot parse ${value}`); }
    return new Uri(m[1], m[2] ?? '', m[3] ?? '', m[4] ?? '', m[5] ?? '');
  }

  static joinPath(base: Uri, ...segments: string[]): Uri {
    return new Uri(base.scheme, base.authority, path.posix.join(base.path, ...segments), base.query, base.fragment);
  }

  get fsPath(): string {
    // "/C:/x/y" -> "C:\x\y" on Windows; unchanged elsewhere.
    const p = /^\/[a-zA-Z]:/.test(this.path) ? this.path.slice(1) : this.path;
    return process.platform === 'win32' ? p.replace(/\//g, '\\') : p;
  }

  with(change: { scheme?: string; authority?: string; path?: string; query?: string; fragment?: string }): Uri {
    return new Uri(change.scheme ?? this.scheme, change.authority ?? this.authority, change.path ?? this.path,
      change.query ?? this.query, change.fragment ?? this.fragment);
  }

  toString(): string {
    return `${this.scheme}://${this.authority}${this.path}${this.query ? '?' + this.query : ''}${this.fragment ? '#' + this.fragment : ''}`;
  }
}

// ─── Tree views ──────────────────────────────────────────────────────────────

export enum TreeItemCollapsibleState { None = 0, Collapsed = 1, Expanded = 2 }
export enum TreeItemCheckboxState { Unchecked = 0, Checked = 1 }

export class ThemeIcon {
  static readonly File = new ThemeIcon('file');
  static readonly Folder = new ThemeIcon('folder');
  constructor(readonly id: string, readonly color?: unknown) {}
}

export class TreeItem {
  label?: string | { label: string };
  resourceUri?: Uri;
  id?: string;
  description?: string | boolean;
  tooltip?: string | unknown;
  iconPath?: ThemeIcon | Uri | string | { light: unknown; dark: unknown };
  contextValue?: string;
  command?: { command: string; title: string; arguments?: unknown[] };
  checkboxState?: TreeItemCheckboxState | { state: TreeItemCheckboxState; tooltip?: string };
  collapsibleState?: TreeItemCollapsibleState;

  constructor(labelOrUri: string | { label: string } | Uri, collapsibleState: TreeItemCollapsibleState = TreeItemCollapsibleState.None) {
    if (labelOrUri instanceof Uri) { this.resourceUri = labelOrUri; } else { this.label = labelOrUri; }
    this.collapsibleState = collapsibleState;
  }
}

// ─── Webviews ────────────────────────────────────────────────────────────────

// Records the html it is given and the messages the extension posts; a test
// plays the webview side with receive().
export class FakeWebview {
  html = '';
  options: Record<string, unknown> = {};
  readonly cspSource = 'https://fake.vscode-cdn.net';
  readonly posted: any[] = [];
  private readonly received = new EventEmitter<any>();
  readonly onDidReceiveMessage = this.received.event;

  postMessage(message: unknown): Promise<boolean> {
    this.posted.push(message);
    return Promise.resolve(true);
  }

  asWebviewUri(uri: Uri): Uri {
    return uri.with({ scheme: 'https', authority: 'file+.vscode-resource.vscode-cdn.net' });
  }

  // Simulates the webview script calling vscode.postMessage(message).
  receive(message: unknown): void { this.received.fire(message); }
}

export class FakeWebviewView {
  readonly webview = new FakeWebview();
  title?: string;
  description?: string;
  private readonly visibility = new EventEmitter<void>();
  readonly onDidChangeVisibility = this.visibility.event;
  private readonly disposeEmitter = new EventEmitter<void>();
  readonly onDidDispose = this.disposeEmitter.event;

  constructor(public visible = true, readonly viewType = 'fake.view') {}

  setVisible(visible: boolean): void {
    this.visible = visible;
    this.visibility.fire();
  }

  show(): void { this.setVisible(true); }
  dispose(): void { this.disposeEmitter.fire(); }
}

export class CancellationTokenSource {
  private readonly emitter = new EventEmitter<void>();
  readonly token = {
    isCancellationRequested: false,
    onCancellationRequested: this.emitter.event,
  };
  cancel(): void {
    this.token.isCancellationRequested = true;
    this.emitter.fire();
  }
  dispose(): void { this.emitter.dispose(); }
}

// ─── Extension context ───────────────────────────────────────────────────────

export class FakeMemento {
  private readonly values = new Map<string, unknown>();
  keys(): readonly string[] { return [...this.values.keys()]; }
  get<T>(key: string, defaultValue?: T): T | undefined {
    return this.values.has(key) ? this.values.get(key) as T : defaultValue;
  }
  update(key: string, value: unknown): Promise<void> {
    if (value === undefined) { this.values.delete(key); } else { this.values.set(key, value); }
    return Promise.resolve();
  }
}

// extensionPath must be a test-owned directory (never the real home dir).
export function fakeExtensionContext(extensionPath: string) {
  return {
    extensionPath,
    extensionUri: Uri.file(extensionPath),
    subscriptions: [] as { dispose(): unknown }[],
    workspaceState: new FakeMemento(),
    globalState: new FakeMemento(),
    asAbsolutePath: (rel: string) => path.join(extensionPath, rel),
  };
}

// ─── Commands ────────────────────────────────────────────────────────────────

export interface ExecutedCommand { command: unknown; args: unknown[] }

const executed: ExecutedCommand[] = [];
const registered = new Map<string, (...args: any[]) => unknown>();

export const commands = {
  // Every executeCommand call, in order (cleared by resetVscodeStub()).
  executed,
  registered,
  registerCommand(command: string, callback: (...args: any[]) => unknown): Disposable {
    registered.set(command, callback);
    return new Disposable(() => registered.delete(command));
  },
  executeCommand(command: unknown, ...args: unknown[]): Promise<unknown> {
    executed.push({ command, args });
    const handler = typeof command === 'string' ? registered.get(command) : undefined;
    try {
      return Promise.resolve(handler ? handler(...args) : undefined);
    } catch (err) {
      return Promise.reject(err);
    }
  },
};

// Clears recorded state between tests.
export function resetVscodeStub(): void {
  executed.length = 0;
  registered.clear();
}

// ─── The module object ───────────────────────────────────────────────────────

export const vscode: Record<string, any> = {
  Disposable,
  EventEmitter,
  Uri,
  TreeItem,
  TreeItemCollapsibleState,
  TreeItemCheckboxState,
  ThemeIcon,
  CancellationTokenSource,
  commands,
};

// ─── Installation ────────────────────────────────────────────────────────────

const STUB_ID = path.join(__dirname, '__fake_vscode__.js');
type ResolveFilename = (request: string, parent: unknown, isMain: boolean, options?: unknown) => string;
const mod = Module as unknown as { _resolveFilename: ResolveFilename & { __fakeVscode?: true } };

export function installVscodeStub(): void {
  const cache = require.cache as Record<string, unknown>;
  cache[STUB_ID] = { id: STUB_ID, filename: STUB_ID, loaded: true, exports: vscode, children: [], paths: [] };
  if (mod._resolveFilename.__fakeVscode) { return; }
  const original = mod._resolveFilename;
  const patched = function (this: unknown, request: string, parent: unknown, isMain: boolean, options?: unknown): string {
    if (request === 'vscode') { return STUB_ID; }
    return original.call(this, request, parent, isMain, options);
  } as ResolveFilename & { __fakeVscode?: true };
  patched.__fakeVscode = true;
  mod._resolveFilename = patched;
}

installVscodeStub();
