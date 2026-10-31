import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as path from 'node:path';
import { ParsedFile } from '../../src/types';
import { ParserFixture, find, get, namesOf, fileNode } from './fixtures';

// C#, C++, C, Ruby, PHP, Swift and Kotlin have no LANG_QUERIES entry, so the
// line-based RegexFallbackParser is their primary parser. It emits only
// declarations (no imports, params, scope data or call references) and gives
// every declaration a fixed 50-line span (endLine = line + 49).

function assertRegexShape(parsed: ParsedFile, language: string): void {
  assert.equal(parsed.language, language);
  assert.deepEqual(parsed.parseErrors, []);
  assert.deepEqual(parsed.callRefs, []);
  const file = fileNode(parsed);
  const decls = parsed.nodes.filter(n => n.type !== 'file');
  for (const n of decls) {
    assert.equal(n.endLine, n.line + 49, `${n.name} gets the fixed span`);
    assert.equal(n.language, language);
    assert.equal(n.params, undefined);
    assert.match(n.hash ?? '', /^[0-9a-f]{12}$/);
  }
  assert.deepEqual(parsed.edges.map(e => e.type), decls.map(() => 'contains'));
  assert.ok(parsed.edges.every(e => e.fromId === file.id));
}

describe('Regex fallback languages', () => {
  const fx = new ParserFixture();
  after(() => fx.cleanup());

  it('C#: classes and interfaces', async () => {
    const p = await fx.parse('Svc.cs', `using System;
namespace Demo {
  public interface IRepo { }
  public abstract class Service : IRepo {
    public async Task Run(int x) {
      if (x > 0) { Helper(x); }
      foreach (var i in items) { }
    }
    private static void Helper(int y) { }
  }
}
`);
    assertRegexShape(p, 'c_sharp');
    assert.deepEqual(p.nodes.filter(n => n.type !== 'file').map(n => [n.type, n.name, n.line]), [
      ['interface', 'IRepo', 3],
      ['class', 'Service', 4],
    ]);
    assert.equal(get(p, 'Service').signature, 'public abstract class Service : IRepo {');
    assert.ok(!p.nodes.some(n => ['if', 'foreach', 'using'].includes(n.name)), 'control-flow keywords are not methods');
  });

  it('C++ (.cpp and .cc): classes', async () => {
    const cpp = await fx.parse('w.cpp', `#include <vector>
class Widget {
public:
  void draw() {
    for (int i = 0; i < 3; i++) {}
  }
};
`);
    assertRegexShape(cpp, 'cpp');
    assert.deepEqual(namesOf(cpp, 'class'), ['Widget']);
    assert.ok(!cpp.nodes.some(n => n.name === 'for'));

    const cc = await fx.parse('a.cc', 'class A {};\n');
    assert.equal(cc.language, 'cpp');
    assert.deepEqual(namesOf(cc, 'class'), ['A']);
  });

  it('does not turn an indented call statement into a method declaration', { todo: 'BUG: the indented-method regex matches call statements like `  render();` / `start()` (astParser.ts:1265)' }, async () => {
    const p = await fx.parse('call.cpp', 'class W {\n  void draw() {\n    render();\n  }\n};\n');
    assert.equal(find(p, 'render'), undefined);
  });

  it('C (.c and .h): file node, language c', async () => {
    const c = await fx.parse('u.c', '#include <stdio.h>\nint add(int a, int b) {\n  return a + b;\n}\n');
    assertRegexShape(c, 'c');
    assert.equal(fileNode(c).endLine, 5);
    const h = await fx.parse('u.h', 'int add(int a, int b);\n');
    assert.equal(h.language, 'c');
  });

  it('Ruby: classes', async () => {
    const p = await fx.parse('greeter.rb', 'class Greeter\n  def greet(name)\n    puts "hi"\n  end\nend\n');
    assertRegexShape(p, 'ruby');
    assert.deepEqual(namesOf(p, 'class'), ['Greeter']);
  });

  it('PHP: classes, methods and functions via the function keyword', async () => {
    const p = await fx.parse('ctrl.php', `<?php
class Controller {
  public function index() {
    return view('x');
  }
}
function helper() { }
`);
    assertRegexShape(p, 'php');
    assert.deepEqual(p.nodes.filter(n => n.type !== 'file').map(n => [n.type, n.name, n.line]), [
      ['class', 'Controller', 2],
      ['function', 'index', 3],
      ['function', 'helper', 7],
    ]);
  });

  it('Swift and Kotlin: classes', async () => {
    const swift = await fx.parse('car.swift', 'class Car {\n  func drive() {\n  }\n}\n');
    assertRegexShape(swift, 'swift');
    assert.deepEqual(namesOf(swift, 'class'), ['Car']);
    const kt = await fx.parse('repo.kt', 'class Repo {\n  fun load(id: Int) {\n  }\n}\n');
    assertRegexShape(kt, 'kotlin');
    assert.deepEqual(namesOf(kt, 'class'), ['Repo']);
  });

  it('drops functions but keeps classes for files under node_modules', async () => {
    const p = await fx.parse('node_modules/lib/x.php', '<?php\nclass Vendor {\n  public function run() {}\n}\nfunction util() {}\n');
    assert.deepEqual(p.nodes.filter(n => n.type !== 'file').map(n => n.name), ['Vendor']);
  });
});

