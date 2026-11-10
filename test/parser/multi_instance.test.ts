import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { ASTParser } from '../../src/ingestion/astParser';
import { ParserFixture, get } from './fixtures';

// Kept in its own file (= its own process): it deliberately creates a second
// ASTParser, and web-tree-sitter can only be initialised once per process.
describe('Several ASTParser instances in one process', () => {
  const fx = new ParserFixture();
  after(() => fx.cleanup());

  const source = 'export function caller() {\n  return callee();\n}\nfunction callee() { return 1; }\n';

  it('the first instance parses with tree-sitter', async () => {
    const p = await fx.parse('first.ts', source);
    assert.equal(get(p, 'caller').endLine, 3);
    assert.equal(p.callRefs.length, 1);
  });

  it('a second instance still parses with tree-sitter', async (t) => {
    t.mock.method(console, 'warn', () => {});
    const second = new ASTParser();
    const p = await second.parseFileAsync(fx.write('second.ts', source));
    assert.equal(get(p, 'caller').endLine, 3);
    assert.equal(p.callRefs.length, 1);
  });
});
