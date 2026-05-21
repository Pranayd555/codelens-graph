# CodeLens Graph

> A VS Code extension that builds a live knowledge graph of your codebase — so AI agents understand everything before acting. No hallucinations. No duplicate files. No wasted tokens.

---

## What it does

Every time you (or an AI agent) saves a file, CodeLens Graph parses it and updates a local graph database with every:

- **File** in the workspace
- **Class**, **Interface**, **Enum**, **Type alias**
- **Function**, **Method**, **Variable**, **Property**
- **Import** and **call relationships** between them

Before any AI agent runs, you can generate a **compressed context** — a precise JSON summary of only the symbols relevant to the current task — and inject it into the agent's prompt. This cuts token usage by ~90% while giving the agent perfect structural awareness of the codebase.

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
3. Before prompting an AI agent, run **Show Agent Context Preview**
4. Type your task description
5. Copy the generated system prompt injection
6. Paste it at the top of your agent's system prompt

The agent will know exactly what already exists, where it lives, and what calls what — before writing a single line.

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
- [ ] Agent run hooks (auto-inject context into Copilot/Cline/Cursor)
- [ ] Snapshot diff viewer (before/after agent run graph comparison)
- [ ] Vector embeddings for semantic symbol search
- [ ] Team sync (shared graph via cloud backend)

---

## License

MIT
