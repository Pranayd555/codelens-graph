import * as path from 'path';
import * as fs   from 'fs';
import * as os   from 'os';
import { GraphDB }        from '../graph/graphDB';
import { ASTParser }      from '../ingestion/astParser';
import { WorkspaceScanner } from '../ingestion/workspaceScanner';
import { ContextBuilder } from '../context/contextBuilder';
import { FileClassifier } from '../context/fileClassifier';
import { MCPLogger }      from './mcpLogger';
import { GraphNode }      from '../types';
import {
  isConfigPath, isNodeModulePath, matchPathFilter, isPathInside, compileSearchRegex, regexTestCapped
} from '../utils';
import { TextIndex, TextEntry } from '../indexing/textIndex';
import { IndexScope, normalizeFolders } from '../ingestion/indexScope';
import { readDependencyManifest, readDeclaredExports } from '../ingestion/dependencyManifest';

const DEFAULT_LARGE_WORKSPACE_THRESHOLD = 5000;

// Reads CodeLens settings from the workspace's .vscode/settings.json (which
// allows comments and trailing commas), so a standalone MCP server indexes the
// same folders the user selected in VS Code.
function readWorkspaceSettings(workspaceRoot: string): Record<string, unknown> {
  try {
    const raw = fs.readFileSync(path.join(workspaceRoot, '.vscode', 'settings.json'), 'utf-8');
    const json = raw
      .replace(/"(?:[^"\\]|\\.)*"|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, m => (m.startsWith('"') ? m : ''))
      .replace(/,(\s*[}\]])/g, '$1');
    const parsed = JSON.parse(json);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

// ─── Task tier classifier ─────────────────────────────────────────────────────

interface TierResult {
  tier:        1 | 2 | 3 | 4;
  label:       string;
  cost:        string;
  nextTool:    string | null;
  instruction: string;
}

function classifyTask(task: string): TierResult {
  const t = task.toLowerCase();

  if (/typo|spelling|comment|format|indent|rename.*variable.*this|change.*string|update.*text/.test(t)
   || /^what (is|does)|^explain|^describe/.test(t)) {
    return {
      tier: 1, label: 'Local edit', cost: '0 tokens', nextTool: null,
      instruction: 'No CodeLens call needed. Work directly on the open file.',
    };
  }

  if (/where is|find.*function|find.*class|locate|which file|what.*returns|signature of|definition of|import path|search.*for|string|text|comment|mention|message|print/.test(t)) {
    const isText = /string|text|comment|mention|message|print/i.test(t);
    return {
      tier: 2, label: 'Search & Lookup', cost: '~50 tokens',
      nextTool: isText ? 'codelens_text_search' : 'codelens_search',
      instruction: isText
        ? 'Call codelens_text_search to locate the text or comment. You may also use other tools if needed.'
        : 'Call codelens_search to locate the symbol definition. You may also use other tools if needed.',
    };
  }

  if (/refactor|rename.*everywhere|move.*to|extract|change.*signature|update.*all.*call|migrate|replace.*across/.test(t)) {
    return {
      tier: 4, label: 'Cross-file refactor', cost: '~600-1200 tokens',
      nextTool: 'codelens_context + codelens_impact',
      instruction: 'Call codelens_context then codelens_impact. Tracing callers or impact helps verify changes.',
    };
  }

  return {
    tier: 3, label: 'Feature / bug fix', cost: '~200-500 tokens', nextTool: 'codelens_context',
    instruction: 'Call codelens_context for codebase context. You may also use other specific tools (like codelens_text_search or codelens_node) as necessary.',
  };
}

// ─── MCPServer ────────────────────────────────────────────────────────────────

export class MCPServer {
  private server:    any;
  private transport: any;
  private workspaces = new Map<string, {
    db: GraphDB;
    contextBuilder: ContextBuilder;
    textIndex: TextIndex;
    logger: MCPLogger;
  }>();
  private defaultWorkspaceRoot = '';
  private runningScans = new Set<string>();
  // Workspaces whose auto-index was skipped because they are too large to index
  // without a folder selection (value: indexable file count).
  private scanNeedsSelection = new Map<string, number>();

  constructor() {
    this.setupRegistryWatcher();
  }

  private setupRegistryWatcher(): void {
    const registryDir = path.join(os.homedir(), '.codelens');
    const registryPath = path.join(registryDir, 'active-workspaces.json');
    
    // Ensure the directory exists
    try {
      fs.mkdirSync(registryDir, { recursive: true });
    } catch {}

    if (fs.existsSync(registryPath)) {
      this.watchRegistryFile(registryPath);
    } else {
      // Check periodically until it is created
      const interval = setInterval(() => {
        if (fs.existsSync(registryPath)) {
          this.watchRegistryFile(registryPath);
          clearInterval(interval);
        }
      }, 5000);
      interval.unref(); // Don't keep event loop alive for this
    }
  }

  private watchRegistryFile(filePath: string): void {
    try {
      fs.watchFile(filePath, { interval: 2000 }, (curr, prev) => {
        if (curr.mtimeMs !== prev.mtimeMs) {
          this.resolveActiveWorkspace().then(active => {
            console.error(`[CodeLens MCP] Active workspace hot-reloaded to: ${active}`);
          }).catch(() => {});
        }
      });
    } catch (err) {
      console.error(`[CodeLens MCP] Failed to watch registry file:`, err);
    }
  }

