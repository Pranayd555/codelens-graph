import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { isSkippedDirectoryName } from '../ingestion/workspaceScanner';
import { isFolderIncluded, isFolderPartiallyIncluded, folderCount } from '../ingestion/indexScope';

// Sub-folders shown in the tree and offered in the picker: everything except
// build output, caches, tool folders and node_modules (those are never indexed
// unless named explicitly in codeLensGraph.includeFolders).
export function listChildFolders(workspaceRoot: string, relDir: string): string[] {
  const abs = relDir ? path.join(workspaceRoot, ...relDir.split('/')) : workspaceRoot;
  try {
    return fs.readdirSync(abs, { withFileTypes: true })
      .filter(e => e.isDirectory() && !isSkippedDirectoryName(e.name))
      .map(e => e.name)
      .sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

export class FolderItem extends vscode.TreeItem {
  constructor(readonly relPath: string, label: string, hasChildren: boolean) {
    super(label, hasChildren ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
    this.id = 'folder:' + relPath;
    this.contextValue = 'indexedFolder';
  }
}

// ─── Indexed Folders view ─────────────────────────────────────────────────────
// Tree of workspace folders with checkboxes mirroring codeLensGraph.includeFolders.
// Checkbox changes are handled by the extension (it updates the setting, which
// triggers an incremental re-scan).

export class IndexedFoldersProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private readonly changed = new vscode.EventEmitter<vscode.TreeItem | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  private counts: Map<string, number> | null = null;

  constructor(
    private readonly workspaceRoot: string,
    private readonly getFolders: () => string[],
    // While CodeLens is off for the workspace the tree is empty, so VS Code
    // shows the view's welcome content (a "Turn On" link) instead.
    private readonly isEnabled: () => boolean
  ) {}

  refresh(): void { this.changed.fire(undefined); }

  setFileCounts(counts: Map<string, number>): void {
    this.counts = counts;
    this.refresh();
  }

  getTreeItem(item: vscode.TreeItem): vscode.TreeItem { return item; }

  getChildren(parent?: vscode.TreeItem): vscode.TreeItem[] {
    if (!this.isEnabled()) { return []; }
    const relDir = parent instanceof FolderItem ? parent.relPath : '';
    const folders = this.getFolders();
    const items: vscode.TreeItem[] = [];

    if (!parent) {
      const rootFiles = new vscode.TreeItem('Workspace root files', vscode.TreeItemCollapsibleState.None);
      rootFiles.description = 'always indexed';
      rootFiles.tooltip = 'Files directly in the workspace root (package.json, tsconfig.json, …) are always indexed.';
      rootFiles.iconPath = new vscode.ThemeIcon('files');
      items.push(rootFiles);
    }

    for (const name of listChildFolders(this.workspaceRoot, relDir)) {
      const relPath = relDir ? `${relDir}/${name}` : name;
      const item = new FolderItem(relPath, name, listChildFolders(this.workspaceRoot, relPath).length > 0);
      const included = isFolderIncluded(relPath, folders);
      const partial = isFolderPartiallyIncluded(relPath, folders);
      item.checkboxState = included ? vscode.TreeItemCheckboxState.Checked : vscode.TreeItemCheckboxState.Unchecked;

      const parts: string[] = [];
      if (this.counts) { parts.push(`${folderCount(this.counts, relPath)} files`); }
      if (partial) { parts.push('partially indexed'); }
      item.description = parts.join(' · ');
      item.tooltip = included
        ? `${relPath} is indexed. Uncheck to stop indexing it.`
        : partial
          ? `Some folders inside ${relPath} are indexed. Check to index all of it.`
          : `${relPath} is not indexed. Check to index it.`;
      items.push(item);
    }
    return items;
  }
}
