import * as path from 'path';

// ─── Index scope ──────────────────────────────────────────────────────────────
// Which parts of the workspace CodeLens indexes, from the
// `codeLensGraph.includeFolders` setting. An empty folder list means the whole
// workspace. Files directly in the workspace root (package.json, tsconfig.json,
// top-level scripts) are always in scope, so the dependency manifest and
// project configuration stay available whatever the selection.

export interface IndexScope {
  workspaceRoot: string;
  // Workspace-relative, '/'-separated, no overlaps (an entry never sits inside another).
  folders: string[];
}

const caseInsensitive = process.platform === 'win32';
const key = (p: string) => (caseInsensitive ? p.toLowerCase() : p);

const isWithin = (child: string, parent: string) =>
  key(child) === key(parent) || key(child).startsWith(key(parent) + '/');

// Cleans the raw setting value. '.' (or an empty list) means the whole workspace;
// absolute paths and paths escaping the workspace are ignored.
export function normalizeFolders(raw: unknown): string[] {
  if (!Array.isArray(raw)) { return []; }
  const entries = raw
    .filter((f): f is string => typeof f === 'string')
    .map(f => f.trim().replace(/\\/g, '/').replace(/^(\.\/)+/, '').replace(/\/+$/, ''))
    .filter(f => f !== '');
  if (entries.includes('.')) { return []; }
  const valid = entries.filter(f => !path.isAbsolute(f) && !/^[a-zA-Z]:/.test(f) && !f.split('/').includes('..'));
  const firstSpelling = new Map<string, string>();
  for (const f of valid) { if (!firstSpelling.has(key(f))) { firstSpelling.set(key(f), f); } }
  const unique = [...firstSpelling.values()].sort();
  return unique.filter(f => !unique.some(other => other !== f && isWithin(f, other)));
}

// Absolute directories to walk recursively.
export function scopeRoots(scope: IndexScope): string[] {
  return scope.folders.length
    ? scope.folders.map(f => path.join(scope.workspaceRoot, ...f.split('/')))
    : [scope.workspaceRoot];
}

export function relativeToWorkspace(filePath: string, workspaceRoot: string): string | null {
  const rel = path.relative(workspaceRoot, filePath);
  if (!rel || rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) { return null; }
  return rel.split(path.sep).join('/');
}

export function isInScope(filePath: string, scope: IndexScope): boolean {
  const rel = relativeToWorkspace(filePath, scope.workspaceRoot);
  if (rel === null) { return false; }
  if (!scope.folders.length) { return true; }
  if (!rel.includes('/')) { return true; } // directly in the workspace root
  return scope.folders.some(folder => isWithin(rel, folder));
}

// Whether a folder (workspace-relative) is fully indexed: it or an ancestor is selected.
export function isFolderIncluded(folder: string, folders: string[]): boolean {
  return !folders.length || folders.some(selected => isWithin(folder, selected));
}

// Whether some, but not all, of a folder is indexed (a descendant is selected).
export function isFolderPartiallyIncluded(folder: string, folders: string[]): boolean {
  return !isFolderIncluded(folder, folders) && folders.some(selected => isWithin(selected, folder));
}

// The include list after the user checks or unchecks one folder.
// Unchecking a folder whose ancestor is selected (or the whole workspace)
// replaces that ancestor with its other children, level by level, so only the
// unchecked branch drops out. Returns null if that would leave nothing selected.
export function toggleFolder(
  folders: string[],
  folder: string,
  include: boolean,
  listChildFolders: (relDir: string) => string[]
): string[] | null {
  const target = normalizeFolders([folder])[0];
  if (!target) { return folders; }

  if (include) {
    if (isFolderIncluded(target, folders)) { return folders; }
    return normalizeFolders([...folders, target]);
  }

  // Unchecking: drop the folder itself and anything selected inside it.
  const withoutTarget = folders.filter(f => !isWithin(f, target));
  const ancestor = folders.length
    ? folders.find(f => f !== target && isWithin(target, f))
    : '';
  if (ancestor === undefined) {
    return withoutTarget.length ? withoutTarget : null;
  }

  // Expand the covering ancestor ('' = workspace root) down to the target's siblings.
  const replacement: string[] = [];
  const steps = target.slice(ancestor ? ancestor.length + 1 : 0).split('/');
  let level = ancestor;
  for (const step of steps) {
    const next = level ? `${level}/${step}` : step;
    for (const child of listChildFolders(level)) {
      const childPath = level ? `${level}/${child}` : child;
      if (key(childPath) !== key(next)) { replacement.push(childPath); }
    }
    level = next;
  }
  const result = normalizeFolders([...withoutTarget.filter(f => f !== ancestor), ...replacement]);
  return result.length ? result : null;
}

// Folders worth suggesting when the user first picks: common source roots, and
// the packages inside monorepo container folders.
const SOURCE_ROOT_NAMES = new Set([
  'src', 'lib', 'app', 'server', 'client', 'web', 'api', 'backend', 'frontend',
  'components', 'pages', 'cmd', 'internal', 'pkg', 'core', 'shared', 'common',
]);
export const CONTAINER_FOLDER_NAMES = new Set(['apps', 'packages', 'libs', 'services', 'modules', 'projects', 'plugins']);

export function suggestFolders(topLevelFolders: string[], listChildFolders: (relDir: string) => string[]): string[] {
  const suggestions: string[] = [];
  for (const folder of topLevelFolders) {
    if (CONTAINER_FOLDER_NAMES.has(folder.toLowerCase())) {
      suggestions.push(...listChildFolders(folder).map(child => `${folder}/${child}`));
    } else if (SOURCE_ROOT_NAMES.has(folder.toLowerCase())) {
      suggestions.push(folder);
    }
  }
  return normalizeFolders(suggestions);
}

// Counts files per folder prefix (every ancestor folder of each file).
export function countFilesByFolder(files: string[], workspaceRoot: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const file of files) {
    const rel = relativeToWorkspace(file, workspaceRoot);
    if (!rel) { continue; }
    const parts = rel.split('/');
    let prefix = '';
    for (let i = 0; i < parts.length - 1; i++) {
      prefix = prefix ? `${prefix}/${parts[i]}` : parts[i];
      counts.set(key(prefix), (counts.get(key(prefix)) ?? 0) + 1);
    }
  }
  return counts;
}

export function folderCount(counts: Map<string, number>, folder: string): number {
  return counts.get(key(folder)) ?? 0;
}
