import * as fs   from 'fs';
import * as path from 'path';
import { GraphDB }    from '../graph/graphDB';
import { GraphStats } from '../types';

// ─── SkillGenerator ───────────────────────────────────────────────────────────
// Previously wrote rules files into the user's repo.
// Now: writes only a single .codelens/mcp.json config file showing how to
// connect the MCP server. No rules files, no repo pollution.
//
// The agent gets context through MCP tools natively — no skill file needed.

export class SkillGenerator {
  constructor(private db: GraphDB) {}

  // ── Generate only the MCP config hint file ────────────────────────────────
  // Written to .codelens/ (gitignored) — not scattered across the repo.

  generateAll(workspaceRoot: string, _stats: GraphStats): string[] {
    const written: string[] = [];
    const codelensDir = path.join(workspaceRoot, '.codelens');
    fs.mkdirSync(codelensDir, { recursive: true });

    // .codelens/README.md — tells developers how to connect the MCP server
    const readmePath = path.join(codelensDir, 'README.md');
    fs.writeFileSync(readmePath, this.buildReadme(workspaceRoot), 'utf-8');
    written.push('.codelens/README.md');

    // .codelens/mcp.json — ready-to-paste MCP config for Claude Code / Cursor
    const mcpConfigPath = path.join(codelensDir, 'mcp.json');
    fs.writeFileSync(mcpConfigPath, this.buildMcpConfig(workspaceRoot), 'utf-8');
    written.push('.codelens/mcp.json');

    // Ensure .codelens/ is gitignored (db + context files stay local)
    this.ensureGitignore(workspaceRoot);

    return written;
  }

  // ── Remove all previously written rule files (cleanup) ───────────────────

  removeAll(workspaceRoot: string): void {
    const legacyPaths = [
      '.cursor/rules/codelens.mdc',
      '.cursorrules',
      '.github/copilot-instructions.md',
      '.clinerules',
      '.vscode/codelens.instructions.md',
      'CONVENTIONS.md',
    ];

    for (const relPath of legacyPaths) {
      const fullPath = path.join(workspaceRoot, relPath);
      if (!fs.existsSync(fullPath)) { continue; }
      try {
        const content = fs.readFileSync(fullPath, 'utf-8');
        if (content.includes('CODELENS_MANAGED_START')) {
          // Our content only — delete the file
          const cleaned = this.removeManagedSection(content);
          if (cleaned.trim()) {
            fs.writeFileSync(fullPath, cleaned, 'utf-8');
          } else {
            fs.unlinkSync(fullPath);
          }
        }
      } catch { /* ignore */ }
    }
  }

  // ── MCP config JSON ───────────────────────────────────────────────────────

  private buildMcpConfig(workspaceRoot: string): string {
    // Find the compiled mcpEntry.js — works whether installed globally or locally
    const entryPath = path.join(__dirname, '..', '..', 'out', 'mcp', 'mcpEntry.js');

    const config = {
      _comment: 'CodeLens Graph MCP Server config — copy the relevant section to your agent config',
      claude_code: {
        _add_to: '~/.claude.json under mcpServers',
        codelens: {
          type:    'stdio',
          command: 'node',
          args:    [entryPath, workspaceRoot],
        },
      },
      cursor: {
        _add_to: '.cursor/mcp.json in your project',
        codelens: {
          command: 'node',
          args:    [entryPath, workspaceRoot],
        },
      },
      cline: {
        _add_to: 'Cline MCP settings → Add Server',
        command: 'node',
        args:    [entryPath, workspaceRoot],
      },
    };

    return JSON.stringify(config, null, 2);
  }

  // ── README for .codelens/ ─────────────────────────────────────────────────

  private buildReadme(workspaceRoot: string): string {
    const entryPath = path.join(__dirname, '..', '..', 'out', 'mcp', 'mcpEntry.js')
      .replace(/\\/g, '/');

    return `# CodeLens Graph

This directory contains the CodeLens Graph index for this project.

## Files
- \`codelens-graph.db\` — SQLite graph database (all symbols + relationships)
- \`mcp.json\` — MCP server connection config (copy to your agent)
- \`agent-context.md\` — Last generated agent context (written on demand)

## Connecting your AI agent

### Claude Code
Add to \`~/.claude.json\`:
\`\`\`json
{
  "mcpServers": {
    "codelens": {
      "type": "stdio",
      "command": "node",
      "args": ["${entryPath}", "${workspaceRoot.replace(/\\/g, '/')}"]
    }
  }
}
\`\`\`

### Cursor
Add to \`.cursor/mcp.json\` in your project:
\`\`\`json
{
  "mcpServers": {
    "codelens": {
      "command": "node",
      "args": ["${entryPath}", "${workspaceRoot.replace(/\\/g, '/')}"]
    }
  }
}
\`\`\`

## Available MCP tools
| Tool | Purpose |
|------|---------|
| \`codelens_search\` | Search all indexed symbols when the location is unknown |
| \`codelens_context\` | Retrieve broad, cross-file context on demand |
| \`codelens_callers\` | Find direct consumers of a shared symbol |
| \`codelens_callees\` | Find a symbol's direct dependencies |
| \`codelens_impact\` | Measure transitive impact before a refactor |
| \`codelens_node\` | Get compact metadata for one known symbol |
| \`codelens_files\` | Search project structure by category or filename |
| \`codelens_status\` | Diagnose a missing or stale index |

## Agent usage policy

CodeLens is an on-demand codebase index, not startup context.

- Do not call CodeLens automatically at the beginning of every task.
- Use it when full-codebase search, architecture discovery, call relationships,
  duplicate detection, or change-impact analysis would be more efficient than
  opening files one by one.
- For targeted work with known files or symbols, read those files directly.
- Start with the smallest useful query. Prefer \`codelens_search\` or a focused
  relationship tool before \`codelens_context\`.
- Request snippets only when they are likely to replace a file read.
- After CodeLens identifies relevant locations, inspect only the files needed
  to verify behavior and make the change.

The graph updates automatically on every file save. No startup context is
injected, and the agent calls these tools only when needed.
`;
  }

  private ensureGitignore(workspaceRoot: string): void {
    const gitignorePath = path.join(workspaceRoot, '.gitignore');
    const entry = '\n# CodeLens Graph (local index)\n.codelens/\n';
    try {
      const existing = fs.existsSync(gitignorePath)
        ? fs.readFileSync(gitignorePath, 'utf-8') : '';
      if (!existing.includes('.codelens/')) {
        fs.appendFileSync(gitignorePath, entry, 'utf-8');
      }
    } catch { /* ignore */ }
  }

  private removeManagedSection(content: string): string {
    const start = content.indexOf('<!-- CODELENS_MANAGED_START -->');
    const end   = content.indexOf('<!-- CODELENS_MANAGED_END -->');
    if (start === -1 || end === -1) { return content; }
    return (content.slice(0, start).trimEnd() + '\n' + content.slice(end + '<!-- CODELENS_MANAGED_END -->'.length).trimStart()).trim();
  }
}
