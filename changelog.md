# Changelog

All notable changes to the **CodeLens Graph** extension will be documented in this file.

---

## [0.2.3] - 2026-07-04

### Added
- **Multi-Token Search Support**: Added pipe-delimited (`|`) search parsing to `codelens_search` (dynamic SQLite LIKE query OR groups with priority ordering).
- **Unified Glob Matching**: Integrated a unified glob matcher (`matchPathFilter`) for consistent exclusions across background scanning, text indexing, and extension watcher.

### Changed
- **Context Bloat Prevention**: Capped output size for `codelens_files` (max 30), `codelens_relations` (max 30), `codelens_impact` (max 50), `codelens_dependencies` types (max 10), and prompt-injected workspace files (max 15) to prevent context bloating.
- **Node Format Cleanup**: Removed verbose `[undef:...]` list tags from `fmtNode` signature representations to keep agent context clean.

### Fixed
- **Watcher Exclusions**: Fixed VS Code watcher exclusions to correctly ignore compiler output directories (`out/`, `output/`) and respect user-configured `excludePatterns`.
- **MCP Suggestions**: Fixed `codelens_node` callers/callees tool recommendations to suggest `codelens_relations` instead of non-existent legacy endpoints.

---

## [0.2.2] - 2026-07-01

### Added
- **Two-Phase Database Scanning**: Graph building now scans workspace files first (excluding `node_modules`), rendering the UI immediately, then parses dependencies in the background.
- **Pre-scan IDE Configuration Onboarding**: Prompts for and generates IDE configurations before scanning begins.
- **Manual Configuration & Reset Actions**: Added "Add Configuration to IDE" and "Clear Configuration Files" buttons in the side panel Actions section.
- **Active Webview Loader**: The Graph Panel now listens to scanning status and displays a spinner during graph generation.

---

## [0.2.1] - 2026-06-29

### Added
- **Asynchronous DB Initialization**: Defer database loading and sql.js WASM compilation to background promises, reducing extension host activation block to under 30ms.
- **DB Access Guards**: Integrated `ensureInit()` awaiters across all commands, watchers, and views to handle lazy database loading safely.
- **WASM Lazy Loading**: Moved the heavy `sql.js` require block to only load when the database is first initialized, reducing bundle load latency.
- **Database Corruption Recovery**: Added try-catch fallbacks to reload and initialization code; if the database file gets corrupted on disk, it falls back to a clean DB instead of crashing.
- **Keyword Guards for Regex Fallback**: Implemented a negative lookahead guard (`(?!(?:if|for|while|switch|catch...)\b)`) in the fallback parser method regex to prevent control flow statements from being matched as symbols.
- **Command Error Handlers**: Wrapped user-facing commands (`manualBuild`, `showContextPreview`, `searchSymbol`) in try-catch wrappers to display friendly VS Code error alerts on failure.
- **Text Indexing & Fuzzy Search**: Implemented a lightweight line-based fuzzy text index and search (`codelens_text_search` MCP tool) to find comments, string literals, and arbitrary text mentions.
- **Unified Call Relations Tool**: Combined callers and callees queries into a single, unified `codelens_relations` tool supporting custom direction queries.
- **In-Memory Version Tracking**: Replaced slow disk file stat checks with instant, zero-I/O in-memory version increments to detect graph mutations.
- **Live UI Syncing**: Wired a unified `refreshAll` callback into all file system watchers and scanner events to refresh both the sidebar stats and the graph explorer UI synchronously.
- **Custom Markdown Visibility**: Treated non-generated workspace `.md` files as configuration paths to make them easily discoverable in agent configuration queries.

### Removed
- **Redundant Startup DB Write**: Removed the slow, redundant `this.persist()` write from database startup sequence.

---

## [0.2.0] - 2026-06-27

### Added
- **Dependency & Config Indexing**: CodeLens Graph now indexes generic configuration files (e.g. `package.json`, `tsconfig.json`, `.yml`, `.md`) and selectively indexes third-party dependencies from `node_modules` (entry point `.d.ts` type definitions, `package.json`, `README.md`). Capped at depth 3 inside dependencies to avoid recursive scanner bloat.
- **`codelens_dependencies` MCP Tool**: A new MCP tool allowing AI agents to query third-party packages, configuration files, package exports, and package types, as well as finding which files in the workspace import or depend on them.
- **`short` and `deep` Context Modes**:
  - `short` (default): Returns the file map and symbol signatures, keeping context retrieval extremely token-efficient.
  - `deep`: Includes inline code snippets for resolved symbols, allowing agents to read necessary code details without accessing the file system file-by-file.
- **New Dependency Edges**: Integrated `depends-on` and `peer-dependency` edge types in the graph DB to represent package dependencies and relationships.
- **D3 Webview UI Filters & Styling**:
  - Added a filter tab for "Configs".
  - Implemented specific edge rendering and arrow styling for `depends_on` and `peer_dependency` relationships.
  - Pre-warmed graph simulation layout (up to 90 ticks) for larger codebases (200+ nodes) to prevent initial webview loading lag.

### Changed
- **Completely Excluded `node_modules` from Graph Panel**: Excluded all `node_modules` files and symbols from entering the D3 webview payload, and removed the "Node Modules" filter button from the UI toolbar. Dependencies remain fully accessible to AI agents via the MCP tools (like `codelens_dependencies` or `scope: "deps"`).
- **MCP Rules Protocol**: Updated default agent instruction rules in `skillGenerator.ts` (Rules 1, 2, 3, and 6) to guide agents on utilizing `mode: "deep"` and query dependencies via `codelens_dependencies` or `scope: "deps"`.
- **Changed Files Filtering**: Optimized the background post-agent-run scanning (`backgroundScanner.ts`) to filter changed files against user and system exclusion patterns before updating the database.
- **Ignore AST Keywords**: The regex parser fallback now ignores common programming language keywords (e.g., `if`, `for`, `class`, `import`) to prevent symbol naming noise.

### Fixed
- Fixed VS Code FileSystemWatcher delete callback logic to return early for paths matching fast exclusion patterns, avoiding unnecessary database deletion attempts.
- Updated file finding patterns on background changed files detection to correctly ignore large folders like `node_modules`, `dist`, and `build`.

---

## [0.1.0] - 2026-06-26

### Added
- Initial release of CodeLens Graph extension.
- Background indexing using Tree-sitter WASM grammars and SQLite WASM database (`sql.js`).
- 9 MCP Tools (triage, search, context, callers, callees, impact, node, files, status).
- Sidebar Stats view and interactive D3 force-directed graph webview.
- Automatic AI assistant skill file generator for Claude, Cursor, Antigravity, Windsurf, and Copilot.
