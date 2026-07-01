import * as fs   from 'fs';
import * as path from 'path';
import { GraphDB }    from '../graph/graphDB';
import { GraphStats } from '../types';

export class SkillGenerator {
  constructor(private db: GraphDB) {}

  generateAll(workspaceRoot: string, _stats: GraphStats, selectedIdes: string[] = []): string[] {
    // First, clean up existing configurations/rules so we don't leave stale ones
    this.removeAll(workspaceRoot);

    const written: string[] = [];
    const codelensDir = path.join(workspaceRoot, '.codelens');
    fs.mkdirSync(codelensDir, { recursive: true });

    fs.writeFileSync(path.join(codelensDir, 'README.md'), this.buildReadme(workspaceRoot), 'utf-8');
    written.push('.codelens/README.md');

    fs.writeFileSync(path.join(codelensDir, 'mcp.json'), this.buildMcpConfig(workspaceRoot), 'utf-8');
    written.push('.codelens/mcp.json');

    // Write manual reference instructions
    fs.writeFileSync(path.join(codelensDir, 'instructions.md'), this.buildInstructionsMd(_stats), 'utf-8');
    written.push('.codelens/instructions.md');

    if (selectedIdes.includes('vscode')) {
      if (this.writeVsCodeMcpConfig(workspaceRoot)) { written.push('.vscode/mcp.json'); }
    } else {
      this.removeVsCodeMcpConfig(workspaceRoot);
    }

    // Write agent instruction rules for selected IDEs
    this.writeAgentInstructions(workspaceRoot, written, selectedIdes, _stats);

    this.ensureGitignore(workspaceRoot);
    return written;
  }

  clearAll(workspaceRoot: string): void {
    // 1. Clean up IDE rule files
    this.removeAll(workspaceRoot);

    // 2. Clean up VS Code MCP configuration
    this.removeVsCodeMcpConfig(workspaceRoot);

    // 3. Clean up .codelens folder files
    const codelensDir = path.join(workspaceRoot, '.codelens');
    const codelensFiles = [
      'README.md',
      'mcp.json',
      'instructions.md',
      'codelens-graph.db',
      'mcp-usage.jsonl'
    ];
    for (const file of codelensFiles) {
      const fp = path.join(codelensDir, file);
      if (fs.existsSync(fp)) {
        try { fs.unlinkSync(fp); } catch {}
      }
    }

    // 4. Delete directories if they are empty
    const dirsToCheck = [
      path.join(workspaceRoot, '.codelens'),
      path.join(workspaceRoot, '.agents'),
      path.join(workspaceRoot, '.cursor', 'rules'),
      path.join(workspaceRoot, '.cursor'),
    ];

    for (const dir of dirsToCheck) {
      if (fs.existsSync(dir)) {
        try {
          const files = fs.readdirSync(dir);
          if (files.length === 0) {
            fs.rmdirSync(dir);
          }
        } catch {}
      }
    }
  }

