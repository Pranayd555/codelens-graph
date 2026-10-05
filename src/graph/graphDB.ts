// sql.js ships as CommonJS — use require()
type Database = import('sql.js').Database;
import * as path from 'path';
import * as fs from 'fs';
import {
  GraphNode, GraphEdge, GraphSnapshot, GraphStats, NodeType, EdgeType, CallReference
} from '../types';
import { PackageInfo } from '../ingestion/dependencyManifest';
import {
  isConfigPath, isNodeModulePath, matchPathFilter, compileSearchRegex, regexTestCapped
} from '../utils';

const SEARCH_TIME_BUDGET_MS = 3000;

// ─── Schema ───────────────────────────────────────────────────────────────────
// Storage is keyed by integers and workspace-relative paths. Earlier versions
// stored absolute-path string ids in every row and index (a node id is
// "<absolute path>::<name>::<line>", an edge id concatenated two of them), which
// made the DB ~5x larger — and sql.js keeps the whole DB, plus a full copy on
// every save, in memory. The public API still speaks string ids: they are
// rebuilt from (file path, key) on read.

const SCHEMA_VERSION = '2';

const SCHEMA = `
  -- Path dictionary shared by nodes, call refs and the text index.
  -- Paths are workspace-relative (absolute if outside the workspace).
  CREATE TABLE IF NOT EXISTS files (
    id    INTEGER PRIMARY KEY,
    path  TEXT UNIQUE NOT NULL
  );

  CREATE TABLE IF NOT EXISTS nodes (
    nid             INTEGER PRIMARY KEY,
    file_id         INTEGER NOT NULL,
    key             TEXT NOT NULL,        -- node id without its "<file path>::" prefix
    type            TEXT NOT NULL,
    name            TEXT NOT NULL,
    line            INTEGER NOT NULL,
    end_line        INTEGER NOT NULL,
    language        TEXT NOT NULL,
    signature       TEXT,
    return_type     TEXT,
    params          TEXT,
    modifiers       TEXT,
    doc_comment     TEXT,
    undefined_refs  TEXT,
    local_vars      TEXT,
    instantiates    TEXT,
    size            INTEGER,
    last_modified   INTEGER,
    hash            TEXT,
    updated_at      INTEGER NOT NULL
  );

  -- origin: 0 = parsed, 1 = resolved call (ref_id = call_refs.rid), 2 = resolved import
  CREATE TABLE IF NOT EXISTS edges (
    eid       INTEGER PRIMARY KEY,
    from_nid  INTEGER NOT NULL,
    to_nid    INTEGER NOT NULL,
    type      TEXT NOT NULL,
    ref_id    INTEGER NOT NULL DEFAULT 0,
    origin    INTEGER NOT NULL DEFAULT 0,
    metadata  TEXT
  );

  CREATE TABLE IF NOT EXISTS call_refs (
    rid         INTEGER PRIMARY KEY,
    from_nid    INTEGER NOT NULL,
    file_id     INTEGER NOT NULL,
    ref_key     TEXT NOT NULL,            -- call ref id without its "<from node id>::" prefix
    symbol_name TEXT NOT NULL,
    qualifier   TEXT,
    line        INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS snapshots (
    id               TEXT PRIMARY KEY,
    timestamp        INTEGER NOT NULL,
    agent_run_id     TEXT,
    node_count       INTEGER NOT NULL,
    edge_count       INTEGER NOT NULL,
    changed_node_ids TEXT,
    added_node_ids   TEXT,
    removed_node_ids TEXT
  );

  CREATE TABLE IF NOT EXISTS file_lines (
    file_id     INTEGER NOT NULL,
    line        INTEGER NOT NULL,
    raw_text    TEXT NOT NULL,
    token_type  TEXT NOT NULL,
    PRIMARY KEY (file_id, line)
  );

  CREATE UNIQUE INDEX IF NOT EXISTS idx_nodes_key      ON nodes(file_id, key);
  CREATE INDEX IF NOT EXISTS idx_nodes_type            ON nodes(type);
  CREATE INDEX IF NOT EXISTS idx_nodes_name            ON nodes(name);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_edges_key      ON edges(from_nid, to_nid, type, ref_id);
  CREATE INDEX IF NOT EXISTS idx_edges_to              ON edges(to_nid);
  CREATE INDEX IF NOT EXISTS idx_edges_ref             ON edges(ref_id);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_call_refs_key  ON call_refs(from_nid, ref_key);
  CREATE INDEX IF NOT EXISTS idx_call_refs_symbol      ON call_refs(symbol_name);
  CREATE INDEX IF NOT EXISTS idx_call_refs_file        ON call_refs(file_id);

  CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT
  );

  -- Direct dependencies declared by workspace package.json files (see
  -- dependencyManifest.ts). Paths are workspace-relative.
  CREATE TABLE IF NOT EXISTS packages (
    name           TEXT PRIMARY KEY,
    declared_range TEXT,
    kind           TEXT,
    declared_in    TEXT,
    installed      INTEGER NOT NULL,
    version        TEXT,
    dir            TEXT,
    types          TEXT,
    main           TEXT,
    readme         TEXT
  );
`;

const NODE_COLUMNS = `n.nid, n.file_id, n.key, n.type, n.name, n.line, n.end_line, n.language, n.signature,
  n.return_type, n.params, n.modifiers, n.doc_comment, n.undefined_refs, n.local_vars, n.instantiates,
  n.size, n.last_modified, n.hash, n.updated_at, f.path AS fpath`;
const NODE_SELECT = `SELECT ${NODE_COLUMNS} FROM nodes n JOIN files f ON f.id = n.file_id`;
const EDGE_SELECT = `
  SELECT e.from_nid, e.to_nid, e.type, e.ref_id, e.metadata,
         a.key AS akey, a.file_id AS afile, fa.path AS apath,
         b.key AS bkey, b.file_id AS bfile, fb.path AS bpath
  FROM edges e
  JOIN nodes a  ON a.nid  = e.from_nid JOIN files fa ON fa.id = a.file_id
  JOIN nodes b  ON b.nid  = e.to_nid   JOIN files fb ON fb.id = b.file_id`;

// A key that is not "<file path>::…" (an id in an unexpected format) is stored
// whole behind this marker.
const RAW_ID_MARKER = '\u0000';

export interface FileLine {
  filePath: string;
  line: number;
  rawText: string;
  tokenType: string;
}

// ─── Relationship resolution helpers ─────────────────────────────────────────

const IMPORT_EXTENSIONS = ['.ts','.tsx','.js','.jsx','.mjs','.py','.go','.rs','.java','.cs','.cpp','.c','.rb','.php','.swift','.kt'];

// A full resolve can take seconds on large workspaces; it commits and hands
// the shared extension-host thread back this often.
const RESOLVE_YIELD_INTERVAL_MS = 25;
const yieldToEventLoop = () => new Promise<void>(resolve => setImmediate(resolve));

type Statement = import('sql.js').Statement;

// Per-resolve-pass memoization; the graph does not change while a pass runs.
interface ResolveCache {
  importPaths:  Map<string, string | null>;
  nodesByName:  Map<string, GraphNode[]>;
  nodesByFile:  Map<string, GraphNode[]>;
  wordPatterns: Map<string, RegExp>;
}

// A stored call reference, with the integer keys the resolver works with.
interface CallRefRow {
  rid: number;
  fromNid: number;
  filePath: string;
  symbolName: string;
  qualifier?: string;
}

// The path an import source points at, before trying extensions / index files.
function importBase(importerPath: string, source: string): string | null {
  if (!source) { return null; }
  const importerDir = path.dirname(importerPath);
  if (source.startsWith('.')) { return path.resolve(importerDir, source); }
  if (source.includes('.') && !source.includes('/') && !source.includes('\\')) {
    return path.resolve(importerDir, source.replace(/\./g, path.sep));
  }
  return null;
}

// Every import base that could resolve to filePath (inverse of resolveImportPath).
function importBasesFor(filePath: string): string[] {
  const bases = [filePath];
  const ext = path.extname(filePath);
  if (IMPORT_EXTENSIONS.includes(ext)) {
    bases.push(filePath.slice(0, -ext.length));
    if (path.basename(filePath, ext) === 'index') { bases.push(path.dirname(filePath)); }
  }
  if (path.basename(filePath) === '__init__.py') { bases.push(path.dirname(filePath)); }
  return bases;
}

