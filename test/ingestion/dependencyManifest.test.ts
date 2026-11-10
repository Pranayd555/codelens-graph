import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { readDependencyManifest, readDeclaredExports, PackageInfo } from '../../src/ingestion/dependencyManifest';
import { TempDir } from './tmp';

describe('readDependencyManifest', () => {
  // <tmp>/node_modules/above sits outside the workspace (<tmp>/ws).
  const tmp = new TempDir();
  const ws = (rel: string) => tmp.path('ws/' + rel);
  const pkgJson = (name: string, fields: Record<string, unknown> = {}, at = 'ws/node_modules') =>
    tmp.writeJson(`${at}/${name}/package.json`, { name, version: '1.0.0', ...fields });
  let byName: Map<string, PackageInfo>;
  let packages: PackageInfo[];
  let rootManifest: string;
  let appManifest: string;

  before(async () => {
    rootManifest = tmp.writeJson('ws/package.json', {
      name: 'fixture',
      dependencies: {
        alpha: '^1.0.0', '@scope/beta': '^2.0.0', gamma: '^3.0.0', '@org/zeta': '1', eta: '1',
        kappa: '1', lambda: '1', mu: '1', nu: '1', above: '1', broken: '1',
      },
      devDependencies: { alpha: '^0.9.0', delta: '*', '@types/node': '^20' },
      peerDependencies: { pi: '>=1' },
      optionalDependencies: { pi: '^1.5', rho: '2' },
    });
    appManifest = tmp.writeJson('ws/packages/app/package.json', {
      name: 'app',
      dependencies: { delta: '^4.0.0', epsilon: '^5.0.0', theta: '^6.0.0' },
      devDependencies: { pi: '0.1' },
    });
    tmp.write('ws/packages/bad/package.json', '{ not json');
    tmp.writeJson('ws/packages/odd/package.json', { dependencies: 'alpha', devDependencies: null });

    // alpha: explicit types/main, README.md; its own dependencies are not reported.
    pkgJson('alpha', { version: '1.2.3', types: 'lib/index.d.ts', main: 'lib/index.js', dependencies: { transitive: '1' } });
    tmp.write('ws/node_modules/alpha/lib/index.d.ts', 'export declare function a(): void;\n');
    tmp.write('ws/node_modules/alpha/lib/index.js', '');
    tmp.write('ws/node_modules/alpha/README.md', '# alpha');
    pkgJson('transitive');

    // @scope/beta: types via exports['.'].import.types, no main entry on disk.
    pkgJson('@scope/beta', { version: '2.0.0', exports: { '.': { import: { types: './dist/esm.d.ts' } } } });
    tmp.write('ws/node_modules/@scope/beta/dist/esm.d.ts', '');
    tmp.write('ws/node_modules/@scope/beta/readme.txt', '');

    // delta: no types of its own → @types/delta; default main index.js.
    pkgJson('delta', { version: '4.1.0' });
    tmp.write('ws/node_modules/delta/index.js', '');
    pkgJson('@types/delta', { types: 'index.d.ts' });
    tmp.write('ws/node_modules/@types/delta/index.d.ts', '');

    // epsilon: installed next to the app manifest, `typings` field.
    pkgJson('epsilon', { version: '5.0.1', typings: 'types.d.ts' }, 'ws/packages/app/node_modules');
    tmp.write('ws/packages/app/node_modules/epsilon/types.d.ts', '');
    tmp.write('ws/packages/app/node_modules/epsilon/Readme.markdown', '');

    // theta: declared by the app, installed at the workspace root (walk up).
    pkgJson('theta', { version: '6.0.0' });
    tmp.write('ws/node_modules/theta/README.rst', '');

    // @org/zeta: scoped, typed through @types/org__zeta.
    pkgJson('@org/zeta');
    pkgJson('@types/org__zeta', { types: 'z.d.ts' });
    tmp.write('ws/node_modules/@types/org__zeta/z.d.ts', '');

    // @types/node: no DefinitelyTyped fallback for @types packages themselves.
    pkgJson('@types/node', { version: '20.0.0' });
    tmp.write('ws/node_modules/@types/node/index.d.ts', '');

    pkgJson('eta', { version: 5 });                                                     // non-string version
    pkgJson('kappa', { exports: { types: './k.d.ts', default: './k.js' } });           // exports without '.'
    tmp.write('ws/node_modules/kappa/k.d.ts', '');
    pkgJson('lambda', { exports: { '.': { require: { types: './r.d.ts' } } } });       // require condition
    tmp.write('ws/node_modules/lambda/r.d.ts', '');
    pkgJson('mu', { types: 'missing.d.ts', main: 5 });                                  // falls back to index.d.ts / index.js
    tmp.write('ws/node_modules/mu/index.d.ts', '');
    tmp.write('ws/node_modules/mu/index.js', '');
    pkgJson('nu', { exports: './nu.js' });                                              // string exports, no types
    pkgJson('pi', { version: '1.5.0' });
    pkgJson('above', {}, 'node_modules');                                               // outside the workspace
    tmp.write('ws/node_modules/broken/package.json', '{ nope');                         // unreadable package.json

    packages = await readDependencyManifest(tmp.path('ws'), [
      appManifest, rootManifest, ws('packages/bad/package.json'), ws('packages/odd/package.json'),
    ]);
    byName = new Map(packages.map(p => [p.name, p]));
  });

  after(() => tmp.remove());

  it('lists only direct dependencies of the given manifests, sorted by name', () => {
    const names = packages.map(p => p.name);
    assert.deepEqual(names, [...names].sort((a, b) => a.localeCompare(b)));
    assert.deepEqual([...names].sort(), [
      '@org/zeta', '@scope/beta', '@types/node', 'above', 'alpha', 'broken', 'delta', 'epsilon',
      'eta', 'gamma', 'kappa', 'lambda', 'mu', 'nu', 'pi', 'rho', 'theta',
    ]);
    assert.ok(!byName.has('transitive'), 'dependencies of installed packages are not walked');
    assert.ok(!byName.has('@types/delta'), 'type packages found by fallback are not listed');
  });

  it('records installed version, directory, types, main and readme', () => {
    const alpha = byName.get('alpha')!;
    assert.equal(alpha.installed, true);
    assert.equal(alpha.version, '1.2.3');
    assert.equal(alpha.dir, ws('node_modules/alpha'));
    assert.equal(alpha.types, ws('node_modules/alpha/lib/index.d.ts'));
    assert.equal(alpha.main, ws('node_modules/alpha/lib/index.js'));
    assert.equal(alpha.readme, ws('node_modules/alpha/README.md'));
  });

  it('prefers the most runtime declaration kind and its range, and records every declaring manifest', () => {
    const alpha = byName.get('alpha')!;
    assert.equal(alpha.kind, 'dependencies');
    assert.equal(alpha.declaredRange, '^1.0.0');
    assert.deepEqual(alpha.declaredIn, [rootManifest]);

    const delta = byName.get('delta')!;
    assert.equal(delta.kind, 'dependencies', 'app dependency outranks the root devDependency');
    assert.equal(delta.declaredRange, '^4.0.0');
    assert.deepEqual([...delta.declaredIn].sort(), [appManifest, rootManifest].sort());

    const pi = byName.get('pi')!;
    assert.equal(pi.kind, 'peerDependencies');
    assert.equal(pi.declaredRange, '>=1');
    assert.equal(byName.get('rho')!.kind, 'optionalDependencies');
    assert.equal(byName.get('@types/node')!.kind, 'devDependencies');
  });

  it('reports declared-but-missing packages as not installed', () => {
    for (const name of ['gamma', 'rho', 'broken']) {
      const p = byName.get(name)!;
      assert.equal(p.installed, false, name);
      assert.deepEqual([p.version, p.dir, p.types, p.main, p.readme], [null, null, null, null, null], name);
    }
  });

  it('looks up installs from the declaring manifest up to the workspace root, never above it', () => {
    assert.equal(byName.get('epsilon')!.dir, ws('packages/app/node_modules/epsilon'));
    assert.equal(byName.get('theta')!.dir, ws('node_modules/theta'));
    assert.equal(byName.get('above')!.installed, false);
  });

  it('finds type definitions from types, typings, exports conditions and index.d.ts', () => {
    assert.equal(byName.get('epsilon')!.types, ws('packages/app/node_modules/epsilon/types.d.ts'));
    assert.equal(byName.get('@scope/beta')!.types, ws('node_modules/@scope/beta/dist/esm.d.ts'));
    assert.equal(byName.get('kappa')!.types, ws('node_modules/kappa/k.d.ts'));
    assert.equal(byName.get('lambda')!.types, ws('node_modules/lambda/r.d.ts'));
    assert.equal(byName.get('mu')!.types, ws('node_modules/mu/index.d.ts'), 'a missing "types" target falls back');
    assert.equal(byName.get('nu')!.types, null);
    assert.equal(byName.get('@types/node')!.types, ws('node_modules/@types/node/index.d.ts'));
  });

  it('falls back to DefinitelyTyped, mapping @scope/name to @types/scope__name', () => {
    assert.equal(byName.get('delta')!.types, ws('node_modules/@types/delta/index.d.ts'));
    assert.equal(byName.get('@org/zeta')!.types, ws('node_modules/@types/org__zeta/z.d.ts'));
    assert.equal(byName.get('gamma')!.types, null);
  });

  it('defaults main to index.js only when it exists', () => {
    assert.equal(byName.get('delta')!.main, ws('node_modules/delta/index.js'));
    assert.equal(byName.get('mu')!.main, ws('node_modules/mu/index.js'), 'non-string main');
    assert.equal(byName.get('@scope/beta')!.main, null);
  });

  it('detects README variants (.md, .markdown, .txt, none) case-insensitively', () => {
    assert.equal(byName.get('@scope/beta')!.readme, ws('node_modules/@scope/beta/readme.txt'));
    assert.equal(byName.get('epsilon')!.readme, ws('packages/app/node_modules/epsilon/Readme.markdown'));
    assert.equal(byName.get('theta')!.readme, null, 'README.rst is not recognised');
  });

  it('records a non-string version as null while still installed', () => {
    const eta = byName.get('eta')!;
    assert.equal(eta.installed, true);
    assert.equal(eta.version, null);
  });

  it('returns [] when there are no manifests or none are readable', async () => {
    assert.deepEqual(await readDependencyManifest(tmp.path('ws'), []), []);
    assert.deepEqual(await readDependencyManifest(tmp.path('ws'), [ws('nope/package.json'), ws('packages/bad/package.json')]), []);
  });

  it('does not read from node_modules beyond one package.json per declared dependency', async () => {
    // A huge node_modules tree would be expensive to walk; only direct deps are touched.
    const reads: string[] = [];
    const original = fs.promises.readFile;
    (fs.promises as any).readFile = (p: any, ...rest: any[]) => { reads.push(String(p)); return (original as any).call(fs.promises, p, ...rest); };
    try {
      await readDependencyManifest(tmp.path('ws'), [rootManifest]);
    } finally {
      (fs.promises as any).readFile = original;
    }
    const nmReads = reads.filter(r => r.split(path.sep).includes('node_modules'));
    assert.ok(nmReads.every(r => path.basename(r) === 'package.json'), 'only package.json files are read');
    assert.ok(!nmReads.some(r => r.includes(`${path.sep}transitive${path.sep}`)), 'transitive deps are not opened');
  });
});

