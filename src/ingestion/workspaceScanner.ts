import * as fs   from 'fs';
import * as path from 'path';
import { ASTParser } from './astParser';
import { GraphDB }   from '../graph/graphDB';
import { ParsedFile } from '../types';
import { isConfigPath, isNodeModulePath, matchPathFilter } from '../utils';
import { TextIndex } from '../indexing/textIndex';
import { IndexScope, scopeRoots, isInScope, relativeToWorkspace } from './indexScope';

export interface ScanOptions {
  excludePatterns:        string[];
  supportedExtensions:    string[];
  onProgress?:            (current: number, total: number, filePath: string) => void;
  force?:                 boolean;
}

// Config files that are indexed (as file nodes, without symbol parsing) even
// when their extension isn't in supportedExtensions.
const CONFIG_EXTS = new Set(['.json', '.md', '.yml', '.yaml', '.js', '.ts', '.tsx', '.jsx', '.json5', '.toml']);

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

// The extension host is one thread shared by every extension, so long scans
// hand control back this often to keep other extensions responsive.
const YIELD_INTERVAL_MS = 25;
const yieldToEventLoop = () => new Promise<void>(resolve => setImmediate(resolve));

// Folder names that are never walked into on their own (build output, caches,
// tool and VCS folders). A folder the user explicitly selects is still indexed.
export function isSkippedDirectoryName(name: string): boolean {
  if (name === 'node_modules') { return true; }
  if (ALWAYS_EXCLUDE_DIRS.has(name)) { return true; }
  // Hidden folders are almost always tool caches; .github is the exception.
  if (name.startsWith('.') && name !== '.github') { return true; }
  if (/^__pycache__$|^\.pytest_cache$|^\.mypy_cache$/.test(name)) { return true; }
  return /^.*[-_](cache|dist|build|generated|gen|out|output|artifacts?)$/i.test(name);
}

export class WorkspaceScanner {
  private textIndex: TextIndex;
  constructor(private parser: ASTParser, private db: GraphDB) {
    this.textIndex = new TextIndex(db);
  }

