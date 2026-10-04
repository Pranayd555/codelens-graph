import * as fs from 'fs';
import * as path from 'path';
import { GraphDB }          from '../graph/graphDB';
import { WorkspaceScanner, ScanOptions } from '../ingestion/workspaceScanner';
import { IndexScope }       from '../ingestion/indexScope';
import { readDependencyManifest } from '../ingestion/dependencyManifest';
import { SkillGenerator }  from '../agent/skillGenerator';
import { GraphStats }       from '../types';
import { isNodeModulePath } from '../utils';

// File-change events arrive in bursts (git checkout, format-on-save, codegen).
// Events inside this window are applied as one batch: one relationship
// resolve and one DB write instead of one per file.
const FILE_BATCH_DEBOUNCE_MS = 400;

// How long to wait before regenerating skills after a file change.
// Prevents thrashing on rapid saves.
const SKILL_REGEN_DEBOUNCE_MS = 5_000;

// Long loops hand control back to the shared extension-host thread this often.
const YIELD_INTERVAL_MS = 25;

const yieldToEventLoop = () => new Promise<void>(resolve => setImmediate(resolve));
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

type FileChange = 'change' | 'delete';

// ─── BackgroundScanner ────────────────────────────────────────────────────────
// Orchestrates indexing without blocking VS Code:
//   1. Full scans (startup / manual / scope change) that reconcile the graph
//      with the selected folders, then a refresh of the dependency manifest
//   2. Batched incremental updates from file-change events
//   3. Skill file regeneration after changes settle
// Scans, batches and manifest refreshes run one at a time through a single
// queue, so nothing interleaves writes to the same DB.

export class BackgroundScanner {
  private work: Promise<unknown> = Promise.resolve();
  private queuedFullScan: Promise<GraphStats | null> | null = null;

  private acceptingChanges = false;
  private pendingChanges = new Map<string, FileChange>();
  private batchTimer: ReturnType<typeof setTimeout> | null = null;
  private batchContext: { workspaceRoot: string } | null = null;

  private skillRegenTimer: ReturnType<typeof setTimeout> | null = null;
  private lastScanStats:   GraphStats | null = null;
  private disposed = false;

  private onScanComplete?: (stats: GraphStats) => void;
  private onStatusChange?:  (msg: string) => void;

  constructor(
    private db:             GraphDB,
    private scanner:        WorkspaceScanner,
    private skillGenerator: SkillGenerator,
    // undefined = the user has not chosen which agents to configure yet
    private getSelectedIdes: () => string[] | undefined
  ) {}

  // ── Register callbacks ─────────────────────────────────────────────────────

  onComplete(cb: (stats: GraphStats) => void)    { this.onScanComplete  = cb; }
  onStatus(cb: (msg: string) => void)             { this.onStatusChange  = cb; }

