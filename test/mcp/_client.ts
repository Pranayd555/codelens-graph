import { spawn, ChildProcessWithoutNullStreams } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// ─── Contract-test client for the standalone MCP server ───────────────────────
// Starts src/mcp/mcpEntry.ts as a child process and speaks newline-delimited
// JSON-RPC over stdio, the way an agent does. HOME/USERPROFILE always point at
// a throwaway "fake home", so the registry and opt-out list the server reads
// (~/.codelens/*.json) are the test's own and the real home is never touched.

export const REPO_ROOT = path.resolve(__dirname, '..', '..');
const ENTRY = path.join(REPO_ROOT, 'src', 'mcp', 'mcpEntry.ts');
const TS_NODE_REGISTER = require.resolve('ts-node/register', { paths: [REPO_ROOT] });

export interface ToolResult { text: string; isError: boolean; }

export interface StartOptions {
  // Workspace path, or '--auto'.
  arg: string;
  // Working directory of the server process. Never the repo root: the server
  // walks up from cwd looking for an indexed .codelens/, and this repo has one.
  cwd: string;
  home: string;
  env?: Record<string, string>;
}

export class McpClient {
  readonly stderr: string[] = [];
  private buffer = '';
  private nextId = 1;
  private exited = false;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();

  private constructor(readonly child: ChildProcessWithoutNullStreams) {
    child.stdout.setEncoding('utf-8');
    child.stdout.on('data', (chunk: string) => this.onData(chunk));
    child.stderr.setEncoding('utf-8');
    child.stderr.on('data', (chunk: string) => { this.stderr.push(chunk); });
    child.on('exit', () => {
      this.exited = true;
      for (const [, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(new Error('MCP server exited. stderr:\n' + this.stderr.join('')));
      }
      this.pending.clear();
    });
  }

  // Spawns the server and completes the MCP handshake.
  static async start(options: StartOptions): Promise<McpClient> {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: options.home,
      USERPROFILE: options.home,
      TS_NODE_PROJECT: path.join(REPO_ROOT, 'tsconfig.json'),
      TS_NODE_TRANSPILE_ONLY: 'true',
      ...options.env,
    };
    // Variables that would change how the server picks its workspace or how
    // the child node process behaves under the test runner.
    delete env.WORKSPACE_FOLDER;
    delete env.NODE_TEST_CONTEXT;
    delete env.NODE_OPTIONS;
    const child = spawn(process.execPath, ['--require', TS_NODE_REGISTER, ENTRY, options.arg], {
      cwd: options.cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    });
    const client = new McpClient(child);
    try {
      await client.initialize();
    } catch (err) {
      await client.close();
      throw err;
    }
    return client;
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let nl: number;
    while ((nl = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, nl).replace(/\r$/, '');
      this.buffer = this.buffer.slice(nl + 1);
      if (!line.trim()) { continue; }
      let msg: any;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.id === undefined || !this.pending.has(msg.id)) { continue; }
      const p = this.pending.get(msg.id)!;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) { p.reject(new Error('JSON-RPC error ' + msg.error.code + ': ' + msg.error.message)); }
      else { p.resolve(msg.result); }
    }
  }

  request(method: string, params: unknown, timeoutMs = 15000): Promise<any> {
    if (this.exited) { return Promise.reject(new Error('MCP server is not running. stderr:\n' + this.stderr.join(''))); }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out after ${timeoutMs} ms waiting for ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }

  notify(method: string, params?: unknown): void {
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, ...(params ? { params } : {}) }) + '\n');
  }

  private async initialize(): Promise<void> {
    // Server startup (ts-node + sql.js) is the slow part, so allow more time here.
    await this.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'codelens-contract-test', version: '0.0.0' },
    }, 60000);
    this.notify('notifications/initialized');
  }

  async listTools(): Promise<Array<{ name: string; description?: string; inputSchema: any }>> {
    return (await this.request('tools/list', {})).tools;
  }

  async call(name: string, args: Record<string, unknown> = {}, timeoutMs = 15000): Promise<ToolResult> {
    const result = await this.request('tools/call', { name, arguments: args }, timeoutMs);
    const text = (result.content ?? []).map((c: any) => c.text ?? '').join('');
    return { text, isError: result.isError === true };
  }

  // Polls a tool until check() accepts its output (no fixed sleeps).
  async waitFor(name: string, args: Record<string, unknown>, check: (text: string) => boolean, timeoutMs = 30000): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    let last = '';
    while (Date.now() < deadline) {
      last = (await this.call(name, args)).text;
      if (check(last)) { return last; }
      await delay(100);
    }
    throw new Error(`Timed out waiting on ${name}. Last output:\n${last}\nstderr:\n${this.stderr.join('')}`);
  }

  // Polls status until the background index holds `files` workspace files and
  // the DB has been written to disk (the scan's final step).
  async waitForIndex(workspaceRoot: string, files: number, workspace?: string): Promise<string> {
    const dbFile = path.join(workspaceRoot, '.codelens', 'codelens-graph.db');
    return this.waitFor('codelens_status', workspace ? { workspace } : {},
      text => filesIndexed(text) >= files && fs.existsSync(dbFile));
  }

  async close(): Promise<void> {
    for (const [, p] of this.pending) { clearTimeout(p.timer); }
    this.pending.clear();
    if (this.exited) { return; }
    const exited = new Promise<void>(resolve => this.child.once('exit', () => resolve()));
    try { this.child.stdin.end(); } catch { /* ignore */ }
    this.child.kill();
    const timer = setTimeout(() => { try { this.child.kill('SIGKILL'); } catch { /* ignore */ } }, 3000);
    await exited;
    clearTimeout(timer);
  }
}

