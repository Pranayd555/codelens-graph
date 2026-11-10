import * as fs   from 'fs';
import * as os   from 'os';
import * as path from 'path';

// Agent MCP configs used to run the server from the extension's install folder
// (…/extensions/pranaydas.codelens-graph-0.3.1/dist/mcp.js). Every update
// installs into a new folder and deletes the old one, so configs that agents
// read outside the workspace (~/.claude.json, ~/.cursor/mcp.json, …) broke on
// each update. Configs now point at a stable launcher in ~/.codelens that
// starts the newest installed version, and old versioned entries are rewritten
// to it on startup.

// Extension folders of the editors CodeLens is installed in, relative to home.
const EXTENSION_ROOTS = [
  '.vscode/extensions', '.vscode-insiders/extensions', '.vscode-oss/extensions',
  '.vscode-server/extensions', '.vscode-server-insiders/extensions',
  '.cursor/extensions', '.cursor-server/extensions', '.windsurf/extensions',
  '.antigravity-ide/extensions', '.antigravity/extensions', '.trae/extensions', '.kiro/extensions',
];

// An installed CodeLens server entry point: …/pranaydas.codelens-graph-<version>[-<platform>]/dist/mcp(-run).js
const VERSIONED_ENTRY = /[\\/]pranaydas\.codelens-graph-\d+\.\d+\.\d+(?:-[\w.]+)?[\\/]dist[\\/]mcp(?:-run)?\.js$/i;

export function launcherPath(home = os.homedir()): string {
  return path.join(home, '.codelens', 'mcp.js');
}

// Forward slashes, as written into JSON configs.
export function launcherConfigPath(home = os.homedir()): string {
  return launcherPath(home).replace(/\\/g, '/');
}

type Version = [number, number, number];

function parseVersion(version: string): Version | null {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function compareVersions(a: Version, b: Version): number {
  for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) { return a[i] - b[i]; } }
  return 0;
}

// The launcher is plain Node with no dependencies. HINT is the server of the
// extension that last wrote it; it only matters when that extension lives
// outside the known folders (a custom --extensions-dir or a development build).
function launcherSource(hint: { entry: string; version: Version }): string {
  return `#!/usr/bin/env node
// CodeLens Graph MCP launcher. Written by the CodeLens Graph extension on
// startup; edits are overwritten. Starts the newest installed CodeLens MCP
// server, so agent configs pointing here survive extension updates.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const HINT = ${JSON.stringify(hint)};
const ROOTS = ${JSON.stringify(EXTENSION_ROOTS)};
const ID = /^pranaydas\\.codelens-graph-(\\d+)\\.(\\d+)\\.(\\d+)(?:-[\\w.]+)?$/i;

function installed() {
  const found = [];
  for (const rel of ROOTS) {
    const root = path.join(os.homedir(), rel);
    let names;
    try { names = fs.readdirSync(root); } catch (e) { continue; }
    // Versions VS Code has replaced or uninstalled but not deleted yet.
    let obsolete = {};
    try { obsolete = JSON.parse(fs.readFileSync(path.join(root, '.obsolete'), 'utf8')) || {}; } catch (e) { /* none */ }
    for (const name of names) {
      const m = ID.exec(name);
      if (!m || obsolete[name]) { continue; }
      const entry = path.join(root, name, 'dist', 'mcp.js');
      if (fs.existsSync(entry)) { found.push({ entry, version: [Number(m[1]), Number(m[2]), Number(m[3])] }); }
    }
  }
  if (HINT && fs.existsSync(HINT.entry)) { found.push(HINT); }
  return found;
}

const newer = (a, b) => {
  for (let i = 0; i < 3; i++) { if (a.version[i] !== b.version[i]) { return a.version[i] > b.version[i]; } }
  return false;
};

const candidates = installed();
if (!candidates.length) {
  console.error('[CodeLens MCP] No installed CodeLens Graph extension was found. Install it in VS Code or Cursor, then restart your agent.');
  process.exit(1);
}
let best = candidates[0];
for (const c of candidates) { if (newer(c, best)) { best = c; } }
require(best.entry);
`;
}

function readHint(source: string): { entry: string; version: Version } | null {
  const m = /^const HINT = (.*);$/m.exec(source);
  if (!m) { return null; }
  try { return JSON.parse(m[1]); } catch { return null; }
}

// Writes a file via a temporary file and a rename, so readers never see it
// half-written. Returns false if the file changed since `expected` was read.
function replaceFile(filePath: string, content: string, expected?: { mtimeMs: number; size: number }): boolean {
  if (expected) {
    const now = fs.statSync(filePath);
    if (now.mtimeMs !== expected.mtimeMs || now.size !== expected.size) { return false; }
  }
  const temp = `${filePath}.codelens-${process.pid}.tmp`;
  try {
    fs.writeFileSync(temp, content, expected ? { mode: fs.statSync(filePath).mode } : undefined);
    fs.renameSync(temp, filePath);
    return true;
  } finally {
    try { fs.unlinkSync(temp); } catch { /* renamed */ }
  }
}

