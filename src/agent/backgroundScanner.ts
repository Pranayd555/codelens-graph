import * as vscode from 'vscode';
import * as path from 'path';
import { GraphDB }          from '../graph/graphDB';
import { WorkspaceScanner, ScanOptions } from '../ingestion/workspaceScanner';
import { SkillGenerator }  from '../agent/skillGenerator';
import { GraphStats }       from '../types';

// How long to wait after VS Code opens before starting the background scan.
// Gives VS Code time to finish loading other extensions first.
const INITIAL_SCAN_DELAY_MS = 3_000;

// How long to wait before regenerating skills after a file change.
// Prevents thrashing on rapid saves.
const SKILL_REGEN_DEBOUNCE_MS = 5_000;

// ─── BackgroundScanner ────────────────────────────────────────────────────────
// Orchestrates the fully autonomous workflow:
//   1. Silent background scan on activation
//   2. Skill file generation + update
//   3. Incremental re-scan on file save
//   4. Skill regeneration after batched changes

export class BackgroundScanner {
  private isScanning       = false;
  private skillRegenTimer: ReturnType<typeof setTimeout> | null = null;
  private changesSinceRegen: Set<string> = new Set();

  private lastScanStats:   GraphStats | null = null;

  private onScanComplete?: (stats: GraphStats) => void;
  private onSkillsWritten?: (paths: string[]) => void;
  private onStatusChange?:  (msg: string) => void;

  constructor(
    private db:             GraphDB,
    private scanner:        WorkspaceScanner,
    private skillGenerator: SkillGenerator,
    private getSelectedIdes: () => string[]
  ) {}

  // ── Register callbacks ─────────────────────────────────────────────────────

  onComplete(cb: (stats: GraphStats) => void)    { this.onScanComplete  = cb; }
  onSkills(cb: (paths: string[]) => void)         { this.onSkillsWritten = cb; }
  onStatus(cb: (msg: string) => void)             { this.onStatusChange  = cb; }

  // ── Entry point: called from extension.activate() ─────────────────────────
  // Delays slightly then silently scans and generates skills.

  scheduleInitialScan(
    workspaceRoot: string,
    options: ScanOptions,
    context: vscode.ExtensionContext
  ): void {
    const timer = setTimeout(async () => {
      await this.runFullScan(workspaceRoot, options);
    }, INITIAL_SCAN_DELAY_MS);

    // Clean up timer if extension deactivates before it fires
    context.subscriptions.push({ dispose: () => clearTimeout(timer) });
  }

  // ── Full scan + skill generation ───────────────────────────────────────────

  async runFullScan(workspaceRoot: string, options: ScanOptions): Promise<GraphStats | null> {
    if (this.isScanning) {
      console.log('[CodeLens] Scan already in progress, skipping.');
      return null;
    }

    this.isScanning = true;
    this.onStatusChange?.('scanning');

    try {
      console.log('[CodeLens] Background scan starting…');

      const result = await this.scanner.scanWorkspace([workspaceRoot], {
        ...options,
        // No progress callback — this is silent
        onProgress: undefined,
      });

      const dbStats = this.db.getStats();
      const fullStats: GraphStats = {
        ...dbStats,
        lastBuilt:       Date.now(),
        buildDurationMs: result.durationMs,
      };

      this.lastScanStats = fullStats;
      console.log(`[CodeLens] Scan complete: ${result.filesScanned} files, ${result.nodesAdded} symbols in ${result.durationMs}ms`);

      // Generate skill files immediately after scan
      await this.generateSkills(workspaceRoot, fullStats);

      this.onScanComplete?.(fullStats);
      this.onStatusChange?.('ready');
      return fullStats;

    } catch (err) {
      console.error('[CodeLens] Background scan failed:', err);
      this.onStatusChange?.('error');
      return null;
    } finally {
      this.isScanning = false;
    }
  }

  // ── Incremental update for a single file change ────────────────────────────
  // Called by FileWatcher on every save. Batches changes and
  // regenerates skills after the debounce window closes.

  async handleFileChanged(filePath: string, workspaceRoot: string, options: ScanOptions): Promise<void> {
    try {
      // Re-parse just the changed file
      await this.scanner.updateFile(filePath);
      this.changesSinceRegen.add(filePath);

      console.log(`[CodeLens] Incremental update: ${path.basename(filePath)}`);

      // Debounce skill regeneration — wait for a quiet moment
      this.scheduleSkillRegen(workspaceRoot);

    } catch (err) {
      console.error(`[CodeLens] Failed to update ${filePath}:`, err);
    }
  }

  // ── Trigger after agent finishes (called by the command handler) ───────────
  // Re-scans files changed during the agent run and regenerates skills.

  async handleAgentRunComplete(
    changedFiles: string[],
    workspaceRoot: string,
    options: ScanOptions
  ): Promise<void> {
    console.log(`[CodeLens] Agent run complete. Re-scanning ${changedFiles.length} changed files…`);
    this.onStatusChange?.('updating');

    for (const fp of changedFiles) {
      try {
        await this.scanner.updateFile(fp, false);
      } catch { /* ignore individual file errors */ }
    }

    this.db.resolveWorkspaceRelationships();
    this.db.persist();
    const dbStats = this.db.getStats();
    const stats: GraphStats = {
      ...dbStats,
      lastBuilt: Date.now(),
      buildDurationMs: 0,
    };

    this.lastScanStats = stats;
    await this.generateSkills(workspaceRoot, stats);
    this.onScanComplete?.(stats);
    this.onStatusChange?.('ready');
  }

  // ── Skill generation ───────────────────────────────────────────────────────

  private async generateSkills(workspaceRoot: string, stats: GraphStats): Promise<void> {
    try {
      const selectedIdes = this.getSelectedIdes();
      const written = this.skillGenerator.generateAll(workspaceRoot, stats, selectedIdes);
      console.log(`[CodeLens] Skills written to: ${written.join(', ')}`);
      this.onSkillsWritten?.(written);
      this.changesSinceRegen.clear();
    } catch (err) {
      console.error('[CodeLens] Skill generation failed:', err);
    }
  }

  private scheduleSkillRegen(workspaceRoot: string): void {
    if (this.skillRegenTimer) { clearTimeout(this.skillRegenTimer); }
    this.skillRegenTimer = setTimeout(async () => {
      this.skillRegenTimer = null;
      const dbStats = this.db.getStats();
      const stats: GraphStats = {
        ...dbStats,
        lastBuilt: Date.now(),
        buildDurationMs: 0,
      };
      await this.generateSkills(workspaceRoot, stats);
    }, SKILL_REGEN_DEBOUNCE_MS);
  }

  getLastStats(): GraphStats | null { return this.lastScanStats; }

  dispose(): void {
    if (this.skillRegenTimer) { clearTimeout(this.skillRegenTimer); }
  }
}
