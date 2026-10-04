import * as fs from 'fs';
import * as path from 'path';

// ─── Dependency manifest ──────────────────────────────────────────────────────
// Instead of walking and parsing node_modules (thousands of folders, and the
// results never linked into the graph), CodeLens records only the packages the
// workspace declares directly: one package.json read per dependency. Exports
// are read on demand from a package's type definitions when an agent asks.

export type DependencyKind = 'dependencies' | 'peerDependencies' | 'optionalDependencies' | 'devDependencies';
const DEPENDENCY_FIELDS: DependencyKind[] = ['dependencies', 'peerDependencies', 'optionalDependencies', 'devDependencies'];

export interface PackageInfo {
  name: string;
  declaredRange: string;
  kind: DependencyKind;
  declaredIn: string[];     // package.json files declaring it (absolute)
  installed: boolean;
  version: string | null;   // installed version
  dir: string | null;       // absolute install directory
  types: string | null;     // absolute path of its type definitions entry
  main: string | null;      // absolute path of its main entry
  readme: string | null;    // absolute path of its README
}

const YIELD_INTERVAL_MS = 25;
const yieldToEventLoop = () => new Promise<void>(resolve => setImmediate(resolve));

async function readJson(filePath: string): Promise<any | null> {
  try { return JSON.parse(await fs.promises.readFile(filePath, 'utf-8')); } catch { return null; }
}

function existingFile(filePath: string | null): string | null {
  if (!filePath) { return null; }
  try { return fs.statSync(filePath).isFile() ? filePath : null; } catch { return null; }
}

// Node-style lookup: <dir>/node_modules/<name>, walking up to the workspace root.
function findInstallDir(name: string, fromDir: string, workspaceRoot: string): string | null {
  let dir = fromDir;
  for (;;) {
    const candidate = path.join(dir, 'node_modules', ...name.split('/'));
    if (existingFile(path.join(candidate, 'package.json'))) { return candidate; }
    const rel = path.relative(workspaceRoot, dir);
    const parent = path.dirname(dir);
    if (!rel || rel.startsWith('..') || parent === dir) { return null; }
    dir = parent;
  }
}

function typesEntry(pkg: any, dir: string): string | null {
  const rootExport = pkg.exports?.['.'] ?? pkg.exports;
  const candidates = [
    pkg.types, pkg.typings,
    typeof rootExport === 'object' ? (rootExport?.types ?? rootExport?.import?.types ?? rootExport?.require?.types) : null,
    'index.d.ts',
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string') {
      const found = existingFile(path.join(dir, candidate));
      if (found) { return found; }
    }
  }
  return null;
}

function readmeIn(dir: string): string | null {
  try {
    const entry = fs.readdirSync(dir).find(f => /^readme(\.(md|markdown|txt))?$/i.test(f));
    return entry ? path.join(dir, entry) : null;
  } catch { return null; }
}

// manifests: workspace package.json files (outside node_modules), absolute paths.
export async function readDependencyManifest(workspaceRoot: string, manifests: string[]): Promise<PackageInfo[]> {
  const declared = new Map<string, { range: string; kind: DependencyKind; declaredIn: string[] }>();
  for (const manifest of [...manifests].sort()) {
    const pkg = await readJson(manifest);
    if (!pkg || typeof pkg !== 'object') { continue; }
    for (const kind of DEPENDENCY_FIELDS) {
      const deps = pkg[kind];
      if (!deps || typeof deps !== 'object') { continue; }
      for (const [name, range] of Object.entries(deps)) {
        const entry = declared.get(name);
        if (entry) {
          if (!entry.declaredIn.includes(manifest)) { entry.declaredIn.push(manifest); }
          // Prefer the most "runtime" declaration kind for display.
          if (DEPENDENCY_FIELDS.indexOf(kind) < DEPENDENCY_FIELDS.indexOf(entry.kind)) { entry.kind = kind; entry.range = String(range); }
        } else {
          declared.set(name, { range: String(range), kind, declaredIn: [manifest] });
        }
      }
    }
  }

  const packages: PackageInfo[] = [];
  let lastYield = Date.now();
  for (const [name, decl] of [...declared.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (Date.now() - lastYield > YIELD_INTERVAL_MS) { await yieldToEventLoop(); lastYield = Date.now(); }
    const dir = findInstallDir(name, path.dirname(decl.declaredIn[0]), workspaceRoot);
    const pkg = dir ? await readJson(path.join(dir, 'package.json')) : null;
    let types = dir && pkg ? typesEntry(pkg, dir) : null;
    if (!types && !name.startsWith('@types/')) {
      // Fall back to DefinitelyTyped (@types/scope__name for scoped packages).
      const typesName = '@types/' + (name.startsWith('@') ? name.slice(1).replace('/', '__') : name);
      const typesDir = findInstallDir(typesName, path.dirname(decl.declaredIn[0]), workspaceRoot);
      const typesPkg = typesDir ? await readJson(path.join(typesDir, 'package.json')) : null;
      types = typesDir && typesPkg ? typesEntry(typesPkg, typesDir) : null;
    }
    packages.push({
      name,
      declaredRange: decl.range,
      kind: decl.kind,
      declaredIn: decl.declaredIn,
      installed: !!pkg,
      version: typeof pkg?.version === 'string' ? pkg.version : null,
      dir: pkg ? dir : null,
      types,
      main: dir && pkg ? existingFile(path.join(dir, typeof pkg.main === 'string' ? pkg.main : 'index.js')) : null,
      readme: dir && pkg ? readmeIn(dir) : null,
    });
  }
  return packages;
}

// ── On-demand export listing from a .d.ts entry ──────────────────────────────

export interface DeclaredExport {
  kind: string;   // function, class, interface, type, const, enum, namespace, re-export
  name: string;
  line: number;
}

const MAX_DTS_BYTES = 2_000_000;
const DECLARATION = /^export\s+(?:declare\s+)?(?:default\s+)?(?:abstract\s+)?(function|class|interface|type|const|let|var|enum|namespace)\s+([A-Za-z_$][\w$]*)/;
const NAMED_EXPORTS = /^export\s+(?:type\s+)?\{([^}]*)\}/;
const STAR_EXPORT = /^export\s+\*\s+(?:as\s+([A-Za-z_$][\w$]*)\s+)?from\s+['"]([^'"]+)['"]/;

export function readDeclaredExports(dtsPath: string, limit = 200): DeclaredExport[] {
  let content: string;
  try {
    if (fs.statSync(dtsPath).size > MAX_DTS_BYTES) { return []; }
    content = fs.readFileSync(dtsPath, 'utf-8');
  } catch { return []; }

  const exports: DeclaredExport[] = [];
  const lines = content.split('\n');
  for (let i = 0; i < lines.length && exports.length < limit; i++) {
    const line = lines[i].trim();
    let m = DECLARATION.exec(line);
    if (m) { exports.push({ kind: m[1] === 'let' || m[1] === 'var' ? 'const' : m[1], name: m[2], line: i + 1 }); continue; }
    m = NAMED_EXPORTS.exec(line);
    if (m) {
      for (const part of m[1].split(',')) {
        const name = part.trim().replace(/^type\s+/, '').split(/\s+as\s+/).pop()?.trim();
        if (name) { exports.push({ kind: 'export', name, line: i + 1 }); }
      }
      continue;
    }
    m = STAR_EXPORT.exec(line);
    if (m) { exports.push({ kind: 're-export', name: m[1] ? `${m[1]} (from ${m[2]})` : `* from ${m[2]}`, line: i + 1 }); }
  }
  return exports;
}
