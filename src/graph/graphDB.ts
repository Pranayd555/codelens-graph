// sql.js ships as CommonJS — use require()
type Database = import('sql.js').Database;
import * as path from 'path';
import * as fs from 'fs';
import {
  GraphNode, GraphEdge, GraphSnapshot, GraphStats, NodeType, EdgeType, CallReference
} from '../types';
import { isConfigPath, isNodeModulePath, matchPathFilter } from '../utils';

// ─── Schema ───────────────────────────────────────────────────────────────────

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS nodes (
    id              TEXT PRIMARY KEY,
    type            TEXT NOT NULL,
    name            TEXT NOT NULL,
    file_path       TEXT NOT NULL,
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

  CREATE TABLE IF NOT EXISTS edges (
    id        TEXT PRIMARY KEY,
    from_id   TEXT NOT NULL,
    to_id     TEXT NOT NULL,
    type      TEXT NOT NULL,
    metadata  TEXT
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

  CREATE TABLE IF NOT EXISTS call_refs (
    id          TEXT PRIMARY KEY,
    from_id     TEXT NOT NULL,
    file_path   TEXT NOT NULL,
    symbol_name TEXT NOT NULL,
    qualifier   TEXT,
    line        INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS files (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    path        TEXT UNIQUE NOT NULL
  );

  CREATE TABLE IF NOT EXISTS file_lines (
    file_id     INTEGER NOT NULL,
    line        INTEGER NOT NULL,
    raw_text    TEXT NOT NULL,
    token_type  TEXT NOT NULL,
    PRIMARY KEY (file_id, line)
  );

  CREATE INDEX IF NOT EXISTS idx_nodes_file  ON nodes(file_path);
  CREATE INDEX IF NOT EXISTS idx_nodes_type  ON nodes(type);
  CREATE INDEX IF NOT EXISTS idx_nodes_name  ON nodes(name);
  CREATE INDEX IF NOT EXISTS idx_edges_from  ON edges(from_id);
  CREATE INDEX IF NOT EXISTS idx_edges_to    ON edges(to_id);
  CREATE INDEX IF NOT EXISTS idx_edges_type  ON edges(type);
  CREATE INDEX IF NOT EXISTS idx_call_refs_from   ON call_refs(from_id);
  CREATE INDEX IF NOT EXISTS idx_call_refs_symbol ON call_refs(symbol_name);
  CREATE INDEX IF NOT EXISTS idx_file_lines_file  ON file_lines(file_id);
`;

export interface FileLine {
  filePath: string;
  line: number;
  rawText: string;
  tokenType: string;
}

// ─── GraphDB ──────────────────────────────────────────────────────────────────

export class GraphDB {
  private db!: Database;
  private dbPath: string;
  private SQL!: any;
  private fileVersion = '';
  private dirty = false;
  private initPromise: Promise<void> | null = null;
  private version = 0;

  constructor(storagePath: string) {
    this.dbPath = path.join(storagePath, 'codelens-graph.db');
  }

  isInitialized(): boolean {
    return this.initPromise !== null && this.db !== undefined;
  }

  getVersion(): number {
    return this.version;
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
          const data = fs.readFileSync(this.dbPath);
          this.db = new this.SQL.Database(data);

          // Schema validation: if file_lines does not exist OR text_index exists, trigger a rebuild for optimization
          // Schema validation: trigger a rebuild if file_lines or files does not exist,
          // or if file_lines has the old 'file_path' column.
          let hasOldSchema = false;
          try {
            const res1 = this.db.exec("SELECT name FROM sqlite_master WHERE type='table' AND name='file_lines'");
            const hasFileLines = res1.length > 0 && res1[0].values.length > 0;
            const res2 = this.db.exec("SELECT name FROM sqlite_master WHERE type='table' AND name='files'");
            const hasFiles = res2.length > 0 && res2[0].values.length > 0;
            
            if (!hasFileLines || !hasFiles) {
              hasOldSchema = true;
            } else {
              const res3 = this.db.exec("PRAGMA table_info(file_lines)");
              const columns = res3[0].values.map((v: any) => v[1]);
              if (columns.includes('file_path')) {
                hasOldSchema = true;
              }
            }
          } catch {}

          if (hasOldSchema) {
            console.log('[CodeLens] Old schema detected (or text_index exists), rebuilding database for optimization…');
            this.db.close();
            try {
              fs.unlinkSync(this.dbPath);
            } catch {}
            this.db = new this.SQL.Database();
          }
        } catch (err) {
          console.warn(`[CodeLens] Failed to load database from disk (${this.dbPath}), falling back to a fresh DB:`, err);
          this.db = new this.SQL.Database();
        }
      } else {
        this.db = new this.SQL.Database();
      }
      this.db.run(SCHEMA);
      this.runMigrations();
      this.version++;
      // DO NOT call this.persist() on init — avoid redundant slow write when no changes were made.
    })();

    return this.initPromise;
  }

  async ensureInit(): Promise<void> {
    if (!this.initPromise) {
      await this.init();
    }
    return this.initPromise!;
  }

  // Add columns that didn't exist in earlier schema versions
  private runMigrations(): void {
    const migrations = [
      `ALTER TABLE nodes ADD COLUMN undefined_refs TEXT`,
      `ALTER TABLE nodes ADD COLUMN local_vars TEXT`,
      `ALTER TABLE nodes ADD COLUMN instantiates TEXT`,
    ];
    for (const sql of migrations) {
      try { this.db.run(sql); } catch { /* column already exists */ }
    }
  }

  persist(): void {
    const data = this.db.export();
    fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });
    fs.writeFileSync(this.dbPath, data);
    this.dirty = false;
    this.fileVersion = this.getFileVersion();
    this.version++;
  }

  close(): void {
    if (this.db) {
      if (this.dirty) {
        try { this.persist(); } catch {}
      }
      try { this.db.close(); } catch {}
      this.db = undefined as any;
    }
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
    if (this.dirty || !fs.existsSync(this.dbPath)) { return false; }
    const currentVersion = this.getFileVersion();
    if (!currentVersion || currentVersion === this.fileVersion) { return false; }

    try {
      const data = fs.readFileSync(this.dbPath);
      const replacement = new this.SQL.Database(data);
      this.db.close();
      this.db = replacement;
      this.db.run(SCHEMA);
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
  }

  // ── Node operations ───────────────────────────────────────────────────────

  upsertNode(node: GraphNode): void {
    this.prepareWrite();
    this.db.run(`
      INSERT INTO nodes
        (id,type,name,file_path,line,end_line,language,signature,return_type,
         params,modifiers,doc_comment,undefined_refs,local_vars,instantiates,
         size,last_modified,hash,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET
        type=excluded.type, name=excluded.name, file_path=excluded.file_path,
        line=excluded.line, end_line=excluded.end_line, language=excluded.language,
        signature=excluded.signature, return_type=excluded.return_type,
        params=excluded.params, modifiers=excluded.modifiers,
        doc_comment=excluded.doc_comment, undefined_refs=excluded.undefined_refs,
        local_vars=excluded.local_vars, instantiates=excluded.instantiates,
        size=excluded.size, last_modified=excluded.last_modified,
        hash=excluded.hash, updated_at=excluded.updated_at
    `, [
      node.id, node.type, node.name, node.filePath,
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
  }

  upsertNodes(nodes: GraphNode[]): void {
    this.prepareWrite();
    this.db.run('BEGIN');
    try { for (const n of nodes) { this.upsertNode(n); } this.db.run('COMMIT'); }
    catch (e) { this.db.run('ROLLBACK'); throw e; }
  }

  getNode(id: string): GraphNode | null {
    this.refreshFromDiskIfChanged();
    const stmt = this.db.prepare('SELECT * FROM nodes WHERE id = ?');
    stmt.bind([id]);
    if (stmt.step()) { const row = stmt.getAsObject(); stmt.free(); return this.rowToNode(row); }
    stmt.free(); return null;
  }

  getNodesByFile(filePath: string): GraphNode[] {
    this.refreshFromDiskIfChanged();
    const stmt = this.db.prepare('SELECT * FROM nodes WHERE file_path = ? ORDER BY line');
    stmt.bind([filePath]);
    const results: GraphNode[] = [];
    while (stmt.step()) { results.push(this.rowToNode(stmt.getAsObject())); }
    stmt.free(); return results;
  }

  getNodesByType(type: NodeType): GraphNode[] {
    this.refreshFromDiskIfChanged();
    const stmt = this.db.prepare('SELECT * FROM nodes WHERE type = ? ORDER BY name');
    stmt.bind([type]);
    const results: GraphNode[] = [];
    while (stmt.step()) { results.push(this.rowToNode(stmt.getAsObject())); }
    stmt.free(); return results;
  }

  // Nodes that have undefined references — pre-diagnosed issues
  getNodesWithUndefinedRefs(scope: 'workspace' | 'all' = 'workspace'): GraphNode[] {
    this.refreshFromDiskIfChanged();

    // 1. Get all defined symbol names in the database
    const stmtDefined = this.db.prepare(
      `SELECT DISTINCT name FROM nodes WHERE type NOT IN ('file', 'import')`
    );
    const definedNames = new Set<string>();
    while (stmtDefined.step()) {
      const row = stmtDefined.getAsObject();
      if (row.name) {
        definedNames.add((row.name as string).trim());
      }
    }
    stmtDefined.free();

    // 2. Query nodes with undefined references and filter them
    const stmt = this.db.prepare(
      `SELECT * FROM nodes WHERE undefined_refs IS NOT NULL AND undefined_refs != '[]' ORDER BY file_path, line`
    );
    const results: GraphNode[] = [];
    while (stmt.step()) {
      const node = this.rowToNode(stmt.getAsObject());
      if (node.undefinedRefs && node.undefinedRefs.length > 0) {
        const filteredRefs = node.undefinedRefs.filter(ref => !definedNames.has(ref));
        if (filteredRefs.length > 0) {
          node.undefinedRefs = filteredRefs;
          results.push(node);
        }
      }
    }
    stmt.free();

    if (scope === 'all') { return results; }

    return results.filter(n => {
      return !isNodeModulePath(n.filePath) && !isConfigPath(n.filePath);
    });
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
      scopeSql = "AND file_path NOT LIKE '%node_modules%'";
    } else if (scope === 'deps') {
      scopeSql = "AND (file_path LIKE '%node_modules%' OR file_path LIKE '%.json' OR file_path LIKE '%.md')";
    }

    // Dynamic WHERE clause
    const conditions: string[] = [];
    const bindParams: any[] = [];

    for (const token of tokens) {
      conditions.push('(lower(name) LIKE lower(?) OR lower(signature) LIKE lower(?) OR lower(doc_comment) LIKE lower(?))');
      const likeParam = `%${token}%`;
      bindParams.push(likeParam, likeParam, likeParam);
    }

    // ORDER BY logic: prioritize exact name match for the first token, or generally matching name
    const orderSql = `
      ORDER BY
        CASE WHEN lower(name) = lower(?) THEN 0
             WHEN lower(name) LIKE lower(?) THEN 1
             ELSE 2 END, name
    `;
    bindParams.push(tokens[0], `${tokens[0]}%`);

    const sql = `
      SELECT * FROM nodes
      WHERE (${conditions.join(' OR ')})
      ${scopeSql}
      ${orderSql}
      LIMIT ?
    `;
    bindParams.push(limit);

    const stmt = this.db.prepare(sql);
    stmt.bind(bindParams);
    const results: GraphNode[] = [];
    while (stmt.step()) { results.push(this.rowToNode(stmt.getAsObject())); }
    stmt.free();

    if (scope === 'workspace') {
      return results.filter(n => !isConfigPath(n.filePath));
    } else if (scope === 'deps') {
      return results.filter(n => isNodeModulePath(n.filePath) || isConfigPath(n.filePath));
    }
    return results;
  }

  deleteNodesByFile(filePath: string): void {
    this.prepareWrite();
    // Delete edges referencing nodes in this file first (no FK cascade in sql.js)
    const nodes = this.getNodesByFile(filePath);
    for (const n of nodes) {
      this.db.run('DELETE FROM edges WHERE from_id = ? OR to_id = ?', [n.id, n.id]);
      this.db.run('DELETE FROM call_refs WHERE from_id = ?', [n.id]);
    }
    this.db.run('DELETE FROM nodes WHERE file_path = ?', [filePath]);
    this.deleteTextEntriesByFile(filePath);
  }

  getAllFiles(scope: 'workspace' | 'deps' | 'all' = 'workspace'): string[] {
    this.refreshFromDiskIfChanged();
    const stmt = this.db.prepare(
      `SELECT DISTINCT file_path FROM nodes WHERE type = 'file' ORDER BY file_path`
    );
    const results: string[] = [];
    while (stmt.step()) { results.push(stmt.getAsObject()['file_path'] as string); }
    stmt.free();

    if (scope === 'all') { return results; }

    return results.filter(fp => {
      const isNm = isNodeModulePath(fp);
      const isCfg = isConfigPath(fp);
      if (scope === 'workspace') {
        return !isNm && !isCfg;
      } else {
        return isNm || isCfg;
      }
    });
  }

  // ── Edge operations ───────────────────────────────────────────────────────

  upsertEdge(edge: GraphEdge): void {
    this.prepareWrite();
    this.db.run(`INSERT OR REPLACE INTO edges (id,from_id,to_id,type,metadata) VALUES (?,?,?,?,?)`, [
      edge.id, edge.fromId, edge.toId, edge.type,
      edge.metadata ? JSON.stringify(edge.metadata) : null,
    ]);
  }

  upsertEdges(edges: GraphEdge[]): void {
    this.prepareWrite();
    this.db.run('BEGIN');
    try { for (const e of edges) { this.upsertEdge(e); } this.db.run('COMMIT'); }
    catch (e) { this.db.run('ROLLBACK'); throw e; }
  }

  getEdgesFrom(nodeId: string, type?: EdgeType): GraphEdge[] {
    this.refreshFromDiskIfChanged();
    const sql  = type ? 'SELECT * FROM edges WHERE from_id=? AND type=?' : 'SELECT * FROM edges WHERE from_id=?';
    const stmt = this.db.prepare(sql);
    stmt.bind(type ? [nodeId, type] : [nodeId]);
    const results: GraphEdge[] = [];
    while (stmt.step()) { results.push(this.rowToEdge(stmt.getAsObject())); }
    stmt.free(); return results;
  }

  getEdgesTo(nodeId: string, type?: EdgeType): GraphEdge[] {
    this.refreshFromDiskIfChanged();
    const sql  = type ? 'SELECT * FROM edges WHERE to_id=? AND type=?' : 'SELECT * FROM edges WHERE to_id=?';
    const stmt = this.db.prepare(sql);
    stmt.bind(type ? [nodeId, type] : [nodeId]);
    const results: GraphEdge[] = [];
    while (stmt.step()) { results.push(this.rowToEdge(stmt.getAsObject())); }
    stmt.free(); return results;
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

    const wsFiles = this.getAllFiles('workspace');
    const wsFilesSet = new Set(wsFiles);

    const stmt = this.db.prepare('SELECT id, type, file_path FROM nodes');
    let totalNodes = 0;
    let fileCount = 0;
    const byType: Record<string, number> = {};
    const wsNodeIds = new Set<string>();

    while (stmt.step()) {
      const row = stmt.getAsObject();
      const fp = row['file_path'] as string;
      const id = row['id'] as string;
      const type = row['type'] as string;

      if (wsFilesSet.has(fp)) {
        wsNodeIds.add(id);
        totalNodes++;
        if (type === 'file') {
          fileCount++;
        }
        byType[type] = (byType[type] || 0) + 1;
      }
    }
    stmt.free();

    const edgeStmt = this.db.prepare('SELECT from_id, to_id FROM edges');
    let totalEdges = 0;
    while (edgeStmt.step()) {
      const row = edgeStmt.getAsObject();
      const fromId = row['from_id'] as string;
      const toId = row['to_id'] as string;
      if (wsNodeIds.has(fromId) && wsNodeIds.has(toId)) {
        totalEdges++;
      }
    }
    edgeStmt.free();

    return { totalNodes, totalEdges, fileCount, byType: byType as Record<NodeType, number> };
  }

  // ─── Durable call references and workspace relationship resolution ───────

  upsertCallRefs(refs: CallReference[]): void {
    if (!refs.length) { return; }
    this.prepareWrite();
    this.db.run('BEGIN');
    try {
      for (const ref of refs) {
        this.db.run(
          `INSERT OR REPLACE INTO call_refs
           (id,from_id,file_path,symbol_name,qualifier,line) VALUES (?,?,?,?,?,?)`,
          [ref.id, ref.fromId, ref.filePath, ref.symbolName, ref.qualifier ?? null, ref.line]
        );
      }
      this.db.run('COMMIT');
    } catch (e) {
      this.db.run('ROLLBACK');
      throw e;
    }
  }

  resolveWorkspaceRelationships(changedFilePath?: string, changedSymbols: string[] = []): void {
    this.prepareWrite();
    const fullResolve = !changedFilePath;
    if (fullResolve) {
      this.db.run(`DELETE FROM edges WHERE type = 'calls'`);
    }
    this.db.run(`DELETE FROM edges WHERE id LIKE 'resolved-import::%'`);

    const fileNodes = this.getNodesByType('file');
    const filesByPath = new Map(fileNodes.map(node => [path.normalize(node.filePath), node]));
    const importsByFile = new Map<string, GraphNode[]>();
    for (const filePath of this.getAllFiles()) {
      importsByFile.set(
        filePath,
        this.getNodesByFile(filePath).filter(node => node.type === 'import')
      );
    }

    this.resolveImportEdges(filesByPath, importsByFile);

    const stmt = this.db.prepare('SELECT * FROM call_refs ORDER BY file_path, line');
    while (stmt.step()) {
      const row = stmt.getAsObject();
      const ref: CallReference = {
        id: row['id'] as string,
        fromId: row['from_id'] as string,
        filePath: row['file_path'] as string,
        symbolName: row['symbol_name'] as string,
        qualifier: row['qualifier'] as string | undefined,
        line: row['line'] as number,
      };
      const isAffected = fullResolve
        || ref.filePath === changedFilePath
        || changedSymbols.includes(ref.symbolName);
      if (!isAffected) { continue; }

      // A call reference has at most one resolved edge. Remove its previous
      // resolution before selecting the best current target.
      const edgePrefix = `${ref.id}::resolved::`;
      this.db.run(
        `DELETE FROM edges WHERE type = 'calls' AND substr(id, 1, length(?)) = ?`,
        [edgePrefix, edgePrefix]
      );
      const target = this.resolveCallTarget(ref, importsByFile);
      if (!target || target.id === ref.fromId) { continue; }

      const edge: GraphEdge = {
        id: `${ref.id}::resolved::${target.id}`,
        fromId: ref.fromId,
        toId: target.id,
        type: 'calls',
        metadata: {
          symbolName: ref.symbolName,
          resolution: target.filePath === ref.filePath ? 'same-file' : 'workspace',
        },
      };
      this.db.run(
        'INSERT OR REPLACE INTO edges (id,from_id,to_id,type,metadata) VALUES (?,?,?,?,?)',
        [edge.id, edge.fromId, edge.toId, edge.type, JSON.stringify(edge.metadata)]
      );
    }
    stmt.free();
  }

  private resolveCallTarget(
    ref: CallReference,
    importsByFile: Map<string, GraphNode[]>
  ): GraphNode | null {
    const importNodes = importsByFile.get(ref.filePath) ?? [];
    const importedFiles = new Set<string>();
    const candidateNames = new Set<string>([ref.symbolName]);
    for (const importNode of importNodes) {
      const signature = importNode.signature ?? '';
      const mentionsTarget = this.containsWord(signature, ref.symbolName)
        || (!!ref.qualifier && this.containsWord(signature, ref.qualifier));
      if (!mentionsTarget) { continue; }

      const aliasPattern = new RegExp(
        `\\b([A-Za-z_$][\\w$]*)\\s+as\\s+${this.escapeRegExp(ref.symbolName)}\\b`
      );
      const aliasMatch = aliasPattern.exec(signature);
      if (aliasMatch) { candidateNames.add(aliasMatch[1]); }

      const resolved = this.resolveImportPath(ref.filePath, importNode.name);
      if (resolved) { importedFiles.add(path.normalize(resolved)); }
    }

    const candidatesById = new Map<string, GraphNode>();
    for (const name of candidateNames) {
      for (const node of this.getNodesByExactName(name)) {
        if (node.type !== 'file' && node.type !== 'import') {
          candidatesById.set(node.id, node);
        }
      }
    }

    // A default import may intentionally use a different local name.
    if (!candidatesById.size && importedFiles.size) {
      for (const importedFile of importedFiles) {
        for (const node of this.getNodesByFile(importedFile)) {
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

  private resolveImportEdges(
    filesByPath: Map<string, GraphNode>,
    importsByFile: Map<string, GraphNode[]>
  ): void {
    for (const [importerPath, importNodes] of importsByFile) {
      const importer = filesByPath.get(path.normalize(importerPath));
      if (!importer) { continue; }

      for (const importNode of importNodes) {
        const targetPath = this.resolveImportPath(importerPath, importNode.name);
        if (!targetPath) { continue; }
        const target = filesByPath.get(path.normalize(targetPath));
        if (!target) { continue; }

        const importerIsNm = isNodeModulePath(importerPath);
        const targetIsNm = isNodeModulePath(targetPath);
        let edgeType: EdgeType = 'imports';
        if (!importerIsNm && targetIsNm) {
          edgeType = 'depends-on';
        } else if (importerIsNm && targetIsNm) {
          edgeType = 'peer-dependency';
        }

        this.db.run(
          'INSERT OR REPLACE INTO edges (id,from_id,to_id,type,metadata) VALUES (?,?,?,?,?)',
          [
            `resolved-import::${importer.id}::${target.id}`,
            importer.id,
            target.id,
            edgeType,
            JSON.stringify({ source: importNode.name, resolution: 'workspace' }),
          ]
        );
      }
    }
  }

  private resolveImportPath(importerPath: string, source: string): string | null {
    if (!source) { return null; }
    const importerDir = path.dirname(importerPath);
    let base: string;

    if (source.startsWith('.')) {
      base = path.resolve(importerDir, source);
    } else if (source.includes('.') && !source.includes('/') && !source.includes('\\')) {
      base = path.resolve(importerDir, source.replace(/\./g, path.sep));
    } else {
      return null;
    }

    const extensions = ['.ts','.tsx','.js','.jsx','.mjs','.py','.go','.rs','.java','.cs','.cpp','.c','.rb','.php','.swift','.kt'];
    const candidates = [
      base,
      ...extensions.map(ext => base + ext),
      ...extensions.map(ext => path.join(base, `index${ext}`)),
      path.join(base, '__init__.py'),
    ];
    return candidates.find(candidate => fs.existsSync(candidate)) ?? null;
  }

  private getNodesByExactName(name: string): GraphNode[] {
    const stmt = this.db.prepare('SELECT * FROM nodes WHERE name = ? ORDER BY file_path, line');
    stmt.bind([name]);
    const results: GraphNode[] = [];
    while (stmt.step()) { results.push(this.rowToNode(stmt.getAsObject())); }
    stmt.free();
    return results;
  }

  private containsWord(text: string, word: string): boolean {
    const escaped = this.escapeRegExp(word);
    return new RegExp(`\\b${escaped}\\b`).test(text);
  }

  private escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  // ── Row mappers ───────────────────────────────────────────────────────────

  private rowToNode(row: Record<string, unknown>): GraphNode {
    return {
      id:             row['id']           as string,
      type:           row['type']         as NodeType,
      name:           row['name']         as string,
      filePath:       row['file_path']    as string,
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
  }

  private rowToEdge(row: Record<string, unknown>): GraphEdge {
    return {
      id:       row['id']       as string,
      fromId:   row['from_id']  as string,
      toId:     row['to_id']    as string,
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
      const filePath = lines[0].filePath;

      // 1. Get or insert file_id
      this.db.run('INSERT OR IGNORE INTO files (path) VALUES (?)', [filePath]);
      const fileStmt = this.db.prepare('SELECT id FROM files WHERE path = ?');
      fileStmt.bind([filePath]);
      if (!fileStmt.step()) {
        fileStmt.free();
        throw new Error(`Failed to resolve file_id for path: ${filePath}`);
      }
      const fileId = fileStmt.getAsObject().id as number;
      fileStmt.free();

      // 2. Insert lines
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
    this.db.run('DELETE FROM file_lines WHERE file_id IN (SELECT id FROM files WHERE path = ?)', [filePath]);
    this.db.run('DELETE FROM files WHERE path = ?', [filePath]);
  }

  deleteTextEntriesByFile(filePath: string): void {
    this.deleteFileLinesByFile(filePath);
  }

  getTextEntriesByWord(word: string, _exact: boolean): any[] {
    this.refreshFromDiskIfChanged();
    const query = `SELECT f.path AS file_path, l.line, l.raw_text, l.token_type
                   FROM file_lines l
                   JOIN files f ON l.file_id = f.id
                   WHERE lower(l.raw_text) LIKE ?`;
    const param = `%${word.toLowerCase()}%`;
    const stmt = this.db.prepare(query);
    stmt.bind([param]);
    const results: any[] = [];
    while (stmt.step()) {
      const row = stmt.getAsObject();
      results.push({
        word: word,
        filePath: row.file_path,
        line: row.line as number,
        text: (row.raw_text as string).toLowerCase(),
        rawText: row.raw_text,
        tokenType: row.token_type,
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

    const isRegex = /[|*?+{}()[\]^$\\&]/.test(normalizedQuery);
    let regex: RegExp | null = null;
    if (isRegex) {
      try {
        regex = new RegExp(normalizedQuery, 'i');
      } catch {}
    }

    const matchesQuery = (lineText: string) => {
      if (regex) {
        return regex.test(lineText);
      }
      return lineText.toLowerCase().includes(normalizedQuery.toLowerCase());
    };

    let sql = `
      SELECT f.path AS file_path, l.line, l.raw_text, l.token_type
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
      const row = stmt.getAsObject();
      const rawText = row.raw_text as string;
      const filePath = row.file_path as string;

      if (inComments && row.token_type !== 'comment') continue;
      if (inStrings && row.token_type !== 'string_literal') continue;
      if (regex && !matchesQuery(rawText)) continue;

      if (fileFilter && !matchPathFilter(filePath, fileFilter, workspaceRoot)) {
        continue;
      }

      results.push({
        filePath,
        line: row.line as number,
        rawText,
        type: row.token_type as string,
      });

      if (results.length >= limit) {
        break;
      }
    }
    stmt.free();
    return results;
  }
}
