import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { ParsedFile } from '../../src/types';
import { ParserFixture, find, get, namesOf, callsFrom, refsOf } from './fixtures';

// Go, Rust and Java use tree-sitter for declarations and calls; their scope
// analysis falls back to the regex scan (identifiers followed by "(" or ".").

const GO_SOURCE = `package main

import (
\t"fmt"
\tstr "strings"
)

import "os"

const Version = "1.0"
var counter int

type Server struct {
\tName string
}

type Handler interface {
\tServe() error
}

// NewServer builds a server.
func NewServer(name string, port int) *Server {
\ts := &Server{Name: name}
\tfmt.Println(str.ToUpper(name))
\treturn s
}

func (s *Server) Start(ctx context.Context) (int, error) {
\thelper(s.Name)
\ts.stop()
\tos.Exit(0)
\treturn 0, nil
}

func helper(n string) {}
`;

const RUST_SOURCE = `use std::collections::HashMap;
use crate::util::{a, b};

/// A point.
pub struct Point { x: i32, y: i32 }

pub enum Shape { Circle, Square }

pub trait Draw {
    fn draw(&self) -> String;
}

impl Point {
    pub fn new(x: i32, y: i32) -> Self {
        Point { x, y }
    }
    pub fn dist(&self) -> f64 {
        compute(self.x);
        HashMap::new();
        self.helper();
        0.0
    }
}

fn compute(v: i32) -> i32 { let doubled = v * 2; doubled }
`;

const JAVA_SOURCE = `package com.example;

import java.util.List;
import static java.lang.Math.max;

/** App class. */
public class App implements Runnable {
    private int count = 0;
    public App(int start) { this.count = start; }
    @Override
    public void run() {
        List<String> xs = build(3);
        System.out.println(xs.size());
        helper();
        new Thread(this).start();
    }
    private static List<String> build(int n) { return null; }
    void helper() {}
}

interface Greeter { String greet(String name); }
enum Level { LOW, HIGH }
`;

describe('Go', () => {
  const fx = new ParserFixture();
  let parsed: ParsedFile;

  before(async () => { parsed = await fx.parse('cmd/main.go', GO_SOURCE); });
  after(() => fx.cleanup());

  it('parses with the go grammar', () => {
    assert.equal(parsed.language, 'go');
    assert.deepEqual(parsed.parseErrors, []);
  });

  it('emits functions with return types and the // comment as docComment', () => {
    assert.deepEqual(namesOf(parsed, 'function'), ['NewServer', 'helper']);
    const ns = get(parsed, 'NewServer', 'function');
    assert.equal(ns.line, 22);
    assert.equal(ns.endLine, 26);
    assert.equal(ns.returnType, '*Server');
    assert.equal(ns.docComment, 'NewServer builds a server.');
    assert.equal(ns.signature, 'func NewServer(name string, port int) *Server {');
  });

  it('emits receiver functions as methods', () => {
    const start = get(parsed, 'Start', 'method');
    assert.equal(start.returnType, '(int, error)');
    assert.equal(start.line, 28);
  });

  it('emits one import node per import declaration', () => {
    const imports = parsed.nodes.filter(n => n.type === 'import');
    assert.deepEqual(imports.map(n => [n.line, n.endLine]), [[3, 6], [8, 8]]);
    assert.ok(imports[0].signature?.includes('"fmt"'));
    assert.equal(parsed.edges.filter(e => e.type === 'imports').length, 2);
  });

  it('records plain calls', () => {
    assert.ok(callsFrom(parsed, 'Start').includes('helper'));
  });

  it('names import nodes after the imported package', { todo: 'BUG: Go import nodes have an empty name (getImportSource/extractImportNames ignore import_spec, astParser.ts:351, 602-637)' }, () => {
    const names = parsed.nodes.filter(n => n.type === 'import').map(n => n.name);
    assert.ok(names.every(n => n.length > 0));
    assert.ok(names.join(' ').includes('fmt'));
  });

  it('does not flag imported packages as undefined refs', { todo: 'BUG: Go imports are not added to scope, so fmt/str are flagged in NewServer (astParser.ts:602-619)' }, () => {
    const refs = refsOf(get(parsed, 'NewServer'));
    assert.ok(!refs.includes('fmt'));
    assert.ok(!refs.includes('str'));
  });

  it('emits type, const and var declarations', { todo: 'BUG: type_declaration/var/const have no name field at top level, so Server, Handler, Version, counter are never emitted (astParser.ts:159-161, 554-576)' }, () => {
    for (const name of ['Server', 'Handler', 'Version', 'counter']) {
      assert.ok(find(parsed, name), name);
    }
  });
});

