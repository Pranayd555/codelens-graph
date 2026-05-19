import * as fs from 'fs';
import * as path from 'path';
import { ASTParser } from './astParser';
import { GraphDB } from './graphDB';
import { ParsedFile } from './types';

export interface ScanResult {
  filesScanned: number;
  filesSkipped: number;
  nodesAdded: number;
  edgesAdded: number;
  errors: string[];
  durationMs: number;
}

export interface ScanOptions {
  excludePatterns: string[];
  supportedExtensions: string[];
  onProgress?: (current: number, total: number, filePath: string) => void;
}

// ─── WorkspaceScanner ──────────────────────────────────────────────────────────

export class WorkspaceScanner {
  constructor(
    private parser: ASTParser,
    private db: GraphDB
  ) {}

  // ── Full workspace scan ────────────────────────────────────────────────────
  // Walks every file in the workspace, parses it, writes to DB.

  async scanWorkspace(rootPaths: string[], options: ScanOptions): Promise<ScanResult> {
    const start = Date.now();
    const result: ScanResult = { filesScanned: 0, filesSkipped: 0, nodesAdded: 0, edgesAdded: 0, errors: [], durationMs: 0 };

    // Collect all candidate files
    const allFiles = this.collectFiles(rootPaths, options);
    const total = allFiles.length;

    for (let i = 0; i < allFiles.length; i++) {
      const filePath = allFiles[i];
      options.onProgress?.(i + 1, total, filePath);

      try {
        const parsed = this.parser.parseFile(filePath);
        if (parsed.parseErrors.length > 0) {
          result.errors.push(...parsed.parseErrors);
        }

        if (parsed.nodes.length > 0) {
          this.db.upsertNodes(parsed.nodes);
          this.db.upsertEdges(parsed.edges);
          result.nodesAdded += parsed.nodes.length;
          result.edgesAdded += parsed.edges.length;
          result.filesScanned++;
        } else {
          result.filesSkipped++;
        }
      } catch (err) {
        result.errors.push(`${filePath}: ${err}`);
        result.filesSkipped++;
      }
    }

    this.db.persist();
    result.durationMs = Date.now() - start;
    return result;
  }

  // ── Incremental update ─────────────────────────────────────────────────────
  // Called when a single file changes. Re-parses just that file.

  async updateFile(filePath: string): Promise<ParsedFile> {
    // Remove old data for this file
    this.db.deleteNodesByFile(filePath);

    // Re-parse
    const parsed = this.parser.parseFile(filePath);
    if (parsed.nodes.length > 0) {
      this.db.upsertNodes(parsed.nodes);
      this.db.upsertEdges(parsed.edges);
    }

    this.db.persist();
    return parsed;
  }

  // ── File collection ────────────────────────────────────────────────────────

  private collectFiles(rootPaths: string[], options: ScanOptions): string[] {
    const files: string[] = [];
    const extSet = new Set(options.supportedExtensions.map(e => e.toLowerCase()));

    for (const rootPath of rootPaths) {
      this.walkDir(rootPath, rootPath, extSet, options.excludePatterns, files);
    }

    return files;
  }

  private walkDir(
    dir: string,
    root: string,
    extensions: Set<string>,
    excludePatterns: string[],
    results: string[]
  ): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      const relPath  = path.relative(root, fullPath);

      if (this.shouldExclude(relPath, entry.name, excludePatterns)) { continue; }

      if (entry.isDirectory()) {
        this.walkDir(fullPath, root, extensions, excludePatterns, results);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (extensions.has(ext)) {
          results.push(fullPath);
        }
      }
    }
  }

  private shouldExclude(relPath: string, name: string, patterns: string[]): boolean {
    // Simple glob-like matching for the most common patterns
    for (const pattern of patterns) {
      const clean = pattern.replace(/\*\*/g, '').replace(/\*/g, '').replace(/\//g, '');

      if (pattern.includes('**')) {
        // Match any segment
        const segment = pattern.replace(/\*\*\//g, '').replace(/\/\*\*/g, '').replace(/\*/g, '');
        if (relPath.includes(segment) || name === segment) { return true; }
      } else if (pattern.startsWith('*')) {
        // Extension match
        const ext = pattern.slice(1);
        if (name.endsWith(ext)) { return true; }
      } else {
        if (name === clean || relPath === clean) { return true; }
      }
    }
    return false;
  }
}
