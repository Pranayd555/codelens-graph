import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { ParsedFile } from '../../src/types';
import { ParserFixture, get, refsOf } from './fixtures';

// Scope analysis for TS/JS function bodies: which identifiers end up in
// undefinedRefs (AST-based for TS/JS: any non-declaring identifier, not only
// calls), localVars (regex-based) and instantiates.

const SCOPE_SOURCE = `import { known } from './k';
const TOP = 1;
function topFn() { return 1; }

export function outer(param: number) {
  const local = param + TOP;
  let { a, b: renamed, c = 3, ...others } = known();
  const [x1, , x2] = [1, 2, 3];
  function inner(innerParam: string) {
    return local + innerParam.length + closureMissing() + TOP;
  }
  try {
    inner('x');
  } catch (err) {
    console.error(err);
  }
  for (const item of [1, 2]) { topFn(); item.toFixed(); }
  for (const key in others) { key.trim(); }
  for (let idx = 0; idx < 2; idx++) { idx.toString(); }
  [1].map(v => v * 2).forEach((w, pos) => w + pos);
  const later = 1;
  return notDeclaredVar + a + renamed + c + x1 + x2 + later + unknownCall();
}

export function noise(count: number) {
  // commentedCall() in a comment
  /* blockCall() in a block comment */
  const s = 'stringCall()' + "dq()" + \`tpl\${count}\`;
  const re = /regexCall\\(\\)/g;
  const typed: Map<string, Array<number>> = new Map();
  const obj = { keyed: 1 };
  return s + re.source + typed.size + obj.keyed + count.toFixed() + q;
}
`;

describe('TS scope analysis: undefinedRefs', () => {
  const fx = new ParserFixture();
  let parsed: ParsedFile;

  before(async () => { parsed = await fx.parse('scope.ts', SCOPE_SOURCE); });
  after(() => fx.cleanup());

  it('flags undeclared calls and undeclared plain references', () => {
    const refs = refsOf(get(parsed, 'outer'));
    assert.ok(refs.includes('unknownCall'));
    assert.ok(refs.includes('notDeclaredVar'), 'non-call references are flagged too in TS/JS');
  });

  it('reports refs from a nested function on the enclosing function as well', () => {
    assert.ok(refsOf(get(parsed, 'outer')).includes('closureMissing'));
    assert.ok(refsOf(get(parsed, 'inner')).includes('closureMissing'));
  });

  it('lists each undefined ref once and emits one edge per ref', () => {
    const outer = get(parsed, 'outer');
    const refs = refsOf(outer);
    assert.equal(new Set(refs).size, refs.length);
    const edges = parsed.edges.filter(e => e.type === 'undefined_ref' && e.fromId === outer.id);
    assert.deepEqual(edges.map(e => e.metadata?.symbolName).sort(), [...refs].sort());
  });

  it('does not flag params, locals, imports, module symbols or builtins', () => {
    const refs = refsOf(get(parsed, 'outer'));
    for (const ok of ['param', 'local', 'TOP', 'topFn', 'known', 'inner', 'console', 'later']) {
      assert.ok(!refs.includes(ok), `${ok} is in scope`);
    }
  });

  it('does not flag object/array destructuring bindings (renamed, defaulted, rest, holes)', () => {
    const refs = refsOf(get(parsed, 'outer'));
    for (const ok of ['a', 'renamed', 'c', 'others', 'x1', 'x2']) {
      assert.ok(!refs.includes(ok), `${ok} is bound by destructuring`);
    }
  });

  it('does not flag catch params, loop variables or arrow callback params', () => {
    const refs = refsOf(get(parsed, 'outer'));
    for (const ok of ['err', 'item', 'key', 'idx', 'w', 'pos']) {
      assert.ok(!refs.includes(ok), `${ok} is bound locally`);
    }
  });

  it('lets a nested function see parent params, earlier parent locals and its own params', () => {
    const refs = refsOf(get(parsed, 'inner'));
    for (const ok of ['local', 'innerParam', 'TOP', 'param']) {
      assert.ok(!refs.includes(ok), `${ok} is visible from inner`);
    }
  });

  it('ignores property names, strings, comments, regex literals, type names and 1-char names', () => {
    const noise = get(parsed, 'noise');
    // `q` is undeclared but single-character names are never reported.
    assert.deepEqual(refsOf(noise), []);
  });
});

