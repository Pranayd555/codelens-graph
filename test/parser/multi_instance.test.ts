import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { ASTParser } from '../../src/ingestion/astParser';
import { ParserFixture, get } from './fixtures';

// Kept in its own file (= its own process): it deliberately creates a second
// ASTParser, which leaves web-tree-sitter in a state other tests must not see.
describe('Several ASTParser instances in one process', () => {
  const fx = new ParserFixture();
  after(() => fx.cleanup());

  const source = 'export function caller() {\n  return callee();\n}\nfunction callee() { return 1; }\n';

  it('the first instance parses with tree-sitter', async () => {
    const p = await fx.parse('first.ts', source);
    assert.equal(get(p, 'caller').endLine, 3);
    assert.equal(p.callRefs.length, 1);
  });

  it('a second instance still parses with tree-sitter', { todo: 'BUG: web-tree-sitter swaps its module exports during init, so a later TreeSitterParser.init() hits "Parser.init is not a function" and silently degrades to regex (astParser.ts:237,250; mcpServer.ts:271 makes one ASTParser per workspace)' }, async (t) => {
    t.mock.method(console, 'warn', () => {});
    const second = new ASTParser();
    const p = await second.parseFileAsync(fx.write('second.ts', source));
    assert.equal(get(p, 'caller').endLine, 3);
    assert.equal(p.callRefs.length, 1);
  });
});