describe('Rust', () => {
  const fx = new ParserFixture();
  let parsed: ParsedFile;

  before(async () => { parsed = await fx.parse('src/lib.rs', RUST_SOURCE); });
  after(() => fx.cleanup());

  it('parses with the rust grammar', () => {
    assert.equal(parsed.language, 'rust');
    assert.deepEqual(parsed.parseErrors, []);
  });

  it('maps structs to class, traits to interface and enums to enum', () => {
    assert.deepEqual(namesOf(parsed, 'class'), ['Point']);
    assert.deepEqual(namesOf(parsed, 'interface'), ['Draw']);
    assert.deepEqual(namesOf(parsed, 'enum'), ['Shape']);
    assert.equal(get(parsed, 'Draw').endLine, 11);
  });

  it('emits fn items, including those inside impl blocks', () => {
    const dist = get(parsed, 'dist', 'function');
    assert.equal(dist.returnType, 'f64');
    assert.equal(dist.line, 17);
    const compute = get(parsed, 'compute', 'function');
    assert.equal(compute.returnType, 'i32');
    assert.deepEqual(compute.localVars, ['doubled']);
  });

  it('emits use declarations as imports', () => {
    const imports = parsed.nodes.filter(n => n.type === 'import');
    assert.deepEqual(imports.map(n => n.signature), ['use std::collections::HashMap;', 'use crate::util::{a, b};']);
  });

  it('records plain calls', () => {
    assert.deepEqual(callsFrom(parsed, 'dist'), ['compute']);
  });

  it('emits a fn named new', { todo: 'BUG: KEYWORDS contains "new", so Rust constructors `fn new` are dropped (astParser.ts:38, 417)' }, () => {
    assert.ok(find(parsed, 'new', 'function'));
  });

  it('does not flag self', { todo: 'BUG: &self is not extracted as a param, so `self` is flagged in methods (astParser.ts:797-798, 1206)' }, () => {
    assert.ok(!refsOf(get(parsed, 'dist')).includes('self'));
  });

  it('strips /// from doc comments', { todo: 'BUG: `/// A point.` becomes docComment "/ A point." (astParser.ts:856)' }, () => {
    assert.equal(get(parsed, 'Point').docComment, 'A point.');
  });
});

describe('Java', () => {
  const fx = new ParserFixture();
  let parsed: ParsedFile;

  before(async () => { parsed = await fx.parse('src/App.java', JAVA_SOURCE); });
  after(() => fx.cleanup());

  it('parses with the java grammar', () => {
    assert.equal(parsed.language, 'java');
    assert.deepEqual(parsed.parseErrors, []);
  });

  it('emits classes, interfaces and enums', () => {
    assert.deepEqual(namesOf(parsed, 'class'), ['App']);
    assert.deepEqual(namesOf(parsed, 'interface'), ['Greeter']);
    assert.deepEqual(namesOf(parsed, 'enum'), ['Level']);
    const app = get(parsed, 'App', 'class');
    assert.equal(app.line, 7);
    assert.equal(app.endLine, 19);
    assert.deepEqual(app.modifiers, ['public']);
  });

  it('emits methods and constructors as methods, with return types', () => {
    assert.deepEqual(namesOf(parsed, 'method'), ['App', 'run', 'build', 'helper', 'greet']);
    assert.equal(get(parsed, 'run', 'method').returnType, 'void');
    assert.equal(get(parsed, 'build', 'method').returnType, 'List<String>');
    assert.equal(get(parsed, 'greet', 'method').returnType, 'String');
  });

  it('emits imports named after the imported type', () => {
    const imports = parsed.nodes.filter(n => n.type === 'import');
    assert.equal(imports.length, 2);
    assert.equal(imports[0].name, 'java.util.List');
  });

  it('records method invocations and instantiations', () => {
    assert.deepEqual(callsFrom(parsed, 'run'), ['build', 'println', 'size', 'helper', 'start']);
    assert.deepEqual(get(parsed, 'run').instantiates, ['Thread']);
  });

  it('extracts method params', { todo: 'BUG: java paramsField is "formal_parameters" but the field is "parameters", so params are never extracted (astParser.ts:198)' }, () => {
    assert.deepEqual(get(parsed, 'build').params?.map(p => p.name), ['n']);
  });

  it('names static imports after the imported member', { todo: 'BUG: `import static java.lang.Math.max;` is named "static" (astParser.ts:634)' }, () => {
    assert.equal(parsed.nodes.filter(n => n.type === 'import')[1].name, 'java.lang.Math.max');
  });

  it('reports every modifier, also after annotations', { todo: 'BUG: java modifiers are only seen when the modifiers node is a single keyword (astParser.ts:836-841)' }, () => {
    assert.deepEqual(get(parsed, 'build').modifiers, ['private', 'static']);
    assert.ok(get(parsed, 'run').modifiers?.includes('public'));
  });

  it('does not flag typed local variables', { todo: 'BUG: local patterns only know const/let/var, so `List<String> xs = ...; xs.size()` flags xs (astParser.ts:1127-1131)' }, () => {
    assert.ok(!refsOf(get(parsed, 'run')).includes('xs'));
  });

  it('strips */ from single-line javadoc', { todo: 'BUG: `/** App class. */` becomes docComment "App class. */" (astParser.ts:856)' }, () => {
    assert.equal(get(parsed, 'App', 'class').docComment, 'App class.');
  });
});
