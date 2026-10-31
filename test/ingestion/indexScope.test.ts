import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  normalizeFolders, scopeRoots, relativeToWorkspace, isInScope,
  isFolderIncluded, isFolderPartiallyIncluded, toggleFolder,
  suggestFolders, countFilesByFolder, folderCount, CONTAINER_FOLDER_NAMES,
} from '../../src/ingestion/indexScope';

const isWin = process.platform === 'win32';
const root = path.join(os.tmpdir(), 'codelens-scope-ws');
const at = (rel: string) => path.join(root, ...rel.split('/'));

// A fake folder tree for toggleFolder / suggestFolders.
function tree(dirs: Record<string, string[]>) {
  return (relDir: string) => dirs[relDir] ?? [];
}

describe('normalizeFolders', () => {
  it('returns [] for non-arrays and ignores non-string entries', () => {
    assert.deepEqual(normalizeFolders(undefined), []);
    assert.deepEqual(normalizeFolders('src'), []);
    assert.deepEqual(normalizeFolders({ 0: 'src' }), []);
    assert.deepEqual(normalizeFolders(['src', 42, null, { a: 1 }]), ['src']);
  });

  it('trims, converts backslashes, strips "./" prefixes and trailing slashes', () => {
    assert.deepEqual(normalizeFolders(['  src/app/  ', '.\\lib\\core\\', '././docs']), ['docs', 'lib/core', 'src/app']);
    assert.deepEqual(normalizeFolders(['', '   ', './']), []);
  });

  it('"." means the whole workspace', () => {
    assert.deepEqual(normalizeFolders(['src', '.']), []);
    assert.deepEqual(normalizeFolders(['./.']), []);
  });

  it('drops absolute paths, drive paths, and paths escaping the workspace', () => {
    assert.deepEqual(normalizeFolders(['/etc', 'C:/Windows', 'c:\\temp', '../outside', 'src/../../x', 'src/..', 'ok']), ['ok']);
  });

  it('sorts, de-duplicates, and drops folders nested inside another entry', () => {
    assert.deepEqual(normalizeFolders(['src/b', 'lib', 'src', 'src/a/deep', 'lib']), ['lib', 'src']);
  });

  it('keeps siblings that share a name prefix', () => {
    assert.deepEqual(normalizeFolders(['src2', 'src']), ['src', 'src2']);
  });

  it('on Windows folds case and keeps the first spelling', { skip: !isWin }, () => {
    assert.deepEqual(normalizeFolders(['Src', 'src', 'SRC/inner']), ['Src']);
    assert.deepEqual(normalizeFolders(['lib', 'LIB']), ['lib']);
  });

  it('on case-sensitive platforms keeps different spellings apart', { skip: isWin }, () => {
    assert.deepEqual(normalizeFolders(['Src', 'src']), ['Src', 'src']);
  });
});

describe('scopeRoots / relativeToWorkspace', () => {
  it('walks the workspace root when no folders are selected', () => {
    assert.deepEqual(scopeRoots({ workspaceRoot: root, folders: [] }), [root]);
  });

  it('maps selected folders to absolute directories', () => {
    assert.deepEqual(scopeRoots({ workspaceRoot: root, folders: ['packages/a', 'src'] }), [at('packages/a'), at('src')]);
  });

  it('returns a "/"-separated relative path, or null for the root and outside paths', () => {
    assert.equal(relativeToWorkspace(at('src/a/b.ts'), root), 'src/a/b.ts');
    assert.equal(relativeToWorkspace(root, root), null);
    assert.equal(relativeToWorkspace(path.dirname(root), root), null);
    assert.equal(relativeToWorkspace(root + '-sibling', root), null);
    assert.equal(relativeToWorkspace(path.join(root, '..', 'x.ts'), root), null);
  });
});

