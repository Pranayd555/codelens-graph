import { GraphDB } from './graphDB';
import { GraphNode, AgentContext, GraphEdge } from './types';

// ─── Token estimator ───────────────────────────────────────────────────────────
// Rough estimation: 1 token ≈ 4 characters for code/JSON

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// ─── Keyword extractor ─────────────────────────────────────────────────────────
// Pulls meaningful words from a natural language task description.
// Removes stop words, keeps identifiers and domain terms.

const STOP_WORDS = new Set([
  'the','a','an','and','or','but','in','on','at','to','for','of','with',
  'by','from','is','are','was','were','be','been','being','have','has',
  'had','do','does','did','will','would','could','should','may','might',
  'must','shall','can','need','i','we','you','it','this','that','these',
  'those','my','your','our','its','me','us','him','her','them','please',
  'make','create','add','update','fix','change','write','build','implement',
  'function','class','file','code','new','using','use','want','get','set',
]);

function extractKeywords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9_\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2 && !STOP_WORDS.has(w));
}

// ─── Context builder ───────────────────────────────────────────────────────────

export class ContextBuilder {
  constructor(private db: GraphDB) {}

  // ── Main entry point ───────────────────────────────────────────────────────
  // Given a natural-language task, produce a compressed AgentContext.

  build(taskDescription: string, maxDepth = 2, maxTokenBudget = 2000): AgentContext {
    const keywords = extractKeywords(taskDescription);

    // Step 1: Find entry-point nodes matching the keywords
    const entryNodes = this.findEntryPoints(keywords);

    // Step 2: BFS expand from entry points up to maxDepth hops
    const entryIds = entryNodes.map(n => n.id);
    const { nodes, edges } = this.db.bfsExpand(entryIds, maxDepth);

    // Step 3: Score and rank nodes by relevance to the task
    const scored = this.scoreNodes(nodes, keywords, taskDescription);

    // Step 4: Trim to token budget
    const { trimmedNodes, trimmedEdges } = this.trimToBudget(
      scored, edges, maxTokenBudget
    );

    // Step 5: Generate warnings about existing symbols
    const warnings = this.generateWarnings(trimmedNodes, taskDescription);

    // Step 6: Collect all existing file paths (so agent knows what exists)
    const existingFiles = this.db.getAllFiles();

    const context: AgentContext = {
      taskDescription,
      entryPoints: entryIds.slice(0, 10),
      subgraph: { nodes: trimmedNodes, edges: trimmedEdges },
      existingFiles,
      warnings,
      tokenEstimate: 0,
      generatedAt: Date.now(),
      diagnoses: []
    };

    context.tokenEstimate = estimateTokens(this.serialize(context));
    return context;
  }

  // ── Entry point discovery ─────────────────────────────────────────────────
  // Searches nodes by name/signature matching keywords.

  private findEntryPoints(keywords: string[]): GraphNode[] {
    const found = new Map<string, GraphNode>();

    for (const kw of keywords) {
      const results = this.db.searchNodes(kw, 10);
      for (const node of results) {
        if (!found.has(node.id)) { found.set(node.id, node); }
      }
    }

    return Array.from(found.values());
  }

  // ── Relevance scoring ─────────────────────────────────────────────────────
  // Score each node 0–100 based on how relevant it is to the task.

  private scoreNodes(
    nodes: GraphNode[],
    keywords: string[],
    task: string
  ): Array<{ node: GraphNode; score: number }> {
    return nodes.map(node => {
      let score = 0;
      const nameL = node.name.toLowerCase();
      const taskL = task.toLowerCase();

      // Exact name match in task text
      if (taskL.includes(nameL)) { score += 40; }

      // Keyword matches in name
      for (const kw of keywords) {
        if (nameL.includes(kw)) { score += 20; }
        if (node.signature?.toLowerCase().includes(kw)) { score += 10; }
        if (node.docComment?.toLowerCase().includes(kw)) { score += 5; }
      }

      // Prefer functions and classes over variables and imports
      const typePriority: Record<string, number> = {
        function: 15, method: 15, class: 12, interface: 10,
        type: 8, variable: 5, property: 3, import: 1, file: 2,
      };
      score += typePriority[node.type] ?? 0;

      // Exported symbols are more relevant
      if (node.modifiers?.includes('export')) { score += 8; }

      return { node, score };
    }).sort((a, b) => b.score - a.score);
  }

  // ── Token budget trimming ─────────────────────────────────────────────────
  // Keep the most relevant nodes until we hit the token budget.

