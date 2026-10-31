import { ASTParser } from '../../src/ingestion/astParser';
import { TestWorkspace } from '../helpers';

// web-tree-sitter can only be initialised once per process: a second ASTParser
// logs "Parser.init is not a function" and silently falls back to regex
// parsing, which resolves fewer calls. Workspaces in one test file therefore
// share a single parser.
const sharedParser = new ASTParser();

export function newWorkspace(): TestWorkspace {
  const ws = new TestWorkspace();
  (ws as any).parser = sharedParser;
  return ws;
}
