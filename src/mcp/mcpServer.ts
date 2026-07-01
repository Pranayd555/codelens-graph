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
import { isConfigPath, isNodeModulePath } from '../utils';
import { TextIndex, TextEntry } from '../indexing/textIndex';

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
      if (fs.existsSync(resolved)) {
        return resolved;
      }
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

      // Check if graph is empty, scan now (blocks until done — first run only)
      const stats = db.getStats();
      if (stats.totalNodes === 0) {
        console.error(`[CodeLens MCP] Graph empty — indexing ${resolvedPath}…`);
        const parser  = new ASTParser();
        const scanner = new WorkspaceScanner(parser, db);

        await scanner.scanWorkspace([resolvedPath], {
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
        });

        const newStats = db.getStats();
        console.error(`[CodeLens MCP] Indexed ${newStats.fileCount} files, ${newStats.totalNodes} symbols`);
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
    const activeWorkspace = await this.resolveActiveWorkspace();
    await this.getWorkspaceContext(activeWorkspace);

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
        if (!results.length) {
          return txt('No symbols found matching "' + query + '" within scope ' + (scope ?? 'workspace') + '. Safe to create.');
        }
        const lines = [
          'Found ' + results.length + ' symbol(s) matching "' + query + '" inside scope ' + (scope ?? 'workspace') + ':',
          '',
          ...results.map(n => this.fmtNode(n, workspaceRoot)),
          '',
          '→ Read only the specific line(s) above.',
        ];
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
        workspace:  z.string().optional().describe('Optional workspace override path')
      },
      async ({ task, max_depth, max_tokens, mode, workspace }: { task: string; max_depth?: number; max_tokens?: number; mode: 'short' | 'deep'; workspace?: string }) => {
        const { db, contextBuilder } = await this.getWorkspaceContext(workspace);
        db.refreshFromDiskIfChanged();
        const ctx    = contextBuilder.build(task, max_depth ?? 2, max_tokens ?? 2500, mode);
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
            lines.push(callers.length
              ? callers.map(c => '  - ' + this.fmtNode(c, workspaceRoot)).join('\n')
              : '  No callers found in indexed codebase.');
            lines.push('');
          }
          
          if (direction === 'callees' || direction === 'both') {
            const callees = db.getEdgesFrom(t.id, 'calls')
              .map(e => db.getNode(e.toId)).filter(Boolean) as GraphNode[];
            lines.push('### Callees (Outgoing):');
            lines.push(callees.length
              ? callees.map(c => '  - ' + this.fmtNode(c, workspaceRoot)).join('\n')
              : '  No outgoing calls found.');
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
        const lines = [
          '## Impact: "' + symbol + '"',
          'Definition: ' + this.rel(t.filePath, workspaceRoot) + ':' + t.line,
          'Signature: ' + (t.signature?.slice(0, 120) ?? 'N/A'),
          '',
          impacted.length + ' affected symbol(s):',
          ...impacted.map(n => '  - [' + n.type + '] ' + n.name + ' @ ' + this.rel(n.filePath, workspaceRoot) + ':' + n.line),
        ];
        if (t.undefinedRefs?.length) {
          lines.push('', 'Existing undefined refs: ' + t.undefinedRefs.join(', '));
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
        workspace: z.string().optional().describe('Optional workspace override path')
      },
      async ({ symbol, with_snippet, workspace }: { symbol: string; with_snippet?: boolean; workspace?: string }) => {
        const { db, workspaceRoot } = await this.getWorkspaceContext(workspace);
        db.refreshFromDiskIfChanged();
        const results = db.searchNodes(symbol, 5).filter(n => n.name === symbol);
        if (!results.length) { return txt('"' + symbol + '" not found.'); }
        const lines: string[] = [];
        for (const node of results.slice(0, 3)) {
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
          if (callerCount) { lines.push('- Callers: ' + callerCount + ' (run codelens_callers)'); }
          if (calleeCount) { lines.push('- Callees: ' + calleeCount + ' (run codelens_callees)'); }
          if (node.undefinedRefs?.length) {
            lines.push('- Undefined refs: ' + node.undefinedRefs.join(', '));
          }
          if (with_snippet === true) {
            const snippet = this.readSnippet(node);
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
        for (const [label, files] of groups) {
          if (filter
            && !label.toLowerCase().includes(filter.toLowerCase())
            && !files.some(f => path.basename(f).toLowerCase().includes(filter.toLowerCase()))) {
            continue;
          }
          lines.push('### ' + label + ' (' + files.length + ')');
          lines.push(...files.map(f => '  - ' + this.rel(f, workspaceRoot)));
          lines.push('');
        }
        return txt(lines.join('\n'));
      }
    );

    // ── codelens_dependencies ─────────────────────────────────────────────────

    tool(
      'codelens_dependencies',
      'Query installed packages and their metadata. Use when the task involves dependencies, versions, types, or package configuration.',
      {
        packageName: z.string().optional().describe('Specific package to look up, e.g. "lodash" or "@types/react". Omit to list all top-level packages.'),
        queryType: z.enum(['info', 'exports', 'types', 'dependents']).optional().default('info').describe('What to retrieve: package info, exported symbols, type definitions, or files that import this package.'),
        workspace: z.string().optional().describe('Optional workspace override path')
      },
      async ({ packageName, queryType, workspace }: { packageName?: string; queryType?: 'info' | 'exports' | 'types' | 'dependents'; workspace?: string }) => {
        const { db, workspaceRoot } = await this.getWorkspaceContext(workspace);
        db.refreshFromDiskIfChanged();
        
        if (packageName) {
          const matches = db.getNodesByType('file').filter(n => 
            isNodeModulePath(n.filePath) && 
            n.filePath.replace(/\\/g, '/').toLowerCase().includes('/' + packageName.toLowerCase() + '/')
          );

          if (!matches.length) {
            return txt('Package "' + packageName + '" is not indexed or found in node_modules.');
          }

          const lines: string[] = ['## Package: ' + packageName, ''];

          if (queryType === 'info') {
            const pkgJsonNode = matches.find(n => n.name === 'package.json');
            if (pkgJsonNode) {
              lines.push('- Version: ' + (pkgJsonNode.signature || 'unknown'));
              lines.push('- Path: ' + this.rel(pkgJsonNode.filePath, workspaceRoot));
            }
            const readmeNode = matches.find(n => n.name.toLowerCase() === 'readme.md');
            if (readmeNode) {
              lines.push('- Readme: ' + this.rel(readmeNode.filePath, workspaceRoot));
            }
            const typeDefs = matches.filter(n => n.name.endsWith('.d.ts'));
            if (typeDefs.length) {
              lines.push('- Type definitions: ' + typeDefs.map(t => this.rel(t.filePath, workspaceRoot)).join(', '));
            }
          } else if (queryType === 'exports') {
            const symbols = matches.flatMap(m => 
              db.getNodesByFile(m.filePath).filter(n => n.type !== 'file' && n.type !== 'import')
            );
            if (!symbols.length) {
              lines.push('No exported symbols found in the type definitions for this package.');
            } else {
              lines.push('Exported symbols:');
              lines.push(...symbols.map(s => '  - [' + s.type + '] ' + s.name + ' @ ' + this.rel(s.filePath, workspaceRoot) + ':' + s.line));
            }
          } else if (queryType === 'types') {
            const typeDefs = matches.filter(n => n.name.endsWith('.d.ts'));
            if (!typeDefs.length) {
              lines.push('No type definition files found for this package.');
            } else {
              lines.push('Type definition files:');
              for (const td of typeDefs) {
                lines.push('### ' + this.rel(td.filePath, workspaceRoot));
                const symbols = db.getNodesByFile(td.filePath).filter(n => n.type !== 'file' && n.type !== 'import');
                lines.push(...symbols.map(s => '  - [' + s.type + '] ' + s.name + ' @ line ' + s.line + ' ' + (s.signature ? '`' + s.signature.slice(0, 100) + '`' : '')));
                lines.push('');
              }
            }
          } else if (queryType === 'dependents') {
            const dependents = new Set<string>();
            for (const fileNode of matches) {
              const edges = db.getEdgesTo(fileNode.id, 'depends-on' as any);
              for (const edge of edges) {
                const node = db.getNode(edge.fromId);
                if (node) {
                  dependents.add(this.rel(node.filePath, workspaceRoot));
                }
              }
            }
            if (!dependents.size) {
              lines.push('No indexed workspace files import or depend on "' + packageName + '".');
            } else {
              lines.push('Workspace files importing/depending on this package:');
              lines.push(...Array.from(dependents).map(d => '  - ' + d));
            }
          }

          return txt(lines.join('\n'));
        } else {
          // List all top-level packages and configs
          const allDeps = db.getAllFiles('deps');
          const lines = ['## Index Dependencies & Configuration Files', ''];
          const packages = new Set<string>();
          const configs: string[] = [];

          for (const fp of allDeps) {
            if (isNodeModulePath(fp)) {
              const match = /\/node_modules\/((?:@[^/]+\/)?[^/]+)/.exec(fp.replace(/\\/g, '/'));
              if (match && match[1]) {
                packages.add(match[1]);
              }
            } else {
              configs.push(this.rel(fp, workspaceRoot));
            }
          }

          if (packages.size > 0) {
            lines.push('### Packages:');
            for (const pkg of Array.from(packages).sort()) {
              // Try to find package version
              const pkgJsonNode = db.getNodesByType('file').find(n => 
                isNodeModulePath(n.filePath) && 
                n.filePath.toLowerCase().endsWith('/node_modules/' + pkg.toLowerCase() + '/package.json')
              );
              const version = pkgJsonNode?.signature ? ` (${pkgJsonNode.signature})` : '';
              lines.push('  - ' + pkg + version);
            }
            lines.push('');
          }

          if (configs.length > 0) {
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
        const { db } = await this.getWorkspaceContext(workspace);
        db.refreshFromDiskIfChanged();
        const stats  = db.getStats();
        const issues = db.getNodesWithUndefinedRefs().length;
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
      async ({ query, fileFilter, inComments, inStrings, limit, workspace }: {
        query: string;
        fileFilter?: string;
        inComments?: boolean;
        inStrings?: boolean;
        limit?: number;
        workspace?: string;
      }) => {
        const { db, textIndex, workspaceRoot } = await this.getWorkspaceContext(workspace);
        db.refreshFromDiskIfChanged();
        
        let tokenType: TextEntry['tokenType'] | undefined;
        if (inComments) {
          tokenType = 'comment';
        } else if (inStrings) {
          tokenType = 'string_literal';
        }

        const results = textIndex.search(query, {
          limit,
          fileFilter,
          tokenType,
          fuzzy: true
        });

        if (results.length === 0) {
          return txt('No matches found for "' + query + '".');
        }

        const lines = [
          '## Text Search Results for "' + query + '" (' + results.length + ' matches):',
          ''
        ];

        for (const entry of results) {
          const relPath = path.relative(workspaceRoot, entry.filePath).replace(/\\/g, '/');
          lines.push('### [' + entry.tokenType + '] ' + relPath + ':' + entry.line);
          lines.push('```');
          lines.push(entry.rawText);
          lines.push('```');
          lines.push('');
        }

        return txt(lines.join('\n'));
      }
    );

    // ── Connect ───────────────────────────────────────────────────────────────

    this.transport = new StdioServerTransport();
    await this.server.connect(this.transport);
    console.error('[CodeLens MCP] Server ready — 10 tools on stdio');
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
    const warn = n.undefinedRefs?.length ? '  [undef:' + n.undefinedRefs.join(',') + ']' : '';
    return '[' + n.type + '] ' + n.name + ' @ ' + this.rel(n.filePath, root) + ':' + n.line + sig + warn;
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

  private readSnippet(node: GraphNode): string | null {
    try {
      const lines   = fs.readFileSync(node.filePath, 'utf-8').split('\n');
      const start   = Math.max(0, node.line - 1);
      const end     = Math.min(lines.length, Math.min(node.endLine ?? start + 15, start + 15));
      const snippet = lines.slice(start, end).join('\n');
      return snippet.length > 800 ? snippet.slice(0, 800) + '\n  // ...' : snippet;
    } catch { return null; }
  }
}
