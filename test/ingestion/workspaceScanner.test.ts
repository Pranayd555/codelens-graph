import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { TestWorkspace, SCAN_OPTIONS } from '../helpers';
import { newWorkspace } from './workspace';
import { ScanOptions, isSkippedDirectoryName } from '../../src/ingestion/workspaceScanner';
import { PARSER_VERSION } from '../../src/ingestion/astParser';
import { IndexScope } from '../../src/ingestion/indexScope';
import { rel } from './tmp';

const isWin = process.platform === 'win32';
const EXCLUDES: ScanOptions = { ...SCAN_OPTIONS, excludePatterns: ['**/generated/**', 'skipme.ts'] };

describe('isSkippedDirectoryName', () => {
  it('skips node_modules, build output, caches, VCS and hidden tool folders', () => {
    for (const name of ['node_modules', 'dist', 'build', 'out', 'coverage', 'vendor', 'target', 'bin', 'obj',
      '__pycache__', '.git', '.vscode', '.codelens', '.anything', 'tmp', 'logs']) {
      assert.equal(isSkippedDirectoryName(name), true, name);
    }
  });

  it('skips *-cache / *_dist / *-generated style names, case-insensitively', () => {
    for (const name of ['webpack-cache', 'app_dist', 'api-generated', 'proto_gen', 'site-output', 'ci-artifacts', 'X-BUILD']) {
      assert.equal(isSkippedDirectoryName(name), true, name);
    }
  });

  it('keeps ordinary source folders and .github', () => {
    for (const name of ['src', 'lib', '.github', 'generated', 'cache', 'distance', 'builder', 'outline']) {
      assert.equal(isSkippedDirectoryName(name), false, name);
    }
  });
});