  // Brings the graph in line with the scope: parses new/changed files in scope
  // and drops indexed files that are gone or no longer in scope (e.g. a
  // deselected folder). Unchanged files are skipped, so a scope change only
  // costs the folders that were added or removed.
  async scanWorkspace(scope: IndexScope, options: ScanOptions): Promise<ScanResult> {
    const start  = Date.now();
    const result: ScanResult = {
      filesScanned: 0, filesSkipped: 0,
      nodesAdded: 0,   edgesAdded: 0,
      errors: [],      durationMs: 0,
    };

    await this.parser.ensureInit();

    const allFiles    = await this.listFiles(scope, options);
    const total       = allFiles.length;
    const indexedSet  = new Set(allFiles.map(f => path.normalize(f)));

    // Drop files that disappeared or fell out of scope (including node_modules
    // entries written by older versions).
    let removedStale = false;
    let lastStaleYield = Date.now();
    for (const indexed of this.db.getAllFiles('all')) {
      if (Date.now() - lastStaleYield > YIELD_INTERVAL_MS) {
        await yieldToEventLoop();
        lastStaleYield = Date.now();
      }
      if (relativeToWorkspace(indexed, scope.workspaceRoot) === null) { continue; }
      if (!indexedSet.has(path.normalize(indexed))) {
        if (this.db.deleteNodesByFile(indexed)) { removedStale = true; }
      }
    }

    const fileNodes = this.db.getNodesByType('file');
    const fileNodeMap = new Map<string, any>();
    for (const node of fileNodes) {
      fileNodeMap.set(path.normalize(node.filePath), node);
    }

    let lastPersistTime = Date.now();
    let unsavedChanges = removedStale;
    let lastYield = Date.now();

    for (let i = 0; i < allFiles.length; i++) {
      if (Date.now() - lastYield > YIELD_INTERVAL_MS) {
        await yieldToEventLoop();
        lastYield = Date.now();
      }
      const filePath = allFiles[i];
      options.onProgress?.(i + 1, total, filePath);

      try {
        let fileStat: fs.Stats;
        try {
          fileStat = fs.statSync(filePath);
        } catch (e) {
          result.errors.push(`${filePath}: Stat failed: ${e}`);
          result.filesSkipped++;
          continue;
        }

        const existingFile = fileNodeMap.get(path.normalize(filePath));
        const isUnmodified = existingFile && existingFile.size === fileStat.size && existingFile.lastModified === fileStat.mtimeMs;
        if (!options.force && isUnmodified) {
          result.filesSkipped++;
          continue;
        }

        const parsed = await this.parser.parseFileAsync(filePath);
        if (parsed.parseErrors.length) { result.errors.push(...parsed.parseErrors); }

        const hadNodes = this.db.deleteNodesByFile(filePath);

        if (parsed.nodes.length > 0) {
          this.db.upsertNodes(parsed.nodes);
          this.db.upsertEdges(parsed.edges);
          this.db.upsertCallRefs(parsed.callRefs);
          if (!isNodeModulePath(filePath)) {
            await this.textIndex.buildForFile(filePath, parsed.language);
          }
          result.nodesAdded += parsed.nodes.length;
          result.edgesAdded += parsed.edges.length;
          result.filesScanned++;
          unsavedChanges = true;
        } else {
          // Empty or unparseable file: re-checked every scan, but only a real
          // removal (it used to have symbols) counts as a change.
          result.filesScanned++;
          if (hadNodes) { unsavedChanges = true; }
        }
      } catch (err) {
        result.errors.push(`${filePath}: ${err}`);
        result.filesSkipped++;
      }

      if (unsavedChanges && (Date.now() - lastPersistTime > 30000)) {
        try {
          this.db.persist();
          lastPersistTime = Date.now();
          unsavedChanges = false;
        } catch (err) {
          result.errors.push(`Intermediate persist failed: ${err}`);
        }
      }
    }

    // Resolving relationships and rewriting the whole DB are the most expensive
    // steps, so skip both when the scan changed nothing (the common startup case).
    if (this.db.needsRelationshipResolve() || unsavedChanges) {
      try {
        await this.db.resolveWorkspaceRelationships();
        this.db.persist();
      } catch (err) {
        result.errors.push(`Final persist failed: ${err}`);
      }
    }
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
      if (!isNodeModulePath(filePath)) {
        await this.textIndex.buildForFile(filePath, parsed.language);
      }
    }
    if (resolveRelationships) {
      const currentSymbols = parsed.nodes
        .filter(n => n.type !== 'file' && n.type !== 'import')
        .map(n => n.name);
      await this.db.resolveWorkspaceRelationships(
        filePath,
        [...new Set([...previousSymbols, ...currentSymbols])]
      );
      this.db.persist();
    }
    return parsed;
  }

  isFileAllowed(filePath: string, scope: IndexScope, options: ScanOptions): boolean {
    const workspaceRoot = scope.workspaceRoot;
    const absolutePath = path.isAbsolute(filePath) ? filePath : path.resolve(workspaceRoot, filePath);
    if (!isInScope(absolutePath, scope) || isNodeModulePath(absolutePath)) { return false; }
    const ext = path.extname(absolutePath).toLowerCase();
    const filename = path.basename(absolutePath);
    const relPath = path.relative(workspaceRoot, absolutePath).replace(/\\/g, '/');

    if (ALWAYS_EXCLUDE_FILES.has(filename)) { return false; }

    for (const pattern of options.excludePatterns) {
      if (this.matchesGlob(relPath, filename, pattern)) { return false; }
    }

    const isConfig = isConfigPath(absolutePath);

    if (isConfig && CONFIG_EXTS.has(ext)) {
      return true;
    }

    const extSet = new Set(options.supportedExtensions.map(e => e.toLowerCase()));
    if (!extSet.has(ext)) { return false; }

    // Folder-name excludes apply below the selected folders, not to the
    // folders the user explicitly chose.
    const selectedRoot = scope.folders
      .map(f => f.toLowerCase())
      .find(f => relPath.toLowerCase().startsWith(f + '/')) ?? '';
    const segments = relPath.split('/');
    let currentRelPath = '';
    for (let i = 0; i < segments.length - 1; i++) {
      const segment = segments[i];
      currentRelPath = currentRelPath ? `${currentRelPath}/${segment}` : segment;
      if (currentRelPath.length <= selectedRoot.length) { continue; }
      if (this.shouldExcludeDir(segment, currentRelPath, options.excludePatterns)) {
        return false;
      }
    }

    return true;
  }

  // ── File collection ────────────────────────────────────────────────────────

  // Every indexable file in scope: the selected folders (recursively) plus files
  // directly in the workspace root. Never descends into node_modules.
  async listFiles(scope: IndexScope, options: ScanOptions): Promise<string[]> {
    const files  = new Array<string>();
    const extSet = new Set(options.supportedExtensions.map(e => e.toLowerCase()));
    const userPatterns = options.excludePatterns;

    for (const root of scopeRoots(scope)) {
      await this.walkDir(root, scope.workspaceRoot, extSet, userPatterns, files, true);
    }
    if (scope.folders.length) {
      await this.walkDir(scope.workspaceRoot, scope.workspaceRoot, extSet, userPatterns, files, false);
    }
    return files;
  }

  // workspaceRoot is used for workspace-relative exclude matching; the walk
  // itself starts at dir.
  private async walkDir(
    dir: string,
    workspaceRoot: string,
    exts: Set<string>,
    userPatterns: string[],
    results: string[],
    recursive: boolean
  ): Promise<void> {
    let entries: fs.Dirent[];
    try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); }
    catch { return; }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      const relPath  = path.relative(workspaceRoot, fullPath).replace(/\\/g, '/');

      if (entry.isDirectory()) {
        if (!recursive || entry.name === 'node_modules') { continue; }
        if (this.shouldExcludeDir(entry.name, relPath, userPatterns)) { continue; }
        await this.walkDir(fullPath, workspaceRoot, exts, userPatterns, results, true);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        const isConfig = isConfigPath(fullPath) && CONFIG_EXTS.has(ext);
        if (this.shouldExcludeFile(entry.name, relPath, userPatterns) && !isConfig) { continue; }
        if (exts.has(ext) || isConfig) {
          results.push(fullPath);
        }
      }
    }
  }

  // ── Directory exclusion ────────────────────────────────────────────────────
  // Checks the hard-coded set first (O(1)), then user glob patterns.
  // Handles dotfile dirs (e.g. .angular, .trae) and nested paths.

  private shouldExcludeDir(name: string, relPath: string, userPatterns: string[]): boolean {
    if (isSkippedDirectoryName(name)) { return true; }

    // User-provided glob patterns. A directory matches if the pattern matches
    // its path or anything inside it (e.g. "**/generated/**" for "src/generated").
    for (const pattern of userPatterns) {
      if (this.matchesGlob(relPath, name, pattern) || matchPathFilter(relPath + '/', pattern)) { return true; }
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
    return matchPathFilter(relPath, pattern) || matchPathFilter(name, pattern);
  }
}
