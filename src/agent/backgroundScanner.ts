import * as fs from 'fs';
import * as path from 'path';
import { GraphDB }          from '../graph/graphDB';
import { WorkspaceScanner, ScanOptions } from '../ingestion/workspaceScanner';
import { SkillGenerator }  from '../agent/skillGenerator';
import { GraphStats }       from '../types';

// File-change events arrive in bursts (git checkout, format-on-save, codegen).
// Events inside this window are applied as one batch: one relationship
// resolve and one DB write instead of one per file.
const FILE_BATCH_DEBOUNCE_MS = 400;

// How long to wait before regenerating skills after a file change.
// Prevents thrashing on rapid saves.
const SKILL_REGEN_DEBOUNCE_MS = 5_000;

// Dependency (node_modules) indexing is lower priority than the workspace
// itself, so it starts a little after the workspace pass finishes.
const DEPS_SCAN_DELAY_MS = 2_000;

// Long loops hand control back to the shared extension-host thread this often.
const YIELD_INTERVAL_MS = 25;

const yieldToEventLoop = () => new Promise<void>(resolve => setImmediate(resolve));
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

type FileChange = 'change' | 'delete';

// ─── BackgroundScanner ────────────────────────────────────────────────────────
// Orchestrates indexing without blocking VS Code:
//   1. Full scans (startup / manual), then a delayed dependency pass
//   2. Batched incremental updates from file-change events
//   3. Skill file regeneration after changes settle
// Scans and batches run one at a time through a single queue, so a batch
// never interleaves with a scan writing the same DB.

export class BackgroundScanner {
  private work: Promise<unknown> = Promise.resolve();
  private queuedFullScan: Promise<GraphStats | null> | null = null;

  private depsScan: Promise<void> = Promise.resolve();
  private depsTimer: ReturnType<typeof setTimeout> | null = null;
  private resolveDepsScan: (() => void) | null = null;

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

  // Resolves once no scan, batch, or dependency pass is running or pending.
  async whenIdle(): Promise<void> {
    for (;;) {
      if (this.batchTimer || this.pendingChanges.size) {
        await delay(FILE_BATCH_DEBOUNCE_MS);
        continue;
      }
      const work = this.work;
      const deps = this.depsScan;
      await Promise.all([work, deps]);
      if (work === this.work && deps === this.depsScan && !this.batchTimer && !this.pendingChanges.size) {
        return;
      }
    }
  }

  // ── Full scan + skill generation ───────────────────────────────────────────
  // Scans the workspace (skipping unchanged files), then schedules the
  // dependency pass. Concurrent non-forced requests share one queued scan.

  runFullScan(workspaceRoot: string, options: ScanOptions): Promise<GraphStats | null> {
    if (this.queuedFullScan && !options.force) { return this.queuedFullScan; }
    const scan = this.enqueue(() => this.scanWorkspacePhase(workspaceRoot, options));
    this.queuedFullScan = scan;
    void scan.finally(() => {
      if (this.queuedFullScan === scan) { this.queuedFullScan = null; }
    });
    return scan;
  }

  private async scanWorkspacePhase(workspaceRoot: string, options: ScanOptions): Promise<GraphStats | null> {
    if (this.disposed) { return null; }
    this.onStatusChange?.('scanning');
    try {
      await this.db.ensureInit();
      console.log('[CodeLens] Workspace scan starting (excluding dependencies)…');
      const result = await this.scanner.scanWorkspace([workspaceRoot], { ...options, excludeDeps: true });
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

      await this.generateSkills(workspaceRoot, stats);
      this.onScanComplete?.(stats);
      this.onStatusChange?.('ready');
      this.scheduleDependencyScan(workspaceRoot, options, stats.buildDurationMs);
      return stats;
    } catch (err) {
      console.error('[CodeLens] Background scan failed:', err);
      this.onStatusChange?.('error');
      return null;
    }
  }

  private scheduleDependencyScan(workspaceRoot: string, options: ScanOptions, workspaceScanMs: number): void {
    this.cancelDependencyScan();
    this.depsScan = new Promise<void>(resolve => {
      this.resolveDepsScan = resolve;
      this.depsTimer = setTimeout(() => {
        this.depsTimer = null;
        this.enqueue(async () => {
          if (this.disposed) { return; }
          console.log('[CodeLens] Dependency scan starting…');
          const depResult = await this.scanner.scanWorkspace([workspaceRoot], {
            ...options,
            depsOnly:   true,
            onProgress: undefined,
          });
          console.log(`[CodeLens] Dependency scan complete: ${depResult.filesScanned} dependency files parsed.`);
          if (depResult.filesScanned > 0) {
            const stats: GraphStats = {
              ...this.db.getStats(),
              lastBuilt:       Date.now(),
              buildDurationMs: workspaceScanMs + depResult.durationMs,
            };
            this.lastScanStats = stats;
            await this.generateSkills(workspaceRoot, stats);
            this.onScanComplete?.(stats);
          }
        })
          .catch(err => console.error('[CodeLens] Background dependency scan failed:', err))
          .finally(() => this.finishDependencyScan());
      }, DEPS_SCAN_DELAY_MS);
    });
  }

  private finishDependencyScan(): void {
    const resolve = this.resolveDepsScan;
    this.resolveDepsScan = null;
    resolve?.();
  }

  private cancelDependencyScan(): void {
    if (this.depsTimer) { clearTimeout(this.depsTimer); this.depsTimer = null; }
    this.finishDependencyScan();
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
    this.onStatusChange?.('updating');

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
              collectSymbols(indexed);
              this.db.deleteNodesByFile(indexed); // also drops its text-index rows
              changedFiles.push(indexed);
            }
          } else {
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
      // The UI refresh this triggers runs as its own task, not stacked onto
      // the DB write above.
      await yieldToEventLoop();
      this.onStatusChange?.('ready');
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
    workspaceRoot: string,
    options: ScanOptions
  ): Promise<void> {
    const allowedFiles = changedFiles
      .map(fp => path.isAbsolute(fp) ? fp : path.resolve(workspaceRoot, fp))
      .filter(fp => this.scanner.isFileAllowed(fp, workspaceRoot, options));
    console.log(`[CodeLens] Agent run complete. Re-scanning ${allowedFiles.length} / ${changedFiles.length} allowed files…`);

    const batch = new Map<string, FileChange>(allowedFiles.map(fp => [fp, 'change']));
    await this.enqueue(() => this.applyBatch(batch, workspaceRoot));

    const stats: GraphStats = { ...this.db.getStats(), lastBuilt: Date.now(), buildDurationMs: 0 };
    this.lastScanStats = stats;
    await this.generateSkills(workspaceRoot, stats);
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
    this.cancelDependencyScan();
    if (this.skillRegenTimer) { clearTimeout(this.skillRegenTimer); this.skillRegenTimer = null; }
  }
}
