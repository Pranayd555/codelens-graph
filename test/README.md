# Tests

```bash
npm test              # every test/**/*.test.ts (Node's built-in test runner + ts-node; Node 21+)
npm run test:coverage # same, with a per-file coverage table
```

Run one area: `node --require ts-node/register --test "test/graph/**/*.test.ts"`.

| Folder | What it covers |
|---|---|
| `ingestion/` | utils, folder scope, dependency manifest, workspace scanner, file watcher |
| `parser/` | tree-sitter parsing per language, scope analysis, regex fallback, robustness |
| `graph/` | graph DB storage, CRUD, search, packages, relationship resolution (full vs incremental), differ, text index |
| `agent/` | background scanner (queue, batching, folder events), agent instruction/config files, workspace opt-out |
| `context/` | agent context builder, file categories, snippets, MCP usage log |
| `mcp/` | contract tests: the real MCP server as a child process, every tool, security and workspace policies |
| `ui/` | graph panel, stats sidebar, indexed-folders tree (with a fake `vscode` module in `ui/_vscode.ts`) |
| `*.test.ts` (root) | cross-cutting features: CommonJS requires, external packages, re-parsing, import hints, MCP launcher |

## Conventions

- `node:test` + `node:assert/strict`. Helpers live in files not named `*.test.ts` (`helpers.ts`, `*/_*.ts`, `*/fixtures.ts`).
- Tests use temp directories under the OS temp folder and remove them. Code that reads `os.homedir()` is pointed at a temp "fake home" (`HOME` / `USERPROFILE`) — tests never touch the real home directory.
- **One `ASTParser` per process.** A second instance currently falls back to regex parsing (see the known bug below), so area helpers share a single parser.
- Tests must pass on Windows, Linux and macOS. Platform-specific expectations are guarded with `process.platform` (and skipped elsewhere).
- **Known bugs are `todo` tests.** A test written for the correct behaviour of something that is currently broken is marked `it('…', { todo: 'BUG: …' }, …)`: it runs and fails without failing the suite. When you fix the bug, remove the `todo` option so the test guards it from then on. List them with:
  ```bash
  node --require ts-node/register --test --test-reporter=tap "test/**/*.test.ts" | grep "# TODO"
  ```
