import * as fs from 'fs';
import { WorkspaceScanner } from './workspaceScanner';

type ChangeCallback = (filePath: string, changeType: 'change' | 'add' | 'unlink') => void;

// ─── FileWatcher ───────────────────────────────────────────────────────────────
// Watches the workspace for file changes and triggers incremental graph updates.
// In a VS Code extension, this wraps vscode.workspace.createFileSystemWatcher.
// This standalone version uses chokidar for testability outside VS Code.

export class FileWatcher {
  private callbacks: ChangeCallback[] = [];
  private watchers: fs.FSWatcher[] = [];
  private debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly DEBOUNCE_MS = 500; // Wait 500ms after last change before processing

  constructor(private scanner: WorkspaceScanner) {}

  // Register a callback for file change events
  onChange(cb: ChangeCallback): void {
    this.callbacks.push(cb);
  }

  // Start watching a set of root directories
  watchRoots(roots: string[], supportedExtensions: string[]): void {
    const extSet = new Set(supportedExtensions.map(e => e.toLowerCase()));

    for (const root of roots) {
      try {
        const watcher = fs.watch(root, { recursive: true }, (eventType, filename) => {
          if (!filename) { return; }

          const fullPath = require('path').join(root, filename);
          const ext = require('path').extname(filename).toLowerCase();
          if (!extSet.has(ext)) { return; }

          // Debounce rapid saves
          this.debounce(fullPath, () => {
            const exists = fs.existsSync(fullPath);
            const changeType = exists
              ? (eventType === 'rename' ? 'add' : 'change')
              : 'unlink';
            this.emit(fullPath, changeType);
          });
        });

        this.watchers.push(watcher);
      } catch (err) {
        console.warn(`[CodeLens] Could not watch ${root}: ${err}`);
      }
    }
  }

  // Handle a specific file change (called from VS Code's FileSystemWatcher)
  async handleFileChange(filePath: string): Promise<void> {
    try {
      await this.scanner.updateFile(filePath);
      this.emit(filePath, 'change');
    } catch (err) {
      console.error(`[CodeLens] Error updating file ${filePath}: ${err}`);
    }
  }

  async handleFileCreate(filePath: string): Promise<void> {
    try {
      await this.scanner.updateFile(filePath);
      this.emit(filePath, 'add');
    } catch (err) {
      console.error(`[CodeLens] Error adding file ${filePath}: ${err}`);
    }
  }

  handleFileDelete(filePath: string): void {
    // GraphDB cascades deletes via FK when nodes are removed by file path
    this.emit(filePath, 'unlink');
  }

  // Stop all watchers
  dispose(): void {
    for (const w of this.watchers) { w.close(); }
    this.watchers = [];
    this.callbacks = [];
    for (const t of this.debounceTimers.values()) { clearTimeout(t); }
    this.debounceTimers.clear();
  }

  private emit(filePath: string, changeType: 'change' | 'add' | 'unlink'): void {
    for (const cb of this.callbacks) { cb(filePath, changeType); }
  }

  private debounce(key: string, fn: () => void): void {
    const existing = this.debounceTimers.get(key);
    if (existing) { clearTimeout(existing); }
    this.debounceTimers.set(key, setTimeout(() => {
      this.debounceTimers.delete(key);
      fn();
    }, this.DEBOUNCE_MS));
  }
}
