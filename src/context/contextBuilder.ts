import * as path    from 'path';
import { GraphDB }  from '../graph/graphDB';
import { GraphNode, AgentContext, GraphEdge, Diagnosis } from '../types';
import { SnippetExtractor } from './snippetExtractor';
import { FileClassifier }   from './fileClassifier';

// ─── Token estimator ──────────────────────────────────────────────────────────
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// ─── Stop words ───────────────────────────────────────────────────────────────
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

// ─── ContextBuilder ───────────────────────────────────────────────────────────

export class ContextBuilder {
  private snippets    = new SnippetExtractor();
  private classifier  = new FileClassifier();

  constructor(private db: GraphDB) {}

  // ── Main build ────────────────────────────────────────────────────────────

  build(taskDescription: string, maxDepth = 2, maxTokenBudget = 2000): AgentContext {
    const keywords   = extractKeywords(taskDescription);
    const entryNodes = this.findEntryPoints(keywords);
    const entryIds   = entryNodes.map(n => n.id);

    const { nodes, edges } = this.db.bfsExpand(entryIds, maxDepth);
    const scored           = this.scoreNodes(nodes, keywords, taskDescription);
    const { trimmedNodes, trimmedEdges } = this.trimToBudget(scored, edges, maxTokenBudget);

    // ── IMPROVEMENT 3: rich warnings with exact location + snippet ────────────
    const warnings   = this.generateWarnings(trimmedNodes, taskDescription);

    // ── IMPROVEMENT 4: category hints so agent finds files without grep ───────
    const existingFiles   = this.db.getAllFiles();

    // ── IMPROVEMENT 1+2: diagnoses include import path + undefined refs ───────
    const diagnoses  = this.buildDiagnoses(trimmedNodes, taskDescription);

    const context: AgentContext = {
      taskDescription,
      entryPoints: entryIds.slice(0, 10),
      subgraph: { nodes: trimmedNodes, edges: trimmedEdges },
      existingFiles,
      warnings,
      diagnoses,
      tokenEstimate: 0,
      generatedAt: Date.now(),
    };

    context.tokenEstimate = estimateTokens(this.buildSystemPromptInjection(context));
    return context;
  }

  // ── Entry point discovery ─────────────────────────────────────────────────

  private findEntryPoints(keywords: string[]): GraphNode[] {
    const found = new Map<string, GraphNode>();
    for (const kw of keywords) {
      for (const node of this.db.searchNodes(kw, 10)) {
        if (!found.has(node.id)) { found.set(node.id, node); }
      }
    }
    return Array.from(found.values());
  }

  // ── Relevance scoring ─────────────────────────────────────────────────────

  private scoreNodes(
    nodes: GraphNode[],
    keywords: string[],
    task: string
  ): Array<{ node: GraphNode; score: number }> {
    return nodes.map(node => {
      let score  = 0;
      const nameL = node.name.toLowerCase();
      const taskL = task.toLowerCase();

      if (taskL.includes(nameL))          { score += 40; }
      for (const kw of keywords) {
        if (nameL.includes(kw))                           { score += 20; }
        if (node.signature?.toLowerCase().includes(kw))  { score += 10; }
        if (node.docComment?.toLowerCase().includes(kw)) { score += 5;  }
      }

      const typePriority: Record<string, number> = {
        function: 15, method: 15, class: 12, interface: 10,
        type: 8, variable: 5, property: 3, import: 1, file: 2,
      };
      score += typePriority[node.type] ?? 0;
      if (node.modifiers?.includes('export')) { score += 8; }

      return { node, score };
    }).sort((a, b) => b.score - a.score);
  }

  // ── Token budget trimming ─────────────────────────────────────────────────

  private trimToBudget(
    scored: Array<{ node: GraphNode; score: number }>,
    edges: GraphEdge[],
    budget: number
  ): { trimmedNodes: GraphNode[]; trimmedEdges: GraphEdge[] } {
    const trimmedNodes: GraphNode[] = [];
    const includedIds  = new Set<string>();
    let   tokenCount   = 0;

    for (const { node } of scored) {
      const cost = estimateTokens(this.serializeNodeCompact(node));
      if (tokenCount + cost > budget) { break; }
      trimmedNodes.push(node);
      includedIds.add(node.id);
      tokenCount += cost;
    }

    return {
      trimmedNodes,
      trimmedEdges: edges.filter(e => includedIds.has(e.fromId) && includedIds.has(e.toId)),
    };
  }

  // ── IMPROVEMENT 3: Warnings with exact context ────────────────────────────
  // Now includes: exact file:line, the signature, and which callers use it.