export function filesIndexed(statusText: string): number {
  const m = /Files indexed: (\d+)/.exec(statusText);
  return m ? Number(m[1]) : -1;
}

export const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

// ─── Temp directories ─────────────────────────────────────────────────────────

export class TempDir {
  readonly root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'codelens-mcp-')));

  path(rel: string): string {
    return path.join(this.root, ...rel.split('/'));
  }

  write(rel: string, text: string): string {
    const filePath = this.path(rel);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, text);
    return filePath;
  }

  mkdir(rel: string): string {
    const dir = this.path(rel);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  exists(rel: string): boolean {
    return fs.existsSync(this.path(rel));
  }

  cleanup(): void {
    // The server may still be releasing files on Windows right after exit.
    for (let i = 0; i < 5; i++) {
      try { fs.rmSync(this.root, { recursive: true, force: true }); return; } catch { /* retry */ }
    }
  }
}

// ─── Fake home: registry and opt-out list ─────────────────────────────────────

export function writeRegistry(home: string, windows: Record<string, { path: string; lastActive: number }>): void {
  const file = path.join(home, '.codelens', 'active-workspaces.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ windows }, null, 2));
}

export function writeDisabled(home: string, workspaces: string[]): void {
  const file = path.join(home, '.codelens', 'disabled-workspaces.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ workspaces }, null, 2));
}

// Symlink to a directory; falls back to a junction on Windows (no privilege
// needed). Returns false when the platform refuses both.
export function linkDir(target: string, linkPath: string): boolean {
  try { fs.symlinkSync(target, linkPath, 'dir'); return true; } catch (err: any) {
    if (err?.code !== 'EPERM' && err?.code !== 'EACCES') { throw err; }
  }
  if (process.platform === 'win32') {
    try { fs.symlinkSync(target, linkPath, 'junction'); return true; } catch { /* fall through */ }
  }
  return false;
}

export function linkFile(target: string, linkPath: string): boolean {
  try { fs.symlinkSync(target, linkPath, 'file'); return true; } catch (err: any) {
    if (err?.code === 'EPERM' || err?.code === 'EACCES') { return false; }
    throw err;
  }
}
