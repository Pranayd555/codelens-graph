import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { GraphDB } from '../../src/graph/graphDB';
import { WorkspaceScanner } from '../../src/ingestion/workspaceScanner';
import { AgentContext, GraphNode } from '../../src/types';
import { SCAN_OPTIONS, TestWorkspace } from '../helpers';

// Local helpers for the context/ and mcpLogger tests (not a test file).

// A temp directory that is removed by the returned cleanup function.
export function makeTempDir(prefix = 'codelens-ctx-'): { dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return { dir, cleanup: () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } } };
}

// A synthetic graph node with sane defaults.
export function makeNode(partial: Partial<GraphNode> & Pick<GraphNode, 'name' | 'filePath'>): GraphNode {
  return {
    id: `${partial.filePath}::${partial.name}::${partial.line ?? 1}`,
    type: 'function',
    line: 1,
    endLine: 1,
    language: 'typescript',
    updatedAt: 0,
    ...partial,
  };
}

// Inserts a file node plus symbol nodes for a file that the scanner would not
// index itself (node_modules, files outside the workspace, ...).
export function insertFile(db: GraphDB, filePath: string, symbols: Array<Partial<GraphNode> & { name: string }>, fileExtra: Partial<GraphNode> = {}): GraphNode[] {
  const fileNode = makeNode({ id: `${filePath}::__file__::0`, type: 'file', name: path.basename(filePath), filePath, line: 0, endLine: 1, ...fileExtra });
  const nodes = symbols.map(s => makeNode({ filePath, ...s }));
  db.upsertNodes([fileNode, ...nodes]);
  return nodes;
}

// Indexes a project that lives in a sub-directory of a TestWorkspace, so the
// project root's ancestors can be given meaningful names (e.g. ".../lib/app").
export async function scanNested(ws: TestWorkspace, rel: string): Promise<GraphDB> {
  const root = ws.path(rel);
  const db = new GraphDB(path.join(root, '.codelens'), { followExternalWrites: false });
  await db.init();
  const scanner = new WorkspaceScanner(ws.parser, db);
  await scanner.scanWorkspace({ workspaceRoot: root, folders: [] }, SCAN_OPTIONS);
  return db;
}

// Section of a rendered context, from its "### Title" header to the next one.
export function section(text: string, title: string): string | null {
  const lines = text.split('\n');
  const start = lines.findIndex(l => l.startsWith('### ') && l.includes(title));
  if (start === -1) { return null; }
  const rest = lines.slice(start + 1);
  const end = rest.findIndex(l => l.startsWith('### '));
  return (end === -1 ? rest : rest.slice(0, end)).join('\n');
}

// Names listed under "### Relevant symbols:", in order.
export function renderedSymbols(text: string): string[] {
  return [...(section(text, 'Relevant symbols') ?? '').matchAll(/^#### \[[a-z]+\] `([^`]+)`$/gm)].map(m => m[1]);
}

// Names of the symbol (non-file, non-import) nodes in a context, in order.
export function symbolsOf(ctx: AgentContext): string[] {
  return ctx.subgraph.nodes.filter(n => n.type !== 'file' && n.type !== 'import').map(n => n.name);
}
