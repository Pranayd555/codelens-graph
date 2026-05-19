import * as crypto from 'crypto';
import { GraphDB } from '../graph/graphDB';
import { GraphSnapshot, GraphNode } from '../types';

function uuid(): string {
  return crypto.randomBytes(16).toString('hex');
}

// ─── GraphDiffer ───────────────────────────────────────────────────────────────
// Captures graph state before an agent run, then diffs it after.

export class GraphDiffer {
  // Map of nodeId → content hash, captured at snapshot time
  private snapshots = new Map<string, Map<string, string>>();

  constructor(private db: GraphDB) {}

  // ── Pre-run: capture current state ────────────────────────────────────────

  captureBaseline(runId: string): void {
    const snapshot = new Map<string, string>();
    const stats = this.db.getStats();

    // Capture hash of every node currently in the DB
    // We iterate by file to avoid loading everything at once
    const files = this.db.getAllFiles();
    for (const filePath of files) {
      const nodes = this.db.getNodesByFile(filePath);
      for (const node of nodes) {
        snapshot.set(node.id, node.hash ?? this.hashNode(node));
      }
    }

    this.snapshots.set(runId, snapshot);
    console.log(`[CodeLens] Baseline captured for run ${runId}: ${snapshot.size} nodes`);
  }

  // ── Post-run: diff against baseline ───────────────────────────────────────

  computeDiff(runId: string): GraphSnapshot {
    const baseline = this.snapshots.get(runId) ?? new Map<string, string>();
    const stats = this.db.getStats();

    // Build current state map
    const current = new Map<string, string>();
    const files = this.db.getAllFiles();
    for (const filePath of files) {
      const nodes = this.db.getNodesByFile(filePath);
      for (const node of nodes) {
        current.set(node.id, node.hash ?? this.hashNode(node));
      }
    }

    const addedNodeIds: string[]   = [];
    const removedNodeIds: string[] = [];
    const changedNodeIds: string[] = [];

    // Find added and changed
    for (const [id, hash] of current) {
      if (!baseline.has(id)) {
        addedNodeIds.push(id);
      } else if (baseline.get(id) !== hash) {
        changedNodeIds.push(id);
      }
    }

    // Find removed
    for (const id of baseline.keys()) {
      if (!current.has(id)) {
        removedNodeIds.push(id);
      }
    }

    // Clean up stored baseline
    this.snapshots.delete(runId);

    const snapshot: GraphSnapshot = {
      id: uuid(),
      timestamp: Date.now(),
      agentRunId: runId,
      nodeCount: stats.totalNodes,
      edgeCount: stats.totalEdges,
      changedNodeIds,
      addedNodeIds,
      removedNodeIds,
    };

    this.db.saveSnapshot(snapshot);
    return snapshot;
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  private hashNode(node: GraphNode): string {
    const content = `${node.name}${node.signature ?? ''}${node.line}`;
    return crypto.createHash('sha1').update(content).digest('hex').slice(0, 12);
  }

  formatDiffSummary(snapshot: GraphSnapshot): string {
    const lines: string[] = [
      `Agent run diff (${new Date(snapshot.timestamp).toLocaleTimeString()})`,
      `  Added:   ${snapshot.addedNodeIds.length} symbols`,
      `  Changed: ${snapshot.changedNodeIds.length} symbols`,
      `  Removed: ${snapshot.removedNodeIds.length} symbols`,
      `  Total graph: ${snapshot.nodeCount} nodes, ${snapshot.edgeCount} edges`,
    ];
    return lines.join('\n');
  }
}