// Installs or refreshes the launcher. serverEntry/version describe the running
// extension. A hint from a newer version is kept, so an older editor starting
// up never steers the launcher to its older server. Returns true if written.
export function installLauncher(serverEntry: string, version: string, home = os.homedir()): boolean {
  const parsed = parseVersion(version) ?? [0, 0, 0];
  let hint = { entry: path.resolve(serverEntry), version: parsed };
  const target = launcherPath(home);
  let existing = '';
  try { existing = fs.readFileSync(target, 'utf-8'); } catch { /* first install */ }
  const previous = existing ? readHint(existing) : null;
  if (previous && fs.existsSync(previous.entry) && compareVersions(previous.version, parsed) > 0) {
    hint = previous;
  }
  const source = launcherSource(hint);
  if (source === existing) { return false; }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  replaceFile(target, source);
  return true;
}

// ─── Rewriting configs that point at a versioned install folder ──────────────

interface ConfigFile {
  filePath: string;
  // Server tables inside the parsed file, e.g. json.mcpServers.
  serverTables: (json: any) => Array<Record<string, any>>;
}

function tables(...pick: Array<(json: any) => any>): (json: any) => Array<Record<string, any>> {
  return json => pick.map(p => { try { return p(json); } catch { return undefined; } })
    .filter((t): t is Record<string, any> => !!t && typeof t === 'object');
}

// Config files that agents read and that users fill from .codelens/mcp.json.
export function agentConfigFiles(home = os.homedir(), workspaceRoot?: string): ConfigFile[] {
  const files: ConfigFile[] = [
    {
      filePath: path.join(home, '.claude.json'),
      serverTables: json => [
        ...tables(j => j.mcpServers)(json),
        ...Object.values(json?.projects ?? {}).flatMap((p: any) => tables(() => p?.mcpServers)(json)),
      ],
    },
    { filePath: path.join(home, '.cursor', 'mcp.json'), serverTables: tables(j => j.mcpServers) },
    { filePath: path.join(home, '.codeium', 'windsurf', 'mcp_config.json'), serverTables: tables(j => j.mcpServers) },
  ];
  if (workspaceRoot) {
    files.push(
      { filePath: path.join(workspaceRoot, '.mcp.json'), serverTables: tables(j => j.mcpServers) },
      { filePath: path.join(workspaceRoot, '.cursor', 'mcp.json'), serverTables: tables(j => j.mcpServers) },
      { filePath: path.join(workspaceRoot, '.vscode', 'mcp.json'), serverTables: tables(j => j.servers) },
    );
  }
  return files;
}

// Points every server whose args run a versioned CodeLens install at the
// launcher. Only those arguments change; the rest of the file keeps its content
// and indentation. Files that are missing, not plain JSON, or that change while
// being updated are left alone (and retried next startup).
export function migrateConfigFile(file: ConfigFile, launcher: string): boolean {
  for (let attempt = 0; attempt < 3; attempt++) {
    let raw: string;
    let stat: fs.Stats;
    try {
      stat = fs.statSync(file.filePath);
      raw = fs.readFileSync(file.filePath, 'utf-8');
    } catch {
      return false;
    }
    let json: any;
    try { json = JSON.parse(raw); } catch { return false; }

    let changed = false;
    for (const servers of file.serverTables(json)) {
      for (const server of Object.values(servers)) {
        if (!server || !Array.isArray(server.args)) { continue; }
        server.args = server.args.map((arg: unknown) => {
          if (typeof arg === 'string' && VERSIONED_ENTRY.test(arg)) { changed = true; return launcher; }
          return arg;
        });
      }
    }
    if (!changed) { return false; }

    const indent = /^[ \t]+(?=")/m.exec(raw)?.[0] ?? '  ';
    const eol = raw.includes('\r\n') ? '\r\n' : '\n';
    let output = JSON.stringify(json, null, indent);
    if (eol === '\r\n') { output = output.replace(/\n/g, '\r\n'); }
    if (/\r?\n$/.test(raw)) { output += eol; }
    try {
      if (replaceFile(file.filePath, output, { mtimeMs: stat.mtimeMs, size: stat.size })) { return true; }
    } catch {
      return false;
    }
    // Changed underneath us (e.g. the agent saved it): read again and retry.
  }
  return false;
}

// Rewrites versioned CodeLens entries in every known agent config. Returns the
// files that changed.
export function migrateAgentConfigs(home = os.homedir(), workspaceRoot?: string): string[] {
  const launcher = launcherConfigPath(home);
  return agentConfigFiles(home, workspaceRoot)
    .filter(file => migrateConfigFile(file, launcher))
    .map(file => file.filePath);
}