describe('TS scope analysis: localVars and instantiates', () => {
  const fx = new ParserFixture();
  let parsed: ParsedFile;

  before(async () => { parsed = await fx.parse('scope.ts', SCOPE_SOURCE); });
  after(() => fx.cleanup());

  it('collects declared locals, loop vars, catch params and nested callback params', () => {
    const vars = get(parsed, 'outer').localVars ?? [];
    for (const v of ['local', 'a', 'c', 'x1', 'x2', 'err', 'item', 'key', 'idx', 'later', 'v', 'w', 'pos', 'innerParam']) {
      assert.ok(vars.includes(v), `${v} should be a local var`);
    }
    assert.equal(new Set(vars).size, vars.length, 'deduplicated');
  });

  it('records the bound name of renamed/rest destructuring as the local', { todo: 'BUG: `{ b: renamed, ...others }` yields localVar "b" (the key) and drops renamed/others (astParser.ts:1129,1141)' }, () => {
    const vars = get(parsed, 'outer').localVars ?? [];
    assert.ok(vars.includes('renamed'));
    assert.ok(vars.includes('others'));
    assert.ok(!vars.includes('b'));
  });

  it('records `new X()` instantiations, even with generic type annotations before them', () => {
    assert.deepEqual(get(parsed, 'noise').instantiates, ['Map']);
    assert.equal(get(parsed, 'outer').instantiates, undefined);
  });

  it('omits localVars/undefinedRefs/instantiates when empty', async () => {
    const p = await fx.parse('empty-scope.ts', 'export function nothing() { return 1; }\n');
    const fn = get(p, 'nothing');
    assert.equal(fn.localVars, undefined);
    assert.equal(fn.undefinedRefs, undefined);
    assert.equal(fn.instantiates, undefined);
    assert.ok(!p.edges.some(e => e.type === 'undefined_ref' || e.type === 'instantiates'));
  });

  it('records classes constructed inside object literals and ternaries', { todo: 'BUG: stripTypeAnnotations treats `key: value` and `? a : b` as type annotations, hiding `new X()` (astParser.ts:922-1001)' }, async () => {
    const p = await fx.parse('factory.ts', `export class Factory {}
export class Other {}
export function build(flag: boolean) {
  const holder = { inst: new Factory() };
  return flag ? holder : new Other();
}
`);
    assert.deepEqual(get(p, 'build').instantiates?.slice().sort(), ['Factory', 'Other']);
  });
});

describe('JS scope analysis', () => {
  const fx = new ParserFixture();
  after(() => fx.cleanup());

  it('treats hoisted module functions and classes declared later as in scope', async () => {
    const p = await fx.parse('hoist.js', `export function first() {
  return second() + new Later().x + LATER_CONST;
}
function second() { return 2; }
class Later { constructor() { this.x = 1; } }
const LATER_CONST = 3;
`);
    assert.deepEqual(refsOf(get(p, 'first')), []);
    assert.deepEqual(get(p, 'first').instantiates, ['Later']);
  });

  it('does not let a function-local declaration leak into another function', async () => {
    const p = await fx.parse('leak.js', `function one() { const shared = 1; return shared; }
function two() { return shared; }
`);
    assert.deepEqual(refsOf(get(p, 'one')), []);
    assert.deepEqual(refsOf(get(p, 'two')), ['shared']);
  });

  it('sees closure vars of the enclosing function from a method-like callback', async () => {
    const p = await fx.parse('closure.js', `export function makeCounter(start) {
  let current = start;
  function tick(step) { current += step; return current + start; }
  return tick;
}
`);
    assert.deepEqual(refsOf(get(p, 'tick')), []);
    assert.deepEqual(get(p, 'tick').params?.map(x => x.name), ['step']);
  });

  it('flags a shorthand property that refers to an undeclared name', { todo: 'BUG: `{ missing }` object shorthand is never checked (astParser.ts:1197 only visits identifier nodes)' }, async () => {
    const p = await fx.parse('shorthand.js', 'export function pack() { return { missingValue }; }\n');
    assert.deepEqual(refsOf(get(p, 'pack')), ['missingValue']);
  });
});