describe('Synchronous parseFile (regex only)', () => {
  const fx = new ParserFixture();
  after(() => fx.cleanup());

  it('parses TS with the regex patterns', () => {
    const file = fx.write('sync.ts', [
      'export abstract class Base {}',
      'export interface Shape {}',
      'export async function load() {}',
      'export const handler = async (req) => req;',
      'let counter = 0;',
      '  public static compute(x) {',
      "  describe('suite', () => {});",
      '  if (ready) {',
      '',
    ].join('\n'));
    const p = fx.parser.parseFile(file);
    assert.equal(p.language, 'typescript');
    assert.deepEqual(p.nodes.filter(n => n.type !== 'file').map(n => [n.type, n.name, n.line]), [
      ['class', 'Base', 1],
      ['interface', 'Shape', 2],
      ['function', 'load', 3],
      ['function', 'handler', 4],
      ['variable', 'handler', 4],
      ['variable', 'counter', 5],
      ['method', 'compute', 6],
    ]);
    assert.ok(!p.nodes.some(n => n.type === 'import'));
  });

  it('reports unsupported and unreadable files', () => {
    const unsupported = fx.parser.parseFile(fx.write('notes.txt', 'hello'));
    assert.equal(unsupported.language, 'unknown');
    assert.deepEqual(unsupported.parseErrors, ['Unsupported']);

    const missing = fx.parser.parseFile(fx.path('missing.ts'));
    assert.equal(missing.language, 'typescript');
    assert.equal(missing.nodes.length, 0);
    assert.match(missing.parseErrors[0], /^Cannot read/);
  });

  it('returns nothing for blank files and handles config files', () => {
    const blank = fx.parser.parseFile(fx.write('blank.ts', '   \n'));
    assert.deepEqual(blank.nodes, []);
    assert.deepEqual(blank.parseErrors, []);

    const json = fx.parser.parseFile(fx.write('package.json', '{"name":"syncpkg","version":"2.0.0"}'));
    assert.equal(json.language, 'json');
    assert.equal(fileNode(json).signature, 'syncpkg@2.0.0');

    assert.equal(fx.parser.parseFile(fx.write('doc.md', '# hi')).language, 'markdown');
    assert.equal(fx.parser.parseFile(fx.write('c.yaml', 'a: 1')).language, 'yaml');
    assert.equal(fx.parser.parseFile(fx.write('node_modules/p/LICENSE', 'MIT')).language, 'config');
  });
});