describe('WorkspaceScanner file selection', () => {
  const ws = newWorkspace();
  const whole = (): IndexScope => ({ workspaceRoot: ws.root, folders: [] });
  const only = (...folders: string[]): IndexScope => ({ workspaceRoot: ws.root, folders });
  const list = async (scope: IndexScope, options: ScanOptions = EXCLUDES) => rel(ws.root, await ws.scanner.listFiles(scope, options));

  before(async () => {
    const files: Record<string, string> = {
      'package.json': '{}',
      'README.md': '# hi',
      'tsconfig.json': '{}',
      'root.ts': 'export const r = 1;',
      'notes.txt': 'not indexed',
      'yarn.lock': '',
      'src/a.ts': 'export const a = 1;',
      'src/b.tsx': 'export const b = 1;',
      'src/types.d.ts': 'export declare const t: 1;',
      'src/vendor.min.js': 'var x=1;',
      'src/skipme.ts': '',
      'src/vite.config.ts': '',
      'src/docs/guide.md': '# guide',
      'src/data/settings.json': '{}',
      'src/sub/deep.py': 'x = 1',
      'src/gen/out.ts': '',
      'src/feature-cache/x.ts': '',
      'src/generated/g.ts': '',
      'src/node_modules/x/y.js': '',
      'lib/l.py': 'x = 1',
      'dist/d.js': '',
      'dist/nested/out/o.js': '',
      'build/b.ts': '',
      'build/inner/i.ts': '',
      'build/inner/dist/x.ts': '',
      'node_modules/pkg/index.js': '',
      'node_modules/pkg/package.json': '{}',
      '.github/workflows/check.js': '',
      '.hidden/h.ts': '',
      'coverage/c.ts': '',
    };
    for (const [file, text] of Object.entries(files)) { ws.write(file, text); }
    await ws.open();
  });

  after(() => ws.close());

  describe('listFiles', () => {
    it('lists supported source files and config files across the workspace', async () => {
      assert.deepEqual(await list(whole()), [
        '.github/workflows/check.js',
        'README.md',
        'lib/l.py',
        'package.json',
        'root.ts',
        'src/a.ts',
        'src/b.tsx',
        'src/docs/guide.md',
        'src/sub/deep.py',
        'src/vite.config.ts',
        'tsconfig.json',
      ]);
    });

    it('applies only the built-in exclusions when no patterns are given', async () => {
      const files = await list(whole(), SCAN_OPTIONS);
      assert.ok(files.includes('src/skipme.ts'));
      assert.ok(files.includes('src/generated/g.ts'));
      for (const never of ['src/types.d.ts', 'src/vendor.min.js', 'src/gen/out.ts', 'src/feature-cache/x.ts',
        'dist/d.js', 'build/b.ts', 'coverage/c.ts', '.hidden/h.ts', 'yarn.lock', 'notes.txt']) {
        assert.ok(!files.includes(never), never);
      }
    });

    it('never descends into node_modules', async () => {
      const files = await list(whole(), SCAN_OPTIONS);
      assert.ok(!files.some(f => f.split('/').includes('node_modules')), files.join(', '));
    });

    it('only lists the selected folders plus files directly in the root', async () => {
      assert.deepEqual(await list(only('lib', 'src/sub')), [
        'README.md', 'lib/l.py', 'package.json', 'root.ts', 'src/sub/deep.py', 'tsconfig.json',
      ]);
    });

    it('indexes an explicitly selected folder even when its name is normally skipped', async () => {
      const files = await list(only('build'));
      assert.ok(files.includes('build/b.ts'));
      assert.ok(files.includes('build/inner/i.ts'));
      assert.ok(!files.includes('build/inner/dist/x.ts'), 'skipped names still apply below the selection');
      assert.ok((await list(only('dist'))).includes('dist/d.js'));
      assert.ok((await list(only('src/gen'))).includes('src/gen/out.ts'));
    });

    it('ignores selected folders that do not exist', async () => {
      assert.deepEqual(await list(only('missing')), ['README.md', 'package.json', 'root.ts', 'tsconfig.json']);
    });

    it('honours supportedExtensions case-insensitively', async () => {
      const files = await list(whole(), { ...SCAN_OPTIONS, supportedExtensions: ['.PY'] });
      assert.ok(files.includes('lib/l.py'));
      assert.ok(!files.includes('src/a.ts'));
      assert.ok(files.includes('package.json'), 'config files are listed regardless');
    });

    it('does not index files of a selected folder inside node_modules',
      { todo: 'BUG: listFiles walks a selected folder under node_modules (workspaceScanner.ts:411-412 only skips node_modules children), although isFileAllowed rejects those files' },
      async () => {
        const files = await list(only('node_modules/pkg'), SCAN_OPTIONS);
        assert.ok(!files.some(f => f.startsWith('node_modules/')), files.join(', '));
      });
  });

  describe('isFileAllowed', () => {
    const allowed = (file: string, scope = whole(), options = EXCLUDES) => ws.scanner.isFileAllowed(ws.path(file), scope, options);

    it('allows source and config files the scanner would index', () => {
      for (const file of ['root.ts', 'src/a.ts', 'lib/l.py', 'package.json', 'src/docs/guide.md', '.github/workflows/check.js']) {
        assert.equal(allowed(file), true, file);
      }
    });

    it('accepts paths relative to the workspace root', () => {
      assert.equal(ws.scanner.isFileAllowed(path.join('src', 'a.ts'), whole(), EXCLUDES), true);
      assert.equal(ws.scanner.isFileAllowed(path.join('dist', 'd.js'), whole(), EXCLUDES), false);
    });

    it('rejects files outside the workspace, out of scope, or in node_modules', () => {
      assert.equal(ws.scanner.isFileAllowed(path.join(path.dirname(ws.root), 'elsewhere.ts'), whole(), EXCLUDES), false);
      assert.equal(allowed('lib/l.py', only('src')), false);
      assert.equal(allowed('root.ts', only('src')), true, 'root files are always in scope');
      assert.equal(allowed('node_modules/pkg/index.js'), false);
      assert.equal(allowed('src/node_modules/x/y.js'), false);
    });

    it('rejects always-excluded files, unsupported extensions and user-excluded paths', () => {
      assert.equal(allowed('yarn.lock', whole(), { ...EXCLUDES, supportedExtensions: ['.lock'] }), false);
      assert.equal(allowed('notes.txt'), false);
      assert.equal(allowed('src/data/settings.json'), false, 'non-config JSON with an unsupported extension');
      assert.equal(allowed('src/skipme.ts'), false);
      assert.equal(allowed('src/generated/g.ts'), false);
      assert.equal(allowed('src/a.ts', whole(), { ...EXCLUDES, excludePatterns: ['src/*.ts'] }), false);
    });

    it('rejects files inside skipped folders unless that folder is the selection', () => {
      assert.equal(allowed('dist/d.js'), false);
      assert.equal(allowed('src/gen/out.ts'), false);
      assert.equal(allowed('src/feature-cache/x.ts'), false);
      assert.equal(allowed('.hidden/h.ts'), false);
      assert.equal(allowed('dist/d.js', only('dist')), true);
      assert.equal(allowed('src/gen/out.ts', only('src/gen')), true);
      assert.equal(allowed('build/inner/i.ts', only('build')), true);
      assert.equal(allowed('build/inner/dist/x.ts', only('build')), false);
      assert.equal(allowed('dist/nested/out/o.js', only('dist')), false);
    });

    it('matches the selected folder case-insensitively on Windows', { skip: !isWin }, () => {
      assert.equal(allowed('dist/d.js', only('DIST')), true);
    });

    it('agrees with listFiles on generated files (.d.ts, .min.js)',
      { todo: 'BUG: walkDir skips *.d.ts / *.min.js (workspaceScanner.ts:476-483) but isFileAllowed (:333) does not, so watcher saves index files a full scan never indexes' },
      () => {
        assert.equal(allowed('src/types.d.ts'), false);
        assert.equal(allowed('src/vendor.min.js'), false);
      });

    it('agrees with listFiles on config files matched by a user exclude pattern',
      { todo: 'BUG: walkDir lets config files bypass user excludes (workspaceScanner.ts:445 `&& !isConfig`) but isFileAllowed applies them first (:343)' },
      async () => {
        const options = { ...SCAN_OPTIONS, excludePatterns: ['*.md'] };
        const listed = await list(whole(), options);
        assert.equal(listed.includes('README.md'), allowed('README.md', whole(), options));
      });
  });

  describe('isTrackedLocation', () => {
    const tracked = (p: string, scope = whole(), options = EXCLUDES) => ws.scanner.isTrackedLocation(ws.path(p), scope, options);

    it('tracks folders and files in scope outside excluded folders', () => {
      assert.equal(tracked('src'), true);
      assert.equal(tracked('src/sub'), true);
      assert.equal(tracked('src/a.ts'), true);
      assert.equal(tracked('src/not/created/yet'), true);
    });

    it('does not track the root itself, outside paths, node_modules, or excluded folders', () => {
      assert.equal(ws.scanner.isTrackedLocation(ws.root, whole(), EXCLUDES), false);
      assert.equal(ws.scanner.isTrackedLocation(path.dirname(ws.root), whole(), EXCLUDES), false);
      assert.equal(tracked('node_modules/pkg'), false);
      assert.equal(tracked('dist'), false);
      assert.equal(tracked('src/gen/sub'), false);
      assert.equal(tracked('src/generated'), false, 'user pattern');
      assert.equal(tracked('lib/sub', only('src')), false, 'out of scope');
    });

    it('tracks an explicitly selected folder that would otherwise be skipped', () => {
      assert.equal(tracked('dist', only('dist')), true);
      assert.equal(tracked('dist/anything', only('dist')), true);
      assert.equal(tracked('dist/nested/out', only('dist')), false);
    });
  });

  describe('listFilesUnder', () => {
    it('lists indexable files under a tracked folder', async () => {
      const files = rel(ws.root, await ws.scanner.listFilesUnder(ws.path('src'), whole(), EXCLUDES));
      assert.deepEqual(files, ['src/a.ts', 'src/b.tsx', 'src/docs/guide.md', 'src/sub/deep.py', 'src/vite.config.ts']);
    });

    it('returns [] for untracked folders', async () => {
      assert.deepEqual(await ws.scanner.listFilesUnder(ws.path('dist'), whole(), EXCLUDES), []);
      assert.deepEqual(await ws.scanner.listFilesUnder(ws.path('lib'), only('src'), EXCLUDES), []);
      assert.deepEqual(await ws.scanner.listFilesUnder(ws.path('missing'), whole(), EXCLUDES), []);
    });

    it('lists a selected, normally skipped folder', async () => {
      const files = rel(ws.root, await ws.scanner.listFilesUnder(ws.path('build'), only('build'), EXCLUDES));
      assert.deepEqual(files, ['build/b.ts', 'build/inner/i.ts']);
    });
  });
});