  private generateWarnings(nodes: GraphNode[], task: string): string[] {
    const warnings: string[] = [];
    const taskL    = task.toLowerCase();
    const keywords = extractKeywords(task);

    for (const node of nodes) {
      if (node.type === 'file' || node.type === 'import') { continue; }

      if (taskL.includes(node.name.toLowerCase())) {
        // Get callers from the graph for richer context
        const callerEdges = this.db.getEdgesTo(node.id, 'calls');
        const callerNames = callerEdges
          .map(e => this.db.getNode(e.fromId)?.name)
          .filter(Boolean)
          .slice(0, 3);

        const relPath  = node.filePath.replace(/\\/g, '/').split('/').slice(-3).join('/');
        let warning    = `"${node.name}" (${node.type}) already exists at .../${relPath}:${node.line}`;

        if (node.signature) {
          warning += `\n    Signature: ${node.signature.slice(0, 120)}`;
        }
        if (callerNames.length > 0) {
          warning += `\n    Called by: ${callerNames.join(', ')}`;
        }
        if (node.modifiers?.includes('export')) {
          warning += `\n    Already exported — import it, do not recreate`;
        }

        warnings.push(warning);
      }
    }

    // File-level warnings with category context
    const allFiles = this.db.getAllFiles();
    for (const fp of allFiles) {
      const basename = path.basename(fp).toLowerCase();
      for (const kw of keywords) {
        if (basename.includes(kw)) {
          const category = this.classifier.classify(fp);
          const relPath  = fp.replace(/\\/g, '/').split('/').slice(-3).join('/');
          warnings.push(`File already exists [${category}]: .../${relPath}`);
          break;
        }
      }
    }

    return [...new Set(warnings)];
  }

  // ── IMPROVEMENT 1+2: Diagnoses with snippets + import paths ──────────────
  // Builds concrete actionable items for the agent.

  private buildDiagnoses(nodes: GraphNode[], task: string): Diagnosis[] {
    const diagnoses: Diagnosis[] = [];

    for (const node of nodes) {
      // Undefined reference diagnosis — the genAI-style bugs
      if (node.undefinedRefs?.length) {
        for (const ref of node.undefinedRefs) {
          // Try to find where this ref IS defined in the codebase
          const definedIn = this.db.searchNodes(ref, 3)
            .filter(n => n.type !== 'import' && n.name === ref);

          const suggestion = definedIn.length > 0
            ? `"${ref}" is defined in ${definedIn[0].filePath}:${definedIn[0].line}. ` +
              `Add: ${this.snippets.buildImportStatement(definedIn[0], node.filePath, node.language)}`
            : `"${ref}" is not defined anywhere in the codebase — check spelling or add the definition`;

          diagnoses.push({
            severity:  'error',
            type:      'undefined_ref',
            message:   `"${node.name}" uses "${ref}" which is not imported or declared`,
            filePath:  node.filePath,
            line:      node.line,
            symbol:    ref,
            suggestion,
          });
        }
      }

      // Duplicate symbol warning — check if something with this name exists
      // in multiple files (common copy-paste problem)
      const taskL = task.toLowerCase();
      if (taskL.includes(node.name.toLowerCase()) && node.type !== 'file') {
        const duplicates = this.db.searchNodes(node.name, 5)
          .filter(n => n.name === node.name && n.id !== node.id && n.type === node.type);

        if (duplicates.length > 0) {
          const locations = duplicates
            .map(d => `${d.filePath.split('/').slice(-2).join('/')}:${d.line}`)
            .join(', ');

          diagnoses.push({
            severity:   'warning',
            type:       'duplicate_symbol',
            message:    `"${node.name}" (${node.type}) exists in ${duplicates.length + 1} places: ${locations}`,
            filePath:   node.filePath,
            line:       node.line,
            symbol:     node.name,
            suggestion: `Use the existing one at ${node.filePath}:${node.line} — do not create another`,
          });
        }
      }
    }

    return diagnoses;
  }

  // ── IMPROVEMENT 1: System prompt injection with snippets + relations ──────

