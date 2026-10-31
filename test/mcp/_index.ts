import * as path from 'node:path';
import { GraphDB } from '../../src/graph/graphDB';
import { ASTParser } from '../../src/ingestion/astParser';
import { WorkspaceScanner } from '../../src/ingestion/workspaceScanner';
import { SCAN_OPTIONS } from '../helpers';

// Pre-built indexes, written in-process before a server starts, so a workspace
// counts as "known" (has .codelens/codelens-graph.db) without the server
// indexing it.

// One parser per process: a second ASTParser in the same process fails to
// initialise tree-sitter and silently falls back to regex parsing.
let sharedParser: ASTParser | undefined;
export const parser = (): ASTParser => (sharedParser ??= new ASTParser());

// Scans dir into dir/.codelens/codelens-graph.db.
export async function buildIndex(dir: string): Promise<void> {
  const db = new GraphDB(path.join(dir, '.codelens'), { followExternalWrites: false });
  await db.init();
  await new WorkspaceScanner(parser(), db).scanWorkspace({ workspaceRoot: dir, folders: [] }, SCAN_OPTIONS);
  db.persist();
  db.close();
}

// An empty DB: known to the server, which then indexes it in the background.
export async function emptyIndex(dir: string): Promise<void> {
  const db = new GraphDB(path.join(dir, '.codelens'), { followExternalWrites: false });
  await db.init();
  db.persist();
  db.close();
}
