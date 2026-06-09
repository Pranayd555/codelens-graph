import * as fs   from 'fs';
import * as path from 'path';
import { ASTParser } from './astParser';
import { GraphDB }   from '../graph/graphDB';
import { ParsedFile } from '../types';

export interface ScanOptions {
  excludePatterns:     string[];
  supportedExtensions: string[];
  onProgress?:         (current: number, total: number, filePath: string) => void;
}

export interface ScanResult {
  filesScanned:  number;
  filesSkipped:  number;
  nodesAdded:    number;
  edgesAdded:    number;
  errors:        string[];
  durationMs:    number;
}

export class WorkspaceScanner {
  constructor(private parser: ASTParser, private db: GraphDB) {}

  async scanWorkspace(rootPaths: string[], options: ScanOptions): Promise<ScanResult> {
    const start  = Date.now();
    const result: ScanResult = { filesScanned: 0, filesSkipped: 0, nodesAdded: 0, edgesAdded: 0, errors: [], durationMs: 0 };

    // Ensure tree-sitter is initialised before scanning
    await this.parser.ensureInit();

    const allFiles = this.collectFiles(rootPaths, options);
    const total    = allFiles.length;
    const indexedFiles = new Set(allFiles.map(filePath => path.normalize(filePath)));

    // Remove files that disappeared since the previous full scan.
    for (const indexedFile of this.db.getAllFiles()) {
      const belongsToScannedRoot = rootPaths.some(root => {
        const relative = path.relative(root, indexedFile);
        return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
      });
      if (belongsToScannedRoot && !indexedFiles.has(path.normalize(indexedFile))) {
        this.db.deleteNodesByFile(indexedFile);
      }
    }

    for (let i = 0; i < allFiles.length; i++) {
      const filePath = allFiles[i];
      options.onProgress?.(i + 1, total, filePath);

      try {
        const parsed = await this.parser.parseFileAsync(filePath);
        if (parsed.parseErrors.length) { result.errors.push(...parsed.parseErrors); }

        if (parsed.nodes.length > 0) {
          this.db.deleteNodesByFile(filePath);
          this.db.upsertNodes(parsed.nodes);
          this.db.upsertEdges(parsed.edges);
          this.db.upsertCallRefs(parsed.callRefs);
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

    this.db.resolveWorkspaceRelationships();
    this.db.persist();
    result.edgesAdded = this.db.getStats().totalEdges;
    result.durationMs = Date.now() - start;
    return result;
  }

  async updateFile(filePath: string, resolveRelationships = true): Promise<ParsedFile> {
    await this.parser.ensureInit();
    const previousSymbols = this.db.getNodesByFile(filePath)
      .filter(node => node.type !== 'file' && node.type !== 'import')
      .map(node => node.name);
    this.db.deleteNodesByFile(filePath);
    const parsed = await this.parser.parseFileAsync(filePath);
    if (parsed.nodes.length > 0) {
      this.db.upsertNodes(parsed.nodes);
      this.db.upsertEdges(parsed.edges);
      this.db.upsertCallRefs(parsed.callRefs);
    }
    if (resolveRelationships) {
      const currentSymbols = parsed.nodes
        .filter(node => node.type !== 'file' && node.type !== 'import')
        .map(node => node.name);
      this.db.resolveWorkspaceRelationships(
        filePath,
        [...new Set([...previousSymbols, ...currentSymbols])]
      );
      this.db.persist();
    }
    return parsed;
  }

  private collectFiles(rootPaths: string[], options: ScanOptions): string[] {
    const files  = new Array<string>();
    const extSet = new Set(options.supportedExtensions.map(e => e.toLowerCase()));
    for (const root of rootPaths) {
      this.walkDir(root, root, extSet, options.excludePatterns, files);
    }
    return files;
  }

  private walkDir(dir: string, root: string, exts: Set<string>, excludes: string[], results: string[]): void {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { return; }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      const relPath  = path.relative(root, fullPath);

      if (this.shouldExclude(relPath, entry.name, excludes)) { continue; }

      if (entry.isDirectory()) {
        this.walkDir(fullPath, root, exts, excludes, results);
      } else if (entry.isFile() && exts.has(path.extname(entry.name).toLowerCase())) {
        results.push(fullPath);
      }
    }
  }

  private shouldExclude(relPath: string, name: string, patterns: string[]): boolean {
    for (const pattern of patterns) {
      const seg = pattern.replace(/\*\*\//g, '').replace(/\/\*\*/g, '').replace(/\*/g, '').replace(/\//g, '');
      if (relPath.includes(seg) || name === seg) { return true; }
    }
    return false;
  }
}
