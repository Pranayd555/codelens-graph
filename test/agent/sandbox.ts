import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// Points os.homedir() at a throwaway directory (HOME on POSIX, USERPROFILE on
// Windows) so code that writes under ~/.codelens never touches the real home.
export class FakeHome {
  readonly root = fs.mkdtempSync(path.join(os.tmpdir(), 'codelens-agent-home-'));
  private readonly saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };

  constructor() {
    process.env.HOME = this.root;
    process.env.USERPROFILE = this.root;
    if (path.resolve(os.homedir()) !== path.resolve(this.root)) {
      throw new Error(`os.homedir() did not follow the fake home (${os.homedir()})`);
    }
  }

  path(rel: string): string {
    return path.join(this.root, ...rel.split('/'));
  }

  write(rel: string, text: string): string {
    const filePath = this.path(rel);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, text);
    return filePath;
  }

  restore(): void {
    for (const [key, value] of Object.entries(this.saved)) {
      if (value === undefined) { delete process.env[key]; } else { process.env[key] = value; }
    }
    fs.rmSync(this.root, { recursive: true, force: true });
  }
}

export function read(filePath: string): string {
  return fs.readFileSync(filePath, 'utf-8');
}

// Files under dir, '/'-separated and relative to it, sorted.
export function listTree(dir: string): string[] {
  const out: string[] = [];
  const walk = (abs: string, rel: string) => {
    for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) { walk(path.join(abs, entry.name), childRel); } else { out.push(childRel); }
    }
  };
  walk(dir, '');
  return out.sort();
}
