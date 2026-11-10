import * as fs   from 'fs';
import * as path from 'path';
import { GraphNode } from '../types';
import { isPathInside } from '../utils';

// Builds "how to import this symbol" hints for agents, in the syntax the
// importing code actually uses: `import { x } from …` for ES modules and
// TypeScript, `const { x } = require(…)` for CommonJS.

export type ModuleSystem = 'esm' | 'cjs';

const JS_LANGUAGES = new Set(['javascript', 'typescript', 'tsx']);
const SOURCE_EXTENSIONS = /\.(ts|tsx|js|jsx|mjs|cjs|mts|cts|py)$/;

// Only the top of a file is needed to see how it imports.
const HEAD_BYTES = 16 * 1024;
const MAX_CACHED = 500;
const moduleSystemCache = new Map<string, { mtimeMs: number; system: ModuleSystem }>();
const packageTypeCache = new Map<string, ModuleSystem | null>();

function readHead(filePath: string): string | null {
  let fd: number | undefined;
  try {
    fd = fs.openSync(filePath, 'r');
    const buffer = Buffer.alloc(HEAD_BYTES);
    const bytes = fs.readSync(fd, buffer, 0, HEAD_BYTES, 0);
    return buffer.toString('utf-8', 0, bytes);
  } catch {
    return null;
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* ignore */ } }
  }
}

// "type" of the nearest package.json at or above dir, up to the workspace root.
function packageType(dir: string, workspaceRoot: string): ModuleSystem | null {
  const cached = packageTypeCache.get(dir);
  if (cached !== undefined) { return cached; }
  let result: ModuleSystem | null = null;
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf-8'));
    result = pkg.type === 'module' ? 'esm' : 'cjs';
  } catch {
    const parent = path.dirname(dir);
    result = parent !== dir && isPathInside(parent, workspaceRoot) ? packageType(parent, workspaceRoot) : null;
  }
  packageTypeCache.set(dir, result);
  return result;
}

// How a JS/TS file imports: from its own import statements first, then its
// extension, then the nearest package.json "type". Files are only read inside
// the workspace (DB paths could come from a pre-built index).
export function detectModuleSystem(filePath: string, workspaceRoot: string | null): ModuleSystem {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.mjs' || ext === '.mts') { return 'esm'; }
  if (ext === '.cjs') { return 'cjs'; }
  if (!workspaceRoot || !isPathInside(filePath, workspaceRoot)) { return 'esm'; }

  let mtimeMs = 0;
  try { mtimeMs = fs.statSync(filePath).mtimeMs; } catch { return 'esm'; }
  const cached = moduleSystemCache.get(filePath);
  if (cached && cached.mtimeMs === mtimeMs) { return cached.system; }

  let system: ModuleSystem;
  const head = readHead(filePath) ?? '';
  if (/^\s*(?:import\s+(?!\()|export\s)/m.test(head)) {
    system = 'esm';
  } else if (/\brequire\s*\(\s*['"`]|\bmodule\.exports\b|\bexports\.[A-Za-z_$][\w$]*\s*=/.test(head)) {
    system = 'cjs';
  } else if (ext === '.ts' || ext === '.tsx' || ext === '.cts') {
    system = 'esm';   // TypeScript syntax is import/export either way
  } else {
    system = packageType(path.dirname(filePath), workspaceRoot) ?? 'esm';
  }

  if (moduleSystemCache.size >= MAX_CACHED) { moduleSystemCache.clear(); }
  moduleSystemCache.set(filePath, { mtimeMs, system });
  return system;
}

export function importSpecifier(targetFile: string, fromDir: string): string {
  let rel = path.relative(fromDir, targetFile).replace(/\\/g, '/').replace(SOURCE_EXTENSIONS, '');
  if (!rel.startsWith('.')) { rel = './' + rel; }
  return rel;
}

// An import statement for node, as written by a file in `language` that uses
// the given module system. Null for languages without a useful hint.
export function formatImport(node: GraphNode, specifier: string, language: string, system: ModuleSystem): string | null {
  const name = node.name;
  if (JS_LANGUAGES.has(language)) {
    const isDefault = node.modifiers?.includes('default');
    if (system === 'cjs') {
      return isDefault ? `const ${name} = require('${specifier}');` : `const { ${name} } = require('${specifier}');`;
    }
    return isDefault ? `import ${name} from '${specifier}';` : `import { ${name} } from '${specifier}';`;
  }
  if (language === 'python') {
    return `from ${specifier.replace(/^\.\//, '').replace(/\//g, '.')} import ${name}`;
  }
  return null;
}