  removeAll(workspaceRoot: string): void {
    const legacy = [
      '.cursor/rules/codelens.mdc',
      '.cursorrules',
      '.github/copilot-instructions.md',
      '.clinerules',
      '.vscode/codelens.instructions.md',
      'CONVENTIONS.md',
      'CLAUDE.md',
      '.windsurfrules',
      '.agents/AGENTS.md'
    ];
    for (const rel of legacy) {
      const fp = path.join(workspaceRoot, rel);
      if (!fs.existsSync(fp)) { continue; }
      try {
        const c = fs.readFileSync(fp, 'utf-8');
        if (c.includes('CODELENS_MANAGED_START')) {
          const cleaned = this.removeManagedSection(c);
          const trimmed = cleaned.trim();
          
          // For .vscode/codelens.instructions.md, if only frontmatter remains, delete the file
          const isOnlyFrontmatter = rel === '.vscode/codelens.instructions.md' &&
            /^---\r?\napplyTo:\s*"[^"]*"\r?\n---$/i.test(trimmed);

          if (trimmed && !isOnlyFrontmatter) {
            fs.writeFileSync(fp, cleaned, 'utf-8');
          } else {
            fs.unlinkSync(fp);
          }
        }
      } catch { /* ignore */ }
    }
  }

  // ── Agent instruction files ───────────────────────────────────────────────

  private writeAgentInstructions(workspaceRoot: string, written: string[], selectedIdes: string[], stats: GraphStats): void {
    const instruction = this.buildAgentInstruction(stats);

    if (selectedIdes.includes('vscode')) {
      const vscodeDir = path.join(workspaceRoot, '.vscode');
      fs.mkdirSync(vscodeDir, { recursive: true });
      fs.writeFileSync(
        path.join(vscodeDir, 'codelens.instructions.md'),
        '---\napplyTo: "**"\n---\n\n' + instruction,
        'utf-8'
      );
      written.push('.vscode/codelens.instructions.md');
    }

    if (selectedIdes.includes('cursor')) {
      const cursorRulesDir = path.join(workspaceRoot, '.cursor', 'rules');
      fs.mkdirSync(cursorRulesDir, { recursive: true });
      const cursorPath = path.join(cursorRulesDir, 'codelens.mdc');
      fs.writeFileSync(cursorPath,
        '---\ndescription: CodeLens Graph — mandatory codebase search protocol\nalwaysApply: true\n---\n\n'
        + instruction, 'utf-8');
      written.push('.cursor/rules/codelens.mdc');
    }

    if (selectedIdes.includes('antigravity')) {
      const agentsDir = path.join(workspaceRoot, '.agents');
      fs.mkdirSync(agentsDir, { recursive: true });
      const agentsPath = path.join(agentsDir, 'AGENTS.md');
      this.mergeInstructions(agentsPath, instruction);
      written.push('.agents/AGENTS.md');
    }

    if (selectedIdes.includes('Claude')) {
      const claudePath = path.join(workspaceRoot, 'CLAUDE.md');
      this.mergeInstructions(claudePath, instruction);
      written.push('CLAUDE.md');
    }

    if (selectedIdes.includes('Winsurf')) {
      const windsurfPath = path.join(workspaceRoot, '.windsurfrules');
      this.mergeInstructions(windsurfPath, instruction);
      written.push('.windsurfrules');
    }
  }

  private buildAgentInstruction(stats: Omit<GraphStats, "lastBuilt" | "buildDurationMs"> & Partial<Pick<GraphStats, "lastBuilt" | "buildDurationMs">>): string {
    const nodeCount = (stats as any).totalNodes ?? 0;
    const fileCount = (stats as any).fileCount   ?? 0;

    return `<!-- CODELENS_MANAGED_START -->
## CodeLens Graph — Mandatory Search Protocol

This workspace has a live codebase knowledge graph via **CodeLens Graph** MCP.
The graph contains **${nodeCount} symbols** across **${fileCount} files**, updated on every save.

### RULE 1 — Triage first to establish the baseline
Before starting a task, call \`codelens_triage\` to classify it.
Use the triage response to pick the most efficient tool path. You have full flexibility to choose other tools as necessary:
- **Tier 1 (typo/formatting)**: No tools needed.
- **Tier 2 (symbol lookup / search)**: Call \`codelens_search\` (for classes, functions, types) or \`codelens_text_search\` (for strings, comments, local variables).
- **Tier 3 (features / bugfixes)**: Start with \`codelens_context\`. Use \`mode: "short"\` to quickly see the file/symbol map (cheapest), or \`mode: "deep"\` only if you need full implementations.
- **Tier 4 (refactoring)**: Use \`codelens_context\` + \`codelens_impact\` to map dependencies and prevent breaking changes.

### RULE 2 — Use specific tools instead of scanning files
Avoid generic workspace scans (grep, ls, find) or reading whole files. Use these targeted tools:
| Task / Need | Recommended Tool | Why It Saves Tokens |
|---|---|---|
| Locate symbol definition | \`codelens_search\` | Returns exact file:line + signature |
| Search text, comments, or strings | \`codelens_text_search\` | Searches line-by-line using fuzzy text index |
| Inspect 1 class/function code | \`codelens_node\` (with \`with_snippet: true\`) | Avoids reading the whole file containing it |
| Understand feature context | \`codelens_context\` | Returns a minimal subgraph of only related files |
| Find callers/callees of a function | \`codelens_relations\` | Lists callers, callees, or both for a given symbol |
| See transitive dependencies | \`codelens_impact\` | Automatically runs BFS to map the blast radius |
| Check directory structure | \`codelens_files\` | Returns category-grouped file list |

### RULE 3 — Read only what CodeLens points to
When CodeLens tools return a \`file:line\` range, read only that specific range using the \`view_file\` tool (with StartLine and EndLine).
Do NOT read whole files, and never read files that are not listed in the graph response.

### RULE 4 — Check before creating
Before writing a new function, class, or file, run \`codelens_search\` to ensure you are not creating a duplicate. Duplication is the #1 source of code rot.

### RULE 5 — Keep the graph updated
The knowledge graph is updated automatically on file save. You can run \`codelens_status\` to verify the index is healthy and up to date.

### RULE 6 — Query dependencies and configs strategically
Only search for package dependencies, type definitions, or configuration files (like package.json, tsconfig.json) when asked or if context is missing.
Use \`codelens_search\` or \`codelens_files\` with \`scope: "deps"\`, or use \`codelens_dependencies\` directly.

### Available tools (MCP server: codelens)
\`codelens_triage\` · \`codelens_search\` · \`codelens_context\` · \`codelens_dependencies\`
\`codelens_relations\` · \`codelens_impact\` · \`codelens_text_search\`
\`codelens_node\` · \`codelens_files\` · \`codelens_status\`
<!-- CODELENS_MANAGED_END -->`;
  }

  // ── MCP .vscode/mcp.json ──────────────────────────────────────────────────

  private writeVsCodeMcpConfig(workspaceRoot: string): boolean {
    const configPath = path.join(workspaceRoot, '.vscode', 'mcp.json');
    let existing: Record<string, unknown> = {};
    if (fs.existsSync(configPath)) {
      try { existing = JSON.parse(fs.readFileSync(configPath,'utf-8')); } catch { /* overwrite */ }
    }
    const updated = {
      ...existing,
      servers: {
        ...(existing['servers'] as Record<string,unknown> ?? {}),
        codelens: { command: 'node', args: [this.getMcpEntryPath(), '--auto'] },
      },
    };
    try {
      fs.mkdirSync(path.join(workspaceRoot, '.vscode'), { recursive: true });
      fs.writeFileSync(configPath, JSON.stringify(updated, null, 2) + '\n', 'utf-8');
      return true;
    } catch { return false; }
  }

  private removeVsCodeMcpConfig(workspaceRoot: string): void {
    const configPath = path.join(workspaceRoot, '.vscode', 'mcp.json');
    if (!fs.existsSync(configPath)) { return; }
    try {
      const existing = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      if (existing && existing.servers && existing.servers.codelens) {
        delete existing.servers.codelens;
        if (Object.keys(existing.servers).length === 0) {
          delete existing.servers;
        }
        if (Object.keys(existing).length === 0) {
          fs.unlinkSync(configPath);
        } else {
          fs.writeFileSync(configPath, JSON.stringify(existing, null, 2) + '\n', 'utf-8');
        }
      }
    } catch { /* ignore */ }
  }

  // ── .codelens/mcp.json ────────────────────────────────────────────────────

  private buildMcpConfig(workspaceRoot: string): string {
    const e = this.getMcpEntryPath();
    return JSON.stringify({
      _comment: 'CodeLens Graph MCP config',
      vscode:      { servers: { codelens: { command: 'node', args: [e, '--auto'] } } },
      cursor:      { _add_to: '~/.cursor/mcp.json', codelens: { command: 'node', args: [e, '--auto'] } },
      Claude:      { _add_to: '~/.claude.json', codelens: { type: 'stdio', command: 'node', args: [e, '--auto'] } },
      Winsurf:     { _add_to: '~/.codeium/windsurf/mcp_config.json', codelens: { command: 'node', args: [e, '--auto'] } },
    }, null, 2);
  }

  // ── .codelens/README.md ───────────────────────────────────────────────────

  private buildReadme(workspaceRoot: string): string {
    return `# CodeLens Graph\n\nLocal codebase index. Auto-updated on every file save.\n\n`
      + `## Configuration & Rules\n`
      + `Please refer to the following files in this directory for setting up your AI agent:\n`
      + `- [instructions.md](file:///${this.toFwd(workspaceRoot)}/.codelens/instructions.md) — Custom instruction rules for different IDEs.\n`
      + `- [mcp.json](file:///${this.toFwd(workspaceRoot)}/.codelens/mcp.json) — MCP server configurations for all supported IDEs.\n`;
  }

  // ── .codelens/instructions.md ─────────────────────────────────────────────

  private buildInstructionsMd(stats: GraphStats): string {
    const instruction = this.buildAgentInstruction(stats);
    return `# CodeLens Graph — AI Agent Instructions

This file contains the mandatory search protocol and rules for AI agents using the CodeLens Graph MCP server.
You can copy the contents of the rules section below and add them to your IDE's custom instructions or rules file.

## Manual Rule Setup Guide

- **VS Code (Copilot / Trae)**: Create a file at \`.vscode/codelens.instructions.md\` with:
  \`\`\`markdown
  ---
  applyTo: "**"
  ---

  <Paste the Rules Section here>
  \`\`\`

- **Cursor**: Create a rule file at \`.cursor/rules/codelens.mdc\` with:
  \`\`\`markdown
  ---
  description: CodeLens Graph — mandatory codebase search protocol
  alwaysApply: true
  ---

  <Paste the Rules Section here>
  \`\`\`

- **Antigravity**: Append/merge the Rules Section into \`.agents/AGENTS.md\` in your project root.

- **Claude Code**: Append/merge the Rules Section into \`CLAUDE.md\` in your project root.

- **Windsurf (Cascade)**: Append/merge the Rules Section into \`.windsurfrules\` in your project root.

---

## Rules Section

${instruction}
`;
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private getMcpEntryPath(): string {
    return path.resolve(__dirname, 'mcp.js').replace(/\\/g, '/');
  }

  private toFwd(p: string): string { return p.replace(/\\/g, '/'); }

  private mergeInstructions(filePath: string, newContent: string): void {
    let existing = '';
    if (fs.existsSync(filePath)) {
      try { existing = fs.readFileSync(filePath, 'utf-8'); } catch { /* overwrite */ }
    }
    if (existing.includes('CODELENS_MANAGED_START')) {
      existing = this.removeManagedSection(existing);
    }
    const merged = (existing.trimEnd() ? existing.trimEnd() + '\n\n' : '') + newContent + '\n';
    fs.writeFileSync(filePath, merged, 'utf-8');
  }

  private ensureGitignore(workspaceRoot: string): void {
    const gp = path.join(workspaceRoot, '.gitignore');
    try {
      const ex = fs.existsSync(gp) ? fs.readFileSync(gp,'utf-8') : '';
      if (!ex.includes('.codelens/')) {
        fs.appendFileSync(gp, '\n# CodeLens Graph local index\n.codelens/\n','utf-8');
      }
    } catch { /* ignore */ }
  }

  private removeManagedSection(content: string): string {
    const s = content.indexOf('<!-- CODELENS_MANAGED_START -->');
    const e = content.indexOf('<!-- CODELENS_MANAGED_END -->');
    if (s === -1 || e === -1) { return content; }
    return (content.slice(0, s).trimEnd() + '\n'
          + content.slice(e + '<!-- CODELENS_MANAGED_END -->'.length).trimStart()).trim();
  }
}
