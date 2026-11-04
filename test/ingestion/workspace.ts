import { ASTParser } from '../../src/ingestion/astParser';
import { TestWorkspace } from '../helpers';

// Workspaces in one test file share a parser, so grammars load only once.
const sharedParser = new ASTParser();

export function newWorkspace(): TestWorkspace {
  const ws = new TestWorkspace();
  (ws as any).parser = sharedParser;
  return ws;
}
