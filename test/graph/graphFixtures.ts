import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { GraphDB } from '../../src/graph/graphDB';
import { ASTParser } from '../../src/ingestion/astParser';
import { GraphNode, GraphEdge, CallReference, NodeType } from '../../src/types';
import { TestWorkspace } from '../helpers';

// web-tree-sitter initializes once per process: a second ASTParser in the same
// process fails Parser.init() and silently falls back to the regex parser. Tests
// that need several workspaces share one parser.
const sharedParser = new ASTParser();
export class SharedParserWorkspace extends TestWorkspace {
  readonly parser = sharedParser;
}

// Shared fixtures for the GraphDB unit tests. Nodes are built by hand so each
// test controls exactly what is stored.

export function tempDir(prefix = 'codelens-graph-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function removeDir(dir: string): void {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

// A workspace root with the DB stored at <root>/.codelens (schema v2 layout).
export class GraphFixture {
  readonly root = tempDir();
  readonly storage = path.join(this.root, '.codelens');
  readonly dbFile = path.join(this.storage, 'codelens-graph.db');
  private opened: GraphDB[] = [];

  path(rel: string): string {
    return path.join(this.root, ...rel.split('/'));
  }

  write(rel: string, text: string): string {
    const filePath = this.path(rel);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, text);
    return filePath;
  }

  async open(options: { followExternalWrites?: boolean } = { followExternalWrites: false }): Promise<GraphDB> {
    const db = new GraphDB(this.storage, options);
    await db.init();
    this.opened.push(db);
    return db;
  }

  // Gives the DB file a distinct mtime so a reader sees it as changed even when
  // two saves land within the filesystem's timestamp resolution.
  private tick = 0;
  bumpDbMtime(): void {
    this.tick++;
    const t = new Date(Date.UTC(2030, 0, 1, 0, 0, this.tick));
    fs.utimesSync(this.dbFile, t, t);
  }

  close(): void {
    for (const db of this.opened) { try { db.close(); } catch { /* ignore */ } }
    removeDir(this.root);
  }
}

export function makeNode(filePath: string, name: string, type: NodeType = 'function', line = 1, extra: Partial<GraphNode> = {}): GraphNode {
  return {
    id: `${filePath}::${name}::${line}`,
    type, name, filePath,
    line, endLine: line + 1,
    language: 'typescript',
    updatedAt: 1,
    ...extra,
  };
}

export function fileNode(filePath: string, extra: Partial<GraphNode> = {}): GraphNode {
  return makeNode(filePath, path.basename(filePath), 'file', 0, { id: `${filePath}::__file__::0`, ...extra });
}

export function importNode(filePath: string, source: string, signature: string, line = 1, language = 'typescript'): GraphNode {
  return makeNode(filePath, source, 'import', line, { signature, language, id: `${filePath}::import::${source}::${line}` });
}

export function edge(from: GraphNode, to: GraphNode, type: GraphEdge['type'] = 'contains', metadata?: Record<string, string>): GraphEdge {
  return { id: `${from.id}->${to.id}:${type}`, fromId: from.id, toId: to.id, type, metadata };
}

export function callRef(from: GraphNode, symbolName: string, line: number, qualifier?: string): CallReference {
  return {
    id: `${from.id}::call::${symbolName}::${line}:0`,
    fromId: from.id, filePath: from.filePath, symbolName, qualifier, line,
  };
}

// Every edge in the graph, as sorted "from -> to [type] metadata" strings.
// With includeId the stored edge key (node and call-ref integer keys) is part
// of each entry, which is only comparable within one DB.
export function dumpEdges(db: GraphDB, root: string, includeId = false): string[] {
  const rel = (id: string) => id.split(root).join('').split(path.sep).join('/');
  const out: string[] = [];
  for (const file of db.getAllFiles('all')) {
    for (const node of db.getNodesByFile(file)) {
      for (const e of db.getEdgesFrom(node.id)) {
        out.push(`${rel(e.fromId)} -> ${rel(e.toId)} [${e.type}] ${JSON.stringify(e.metadata ?? {})}${includeId ? ' #' + e.id : ''}`);
      }
    }
  }
  return out.sort();
}

// Reads a DB file with sql.js directly, bypassing GraphDB.
export async function openRawDb(data?: Uint8Array): Promise<any> {
  const initSqlJs = require('sql.js');
  const SQL = await initSqlJs({
    locateFile: (file: string) => path.join(__dirname, '..', '..', 'node_modules', 'sql.js', 'dist', file),
  });
  return data ? new SQL.Database(data) : new SQL.Database();
}

export async function rawQuery(dbFile: string, sql: string): Promise<unknown[][]> {
  const raw = await openRawDb(fs.readFileSync(dbFile));
  try {
    return raw.exec(sql)[0]?.values ?? [];
  } finally {
    raw.close();
  }
}

// Writes a DB in the pre-v2 storage format (string ids, absolute paths).
export async function writeLegacyDb(dbFile: string, filePath: string): Promise<void> {
  const raw = await openRawDb();
  raw.run('CREATE TABLE nodes (id TEXT PRIMARY KEY, type TEXT, name TEXT, file_path TEXT)');
  raw.run('INSERT INTO nodes VALUES (?, ?, ?, ?)', [`${filePath}::legacy::1`, 'function', 'legacy', filePath]);
  const data = raw.export();
  raw.close();
  fs.mkdirSync(path.dirname(dbFile), { recursive: true });
  fs.writeFileSync(dbFile, data);
}

// Replaces Date.now for the duration of fn (sync or async).
export async function withClock<T>(now: () => number, fn: () => T | Promise<T>): Promise<T> {
  const real = Date.now;
  Date.now = now;
  try {
    return await fn();
  } finally {
    Date.now = real;
  }
}

// Silences console.log/warn noise from code under test.
export async function quietly<T>(fn: () => T | Promise<T>): Promise<T> {
  const { log, warn } = console;
  console.log = () => {};
  console.warn = () => {};
  try {
    return await fn();
  } finally {
    console.log = log;
    console.warn = warn;
  }
}
