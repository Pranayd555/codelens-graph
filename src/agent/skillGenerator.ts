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

### RULE 1 — Always triage first (10 tokens)
Before ANY file operation, call \`codelens_triage\` with your task description.
It costs ~10 tokens and tells you the exact minimum tool needed.
- Tier 1 (typo/format): no tool needed
- Tier 2 (find a symbol): \`codelens_search\` only
- Tier 3 (feature/fix): \`codelens_context\` (defaults to \`short\` mode. If you need complete implementations/snippets, call with \`mode: "deep"\` to pull large context instead of reading files one-by-one)
- Tier 4 (refactor): \`codelens_context\` + \`codelens_impact\`

### RULE 2 — Never read files to discover structure
Use CodeLens tools instead of \`read_file\`, \`grep\`, \`find\`, or \`ls\`:
| Instead of | Use |
|---|---|
| \`grep -r "functionName"\` | \`codelens_search\` |
| \`ls src/\` or \`find . -name\` | \`codelens_files\` |
| Reading whole files to understand | \`codelens_context\` (use \`mode: "deep"\` to pull full code snippets instead of reading files one-by-one) |
| Finding callers before refactor | \`codelens_callers\` |
| Checking what breaks | \`codelens_impact\` |

### RULE 3 — Read only what CodeLens points to
When CodeLens returns \`file:line\`, read only that specific line range.
Never read whole files unless you pull them via \`codelens_context\` with \`mode: "deep"\`. Never read files not listed in the graph response.

### RULE 4 — Check before creating
Before creating any new file or function, call \`codelens_search\` to verify
it does not already exist. Creating duplicates is the #1 source of bugs.

### RULE 5 — Update graph after changes
After making changes, the graph updates automatically on file save.
For large agent runs, call \`codelens_status\` to verify the index is current.

### RULE 6 — Querying dependencies & configurations
Only look for dependencies, versions, type definitions, or config files (e.g. package.json, tsconfig.json, vite.config.ts) when asked or if context is missing.
Use \`codelens_search\` or \`codelens_files\` with \`scope: "deps"\` or \`codelens_dependencies\` to find them. Do NOT use regular search/files workspace scope.

### Available tools (MCP server: codelens)
\`codelens_triage\` · \`codelens_search\` · \`codelens_context\` · \`codelens_dependencies\`
\`codelens_callers\` · \`codelens_callees\` · \`codelens_impact\`
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
        codelens: { command: 'node', args: [this.getMcpEntryPath(), this.toFwd(workspaceRoot)] },
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
    const p = this.toFwd(workspaceRoot);
    return JSON.stringify({
      _comment: 'CodeLens Graph MCP config',
      vscode:      { servers: { codelens: { command: 'node', args: [e, p] } } },
      cursor:      { _add_to: '~/.cursor/mcp.json', codelens: { command: 'node', args: [e, p] } },
      Claude:      { _add_to: '~/.claude.json', codelens: { type: 'stdio', command: 'node', args: [e, p] } },
      Winsurf:     { _add_to: '~/.codeium/windsurf/mcp_config.json', codelens: { command: 'node', args: [e, p] } },
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
