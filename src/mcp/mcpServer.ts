import * as path from 'path';
import * as fs   from 'fs';
import { GraphDB }        from '../graph/graphDB';
import { ContextBuilder } from '../context/contextBuilder';
import { FileClassifier } from '../context/fileClassifier';
import { GraphNode }      from '../types';

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
          'CodeLens Graph is an on-demand full-codebase index. Do not call its tools automatically ' +
          'at the start of a task and do not request broad context when the relevant files or symbols ' +
          'are already known. Use it for codebase-wide symbol or file discovery, architecture search, ' +
          'call relationships, duplicate detection, and refactor impact analysis. Begin with the ' +
          'smallest focused query, then inspect only the source files needed to complete the task.',
      }
    );

    // ── codelens_search ───────────────────────────────────────────────────
    this.server.tool(
      'codelens_search',
      'Search the full indexed codebase for symbols when the definition or file is unknown, ' +
      'or when checking whether functionality already exists. Returns compact file:line matches. ' +
      'Do not call for a file or symbol whose exact location is already known.',
      { query: z.string(), limit: z.number().optional().default(15) },
      async ({ query, limit }: { query: string; limit?: number }) => {
        const results = this.db.searchNodes(query, limit ?? 15);
        if (!results.length) {
          return { content: [{ type: 'text' as const, text: `No symbols found matching "${query}"` }] };
        }
        const text = [`Found ${results.length} symbols:`, '',
          ...results.map(n => this.fmtNode(n, workspaceRoot))].join('\n');
        return { content: [{ type: 'text' as const, text }] };
      }
    );

    // ── codelens_context ──────────────────────────────────────────────────
    this.server.tool(
      'codelens_context',
      'On-demand context search across the codebase. Use only for broad exploration, unfamiliar ' +
      'architecture, cross-cutting work, or tasks whose relevant files and symbols are unknown. ' +
      'Do not call automatically at task start or for targeted questions about known files or symbols. ' +
      'Prefer codelens_search for discovery and focused graph tools for relationships or impact.',
      { task: z.string(), max_depth: z.number().optional().default(2), max_tokens: z.number().optional().default(3000) },
      async ({ task, max_depth, max_tokens }: { task: string; max_depth?: number; max_tokens?: number }) => {
        const ctx    = this.contextBuilder.build(task, max_depth ?? 2, max_tokens ?? 3000);
        const output = this.contextBuilder.buildSystemPromptInjection(ctx);
        const header = `## CodeLens: "${task}"\nSymbols: ${ctx.subgraph.nodes.length} | ~${ctx.tokenEstimate} tokens\n\n`;
        return { content: [{ type: 'text' as const, text: header + output }] };
      }
    );

    // ── codelens_callers ──────────────────────────────────────────────────
    this.server.tool(
      'codelens_callers',
      'Query the full graph for direct callers of a symbol. Use when call-site coverage matters, ' +
      'especially before changing a shared API. Do not call for isolated edits with known consumers.',
      { symbol: z.string() },
      async ({ symbol }: { symbol: string }) => {
        const targets = this.db.searchNodes(symbol, 5).filter(n => n.name === symbol);
        if (!targets.length) {
          return { content: [{ type: 'text' as const, text: `"${symbol}" not found` }] };
        }
        const lines: string[] = [];
        for (const t of targets) {
          const callers = this.db.getEdgesTo(t.id, 'calls')
            .map(e => this.db.getNode(e.fromId)).filter(Boolean) as GraphNode[];
          lines.push(`## ${t.name} @ ${this.rel(t.filePath, workspaceRoot)}:${t.line}`);
          lines.push(callers.length
            ? callers.map(c => `  - ${this.fmtNode(c, workspaceRoot)}`).join('\n')
            : '  No callers found.');
          lines.push('');
        }
        return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
      }
    );

    // ── codelens_callees ──────────────────────────────────────────────────
    this.server.tool(
      'codelens_callees',
      'Query the full graph for a symbol\'s direct dependencies. Use when its dependency chain is ' +
      'needed; do not call merely to inspect an already-known implementation.',
      { symbol: z.string() },
      async ({ symbol }: { symbol: string }) => {
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

    // ── codelens_impact ───────────────────────────────────────────────────
    this.server.tool(
      'codelens_impact',
      'Search the graph for the transitive impact radius of changing a symbol. Use for refactors, ' +
      'public API changes, or shared behavior; avoid it for small local edits.',
      { symbol: z.string(), depth: z.number().optional().default(3) },
      async ({ symbol, depth }: { symbol: string; depth?: number }) => {
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

    // ── codelens_node ─────────────────────────────────────────────────────
    this.server.tool(
      'codelens_node',
      'Get compact indexed details for one known symbol. Request with_snippet=true only when a short ' +
      'source excerpt can avoid a file read; otherwise keep the default metadata-only response.',
      { symbol: z.string(), with_snippet: z.boolean().optional().default(false) },
      async ({ symbol, with_snippet }: { symbol: string; with_snippet?: boolean }) => {
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
          if (callerCount) { lines.push(`- **Callers:** ${callerCount} (run codelens_callers)`); }
          if (calleeCount) { lines.push(`- **Callees:** ${calleeCount} (run codelens_callees)`); }
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

    // ── codelens_files ────────────────────────────────────────────────────
    this.server.tool(
      'codelens_files',
      'Search the indexed file structure by category or filename across the full codebase. Use when ' +
      'project layout or candidate files are unknown. Supply filter whenever possible and do not call ' +
      'to list files already known from the task or prior results.',
      { filter: z.string().optional() },
      async ({ filter }: { filter?: string }) => {
        const classifier = new FileClassifier();
        const allFiles   = this.db.getAllFiles();
        const groups     = classifier.groupFiles(allFiles);
        const stats      = this.db.getStats();
        const lines      = [`## Workspace (${allFiles.length} files, ${stats.totalNodes} symbols)`, ''];
        for (const [label, files] of groups) {
          if (filter && !label.toLowerCase().includes(filter.toLowerCase()) &&
              !files.some(f => path.basename(f).toLowerCase().includes(filter.toLowerCase()))) { continue; }
          lines.push(`### ${label} (${files.length})`);
          lines.push(...files.map(f => `  - ${this.rel(f, workspaceRoot)}`));
          lines.push('');
        }
        return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
      }
    );

    // ── codelens_status ───────────────────────────────────────────────────
    this.server.tool(
      'codelens_status',
      'Check index freshness and graph health when CodeLens results appear missing or stale. ' +
      'Do not call during normal task execution.',
      {},
      async () => {
        const stats    = this.db.getStats();
        const issues   = this.db.getNodesWithUndefinedRefs().length;
        const text = [
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
    console.error('[CodeLens MCP] Server ready on stdio');
  }

  async stop(): Promise<void> {
    try { await this.server?.close(); } catch { /* ignore */ }
  }

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
