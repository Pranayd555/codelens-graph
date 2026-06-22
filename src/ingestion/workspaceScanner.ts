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

// ─── Hard-coded never-index list ──────────────────────────────────────────────
// These directories/files are NEVER source code regardless of user config.
// Covers: build outputs, package managers, caches, IDE internals, test artefacts,
// generated code, lock files, and dotfile tool directories — across all major
// languages (JS/TS, Python, Go, Rust, Java, C#, Ruby, PHP, Swift, Kotlin)
// and IDEs (VS Code, Cursor, IntelliJ, Xcode, Android Studio, Eclipse).

const ALWAYS_EXCLUDE_DIRS = new Set([
  // ── JavaScript / TypeScript ───────────────────────────────────────────────
  'node_modules',       // npm / yarn / pnpm packages
  '.npm',               // npm cache
  '.yarn',              // yarn cache
  '.pnpm-store',        // pnpm store
  'dist',               // generic build output
  'build',              // generic build output
  'out',                // tsc / webpack output
  'output',             // generic output
  'bundle',             // bundle output
  '.next',              // Next.js build cache
  '.nuxt',              // Nuxt.js build cache
  '.svelte-kit',        // SvelteKit build cache
  '.vite',              // Vite cache
  '.turbo',             // Turborepo cache
  '.vercel',            // Vercel deployment cache
  '.netlify',           // Netlify cache
  'storybook-static',   // Storybook build
  'coverage',           // test coverage reports
  '.nyc_output',        // Istanbul/nyc coverage
  'jest_html_reporters_temp_folder', // Jest HTML reporter
  'playwright-report',  // Playwright test reports
  'test-results',       // Playwright / generic test results
  '.parcel-cache',      // Parcel bundler cache
  '.cache',             // Generic cache (Parcel, Babel, etc.)
  '__pycache__',        // Python bytecode cache
  // ── Angular ───────────────────────────────────────────────────────────────
  '.angular',           // Angular CLI cache (contains cache/ subfolder)
  // ── Python ────────────────────────────────────────────────────────────────
  '.venv',              // Python virtual environment
  'venv',
  'env',
  '.env',               // virtualenv shorthand (also used for dotenv — excluded as dir)
  'site-packages',      // installed Python packages inside venv
  '__pycache__',
  '.pytest_cache',      // pytest cache
  '.mypy_cache',        // mypy type checker cache
  '.ruff_cache',        // ruff linter cache
  '.hypothesis',        // Hypothesis fuzzer database
  'htmlcov',            // coverage.py HTML output
  'dist-info',          // pip package metadata
  'egg-info',           // setuptools egg metadata
  '.eggs',              // setuptools eggs
  'build',              // Python build/ output (also matches JS)
  // ── Go ────────────────────────────────────────────────────────────────────
  'vendor',             // Go modules vendor directory
  // ── Rust ─────────────────────────────────────────────────────────────────
  'target',             // Cargo build output
  // ── Java / Kotlin / Android ───────────────────────────────────────────────
  'target',             // Maven build output (same name as Rust)
  '.gradle',            // Gradle cache
  'gradle',             // Gradle wrapper files (only cache matters but skip whole dir)
  '.m2',                // Maven local repository
  'bin',                // Eclipse / Java compiled classes
  'gen',                // Android generated sources
  '.idea',              // IntelliJ / Android Studio project files
  // ── C# / .NET ────────────────────────────────────────────────────────────
  'obj',                // .NET build intermediates
  'bin',                // .NET build output (same as Java above)
  'packages',           // NuGet packages
  '.vs',                // Visual Studio project state
  // ── Ruby ─────────────────────────────────────────────────────────────────
  '.bundle',            // Bundler config & gems
  // ── PHP / Composer ───────────────────────────────────────────────────────
  'vendor',             // Composer packages (same as Go vendor)
  // ── Swift / Xcode ────────────────────────────────────────────────────────
  '.build',             // Swift Package Manager build
  'DerivedData',        // Xcode derived data
  'xcuserdata',         // Xcode user data
  // ── Version control ──────────────────────────────────────────────────────
  '.git',
  '.hg',                // Mercurial
  '.svn',               // Subversion
  // ── IDE / editor tool directories ────────────────────────────────────────
  '.vscode',            // VS Code project settings (not source)
  '.cursor',            // Cursor IDE settings
  '.trae',              // Trae IDE settings
  '.idea',              // JetBrains IDEs
  '.eclipse',           // Eclipse workspace
  '.settings',          // Eclipse project settings
  '.classpath',         // Eclipse classpath
  // ── Linter / formatter caches ─────────────────────────────────────────────
  '.eslintcache',
  '.stylelintcache',
  '.prettiercache',
  // ── Docker / container ───────────────────────────────────────────────────
  '.docker',
  // ── Miscellaneous generated/downloaded content ────────────────────────────
  '.codelens',          // Our own DB directory
  'tmp',
  'temp',
  '.tmp',
  '.temp',
  'logs',
  '.logs',
]);

