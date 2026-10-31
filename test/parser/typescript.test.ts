import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { makeNodeId, makeEdgeId } from '../../src/ingestion/astParser';
import { ParsedFile } from '../../src/types';
import { ParserFixture, find, get, namesOf, fileNode, callsFrom, refsOf } from './fixtures';

// Declarations, modifiers, params, imports, edges and call references emitted
// by the tree-sitter path for TypeScript, TSX and JavaScript.

const TS_SOURCE = `import { readFile, writeFile as wf } from 'fs/promises';
import * as path from 'path';
import Default from './dep';
import type { Thing } from "./types";

/**
 * Adds numbers.
 */
export function add(a: number, b: number = 2, ...rest: number[]): number {
  return a + b + helper(rest);
}

// Internal helper
function helper(xs: number[]): number {
  return xs.length;
}

export default async function main(opt?: string): Promise<void> {
  const data = await readFile(opt ?? 'x');
  const svc = new Service(data.toString());
  svc.run();
  path.join('a', 'b');
  missingFn(data);
  Math.max(1, 2);
}

export interface Shape { area(): number; }
export type Id = string | number;
export enum Color { Red, Green }

export abstract class Base {
  abstract name(): string;
}

export class Service extends Base {
  private static count = 0;
  constructor(private readonly input: string) { super(); }
  name(): string { return 'svc'; }
  public async run(): Promise<number> {
    this.log();
    return Service.count;
  }
  static create(): Service { return new Service(''); }
  private log() { console.log(this.input); }
}

export const arrow = async (x: string): Promise<string> => x.trim();
const VALUE = 42;
let mutable = { a: 1 };
const { p, q } = mutable as any;
const [first] = [1];
`;

