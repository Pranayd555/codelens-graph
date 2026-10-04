import * as fs   from 'fs';
import * as path from 'path';
import { GraphDB }    from '../graph/graphDB';
import { GraphStats } from '../types';

const MANAGED_START = '<!-- CODELENS_MANAGED_START -->';

// Agent rule files CodeLens manages. 'whole' files are owned by CodeLens;
// 'merge' files belong to the user and only carry a managed section.
const AGENT_RULE_FILES: Array<{ rel: string; ide?: string; mode: 'whole' | 'merge'; header?: string }> = [
  { rel: '.vscode/codelens.instructions.md', ide: 'vscode', mode: 'whole', header: '---\napplyTo: "**"\n---\n\n' },
  { rel: '.cursor/rules/codelens.mdc', ide: 'cursor', mode: 'whole',
    header: '---\ndescription: CodeLens Graph — mandatory codebase search protocol\nalwaysApply: true\n---\n\n' },
  { rel: '.agents/AGENTS.md', ide: 'antigravity', mode: 'merge' },
  { rel: 'CLAUDE.md',         ide: 'Claude',      mode: 'merge' },
  { rel: '.windsurfrules',    ide: 'Winsurf',     mode: 'merge' },
  // Written by older versions — only ever cleaned up now.
  { rel: '.cursorrules',                    mode: 'merge' },
  { rel: '.github/copilot-instructions.md', mode: 'merge' },
  { rel: '.clinerules',                     mode: 'merge' },
  { rel: 'CONVENTIONS.md',                  mode: 'merge' },
];

// Rewrites a file only when its content differs (line endings ignored), so
// regenerating configs on startup or after saves doesn't touch mtimes, git
// status, or other tools' file watchers.
function writeIfChanged(filePath: string, content: string): boolean {
  try {
    const existing = fs.readFileSync(filePath, 'utf-8');
    if (existing.replace(/\r\n/g, '\n') === content.replace(/\r\n/g, '\n')) { return false; }
  } catch { /* missing — write it */ }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf-8');
  return true;
}

export class SkillGenerator {
  constructor(private db: GraphDB) {}

  // CodeLens's own files under .codelens/. Safe to write before the user has
  // chosen any agent integrations — nothing outside .codelens/ is touched.
  writeInternalFiles(workspaceRoot: string, stats: GraphStats): string[] {
    const codelensDir = path.join(workspaceRoot, '.codelens');
    writeIfChanged(path.join(codelensDir, '.gitignore'), '*\n');
    writeIfChanged(path.join(codelensDir, 'README.md'), this.buildReadme(workspaceRoot));
    writeIfChanged(path.join(codelensDir, 'mcp.json'), this.buildMcpConfig(workspaceRoot));
    writeIfChanged(path.join(codelensDir, 'instructions.md'), this.buildInstructionsMd(stats));
    return ['.codelens/README.md', '.codelens/mcp.json', '.codelens/instructions.md'];
  }

  // Brings .codelens/ files, .vscode/mcp.json and every agent rule file in line
  // with the selection. Files are only rewritten when their content changes.
  // The index is kept out of git by .codelens/.gitignore, not the root .gitignore.
  generateAll(workspaceRoot: string, stats: GraphStats, selectedIdes: string[] = []): string[] {
    const written = this.writeInternalFiles(workspaceRoot, stats);

    if (selectedIdes.includes('vscode')) {
      if (this.writeVsCodeMcpConfig(workspaceRoot)) { written.push('.vscode/mcp.json'); }
    } else {
      this.removeVsCodeMcpConfig(workspaceRoot);
    }

    this.syncAgentInstructions(workspaceRoot, written, selectedIdes);
    return written;
  }