describe('WorkspaceScanner.scanWorkspace', () => {
  let ws: TestWorkspace;
  const scope = (): IndexScope => ({ workspaceRoot: ws.root, folders: [] });
  const indexed = () => rel(ws.root, ws.db.getAllFiles('all'));

  beforeEach(async () => {
    ws = newWorkspace();
    ws.write('package.json', JSON.stringify({ name: 'fixture' }));
    ws.write('src/b.js', 'function helper() { return 1; }\nmodule.exports = { helper };\n');
    ws.write('src/a.js', "const { helper } = require('./b');\nfunction useIt() { return helper(); }\nmodule.exports = { useIt };\n");
    ws.write('lib/l.py', 'def lib_fn():\n    return 1\n');
    await ws.open();
  });

  afterEach(() => ws.close());

  it('indexes every listed file on the first scan', async () => {
    const result = await ws.scan();
    assert.equal(result.filesScanned, 4);
    assert.equal(result.filesSkipped, 0);
    assert.deepEqual(result.errors, []);
    assert.ok(result.nodesAdded > 0);
    assert.equal(result.edgesAdded, ws.db.getStats().totalEdges);
    assert.ok(result.durationMs >= 0);
    assert.deepEqual(indexed(), ['lib/l.py', 'package.json', 'src/a.js', 'src/b.js']);
    assert.deepEqual(ws.callsFrom('useIt'), ['helper@src/b.js']);
    assert.equal(ws.db.getMetaValue('parser_version'), PARSER_VERSION);
    assert.ok(fs.existsSync(path.join(ws.root, '.codelens')), 'the index is persisted');
  });

  it('skips unchanged files, and skips resolving and persisting when nothing changed', async () => {
    await ws.scan();
    const version = ws.db.getVersion();
    const result = await ws.scan();
    assert.equal(result.filesScanned, 0);
    assert.equal(result.filesSkipped, 4);
    assert.equal(ws.db.getVersion(), version, 'no persist on a no-op scan');
  });

  it('re-parses a file whose size or mtime changed', async () => {
    await ws.scan();
    ws.write('src/b.js', 'function helperRenamed() { return 1; }\nmodule.exports = { helperRenamed };\n');
    let result = await ws.scan();
    assert.equal(result.filesScanned, 1);
    assert.equal(result.filesSkipped, 3);
    assert.doesNotThrow(() => ws.node('helperRenamed'));
    assert.throws(() => ws.node('helper', 'src/b.js'));

    // Same content and size, newer mtime.
    const later = new Date(Date.now() + 60_000);
    fs.utimesSync(ws.path('lib/l.py'), later, later);
    result = await ws.scan();
    assert.equal(result.filesScanned, 1);
  });

  it('re-parses everything with force', async () => {
    await ws.scan();
    const version = ws.db.getVersion();
    const result = await ws.scan({ force: true });
    assert.equal(result.filesScanned, 4);
    assert.equal(result.filesSkipped, 0);
    assert.ok(ws.db.getVersion() > version, 'a forced scan persists');
  });

  it('drops files that disappeared', async () => {
    await ws.scan();
    fs.rmSync(ws.path('lib/l.py'));
    const version = ws.db.getVersion();
    await ws.scan();
    assert.deepEqual(indexed(), ['package.json', 'src/a.js', 'src/b.js']);
    assert.throws(() => ws.node('lib_fn'));
    assert.ok(ws.db.getVersion() > version, 'removing a file persists');
  });

  it('drops files that left the scope or became excluded, keeping root files', async () => {
    await ws.scan();
    await ws.scanner.scanWorkspace({ workspaceRoot: ws.root, folders: ['src'] }, SCAN_OPTIONS);
    assert.deepEqual(indexed(), ['package.json', 'src/a.js', 'src/b.js']);

    await ws.scanner.scanWorkspace(scope(), { ...SCAN_OPTIONS, excludePatterns: ['src/a.js'] });
    assert.deepEqual(indexed(), ['lib/l.py', 'package.json', 'src/b.js']);
  });

  it('removes node_modules entries left by older versions', async () => {
    await ws.scan();
    const nm = ws.write('node_modules/old/index.js', 'function oldFn() {}\n');
    await ws.scanner.updateFile(nm);
    assert.ok(ws.db.getAllFiles('all').some(f => path.normalize(f) === path.normalize(nm)));
    await ws.scan();
    assert.ok(!ws.db.getAllFiles('all').some(f => path.normalize(f) === path.normalize(nm)));
  });

  it('leaves indexed files outside the workspace root alone', async () => {
    await ws.scan();
    const outside = path.join(path.dirname(ws.root), 'outside-codelens-test.js');
    ws.db.upsertNodes([{
      id: `${outside}::file`, type: 'file', name: 'outside-codelens-test.js', filePath: outside,
      line: 1, endLine: 1, language: 'javascript', updatedAt: 0,
    }]);
    await ws.scan();
    assert.ok(ws.db.getAllFiles('all').includes(outside));
  });

  it('reports progress for every file', async () => {
    const calls: Array<[number, number, string]> = [];
    await ws.scan({ onProgress: (current, total, file) => calls.push([current, total, file]) });
    assert.deepEqual(calls.map(c => c[0]), [1, 2, 3, 4]);
    assert.ok(calls.every(c => c[1] === 4));
    assert.deepEqual(rel(ws.root, calls.map(c => c[2])), ['lib/l.py', 'package.json', 'src/a.js', 'src/b.js']);
  });

  it('records a stat failure and carries on', async () => {
    const victim = ws.path('lib/l.py');
    const result = await ws.scan({ onProgress: (_c, _t, file) => { if (file === victim) { fs.rmSync(victim); } } });
    assert.equal(result.filesSkipped, 1);
    assert.equal(result.filesScanned, 3);
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0], /Stat failed/);
  });

  it('reports parse errors for files the parser cannot handle', async () => {
    ws.write('src/data.xyz', 'whatever');
    const result = await ws.scan({ supportedExtensions: [...SCAN_OPTIONS.supportedExtensions, '.xyz'] });
    assert.ok(result.errors.some(e => /Unsupported extension/.test(e)), result.errors.join('\n'));
  });

  it('re-checks empty files every scan without treating them as a change', async () => {
    ws.write('src/empty.js', '');
    await ws.scan();
    const version = ws.db.getVersion();
    const result = await ws.scan();
    assert.equal(result.filesScanned, 1, 'only the empty file is re-checked');
    assert.equal(ws.db.getVersion(), version);
  });

  it('removes the symbols of a file that became empty', async () => {
    await ws.scan();
    ws.write('src/b.js', '');
    const version = ws.db.getVersion();
    await ws.scan();
    assert.throws(() => ws.node('helper', 'src/b.js'));
    assert.deepEqual(ws.callsFrom('useIt'), []);
    assert.ok(ws.db.getVersion() > version);
  });

  it('re-parses unchanged files once after a parser version change', async () => {
    await ws.scan();
    ws.db.setMetaValue('parser_version', 'old');
    const result = await ws.scan();
    assert.equal(result.filesScanned, 4);
    assert.equal(ws.db.getMetaValue('parser_version'), PARSER_VERSION);
    assert.equal((await ws.scan()).filesScanned, 0);
  });

  it('records a file that fails to parse and indexes the rest', async () => {
    const victim = ws.path('lib/l.py');
    const parser = ws.parser as any;
    const original = parser.parseFileAsync;
    parser.parseFileAsync = async function (this: unknown, filePath: string) {
      if (filePath === victim) { throw new Error('parser crashed'); }
      return original.call(this, filePath);
    };
    try {
      const result = await ws.scan();
      assert.equal(result.filesScanned, 3);
      assert.equal(result.filesSkipped, 1);
      assert.equal(result.errors.length, 1);
      assert.match(result.errors[0], /l\.py: Error: parser crashed/);
      assert.deepEqual(indexed(), ['package.json', 'src/a.js', 'src/b.js']);
    } finally {
      parser.parseFileAsync = original;
    }
  });

  it('reports a failed final persist instead of throwing', async () => {
    // A directory where the DB file should be makes the write fail.
    fs.mkdirSync(path.join(ws.root, '.codelens', 'codelens-graph.db'), { recursive: true });
    const result = await ws.scan();
    assert.equal(result.filesScanned, 4);
    assert.ok(result.errors.some(e => /^Final persist failed/.test(e)), result.errors.join('\n'));
  });
});

