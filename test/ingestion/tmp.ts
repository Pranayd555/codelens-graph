import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// A bare temp directory (no graph DB) for tests that only need files on disk.
export class TempDir {
  readonly root = fs.mkdtempSync(path.join(os.tmpdir(), 'codelens-ingest-'));

  path(rel = ''): string {
    return rel ? path.join(this.root, ...rel.split('/')) : this.root;
  }

  write(rel: string, text: string): string {
    const filePath = this.path(rel);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, text);
    return filePath;
  }

  writeJson(rel: string, value: unknown): string {
    return this.write(rel, JSON.stringify(value, null, 2));
  }

  mkdir(rel: string): string {
    const dir = this.path(rel);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  remove(): void {
    try { fs.rmSync(this.root, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

// Workspace-relative, '/'-separated, sorted — for comparing file lists.
export function rel(root: string, files: string[]): string[] {
  return files.map(f => path.relative(root, f).split(path.sep).join('/')).sort();
}