describe('isInScope', () => {
  const whole = { workspaceRoot: root, folders: [] };
  const some = { workspaceRoot: root, folders: ['src', 'packages/a'] };

  it('everything inside the workspace is in scope when no folders are selected', () => {
    assert.equal(isInScope(at('deep/a/b/c.ts'), whole), true);
    assert.equal(isInScope(at('x.ts'), whole), true);
  });

  it('nothing outside the workspace (or the root itself) is in scope', () => {
    assert.equal(isInScope(path.join(path.dirname(root), 'other', 'x.ts'), whole), false);
    assert.equal(isInScope(root, whole), false);
  });

  it('files directly in the root are always in scope', () => {
    assert.equal(isInScope(at('package.json'), some), true);
  });

  it('only selected folders (and their descendants) are in scope', () => {
    assert.equal(isInScope(at('src/a.ts'), some), true);
    assert.equal(isInScope(at('src/x/y/a.ts'), some), true);
    assert.equal(isInScope(at('packages/a/index.ts'), some), true);
    assert.equal(isInScope(at('packages/b/index.ts'), some), false);
    assert.equal(isInScope(at('lib/a.ts'), some), false);
    assert.equal(isInScope(at('src2/a.ts'), some), false, 'sibling sharing a name prefix');
  });

  it('matches selected folders case-insensitively on Windows', { skip: !isWin }, () => {
    assert.equal(isInScope(at('SRC/a.ts'), some), true);
    assert.equal(isInScope(at('Packages/A/index.ts'), some), true);
  });

  it('matches selected folders case-sensitively elsewhere', { skip: isWin }, () => {
    assert.equal(isInScope(at('SRC/a.ts'), some), false);
  });
});

describe('isFolderIncluded / isFolderPartiallyIncluded', () => {
  const folders = ['packages/a', 'src'];

  it('everything is included when the list is empty', () => {
    assert.equal(isFolderIncluded('anything/at/all', []), true);
    assert.equal(isFolderPartiallyIncluded('anything', []), false);
  });

  it('a folder is included when it or an ancestor is selected', () => {
    assert.equal(isFolderIncluded('src', folders), true);
    assert.equal(isFolderIncluded('src/deep/er', folders), true);
    assert.equal(isFolderIncluded('packages/a/lib', folders), true);
    assert.equal(isFolderIncluded('packages', folders), false);
    assert.equal(isFolderIncluded('packages/b', folders), false);
    assert.equal(isFolderIncluded('src2', folders), false);
  });

  it('a folder is partially included when only a descendant is selected', () => {
    assert.equal(isFolderPartiallyIncluded('packages', folders), true);
    assert.equal(isFolderPartiallyIncluded('packages/a', folders), false, 'fully included');
    assert.equal(isFolderPartiallyIncluded('packages/b', folders), false);
    assert.equal(isFolderPartiallyIncluded('lib', folders), false);
  });
});