// Files that should never be indexed even if extension matches
const ALWAYS_EXCLUDE_FILES = new Set([
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'Gemfile.lock',
  'Podfile.lock',
  'Cargo.lock',
  'composer.lock',
  'go.sum',
  '.DS_Store',
  'Thumbs.db',
  'tsconfig.tsbuildinfo',
  '.eslintcache',
  '.stylelintcache',
]);

// ─── WorkspaceScanner ─────────────────────────────────────────────────────────

export class WorkspaceScanner {
  constructor(private parser: ASTParser, private db: GraphDB) {}

  async scanWorkspace(rootPaths: string[], options: ScanOptions): Promise<ScanResult> {
    const start  = Date.now();
    const result: ScanResult = {
      filesScanned: 0, filesSkipped: 0,
      nodesAdded: 0,   edgesAdded: 0,
      errors: [],      durationMs: 0,
    };

    await this.parser.ensureInit();

    const allFiles    = this.collectFiles(rootPaths, options);
    const total       = allFiles.length;
    const indexedSet  = new Set(allFiles.map(f => path.normalize(f)));

    // Remove stale entries for files that disappeared
    for (const indexed of this.db.getAllFiles()) {
      const belongsToRoot = rootPaths.some(root => {
        const rel = path.relative(root, indexed);
        return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
      });
      if (belongsToRoot && !indexedSet.has(path.normalize(indexed))) {
        this.db.deleteNodesByFile(indexed);
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
      .filter(n => n.type !== 'file' && n.type !== 'import')
      .map(n => n.name);
    this.db.deleteNodesByFile(filePath);
    const parsed = await this.parser.parseFileAsync(filePath);
    if (parsed.nodes.length > 0) {
      this.db.upsertNodes(parsed.nodes);
      this.db.upsertEdges(parsed.edges);
      this.db.upsertCallRefs(parsed.callRefs);
    }
    if (resolveRelationships) {
      const currentSymbols = parsed.nodes
        .filter(n => n.type !== 'file' && n.type !== 'import')
        .map(n => n.name);
      this.db.resolveWorkspaceRelationships(
        filePath,
        [...new Set([...previousSymbols, ...currentSymbols])]
      );
      this.db.persist();
    }
    return parsed;
  }

  // ── File collection ────────────────────────────────────────────────────────

  private collectFiles(rootPaths: string[], options: ScanOptions): string[] {
    const files  = new Array<string>();
    const extSet = new Set(options.supportedExtensions.map(e => e.toLowerCase()));

    // Merge user patterns with the hard-coded never-index set
    const userPatterns = options.excludePatterns;

    for (const root of rootPaths) {
      this.walkDir(root, root, extSet, userPatterns, files);
    }
    return files;
  }

  private walkDir(
    dir: string,
    root: string,
    exts: Set<string>,
    userPatterns: string[],
    results: string[]
  ): void {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { return; }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      const relPath  = path.relative(root, fullPath).replace(/\\/g, '/');

      if (entry.isDirectory()) {
        if (this.shouldExcludeDir(entry.name, relPath, userPatterns)) { continue; }
        this.walkDir(fullPath, root, exts, userPatterns, results);
      } else if (entry.isFile()) {
        if (this.shouldExcludeFile(entry.name, relPath, userPatterns)) { continue; }
        if (exts.has(path.extname(entry.name).toLowerCase())) {
          results.push(fullPath);
        }
      }
    }
  }

  // ── Directory exclusion ────────────────────────────────────────────────────
  // Checks the hard-coded set first (O(1)), then user glob patterns.
  // Handles dotfile dirs (e.g. .angular, .trae) and nested paths.

  private shouldExcludeDir(name: string, relPath: string, userPatterns: string[]): boolean {
    // 1. Hard-coded never-index set — exact directory name match
    if (ALWAYS_EXCLUDE_DIRS.has(name)) { return true; }

    // 2. Dotfile directories — any hidden dir is almost certainly a tool cache
    //    Exception: .github is sometimes needed (but not indexed for code anyway)
    if (name.startsWith('.') && name !== '.github') { return true; }

    // 3. Directories that look like generated/installed content by name pattern
    if (/^__pycache__$|^\.pytest_cache$|^\.mypy_cache$/.test(name)) { return true; }
    if (/^.*[-_](cache|dist|build|generated|gen|out|output|artifacts?)$/i.test(name)) {
      return true;
    }

    // 4. User-provided glob patterns — proper segment matching
    for (const pattern of userPatterns) {
      if (this.matchesGlob(relPath, name, pattern)) { return true; }
    }

    return false;
  }

  // ── File exclusion ─────────────────────────────────────────────────────────

  private shouldExcludeFile(name: string, relPath: string, userPatterns: string[]): boolean {
    // 1. Hard-coded never-index files
    if (ALWAYS_EXCLUDE_FILES.has(name)) { return true; }

    // 2. Minified files — identifiable by .min.js / .min.css etc.
    if (/\.min\.(js|css|mjs)$/.test(name)) { return true; }

    // 3. Generated declaration files that aren't source
    //    (*.d.ts is fine to skip — it's compiled output, not source)
    if (name.endsWith('.d.ts')) { return true; }

    // 4. Map files
    if (name.endsWith('.js.map') || name.endsWith('.css.map')) { return true; }

    // 5. User glob patterns
    for (const pattern of userPatterns) {
      if (this.matchesGlob(relPath, name, pattern)) { return true; }
    }

    return false;
  }

  // ── Proper glob matcher ────────────────────────────────────────────────────
  // Replaces the broken string-strip approach.
  // Supports: **/foo/**, **/foo, foo/**, foo, *.ext

  private matchesGlob(relPath: string, name: string, pattern: string): boolean {
    // Normalise pattern separators
    const p = pattern.replace(/\\/g, '/').replace(/^\/|\/$/g, '');

    // Convert glob to regex
    // 1. Escape regex special chars except * and /
    let regexStr = p
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')   // escape special chars
      .replace(/\*\*\//g, '(?:.+/)?')          // **/ = any depth prefix (optional)
      .replace(/\/\*\*/g, '(?:/.+)?')          // /** = any depth suffix (optional)
      .replace(/\*/g, '[^/]*');                 // * = any single segment chars

    // Anchor: if no ** prefix, match from start or after a /
    if (!p.startsWith('**')) {
      regexStr = '(?:^|/)' + regexStr;
    }

    try {
      const regex = new RegExp(regexStr + '(?:/|$)');
      if (regex.test(relPath)) { return true; }
      // Also match against bare name for patterns like "node_modules"
      if (regex.test(name))    { return true; }
    } catch {
      // Fallback: simple segment inclusion
      const seg = p.replace(/\*/g, '').replace(/\//g, '');
      if (seg && (relPath.includes(seg) || name === seg)) { return true; }
    }

    return false;
  }
}