function pathKey(p: string): string {
  const normalized = path.normalize(p);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

// ─── GraphDB ──────────────────────────────────────────────────────────────────

export class GraphDB {
  private db!: Database;
  private dbPath: string;
  private root: string | null;
  private SQL!: any;
  private fileVersion = '';
  private dirty = false;
  // Relationship (call/import edge) freshness. Graph writes set writesSinceResolve;
  // an incremental resolve clears it for the files it covered. fullResolvePending is
  // persisted in `meta` so a scan interrupted after an intermediate persist is fully
  // resolved on the next startup, even though its files then look unchanged.
  private writesSinceResolve = false;
  private fullResolvePending = false;
  private resolveTransactionOpen = false;
  // Stats queries scan every node and edge; they are cached until the next
  // write (writeCount) or reload from disk (version).
  private writeCount = 0;
  private undefinedRefCount: { key: string; count: number } | null = null;
  private statsCache: { key: string; stats: Omit<GraphStats, 'lastBuilt' | 'buildDurationMs'> } | null = null;
  private initPromise: Promise<void> | null = null;
  private version = 0;
  private rebuiltForUpgrade = false;

  // files.id <-> path caches (cleared whenever the DB is replaced).
  private fileIds   = new Map<string, number>();   // stored path → id
  private filePaths = new Map<number, string>();   // id → absolute path
  // Integer key of each node object handed out, for internal use (resolver, edges).
  private nids = new WeakMap<GraphNode, number>();
  // Node id → nid for the nodes written by the latest upsertNodes call, so the
  // edges and call refs of the same parse don't each need a lookup.
  private recentNids = new Map<string, number>();

  private cacheKey(scope: string): string {
    return `${scope}:${this.version}:${this.writeCount}`;
  }

  // followExternalWrites: reload when another process rewrites the file. The
  // MCP server (a reader) needs this; the extension owns and writes the file,
  // so it must not adopt a file written elsewhere (e.g. by an MCP server from a
  // different CodeLens version) — its in-memory graph stays authoritative and
  // is written back on the next save.
  private followExternalWrites: boolean;

  constructor(storagePath: string, options: { followExternalWrites?: boolean } = {}) {
    this.dbPath = path.join(storagePath, 'codelens-graph.db');
    this.root = this.getWorkspaceRoot();
    this.followExternalWrites = options.followExternalWrites ?? true;
  }

  isInitialized(): boolean {
    return this.initPromise !== null && this.db !== undefined;
  }

  getVersion(): number {
    return this.version;
  }

  // True when init() found a DB in an older storage format and started a new
  // one (the next scan re-indexes the workspace).
  wasRebuiltForUpgrade(): boolean {
    return this.rebuiltForUpgrade;
  }

  // The DB lives at <workspace>/.codelens/, so the workspace is two levels up.
  // Returns null for a DB stored elsewhere (e.g. global storage, no folder open).
  getWorkspaceRoot(): string | null {
    const storageDir = path.dirname(this.dbPath);
    return path.basename(storageDir) === '.codelens' ? path.dirname(storageDir) : null;
  }

  async init(): Promise<void> {
    if (this.initPromise) { return this.initPromise; }

    this.initPromise = (async () => {
      // Resolve WASM file relative to bundle output (dist/wasm/) or node_modules
      const wasmDir = (() => {
        const distWasm = require('path').join(__dirname, 'wasm');
        const nmWasm   = require('path').join(__dirname, '..', '..', 'node_modules', 'sql.js', 'dist');
        return require('fs').existsSync(require('path').join(distWasm, 'sql-wasm.wasm')) ? distWasm : nmWasm;
      })();

      const initSqlJs = require('sql.js') as typeof import('sql.js').default;
      this.SQL = await initSqlJs({
        locateFile: (file: string) => require('path').join(wasmDir, file),
      });
      if (fs.existsSync(this.dbPath)) {
        try {
          // Record which on-disk version was loaded (stat before read), so the
          // first refreshFromDiskIfChanged() doesn't reload the whole file again.
          const loadedVersion = this.getFileVersion();
          const data = fs.readFileSync(this.dbPath);
          this.db = new this.SQL.Database(data);
          this.fileVersion = loadedVersion;

          if (!this.hasCurrentSchema(this.db)) {
            console.log('[CodeLens] Graph storage format changed — rebuilding the index once.');
            this.db.close();
            try { fs.unlinkSync(this.dbPath); } catch { /* ignore */ }
            this.db = new this.SQL.Database();
            this.fileVersion = '';
            this.rebuiltForUpgrade = true;
          }
        } catch (err) {
          console.warn(`[CodeLens] Failed to load database from disk (${this.dbPath}), falling back to a fresh DB:`, err);
          this.db = new this.SQL.Database();
        }
      } else {
        this.db = new this.SQL.Database();
      }
      this.db.run(SCHEMA);
      this.db.run(`INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?)`, [SCHEMA_VERSION]);
      this.clearCaches();
      this.loadMeta();
      this.version++;
      // DO NOT call this.persist() on init — avoid redundant slow write when no changes were made.
    })();

    return this.initPromise;
  }

  // An existing DB is current if its nodes table is integer-keyed (or it has
  // no graph tables yet).
  private hasCurrentSchema(db: Database): boolean {
    try {
      const tables = db.exec(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'nodes'`);
      if (!tables.length || !tables[0].values.length) { return true; }
      const columns = (db.exec('PRAGMA table_info(nodes)')[0]?.values ?? []).map(v => v[1]);
      return columns.includes('nid') && columns.includes('file_id');
    } catch {
      return false;
    }
  }

  async ensureInit(): Promise<void> {
    if (!this.initPromise) {
      await this.init();
    }
    return this.initPromise!;
  }

  private loadMeta(): void {
    const value = this.db.exec(`SELECT value FROM meta WHERE key = 'relationships_stale'`)[0]?.values[0]?.[0];
    if (value === undefined) {
      // DB written by a version without this flag: resolve once if it has data.
      const count = this.db.exec('SELECT COUNT(*) FROM nodes')[0]?.values[0]?.[0] ?? 0;
      this.fullResolvePending = Number(count) > 0;
    } else {
      this.fullResolvePending = value === '1';
    }
    this.writesSinceResolve = false;
  }

  needsRelationshipResolve(): boolean {
    return this.fullResolvePending || this.writesSinceResolve;
  }

  persist(): void {
    this.db.run(
      `INSERT OR REPLACE INTO meta (key, value) VALUES ('relationships_stale', ?)`,
      [this.needsRelationshipResolve() ? '1' : '0']
    );
    const data = this.db.export();
    const storageDir = path.dirname(this.dbPath);
    fs.mkdirSync(storageDir, { recursive: true });
    // Keep the index out of git without editing the user's root .gitignore.
    const nestedIgnore = path.join(storageDir, '.gitignore');
    if (path.basename(storageDir) === '.codelens' && !fs.existsSync(nestedIgnore)) {
      try { fs.writeFileSync(nestedIgnore, '*\n', 'utf-8'); } catch { /* best effort */ }
    }
    fs.writeFileSync(this.dbPath, data);
    this.dirty = false;
    this.fileVersion = this.getFileVersion();
    this.version++;
  }

  close(): void {
    if (this.db) {
      if (this.resolveTransactionOpen) {
        // Closing during a yielded resolve: drop the open chunk. The relationship
        // flags stay set, so the next startup resolves again.
        try { this.db.run('ROLLBACK'); } catch { /* ignore */ }
        this.resolveTransactionOpen = false;
      }
      if (this.dirty) {
        try { this.persist(); } catch {}
      }
      try { this.db.close(); } catch {}
      this.db = undefined as any;
    }
    this.clearCaches();
    this.initPromise = null;
    this.dirty = false;
  }

  // sql.js keeps the database in process memory. The extension writes the
  // workspace-local DB while MCP reads it from another process, so readers
  // must reload when the file changes instead of serving a stale snapshot.
  refreshFromDiskIfChanged(): boolean {
    if (!this.db) {
      throw new Error('Database not initialized. Ensure init() has completed successfully.');
    }
    if (!this.followExternalWrites || this.dirty || !fs.existsSync(this.dbPath)) { return false; }
    const currentVersion = this.getFileVersion();
    if (!currentVersion || currentVersion === this.fileVersion) { return false; }

    try {
      const data = fs.readFileSync(this.dbPath);
      const replacement = new this.SQL.Database(data);
      if (!this.hasCurrentSchema(replacement)) {
        // Written by a different CodeLens version: don't load a format we can't read.
        replacement.close();
        this.fileVersion = currentVersion;
        console.warn('[CodeLens] Ignoring graph DB written in an older format by another process.');
        return false;
      }
      this.db.close();
      this.db = replacement;
      this.db.run(SCHEMA);
      this.clearCaches();
      this.loadMeta();
      this.fileVersion = currentVersion;
      this.version++;
      return true;
    } catch (err) {
      console.warn(`[CodeLens] Failed to reload database from disk (${this.dbPath}):`, err);
      return false;
    }
  }

  private getFileVersion(): string {
    try {
      const stat = fs.statSync(this.dbPath);
      return `${stat.mtimeMs}:${stat.size}`;
    } catch {
      return '';
    }
  }

  private prepareWrite(): void {
    if (!this.db) {
      throw new Error('Database not initialized. Ensure init() has completed successfully.');
    }
    this.refreshFromDiskIfChanged();
    this.dirty = true;
    this.writeCount++;
  }

  // ── Paths and ids ─────────────────────────────────────────────────────────

  private clearCaches(): void {
    this.fileIds.clear();
    this.filePaths.clear();
    this.recentNids.clear();
  }

  private toStoredPath(absPath: string): string {
    if (!this.root) { return absPath; }
    const rel = path.relative(this.root, absPath);
    return !rel || rel.startsWith('..') || path.isAbsolute(rel) ? absPath : rel;
  }

  private toAbsPath(stored: string): string {
    return !this.root || path.isAbsolute(stored) ? stored : path.join(this.root, stored);
  }

  private absPathOf(fileId: number, stored: string): string {
    let abs = this.filePaths.get(fileId);
    if (abs === undefined) {
      abs = this.toAbsPath(stored);
      this.filePaths.set(fileId, abs);
      this.fileIds.set(stored, fileId);
    }
    return abs;
  }

  private fileIdFor(absPath: string, create: boolean): number | null {
    const stored = this.toStoredPath(absPath);
    let id = this.fileIds.get(stored);
    if (id !== undefined) { return id; }
    const found = this.db.exec('SELECT id FROM files WHERE path = ?', [stored])[0]?.values[0]?.[0];
    if (found !== undefined) {
      id = Number(found);
    } else if (create) {
      this.db.run('INSERT INTO files (path) VALUES (?)', [stored]);
      id = Number(this.db.exec('SELECT last_insert_rowid()')[0].values[0][0]);
    } else {
      return null;
    }
    this.fileIds.set(stored, id);
    this.filePaths.set(id, this.toAbsPath(stored));
    return id;
  }

  private forgetFile(fileId: number): void {
    const abs = this.filePaths.get(fileId);
    if (abs !== undefined) { this.fileIds.delete(this.toStoredPath(abs)); }
    this.filePaths.delete(fileId);
  }

  // Splits a node id into the part after its "<file path>::" prefix.
  private keyFor(id: string, filePath: string): string {
    return id.startsWith(filePath + '::') ? id.slice(filePath.length + 2) : RAW_ID_MARKER + id;
  }

  private idFrom(key: string, fileId: number, storedPath: string): string {
    return key.startsWith(RAW_ID_MARKER) ? key.slice(1) : `${this.absPathOf(fileId, storedPath)}::${key}`;
  }

  // Node id → nid. Ids are "<absolute file path>::<key>"; file paths never
  // contain "::", so the first prefix naming a known file is the right one.
  private nidOf(id: string): number | null {
    const recent = this.recentNids.get(id);
    if (recent !== undefined) { return recent; }
    for (let idx = id.indexOf('::'); idx !== -1; idx = id.indexOf('::', idx + 2)) {
      const fileId = this.fileIdFor(id.slice(0, idx), false);
      if (fileId === null) { continue; }
      const nid = this.db.exec('SELECT nid FROM nodes WHERE file_id = ? AND key = ?', [fileId, id.slice(idx + 2)])[0]?.values[0]?.[0];
      if (nid !== undefined) { return Number(nid); }
    }
    const raw = this.db.exec('SELECT nid FROM nodes WHERE key = ?', [RAW_ID_MARKER + id])[0]?.values[0]?.[0];
    return raw === undefined ? null : Number(raw);
  }

  // ── Node operations ───────────────────────────────────────────────────────

  upsertNode(node: GraphNode): void {
    this.upsertNodes([node]);
  }

  upsertNodes(nodes: GraphNode[]): void {
    this.prepareWrite();
    this.recentNids.clear();
    if (!nodes.length) { return; }
    this.writesSinceResolve = true;
    this.db.run('BEGIN');
    try {
      const stmt = this.db.prepare(`
        INSERT INTO nodes
          (file_id,key,type,name,line,end_line,language,signature,return_type,
           params,modifiers,doc_comment,undefined_refs,local_vars,instantiates,
           size,last_modified,hash,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(file_id, key) DO UPDATE SET
          type=excluded.type, name=excluded.name,
          line=excluded.line, end_line=excluded.end_line, language=excluded.language,
          signature=excluded.signature, return_type=excluded.return_type,
          params=excluded.params, modifiers=excluded.modifiers,
          doc_comment=excluded.doc_comment, undefined_refs=excluded.undefined_refs,
          local_vars=excluded.local_vars, instantiates=excluded.instantiates,
          size=excluded.size, last_modified=excluded.last_modified,
          hash=excluded.hash, updated_at=excluded.updated_at
        RETURNING nid
      `);
      try {
        for (const node of nodes) {
          const fileId = this.fileIdFor(node.filePath, true)!;
          stmt.bind([
            fileId, this.keyFor(node.id, node.filePath), node.type, node.name,
            node.line, node.endLine, node.language,
            node.signature ?? null, node.returnType ?? null,
            node.params        ? JSON.stringify(node.params)        : null,
            node.modifiers     ? JSON.stringify(node.modifiers)     : null,
            node.docComment    ?? null,
            node.undefinedRefs ? JSON.stringify(node.undefinedRefs) : null,
            node.localVars     ? JSON.stringify(node.localVars)     : null,
            node.instantiates  ? JSON.stringify(node.instantiates)  : null,
            node.size ?? null, node.lastModified ?? null,
            node.hash ?? null, node.updatedAt,
          ]);
          if (stmt.step()) { this.recentNids.set(node.id, Number(stmt.get()[0])); }
          stmt.reset();
        }
      } finally {
        stmt.free();
      }
      this.db.run('COMMIT');
    } catch (e) {
      this.db.run('ROLLBACK');
      this.recentNids.clear();
      throw e;
    }
  }

  getNode(id: string): GraphNode | null {
    this.refreshFromDiskIfChanged();
    const nid = this.nidOf(id);
    return nid === null ? null : this.queryNodes(`${NODE_SELECT} WHERE n.nid = ?`, [nid])[0] ?? null;
  }

  getNodesByFile(filePath: string): GraphNode[] {
    this.refreshFromDiskIfChanged();
    const fileId = this.fileIdFor(filePath, false);
    if (fileId === null) { return []; }
    return this.queryNodes(`${NODE_SELECT} WHERE n.file_id = ? ORDER BY n.line, n.nid`, [fileId]);
  }

  getNodesByType(type: NodeType): GraphNode[] {
    this.refreshFromDiskIfChanged();
    return this.queryNodes(`${NODE_SELECT} WHERE n.type = ? ORDER BY n.name, n.nid`, [type]);
  }

  private queryNodes(sql: string, params: unknown[] = []): GraphNode[] {
    const stmt = this.db.prepare(sql);
    if (params.length) { stmt.bind(params as any[]); }
    const results: GraphNode[] = [];
    while (stmt.step()) { results.push(this.rowToNode(stmt.getAsObject())); }
    stmt.free();
    return results;
  }

  // Nodes that have undefined references — pre-diagnosed issues
  // Same count as getNodesWithUndefinedRefs('workspace').length, but reads only
  // the columns it needs and is cached until the graph next changes.
  // The stats panel asks for it after every update.
  countNodesWithUndefinedRefs(): number {
    this.refreshFromDiskIfChanged();
    const key = this.cacheKey('undefined-refs');
    if (this.undefinedRefCount?.key === key) { return this.undefinedRefCount.count; }

    const definedNames = this.definedSymbolNames();
    let count = 0;
    const stmt = this.db.prepare(
      `SELECT n.file_id, f.path, n.undefined_refs FROM nodes n JOIN files f ON f.id = n.file_id
       WHERE n.undefined_refs IS NOT NULL AND n.undefined_refs != '[]'`
    );
    while (stmt.step()) {
      const [fileId, stored, refsJson] = stmt.get() as [number, string, string];
      const filePath = this.absPathOf(fileId, stored);
      if (isNodeModulePath(filePath) || isConfigPath(filePath)) { continue; }
      let refs: unknown;
      try { refs = JSON.parse(refsJson); } catch { continue; }
      if (Array.isArray(refs) && refs.some(ref => !definedNames.has(ref))) { count++; }
    }
    stmt.free();

    this.undefinedRefCount = { key, count };
    return count;
  }

  private definedSymbolNames(): Set<string> {
    const names = new Set<string>();
    const stmt = this.db.prepare(`SELECT DISTINCT name FROM nodes WHERE type NOT IN ('file', 'import')`);
    while (stmt.step()) {
      const name = stmt.get()[0];
      if (name) { names.add(String(name).trim()); }
    }
    stmt.free();
    return names;
  }

  getNodesWithUndefinedRefs(scope: 'workspace' | 'all' = 'workspace'): GraphNode[] {
    this.refreshFromDiskIfChanged();
    const definedNames = this.definedSymbolNames();
    const results: GraphNode[] = [];
    for (const node of this.queryNodes(
      `${NODE_SELECT} WHERE n.undefined_refs IS NOT NULL AND n.undefined_refs != '[]' ORDER BY f.path, n.line, n.nid`
    )) {
      if (node.undefinedRefs && node.undefinedRefs.length > 0) {
        const filteredRefs = node.undefinedRefs.filter(ref => !definedNames.has(ref));
        if (filteredRefs.length > 0) {
          node.undefinedRefs = filteredRefs;
          results.push(node);
        }
      }
    }

    if (scope === 'all') { return results; }
    return results.filter(n => !isNodeModulePath(n.filePath) && !isConfigPath(n.filePath));
  }

  searchNodes(query: string, limit = 20, scope: 'workspace' | 'deps' | 'all' = 'workspace'): GraphNode[] {
    this.refreshFromDiskIfChanged();

    // Normalize and decode query
    let decoded = query;
    try {
      decoded = decodeURIComponent(query);
    } catch {}
    decoded = decoded.trim();

    // Split on pipe (|) if present
    const tokens = decoded.split('|')
      .map(t => t.trim())
      .filter(t => t.length >= 2 && /\w+/.test(t));

    if (tokens.length === 0) {
      return [];
    }

    let scopeSql = '';
    if (scope === 'workspace') {
      scopeSql = "AND f.path NOT LIKE '%node_modules%'";
    } else if (scope === 'deps') {
      scopeSql = "AND (f.path LIKE '%node_modules%' OR f.path LIKE '%.json' OR f.path LIKE '%.md')";
    }

    const conditions: string[] = [];
    const bindParams: any[] = [];
    for (const token of tokens) {
      conditions.push('(lower(n.name) LIKE lower(?) OR lower(n.signature) LIKE lower(?) OR lower(n.doc_comment) LIKE lower(?))');
      const likeParam = `%${token}%`;
      bindParams.push(likeParam, likeParam, likeParam);
    }

    // ORDER BY logic: prioritize exact name match for the first token, or generally matching name
    const orderSql = `
      ORDER BY
        CASE WHEN lower(n.name) = lower(?) THEN 0
             WHEN lower(n.name) LIKE lower(?) THEN 1
             ELSE 2 END, n.name, n.nid
    `;
    bindParams.push(tokens[0], `${tokens[0]}%`);

    // The config-file filter below runs in JS, so the limit is applied after
    // it — otherwise config files could use up the limit and hide symbols.
    const sql = `${NODE_SELECT} WHERE (${conditions.join(' OR ')}) ${scopeSql} ${orderSql}`;
    const keep = (n: GraphNode) =>
      scope === 'workspace' ? !isConfigPath(n.filePath)
      : scope === 'deps' ? (isNodeModulePath(n.filePath) || isConfigPath(n.filePath))
      : true;

    const stmt = this.db.prepare(sql);
    stmt.bind(bindParams);
    const results: GraphNode[] = [];
    while (results.length < limit && stmt.step()) {
      const node = this.rowToNode(stmt.getAsObject());
      if (keep(node)) { results.push(node); }
    }
    stmt.free();
    return results;
  }

  // ── Dependency manifest ───────────────────────────────────────────────────

  // Replaces the stored manifest. Returns false (and writes nothing) when it is
  // unchanged, so refreshing it after every scan doesn't force a DB write.
  replacePackages(packages: PackageInfo[]): boolean {
    const root = this.root;
    const rel = (p: string | null) => (p && root ? path.relative(root, p).split(path.sep).join('/') : p);
    const rows = packages.map(p => [
      p.name, p.declaredRange, p.kind, JSON.stringify(p.declaredIn.map(rel)), p.installed ? 1 : 0,
      p.version, rel(p.dir), rel(p.types), rel(p.main), rel(p.readme),
    ]);
    const current = this.db.exec('SELECT name, declared_range, kind, declared_in, installed, version, dir, types, main, readme FROM packages ORDER BY name')[0]?.values ?? [];
    if (JSON.stringify(current) === JSON.stringify([...rows].sort((a, b) => String(a[0]).localeCompare(String(b[0]))))) {
      return false;
    }

    this.prepareWrite();
    this.db.run('BEGIN');
    try {
      this.db.run('DELETE FROM packages');
      const insert = this.db.prepare('INSERT INTO packages VALUES (?,?,?,?,?,?,?,?,?,?)');
      for (const row of rows) { insert.run(row as any[]); }
      insert.free();
      this.db.run('COMMIT');
    } catch (e) {
      this.db.run('ROLLBACK');
      throw e;
    }
    return true;
  }

  getPackages(): PackageInfo[] {
    this.refreshFromDiskIfChanged();
    const root = this.root;
    const abs = (p: unknown) => (typeof p === 'string' && p ? (root ? path.join(root, p) : p) : null);
    const res = this.db.exec('SELECT name, declared_range, kind, declared_in, installed, version, dir, types, main, readme FROM packages ORDER BY name');
    return (res[0]?.values ?? []).map(r => ({
      name: String(r[0]),
      declaredRange: String(r[1] ?? ''),
      kind: String(r[2]) as PackageInfo['kind'],
      declaredIn: (JSON.parse(String(r[3] ?? '[]')) as string[]).map(p => abs(p) ?? p),
      installed: r[4] === 1,
      version: r[5] === null ? null : String(r[5]),
      dir: abs(r[6]),
      types: abs(r[7]),
      main: abs(r[8]),
      readme: abs(r[9]),
    }));
  }

  // Workspace files with an import of the package (or one of its subpaths).
  getFilesImporting(packageName: string): string[] {
    this.refreshFromDiskIfChanged();
    const stmt = this.db.prepare(
      `SELECT DISTINCT f.id, f.path FROM nodes n JOIN files f ON f.id = n.file_id
       WHERE n.type = 'import' AND (n.name = ? OR substr(n.name, 1, ?) = ?)
       ORDER BY f.path`
    );
    stmt.bind([packageName, packageName.length + 1, packageName + '/']);
    const files: string[] = [];
    while (stmt.step()) {
      const [fileId, stored] = stmt.get() as [number, string];
      files.push(this.absPathOf(fileId, stored));
    }
    stmt.free();
    return files;
  }

  // Returns whether the file had any nodes. Only then are relationships marked
  // stale — re-parsing an empty file must not force a full resolve.
  deleteNodesByFile(filePath: string): boolean {
    this.prepareWrite();
    const fileId = this.fileIdFor(filePath, false);
    if (fileId === null) { return false; }
    const count = Number(this.db.exec('SELECT COUNT(*) FROM nodes WHERE file_id = ?', [fileId])[0]?.values[0]?.[0] ?? 0);
    if (count) {
      this.writesSinceResolve = true;
      // No FK cascade in sql.js: drop edges and call refs touching these nodes first.
      this.db.run(`DELETE FROM edges WHERE from_nid IN (SELECT nid FROM nodes WHERE file_id = ?)
                                    OR to_nid IN (SELECT nid FROM nodes WHERE file_id = ?)`, [fileId, fileId]);
      this.db.run('DELETE FROM call_refs WHERE from_nid IN (SELECT nid FROM nodes WHERE file_id = ?)', [fileId]);
      this.db.run('DELETE FROM nodes WHERE file_id = ?', [fileId]);
    }
    this.db.run('DELETE FROM file_lines WHERE file_id = ?', [fileId]);
    this.dropFileIfUnused(fileId);
    for (const [id] of this.recentNids) { if (id.startsWith(filePath + '::')) { this.recentNids.delete(id); } }
    return count > 0;
  }

  private dropFileIfUnused(fileId: number): void {
    this.db.run(`DELETE FROM files WHERE id = ?
                   AND NOT EXISTS (SELECT 1 FROM nodes WHERE file_id = ?)
                   AND NOT EXISTS (SELECT 1 FROM call_refs WHERE file_id = ?)
                   AND NOT EXISTS (SELECT 1 FROM file_lines WHERE file_id = ?)`, [fileId, fileId, fileId, fileId]);
    if (this.db.getRowsModified() > 0) { this.forgetFile(fileId); }
  }

  getAllFiles(scope: 'workspace' | 'deps' | 'all' = 'workspace'): string[] {
    this.refreshFromDiskIfChanged();
    return this.indexedFiles(scope).map(f => f.path);
  }

  // Files that have a file node, as [id, absolute path], ordered by path.
  private indexedFiles(scope: 'workspace' | 'deps' | 'all'): Array<{ id: number; path: string }> {
    const stmt = this.db.prepare(
      `SELECT DISTINCT f.id, f.path FROM nodes n JOIN files f ON f.id = n.file_id WHERE n.type = 'file' ORDER BY f.path`
    );
    const results: Array<{ id: number; path: string }> = [];
    while (stmt.step()) {
      const [fileId, stored] = stmt.get() as [number, string];
      results.push({ id: fileId, path: this.absPathOf(fileId, stored) });
    }
    stmt.free();

    if (scope === 'all') { return results; }
    return results.filter(({ path: fp }) => {
      const isNm = isNodeModulePath(fp);
      const isCfg = isConfigPath(fp);
      return scope === 'workspace' ? (!isNm && !isCfg) : (isNm || isCfg);
    });
  }

  // ── Edge operations ───────────────────────────────────────────────────────

  upsertEdge(edge: GraphEdge): void {
    this.upsertEdges([edge]);
  }

  // Edges whose endpoints are not stored nodes are skipped.
  upsertEdges(edges: GraphEdge[]): void {
    this.prepareWrite();
    if (!edges.length) { return; }
    this.writesSinceResolve = true;
    this.db.run('BEGIN');
    try {
      const stmt = this.db.prepare(
        'INSERT OR REPLACE INTO edges (from_nid,to_nid,type,ref_id,origin,metadata) VALUES (?,?,?,0,0,?)'
      );
      try {
        for (const edge of edges) {
          const fromNid = this.nidOf(edge.fromId);
          const toNid = this.nidOf(edge.toId);
          if (fromNid === null || toNid === null) { continue; }
          stmt.run([fromNid, toNid, edge.type, edge.metadata ? JSON.stringify(edge.metadata) : null]);
        }
      } finally {
        stmt.free();
      }
      this.db.run('COMMIT');
    } catch (e) {
      this.db.run('ROLLBACK');
      throw e;
    }
  }

  getEdgesFrom(nodeId: string, type?: EdgeType): GraphEdge[] {
    this.refreshFromDiskIfChanged();
    const nid = this.nidOf(nodeId);
    if (nid === null) { return []; }
    return type
      ? this.queryEdges(`${EDGE_SELECT} WHERE e.from_nid = ? AND e.type = ? ORDER BY e.eid`, [nid, type])
      : this.queryEdges(`${EDGE_SELECT} WHERE e.from_nid = ? ORDER BY e.eid`, [nid]);
  }

  getEdgesTo(nodeId: string, type?: EdgeType): GraphEdge[] {
    this.refreshFromDiskIfChanged();
    const nid = this.nidOf(nodeId);
    if (nid === null) { return []; }
    return type
      ? this.queryEdges(`${EDGE_SELECT} WHERE e.to_nid = ? AND e.type = ? ORDER BY e.eid`, [nid, type])
      : this.queryEdges(`${EDGE_SELECT} WHERE e.to_nid = ? ORDER BY e.eid`, [nid]);
  }

  private queryEdges(sql: string, params: unknown[]): GraphEdge[] {
    const stmt = this.db.prepare(sql);
    stmt.bind(params as any[]);
    const results: GraphEdge[] = [];
    while (stmt.step()) { results.push(this.rowToEdge(stmt.getAsObject())); }
    stmt.free();
    return results;
  }

  // ── BFS traversal ─────────────────────────────────────────────────────────

  bfsExpand(seedIds: string[], depth: number): { nodes: GraphNode[]; edges: GraphEdge[] } {
    this.refreshFromDiskIfChanged();
    const visitedNodes = new Set<string>(seedIds);
    const visitedEdges = new Set<string>();
    const resultNodes: GraphNode[] = [];
    const resultEdges: GraphEdge[] = [];

    for (const id of seedIds) {
      const node = this.getNode(id);
      if (node) { resultNodes.push(node); }
    }

    let frontier = [...seedIds];

    for (let hop = 0; hop < depth; hop++) {
      const nextFrontier: string[] = [];
      for (const nodeId of frontier) {
        const allEdges = [...this.getEdgesFrom(nodeId), ...this.getEdgesTo(nodeId)];
        for (const edge of allEdges) {
          if (visitedEdges.has(edge.id)) { continue; }
          visitedEdges.add(edge.id);
          resultEdges.push(edge);
          const neighborId = edge.fromId === nodeId ? edge.toId : edge.fromId;
          if (!visitedNodes.has(neighborId)) {
            visitedNodes.add(neighborId);
            const neighbor = this.getNode(neighborId);
            if (neighbor) { resultNodes.push(neighbor); nextFrontier.push(neighborId); }
          }
        }
      }
      frontier = nextFrontier;
      if (frontier.length === 0) { break; }
    }

    return { nodes: resultNodes, edges: resultEdges };
  }

  // ── Snapshots ─────────────────────────────────────────────────────────────

  saveSnapshot(snapshot: GraphSnapshot): void {
    this.prepareWrite();
    this.db.run(`INSERT OR REPLACE INTO snapshots
      (id,timestamp,agent_run_id,node_count,edge_count,changed_node_ids,added_node_ids,removed_node_ids)
      VALUES (?,?,?,?,?,?,?,?)`, [
      snapshot.id, snapshot.timestamp, snapshot.agentRunId ?? null,
      snapshot.nodeCount, snapshot.edgeCount,
      JSON.stringify(snapshot.changedNodeIds),
      JSON.stringify(snapshot.addedNodeIds),
      JSON.stringify(snapshot.removedNodeIds),
    ]);
  }

  getSnapshots(limit = 20): GraphSnapshot[] {
    this.refreshFromDiskIfChanged();
    const stmt = this.db.prepare('SELECT * FROM snapshots ORDER BY timestamp DESC LIMIT ?');
    stmt.bind([limit]);
    const results: GraphSnapshot[] = [];
    while (stmt.step()) {
      const r = stmt.getAsObject();
      results.push({
        id: r['id'] as string, timestamp: r['timestamp'] as number,
        agentRunId:      r['agent_run_id']     as string | undefined,
        nodeCount:       r['node_count']        as number,
        edgeCount:       r['edge_count']        as number,
        changedNodeIds:  JSON.parse((r['changed_node_ids']  as string) || '[]'),
        addedNodeIds:    JSON.parse((r['added_node_ids']    as string) || '[]'),
        removedNodeIds:  JSON.parse((r['removed_node_ids']  as string) || '[]'),
      });
    }
    stmt.free(); return results;
  }

  // ── Stats ─────────────────────────────────────────────────────────────────

  getStats(scope: 'workspace' | 'all' = 'workspace'): Omit<GraphStats, 'lastBuilt' | 'buildDurationMs'> {
    this.refreshFromDiskIfChanged();
    const key = this.cacheKey('stats:' + scope);
    if (this.statsCache?.key === key) {
      const cached = this.statsCache.stats;
      return { ...cached, byType: { ...cached.byType } };
    }
    const stats = this.computeStats(scope);
    this.statsCache = { key, stats: { ...stats, byType: { ...stats.byType } } };
    return stats;
  }

  private computeStats(scope: 'workspace' | 'all'): Omit<GraphStats, 'lastBuilt' | 'buildDurationMs'> {
    if (scope === 'all') {
      const totalNodes = (this.db.exec('SELECT COUNT(*) FROM nodes')[0]?.values[0][0] ?? 0) as number;
      const totalEdges = (this.db.exec('SELECT COUNT(*) FROM edges')[0]?.values[0][0] ?? 0) as number;
      const fileCount  = (this.db.exec(`SELECT COUNT(*) FROM nodes WHERE type='file'`)[0]?.values[0][0] ?? 0) as number;
      const byTypeRows = this.db.exec('SELECT type, COUNT(*) FROM nodes GROUP BY type');
      const byType: Record<string, number> = {};
      if (byTypeRows[0]) {
        for (const row of byTypeRows[0].values) { byType[row[0] as string] = row[1] as number; }
      }
      return { totalNodes, totalEdges, fileCount, byType: byType as Record<NodeType, number> };
    }

    // Workspace scope: nodes in workspace files (not deps/configs), and edges
    // whose endpoints are both such nodes.
    const wsFileIds = new Set(this.indexedFiles('workspace').map(f => f.id));
    let totalNodes = 0;
    let fileCount = 0;
    const byType: Record<string, number> = {};
    const wsNids = new Set<number>();
    const stmt = this.db.prepare('SELECT nid, type, file_id FROM nodes');
    while (stmt.step()) {
      const [nid, type, fileId] = stmt.get() as [number, string, number];
      if (wsFileIds.has(fileId)) {
        wsNids.add(nid);
        totalNodes++;
        if (type === 'file') { fileCount++; }
        byType[type] = (byType[type] || 0) + 1;
      }
    }
    stmt.free();

    let totalEdges = 0;
    const edgeStmt = this.db.prepare('SELECT from_nid, to_nid FROM edges');
    while (edgeStmt.step()) {
      const [fromNid, toNid] = edgeStmt.get() as [number, number];
      if (wsNids.has(fromNid) && wsNids.has(toNid)) { totalEdges++; }
    }
    edgeStmt.free();

    return { totalNodes, totalEdges, fileCount, byType: byType as Record<NodeType, number> };
  }

  // ─── Durable call references and workspace relationship resolution ───────

  // Upserted by (caller, call site) so a ref keeps its rid — resolved call
  // edges are keyed by it.
  upsertCallRefs(refs: CallReference[]): void {
    if (!refs.length) { return; }
    this.prepareWrite();
    this.writesSinceResolve = true;
    this.db.run('BEGIN');
    try {
      const stmt = this.db.prepare(`
        INSERT INTO call_refs (from_nid, file_id, ref_key, symbol_name, qualifier, line)
        VALUES (?,?,?,?,?,?)
        ON CONFLICT(from_nid, ref_key) DO UPDATE SET
          file_id=excluded.file_id, symbol_name=excluded.symbol_name,
          qualifier=excluded.qualifier, line=excluded.line
      `);
      try {
        for (const ref of refs) {
          const fromNid = this.nidOf(ref.fromId);
          if (fromNid === null) { continue; }
          const refKey = ref.id.startsWith(ref.fromId + '::') ? ref.id.slice(ref.fromId.length + 2) : RAW_ID_MARKER + ref.id;
          stmt.run([fromNid, this.fileIdFor(ref.filePath, true)!, refKey, ref.symbolName, ref.qualifier ?? null, ref.line]);
        }
      } finally {
        stmt.free();
      }
      this.db.run('COMMIT');
    } catch (e) {
      this.db.run('ROLLBACK');
      throw e;
    }
  }

  // Re-resolves call and import edges. With no argument everything is rebuilt.
  // With changed files (one or a batch) only edges that could have changed are
  // touched: call refs in those files or naming the given symbols, and imports
  // in those files or whose source path points at one of them.
  async resolveWorkspaceRelationships(changedFilePaths?: string | string[], changedSymbols: string[] = []): Promise<void> {
    this.prepareWrite();
    const changedFiles = changedFilePaths === undefined
      ? null
      : (Array.isArray(changedFilePaths) ? changedFilePaths : [changedFilePaths]);
    const fullResolve = changedFiles === null;
    const cache: ResolveCache = {
      importPaths: new Map(), nodesByName: new Map(), nodesByFile: new Map(), wordPatterns: new Map(),
    };

    // Work is committed in chunks so the event loop can run in between.
    // Each chunk also invalidates cached stats (edge inserts skip prepareWrite).
    const begin = () => { this.db.run('BEGIN'); this.resolveTransactionOpen = true; this.writeCount++; };
    const commit = () => { this.db.run('COMMIT'); this.resolveTransactionOpen = false; this.writeCount++; };
    let lastYield = Date.now();
    const maybeYield = async () => {
      if (Date.now() - lastYield < RESOLVE_YIELD_INTERVAL_MS) { return; }
      commit();
      await yieldToEventLoop();
      if (!this.db) { throw new Error('Database closed during relationship resolve'); }
      begin();
      lastYield = Date.now();
    };

    const statements: Statement[] = [];
    const prepare = (sql: string) => { const stmt = this.db.prepare(sql); statements.push(stmt); return stmt; };

    begin();
    try {
      const insertEdge = prepare(
        'INSERT OR REPLACE INTO edges (from_nid,to_nid,type,ref_id,origin,metadata) VALUES (?,?,?,?,?,?)'
      );
      const deleteImporterEdges = prepare('DELETE FROM edges WHERE from_nid = ? AND origin = 2');
      const deleteCallEdges = prepare(`DELETE FROM edges WHERE ref_id = ? AND type = 'calls'`);

      if (fullResolve) {
        this.db.run(`DELETE FROM edges WHERE type = 'calls'`);
      }

      const fileNodes = this.getNodesByType('file');
      const filesByPath = new Map(fileNodes.map(node => [path.normalize(node.filePath), node]));
      const importsByFile = this.getWorkspaceImportsByFile();

      await this.resolveImportEdges(filesByPath, importsByFile, changedFiles, cache, insertEdge, deleteImporterEdges, maybeYield);

      for (const ref of this.getAffectedCallRefs(changedFiles, changedSymbols)) {
        await maybeYield();
        if (!fullResolve) { deleteCallEdges.run([ref.rid]); }
        const target = this.resolveCallTarget(ref, importsByFile, cache);
        const targetNid = target ? this.nids.get(target) : undefined;
        if (!target || targetNid === undefined || targetNid === ref.fromNid) { continue; }

        const metadata = {
          symbolName: ref.symbolName,
          resolution: target.filePath === ref.filePath ? 'same-file' : 'workspace',
        };
        insertEdge.run([ref.fromNid, targetNid, 'calls', ref.rid, 1, JSON.stringify(metadata)]);
      }
      commit();
    } catch (e) {
      if (this.resolveTransactionOpen) {
        try { this.db.run('ROLLBACK'); } catch { /* connection may be gone */ }
        this.resolveTransactionOpen = false;
      }
      throw e;
    } finally {
      for (const stmt of statements) { try { stmt.free(); } catch { /* already freed by close */ } }
    }

    this.writesSinceResolve = false;
    if (fullResolve) { this.fullResolvePending = false; }
  }

  // Import nodes of workspace files (not deps/configs), keyed by file path.
  private getWorkspaceImportsByFile(): Map<string, GraphNode[]> {
    const importsByFile = new Map<string, GraphNode[]>();
    for (const filePath of this.getAllFiles()) { importsByFile.set(filePath, []); }
    for (const node of this.queryNodes(`${NODE_SELECT} WHERE n.type = 'import' ORDER BY f.path, n.line, n.nid`)) {
      importsByFile.get(node.filePath)?.push(node);
    }
    return importsByFile;
  }

  private getAffectedCallRefs(changedFiles: string[] | null, changedSymbols: string[]): CallRefRow[] {
    let sql = `SELECT r.rid, r.from_nid, r.symbol_name, r.qualifier, f.id, f.path
               FROM call_refs r JOIN files f ON f.id = r.file_id`;
    let params: unknown[] = [];
    if (changedFiles !== null) {
      const fileParams = [...new Set(changedFiles.map(f => this.toStoredPath(f)))];
      const symbolParams = [...new Set(changedSymbols)];
      if (!fileParams.length && !symbolParams.length) { return []; }
      // SQLite caps bound parameters; very large batches fall back to a filtered scan.
      if (fileParams.length + symbolParams.length <= 900) {
        const conditions: string[] = [];
        if (fileParams.length) { conditions.push(`f.path IN (${fileParams.map(() => '?').join(',')})`); }
        if (symbolParams.length) { conditions.push(`r.symbol_name IN (${symbolParams.map(() => '?').join(',')})`); }
        sql += ' WHERE ' + conditions.join(' OR ');
        params = [...fileParams, ...symbolParams];
      }
    }
    sql += ' ORDER BY f.path, r.line, r.rid';

    const fileSet = changedFiles ? new Set(changedFiles) : null;
    const symbolSet = new Set(changedSymbols);
    const refs: CallRefRow[] = [];
    const stmt = this.db.prepare(sql);
    if (params.length) { stmt.bind(params as any[]); }
    while (stmt.step()) {
      const [rid, fromNid, symbolName, qualifier, fileId, stored] = stmt.get() as [number, number, string, string | null, number, string];
      const ref: CallRefRow = {
        rid, fromNid, symbolName,
        qualifier: qualifier ?? undefined,
        filePath: this.absPathOf(fileId, stored),
      };
      if (fileSet && !fileSet.has(ref.filePath) && !symbolSet.has(ref.symbolName)) { continue; }
      refs.push(ref);
    }
    stmt.free();
    return refs;
  }

  private resolveCallTarget(
    ref: CallRefRow,
    importsByFile: Map<string, GraphNode[]>,
    cache: ResolveCache
  ): GraphNode | null {
    const importNodes = importsByFile.get(ref.filePath) ?? [];
    const importedFiles = new Set<string>();
    const candidateNames = new Set<string>([ref.symbolName]);
    for (const importNode of importNodes) {
      const signature = importNode.signature ?? '';
      const mentionsTarget = this.wordPattern(ref.symbolName, cache).test(signature)
        || (!!ref.qualifier && this.wordPattern(ref.qualifier, cache).test(signature));
      if (!mentionsTarget) { continue; }

      const aliasMatch = this.aliasPattern(ref.symbolName, cache).exec(signature);
      if (aliasMatch) { candidateNames.add(aliasMatch[1]); }

      const resolved = this.resolveImportPath(ref.filePath, importNode.name, cache);
      if (resolved) { importedFiles.add(path.normalize(resolved)); }
    }

    const candidatesById = new Map<string, GraphNode>();
    for (const name of candidateNames) {
      for (const node of this.getNodesByExactNameCached(name, cache)) {
        if (node.type !== 'file' && node.type !== 'import') {
          candidatesById.set(node.id, node);
        }
      }
    }

    // A default import may intentionally use a different local name.
    if (!candidatesById.size && importedFiles.size) {
      for (const importedFile of importedFiles) {
        let fileNodes = cache.nodesByFile.get(importedFile);
        if (!fileNodes) {
          fileNodes = this.getNodesByFile(importedFile);
          cache.nodesByFile.set(importedFile, fileNodes);
        }
        for (const node of fileNodes) {
          if (node.modifiers?.includes('default')) {
            candidatesById.set(node.id, node);
          }
        }
      }
    }

    const candidates = [...candidatesById.values()];
    if (!candidates.length) { return null; }

    const scored = candidates.map(node => {
      let score = 0;
      if (node.filePath === ref.filePath) { score += 100; }
      if (importedFiles.has(path.normalize(node.filePath))) { score += 80; }
      if (node.modifiers?.includes('export')) { score += 5; }
      if (node.type === 'function' || node.type === 'method') { score += 3; }
      return { node, score };
    }).sort((a, b) => b.score - a.score || a.node.filePath.localeCompare(b.node.filePath));

    if (scored[0].score > 0 || scored.length === 1) { return scored[0].node; }
    return null;
  }

  private async resolveImportEdges(
    filesByPath: Map<string, GraphNode>,
    importsByFile: Map<string, GraphNode[]>,
    changedFiles: string[] | null,
    cache: ResolveCache,
    insertEdge: Statement,
    deleteImporterEdges: Statement,
    maybeYield: () => Promise<void>
  ): Promise<void> {
    let importers: Iterable<[string, GraphNode[]]>;
    if (changedFiles === null) {
      this.db.run('DELETE FROM edges WHERE origin = 2');
      importers = importsByFile;
    } else {
      // Re-resolve importers that changed, plus importers whose import source
      // points at a changed path (a created/deleted file can change their target).
      const changedBases = new Set<string>();
      for (const filePath of changedFiles) {
        for (const base of importBasesFor(filePath)) { changedBases.add(pathKey(base)); }
      }
      const changedSet = new Set(changedFiles.map(pathKey));
      const selected: Array<[string, GraphNode[]]> = [];
      for (const [importerPath, importNodes] of importsByFile) {
        const affected = changedSet.has(pathKey(importerPath)) || importNodes.some(node => {
          const base = importBase(importerPath, node.name);
          return base !== null && changedBases.has(pathKey(base));
        });
        if (!affected) { continue; }
        const importer = filesByPath.get(path.normalize(importerPath));
        const importerNid = importer ? this.nids.get(importer) : undefined;
        if (importerNid !== undefined) { deleteImporterEdges.run([importerNid]); }
        selected.push([importerPath, importNodes]);
      }
      importers = selected;
    }

    for (const [importerPath, importNodes] of importers) {
      await maybeYield();
      const importer = filesByPath.get(path.normalize(importerPath));
      const importerNid = importer ? this.nids.get(importer) : undefined;
      if (importerNid === undefined) { continue; }

      for (const importNode of importNodes) {
        const targetPath = this.resolveImportPath(importerPath, importNode.name, cache);
        if (!targetPath) { continue; }
        const target = filesByPath.get(path.normalize(targetPath));
        const targetNid = target ? this.nids.get(target) : undefined;
        if (targetNid === undefined) { continue; }

        const importerIsNm = isNodeModulePath(importerPath);
        const targetIsNm = isNodeModulePath(targetPath);
        let edgeType: EdgeType = 'imports';
        if (!importerIsNm && targetIsNm) {
          edgeType = 'depends-on';
        } else if (importerIsNm && targetIsNm) {
          edgeType = 'peer-dependency';
        }

        insertEdge.run([
          importerNid, targetNid, edgeType, 0, 2,
          JSON.stringify({ source: importNode.name, resolution: 'workspace' }),
        ]);
      }
    }
  }

  // Each lookup probes up to ~34 candidate paths on disk, so results are
  // cached per resolve pass (keyed by importer directory + source).
  private resolveImportPath(importerPath: string, source: string, cache: ResolveCache): string | null {
    const key = path.dirname(importerPath) + '\0' + source;
    const cached = cache.importPaths.get(key);
    if (cached !== undefined) { return cached; }

    const base = importBase(importerPath, source);
    let resolved: string | null = null;
    if (base !== null) {
      const candidates = [
        base,
        ...IMPORT_EXTENSIONS.map(ext => base + ext),
        ...IMPORT_EXTENSIONS.map(ext => path.join(base, `index${ext}`)),
        path.join(base, '__init__.py'),
      ];
      resolved = candidates.find(candidate => fs.existsSync(candidate)) ?? null;
    }
    cache.importPaths.set(key, resolved);
    return resolved;
  }

  private getNodesByExactNameCached(name: string, cache: ResolveCache): GraphNode[] {
    let nodes = cache.nodesByName.get(name);
    if (!nodes) {
      nodes = this.queryNodes(`${NODE_SELECT} WHERE n.name = ? ORDER BY f.path, n.line, n.nid`, [name]);
      cache.nodesByName.set(name, nodes);
    }
    return nodes;
  }

  private wordPattern(word: string, cache: ResolveCache): RegExp {
    const key = 'w:' + word;
    let pattern = cache.wordPatterns.get(key);
    if (!pattern) {
      pattern = new RegExp(`\\b${this.escapeRegExp(word)}\\b`);
      cache.wordPatterns.set(key, pattern);
    }
    return pattern;
  }

  private aliasPattern(symbolName: string, cache: ResolveCache): RegExp {
    const key = 'a:' + symbolName;
    let pattern = cache.wordPatterns.get(key);
    if (!pattern) {
      pattern = new RegExp(`\\b([A-Za-z_$][\\w$]*)\\s+as\\s+${this.escapeRegExp(symbolName)}\\b`);
      cache.wordPatterns.set(key, pattern);
    }
    return pattern;
  }

  private escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  // ── Row mappers ───────────────────────────────────────────────────────────

  private rowToNode(row: Record<string, unknown>): GraphNode {
    const fileId = row['file_id'] as number;
    const filePath = this.absPathOf(fileId, row['fpath'] as string);
    const key = row['key'] as string;
    const node: GraphNode = {
      id:             key.startsWith(RAW_ID_MARKER) ? key.slice(1) : `${filePath}::${key}`,
      type:           row['type']         as NodeType,
      name:           row['name']         as string,
      filePath,
      line:           row['line']         as number,
      endLine:        row['end_line']     as number,
      language:       row['language']     as string,
      signature:      row['signature']    as string | undefined,
      returnType:     row['return_type']  as string | undefined,
      params:         row['params']          ? JSON.parse(row['params']          as string) : undefined,
      modifiers:      row['modifiers']       ? JSON.parse(row['modifiers']       as string) : undefined,
      docComment:     row['doc_comment']  as string | undefined,
      undefinedRefs:  row['undefined_refs']  ? JSON.parse(row['undefined_refs']  as string) : undefined,
      localVars:      row['local_vars']      ? JSON.parse(row['local_vars']      as string) : undefined,
      instantiates:   row['instantiates']    ? JSON.parse(row['instantiates']    as string) : undefined,
      size:           row['size']         as number | undefined,
      lastModified:   row['last_modified']as number | undefined,
      hash:           row['hash']         as string | undefined,
      updatedAt:      row['updated_at']   as number,
    };
    this.nids.set(node, row['nid'] as number);
    return node;
  }

  private rowToEdge(row: Record<string, unknown>): GraphEdge {
    const fromNid = row['from_nid'] as number;
    const toNid = row['to_nid'] as number;
    return {
      // Stable for a given edge; callers only use it as a key.
      id:       `${fromNid}>${toNid}:${row['type']}:${row['ref_id']}`,
      fromId:   this.idFrom(row['akey'] as string, row['afile'] as number, row['apath'] as string),
      toId:     this.idFrom(row['bkey'] as string, row['bfile'] as number, row['bpath'] as string),
      type:     row['type']     as EdgeType,
      metadata: row['metadata'] ? JSON.parse(row['metadata'] as string) : undefined,
    };
  }

  // ── Text Index Operations ──────────────────────────────────────────────────

  addFileLines(lines: FileLine[]): void {
    if (!lines.length) { return; }
    this.prepareWrite();
    this.db.run('BEGIN');
    try {
      const fileId = this.fileIdFor(lines[0].filePath, true)!;
      const lineStmt = this.db.prepare(`
        INSERT OR IGNORE INTO file_lines (file_id, line, raw_text, token_type)
        VALUES (?, ?, ?, ?)
      `);
      for (const line of lines) {
        lineStmt.run([fileId, line.line, line.rawText, line.tokenType]);
      }
      lineStmt.free();
      this.db.run('COMMIT');
    } catch (e) {
      this.db.run('ROLLBACK');
      throw e;
    }
  }

  addTextEntries(entries: any[]): void {
    // Kept for backward compatibility. Map entries to FileLines.
    const uniqueLines = new Map<string, any>();
    for (const e of entries) {
      const key = `${e.filePath}:${e.line}`;
      if (!uniqueLines.has(key)) {
        uniqueLines.set(key, e);
      }
    }
    const lines: FileLine[] = Array.from(uniqueLines.values()).map(e => ({
      filePath: e.filePath,
      line: e.line,
      rawText: e.rawText,
      tokenType: e.tokenType,
    }));
    this.addFileLines(lines);
  }

  deleteFileLinesByFile(filePath: string): void {
    this.prepareWrite();
    const fileId = this.fileIdFor(filePath, false);
    if (fileId === null) { return; }
    this.db.run('DELETE FROM file_lines WHERE file_id = ?', [fileId]);
    this.dropFileIfUnused(fileId);
  }

  deleteTextEntriesByFile(filePath: string): void {
    this.deleteFileLinesByFile(filePath);
  }

  getTextEntriesByWord(word: string, _exact: boolean): any[] {
    this.refreshFromDiskIfChanged();
    const stmt = this.db.prepare(`SELECT f.id, f.path, l.line, l.raw_text, l.token_type
                                  FROM file_lines l JOIN files f ON l.file_id = f.id
                                  WHERE lower(l.raw_text) LIKE ?`);
    stmt.bind([`%${word.toLowerCase()}%`]);
    const results: any[] = [];
    while (stmt.step()) {
      const [fileId, stored, line, rawText, tokenType] = stmt.get() as [number, string, number, string, string];
      results.push({
        word,
        filePath: this.absPathOf(fileId, stored),
        line,
        text: rawText.toLowerCase(),
        rawText,
        tokenType,
      });
    }
    stmt.free();
    return results;
  }

  searchFileLines(
    normalizedQuery: string,
    fileFilter?: string,
    inComments?: boolean,
    inStrings?: boolean,
    limit = 10,
    workspaceRoot?: string
  ): Array<{ filePath: string; line: number; rawText: string; type: string }> {
    this.refreshFromDiskIfChanged();

    const { regex } = compileSearchRegex(normalizedQuery);

    const matchesQuery = (lineText: string) => {
      if (regex) {
        return regexTestCapped(regex, lineText);
      }
      return lineText.toLowerCase().includes(normalizedQuery.toLowerCase());
    };

    // Regex scans can't use the LIKE pre-filter, so bound total scan time and
    // return what was found rather than stalling the MCP server.
    const deadline = Date.now() + SEARCH_TIME_BUDGET_MS;
    let scanned = 0;

    let sql = `
      SELECT f.id, f.path, l.line, l.raw_text, l.token_type
      FROM file_lines l
      JOIN files f ON l.file_id = f.id
      WHERE f.path NOT LIKE '%node_modules%'
    `;
    const params: any[] = [];
    if (!regex) {
      sql += ' AND lower(l.raw_text) LIKE ?';
      params.push(`%${normalizedQuery.toLowerCase()}%`);
    }

    const stmt = this.db.prepare(sql);
    if (params.length) {
      stmt.bind(params);
    }

    const results = [];
    while (stmt.step()) {
      if (++scanned % 500 === 0 && Date.now() > deadline) { break; }
      const [fileId, stored, line, rawText, tokenType] = stmt.get() as [number, string, number, string, string];
      const filePath = this.absPathOf(fileId, stored);

      if (inComments && tokenType !== 'comment') continue;
      if (inStrings && tokenType !== 'string_literal') continue;
      if (regex && !matchesQuery(rawText)) continue;

      if (fileFilter && !matchPathFilter(filePath, fileFilter, workspaceRoot)) {
        continue;
      }

      results.push({ filePath, line, rawText, type: tokenType });

      if (results.length >= limit) {
        break;
      }
    }
    stmt.free();
    return results;
  }
}
