#!/usr/bin/env node
// ─── MCP entry point ──────────────────────────────────────────────────────────
// Run as: node out/mcp/mcpEntry.js <workspace-path>
// Or via package bin: codelens-mcp <workspace-path>
//
// Add to Claude Code (~/.claude.json):
// {
//   "mcpServers": {
//     "codelens": {
//       "type": "stdio",
//       "command": "node",
//       "args": ["/path/to/codelens-graph/out/mcp/mcpEntry.js", "/path/to/your/project"]
//     }
//   }
// }
//
// Add to VS Code (project .vscode/mcp.json):
// {
//   "servers": {
//     "codelens": {
//       "command": "node",
//       "args": ["/path/to/extension/out/mcp/mcpEntry.js", "/path/to/your/project"]
//     }
//   }
// }
//
// Add to Cursor (~/.cursor/mcp.json or project .cursor/mcp.json):
// {
//   "mcpServers": {
//     "codelens": {
//       "command": "node",
//       "args": ["/path/to/codelens-graph/out/mcp/mcpEntry.js", "${workspaceFolder}"]
//     }
//   }
// }

import * as path from 'path';
import * as fs   from 'fs';
import { GraphDB }        from '../graph/graphDB';
import { ASTParser }      from '../ingestion/astParser';
import { WorkspaceScanner } from '../ingestion/workspaceScanner';
import { ContextBuilder } from '../context/contextBuilder';
import { MCPServer }      from './mcpServer';

async function main() {
  const workspaceRoot = process.argv[2] ?? process.cwd();

  if (!fs.existsSync(workspaceRoot)) {
    console.error(`[CodeLens MCP] Workspace not found: ${workspaceRoot}`);
    process.exit(1);
  }

  // DB lives in .codelens/ inside the workspace (not in extension storage)
  const dbDir = path.join(workspaceRoot, '.codelens');
  fs.mkdirSync(dbDir, { recursive: true });

  const db     = new GraphDB(dbDir);
  await db.init();

  const stats = db.getStats();

  // If graph is empty, scan now (blocks until done — first run only)
  if (stats.totalNodes === 0) {
    console.error(`[CodeLens MCP] Graph empty — indexing ${workspaceRoot}…`);
    const parser  = new ASTParser();
    const scanner = new WorkspaceScanner(parser, db);

    // Use the same comprehensive exclude list as the VS Code extension.
    // The ALWAYS_EXCLUDE_DIRS set in workspaceScanner handles dot-dirs and
    // build folders automatically — these patterns add explicit belt+braces.
    await scanner.scanWorkspace([workspaceRoot], {
      excludePatterns: [
        '**/node_modules/**', '**/dist/**', '**/build/**', '**/out/**', '**/output/**',
        '**/bundle/**', '**/.next/**', '**/.nuxt/**', '**/.svelte-kit/**', '**/.vite/**',
        '**/.turbo/**', '**/.parcel-cache/**', '**/.cache/**', '**/.angular/**',
        '**/coverage/**', '**/.nyc_output/**', '**/playwright-report/**', '**/test-results/**',
        '**/__pycache__/**', '**/.venv/**', '**/venv/**', '**/.pytest_cache/**',
        '**/.mypy_cache/**', '**/site-packages/**', '**/*.egg-info/**',
        '**/vendor/**', '**/target/**', '**/.gradle/**', '**/.m2/**', '**/obj/**',
        '**/.git/**', '**/.hg/**', '**/.svn/**', '**/.idea/**', '**/.vs/**',
        '**/.vscode/**', '**/.cursor/**', '**/.trae/**', '**/.codelens/**',
        '**/DerivedData/**', '**/xcuserdata/**', '**/.build/**',
      ],
      supportedExtensions: [
        '.ts','.tsx','.js','.jsx','.mjs',
        '.py','.go','.rs','.java','.cs',
        '.cpp','.c','.rb','.php','.swift','.kt',
      ],
    });

    const newStats = db.getStats();
    console.error(`[CodeLens MCP] Indexed ${newStats.fileCount} files, ${newStats.totalNodes} symbols`);
  } else {
    console.error(`[CodeLens MCP] Graph loaded: ${stats.totalNodes} symbols in ${stats.fileCount} files`);
  }

  const contextBuilder = new ContextBuilder(db);
  const server         = new MCPServer(db, contextBuilder);

  await server.start(workspaceRoot);

  // Graceful shutdown
  process.on('SIGINT',  async () => { await server.stop(); db.close(); process.exit(0); });
  process.on('SIGTERM', async () => { await server.stop(); db.close(); process.exit(0); });
}

main().catch(err => {
  console.error('[CodeLens MCP] Fatal:', err);
  process.exit(1);
});