  private async resolveActiveWorkspace(overrideWorkspace?: string): Promise<string> {
    if (overrideWorkspace) {
      const resolved = path.resolve(overrideWorkspace);
      if (!this.isKnownWorkspace(resolved)) {
        throw new Error(
          'Workspace override rejected: "' + overrideWorkspace + '" is not a CodeLens workspace '
          + '(no .codelens/codelens-graph.db and not open in VS Code). Omit the workspace argument '
          + 'to use the active workspace, or pass the project root that contains .codelens/.'
        );
      }
      return resolved;
    }

    // Try reading active-workspaces.json global registry
    const registryPath = path.join(os.homedir(), '.codelens', 'active-workspaces.json');
    if (fs.existsSync(registryPath)) {
      try {
        const data = JSON.parse(fs.readFileSync(registryPath, 'utf-8'));
        const windows = data.windows ?? {};
        let mostActivePath: string | null = null;
        let maxTime = -1;
        
        for (const pid of Object.keys(windows)) {
          const win = windows[pid];
          if (win && win.path && win.lastActive > maxTime) {
            mostActivePath = win.path;
            maxTime = win.lastActive;
          }
        }
        if (mostActivePath && fs.existsSync(mostActivePath)) {
          return path.resolve(mostActivePath);
        }
      } catch (err) {
        // Fallback
      }
    }

    // Fall back to process.cwd() or the folder containing `.codelens/codelens-graph.db` in cwd and ancestors
    return this.discoverWorkspaceFromCwd();
  }

  // The `workspace` tool argument is agent-controlled, so only folders CodeLens
  // already manages are accepted. Otherwise a prompt-injected agent could create
  // .codelens/ files in, or run codelens_clear_config against, any directory.
  private isKnownWorkspace(dir: string): boolean {
    const same = (a: string, b: string) =>
      process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;

    if (this.defaultWorkspaceRoot && same(dir, path.resolve(this.defaultWorkspaceRoot))) { return true; }
    for (const loaded of this.workspaces.keys()) {
      if (same(dir, loaded)) { return true; }
    }
    if (fs.existsSync(path.join(dir, '.codelens', 'codelens-graph.db'))) { return true; }
    return this.isOpenInVsCode(dir);
  }

  // Whether a VS Code window with the CodeLens extension has this workspace open.
  private isOpenInVsCode(dir: string): boolean {
    const same = (a: string, b: string) =>
      process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
    const registryPath = path.join(os.homedir(), '.codelens', 'active-workspaces.json');
    try {
      const windows = JSON.parse(fs.readFileSync(registryPath, 'utf-8')).windows ?? {};
      return Object.values(windows).some((w: any) => typeof w?.path === 'string' && same(dir, path.resolve(w.path)));
    } catch {
      return false;
    }
  }

  private discoverWorkspaceFromCwd(): string {
    let curr = process.cwd();
    while (true) {
      const dbFile = path.join(curr, '.codelens', 'codelens-graph.db');
      if (fs.existsSync(dbFile)) {
        return path.resolve(curr);
      }
      const parent = path.dirname(curr);
      if (parent === curr) {
        break; // Reached root
      }
      curr = parent;
    }
    // Fallbacks
    if (process.env.WORKSPACE_FOLDER && fs.existsSync(process.env.WORKSPACE_FOLDER)) {
      return path.resolve(process.env.WORKSPACE_FOLDER);
    }
    return path.resolve(this.defaultWorkspaceRoot || process.cwd());
  }

  private async getWorkspaceContext(overrideWorkspace?: string): Promise<{
    workspaceRoot: string;
    db: GraphDB;
    contextBuilder: ContextBuilder;
    textIndex: TextIndex;
    logger: MCPLogger;
  }> {
    const resolvedPath = await this.resolveActiveWorkspace(overrideWorkspace);
    let ctx = this.workspaces.get(resolvedPath);
    if (!ctx) {
      const dbDir = path.join(resolvedPath, '.codelens');
      fs.mkdirSync(dbDir, { recursive: true });
      const db = new GraphDB(dbDir);
      await db.init();

      // Graph empty: index in the background — unless VS Code has this
      // workspace open (the extension owns indexing there, and two writers
      // would overwrite each other's DB), or it is too large to index without
      // a folder selection.
      const stats = db.getStats();
      if (stats.totalNodes === 0 && this.isOpenInVsCode(resolvedPath)) {
        console.error(`[CodeLens MCP] Graph empty — ${resolvedPath} is open in VS Code; the CodeLens extension builds the graph.`);
      } else if (stats.totalNodes === 0) {
        if (!this.runningScans.has(resolvedPath)) {
          this.runningScans.add(resolvedPath);
          const parser  = new ASTParser();
          const scanner = new WorkspaceScanner(parser, db);
          const settings = readWorkspaceSettings(resolvedPath);
          const scope: IndexScope = { workspaceRoot: resolvedPath, folders: normalizeFolders(settings['codeLensGraph.includeFolders']) };
          const threshold = typeof settings['codeLensGraph.largeWorkspaceThreshold'] === 'number'
            ? settings['codeLensGraph.largeWorkspaceThreshold'] as number
            : DEFAULT_LARGE_WORKSPACE_THRESHOLD;

          const scanOptions = {
            excludePatterns: [
              '**/node_modules/**', '**/dist/**', '**/build/**', '**/out/**', '**/output/**',
              '**/bundle/**', '**/.next/**', '**/.nuxt/**', '**/.svelte-kit/**', '**/.vite/**',
              '**/.turbo/**', '**/.parcel-cache/**', '**/.cache/**', '**/.angular/**',
              '**/coverage/**', '**/.nyc_output/**', '**/playwright-report/**', '**/test-results/**',
              '**/__pycache__/**', '**/.venv/**', '**/venv/**', '**/.pytest_cache/**',
              '**/.mypy_cache/**', '**/site-packages/**', '**/*.egg-info/**',
              '**/vendor/**', '**/target/**', '**/.gradle/**', '**/.m2/**', '**/obj/**',
              '**/.git/**', '**/.hg/**', '**/.svn/**', '**/.idea/**', '**/.vs/**',
              '**/.vscode/**', '**/.cursor/**', '**/.trae/**', '**/.codelens/**',
              '**/DerivedData/**', '**/xcuserdata/**', '**/.build/**',
            ],
            supportedExtensions: [
              '.ts','.tsx','.js','.jsx','.mjs',
              '.py','.go','.rs','.java','.cs',
              '.cpp','.c','.rb','.php','.swift','.kt',
            ],
          };
          if (Array.isArray(settings['codeLensGraph.excludePatterns'])) {
            scanOptions.excludePatterns = settings['codeLensGraph.excludePatterns'] as string[];
          }
          if (Array.isArray(settings['codeLensGraph.supportedExtensions'])) {
            scanOptions.supportedExtensions = settings['codeLensGraph.supportedExtensions'] as string[];
          }

          (async () => {
            if (!scope.folders.length) {
              const count = (await scanner.listFiles(scope, scanOptions)).length;
              if (count > threshold) {
                this.scanNeedsSelection.set(resolvedPath, count);
                console.error(`[CodeLens MCP] ${count} indexable files exceeds the large-workspace threshold (${threshold}); not indexing until folders are selected.`);
                return;
              }
            }
            console.error(`[CodeLens MCP] Graph empty — starting background index for ${resolvedPath}…`);
            const result = await scanner.scanWorkspace(scope, scanOptions);
            const manifests = db.getAllFiles('all').filter(f => path.basename(f).toLowerCase() === 'package.json' && !isNodeModulePath(f));
            if (db.replacePackages(await readDependencyManifest(resolvedPath, manifests))) { db.persist(); }
            const newStats = db.getStats();
            console.error(`[CodeLens MCP] Background index finished. Indexed ${newStats.fileCount} files, ${newStats.totalNodes} symbols. Errors: ${result.errors.length}`);
          })().catch((err) => {
            console.error(`[CodeLens MCP] Background index failed:`, err);
          }).finally(() => {
            this.runningScans.delete(resolvedPath);
          });
        } else {
          console.error(`[CodeLens MCP] Graph empty — background indexing already in progress for ${resolvedPath}`);
        }
      } else {
        console.error(`[CodeLens MCP] Graph loaded: ${stats.totalNodes} symbols in ${stats.fileCount} files`);
      }

      const contextBuilder = new ContextBuilder(db);
      const textIndex = new TextIndex(db);
      const logger = new MCPLogger(resolvedPath);
      ctx = { db, contextBuilder, textIndex, logger };
      this.workspaces.set(resolvedPath, ctx);
    }
    return { workspaceRoot: resolvedPath, ...ctx };
  }