  // Runs fn after all previously queued scans/batches have finished.
  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.work.then(fn, fn);
    this.work = run.catch(() => undefined);
    return run;
  }

  // Resolves once no scan or batch is running or pending.
  async whenIdle(): Promise<void> {
    for (;;) {
      if (this.batchTimer || this.pendingChanges.size) {
        await delay(FILE_BATCH_DEBOUNCE_MS);
        continue;
      }
      const work = this.work;
      await work;
      if (work === this.work && !this.batchTimer && !this.pendingChanges.size) { return; }
    }
  }

  // Number of files a full scan of this scope would index (walks the folders,
  // parses nothing). Used to ask before indexing very large workspaces.
  async countIndexableFiles(scope: IndexScope, options: ScanOptions): Promise<number> {
    return (await this.scanner.listFiles(scope, options)).length;
  }

  // ── Full scan + skill generation ───────────────────────────────────────────
  // Reconciles the graph with the scope (unchanged files are skipped), then
  // refreshes the dependency manifest. Concurrent non-forced requests share
  // one queued scan.

  runFullScan(scope: IndexScope, options: ScanOptions): Promise<GraphStats | null> {
    if (this.queuedFullScan && !options.force) { return this.queuedFullScan; }
    const scan = this.enqueue(() => this.scanPhase(scope, options));
    this.queuedFullScan = scan;
    void scan.finally(() => {
      if (this.queuedFullScan === scan) { this.queuedFullScan = null; }
    });
    return scan;
  }

  private async scanPhase(scope: IndexScope, options: ScanOptions): Promise<GraphStats | null> {
    if (this.disposed) { return null; }
    this.onStatusChange?.('scanning');
    try {
      await this.db.ensureInit();
      const folders = scope.folders.length ? scope.folders.join(', ') : 'entire workspace';
      console.log(`[CodeLens] Workspace scan starting (${folders})…`);
      const result = await this.scanner.scanWorkspace(scope, options);
      if (await this.refreshManifest(scope.workspaceRoot)) { this.db.persist(); }

      const stats: GraphStats = {
        ...this.db.getStats(),
        lastBuilt:       Date.now(),
        buildDurationMs: result.durationMs,
      };
      this.lastScanStats = stats;
      console.log(
        `[CodeLens] Workspace scan complete: ${result.filesScanned} parsed, ` +
        `${result.filesSkipped} unchanged, ${result.durationMs}ms.`
      );

      await this.generateSkills(scope.workspaceRoot, stats);
      this.onScanComplete?.(stats);
      this.onStatusChange?.('ready');
      return stats;
    } catch (err) {
      console.error('[CodeLens] Background scan failed:', err);
      this.onStatusChange?.('error');
      return null;
    }
  }

  // ── Dependency manifest ────────────────────────────────────────────────────
  // Direct dependencies of the workspace's package.json files (one package.json
  // read per dependency; node_modules is never walked or parsed).

  refreshDependencies(workspaceRoot: string): Promise<void> {
    return this.enqueue(async () => {
      if (this.disposed) { return; }
      await this.db.ensureInit();
      if (await this.refreshManifest(workspaceRoot)) {
        this.db.persist();
        console.log('[CodeLens] Dependency manifest updated.');
      }
    }).catch(err => console.error('[CodeLens] Dependency manifest refresh failed:', err));
  }

  // Returns whether the stored manifest changed.
  private async refreshManifest(workspaceRoot: string): Promise<boolean> {
    const manifests = this.db.getAllFiles('all')
      .filter(f => path.basename(f).toLowerCase() === 'package.json' && !isNodeModulePath(f));
    const packages = await readDependencyManifest(workspaceRoot, manifests);
    return this.db.replacePackages(packages);
  }

  // ── Incremental updates from file-change events ────────────────────────────

  // Events are ignored until the first scan has started (that scan picks up
  // anything changed before it) and while the graph is cleared.
  setAcceptingChanges(accepting: boolean): void {
    this.acceptingChanges = accepting;
    if (!accepting) {
      this.pendingChanges.clear();
      if (this.batchTimer) { clearTimeout(this.batchTimer); this.batchTimer = null; }
    }
  }

  // Callers filter out-of-scope paths before queueing.
  queueFileChange(filePath: string, change: FileChange, workspaceRoot: string): void {
    if (!this.acceptingChanges || this.disposed) { return; }
    this.pendingChanges.set(filePath, change); // latest event per path wins
    this.batchContext = { workspaceRoot };
    if (this.batchTimer) { clearTimeout(this.batchTimer); }
    this.batchTimer = setTimeout(() => {
      this.batchTimer = null;
      this.flushBatch();
    }, FILE_BATCH_DEBOUNCE_MS);
  }

  private flushBatch(): void {
    if (!this.pendingChanges.size || !this.batchContext) { return; }
    const batch = new Map(this.pendingChanges);
    this.pendingChanges.clear();
    const { workspaceRoot } = this.batchContext;
    void this.enqueue(() => this.applyBatch(batch, workspaceRoot))
      .catch(err => console.error('[CodeLens] Failed to apply file changes:', err));
  }

  // Re-parses changed files, drops deleted ones, then resolves relationships
  // and writes the DB once for the whole batch.
  private async applyBatch(batch: Map<string, FileChange>, workspaceRoot: string): Promise<void> {
    if (this.disposed) { return; }
    await this.db.ensureInit();

    // Only show "updating" once the batch actually touches an indexed file
    // (deleting build output, for example, changes nothing).
    let announced = false;
    const announce = () => {
      if (!announced) { announced = true; this.onStatusChange?.('updating'); }
    };

    const changedFiles: string[] = [];
    const affectedSymbols = new Set<string>();
    let indexedFiles: string[] | null = null; // looked up once, only if a batch has deletes
    const collectSymbols = (filePath: string) => {
      for (const node of this.db.getNodesByFile(filePath)) {
        if (node.type !== 'file' && node.type !== 'import') { affectedSymbols.add(node.name); }
      }
    };

    try {
      let lastYield = Date.now();
      for (const [filePath, change] of batch) {
        if (Date.now() - lastYield > YIELD_INTERVAL_MS) {
          await yieldToEventLoop();
          lastYield = Date.now();
        }
        try {
          if (change === 'delete' || !fs.existsSync(filePath)) {
            // A deleted folder arrives as one event for the folder itself.
            indexedFiles ??= this.db.getAllFiles('all');
            for (const indexed of this.indexedFilesAt(filePath, indexedFiles)) {
              announce();
              collectSymbols(indexed);
              this.db.deleteNodesByFile(indexed); // also drops its text-index rows
              changedFiles.push(indexed);
            }
          } else {
            announce();
            collectSymbols(filePath);
            const parsed = await this.scanner.updateFile(filePath, false);
            for (const node of parsed.nodes) {
              if (node.type !== 'file' && node.type !== 'import') { affectedSymbols.add(node.name); }
            }
            changedFiles.push(filePath);
          }
        } catch (err) {
          console.error(`[CodeLens] Failed to update ${filePath}:`, err);
        }
      }

      if (changedFiles.length) {
        await this.db.resolveWorkspaceRelationships(changedFiles, [...affectedSymbols]);
        this.db.persist();
        console.log(`[CodeLens] Applied ${changedFiles.length} file change(s) in one batch.`);
        this.scheduleSkillRegen(workspaceRoot);
      }
    } finally {
      if (announced) {
        // The UI refresh this triggers runs as its own task, not stacked onto
        // the DB write above.
        await yieldToEventLoop();
        this.onStatusChange?.('ready');
      }
    }
  }

  // The indexed file at this path, or every indexed file under it if it was a folder.
  private indexedFilesAt(deletedPath: string, indexedFiles: string[]): string[] {
    if (indexedFiles.includes(deletedPath)) { return [deletedPath]; }
    const prefix = deletedPath.endsWith(path.sep) ? deletedPath : deletedPath + path.sep;
    return indexedFiles.filter(f => f.startsWith(prefix));
  }

  // ── Trigger after agent finishes (called by the command handler) ───────────
  // Re-scans files changed during the agent run and regenerates skills.

  async handleAgentRunComplete(
    changedFiles: string[],
    scope: IndexScope,
    options: ScanOptions
  ): Promise<void> {
    const allowedFiles = changedFiles
      .map(fp => path.isAbsolute(fp) ? fp : path.resolve(scope.workspaceRoot, fp))
      .filter(fp => this.scanner.isFileAllowed(fp, scope, options));
    console.log(`[CodeLens] Agent run complete. Re-scanning ${allowedFiles.length} / ${changedFiles.length} allowed files…`);

    const batch = new Map<string, FileChange>(allowedFiles.map(fp => [fp, 'change']));
    await this.enqueue(() => this.applyBatch(batch, scope.workspaceRoot));

    const stats: GraphStats = { ...this.db.getStats(), lastBuilt: Date.now(), buildDurationMs: 0 };
    this.lastScanStats = stats;
    await this.generateSkills(scope.workspaceRoot, stats);
    this.onScanComplete?.(stats);
  }

  // ── Skill generation ───────────────────────────────────────────────────────
  // Until the user picks which agents to configure, only CodeLens's own
  // .codelens/ files are written — nothing in the user's project files.

  private async generateSkills(workspaceRoot: string, stats: GraphStats): Promise<void> {
    try {
      const selectedIdes = this.getSelectedIdes();
      const written = selectedIdes === undefined
        ? this.skillGenerator.writeInternalFiles(workspaceRoot, stats)
        : this.skillGenerator.generateAll(workspaceRoot, stats, selectedIdes);
      console.log(`[CodeLens] Skills up to date: ${written.join(', ')}`);
    } catch (err) {
      console.error('[CodeLens] Skill generation failed:', err);
    }
  }

  private scheduleSkillRegen(workspaceRoot: string): void {
    if (this.skillRegenTimer) { clearTimeout(this.skillRegenTimer); }
    this.skillRegenTimer = setTimeout(async () => {
      this.skillRegenTimer = null;
      const stats: GraphStats = { ...this.db.getStats(), lastBuilt: Date.now(), buildDurationMs: 0 };
      await this.generateSkills(workspaceRoot, stats);
    }, SKILL_REGEN_DEBOUNCE_MS);
  }

  getLastStats(): GraphStats | null { return this.lastScanStats; }

  dispose(): void {
    this.disposed = true;
    this.setAcceptingChanges(false);
    if (this.skillRegenTimer) { clearTimeout(this.skillRegenTimer); this.skillRegenTimer = null; }
  }
}