  clearAll(workspaceRoot: string): void {
    // 1. Clean up IDE rule files
    this.removeAll(workspaceRoot);

    // 2. Clean up VS Code MCP configuration
    this.removeVsCodeMcpConfig(workspaceRoot);

    // 3. Clean up .codelens folder files
    const codelensDir = path.join(workspaceRoot, '.codelens');
    try {
      if (fs.existsSync(codelensDir)) {
        fs.rmSync(codelensDir, { recursive: true, force: true });
      }
    } catch {
      // Fallback if rmSync fails (e.g. file lock or permissions issues)
      try {
        const files = fs.readdirSync(codelensDir);
        for (const file of files) {
          try { fs.unlinkSync(path.join(codelensDir, file)); } catch {}
        }
      } catch {}
    }

    // 4. Remove CodeLens entries from .gitignore
    this.removeGitignore(workspaceRoot);

    // 5. Delete directories if they are empty
    const dirsToCheck = [
      path.join(workspaceRoot, '.codelens'),
      path.join(workspaceRoot, '.agents'),
      path.join(workspaceRoot, '.cursor', 'rules'),
      path.join(workspaceRoot, '.cursor'),
      path.join(workspaceRoot, '.vscode'),
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
    for (const target of AGENT_RULE_FILES) {
      this.removeManagedSectionFrom(path.join(workspaceRoot, target.rel));
    }
  }

  // Strips the managed section; deletes the file if nothing meaningful remains.
  private removeManagedSectionFrom(filePath: string): void {
    if (!fs.existsSync(filePath)) { return; }
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      if (!content.includes(MANAGED_START)) { return; }
      const remaining = this.contentWithoutManagedSection(content);
      if (remaining) {
        writeIfChanged(filePath, remaining);
      } else {
        fs.unlinkSync(filePath);
      }
    } catch { /* ignore */ }
  }

  // What is left after removing the managed section, or '' when only
  // whitespace / frontmatter would remain.
  private contentWithoutManagedSection(content: string): string {
    const cleaned = this.removeManagedSection(content);
    const trimmed = cleaned.trim();
    const withoutFrontmatter = trimmed.replace(/^---[\s\S]*?---/, '').trim();
    return trimmed && withoutFrontmatter !== '' ? cleaned : '';
  }

  // ── Agent instruction files ───────────────────────────────────────────────

  private syncAgentInstructions(workspaceRoot: string, written: string[], selectedIdes: string[]): void {
    const instruction = this.buildAgentInstruction();
    for (const target of AGENT_RULE_FILES) {
      const filePath = path.join(workspaceRoot, target.rel);
      if (!target.ide || !selectedIdes.includes(target.ide)) {
        this.removeManagedSectionFrom(filePath);
        continue;
      }
      const desired = target.mode === 'whole'
        ? (target.header ?? '') + instruction
        : this.mergedInstructions(filePath, instruction);
      writeIfChanged(filePath, desired);
      written.push(target.rel);
    }
  }

  // Kept free of live numbers (symbol/file counts) so the files that embed it
  // don't change — and show up in git — after every save.
  private buildAgentInstruction(): string {
    return `<!-- CODELENS_MANAGED_START -->
## CodeLens Graph — Mandatory Search Protocol

This workspace has a live codebase knowledge graph via **CodeLens Graph** MCP, updated on every save.
Run \`codelens_status\` for current symbol and file counts.

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
      writeIfChanged(configPath, JSON.stringify(updated, null, 2) + '\n');
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
    const instruction = this.buildAgentInstruction();
    return `# CodeLens Graph — AI Agent Instructions

This file contains the mandatory search protocol and rules for AI agents using the CodeLens Graph MCP server.
The graph currently contains **${stats.totalNodes} symbols** across **${stats.fileCount} files**.
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

  // The user's file with the managed section replaced by newContent at the end.
  private mergedInstructions(filePath: string, newContent: string): string {
    let existing = '';
    try { existing = fs.readFileSync(filePath, 'utf-8'); } catch { /* new file */ }
    if (existing.includes(MANAGED_START)) {
      existing = this.contentWithoutManagedSection(existing);
    }
    return (existing.trimEnd() ? existing.trimEnd() + '\n\n' : '') + newContent + '\n';
  }

  private removeGitignore(workspaceRoot: string): void {
    const gp = path.join(workspaceRoot, '.gitignore');
    if (!fs.existsSync(gp)) { return; }
    try {
      const content = fs.readFileSync(gp, 'utf-8');
      const cleaned = content.replace(/\r?\n# CodeLens Graph local index\r?\n\.codelens\/\r?\n?/, '');
      if (cleaned !== content) {
        fs.writeFileSync(gp, cleaned, 'utf-8');
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
