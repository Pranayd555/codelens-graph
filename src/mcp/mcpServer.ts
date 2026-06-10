import * as path from 'path';
import * as fs   from 'fs';
import { GraphDB }        from '../graph/graphDB';
import { ContextBuilder } from '../context/contextBuilder';
import { FileClassifier } from '../context/fileClassifier';
import { GraphNode }      from '../types';

// ─── Task tier classifier ─────────────────────────────────────────────────────
// Determines the minimum CodeLens tooling required for a task, preventing
// agents from pulling full context for trivial edits.

interface TierResult {
  tier: 1 | 2 | 3 | 4;
  label: string;
  cost: string;
  nextTool: string | null;
  instruction: string;
}

function classifyTask(task: string): TierResult {
  const t = task.toLowerCase();

  if (/fix.*typo|spelling|add.*comment|format|indent|rename.*variable.*this|change.*string|update.*text|^what (is|does)|^explain|^describe/.test(t)) {
    return { tier: 1, label: 'Local edit', cost: '0 tokens', nextTool: null,
      instruction: 'No CodeLens call needed. Work directly on the open file.' };
  }
  if (/where is|find.*function|find.*class|locate|which file|what.*returns|signature of|definition of|import path/.test(t)) {
    return { tier: 2, label: 'Symbol lookup', cost: '~50 tokens', nextTool: 'codelens_search',
      instruction: 'Call codelens_search only. After it returns, read ONLY that file:line range — not the whole file.' };
  }
  if (/refactor|rename.*everywhere|move.*to|extract|delete|remove|change.*signature|update.*all.*call|migrate|replace.*across/.test(t)) {
    return { tier: 4, label: 'Cross-file refactor', cost: '~600-1200 tokens', nextTool: 'codelens_context+codelens_impact',
      instruction: 'Call codelens_context then codelens_impact. Read only files the graph specifies.' };
  }
  return { tier: 3, label: 'Feature / bug fix', cost: '~200-500 tokens', nextTool: 'codelens_context',
    instruction: 'Call codelens_context with your task. Read only the file:line locations it returns. Do not call codelens_impact.' };
}

// ─── MCPServer ────────────────────────────────────────────────────────────────

export class MCPServer {
  private server: any;
  private transport: any;

  constructor(private db: GraphDB, private contextBuilder: ContextBuilder) {}

