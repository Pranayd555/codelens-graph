# CodeLens Graph

> A VS Code extension that gives AI agents an on-demand, full-codebase search and relationship graph. No automatic context dump, duplicate implementations, or wasted tokens.

---

## What it does

Every time you (or an AI agent) saves a file, CodeLens Graph parses it and updates a local graph database with every:

- **File** in the workspace
- **Class**, **Interface**, **Enum**, **Type alias**
- **Function**, **Method**, **Variable**, **Property**
- **Import** and **call relationships** between them

AI agents query the graph only when they need codebase-wide discovery, architectural context, call relationships, duplicate detection, or change-impact analysis. CodeLens narrows the search to relevant symbols and files; the agent then reads only the source needed for the task.

---

## Installation

### From .vsix (recommended for users)

```bash
code --install-extension codelens-graph-0.1.0.vsix
```

Or: `Ctrl+Shift+P` → `Extensions: Install from VSIX…`

### From source (for development)

```bash
git clone https://github.com/pranayd555/codelens-graph.git
cd codelens-graph
npm install
```

Then press **F5** in VS Code to launch the Extension Development Host.

---

## Usage

| Command | What it does |
|---|---|
| `CodeLens: Build Knowledge Graph` | Full scan of the workspace |
| `CodeLens: Show Graph Explorer` | Open the interactive D3 graph |
| `CodeLens: Show Agent Context Preview` | Generate compressed context for a task |
| `CodeLens: Search Symbol in Graph` | Find any function/class/variable instantly |
| `CodeLens: Force Rebuild Graph` | Full rescan (clear + rebuild) |

### Workflow with AI agents

1. Open your project in VS Code
2. Run **Build Knowledge Graph** once (auto-runs on first open)
3. Connect the CodeLens MCP server using `.codelens/mcp.json`
4. Give the agent its task normally; no context is injected at startup
5. The agent calls CodeLens only when it needs full-codebase search or graph analysis
6. After CodeLens identifies relevant locations, the agent reads only the required files

For targeted work where the file and symbol are already known, the agent should read them directly. For unfamiliar or cross-cutting work, it should start with the smallest useful CodeLens query and expand only when needed.

---

## Settings

| Setting | Default | Description |
|---|---|---|
| `codeLensGraph.autoRebuildOnSave` | `true` | Update graph on file save |
| `codeLensGraph.maxGraphDepth` | `2` | BFS hops from entry points |
| `codeLensGraph.maxTokenBudget` | `2000` | Max tokens in agent context |
| `codeLensGraph.excludePatterns` | `node_modules, dist, build...` | Folders to skip |
| `codeLensGraph.supportedExtensions` | `.ts .js .py .go .rs...` | Languages to parse |

---

## Architecture

```
src/
├── extension.ts              # VS Code entry point, command registration
├── types.ts                  # GraphNode, GraphEdge, AgentContext types
├── ingestion/
│   ├── astParser.ts          # Regex + tree-sitter AST parser (150+ languages)
│   ├── workspaceScanner.ts   # Walks workspace, feeds files to parser
│   └── fileWatcher.ts        # Incremental updates on file save
├── graph/
│   ├── graphDB.ts            # SQLite storage (nodes, edges, snapshots)
│   └── differ.ts             # Pre/post agent run diff engine
├── context/
│   └── contextBuilder.ts     # Task → BFS subgraph → compressed JSON
└── ui/
    └── graphPanel.ts         # D3.js force-directed graph webview
```

---

## Development

```bash
# Install dependencies
npm install

# Compile TypeScript
npm run compile

# Watch mode (auto-recompile on save)
npm run watch

# Package as .vsix
npx vsce package --allow-missing-repository

# Type check only (no output)
npx tsc --noEmit
```

**To test with F5:**
1. Open this folder in VS Code
2. Press `F5`
3. A new VS Code window opens with the extension loaded
4. Open any project folder in that window
5. `Ctrl+Shift+P` → `CodeLens: Build Knowledge Graph`

---

## Roadmap

- [ ] Tree-sitter WASM grammars (full AST precision, replaces regex parser)
- [ ] Deeper agent integrations that preserve on-demand context retrieval
- [ ] Snapshot diff viewer (before/after agent run graph comparison)
- [ ] Vector embeddings for semantic symbol search
- [ ] Team sync (shared graph via cloud backend)

---

## License

MIT
