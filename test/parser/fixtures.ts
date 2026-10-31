import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ASTParser } from '../../src/ingestion/astParser';
import { CallReference, GraphNode, NodeType, ParsedFile } from '../../src/types';

// The one ASTParser per test process. Every test file runs in its own process,
// and only the first ASTParser in a process gets tree-sitter: web-tree-sitter
// replaces its module exports during init, so a later instance's init fails
// and it silently falls back to regex (see multi_instance.test.ts).
export const sharedParser = new ASTParser();

// Throwaway directory of source files, parsed with the shared parser.
export class ParserFixture {
  readonly root = fs.mkdtempSync(path.join(os.tmpdir(), 'codelens-parser-'));
  readonly parser = sharedParser;

  path(rel: string): string {
    return path.join(this.root, ...rel.split('/'));
  }

  write(rel: string, content: string | Buffer): string {
    const filePath = this.path(rel);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content);
    return filePath;
  }

  async parse(rel: string, content: string | Buffer): Promise<ParsedFile> {
    return this.parser.parseFileAsync(this.write(rel, content));
  }

  cleanup(): void {
    try { fs.rmSync(this.root, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

export function find(parsed: ParsedFile, name: string, type?: NodeType): GraphNode | undefined {
  return parsed.nodes.find(n => n.name === name && (!type || n.type === type));
}

export function get(parsed: ParsedFile, name: string, type?: NodeType): GraphNode {
  const found = find(parsed, name, type);
  if (!found) {
    const have = parsed.nodes.map(n => `${n.type}:${n.name}`).join(', ');
    throw new Error(`no ${type ?? 'node'} named ${name}; have [${have}]`);
  }
  return found;
}

export function namesOf(parsed: ParsedFile, type: NodeType): string[] {
  return parsed.nodes.filter(n => n.type === type).map(n => n.name);
}

export function fileNode(parsed: ParsedFile): GraphNode {
  return get(parsed, path.basename(parsed.filePath), 'file');
}

// Calls made from inside the named function/method, as "qualifier.symbol"
// (or just "symbol" when unqualified), in source order.
export function callsFrom(parsed: ParsedFile, fnName: string): string[] {
  const fn = parsed.nodes.find(n => n.name === fnName && (n.type === 'function' || n.type === 'method'));
  if (!fn) { throw new Error(`no function ${fnName}`); }
  return parsed.callRefs
    .filter((c: CallReference) => c.fromId === fn.id)
    .map(c => (c.qualifier ? `${c.qualifier}.${c.symbolName}` : c.symbolName));
}

export function refsOf(node: GraphNode): string[] {
  return node.undefinedRefs ?? [];
}