  async start(workspaceRoot: string): Promise<void> {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { McpServer }          = require('@modelcontextprotocol/sdk/server/mcp.js');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { z } = require('zod');

    this.defaultWorkspaceRoot = workspaceRoot === '--auto' ? '' : workspaceRoot;

    // Resolve/initialize default workspace root
    await this.getWorkspaceContext();

    const pkgVersion = (() => {
      try {
        const pkgPath = path.join(__dirname, '..', 'package.json');
        if (fs.existsSync(pkgPath)) {
          const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
          return pkg.version || '0.2.2';
        }
      } catch {}
      return '0.2.2';
    })();

    this.server = new McpServer(
      { name: 'codelens-graph', version: pkgVersion },
      {
        instructions:
          'MANDATORY: Use CodeLens Graph tools for ALL codebase discovery. '
        + 'NEVER use grep, find, ls, or read_file to discover symbols, structure, or relationships — '
        + 'CodeLens provides this instantly at a fraction of the token cost. '
        + 'WORKFLOW: (1) Call codelens_triage FIRST on every task — it costs ~10 tokens and tells you '
        + 'the minimum tool needed. (2) Use only what triage recommends. '
        + '(3) Read ONLY the specific file:line locations CodeLens returns — never whole files. '
        + '(4) Before creating any file or function, call codelens_search to verify it does not already exist. '
        + 'Skipping CodeLens for "small" tasks wastes tokens and causes duplicates.',
      }
    );

    // ── Helper: wrap every handler with logging ───────────────────────────────
    const tool = (
      name: string,
      description: string,
      schema: any,
      handler: (args: any) => Promise<{ content: Array<{ type: 'text'; text: string }> }>
    ) => {
      this.server.tool(name, description, schema, async (args: any) => {
        const t0     = Date.now();
        const result = await handler(args);
        const text   = result.content.map((c: any) => c.text).join('');
        const { logger } = await this.getWorkspaceContext(args.workspace);
        logger.log(name, args, text, Date.now() - t0);
        return result;
      });
    };

    const txt = (text: string) => ({ content: [{ type: 'text' as const, text }] });

    // ── codelens_triage ───────────────────────────────────────────────────────

    tool(
      'codelens_triage',
      'CALL THIS FIRST before any file operation or other CodeLens tool. '
      + 'Classifies the task and returns the single minimum tool needed. '
      + '~10 tokens. Tier 1=no tool, Tier 2=search, Tier 3=context, Tier 4=context+impact.',
      {
        task: z.string().describe('What you are about to do, in plain English'),
        workspace: z.string().optional().describe('Optional workspace override path')
      },
      async ({ task, workspace }: { task: string; workspace?: string }) => {
        const r     = classifyTask(task);
        const { db } = await this.getWorkspaceContext(workspace);
        const stats = db.getStats();
        const next  = r.tier === 1
          ? '✅ No CodeLens call needed. Proceed directly.'
          : '→ Next: ' + r.nextTool;
        return txt([
          '## CodeLens Triage',
          'Task: "' + task + '"',
          'Tier ' + r.tier + ' — ' + r.label + ' | Cost: ' + r.cost,
          'Action: ' + r.instruction,
          '',
          next,
          '',
          'Graph: ' + stats.totalNodes + ' symbols · ' + stats.fileCount + ' files indexed',
        ].join('\n'));
      }
    );

    // ── codelens_search ───────────────────────────────────────────────────────

    tool(
      'codelens_search',
      'Search the codebase for symbol definitions (classes, functions, methods, variables, interfaces, types) by name. '
      + 'Returns the exact file path, line number, and symbol signature. '
      + 'Use this for Tier 2 tasks to locate where a symbol is defined, or before creating a new symbol to ensure it does not already exist. '
      + 'DO NOT use for arbitrary text/string searches or looking inside comments/strings (use codelens_text_search instead).',
      {
        query: z.string(),
        limit: z.number().optional().default(10),
        scope: z.enum(['workspace', 'deps', 'all']).optional().default('workspace'),
        workspace: z.string().optional().describe('Optional workspace override path')
      },
      async ({ query, limit, scope, workspace }: { query: string; limit?: number; scope?: 'workspace' | 'deps' | 'all'; workspace?: string }) => {
        const { db, workspaceRoot } = await this.getWorkspaceContext(workspace);
        db.refreshFromDiskIfChanged();
        const results = db.searchNodes(query, limit ?? 10, scope ?? 'workspace');
        const packages = scope === 'deps' || scope === 'all'
          ? db.getPackages().filter(p => p.name.toLowerCase().includes(query.toLowerCase())).slice(0, limit ?? 10)
          : [];
        if (!results.length && !packages.length) {
          let msg = 'No symbols found matching "' + query + '" within scope ' + (scope ?? 'workspace') + '.';
          if (scope === 'deps' || scope === 'all') {
            msg += '\n\nDependency symbols are not indexed; use codelens_dependencies with queryType "exports" to list a package\'s exports.';
          }
          return txt(msg + ' Safe to create.');
        }
        const lines = [
          'Found ' + results.length + ' symbol(s) matching "' + query + '" inside scope ' + (scope ?? 'workspace') + ':',
          '',
          ...results.map(n => this.fmtNode(n, workspaceRoot)),
        ];
        if (packages.length) {
          lines.push('', 'Matching dependencies:');
          lines.push(...packages.map(p => '  - ' + p.name + '@' + (p.version ?? p.declaredRange + ' (not installed)')));
        }
        lines.push('', '→ Read only the specific line(s) above.');
        return txt(lines.join('\n'));
      }
    );

    // ── codelens_context ──────────────────────────────────────────────────────

    tool(
      'codelens_context',
      'Retrieve a compressed codebase context subgraph for a feature or bugfix task (Tier 3). '
      + 'Returns relevant files, symbols, import paths, and call relationships. '
      + 'Use mode "short" to get a high-level map (very cheap), or mode "deep" to pull full implementation snippets of related symbols. '
      + 'After calling this, read ONLY the file:line ranges specified to save tokens.',
      {
        task:       z.string(),
        max_depth:  z.number().optional().default(2),
        max_tokens: z.number().optional().default(2500),
        mode:       z.enum(['short', 'deep']).optional().default('short'),
        scope:      z.enum(['workspace', 'deps', 'all']).optional().default('workspace').describe('Filter context to: "workspace" (default, excludes node_modules/configs), "deps" (only node_modules and configs), or "all" (includes everything). Use "deps" or "all" only if the task explicitly requires inspecting external dependencies or config files.'),
        workspace:  z.string().optional().describe('Optional workspace override path')
      },
      async ({ task, max_depth, max_tokens, mode, scope, workspace }: {
        task: string;
        max_depth?: number;
        max_tokens?: number;
        mode: 'short' | 'deep';
        scope?: 'workspace' | 'deps' | 'all';
        workspace?: string;
      }) => {
        const { db, contextBuilder } = await this.getWorkspaceContext(workspace);
        db.refreshFromDiskIfChanged();
        const ctx    = contextBuilder.build(task, max_depth ?? 2, max_tokens ?? 2500, mode, scope ?? 'workspace');
        const output = contextBuilder.buildSystemPromptInjection(ctx, mode);
        const header = [
          '## CodeLens Context: "' + task + '" (' + mode + ' mode)',
          'Symbols: ' + ctx.subgraph.nodes.length + ' | ~' + ctx.tokenEstimate + ' tokens',
          'READ ONLY the file:line combinations listed — not whole files.',
          '',
        ].join('\n');
        return txt(header + output);
      }
    );

    // ── codelens_relations ────────────────────────────────────────────────────

    tool(
      'codelens_relations',
      'Find callers (who calls this) and/or callees (what this calls) of a function or method. '
      + 'Use this to map incoming or outgoing call dependencies before editing a shared symbol.',
      {
        symbol: z.string().describe('Name of the symbol (function or method) to query'),
        direction: z.enum(['callers', 'callees', 'both']).optional().default('both').describe('Query incoming callers, outgoing callees, or both'),
        workspace: z.string().optional().describe('Optional workspace override path')
      },
      async ({ symbol, direction, workspace }: { symbol: string; direction: 'callers' | 'callees' | 'both'; workspace?: string }) => {
        const { db, workspaceRoot } = await this.getWorkspaceContext(workspace);
        db.refreshFromDiskIfChanged();
        const targets = db.searchNodes(symbol, 5).filter(n => n.name === symbol);
        if (!targets.length) { return txt('"' + symbol + '" not found in graph.'); }
        
        const lines: string[] = [];
        for (const t of targets) {
          lines.push('## Symbol: ' + t.name + ' @ ' + this.rel(t.filePath, workspaceRoot) + ':' + t.line);
          
          if (direction === 'callers' || direction === 'both') {
            const callers = db.getEdgesTo(t.id, 'calls')
              .map(e => db.getNode(e.fromId)).filter(Boolean) as GraphNode[];
            lines.push('### Callers (Incoming):');
            if (callers.length > 0) {
              const maxCallers = 30;
              const shownCallers = callers.slice(0, maxCallers);
              lines.push(...shownCallers.map(c => '  - ' + this.fmtNode(c, workspaceRoot)));
              if (callers.length > maxCallers) {
                lines.push(`  - ... and ${callers.length - maxCallers} more callers.`);
              }
            } else {
              lines.push('  No callers found in indexed codebase.');
            }
            lines.push('');
          }
          
          if (direction === 'callees' || direction === 'both') {
            const callees = db.getEdgesFrom(t.id, 'calls')
              .map(e => db.getNode(e.toId)).filter(Boolean) as GraphNode[];
            lines.push('### Callees (Outgoing):');
            if (callees.length > 0) {
              const maxCallees = 30;
              const shownCallees = callees.slice(0, maxCallees);
              lines.push(...shownCallees.map(c => '  - ' + this.fmtNode(c, workspaceRoot)));
              if (callees.length > maxCallees) {
                lines.push(`  - ... and ${callees.length - maxCallees} more callees.`);
              }
            } else {
              lines.push('  No outgoing calls found.');
            }
            lines.push('');
          }
        }
        return txt(lines.join('\n'));
      }
    );

    // ── codelens_impact ───────────────────────────────────────────────────────

    tool(
      'codelens_impact',
      'Calculate the transitive impact radius/dependency tree of changing a symbol. '
      + 'Use before major refactoring (Tier 4) to list all files and symbols that may break or require updates.',
      {
        symbol: z.string(),
        depth: z.number().optional().default(3),
        workspace: z.string().optional().describe('Optional workspace override path')
      },
      async ({ symbol, depth, workspace }: { symbol: string; depth?: number; workspace?: string }) => {
        const { db, workspaceRoot } = await this.getWorkspaceContext(workspace);
        db.refreshFromDiskIfChanged();
        const targets = db.searchNodes(symbol, 3).filter(n => n.name === symbol);
        if (!targets.length) { return txt('"' + symbol + '" not found.'); }
        const t = targets[0];
        const { nodes, edges } = db.bfsExpand([t.id], depth ?? 3);
        const impacted = nodes.filter(n => n.id !== t.id && edges.some(e => e.fromId === n.id || e.toId === n.id));
        const maxImpacted = 50;
        const shownImpacted = impacted.slice(0, maxImpacted);
        const lines = [
          '## Impact: "' + symbol + '"',
          'Definition: ' + this.rel(t.filePath, workspaceRoot) + ':' + t.line,
          'Signature: ' + (t.signature?.slice(0, 120) ?? 'N/A'),
          '',
          impacted.length + ' affected symbol(s):',
          ...shownImpacted.map(n => '  - [' + n.type + '] ' + n.name + ' @ ' + this.rel(n.filePath, workspaceRoot) + ':' + n.line),
        ];
        if (impacted.length > maxImpacted) {
          lines.push(`  - ... and ${impacted.length - maxImpacted} more symbols.`);
        }
        if (t.undefinedRefs?.length) {
          lines.push('', 'Existing undefined refs: ' + t.undefinedRefs.slice(0, 20).join(', ') + (t.undefinedRefs.length > 20 ? ` (+ ${t.undefinedRefs.length - 20} more)` : ''));
        }
        return txt(lines.join('\n'));
      }
    );

    // ── codelens_node ─────────────────────────────────────────────────────────

    tool(
      'codelens_node',
      'Retrieve detailed schema information and signature for a single symbol by name. '
      + 'Set with_snippet=true to inspect its code block/body. '
      + 'Use this instead of reading a whole file when you only need to understand or view the implementation of one specific class or function.',
      {
        symbol: z.string(),
        with_snippet: z.boolean().optional().default(false),
        filePath: z.string().optional().describe('Optional file path (absolute, relative, or suffix) to disambiguate if multiple symbols share the same name.'),
        workspace: z.string().optional().describe('Optional workspace override path')
      },
      async ({ symbol, with_snippet, filePath, workspace }: { symbol: string; with_snippet?: boolean; filePath?: string; workspace?: string }) => {
        const { db, workspaceRoot } = await this.getWorkspaceContext(workspace);
        db.refreshFromDiskIfChanged();
        const results = db.searchNodes(symbol, 5).filter(n => n.name === symbol);
        
        let filteredResults = results;
        if (filePath) {
          const normQueryPath = filePath.replace(/\\/g, '/').toLowerCase();
          filteredResults = results.filter(n => {
            const normNodePath = n.filePath.replace(/\\/g, '/').toLowerCase();
            const normRelPath = this.rel(n.filePath, workspaceRoot).toLowerCase();
            return normNodePath.endsWith(normQueryPath) || normRelPath.endsWith(normQueryPath);
          });
        }

        if (!filteredResults.length) { return txt('"' + symbol + '" not found' + (filePath ? ' inside file matching ' + filePath : '') + '.'); }
        const lines: string[] = [];
        for (const node of filteredResults.slice(0, 3)) {
          lines.push('## [' + node.type + '] ' + node.name);
          lines.push('- File: ' + this.rel(node.filePath, workspaceRoot) + ':' + node.line);
          if (node.signature)   { lines.push('- Signature: ' + node.signature.slice(0, 200)); }
          if (node.returnType)  { lines.push('- Returns: ' + node.returnType); }
          if (node.params?.length) {
            lines.push('- Params: ' + node.params.map(p => p.name + ': ' + (p.type ?? '?')).join(', '));
          }
          const imp = this.buildImportStmt(node, workspaceRoot);
          if (imp) { lines.push('- Import as: ' + imp); }
          const callerCount = db.getEdgesTo(node.id, 'calls').length;
          const calleeCount = db.getEdgesFrom(node.id, 'calls').length;
          if (callerCount) { lines.push('- Callers: ' + callerCount + ' (run codelens_relations with direction callers)'); }
          if (calleeCount) { lines.push('- Callees: ' + calleeCount + ' (run codelens_relations with direction callees)'); }
          if (node.undefinedRefs?.length) {
            lines.push('- Undefined refs: ' + node.undefinedRefs.join(', '));
          }
          if (with_snippet === true) {
            const snippet = this.readSnippet(node, workspaceRoot);
            if (snippet) { lines.push('', '```' + node.language, snippet, '```'); }
          }
          lines.push('');
        }
        return txt(lines.join('\n'));
      }
    );

    // ── codelens_files ────────────────────────────────────────────────────────

    tool(
      'codelens_files',
      'Retrieve the workspace file structure grouped by category (routes, services, models, utils...). '
      + 'Use this instead of ls, find, or directory listing commands. '
      + 'Supply a filter to search file paths, or set scope="deps" to find package.json, configuration files, or type definitions.',
      {
        filter: z.string().optional(),
        scope: z.enum(['workspace', 'deps', 'all']).optional().default('workspace'),
        workspace: z.string().optional().describe('Optional workspace override path')
      },
      async ({ filter, scope, workspace }: { filter?: string; scope?: 'workspace' | 'deps' | 'all'; workspace?: string }) => {
        const { db, workspaceRoot } = await this.getWorkspaceContext(workspace);
        db.refreshFromDiskIfChanged();
        const classifier = new FileClassifier();
        const allFiles   = db.getAllFiles(scope ?? 'workspace');
        const groups     = classifier.groupFiles(allFiles);
        const lines      = ['## Workspace (' + allFiles.length + ' files, scope: ' + (scope ?? 'workspace') + ')', ''];
        if (scope === 'deps' || scope === 'all') {
          const packages = db.getPackages();
          if (packages.length) {
            lines.push('### Dependencies (' + packages.length + ') — see codelens_dependencies');
            lines.push(...packages.map(p => '  - ' + p.name + '@' + (p.version ?? p.declaredRange)));
            lines.push('');
          }
        }
        for (const [label, files] of groups) {
          if (filter
            && !label.toLowerCase().includes(filter.toLowerCase())
            && !files.some(f => path.basename(f).toLowerCase().includes(filter.toLowerCase()))) {
            continue;
          }
          lines.push('### ' + label + ' (' + files.length + ')');
          const maxFilesToShow = filter ? files.length : 30;
          const shownFiles = files.slice(0, maxFilesToShow);
          lines.push(...shownFiles.map(f => '  - ' + this.rel(f, workspaceRoot)));
          if (files.length > maxFilesToShow) {
            lines.push(`  - ... and ${files.length - maxFilesToShow} more files. Use a filter to narrow search.`);
          }
          lines.push('');
        }
        return txt(lines.join('\n'));
      }
    );

    // ── codelens_dependencies ─────────────────────────────────────────────────

    tool(
      'codelens_dependencies',
      'Query the workspace\'s direct dependencies (declared in its package.json files): installed version, entry points, '
      + 'exports from type definitions, and which files import a package. Use when the task involves dependencies, versions, types, or package configuration.',
      {
        packageName: z.string().optional().describe('Specific package to look up, e.g. "lodash" or "@types/react". Omit to list all direct dependencies.'),
        queryType: z.enum(['info', 'exports', 'types', 'dependents']).optional().default('info').describe('What to retrieve: package info, exported symbols, type definitions, or files that import this package.'),
        workspace: z.string().optional().describe('Optional workspace override path')
      },
      async ({ packageName, queryType, workspace }: { packageName?: string; queryType?: 'info' | 'exports' | 'types' | 'dependents'; workspace?: string }) => {
        const { db, workspaceRoot } = await this.getWorkspaceContext(workspace);
        db.refreshFromDiskIfChanged();
        
        const packages = db.getPackages();
        if (packageName) {
          const pkg = packages.find(p => p.name === packageName)
            ?? packages.find(p => p.name.toLowerCase() === packageName.toLowerCase());
          if (!pkg) {
            const known = packages.filter(p => p.name.toLowerCase().includes(packageName.toLowerCase())).map(p => p.name);
            return txt('Package "' + packageName + '" is not a direct dependency of this workspace.'
              + (known.length ? ' Similar: ' + known.slice(0, 10).join(', ') : ''));
          }
          const rel = (p: string) => this.rel(p, workspaceRoot);
          const lines: string[] = ['## Package: ' + pkg.name, ''];

          if (queryType === 'info') {
            lines.push('- Installed version: ' + (pkg.version ?? 'not installed'));
            lines.push('- Declared: ' + pkg.declaredRange + ' (' + pkg.kind + ') in ' + pkg.declaredIn.map(rel).join(', '));
            if (pkg.dir)    { lines.push('- Path: ' + rel(pkg.dir)); }
            if (pkg.types)  { lines.push('- Type definitions: ' + rel(pkg.types)); }
            if (pkg.main)   { lines.push('- Main entry: ' + rel(pkg.main)); }
            if (pkg.readme) { lines.push('- Readme: ' + rel(pkg.readme)); }
          } else if (queryType === 'exports' || queryType === 'types') {
            if (!pkg.types) {
              lines.push('No type definitions found for this package' + (pkg.installed ? '.' : ' (it is not installed).'));
            } else {
              const exported = readDeclaredExports(pkg.types);
              lines.push('Type definitions: ' + rel(pkg.types), '');
              if (!exported.length) {
                lines.push('No top-level exports found in the type definitions entry.');
              } else {
                lines.push('Exports declared in the entry file (read on demand):');
                lines.push(...exported.map(e => '  - [' + e.kind + '] ' + e.name + ' @ line ' + e.line));
              }
            }
          } else if (queryType === 'dependents') {
            const files = db.getFilesImporting(pkg.name);
            if (!files.length) {
              lines.push('No indexed workspace files import "' + pkg.name + '".');
            } else {
              lines.push('Workspace files importing this package (' + files.length + '):');
              lines.push(...files.map(f => '  - ' + rel(f)));
            }
          }
          return txt(lines.join('\n'));
        } else {
          const lines = ['## Dependencies & Configuration Files', ''];
          if (packages.length) {
            lines.push('### Direct dependencies (' + packages.length + '):');
            for (const p of packages) {
              lines.push('  - ' + p.name + '@' + (p.version ?? p.declaredRange + ' (not installed)') + (p.kind === 'dependencies' ? '' : ' [' + p.kind + ']'));
            }
            lines.push('');
          }
          const configs = db.getAllFiles('deps').filter(f => !isNodeModulePath(f)).map(f => this.rel(f, workspaceRoot));
          if (configs.length) {
            lines.push('### Configurations:');
            lines.push(...configs.sort().map(c => '  - ' + c));
            lines.push('');
          }
          return txt(lines.join('\n'));
        }
      }
    );

    // ── codelens_status ───────────────────────────────────────────────────────

    tool(
      'codelens_status',
      'Graph health and statistics. Call when results seem missing or stale.',
      {
        workspace: z.string().optional().describe('Optional workspace override path')
      },
      async ({ workspace }: { workspace?: string }) => {
        const { db, workspaceRoot } = await this.getWorkspaceContext(workspace);
        db.refreshFromDiskIfChanged();
        const stats  = db.getStats();
        const issues = db.countNodesWithUndefinedRefs();
        const pendingFiles = stats.totalNodes === 0 ? this.scanNeedsSelection.get(workspaceRoot) : undefined;
        if (pendingFiles !== undefined) {
          return txt([
            '## CodeLens Status',
            '- Not indexed yet: this workspace has ' + pendingFiles + ' indexable files, above the large-workspace threshold.',
            '- Ask the user to choose folders to index: "CodeLens: Select Indexed Folders" in VS Code, '
              + 'or set "codeLensGraph.includeFolders" in .vscode/settings.json.',
          ].join('\n'));
        }
        return txt([
          '## CodeLens Status',
          '- Files indexed: ' + stats.fileCount,
          '- Total symbols: ' + stats.totalNodes,
          '- Relationships: ' + stats.totalEdges,
          '- Symbols with undefined refs: ' + issues,
          '- By type: ' + Object.entries(stats.byType).map(([k, v]) => k + ':' + v).join(', '),
        ].join('\n'));
      }
    );

    // ── codelens_text_search ──────────────────────────────────────────────────

    tool(
      'codelens_text_search',
      'Fuzzy full-text search for arbitrary strings, comments, string literals, and local variables. '
      + 'Use this when the query is not a formal symbol name, or when looking for error messages, TODO comments, conceptual references, or specific text strings.',
      {
        query: z.string().describe('Text to search for (e.g., "getPatterns", "TODO", "rate limit")'),
        fileFilter: z.string().optional().describe('Optional file extension filter, e.g. ".ts" or ".md"'),
        inComments: z.boolean().optional().describe('Search in comments only'),
        inStrings: z.boolean().optional().describe('Search in string literals only'),
        limit: z.number().optional().default(10).describe('Max results'),
        workspace: z.string().optional().describe('Optional workspace override path')
      },
      async ({ query, fileFilter, inComments, inStrings, limit = 10, workspace }: {
        query: string;
        fileFilter?: string;
        inComments?: boolean;
        inStrings?: boolean;
        limit?: number;
        workspace?: string;
      }) => {
        const { db, workspaceRoot } = await this.getWorkspaceContext(workspace);
        db.refreshFromDiskIfChanged();

        // 1. Normalize and decode query
        let decoded = query;
        try {
          decoded = decodeURIComponent(query);
        } catch {}
        const normalizedQuery = decoded.trim();

        if (!normalizedQuery) {
          return txt('Empty search query.');
        }

        // 2. Determine regex status (invalid or backtracking-prone patterns fall back to substring search)
        const { regex, rejected: regexRejected } = compileSearchRegex(normalizedQuery);

        const resultsMap = new Map<string, { filePath: string; line: number; rawText: string; source: 'graph' | 'filesystem'; type: string }>();

        // Heuristics for token types
        const isLineComment = (lineText: string) => {
          const t = lineText.trim();
          return t.startsWith('//') || t.startsWith('/*') || t.startsWith('*') || t.startsWith('#');
        };
        const isLineString = (lineText: string) => {
          const t = lineText.trim();
          return (t.includes('"') || t.includes("'") || t.includes('`')) && 
                 !t.includes('function') && !t.includes('class') && !t.includes('const');
        };

        const matchesQuery = (lineText: string) => {
          if (inComments && !isLineComment(lineText)) return false;
          if (inStrings && !isLineString(lineText)) return false;
          
          if (regex) {
            return regexTestCapped(regex, lineText);
          }
          return lineText.toLowerCase().includes(normalizedQuery.toLowerCase());
        };

        let graphMatchedCount = 0;

        // 3. Layer 1: Graph Search (only if not searching comments/strings specifically)
        if (!inComments && !inStrings) {
          const graphNodes = db.searchNodes(normalizedQuery, limit * 3, 'workspace');
          for (const node of graphNodes) {
            // Apply file filter
            if (fileFilter && !matchPathFilter(node.filePath, fileFilter, workspaceRoot)) {
              continue;
            }

            // Read the exact line for verification
            try {
              if (isPathInside(node.filePath, workspaceRoot) && fs.existsSync(node.filePath)) {
                const content = fs.readFileSync(node.filePath, 'utf-8');
                const linesList = content.split('\n');
                const lineIndex = node.line - 1;
                const lineText = linesList[lineIndex];
                if (lineText !== undefined && matchesQuery(lineText)) {
                  const key = `${node.filePath}:${node.line}`;
                  resultsMap.set(key, {
                    filePath: node.filePath,
                    line: node.line,
                    rawText: lineText.trim(),
                    source: 'graph',
                    type: node.type
                  });
                  graphMatchedCount++;
                  if (resultsMap.size >= limit) {
                    break;
                  }
                }
              }
            } catch {}
          }
        }

        let databaseScanTriggered = false;

        // 4. Layer 2: Database Scan Fallback
        if (resultsMap.size < limit) {
          databaseScanTriggered = true;
          const dbResults = db.searchFileLines(
            normalizedQuery,
            fileFilter,
            inComments,
            inStrings,
            limit - resultsMap.size,
            workspaceRoot
          );

          for (const r of dbResults) {
            const key = `${r.filePath}:${r.line}`;
            if (!resultsMap.has(key)) {
              resultsMap.set(key, {
                filePath: r.filePath,
                line: r.line,
                rawText: r.rawText,
                source: 'database' as any,
                type: r.type
              });
            }
          }
        }

        const results = Array.from(resultsMap.values());

        if (results.length === 0) {
          if (regexRejected) {
            return txt('No matches found for "' + normalizedQuery + '". The pattern was searched as literal text because it '
              + 'could backtrack excessively (nested repetition, backreferences, or >2 unbounded quantifiers). Simplify the regex and retry.');
          }
          return txt('No matches found for "' + normalizedQuery + '".\n\nGraph may be stale. Run codelens_status to check index freshness.');
        }

        const lines = [
          '## Text Search Results for "' + normalizedQuery + '" (' + results.length + ' matches):',
          ''
        ];

        for (const entry of results) {
          const relPath = path.relative(workspaceRoot, entry.filePath).replace(/\\/g, '/');
          lines.push('### [' + entry.type + '] ' + relPath + ':' + entry.line + ' (' + entry.source + ')');
          lines.push('```');
          lines.push(entry.rawText);
          lines.push('```');
          lines.push('');
        }

        // Diagnostics block
        lines.push('---');
        if (regexRejected) {
          lines.push('*Regex not used (too long, nested repetition, backreferences, or >2 unbounded quantifiers); searched as literal text.*');
        }
        if (databaseScanTriggered) {
          lines.push('*Matched via hybrid search: graph nodes pre-filter + database scan fallback.*');
        } else {
          lines.push('*Matched via graph nodes.*');
        }

        if (graphMatchedCount === 0 && results.length > 0) {
          lines.push('💡 *Tip: No symbols matched this query directly, but database search succeeded. Graph may be stale. Run codelens_status to check index freshness.*');
        }

        return txt(lines.join('\n'));
      }
    );

    // ── codelens_clear_config ────────────────────────────────────────────────
    tool(
      'codelens_clear_config',
      'Completely removes all CodeLens-generated configuration and rule files from the workspace. '
      + 'This includes mcp.json, instruction markdown files, and IDE rules.',
      {
        workspace: z.string().optional().describe('Optional workspace override path')
      },
      async ({ workspace }: { workspace?: string }) => {
        const { workspaceRoot } = await this.getWorkspaceContext(workspace);
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { SkillGenerator } = require('../agent/skillGenerator');
        const { GraphDB } = require('../graph/graphDB');
        const dbDir = path.join(workspaceRoot, '.codelens');
        const db = new GraphDB(dbDir);
        const skillGenerator = new SkillGenerator(db);

        // 1. Close and reset database connection if open
        const activeCtx = this.workspaces.get(workspaceRoot);
        if (activeCtx) {
          await activeCtx.db.close();
          this.workspaces.delete(workspaceRoot);
        }

        // 2. Clear configurations and directories on disk
        skillGenerator.clearAll(workspaceRoot);

        return txt('CodeLens Graph: Configurations and directories cleared successfully.');
      }
    );

    // ── Connect ───────────────────────────────────────────────────────────────

    this.transport = new StdioServerTransport();
    await this.server.connect(this.transport);
    console.error('[CodeLens MCP] Server ready — 11 tools on stdio');
  }

