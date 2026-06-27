import * as path from 'path';
import * as fs   from 'fs';
import { GraphDB }        from '../graph/graphDB';
import { ContextBuilder } from '../context/contextBuilder';
import { FileClassifier } from '../context/fileClassifier';
import { MCPLogger }      from './mcpLogger';
import { GraphNode }      from '../types';
import { isConfigPath, isNodeModulePath } from '../utils';

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

  if (/where is|find.*function|find.*class|locate|which file|what.*returns|signature of|definition of|import path/.test(t)) {
    return {
      tier: 2, label: 'Symbol lookup', cost: '~50 tokens', nextTool: 'codelens_search',
      instruction: 'Call codelens_search only. After it returns, read ONLY that file:line range.',
    };
  }

  if (/refactor|rename.*everywhere|move.*to|extract|change.*signature|update.*all.*call|migrate|replace.*across/.test(t)) {
    return {
      tier: 4, label: 'Cross-file refactor', cost: '~600-1200 tokens',
      nextTool: 'codelens_context + codelens_impact',
      instruction: 'Call codelens_context then codelens_impact. Read only files the graph specifies.',
    };
  }

  return {
    tier: 3, label: 'Feature / bug fix', cost: '~200-500 tokens', nextTool: 'codelens_context',
    instruction: 'Call codelens_context with your task. Read only the file:line locations returned.',
  };
}

// ─── MCPServer ────────────────────────────────────────────────────────────────

export class MCPServer {
  private server:    any;
  private transport: any;
  private logger!:   MCPLogger;

  constructor(private db: GraphDB, private contextBuilder: ContextBuilder) {}