describe('WorkspaceScanner.updateFile', () => {
  const ws = newWorkspace();
  const b = 'src/b.js';

  before(async () => {
    ws.write(b, 'function helper() { return 1; }\nmodule.exports = { helper };\n');
    ws.write('src/a.js', "const { helper } = require('./b');\nfunction useIt() { return helper(); }\nmodule.exports = { useIt };\n");
    await ws.scan();
  });

  after(() => ws.close());

  it('re-parses one file, re-resolves callers of removed symbols, and persists', async () => {
    assert.deepEqual(ws.callsFrom('useIt'), ['helper@src/b.js']);
    ws.write(b, 'function other() { return 1; }\nmodule.exports = { other };\n');
    const version = ws.db.getVersion();
    const parsed = await ws.scanner.updateFile(ws.path(b));
    assert.ok(parsed.nodes.some(n => n.name === 'other'));
    assert.throws(() => ws.node('helper', b));
    assert.deepEqual(ws.callsFrom('useIt'), []);
    assert.ok(ws.db.getVersion() > version);
  });

  it('links callers to a symbol that (re)appears', async () => {
    ws.write(b, 'function helper() { return 2; }\nmodule.exports = { helper };\n');
    await ws.scanner.updateFile(ws.path(b));
    assert.deepEqual(ws.callsFrom('useIt'), ['helper@src/b.js']);
  });

  it('skips resolving and persisting when asked', async () => {
    ws.write(b, 'function helper() { return 3; }\nfunction extra() {}\nmodule.exports = { helper, extra };\n');
    const version = ws.db.getVersion();
    const parsed = await ws.scanner.updateFile(ws.path(b), false);
    assert.ok(parsed.nodes.some(n => n.name === 'extra'));
    assert.doesNotThrow(() => ws.node('extra', b));
    assert.equal(ws.db.getVersion(), version);
  });

  it('clears a file that was deleted from disk', async () => {
    const gone = ws.write('src/gone.js', 'function goneFn() {}\n');
    await ws.scanner.updateFile(gone);
    assert.doesNotThrow(() => ws.node('goneFn'));
    fs.rmSync(gone);
    const parsed = await ws.scanner.updateFile(gone);
    assert.equal(parsed.nodes.length, 0);
    assert.throws(() => ws.node('goneFn'));
  });
});
