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

import { MCPServer }      from './mcpServer';

async function main() {
  const workspaceRoot = process.argv[2] ?? '--auto';

  const server = new MCPServer();
  await server.start(workspaceRoot);

  // Graceful shutdown
  process.on('SIGINT',  async () => { await server.stop(); process.exit(0); });
  process.on('SIGTERM', async () => { await server.stop(); process.exit(0); });
}

main().catch(err => {
  console.error('[CodeLens MCP] Fatal:', err);
  process.exit(1);
});
