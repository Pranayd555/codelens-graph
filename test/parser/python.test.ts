import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { ParsedFile } from '../../src/types';
import { ParserFixture, find, get, namesOf, callsFrom, refsOf } from './fixtures';

// Python goes through tree-sitter for declarations, imports and calls, but its
// undefinedRefs come from the regex scan, which only looks at identifiers
// followed by "(" or "." (calls and attribute access).

const PY_SOURCE = `import os
import numpy.linalg as la
import json, re
from typing import List, Optional
from .models import User as U, Order

MAX_ITEMS = 10

# Service doc
class UserService(Base):
    """Docstring."""
    limit = 5

    def __init__(self, repo):
        self.repo = repo

    async def fetch(self, user_id: int, flag: bool = False, *args, **kwargs) -> Optional[U]:
        result = self.repo.get(user_id)
        for item in result:
            process(item)
        try:
            data = json.loads(result)
        except ValueError as exc:
            log(exc)
        return helper(data)

def helper(x):
    value = transform(x)
    print(len(value))
    return value.strip()

@decorator
def decorated(a, b=2):
    """Says: call fake_fn() please."""
    return a + b
`;

describe('Python declarations and imports', () => {
  const fx = new ParserFixture();
  let parsed: ParsedFile;

  before(async () => { parsed = await fx.parse('pkg/service.py', PY_SOURCE); });
  after(() => fx.cleanup());

  it('parses with the python grammar', () => {
    assert.equal(parsed.language, 'python');
    assert.deepEqual(parsed.parseErrors, []);
  });

  it('emits import nodes named after the module, including relative and dotted ones', () => {
    const imports = parsed.nodes.filter(n => n.type === 'import');
    assert.deepEqual(imports.map(n => n.name), ['os', 'numpy.linalg', 'json', 'typing', '.models']);
    assert.deepEqual(imports.map(n => n.line), [1, 2, 3, 4, 5]);
    assert.equal(imports[4].signature, 'from .models import User as U, Order');
    assert.equal(parsed.edges.filter(e => e.type === 'imports').length, 5);
  });

  it('extracts classes with their span and the # comment above as docComment', () => {
    const cls = get(parsed, 'UserService', 'class');
    assert.equal(cls.line, 10);
    assert.equal(cls.endLine, 25);
    assert.equal(cls.docComment, 'Service doc');
    assert.equal(cls.signature, 'class UserService(Base):');
  });

  it('extracts functions and methods with plain and default params', () => {
    const init = get(parsed, '__init__');
    assert.deepEqual(init.params?.map(p => p.name), ['self', 'repo']);
    const decorated = get(parsed, 'decorated');
    assert.equal(decorated.line, 33, 'line of the def, not the decorator');
    assert.deepEqual(decorated.params, [
      { name: 'a', type: undefined, defaultValue: undefined, rest: false },
      { name: 'b', type: undefined, defaultValue: '2', rest: false },
    ]);
  });

  it('reports async defs and their return annotation', () => {
    const fetch = get(parsed, 'fetch');
    assert.deepEqual(fetch.modifiers, ['async']);
    assert.equal(fetch.returnType, 'Optional[U]');
    assert.equal(fetch.line, 17);
    assert.equal(fetch.endLine, 25);
    assert.equal(fetch.signature, 'async def fetch(self, user_id: int, flag: bool = False, *args, **kwargs) -> Optional[U]:');
  });

  it('extracts typed, typed-default and splat params', { todo: 'BUG: typed_parameter/typed_default_parameter/*args/**kwargs are dropped from params (astParser.ts:797-799, 815-816)' }, () => {
    assert.deepEqual(get(parsed, 'fetch').params?.map(p => p.name), ['self', 'user_id', 'flag', 'args', 'kwargs']);
  });

  it('emits module-level and class-level assignments as variables', { todo: 'BUG: python `assignment` has no name field, so MAX_ITEMS/limit are never emitted (astParser.ts:144, 554-576)' }, () => {
    assert.ok(find(parsed, 'MAX_ITEMS', 'variable'));
    assert.ok(find(parsed, 'limit', 'variable'));
  });

  it('does not emit locals or self attributes as nodes', () => {
    for (const local of ['result', 'data', 'value', 'repo', 'item']) {
      assert.equal(find(parsed, local, 'variable'), undefined, local);
    }
  });

  it('records plain function calls with the enclosing def', () => {
    assert.deepEqual(callsFrom(parsed, 'fetch'), ['process', 'log', 'helper']);
    assert.deepEqual(callsFrom(parsed, 'helper'), ['transform', 'print', 'len']);
  });

  it('records attribute calls such as obj.method()', { todo: 'BUG: python `attribute` callees are ignored, so self.repo.get()/json.loads() produce no callRefs (astParser.ts:585-589)' }, () => {
    const calls = callsFrom(parsed, 'helper');
    assert.ok(calls.includes('value.strip'));
  });
});