  private trimToBudget(
    scored: Array<{ node: GraphNode; score: number }>,
    edges: GraphEdge[],
    budget: number
  ): { trimmedNodes: GraphNode[]; trimmedEdges: GraphEdge[] } {
    const trimmedNodes: GraphNode[] = [];
    const includedIds = new Set<string>();
    let tokenCount = 0;

    for (const { node } of scored) {
      const nodeJson = this.serializeNode(node);
      const nodeCost = estimateTokens(nodeJson);

      if (tokenCount + nodeCost > budget) { break; }

      trimmedNodes.push(node);
      includedIds.add(node.id);
      tokenCount += nodeCost;
    }

    // Only include edges where both endpoints are in the trimmed set
    const trimmedEdges = edges.filter(
      e => includedIds.has(e.fromId) && includedIds.has(e.toId)
    );

    return { trimmedNodes, trimmedEdges };
  }

  // ── Warning generation ────────────────────────────────────────────────────
  // Tell the agent what already exists to prevent duplicates.

  private generateWarnings(nodes: GraphNode[], task: string): string[] {
    const warnings: string[] = [];
    const taskL = task.toLowerCase();

    for (const node of nodes) {
      if (node.type === 'file') { continue; }

      // Warn if the symbol name appears in the task (likely to be re-created)
      if (taskL.includes(node.name.toLowerCase())) {
        const loc = `${node.filePath}:${node.line}`;
        warnings.push(
          `"${node.name}" (${node.type}) already exists at ${loc} — do not duplicate`
        );
      }
    }

    // Warn about existing files in relevant directories
    const allFiles = this.db.getAllFiles();
    const keywords = extractKeywords(task);
    for (const fp of allFiles) {
      for (const kw of keywords) {
        if (fp.toLowerCase().includes(kw)) {
          warnings.push(`File already exists: ${fp}`);
          break;
        }
      }
    }

    return [...new Set(warnings)]; // deduplicate
  }

  // ── Serialization ─────────────────────────────────────────────────────────
  // Produces the compact JSON that gets injected into the agent's system prompt.

  serialize(context: AgentContext): string {
    return JSON.stringify({
      task: context.taskDescription,
      entry_points: context.entryPoints,
      existing_files: context.existingFiles,
      warnings: context.warnings,
      symbols: context.subgraph.nodes
        .filter(n => n.type !== 'import') // imports add noise
        .map(n => this.serializeNode(n)),
      relationships: context.subgraph.edges.map(e => ({
        from: e.fromId.split('::')[1] ?? e.fromId, // just the name part
        type: e.type,
        to:   e.toId.split('::')[1]   ?? e.toId,
      })),
    }, null, 2);
  }

  private serializeNode(node: GraphNode): string {
    // Compact representation — only include non-null fields
    const compact: Record<string, unknown> = {
      name: node.name,
      type: node.type,
      file: node.filePath,
      line: node.line,
    };
    if (node.signature)   { compact['sig']      = node.signature; }
    if (node.returnType)  { compact['returns']   = node.returnType; }
    if (node.params?.length) { compact['params'] = node.params.map(p => `${p.name}:${p.type ?? '?'}`); }
    if (node.modifiers?.length) { compact['mods'] = node.modifiers; }
    if (node.docComment)  { compact['doc']       = node.docComment.slice(0, 100); }
    return JSON.stringify(compact);
  }

  // ── System prompt injection ────────────────────────────────────────────────
  // Returns the string to prepend to an agent's system prompt.

  buildSystemPromptInjection(context: AgentContext): string {
    const lines: string[] = [
      '## Codebase Context (CodeLens Graph)',
      `Generated: ${new Date(context.generatedAt).toISOString()}`,
      `Token estimate: ${context.tokenEstimate}`,
      '',
      '### Relevant symbols in this codebase:',
    ];

    for (const node of context.subgraph.nodes) {
      if (node.type === 'import' || node.type === 'file') { continue; }
      lines.push(
        `- [${node.type}] ${node.name} @ ${node.filePath}:${node.line}` +
        (node.signature ? `  →  ${node.signature.slice(0, 120)}` : '')
      );
    }

    if (context.subgraph.edges.length > 0) {
      lines.push('', '### Relationships:');
      for (const edge of context.subgraph.edges.slice(0, 30)) {
        const from = edge.fromId.split('::')[1] ?? edge.fromId;
        const to   = edge.toId.split('::')[1]   ?? edge.toId;
        lines.push(`- ${from} --[${edge.type}]--> ${to}`);
      }
    }

    if (context.warnings.length > 0) {
      lines.push('', '### ⚠️ Warnings — existing symbols (do not recreate):');
      for (const w of context.warnings) { lines.push(`- ${w}`); }
    }

    lines.push('', '### All files in workspace:');
    for (const f of context.existingFiles.slice(0, 50)) { lines.push(`- ${f}`); }
    if (context.existingFiles.length > 50) {
      lines.push(`  ... and ${context.existingFiles.length - 50} more`);
    }

    return lines.join('\n');
  }
}
