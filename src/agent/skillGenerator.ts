import * as fs   from 'fs';
import * as path from 'path';
import { GraphDB }    from '../graph/graphDB';
import { GraphStats } from '../types';

export class SkillGenerator {
  constructor(private db: GraphDB) {}

  generateAll(workspaceRoot: string, _stats: GraphStats): string[] {
    const written: string[] = [];
    const codelensDir = path.join(workspaceRoot, '.codelens');
    fs.mkdirSync(codelensDir, { recursive: true });

    fs.writeFileSync(path.join(codelensDir, 'README.md'), this.buildReadme(workspaceRoot), 'utf-8');
    written.push('.codelens/README.md');

    fs.writeFileSync(path.join(codelensDir, 'mcp.json'), this.buildMcpConfig(workspaceRoot), 'utf-8');
    written.push('.codelens/mcp.json');

    if (this.writeVsCodeMcpConfig(workspaceRoot)) { written.push('.vscode/mcp.json'); }

    // KEY FIX: write agent instruction files that the agents actually read automatically
    this.writeAgentInstructions(workspaceRoot, written);

    this.ensureGitignore(workspaceRoot);
    return written;
  }

  removeAll(workspaceRoot: string): void {
    const legacy = ['.cursor/rules/codelens.mdc','.cursorrules',
      '.github/copilot-instructions.md','.clinerules',
      '.vscode/codelens.instructions.md','CONVENTIONS.md'];
    for (const rel of legacy) {
      const fp = path.join(workspaceRoot, rel);
      if (!fs.existsSync(fp)) { continue; }
      try {
        const c = fs.readFileSync(fp,'utf-8');
        if (c.includes('CODELENS_MANAGED_START')) {
          const cleaned = this.removeManagedSection(c);
          if (cleaned.trim()) { fs.writeFileSync(fp, cleaned,'utf-8'); }
          else { fs.unlinkSync(fp); }
        }
      } catch { /* ignore */ }
    }
  }

  // ── Agent instruction files ───────────────────────────────────────────────
  // Each agent reads from a different path. We write ALL of them so whatever
  // agent the user has, it automatically picks up the instructions.

  private writeAgentInstructions(workspaceRoot: string, written: string[]): void {
    const stats       = this.db.getStats();
    const instruction = this.buildAgentInstruction(stats);

    // ── VS Code Copilot (.github/copilot-instructions.md) ────────────────────
    // Read automatically by GitHub Copilot Chat as workspace instructions
    const ghDir = path.join(workspaceRoot, '.github');
    fs.mkdirSync(ghDir, { recursive: true });
    const copilotPath = path.join(ghDir, 'copilot-instructions.md');
    this.mergeInstructions(copilotPath, instruction);
    written.push('.github/copilot-instructions.md');

    // ── Cursor (.cursor/rules/codelens.mdc) ───────────────────────────────────
    const cursorRulesDir = path.join(workspaceRoot, '.cursor', 'rules');
    fs.mkdirSync(cursorRulesDir, { recursive: true });
    const cursorPath = path.join(cursorRulesDir, 'codelens.mdc');
    fs.writeFileSync(cursorPath,
      '---\ndescription: CodeLens Graph — mandatory codebase search protocol\nalwaysApply: true\n---\n\n'
      + instruction, 'utf-8');
    written.push('.cursor/rules/codelens.mdc');

    // ── Cline / Roo Code (.clinerules) ───────────────────────────────────────
    const clinePath = path.join(workspaceRoot, '.clinerules');
    this.mergeInstructions(clinePath, instruction);
    written.push('.clinerules');

    // ── Trae / generic (.vscode/codelens.instructions.md) ────────────────────
    // VS Code reads .vscode/*.instructions.md as chat instructions
    const vscodeDir = path.join(workspaceRoot, '.vscode');
    fs.mkdirSync(vscodeDir, { recursive: true });
    fs.writeFileSync(
      path.join(vscodeDir, 'codelens.instructions.md'),
      '---\napplyTo: "**"\n---\n\n' + instruction,
      'utf-8'
    );
    written.push('.vscode/codelens.instructions.md');
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
- Tier 3 (feature/fix): \`codelens_context\` only  
- Tier 4 (refactor): \`codelens_context\` + \`codelens_impact\`

### RULE 2 — Never read files to discover structure
Use CodeLens tools instead of \`read_file\`, \`grep\`, \`find\`, or \`ls\`:
| Instead of | Use |
|---|---|
| \`grep -r "functionName"\` | \`codelens_search\` |
| \`ls src/\` or \`find . -name\` | \`codelens_files\` |
| Reading whole files to understand | \`codelens_context\` |
| Finding callers before refactor | \`codelens_callers\` |
| Checking what breaks | \`codelens_impact\` |

### RULE 3 — Read only what CodeLens points to
When CodeLens returns \`file:line\`, read only that specific line range.
Never read whole files. Never read files not listed in the graph response.

### RULE 4 — Check before creating
Before creating any new file or function, call \`codelens_search\` to verify
it does not already exist. Creating duplicates is the #1 source of bugs.

### RULE 5 — Update graph after changes
After making changes, the graph updates automatically on file save.
For large agent runs, call \`codelens_status\` to verify the index is current.

### Available tools (MCP server: codelens)
\`codelens_triage\` · \`codelens_search\` · \`codelens_context\`
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

  // ── .codelens/mcp.json ────────────────────────────────────────────────────

  private buildMcpConfig(workspaceRoot: string): string {
    const e = this.getMcpEntryPath();
    const p = this.toFwd(workspaceRoot);
    return JSON.stringify({
      _comment: 'CodeLens Graph MCP config — .vscode/mcp.json is auto-written, no action needed',
      vscode:      { servers: { codelens: { command: 'node', args: [e, p] } } },
      claude_code: { _add_to: '~/.claude.json', codelens: { type: 'stdio', command: 'node', args: [e, p] } },
      cursor:      { _add_to: '~/.cursor/mcp.json', codelens: { command: 'node', args: [e, p] } },
      cline:       { _add_to: 'Cline MCP Settings → Stdio', command: 'node', args: [e, p] },
    }, null, 2);
  }

  // ── .codelens/README.md ───────────────────────────────────────────────────

  private buildReadme(workspaceRoot: string): string {
    const e = this.getMcpEntryPath();
    const p = this.toFwd(workspaceRoot);
    return `# CodeLens Graph\n\nLocal codebase index. Auto-updated on every file save.\n\n`
      + `## MCP Config\n\`.vscode/mcp.json\` is written automatically — VS Code picks it up.\n\n`
      + `### Claude Code (~/.claude.json)\n\`\`\`json\n`
      + `{"mcpServers":{"codelens":{"type":"stdio","command":"node","args":["${e}","${p}"]}}}\n\`\`\`\n\n`
      + `### Cursor (.cursor/mcp.json)\n\`\`\`json\n`
      + `{"mcpServers":{"codelens":{"command":"node","args":["${e}","${p}"]}}}\n\`\`\`\n`;
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