  buildSystemPromptInjection(context: AgentContext): string {
    const lines: string[] = [
      '## Codebase Context (CodeLens Graph)',
      `Generated: ${new Date(context.generatedAt).toISOString()}`,
      `Token estimate: ~${context.tokenEstimate}`,
      '',
    ];

    // ── IMPROVEMENT 4: Category-based file map at the top ─────────────────
    const keywords     = extractKeywords(context.taskDescription);
    const categoryHint = this.classifier.buildCategoryHint(context.existingFiles, keywords);
    if (categoryHint) {
      lines.push('### File map (by category):');
      lines.push(categoryHint);
      lines.push('');
    }

    // ── IMPROVEMENT 1: Symbols with snippet + IMPROVEMENT 2: import path ──
    lines.push('### Relevant symbols:');
    lines.push('');

    for (const node of context.subgraph.nodes) {
      if (node.type === 'import' || node.type === 'file') { continue; }

      const relPath = node.filePath.replace(/\\/g, '/').split('/').slice(-3).join('/');

      // Header line: type, name, location
      lines.push(`#### [${node.type}] \`${node.name}\``);
      lines.push(`- **Location:** \`.../${relPath}:${node.line}\``);

      // IMPROVEMENT 2: Import path — tell agent exactly how to import this
      const importStmt = this.snippets.buildImportStatement(node, node.filePath, node.language);
      lines.push(`- **Import as:** \`${importStmt}\``);

      // Signature
      if (node.signature) {
        lines.push(`- **Signature:** \`${node.signature.slice(0, 150)}\``);
      }

      // Return type + params
      if (node.returnType) { lines.push(`- **Returns:** \`${node.returnType}\``); }
      if (node.params?.length) {
        lines.push(`- **Params:** ${node.params.map(p => `\`${p.name}: ${p.type ?? '?'}\``).join(', ')}`);
      }

      // IMPROVEMENT 1: Callers and callees in one shot ("used by / depends on")
      const callerEdges = context.subgraph.edges.filter(e => e.toId === node.id   && e.type === 'calls');
      const calleeEdges = context.subgraph.edges.filter(e => e.fromId === node.id && e.type === 'calls');

      if (callerEdges.length > 0) {
        const callers = callerEdges
          .map(e => context.subgraph.nodes.find(n => n.id === e.fromId)?.name)
          .filter(Boolean).join(', ');
        lines.push(`- **Used by:** ${callers}`);
      }
      if (calleeEdges.length > 0) {
        const callees = calleeEdges
          .map(e => context.subgraph.nodes.find(n => n.id === e.toId)?.name)
          .filter(Boolean).join(', ');
        lines.push(`- **Calls:** ${callees}`);
      }

      // Undefined refs warning inline on the symbol
      if (node.undefinedRefs?.length) {
        lines.push(`- **⚠️ Undefined refs:** \`${node.undefinedRefs.join('`, `')}\``);
      }

      // IMPROVEMENT 1: Actual code snippet — eliminates the file read
      const snippet = this.snippets.extractSnippet(node);
      if (snippet) {
        lines.push('- **Snippet:**');
        lines.push('```' + node.language);
        lines.push(snippet);
        lines.push('```');
      }

      lines.push('');
    }

    // ── IMPROVEMENT 3: Warnings with full context ─────────────────────────
    if (context.warnings.length > 0) {
      lines.push('### ⚠️ Existing symbols — do not recreate:');
      lines.push('');
      for (const w of context.warnings) { lines.push(`- ${w}`); }
      lines.push('');
    }

    // ── Diagnoses (errors the graph already found) ────────────────────────
    const errors   = context.diagnoses.filter(d => d.severity === 'error');
    const warnings = context.diagnoses.filter(d => d.severity === 'warning');

    if (errors.length > 0) {
      lines.push('### 🔴 Errors to fix:');
      for (const d of errors) {
        lines.push(`- **${d.message}**`);
        if (d.suggestion) { lines.push(`  → Fix: ${d.suggestion}`); }
      }
      lines.push('');
    }

    if (warnings.length > 0) {
      lines.push('### 🟡 Warnings:');
      for (const d of warnings) {
        lines.push(`- ${d.message}`);
        if (d.suggestion) { lines.push(`  → ${d.suggestion}`); }
      }
      lines.push('');
    }

    // ── All files (compact, categorised) ─────────────────────────────────
    lines.push('### All workspace files:');
    const groups = this.classifier.groupFiles(context.existingFiles);
    for (const [label, files] of groups) {
      lines.push(`**${label}:** ${files.map(f => path.basename(f)).join(', ')}`);
    }

    return lines.join('\n');
  }

  // ── Compact node serializer (for token budget counting) ───────────────────

  private serializeNodeCompact(node: GraphNode): string {
    const compact: Record<string, unknown> = {
      name: node.name, type: node.type, file: node.filePath, line: node.line,
    };
    if (node.signature)        { compact['sig']     = node.signature.slice(0, 100); }
    if (node.returnType)       { compact['returns'] = node.returnType; }
    if (node.params?.length)   { compact['params']  = node.params.map(p => `${p.name}:${p.type ?? '?'}`); }
    if (node.undefinedRefs?.length) { compact['undefs'] = node.undefinedRefs; }
    return JSON.stringify(compact);
  }

  // Keep for backward compat (used by extension.ts showContext command)
  serialize(context: AgentContext): string {
    return this.buildSystemPromptInjection(context);
  }
}