describe('readDeclaredExports', () => {
  const tmp = new TempDir();
  after(() => tmp.remove());

  it('lists declarations, named exports and re-exports with 1-based lines', () => {
    const dts = tmp.write('index.d.ts', [
      'export declare function foo(a: string): void;',     // 1
      'export default class Widget {}',                    // 2
      'export interface Opts {}',                          // 3
      'export type Id = string;',                          // 4
      'export const VERSION: string;',                     // 5
      'export let counter: number;',                       // 6
      'export var legacy: any;',                           // 7
      'export declare enum Color { Red }',                 // 8
      'export namespace NS {}',                            // 9
      'export declare abstract class Base {}',             // 10
      "export { a, b as c, type D } from './x';",          // 11
      "export type { E } from './y';",                     // 12
      "export * from './all';",                            // 13
      "export * as utils from './utils';",                 // 14
      'declare function hidden(): void;',                  // 15
      '    export function indented(): void;',             // 16
      '// export function commented(): void;',             // 17
    ].join('\n'));

    assert.deepEqual(readDeclaredExports(dts), [
      { kind: 'function', name: 'foo', line: 1 },
      { kind: 'class', name: 'Widget', line: 2 },
      { kind: 'interface', name: 'Opts', line: 3 },
      { kind: 'type', name: 'Id', line: 4 },
      { kind: 'const', name: 'VERSION', line: 5 },
      { kind: 'const', name: 'counter', line: 6 },
      { kind: 'const', name: 'legacy', line: 7 },
      { kind: 'enum', name: 'Color', line: 8 },
      { kind: 'namespace', name: 'NS', line: 9 },
      { kind: 'class', name: 'Base', line: 10 },
      { kind: 'export', name: 'a', line: 11 },
      { kind: 'export', name: 'c', line: 11 },
      { kind: 'export', name: 'D', line: 11 },
      { kind: 'export', name: 'E', line: 12 },
      { kind: 're-export', name: '* from ./all', line: 13 },
      { kind: 're-export', name: 'utils (from ./utils)', line: 14 },
      { kind: 'function', name: 'indented', line: 16 },
    ]);
  });

  it('handles CRLF line endings', () => {
    const dts = tmp.write('crlf.d.ts', 'export declare const a: 1;\r\nexport { b };\r\n');
    assert.deepEqual(readDeclaredExports(dts), [
      { kind: 'const', name: 'a', line: 1 },
      { kind: 'export', name: 'b', line: 2 },
    ]);
  });

  it('stops at the limit (default 200)', () => {
    const dts = tmp.write('many.d.ts', Array.from({ length: 250 }, (_, i) => `export declare const c${i}: number;`).join('\n'));
    assert.equal(readDeclaredExports(dts).length, 200);
    assert.deepEqual(readDeclaredExports(dts, 3).map(e => e.name), ['c0', 'c1', 'c2']);
  });

  it('returns [] for missing or oversized files', () => {
    assert.deepEqual(readDeclaredExports(tmp.path('missing.d.ts')), []);
    const big = tmp.write('big.d.ts', 'export declare const x: 1;\n' + ' '.repeat(2_000_001));
    assert.deepEqual(readDeclaredExports(big), []);
  });
});