  async start(workspaceRoot: string): Promise<void> {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { McpServer }          = require('@modelcontextprotocol/sdk/server/mcp.js');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { z } = require('zod');

    this.logger = new MCPLogger(workspaceRoot);

    this.server = new McpServer(
      { name: 'codelens-graph', version: '0.1.0' },
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
      schema: object,
      handler: (args: any) => Promise<{ content: Array<{ type: 'text'; text: string }> }>
    ) => {
      this.server.tool(name, description, schema, async (args: any) => {
        const t0     = Date.now();
        const result = await handler(args);
        const text   = result.content.map((c: any) => c.text).join('');
        this.logger.log(name, args, text, Date.now() - t0);
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
      { task: z.string().describe('What you are about to do, in plain English') },
      async ({ task }: { task: string }) => {
        const r     = classifyTask(task);
        const stats = this.db.getStats();
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
      'Search the full codebase for any symbol by name. '
      + 'Use for Tier 2 tasks or to verify a symbol does not exist before creating it. '
      + 'Returns exact file:line + signature. '
      + 'After this call, read ONLY that specific line range — never the whole file.',
      {
        query: z.string(),
        limit: z.number().optional().default(10),
        scope: z.enum(['workspace', 'deps', 'all']).optional().default('workspace')
      },
      async ({ query, limit, scope }: { query: string; limit?: number; scope?: 'workspace' | 'deps' | 'all' }) => {
        this.db.refreshFromDiskIfChanged();
        const results = this.db.searchNodes(query, limit ?? 10, scope ?? 'workspace');
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
      'Compressed codebase context for a feature/bugfix task (Tier 3). '
      + 'Returns relevant symbols with optional snippets, file:line, import paths, '
      + 'call relationships, duplicate warnings, and pre-diagnosed errors. '
      + 'ONE call replaces reading 3-10 files. '
      + 'After this, read ONLY the file:line locations specified.',
      {
        task:       z.string(),
        max_depth:  z.number().optional().default(2),
        max_tokens: z.number().optional().default(2500),
        mode:       z.enum(['short', 'deep']).optional().default('short'),
      },
      async ({ task, max_depth, max_tokens, mode }: { task: string; max_depth?: number; max_tokens?: number; mode: 'short' | 'deep' }) => {
        this.db.refreshFromDiskIfChanged();
        const ctx    = this.contextBuilder.build(task, max_depth ?? 2, max_tokens ?? 2500, mode);
        const output = this.contextBuilder.buildSystemPromptInjection(ctx, mode);
        const header = [
          '## CodeLens Context: "' + task + '" (' + mode + ' mode)',
          'Symbols: ' + ctx.subgraph.nodes.length + ' | ~' + ctx.tokenEstimate + ' tokens',
          'READ ONLY the file:line combinations listed — not whole files.',
          '',
        ].join('\n');
        return txt(header + output);
      }
    );

    // ── codelens_callers ──────────────────────────────────────────────────────

    tool(
      'codelens_callers',
      'Find all callers of a function. Use for Tier 4 tasks before modifying a shared API. '
      + 'Do NOT call for simple local fixes.',
      { symbol: z.string() },
      async ({ symbol }: { symbol: string }) => {
        this.db.refreshFromDiskIfChanged();
        const targets = this.db.searchNodes(symbol, 5).filter(n => n.name === symbol);
        if (!targets.length) { return txt('"' + symbol + '" not found in graph.'); }
        const lines: string[] = [];
        for (const t of targets) {
          const callers = this.db.getEdgesTo(t.id, 'calls')
            .map(e => this.db.getNode(e.fromId)).filter(Boolean) as GraphNode[];
          lines.push('## ' + t.name + ' @ ' + this.rel(t.filePath, workspaceRoot) + ':' + t.line);
          lines.push(callers.length
            ? callers.map(c => '  - ' + this.fmtNode(c, workspaceRoot)).join('\n')
            : '  No callers found in indexed codebase.');
          lines.push('');
        }
        return txt(lines.join('\n'));
      }
    );

    // ── codelens_callees ──────────────────────────────────────────────────────

    tool(
      'codelens_callees',
      'Find all functions a symbol calls. Use for Tier 4 or when understanding dependencies.',
      { symbol: z.string() },
      async ({ symbol }: { symbol: string }) => {
        this.db.refreshFromDiskIfChanged();
        const targets = this.db.searchNodes(symbol, 5).filter(n => n.name === symbol);
        if (!targets.length) { return txt('"' + symbol + '" not found.'); }
        const lines: string[] = [];
        for (const t of targets) {
          const callees = this.db.getEdgesFrom(t.id, 'calls')
            .map(e => this.db.getNode(e.toId)).filter(Boolean) as GraphNode[];
          lines.push('## ' + t.name + ' calls:');
          lines.push(callees.length
            ? callees.map(c => '  - ' + this.fmtNode(c, workspaceRoot)).join('\n')
            : '  No outgoing calls found.');
          lines.push('');
        }
        return txt(lines.join('\n'));
      }
    );

    // ── codelens_impact ───────────────────────────────────────────────────────

    tool(
      'codelens_impact',
      'Full impact radius of changing a symbol. Use for Tier 4 refactors ONLY — not bugfixes. '
      + 'Call BEFORE refactoring to understand what else will break.',
      { symbol: z.string(), depth: z.number().optional().default(3) },
      async ({ symbol, depth }: { symbol: string; depth?: number }) => {
        this.db.refreshFromDiskIfChanged();
        const targets = this.db.searchNodes(symbol, 3).filter(n => n.name === symbol);
        if (!targets.length) { return txt('"' + symbol + '" not found.'); }
        const t = targets[0];
        const { nodes, edges } = this.db.bfsExpand([t.id], depth ?? 3);
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
      'Full details + code snippet for one symbol. '
      + 'Use instead of read_file when you only need to inspect a single function body. '
      + 'Set with_snippet=true only when you need the actual code lines.',
      { symbol: z.string(), with_snippet: z.boolean().optional().default(false) },
      async ({ symbol, with_snippet }: { symbol: string; with_snippet?: boolean }) => {
        this.db.refreshFromDiskIfChanged();
        const results = this.db.searchNodes(symbol, 5).filter(n => n.name === symbol);
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
          const callerCount = this.db.getEdgesTo(node.id, 'calls').length;
          const calleeCount = this.db.getEdgesFrom(node.id, 'calls').length;
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
      'File structure grouped by category (routes, services, models, templates, utils...). '
      + 'Use instead of ls/find/directory scanning. Supply filter to narrow results.',
      {
        filter: z.string().optional(),
        scope: z.enum(['workspace', 'deps', 'all']).optional().default('workspace')
      },
      async ({ filter, scope }: { filter?: string; scope?: 'workspace' | 'deps' | 'all' }) => {
        this.db.refreshFromDiskIfChanged();
        const classifier = new FileClassifier();
        const allFiles   = this.db.getAllFiles(scope ?? 'workspace');
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
        queryType: z.enum(['info', 'exports', 'types', 'dependents']).optional().default('info').describe('What to retrieve: package info, exported symbols, type definitions, or files that import this package.')
      },
      async ({ packageName, queryType }: { packageName?: string; queryType?: 'info' | 'exports' | 'types' | 'dependents' }) => {
        this.db.refreshFromDiskIfChanged();
        
        if (packageName) {
          const matches = this.db.getNodesByType('file').filter(n => 
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
              this.db.getNodesByFile(m.filePath).filter(n => n.type !== 'file' && n.type !== 'import')
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
                const symbols = this.db.getNodesByFile(td.filePath).filter(n => n.type !== 'file' && n.type !== 'import');
                lines.push(...symbols.map(s => '  - [' + s.type + '] ' + s.name + ' @ line ' + s.line + ' ' + (s.signature ? '`' + s.signature.slice(0, 100) + '`' : '')));
                lines.push('');
              }
            }
          } else if (queryType === 'dependents') {
            const dependents = new Set<string>();
            for (const fileNode of matches) {
              const edges = this.db.getEdgesTo(fileNode.id, 'depends-on' as any);
              for (const edge of edges) {
                const node = this.db.getNode(edge.fromId);
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
          const allDeps = this.db.getAllFiles('deps');
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
              const pkgJsonNode = this.db.getNodesByType('file').find(n => 
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
      {},
      async () => {
        this.db.refreshFromDiskIfChanged();
        const stats  = this.db.getStats();
        const issues = this.db.getNodesWithUndefinedRefs().length;
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

    // ── Connect ───────────────────────────────────────────────────────────────

    this.transport = new StdioServerTransport();
    await this.server.connect(this.transport);
    console.error('[CodeLens MCP] Server ready — 10 tools on stdio');
  }

  async stop(): Promise<void> {
    this.logger?.summarise();
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