describe('TypeScript declarations', () => {
  const fx = new ParserFixture();
  let parsed: ParsedFile;
  let filePath: string;

  before(async () => {
    filePath = fx.write('src/service.ts', TS_SOURCE);
    parsed = await fx.parser.parseFileAsync(filePath);
  });
  after(() => fx.cleanup());

  it('reports the language, path and no parse errors', () => {
    assert.equal(parsed.language, 'typescript');
    assert.equal(parsed.filePath, filePath);
    assert.deepEqual(parsed.parseErrors, []);
  });

  it('emits one file node describing the whole file', () => {
    const files = parsed.nodes.filter(n => n.type === 'file');
    assert.equal(files.length, 1);
    const f = files[0];
    assert.equal(f.name, 'service.ts');
    assert.equal(f.id, makeNodeId(filePath, '__file__', 0));
    assert.equal(f.line, 0);
    assert.equal(f.endLine, TS_SOURCE.split('\n').length);
    assert.equal(f.size, Buffer.byteLength(TS_SOURCE));
    assert.match(f.hash ?? '', /^[0-9a-f]{12}$/);
    assert.equal(typeof f.lastModified, 'number');
  });

  it('emits an import node per import statement, named after the module', () => {
    const imports = parsed.nodes.filter(n => n.type === 'import');
    assert.deepEqual(imports.map(n => n.name), ['fs/promises', 'path', './dep', './types']);
    assert.deepEqual(imports.map(n => n.line), [1, 2, 3, 4]);
    assert.equal(imports[0].signature, "import { readFile, writeFile as wf } from 'fs/promises';");
    assert.equal(imports[3].signature, 'import type { Thing } from "./types";');
  });

  it('links every import node to the file with an imports edge', () => {
    const file = fileNode(parsed);
    const importIds = parsed.nodes.filter(n => n.type === 'import').map(n => n.id).sort();
    const edges = parsed.edges.filter(e => e.type === 'imports');
    assert.deepEqual(edges.map(e => e.toId).sort(), importIds);
    for (const e of edges) {
      assert.equal(e.fromId, file.id);
      assert.equal(e.id, makeEdgeId(file.id, 'imports', e.toId));
    }
  });

  it('links every declaration to the file with a contains edge', () => {
    const file = fileNode(parsed);
    const declared = parsed.nodes.filter(n => n.type !== 'file' && n.type !== 'import');
    const contains = parsed.edges.filter(e => e.type === 'contains');
    assert.equal(contains.length, declared.length);
    assert.deepEqual(contains.map(e => e.toId).sort(), declared.map(n => n.id).sort());
    assert.ok(contains.every(e => e.fromId === file.id));
  });

  it('builds node ids from path, name and line', () => {
    for (const n of parsed.nodes.filter(x => x.type !== 'file' && x.type !== 'import')) {
      assert.equal(n.id, makeNodeId(filePath, n.name, n.line));
      assert.equal(n.filePath, filePath);
      assert.equal(n.language, 'typescript');
    }
  });

  it('extracts a function with typed, default and rest params', () => {
    const add = get(parsed, 'add', 'function');
    assert.equal(add.line, 9);
    assert.equal(add.endLine, 11);
    assert.deepEqual(add.params, [
      { name: 'a', type: 'number', defaultValue: undefined, rest: false },
      { name: 'b', type: 'number', defaultValue: '2', rest: false },
      { name: 'rest', type: 'number[]', defaultValue: undefined, rest: true },
    ]);
    assert.deepEqual(add.modifiers, ['export']);
    assert.equal(add.signature, 'function add(a: number, b: number = 2, ...rest: number[]): number {');
    assert.ok(add.returnType?.endsWith('number'));
    assert.ok(add.docComment?.startsWith('Adds numbers.'));
  });

  it('returnType carries just the type, like params do', { todo: 'BUG: TS returnType keeps the leading ": " of the type annotation (astParser.ts:432)' }, () => {
    assert.equal(get(parsed, 'add').returnType, 'number');
    assert.equal(get(parsed, 'main').returnType, 'Promise<void>');
  });

  it('strips the closing */ from JSDoc comments', { todo: 'BUG: JSDoc docComment ends with a stray "/" from the closing */ line (astParser.ts:855-856)' }, () => {
    assert.equal(get(parsed, 'add').docComment, 'Adds numbers.');
  });

  it('takes a // comment directly above a declaration as its docComment', () => {
    const helper = get(parsed, 'helper', 'function');
    assert.equal(helper.docComment, 'Internal helper');
    assert.deepEqual(helper.modifiers, []);
    assert.equal(get(parsed, 'Shape').docComment, undefined);
  });

  it('marks async and exported functions', () => {
    const main = get(parsed, 'main', 'function');
    assert.ok(main.modifiers?.includes('async'));
    assert.ok(main.modifiers?.includes('export'));
    assert.deepEqual(main.params, [{ name: 'opt', type: 'string', defaultValue: undefined, rest: false }]);
  });

  it('marks default exports with the default modifier', { todo: 'BUG: "default" is never reported for `export default function` (astParser.ts:843 only adds export)' }, () => {
    assert.ok(get(parsed, 'main').modifiers?.includes('default'));
  });

  it('extracts interfaces, type aliases and enums', () => {
    assert.deepEqual(namesOf(parsed, 'interface'), ['Shape']);
    assert.deepEqual(namesOf(parsed, 'type'), ['Id']);
    assert.deepEqual(namesOf(parsed, 'enum'), ['Color']);
    assert.deepEqual(get(parsed, 'Color').modifiers, ['export']);
    assert.equal(get(parsed, 'Id').signature, 'type Id = string | number;');
  });

  it('extracts classes with their span and abstract/export modifiers', () => {
    assert.deepEqual(namesOf(parsed, 'class'), ['Base', 'Service']);
    const base = get(parsed, 'Base', 'class');
    assert.ok(base.modifiers?.includes('abstract'));
    assert.ok(base.modifiers?.includes('export'));
    const svc = get(parsed, 'Service', 'class');
    assert.equal(svc.line, 35);
    assert.equal(svc.endLine, 45);
    assert.equal(svc.signature, 'class Service extends Base {');
  });

  it('extracts methods with access/static/async modifiers', () => {
    assert.deepEqual(namesOf(parsed, 'method'), ['constructor', 'name', 'run', 'create', 'log']);
    assert.deepEqual(get(parsed, 'run', 'method').modifiers, ['public', 'async']);
    assert.deepEqual(get(parsed, 'create', 'method').modifiers, ['static']);
    assert.deepEqual(get(parsed, 'log', 'method').modifiers, ['private']);
    const ctor = get(parsed, 'constructor', 'method');
    assert.deepEqual(ctor.params?.map(p => [p.name, p.type]), [['input', 'string']]);
  });

  it('records classes constructed with new as instantiates + edges', () => {
    assert.deepEqual(get(parsed, 'create', 'method').instantiates, ['Service']);
    const main = get(parsed, 'main');
    assert.deepEqual(main.instantiates, ['Service']);
    const edge = parsed.edges.find(e => e.type === 'instantiates' && e.fromId === main.id);
    assert.ok(edge);
    assert.equal(edge.toId, '__class__::Service');
    assert.deepEqual(edge.metadata, { className: 'Service' });
  });

  it('emits module-level variables but not destructured ones', () => {
    const vars = namesOf(parsed, 'variable');
    assert.ok(vars.includes('VALUE'));
    assert.ok(vars.includes('mutable'));
    assert.ok(vars.includes('arrow'));
    assert.deepEqual(get(parsed, 'arrow').modifiers, ['export']);
    assert.equal(get(parsed, 'VALUE').line, 48);
    assert.ok(!parsed.nodes.some(n => /[{[\]]/.test(n.name)), 'no node named after a binding pattern');
    for (const local of ['data', 'svc', 'p', 'q', 'first']) {
      assert.equal(find(parsed, local, 'variable'), undefined, `${local} should not be a variable node`);
    }
  });

  it('does not emit nodes for class fields or abstract signatures', () => {
    assert.equal(find(parsed, 'count'), undefined);
    assert.equal(parsed.nodes.filter(n => n.name === 'name').length, 1, 'only the concrete name() method');
  });

  it('flags undefined references and emits undefined_ref edges', () => {
    const main = get(parsed, 'main');
    assert.deepEqual(main.undefinedRefs, ['missingFn']);
    const edge = parsed.edges.find(e => e.type === 'undefined_ref' && e.fromId === main.id);
    assert.ok(edge);
    assert.equal(edge.toId, `${filePath}::missingFn::0`);
    assert.deepEqual(edge.metadata, { symbolName: 'missingFn' });
  });

  it('records every call with its enclosing function and qualifier', () => {
    assert.deepEqual(callsFrom(parsed, 'add'), ['helper']);
    assert.deepEqual(callsFrom(parsed, 'main'), [
      'readFile', 'data.toString', 'svc.run', 'path.join', 'missingFn', 'Math.max',
    ]);
    assert.deepEqual(callsFrom(parsed, 'run'), ['this.log']);
    assert.deepEqual(callsFrom(parsed, 'log'), ['console.log']);
  });

  it('gives call references stable ids with line and column', () => {
    const main = get(parsed, 'main');
    const ref = parsed.callRefs.find(c => c.symbolName === 'missingFn');
    assert.ok(ref);
    assert.equal(ref.line, 23);
    assert.equal(ref.fromId, main.id);
    assert.equal(ref.filePath, filePath);
    assert.equal(ref.qualifier, undefined);
    assert.equal(ref.id, `${main.id}::call::missingFn::23:2`);
  });

  it('keeps calls made inside a const arrow function', { todo: 'BUG: `const f = () => g()` yields only a variable node, so calls in it are dropped (astParser.ts:554-576 never names arrow_function; 596 needs a function node)' }, () => {
    assert.ok(parsed.callRefs.some(c => c.symbolName === 'trim'));
  });
});

describe('TypeScript CommonJS require wrappers', () => {
  const fx = new ParserFixture();
  after(() => fx.cleanup());

  it('unwraps `as` casts, member access and non-null assertions around require()', async () => {
    const parsed = await fx.parse('req.ts', [
      "const settings = (require('./cfg') as any).settings;",
      "const lib = require('./lib')!;",
      'const notReq = compute();',
      'export function useAll() { return settings + lib; }',
      '',
    ].join('\n'));
    const imports = parsed.nodes.filter(n => n.type === 'import');
    assert.deepEqual(imports.map(n => [n.name, n.line]), [['./cfg', 1], ['./lib', 2]]);
    assert.equal(find(parsed, 'settings', 'variable'), undefined);
    assert.equal(find(parsed, 'lib', 'variable'), undefined);
    assert.ok(find(parsed, 'notReq', 'variable'));
    assert.deepEqual(refsOf(get(parsed, 'useAll')), []);
  });

  it('unwraps an angle-bracket type assertion around require()', { todo: 'BUG: `(<any>require("x"))` is not seen as an import; type_assertion unwrap picks the type argument (astParser.ts:651)' }, async () => {
    const parsed = await fx.parse('old.ts', "const wrapped = (<any>require('./old'));\n");
    assert.deepEqual(parsed.nodes.filter(n => n.type === 'import').map(n => n.name), ['./old']);
  });
});

describe('TSX components', () => {
  const fx = new ParserFixture();
  let parsed: ParsedFile;

  before(async () => {
    parsed = await fx.parse('Counter.tsx', `import React, { useState } from 'react';
import { Button } from './Button';

export function Counter({ initial, label }: { initial: number; label: string }) {
  const [count, setCount] = useState(initial);
  return (
    <div className="counter">
      <Button onClick={() => setCount(count + 1)}>{label}</Button>
      <Missing />
    </div>
  );
}

export default function App(): JSX.Element {
  return <Counter initial={1} label="x" />;
}
`);
  });
  after(() => fx.cleanup());

  it('parses with the tsx grammar', () => {
    assert.equal(parsed.language, 'tsx');
    assert.deepEqual(parsed.parseErrors, []);
    assert.deepEqual(parsed.nodes.filter(n => n.type === 'import').map(n => n.name), ['react', './Button']);
  });

  it('extracts destructured props as params', () => {
    const counter = get(parsed, 'Counter', 'function');
    assert.deepEqual(counter.params?.map(p => p.name), ['initial', 'label']);
    assert.equal(counter.line, 4);
    assert.equal(counter.endLine, 12);
    assert.ok(get(parsed, 'App').returnType?.includes('JSX.Element'));
  });

  it('flags an unimported component but not imported ones or locals', () => {
    const refs = refsOf(get(parsed, 'Counter'));
    assert.ok(refs.includes('Missing'));
    for (const ok of ['Button', 'useState', 'React', 'count', 'setCount', 'initial', 'label']) {
      assert.ok(!refs.includes(ok), `${ok} should be in scope`);
    }
    assert.deepEqual(refsOf(get(parsed, 'App')), [], 'Counter is declared in this file');
  });

  it('does not flag intrinsic lowercase JSX elements', { todo: 'BUG: <div>/<section> tag names are reported as undefinedRefs (astParser.ts:1196-1202 treats jsx tag identifiers as references)' }, () => {
    assert.ok(!refsOf(get(parsed, 'Counter')).includes('div'));
  });

  it('records hook and callback calls', () => {
    assert.deepEqual(callsFrom(parsed, 'Counter'), ['useState', 'setCount']);
  });
});

describe('JavaScript modules', () => {
  const fx = new ParserFixture();
  let parsed: ParsedFile;

  before(async () => {
    parsed = await fx.parse('lib/mod.js', `import def, { named } from './lib.js';
export class Animal {
  constructor(name) { this.name = name; }
  speak() { return \`\${this.name} \${named()}\`; }
  static of(n) { return new Animal(n); }
}
export async function load(url, { retries = 3 } = {}) {
  const res = await fetch(url);
  return def(res, retries, globalThing);
}
var legacy = function namedExpr(a) { return a; };
export const arrowFn = (a, b) => helperX(a, b);
function withDefault(p = 1, ...rest) { return p + rest.length; }
`);
  });
  after(() => fx.cleanup());

  it('parses with the javascript grammar', () => {
    assert.equal(parsed.language, 'javascript');
    assert.deepEqual(parsed.nodes.filter(n => n.type === 'import').map(n => n.name), ['./lib.js']);
  });

  it('extracts classes, methods and static modifiers', () => {
    assert.deepEqual(namesOf(parsed, 'class'), ['Animal']);
    assert.deepEqual(namesOf(parsed, 'method'), ['constructor', 'speak', 'of']);
    const of = get(parsed, 'of', 'method');
    assert.deepEqual(of.modifiers, ['static']);
    assert.deepEqual(of.params?.map(p => p.name), ['n']);
    assert.deepEqual(of.instantiates, ['Animal']);
  });

  it('extracts functions, named function expressions and var declarations', () => {
    const load = get(parsed, 'load', 'function');
    assert.deepEqual(load.modifiers?.slice().sort(), ['async', 'export']);
    assert.equal(load.params?.[0].name, 'url');
    assert.deepEqual(load.localVars, ['res']);
    assert.ok(find(parsed, 'namedExpr', 'function'));
    assert.ok(find(parsed, 'legacy', 'variable'));
    assert.ok(find(parsed, 'arrowFn', 'variable'));
  });

  it('records calls inside template literals', () => {
    assert.deepEqual(callsFrom(parsed, 'speak'), ['named']);
    assert.deepEqual(callsFrom(parsed, 'load'), ['fetch', 'def']);
  });

  it('flags a global that is neither declared nor imported', () => {
    assert.ok(refsOf(get(parsed, 'load')).includes('globalThing'));
  });

  it('treats default, rest and destructured params as parameters', { todo: 'BUG: JS assignment_pattern/rest_pattern/object_pattern params are skipped, so they go missing and are flagged as undefinedRefs (astParser.ts:797-798)' }, () => {
    const withDefault = get(parsed, 'withDefault');
    assert.deepEqual(withDefault.params?.map(p => p.name), ['p', 'rest']);
    assert.deepEqual(refsOf(withDefault), []);
    assert.deepEqual(refsOf(get(parsed, 'load')), ['globalThing']);
  });

  it('maps .mjs and .jsx to javascript, including JSX syntax', async () => {
    const mjs = await fx.parse('m.mjs', "export function hello() { return 'hi'; }\n");
    assert.equal(mjs.language, 'javascript');
    assert.ok(find(mjs, 'hello', 'function'));

    const jsx = await fx.parse('View.jsx', `import { Card } from './Card';
export function View(props) {
  return <section>{props.items.map(i => <Card key={i.id} />)}</section>;
}
`);
    assert.equal(jsx.language, 'javascript');
    const view = get(jsx, 'View', 'function');
    assert.ok(!refsOf(view).includes('Card'));
    assert.deepEqual(callsFrom(jsx, 'View'), ['props.items.map']);
  });
});

describe('Declaration names that collide with keyword / test-hook filters', () => {
  const fx = new ParserFixture();
  after(() => fx.cleanup());

  it('keeps ordinary declarations while skipping test-hook callbacks', async () => {
    const parsed = await fx.parse('spec.ts', `describe('x', () => {
  it('y', () => { run(); });
});
export function run() { return 1; }
`);
    assert.deepEqual(namesOf(parsed, 'function'), ['run']);
  });

  it('keeps methods named like keywords or test hooks', { todo: 'BUG: KEYWORDS/TEST_HOOKS filters drop real declarations named delete/new/setup/before/after/test (astParser.ts:417-418)' }, async () => {
    const parsed = await fx.parse('holder.ts', `export class Holder {
  delete(key: string) { return key; }
  setup() { return 1; }
}
export function test() { return 2; }
`);
    assert.deepEqual(namesOf(parsed, 'method'), ['delete', 'setup']);
    assert.ok(find(parsed, 'test', 'function'));
  });
});
