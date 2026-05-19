// sql.js ships as CommonJS — use require()
// eslint-disable-next-line @typescript-eslint/no-require-imports
const initSqlJs = require('sql.js') as typeof import('sql.js').default;
type Database = import('sql.js').Database;
import * as path from 'path';
import * as fs from 'fs';
import {
  GraphNode, GraphEdge, GraphSnapshot, GraphStats, NodeType, EdgeType
} from '../types';

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

  CREATE INDEX IF NOT EXISTS idx_nodes_file  ON nodes(file_path);
  CREATE INDEX IF NOT EXISTS idx_nodes_type  ON nodes(type);
  CREATE INDEX IF NOT EXISTS idx_nodes_name  ON nodes(name);
  CREATE INDEX IF NOT EXISTS idx_edges_from  ON edges(from_id);
  CREATE INDEX IF NOT EXISTS idx_edges_to    ON edges(to_id);
  CREATE INDEX IF NOT EXISTS idx_edges_type  ON edges(type);
`;

// ─── GraphDB ──────────────────────────────────────────────────────────────────

export class GraphDB {
  private db!: Database;
  private dbPath: string;
  private SQL!: Awaited<ReturnType<typeof initSqlJs>>;

  constructor(storagePath: string) {
    this.dbPath = path.join(storagePath, 'codelens-graph.db');
  }

  async init(): Promise<void> {
    this.SQL = await initSqlJs();
    if (fs.existsSync(this.dbPath)) {
      const data = fs.readFileSync(this.dbPath);
      this.db = new this.SQL.Database(data);
    } else {
      this.db = new this.SQL.Database();
    }
    this.db.run(SCHEMA);
    this.runMigrations();
    this.persist();
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
  }

  close(): void { this.persist(); this.db.close(); }

  // ── Node operations ───────────────────────────────────────────────────────

  upsertNode(node: GraphNode): void {
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
    this.db.run('BEGIN');
    try { for (const n of nodes) { this.upsertNode(n); } this.db.run('COMMIT'); }
    catch (e) { this.db.run('ROLLBACK'); throw e; }
  }

  getNode(id: string): GraphNode | null {
    const stmt = this.db.prepare('SELECT * FROM nodes WHERE id = ?');
    stmt.bind([id]);
    if (stmt.step()) { const row = stmt.getAsObject(); stmt.free(); return this.rowToNode(row); }
    stmt.free(); return null;
  }

  getNodesByFile(filePath: string): GraphNode[] {
    const stmt = this.db.prepare('SELECT * FROM nodes WHERE file_path = ? ORDER BY line');
    stmt.bind([filePath]);
    const results: GraphNode[] = [];
    while (stmt.step()) { results.push(this.rowToNode(stmt.getAsObject())); }
    stmt.free(); return results;
  }

  getNodesByType(type: NodeType): GraphNode[] {
    const stmt = this.db.prepare('SELECT * FROM nodes WHERE type = ? ORDER BY name');
    stmt.bind([type]);
    const results: GraphNode[] = [];
    while (stmt.step()) { results.push(this.rowToNode(stmt.getAsObject())); }
    stmt.free(); return results;
  }

  // Nodes that have undefined references — pre-diagnosed issues
  getNodesWithUndefinedRefs(): GraphNode[] {
    const stmt = this.db.prepare(
      `SELECT * FROM nodes WHERE undefined_refs IS NOT NULL AND undefined_refs != '[]' ORDER BY file_path, line`
    );
    const results: GraphNode[] = [];
    while (stmt.step()) { results.push(this.rowToNode(stmt.getAsObject())); }
    stmt.free(); return results;
  }

  searchNodes(query: string, limit = 20): GraphNode[] {
    const stmt = this.db.prepare(`
      SELECT * FROM nodes
      WHERE lower(name) LIKE lower(?) OR lower(signature) LIKE lower(?)
      ORDER BY
        CASE WHEN lower(name) = lower(?) THEN 0
             WHEN lower(name) LIKE lower(?) THEN 1
             ELSE 2 END, name
      LIMIT ?
    `);
    const like = `%${query}%`;
    stmt.bind([like, like, query, `${query}%`, limit]);
    const results: GraphNode[] = [];
    while (stmt.step()) { results.push(this.rowToNode(stmt.getAsObject())); }
    stmt.free(); return results;
  }

  deleteNodesByFile(filePath: string): void {
    // Delete edges referencing nodes in this file first (no FK cascade in sql.js)
    const nodes = this.getNodesByFile(filePath);
    for (const n of nodes) {
      this.db.run('DELETE FROM edges WHERE from_id = ? OR to_id = ?', [n.id, n.id]);
    }
    this.db.run('DELETE FROM nodes WHERE file_path = ?', [filePath]);
  }

  getAllFiles(): string[] {
    const stmt = this.db.prepare(
      `SELECT DISTINCT file_path FROM nodes WHERE type = 'file' ORDER BY file_path`
    );
    const results: string[] = [];
    while (stmt.step()) { results.push(stmt.getAsObject()['file_path'] as string); }
    stmt.free(); return results;
  }

  // ── Edge operations ───────────────────────────────────────────────────────

  upsertEdge(edge: GraphEdge): void {
    this.db.run(`INSERT OR REPLACE INTO edges (id,from_id,to_id,type,metadata) VALUES (?,?,?,?,?)`, [
      edge.id, edge.fromId, edge.toId, edge.type,
      edge.metadata ? JSON.stringify(edge.metadata) : null,
    ]);
  }

  upsertEdges(edges: GraphEdge[]): void {
    this.db.run('BEGIN');
    try { for (const e of edges) { this.upsertEdge(e); } this.db.run('COMMIT'); }
    catch (e) { this.db.run('ROLLBACK'); throw e; }
  }

  getEdgesFrom(nodeId: string, type?: EdgeType): GraphEdge[] {
    const sql  = type ? 'SELECT * FROM edges WHERE from_id=? AND type=?' : 'SELECT * FROM edges WHERE from_id=?';
    const stmt = this.db.prepare(sql);
    stmt.bind(type ? [nodeId, type] : [nodeId]);
    const results: GraphEdge[] = [];
    while (stmt.step()) { results.push(this.rowToEdge(stmt.getAsObject())); }
    stmt.free(); return results;
  }

  getEdgesTo(nodeId: string, type?: EdgeType): GraphEdge[] {
    const sql  = type ? 'SELECT * FROM edges WHERE to_id=? AND type=?' : 'SELECT * FROM edges WHERE to_id=?';
    const stmt = this.db.prepare(sql);
    stmt.bind(type ? [nodeId, type] : [nodeId]);
    const results: GraphEdge[] = [];
    while (stmt.step()) { results.push(this.rowToEdge(stmt.getAsObject())); }
    stmt.free(); return results;
  }

  // ── BFS traversal ─────────────────────────────────────────────────────────

  bfsExpand(seedIds: string[], depth: number): { nodes: GraphNode[]; edges: GraphEdge[] } {
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

  getStats(): Omit<GraphStats, 'lastBuilt' | 'buildDurationMs'> {
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
}