  async stop(): Promise<void> {
    const registryPath = path.join(os.homedir(), '.codelens', 'active-workspaces.json');
    try { fs.unwatchFile(registryPath); } catch {}
    for (const ctx of this.workspaces.values()) {
      ctx.logger?.summarise();
      ctx.db?.close();
    }
    try { await this.server?.close(); } catch { /* ignore */ }
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  private rel(fp: string, root: string): string {
    return path.relative(root, fp).replace(/\\/g, '/');
  }

  private fmtNode(n: GraphNode, root: string): string {
    const sig  = n.signature ? '  ->  ' + n.signature.slice(0, 80) : '';
    return '[' + n.type + '] ' + n.name + ' @ ' + this.rel(n.filePath, root) + ':' + n.line + sig;
  }

  private buildImportStmt(node: GraphNode, root: string): string | null {
    if (node.type === 'file' || node.type === 'import') { return null; }
    const rel = './' + this.rel(node.filePath, root).replace(/\.(ts|tsx|js|jsx|mjs)$/, '');
    if (node.language === 'python') {
      return 'from ' + rel.replace(/^\.\//, '').replace(/\//g, '.') + ' import ' + node.name;
    }
    return node.modifiers?.includes('default')
      ? 'import ' + node.name + ' from \'' + rel + '\';'
      : 'import { ' + node.name + ' } from \'' + rel + '\';';
  }

  // Node paths come from the DB, which a cloned repo could ship pre-built —
  // never read outside the workspace.
  private readSnippet(node: GraphNode, workspaceRoot: string): string | null {
    if (!isPathInside(node.filePath, workspaceRoot)) { return null; }
    try {
      const lines   = fs.readFileSync(node.filePath, 'utf-8').split('\n');
      const start   = Math.max(0, node.line - 1);
      const end     = Math.min(lines.length, Math.min(node.endLine ?? start + 15, start + 15));
      const snippet = lines.slice(start, end).join('\n');
      return snippet.length > 800 ? snippet.slice(0, 800) + '\n  // ...' : snippet;
    } catch { return null; }
  }
}