describe('Python scope analysis', () => {
  const fx = new ParserFixture();
  let parsed: ParsedFile;

  before(async () => { parsed = await fx.parse('service.py', PY_SOURCE); });
  after(() => fx.cleanup());

  it('flags called names that are not imported, declared or params', () => {
    assert.deepEqual(refsOf(get(parsed, 'fetch')), ['log']);
    assert.ok(refsOf(get(parsed, 'helper')).includes('transform'));
    const edges = parsed.edges.filter(e => e.type === 'undefined_ref' && e.fromId === get(parsed, 'fetch').id);
    assert.deepEqual(edges.map(e => e.metadata?.symbolName), ['log']);
  });

  it('does not flag imports, module defs, self, loop vars, except-as names or strings', () => {
    const refs = [...refsOf(get(parsed, 'fetch')), ...refsOf(get(parsed, 'decorated'))];
    for (const ok of ['json', 'helper', 'self', 'item', 'exc', 'fake_fn']) {
      assert.ok(!refs.includes(ok), `${ok} should not be flagged`);
    }
    assert.ok(!refsOf(get(parsed, 'helper')).includes('x'));
  });

  it('only flags names used as calls or attribute bases', () => {
    // ValueError is only referenced in `except ValueError as exc:`.
    assert.ok(!refsOf(get(parsed, 'fetch')).includes('ValueError'));
  });

  it('collects for-loop, except-as and indented assignment locals', () => {
    const vars = get(parsed, 'fetch').localVars ?? [];
    for (const v of ['item', 'exc', 'data']) {
      assert.ok(vars.includes(v), v);
    }
  });

  it('does not flag Python builtins', { todo: 'BUG: Python builtins (print, len, ...) are flagged; only JS_BUILTINS are whitelisted (astParser.ts:1153-1175)' }, () => {
    const refs = refsOf(get(parsed, 'helper'));
    assert.ok(!refs.includes('print'));
    assert.ok(!refs.includes('len'));
  });

  it('treats the first assignment of a body as a local', { todo: 'BUG: /^\\s+(\\w+)\\s*=/ misses the first body line (no indent in body text), so `value` is flagged (astParser.ts:1128)' }, () => {
    assert.ok(!refsOf(get(parsed, 'helper')).includes('value'));
    assert.ok(get(parsed, 'fetch').localVars?.includes('result'));
  });

  it('ignores names inside # comments', { todo: 'BUG: stripStringsAndComments only knows JS comments, so `# cache.get()` yields an undefinedRef (astParser.ts:865-919)' }, async () => {
    const p = await fx.parse('comment.py', 'def commented(n):\n    total = n\n    # remember to call cache.get() later\n    return total\n');
    assert.deepEqual(refsOf(get(p, 'commented')), []);
  });

  it('still sees calls after floor division', { todo: 'BUG: `//` floor division is stripped as a JS line comment, hiding the rest of the line (astParser.ts:873-875)' }, async () => {
    const p = await fx.parse('floor.py', 'def halve(n):\n    return n // 2 + missing_after_floor(n)\n');
    assert.deepEqual(refsOf(get(p, 'halve')), ['missing_after_floor']);
  });
});

describe('Python robustness', () => {
  const fx = new ParserFixture();
  after(() => fx.cleanup());

  it('keeps valid defs around a syntax error', async () => {
    const p = await fx.parse('bad.py', 'def broken(:\n  pass\ndef good():\n  return 1\n');
    assert.ok(find(p, 'good', 'function'));
    assert.deepEqual(p.parseErrors, []);
  });

  it('handles nested functions and classes', async () => {
    const p = await fx.parse('nested.py', `class Outer:
    class Inner:
        def method(self):
            def local_helper():
                return 1
            return local_helper()
`);
    assert.deepEqual(namesOf(p, 'class'), ['Outer', 'Inner']);
    assert.ok(find(p, 'method'));
    assert.ok(find(p, 'local_helper'));
    assert.deepEqual(callsFrom(p, 'method'), ['local_helper']);
  });
});
