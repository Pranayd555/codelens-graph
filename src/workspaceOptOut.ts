import * as fs   from 'fs';
import * as os   from 'os';
import * as path from 'path';

// Workspaces where the user turned CodeLens off (answered "No" or used "Turn Off").
// The extension's own source of truth is VS Code's per-workspace state; this
// per-user file (never inside the project) lets the standalone MCP server honor
// the same choice, e.g. when an agent with a global MCP config runs there.

const optOutPath = () => path.join(os.homedir(), '.codelens', 'disabled-workspaces.json');

const normalize = (p: string) => {
  const resolved = path.resolve(p);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
};

function readDisabled(): string[] {
  try {
    const list = JSON.parse(fs.readFileSync(optOutPath(), 'utf-8')).workspaces;
    return Array.isArray(list) ? list.filter((p: unknown): p is string => typeof p === 'string') : [];
  } catch {
    return [];
  }
}

export function setWorkspaceDisabled(workspaceRoot: string, disabled: boolean): void {
  const key  = normalize(workspaceRoot);
  const list = readDisabled().filter(p => normalize(p) !== key);
  if (disabled) { list.push(path.resolve(workspaceRoot)); }
  else if (!fs.existsSync(optOutPath())) { return; }
  try {
    fs.mkdirSync(path.dirname(optOutPath()), { recursive: true });
    fs.writeFileSync(optOutPath(), JSON.stringify({ workspaces: list }, null, 2), 'utf-8');
  } catch (err) {
    console.error('[CodeLens] Failed to record the workspace on/off choice:', err);
  }
}

// The turned-off workspace that contains dir (or is dir), if any.
export function findDisabledWorkspace(dir: string): string | undefined {
  const target = normalize(dir);
  return readDisabled().find(p => {
    const root = normalize(p);
    return target === root || target.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
  });
}
