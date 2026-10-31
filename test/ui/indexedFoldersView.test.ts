import { TreeItem, TreeItemCheckboxState, TreeItemCollapsibleState, ThemeIcon, resetVscodeStub } from './_vscode';
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { listChildFolders, FolderItem, IndexedFoldersProvider } from '../../src/ui/indexedFoldersView';
import { countFilesByFolder } from '../../src/ingestion/indexScope';

let root: string;

function mkdirs(...rels: string[]): void {
  for (const rel of rels) { fs.mkdirSync(path.join(root, ...rel.split('/')), { recursive: true }); }
}
function touch(rel: string): string {
  const file = path.join(root, ...rel.split('/'));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '');
  return file;
}

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'codelens-ui-folders-'));
  mkdirs(
    'src/a/deep', 'src/b', 'lib', 'Zeta', 'alpha',
    'node_modules/pkg', '.git', '.vscode', '.github/workflows',
    'dist', 'build', 'out', '__pycache__', 'web-dist', 'my_cache',
    'tools/node_modules', 'tools/.cache',
  );
  touch('package.json');
  touch('src/index.ts');
  touch('src/a/one.ts');
  touch('src/a/deep/two.ts');
  touch('lib/readme.txt');
  touch('lib/util.js');
});

after(() => {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
});

beforeEach(() => resetVscodeStub());

describe('listChildFolders', () => {
  it('lists sub-folders, skipping node_modules, hidden folders (except .github) and build/cache output', () => {
    const top = listChildFolders(root, '');
    assert.deepEqual([...top].sort(), ['.github', 'alpha', 'lib', 'src', 'tools', 'Zeta'].sort());
  });

  it('sorts names with localeCompare (case-insensitive order, not code-unit order)', () => {
    const top = listChildFolders(root, '').filter(n => !n.startsWith('.'));
    assert.deepEqual(top, ['alpha', 'lib', 'src', 'tools', 'Zeta']);
  });

  it('lists nested folders by a /-separated relative path', () => {
    assert.deepEqual(listChildFolders(root, 'src'), ['a', 'b']);
    assert.deepEqual(listChildFolders(root, 'src/a'), ['deep']);
    assert.deepEqual(listChildFolders(root, 'src/a/deep'), []);
    assert.deepEqual(listChildFolders(root, 'tools'), [], 'only skipped folders inside');
  });

  it('never lists files', () => {
    assert.ok(!listChildFolders(root, '').includes('package.json'));
    assert.deepEqual(listChildFolders(root, 'lib'), []);
  });

  it('returns [] for a missing directory or a file', () => {
    assert.deepEqual(listChildFolders(root, 'does/not/exist'), []);
    assert.deepEqual(listChildFolders(path.join(root, 'nope'), ''), []);
    assert.deepEqual(listChildFolders(root, 'package.json'), []);
  });
});

describe('FolderItem', () => {
  it('is a tree item keyed by its relative path', () => {
    const item = new FolderItem('src/a', 'a', true);
    assert.ok(item instanceof TreeItem);
    assert.equal(item.relPath, 'src/a');
    assert.equal(item.label, 'a');
    assert.equal(item.id, 'folder:src/a');
    assert.equal(item.contextValue, 'indexedFolder');
    assert.equal(item.collapsibleState, TreeItemCollapsibleState.Collapsed);
  });

  it('is not expandable without sub-folders', () => {
    assert.equal(new FolderItem('lib', 'lib', false).collapsibleState, TreeItemCollapsibleState.None);
  });
});

