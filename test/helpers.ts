import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ASTParser } from '../src/ingestion/astParser';
import { GraphDB } from '../src/graph/graphDB';
import { WorkspaceScanner, ScanOptions } from '../src/ingestion/workspaceScanner';
import { readDependencyManifest } from '../src/ingestion/dependencyManifest';
import { GraphNode } from '../src/types';

export const SCAN_OPTIONS: ScanOptions = {
  excludePatterns: [],
  supportedExtensions: ['.js', '.mjs', '.ts', '.tsx', '.py'],
};

// A throwaway workspace on disk, indexed through the same scanner the
// extension uses.
export class TestWorkspace {
  readonly root = fs.mkdtempSync(path.join(os.tmpdir(), 'codelens-test-'));
  readonly parser = new ASTParser();
  db!: GraphDB;
  scanner!: WorkspaceScanner;

  path(rel: string): string {
    return path.join(this.root, ...rel.split('/'));
  }

  write(rel: string, text: string): string {
    const filePath = this.path(rel);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, text);
    return filePath;
  }

  async open(): Promise<void> {
    this.db = new GraphDB(path.join(this.root, '.codelens'), { followExternalWrites: false });
    await this.db.init();
    this.scanner = new WorkspaceScanner(this.parser, this.db);
  }

  // Full scan, with the dependency manifest loaded first (as on a rescan).
  async scan(options: Partial<ScanOptions> = {}) {
    if (!this.db) { await this.open(); }
    const manifests = fs.existsSync(this.path('package.json')) ? [this.path('package.json')] : [];
    this.db.replacePackages(await readDependencyManifest(this.root, manifests));
    return this.scanner.scanWorkspace({ workspaceRoot: this.root, folders: [] }, { ...SCAN_OPTIONS, ...options });
  }

  node(name: string, fileRel?: string): GraphNode {
    const filePath = fileRel ? path.normalize(this.path(fileRel)) : null;
    const found = this.db.searchNodes(name, 50, 'all')
      .find(n => n.name === name && n.type !== 'import' && (!filePath || path.normalize(n.filePath) === filePath));
    if (!found) { throw new Error(`node ${name}${fileRel ? ' in ' + fileRel : ''} not found`); }
    return found;
  }

  // Call targets of a symbol, as "name@relative/path".
  callsFrom(name: string, fileRel?: string): string[] {
    return this.db.getEdgesFrom(this.node(name, fileRel).id, 'calls').map(edge => {
      const target = this.db.getNode(edge.toId);
      return target ? `${target.name}@${path.relative(this.root, target.filePath).split(path.sep).join('/')}` : edge.toId;
    });
  }

  close(): void {
    this.db?.close();
    try { fs.rmSync(this.root, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}