  async start(workspaceRoot: string): Promise<void> {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { z } = require('zod');

    this.server = new McpServer(
      { name: 'codelens-graph', version: '0.1.0' },
      {
        instructions:
          'MANDATORY: Use CodeLens Graph tools for ALL codebase discovery. ' +
          'NEVER use grep, find, ls, or read_file to discover symbols, file structure, ' +
          'or call relationships — CodeLens provides this instantly and at a fraction of the token cost. ' +
          'WORKFLOW: (1) call codelens_triage first for every task — it tells you the minimum tool needed. ' +
          '(2) Use only the tool codelens_triage recommends. ' +
          '(3) Read ONLY the specific file:line locations CodeLens returns — never whole files. ' +
          '(4) Before creating any file or function, call codelens_search to verify it does not already exist. ' +
          'Token budget: codelens_triage=10, codelens_search=50, codelens_context=200-500, codelens_impact=600-1200. ' +
          'Skipping CodeLens for "small" tasks is forbidden — triage costs only 10 tokens and prevents all duplicates.',
      }
    );

    // ── codelens_triage ───────────────────────────────────────────────────────
    this.server.tool(
      'codelens_triage',
      'CALL THIS FIRST before any file operation or other CodeLens tool. ' +
      'Classifies the task into 4 tiers and returns the single minimum tool needed — or confirms ' +
      'no CodeLens call is required at all. Costs ~10 tokens. ' +
      'Tier 1 (typo/comment/format): no CodeLens needed. ' +
      'Tier 2 (find a symbol): codelens_search only. ' +
      'Tier 3 (feature/bugfix): codelens_context only. ' +
      'Tier 4 (refactor/rename/cross-file): codelens_context + codelens_impact.',
      { task: z.string().describe('What you are about to do, in plain English') },
      async ({ task }: { task: string }) => {
        const r     = classifyTask(task);
        const stats = this.db.getStats();
        const lines = [
          `## CodeLens Triage`,
          `Task: "${task}"`,
          `Tier ${r.tier} — ${r.label} | Cost: ${r.cost}`,
          `Action: ${r.instruction}`,
          '',
          r.tier === 1
            ? '✅ No CodeLens call needed. Proceed directly.'
            : `→ Next call: \`${r.nextTool}\``,
          '',
          `Graph: ${stats.totalNodes} symbols · ${stats.fileCount} files`,
        ];
        return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
      }
    );

    // ── codelens_search ───────────────────────────────────────────────────────
    this.server.tool(
      'codelens_search',
      'Search the full codebase for any symbol by name. ' +
      'Use for Tier 2 tasks or to verify a symbol does not already exist before creating it. ' +
      'Returns exact file:line + signature. ' +
      'After this, read ONLY the specific line range returned — never the whole file.',
      { query: z.string(), limit: z.number().optional().default(10) },
      async ({ query, limit }: { query: string; limit?: number }) => {
        this.db.refreshFromDiskIfChanged();
        const results = this.db.searchNodes(query, limit ?? 10);
        if (!results.length) {
          return { content: [{ type: 'text' as const, text: `No symbols found matching "${query}". Safe to create.` }] };
        }
        const text = [
          `Found ${results.length} symbol(s) matching "${query}":`,
          '',
          ...results.map(n => this.fmtNode(n, workspaceRoot)),
          '',
          '→ Read only the specific line(s) above.',
        ].join('\n');
        return { content: [{ type: 'text' as const, text }] };
      }
    );

    // ── codelens_context ──────────────────────────────────────────────────────
    this.server.tool(
      'codelens_context',
      'Get compressed codebase context for a feature or bugfix task (Tier 3). ' +
      'Returns: relevant symbols with code snippets, exact file:line, import paths, ' +
      'call relationships, file categories, duplicate warnings, and pre-diagnosed errors. ' +
      'ONE call replaces reading 3-10 files. ' +
      'After this, read ONLY the file:line locations specified — nothing more.',
      {
        task:       z.string(),
        max_depth:  z.number().optional().default(2),
        max_tokens: z.number().optional().default(2500),
      },
      async ({ task, max_depth, max_tokens }: { task: string; max_depth?: number; max_tokens?: number }) => {
        this.db.refreshFromDiskIfChanged();
        const ctx    = this.contextBuilder.build(task, max_depth ?? 2, max_tokens ?? 2500);
        const output = this.contextBuilder.buildSystemPromptInjection(ctx);
        const header = [
          `## CodeLens Context: "${task}"`,
          `Symbols: ${ctx.subgraph.nodes.length} | ~${ctx.tokenEstimate} tokens`,
          `⚠ Read ONLY the file:line combinations listed — not whole files.`,
          '',
        ].join('\n');
        return { content: [{ type: 'text' as const, text: header + output }] };
      }
    );

    // ── codelens_callers ──────────────────────────────────────────────────────
    this.server.tool(
      'codelens_callers',
      'Find all callers of a function. Use for Tier 4 tasks before modifying a shared API.',
      { symbol: z.string() },
      async ({ symbol }: { symbol: string }) => {
        this.db.refreshFromDiskIfChanged();
        const targets = this.db.searchNodes(symbol, 5).filter(n => n.name === symbol);
        if (!targets.length) {
          return { content: [{ type: 'text' as const, text: `"${symbol}" not found in graph` }] };
        }
        const lines: string[] = [];
        for (const t of targets) {
          const callers = this.db.getEdgesTo(t.id, 'calls')
            .map(e => this.db.getNode(e.fromId)).filter(Boolean) as GraphNode[];
          lines.push(`## ${t.name} @ ${this.rel(t.filePath, workspaceRoot)}:${t.line}`);
          lines.push(callers.length
            ? callers.map(c => `  - ${this.fmtNode(c, workspaceRoot)}`).join('\n')
            : '  No callers found in indexed codebase.');
          lines.push('');
        }
        return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
      }
    );

    // ── codelens_callees ──────────────────────────────────────────────────────
    this.server.tool(
      'codelens_callees',
      'Find all functions a symbol calls. Use for Tier 4 or when understanding dependencies.',
      { symbol: z.string() },
      async ({ symbol }: { symbol: string }) => {
        this.db.refreshFromDiskIfChanged();
        const targets = this.db.searchNodes(symbol, 5).filter(n => n.name === symbol);
        if (!targets.length) {
          return { content: [{ type: 'text' as const, text: `"${symbol}" not found` }] };
        }
        const lines: string[] = [];
        for (const t of targets) {
          const callees = this.db.getEdgesFrom(t.id, 'calls')
            .map(e => this.db.getNode(e.toId)).filter(Boolean) as GraphNode[];
          lines.push(`## ${t.name} calls:`);
          lines.push(callees.length
            ? callees.map(c => `  - ${this.fmtNode(c, workspaceRoot)}`).join('\n')
            : '  No outgoing calls found.');
          lines.push('');
        }
        return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
      }
    );

    // ── codelens_impact ───────────────────────────────────────────────────────
    this.server.tool(
      'codelens_impact',
      'Full impact radius of changing a symbol. Use for Tier 4 refactors ONLY — not bugfixes.',
      { symbol: z.string(), depth: z.number().optional().default(3) },
      async ({ symbol, depth }: { symbol: string; depth?: number }) => {
        this.db.refreshFromDiskIfChanged();
        const targets = this.db.searchNodes(symbol, 3).filter(n => n.name === symbol);
        if (!targets.length) {
          return { content: [{ type: 'text' as const, text: `"${symbol}" not found` }] };
        }
        const t = targets[0];
        const { nodes, edges } = this.db.bfsExpand([t.id], depth ?? 3);
        const impacted = nodes.filter(n => n.id !== t.id && edges.some(e => e.fromId === n.id || e.toId === n.id));
        const lines = [
          `## Impact: "${symbol}"`,
          `Definition: ${this.rel(t.filePath, workspaceRoot)}:${t.line}`,
          `Signature: ${t.signature?.slice(0, 120) ?? 'N/A'}`,
          '',
          `${impacted.length} affected symbol(s):`,
          ...impacted.map(n => `  - [${n.type}] ${n.name} @ ${this.rel(n.filePath, workspaceRoot)}:${n.line}`),
        ];
        if (t.undefinedRefs?.length) {
          lines.push('', `⚠️ Existing undefined refs: ${t.undefinedRefs.join(', ')}`);
        }
        return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
      }
    );

    // ── codelens_node ─────────────────────────────────────────────────────────
    this.server.tool(
      'codelens_node',
      'Get full details + code snippet for one symbol. ' +
      'Use instead of read_file when you need to inspect a single function body.',
      { symbol: z.string(), with_snippet: z.boolean().optional().default(false) },
      async ({ symbol, with_snippet }: { symbol: string; with_snippet?: boolean }) => {
        this.db.refreshFromDiskIfChanged();
        const results = this.db.searchNodes(symbol, 5).filter(n => n.name === symbol);
        if (!results.length) {
          return { content: [{ type: 'text' as const, text: `"${symbol}" not found` }] };
        }
        const lines: string[] = [];
        for (const node of results.slice(0, 3)) {
          lines.push(`## [${node.type}] ${node.name}`);
          lines.push(`- **File:** \`${this.rel(node.filePath, workspaceRoot)}:${node.line}\``);
          if (node.signature)  { lines.push(`- **Signature:** \`${node.signature.slice(0, 200)}\``); }
          if (node.returnType) { lines.push(`- **Returns:** \`${node.returnType}\``); }
          if (node.params?.length) {
            lines.push(`- **Params:** ${node.params.map(p => `\`${p.name}: ${p.type ?? '?'}\``).join(', ')}`);
          }
          const importStmt = this.buildImportStmt(node, workspaceRoot);
          if (importStmt) { lines.push(`- **Import as:** \`${importStmt}\``); }
          const callerCount = this.db.getEdgesTo(node.id, 'calls').length;
          const calleeCount = this.db.getEdgesFrom(node.id, 'calls').length;
          if (callerCount) { lines.push(`- **Callers:** ${callerCount} (run codelens_callers for list)`); }
          if (calleeCount) { lines.push(`- **Callees:** ${calleeCount} (run codelens_callees for list)`); }
          if (node.undefinedRefs?.length) {
            lines.push(`- **⚠️ Undefined refs:** \`${node.undefinedRefs.join('`, `')}\``);
          }
          if (with_snippet === true) {
            const snippet = this.readSnippet(node);
            if (snippet) { lines.push('', '```' + node.language, snippet, '```'); }
          }
          lines.push('');
        }
        return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
      }
    );

    // ── codelens_files ────────────────────────────────────────────────────────
    this.server.tool(
      'codelens_files',
      'File structure grouped by category (routes, services, models, templates, utils…). ' +
      'Use instead of ls/find/directory scanning. Supply filter to narrow results.',
      { filter: z.string().optional() },
      async ({ filter }: { filter?: string }) => {
        this.db.refreshFromDiskIfChanged();
        const classifier = new FileClassifier();
        const allFiles   = this.db.getAllFiles();
        const groups     = classifier.groupFiles(allFiles);
        const stats      = this.db.getStats();
        const lines      = [`## Workspace (${allFiles.length} files · ${stats.totalNodes} symbols)`, ''];
        for (const [label, files] of groups) {
          if (filter && !label.toLowerCase().includes(filter.toLowerCase()) &&
              !files.some(f => path.basename(f).toLowerCase().includes(filter.toLowerCase()))) {
            continue;
          }
          lines.push(`### ${label} (${files.length})`);
          lines.push(...files.map(f => `  - ${this.rel(f, workspaceRoot)}`));
          lines.push('');
        }
        return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
      }
    );

    // ── codelens_status ───────────────────────────────────────────────────────
    this.server.tool(
      'codelens_status',
      'Graph health and statistics. Call when results seem missing or stale.',
      {},
      async () => {
        this.db.refreshFromDiskIfChanged();
        const stats  = this.db.getStats();
        const issues = this.db.getNodesWithUndefinedRefs().length;
        const text   = [
          `## CodeLens Status`,
          `- Files indexed: ${stats.fileCount}`,
          `- Total symbols: ${stats.totalNodes}`,
          `- Relationships: ${stats.totalEdges}`,
          `- Symbols with undefined refs: ${issues}`,
          `- By type: ${Object.entries(stats.byType).map(([k,v]) => `${k}:${v}`).join(', ')}`,
        ].join('\n');
        return { content: [{ type: 'text' as const, text }] };
      }
    );

    this.transport = new StdioServerTransport();
    await this.server.connect(this.transport);
    console.error('[CodeLens MCP] Server ready — 9 tools on stdio');
  }

  async stop(): Promise<void> {
    try { await this.server?.close(); } catch { /* ignore */ }
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private rel(fp: string, root: string): string {
    return path.relative(root, fp).replace(/\\/g, '/');
  }

  private fmtNode(n: GraphNode, root: string): string {
    const sig  = n.signature ? `  →  ${n.signature.slice(0, 80)}` : '';
    const warn = n.undefinedRefs?.length ? `  ⚠️ undef:${n.undefinedRefs.join(',')}` : '';
    return `[${n.type}] ${n.name} @ ${this.rel(n.filePath, root)}:${n.line}${sig}${warn}`;
  }

  private buildImportStmt(node: GraphNode, root: string): string | null {
    if (node.type === 'file' || node.type === 'import') { return null; }
    const rel = './' + this.rel(node.filePath, root).replace(/\.(ts|tsx|js|jsx|mjs)$/, '');
    if (node.language === 'python') {
      return `from ${rel.replace(/^\.\//, '').replace(/\//g, '.')} import ${node.name}`;
    }
    return node.modifiers?.includes('default')
      ? `import ${node.name} from '${rel}';`
      : `import { ${node.name} } from '${rel}';`;
  }

  private readSnippet(node: GraphNode): string | null {
    try {
      const lines   = fs.readFileSync(node.filePath, 'utf-8').split('\n');
      const start   = Math.max(0, node.line - 1);
      const end     = Math.min(lines.length, Math.min(node.endLine ?? start + 15, start + 15));
      const snippet = lines.slice(start, end).join('\n');
      return snippet.length > 800 ? snippet.slice(0, 800) + '\n  // …' : snippet;
    } catch { return null; }
  }
}