describe('IndexedFoldersProvider', () => {
  function provider(folders: string[] = [], enabled = true) {
    const state = { folders, enabled };
    const p = new IndexedFoldersProvider(root, () => state.folders, () => state.enabled);
    return { p, state };
  }
  const folderItems = (items: TreeItem[]) => items.filter((i): i is FolderItem => i instanceof FolderItem);
  const byPath = (items: TreeItem[], rel: string) => {
    const found = folderItems(items).find(i => i.relPath === rel);
    assert.ok(found, `item ${rel}`);
    return found;
  };

  it('root: a "Workspace root files" item first, then the top-level folders', () => {
    const items = provider().p.getChildren();
    const first = items[0];
    assert.ok(!(first instanceof FolderItem));
    assert.equal(first.label, 'Workspace root files');
    assert.equal(first.description, 'always indexed');
    assert.equal(first.collapsibleState, TreeItemCollapsibleState.None);
    assert.ok(first.iconPath instanceof ThemeIcon);
    assert.equal((first.iconPath as ThemeIcon).id, 'files');
    assert.deepEqual(folderItems(items).map(i => i.relPath), listChildFolders(root, ''));
    assert.equal(items.length, listChildFolders(root, '').length + 1);
  });

  it('only folders with listable sub-folders are expandable', () => {
    const items = provider().p.getChildren();
    assert.equal(byPath(items, 'src').collapsibleState, TreeItemCollapsibleState.Collapsed);
    assert.equal(byPath(items, 'lib').collapsibleState, TreeItemCollapsibleState.None);
    assert.equal(byPath(items, 'tools').collapsibleState, TreeItemCollapsibleState.None, 'node_modules/.cache do not count');
  });

  it('nested: children of a folder item, with /-joined paths and no root-files item', () => {
    const { p } = provider();
    const src = byPath(p.getChildren(), 'src');
    const children = p.getChildren(src);
    assert.ok(children.every(c => c instanceof FolderItem));
    assert.deepEqual(folderItems(children).map(c => [c.relPath, c.id]), [['src/a', 'folder:src/a'], ['src/b', 'folder:src/b']]);
    const deep = p.getChildren(byPath(children, 'src/a'));
    assert.deepEqual(folderItems(deep).map(c => c.relPath), ['src/a/deep']);
    assert.deepEqual(p.getChildren(byPath(deep, 'src/a/deep')), []);
  });

  it('an empty include list means everything is checked', () => {
    const { p } = provider([]);
    const items = folderItems(p.getChildren());
    for (const item of items) {
      assert.equal(item.checkboxState, TreeItemCheckboxState.Checked, item.relPath);
      assert.equal(item.description, '');
      assert.match(String(item.tooltip), /is indexed\. Uncheck/);
    }
  });

  it('checked, unchecked and partially included folders', () => {
    const { p } = provider(['src/a', 'lib']);
    const top = p.getChildren();
    const src = byPath(top, 'src');
    assert.equal(src.checkboxState, TreeItemCheckboxState.Unchecked);
    assert.equal(src.description, 'partially indexed');
    assert.equal(src.tooltip, 'Some folders inside src are indexed. Check to index all of it.');

    const lib = byPath(top, 'lib');
    assert.equal(lib.checkboxState, TreeItemCheckboxState.Checked);
    assert.equal(lib.description, '');
    assert.equal(lib.tooltip, 'lib is indexed. Uncheck to stop indexing it.');

    const alpha = byPath(top, 'alpha');
    assert.equal(alpha.checkboxState, TreeItemCheckboxState.Unchecked);
    assert.equal(alpha.description, '');
    assert.equal(alpha.tooltip, 'alpha is not indexed. Check to index it.');

    const inSrc = p.getChildren(src);
    assert.equal(byPath(inSrc, 'src/a').checkboxState, TreeItemCheckboxState.Checked);
    assert.equal(byPath(inSrc, 'src/b').checkboxState, TreeItemCheckboxState.Unchecked);
    assert.equal(byPath(inSrc, 'src/b').description, '');
    // A selected ancestor checks every descendant.
    assert.equal(byPath(p.getChildren(byPath(inSrc, 'src/a')), 'src/a/deep').checkboxState, TreeItemCheckboxState.Checked);
  });

  it('reads the include list on every call', () => {
    const { p, state } = provider(['lib']);
    assert.equal(byPath(p.getChildren(), 'src').checkboxState, TreeItemCheckboxState.Unchecked);
    state.folders = ['src'];
    assert.equal(byPath(p.getChildren(), 'src').checkboxState, TreeItemCheckboxState.Checked);
  });

  it('is empty while CodeLens is off, so the welcome view shows', () => {
    const { p, state } = provider([], false);
    const src = new FolderItem('src', 'src', true);
    assert.deepEqual(p.getChildren(), []);
    assert.deepEqual(p.getChildren(src), []);
    state.enabled = true;
    assert.ok(p.getChildren().length > 1);
    assert.equal(p.getChildren(src).length, 2);
  });

  it('shows file counts once set, combined with the partial marker', () => {
    const { p } = provider(['src/a']);
    const counts = countFilesByFolder(
      ['src/index.ts', 'src/a/one.ts', 'src/a/deep/two.ts', 'lib/readme.txt', 'lib/util.js'].map(rel => path.join(root, ...rel.split('/'))),
      root
    );
    p.setFileCounts(counts);
    const top = p.getChildren();
    assert.equal(byPath(top, 'src').description, '3 files · partially indexed');
    assert.equal(byPath(top, 'lib').description, '2 files');
    assert.equal(byPath(top, 'alpha').description, '0 files');
    const inSrc = p.getChildren(byPath(top, 'src'));
    assert.equal(byPath(inSrc, 'src/a').description, '2 files');
    assert.equal(byPath(inSrc, 'src/b').description, '0 files');
  });

  it('refresh() and setFileCounts() fire onDidChangeTreeData with undefined (whole tree)', () => {
    const { p } = provider();
    const events: unknown[] = [];
    const sub = p.onDidChangeTreeData(e => events.push(e));
    p.refresh();
    p.setFileCounts(new Map());
    assert.deepEqual(events, [undefined, undefined]);
    sub.dispose();
    p.refresh();
    assert.equal(events.length, 2, 'disposed listener is not called');
  });

  it('getTreeItem returns the item itself', () => {
    const item = new FolderItem('lib', 'lib', false);
    assert.equal(provider().p.getTreeItem(item), item);
  });
});