describe('toggleFolder', () => {
  const fs = tree({
    '': ['docs', 'lib', 'src'],
    src: ['a', 'b', 'c'],
    'src/a': ['x', 'y'],
    lib: ['core'],
  });

  it('checking a folder adds it and absorbs selected descendants', () => {
    assert.deepEqual(toggleFolder(['lib'], 'src', true, fs), ['lib', 'src']);
    assert.deepEqual(toggleFolder(['src/a', 'src/b', 'lib'], 'src', true, fs), ['lib', 'src']);
    assert.deepEqual(toggleFolder(['lib'], './src/a/', true, fs), ['lib', 'src/a'], 'the toggled path is normalized');
  });

  it('checking an already-included folder returns the list unchanged', () => {
    const folders = ['src'];
    assert.equal(toggleFolder(folders, 'src/a', true, fs), folders);
    assert.deepEqual(toggleFolder([], 'src', true, fs), [], 'whole workspace already covers it');
  });

  it('an empty or invalid folder argument leaves the list unchanged', () => {
    const folders = ['src'];
    assert.equal(toggleFolder(folders, '', false, fs), folders);
    assert.equal(toggleFolder(folders, '.', false, fs), folders);
    assert.equal(toggleFolder(folders, '../x', true, fs), folders);
  });

  it('unchecking a selected folder removes it (and anything selected inside it)', () => {
    assert.deepEqual(toggleFolder(['lib', 'src'], 'src', false, fs), ['lib']);
    assert.deepEqual(toggleFolder(['lib', 'src/a', 'src/b'], 'src', false, fs), ['lib']);
  });

  it('unchecking a folder that is not selected changes nothing', () => {
    assert.deepEqual(toggleFolder(['lib', 'src'], 'docs', false, fs), ['lib', 'src']);
  });

  it('returns null when the last selected folder would be removed', () => {
    assert.equal(toggleFolder(['src'], 'src', false, fs), null);
    assert.equal(toggleFolder(['src/a', 'src/b'], 'src', false, fs), null);
  });

  it('unchecking inside the whole workspace selects every other branch', () => {
    assert.deepEqual(toggleFolder([], 'src', false, fs), ['docs', 'lib']);
    assert.deepEqual(toggleFolder([], 'src/a/x', false, fs), ['docs', 'lib', 'src/a/y', 'src/b', 'src/c']);
  });

  it('unchecking below a selected ancestor replaces the ancestor level by level', () => {
    assert.deepEqual(toggleFolder(['lib', 'src'], 'src/a', false, fs), ['lib', 'src/b', 'src/c']);
    assert.deepEqual(toggleFolder(['src'], 'src/a/y', false, fs), ['src/a/x', 'src/b', 'src/c']);
  });

  it('returns null when unchecking the only child of the whole workspace', () => {
    assert.equal(toggleFolder([], 'only', false, tree({ '': ['only'] })), null);
  });

  it('on Windows, unchecking a selected folder spelled differently removes it',
    { skip: !isWin, todo: 'BUG: indexScope.ts:90 compares `f !== target` case-sensitively, so ["Src"] unchecking "src" treats Src as an ancestor and selects its children instead of removing it' },
    () => {
      // On Windows, listing "Src" or "src" reads the same directory.
      const winFs = (relDir: string) => (relDir.toLowerCase() === 'src' ? ['a', 'b'] : relDir === '' ? ['src'] : []);
      assert.equal(toggleFolder(['Src'], 'src', false, winFs), null);
    });
});

describe('suggestFolders', () => {
  it('suggests common source roots and the packages inside container folders', () => {
    const list = tree({ packages: ['ui', 'core'], Apps: ['web'], docs: ['x'] });
    assert.deepEqual(
      suggestFolders(['docs', 'packages', 'Src', 'lib', 'Apps', 'scripts', 'node_modules'], list),
      ['Apps/web', 'Src', 'lib', 'packages/core', 'packages/ui'],
    );
  });

  it('suggests nothing for an unconventional layout', () => {
    assert.deepEqual(suggestFolders(['foo', 'bar'], tree({})), []);
    assert.deepEqual(suggestFolders(['packages'], tree({})), [], 'an empty container contributes nothing');
  });

  it('exposes the container folder names', () => {
    assert.ok(CONTAINER_FOLDER_NAMES.has('packages'));
    assert.ok(CONTAINER_FOLDER_NAMES.has('apps'));
    assert.ok(!CONTAINER_FOLDER_NAMES.has('src'));
  });
});

describe('countFilesByFolder / folderCount', () => {
  const files = [
    at('package.json'),
    at('src/a.ts'),
    at('src/b.ts'),
    at('src/deep/c.ts'),
    at('lib/d.ts'),
    path.join(path.dirname(root), 'elsewhere', 'e.ts'),
  ];
  const counts = countFilesByFolder(files, root);

  it('counts every file under each ancestor folder', () => {
    assert.equal(folderCount(counts, 'src'), 3);
    assert.equal(folderCount(counts, 'src/deep'), 1);
    assert.equal(folderCount(counts, 'lib'), 1);
  });

  it('ignores root-level and outside files, and returns 0 for unknown folders', () => {
    assert.equal(folderCount(counts, 'elsewhere'), 0);
    assert.equal(folderCount(counts, 'missing'), 0);
    assert.equal(counts.size, 3);
  });

  it('looks folders up case-insensitively on Windows', { skip: !isWin }, () => {
    assert.equal(folderCount(counts, 'SRC'), 3);
    const mixed = countFilesByFolder([at('Src/a.ts'), at('src/b.ts')], root);
    assert.equal(folderCount(mixed, 'src'), 2);
  });
});