describe('Config and metadata files', () => {
  const fx = new ParserFixture();
  after(() => fx.cleanup());

  async function onlyFileNode(rel: string, content: string, language: string) {
    const p = await fx.parse(rel, content);
    assert.equal(p.language, language);
    assert.deepEqual(p.parseErrors, []);
    assert.deepEqual(p.nodes.map(n => n.type), ['file']);
    assert.deepEqual(p.edges, []);
    assert.deepEqual(p.callRefs, []);
    return p.nodes[0];
  }

  it('package.json gets name@version as its signature', async () => {
    const f = await onlyFileNode('package.json', '{"name":"demo","version":"1.2.3"}\n', 'json');
    assert.equal(f.signature, 'demo@1.2.3');
    assert.equal(f.name, 'package.json');
  });

  it('package.json without a version falls back to 0.0.0; without a name gets no signature', async () => {
    assert.equal((await onlyFileNode('a/package.json', '{"name":"nover"}', 'json')).signature, 'nover@0.0.0');
    assert.equal((await onlyFileNode('b/package.json', '{"private":true}', 'json')).signature, undefined);
  });

  it('invalid package.json does not throw', async () => {
    assert.equal((await onlyFileNode('c/package.json', '{bad json', 'json')).signature, undefined);
  });

  it('other json, markdown and yaml files are file nodes only', async () => {
    assert.equal((await onlyFileNode('tsconfig.json', '{"name":"not-a-package"}', 'json')).signature, undefined);
    await onlyFileNode('README.md', '# Title\n\nfunction notCode() {}\n', 'markdown');
    await onlyFileNode('ci.yml', 'jobs:\n  build: {}\n', 'yaml');
    await onlyFileNode('ci.yaml', 'a: 1\n', 'yaml');
  });

  it('extensionless files under node_modules are config files', async () => {
    await onlyFileNode('node_modules/pkg/LICENSE', 'MIT', 'config');
  });

  it('whitelisted extensionless config files are config files', async () => {
    await onlyFileNode('Dockerfile', 'FROM node:20\n', 'config');
  });

  it('*.config.js keeps its language and is parsed as code', async () => {
    const p = await fx.parse('jest.config.js', 'module.exports = { testEnvironment: "node" };\n');
    assert.equal(p.language, 'javascript');
  });

  it('unsupported extensions are reported', async () => {
    const p = await fx.parse('notes.txt', 'plain text');
    assert.equal(p.language, 'unknown');
    assert.deepEqual(p.nodes, []);
    assert.deepEqual(p.parseErrors, ['Unsupported extension']);
  });
});

describe('Fallback when tree-sitter throws', () => {
  const fx = new ParserFixture();
  after(() => fx.cleanup());

  it('returns the regex parse instead of failing', async (t) => {
    const file = fx.write('flaky.ts', 'export function stable() {\n  return other();\n}\n');
    await fx.parser.parseFileAsync(file); // make sure tree-sitter is initialised

    // The tree-sitter path stats the file first; make only that call fail.
    const realStat = fs.statSync;
    let failed = false;
    t.mock.method(fs, 'statSync', function (this: unknown, ...args: Parameters<typeof fs.statSync>) {
      if (!failed) { failed = true; throw new Error('simulated tree-sitter failure'); }
      return realStat.apply(fs, args);
    });
    const warn = t.mock.method(console, 'warn', () => {});

    const p = await fx.parser.parseFileAsync(file);
    assert.ok(failed);
    assert.equal(warn.mock.callCount(), 1);
    assert.match(String(warn.mock.calls[0].arguments[0]), /tree-sitter failed for .*flaky\.ts/);
    assert.equal(p.language, 'typescript');
    const stable = get(p, 'stable', 'function');
    assert.equal(stable.endLine, stable.line + 49, 'regex span, not the real one');
    assert.deepEqual(p.callRefs, []);
    assert.equal(path.basename(fileNode(p).filePath), 'flaky.ts');
  });
});
