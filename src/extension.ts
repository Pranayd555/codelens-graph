import * as vscode from 'vscode';
import * as path   from 'path';
import * as crypto from 'crypto';
import * as fs     from 'fs';

import { GraphDB }            from './graph/graphDB';
import { ASTParser }          from './ingestion/astParser';
import { WorkspaceScanner }   from './ingestion/workspaceScanner';
import { FileWatcher }        from './ingestion/fileWatcher';
import { ContextBuilder }     from './context/contextBuilder';
import { GraphDiffer }        from './graph/differ';
import { SkillGenerator }     from './agent/skillGenerator';
import { BackgroundScanner }  from './agent/backgroundScanner';
import { getGraphPanelHtml, toWebviewData } from './ui/graphPanel';
import { readRecentLogs, formatUsageReport } from './mcp/mcpLogger';
import { StatsViewProvider }   from './ui/statsView';
import { GraphStats }         from './types';
import { isNodeModulePath }   from './utils';

// ─── Extension-wide state ─────────────────────────────────────────────────────

let db:                GraphDB;
let parser:            ASTParser;
let scanner:           WorkspaceScanner;
let fileWatcher:       FileWatcher;
let contextBuilder:    ContextBuilder;
let differ:            GraphDiffer;
let skillGenerator:    SkillGenerator;
let backgroundScanner: BackgroundScanner;

let graphPanel:       vscode.WebviewPanel | undefined;
let statusBarItem:    vscode.StatusBarItem;
let statsViewProvider: StatsViewProvider;

// ─── activate ─────────────────────────────────────────────────────────────────

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  console.log('[CodeLens Graph] Activating…');

  // ── 1. Boot all services ──────────────────────────────────────────────────

  const activeWorkspaceRoot = vscode.workspace.workspaceFolders?.[0].uri.fsPath;
  const graphStoragePath = activeWorkspaceRoot
    ? path.join(activeWorkspaceRoot, '.codelens')
    : context.globalStorageUri.fsPath;

  db             = new GraphDB(graphStoragePath);
  parser         = new ASTParser();
  scanner        = new WorkspaceScanner(parser, db);
  fileWatcher    = new FileWatcher(scanner);
  contextBuilder = new ContextBuilder(db);
  differ         = new GraphDiffer(db);
  skillGenerator = new SkillGenerator(db);
  backgroundScanner = new BackgroundScanner(db, scanner, skillGenerator, () => {
    return context.workspaceState.get<string[]>('selectedIdes') ?? [];
  });

  // Start database initialization asynchronously in the background.
  db.init().then(() => {
    const cfg = getConfig();
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0].uri.fsPath;
    if (workspaceRoot) {
      const stats = db.getStats();

      if (stats.totalNodes === 0) {
        // First install: show scanning status immediately so user knows it's working
        setStatus('scanning');
        backgroundScanner.scheduleInitialScan(workspaceRoot, {
          excludePatterns:     cfg.excludePatterns,
          supportedExtensions: cfg.supportedExtensions,
        }, context);

        // Prompt the user for IDE preferences on first install/activation
        if (context.workspaceState.get('selectedIdes') === undefined) {
          vscode.window.showInformationMessage(
            'CodeLens Graph: Which IDEs would you like to install automatic configurations for?',
            'Select IDEs',
            'Skip'
          ).then(async choice => {
            if (choice === 'Select IDEs') {
              await getOrPromptSelectedIdes(context, true);
            } else {
              await context.workspaceState.update('selectedIdes', []);
            }
            // Regenerate skills immediately with choice if scanner finished
            const dbStats = db.getStats();
            if (dbStats.totalNodes > 0) {
              const fullStats: GraphStats = { ...dbStats, lastBuilt: Date.now(), buildDurationMs: 0 };
              const ides = context.workspaceState.get<string[]>('selectedIdes') ?? [];
              skillGenerator.generateAll(workspaceRoot, fullStats, ides);
            }
          });
        }
      } else {
        // Already have a graph — refresh skills and show ready
        setStatus('ready', stats.totalNodes, stats.totalEdges);
        statsViewProvider?.refresh();
        const fullStats: GraphStats = { ...stats, lastBuilt: Date.now(), buildDurationMs: 0 };
        const ides = context.workspaceState.get<string[]>('selectedIdes') ?? [];
        skillGenerator.generateAll(workspaceRoot, fullStats, ides);
        console.log(`[CodeLens] Existing graph loaded: ${stats.totalNodes} nodes. Skills refreshed.`);
      }
    }
  }).catch(err => {
    console.error('[CodeLens] Database initialization failed:', err);
    setStatus('error');
  });

  // ── 2. Status bar ──────────────────────────────────────────────────────────

  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBarItem.command = 'codelens-graph.showGraph';
  setStatus('idle');
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);

  // ── 3. Register stats sidebar provider ───────────────────────────────────
  statsViewProvider = new StatsViewProvider(db, context);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(StatsViewProvider.viewId, statsViewProvider)
  );

  // ── 4. Background scanner callbacks (was 3) ──────────────────────────────

  backgroundScanner.onStatus(state => {
    if (state === 'scanning')  { setStatus('scanning'); }
    if (state === 'updating')  { setStatus('updating'); }
    if (state === 'ready')     {
      const s = db.getStats();
      setStatus('ready', s.totalNodes, s.totalEdges);
      refreshGraphPanel();
      statsViewProvider?.refresh();
    }
    if (state === 'error')     { setStatus('error'); }
  });

  backgroundScanner.onComplete(stats => {
    setStatus('ready', stats.totalNodes, stats.totalEdges);
    refreshGraphPanel();
    statsViewProvider?.refresh();
    refreshSavings();
  });

  backgroundScanner.onSkills(_written => {
    // Show MCP setup notification on first install (when graph was empty before scan)
    const shownKey = 'codelens.mcpNotified.v2';
    const stats = db.getStats();
    if (!context.globalState.get(shownKey) && stats.totalNodes > 0) {
      context.globalState.update(shownKey, true);
      vscode.window.showInformationMessage(
        `CodeLens Graph: ${stats.totalNodes} symbols indexed across ${stats.fileCount} files. ` +
        `MCP server config written to .vscode/mcp.json`,
        'Copy Full Config', 'Show Graph'
      ).then(choice => {
        if (choice === 'Copy Full Config') {
          vscode.commands.executeCommand('codelens-graph.copyMcpConfig');
        } else if (choice === 'Show Graph') {
          showGraphPanel(context);
        }
      });
    }
  });

  // ── 5. Commands ───────────────────────────────────────────────────────────

  context.subscriptions.push(

    // Manual full rebuild (user-triggered)
    vscode.commands.registerCommand('codelens-graph.buildGraph', async () => {
      await manualBuild(context);
    }),

    vscode.commands.registerCommand('codelens-graph.rebuildGraph', async () => {
      await manualBuild(context, true);
    }),

    // Graph viewer
    vscode.commands.registerCommand('codelens-graph.showGraph', async () => {
      await showGraphPanel(context);
    }),

    // Agent context preview (still available for debugging)
    vscode.commands.registerCommand('codelens-graph.showContext', async () => {
      await showContextPreview();
    }),

    // Symbol search
    vscode.commands.registerCommand('codelens-graph.searchSymbol', async () => {
      await searchSymbol();
    }),

    // ── Agent-callable commands (invoked by AI via VS Code command palette) ──

    // Called by the AI agent BEFORE starting work on a task.
    // Returns a compressed context JSON — the agent reads it, not the user.
    vscode.commands.registerCommand('codelens-graph.getContextForTask', async (taskDescription?: string, mode?: 'short' | 'deep') => {
      await db.ensureInit();
      const task = taskDescription
        ?? await vscode.window.showInputBox({ prompt: 'Task description for context lookup' });
      if (!task) { return; }

      const actualMode = mode ?? 'short';
      const cfg = getConfig();
      const agentCtx = contextBuilder.build(task, cfg.maxGraphDepth, cfg.maxTokenBudget, actualMode);
      const injection = contextBuilder.buildSystemPromptInjection(agentCtx, actualMode);

      // Show in editor — context is returned directly, no file write needed
      const doc = await vscode.workspace.openTextDocument({
        language: 'markdown',
        content: injection,
      });
      await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);

      return { context: injection, tokenEstimate: agentCtx.tokenEstimate };
    }),

    // Called by the AI agent AFTER it finishes making changes.
    // Re-scans changed files and regenerates skill files.
    vscode.commands.registerCommand('codelens-graph.updateAfterAgentRun', async (changedFiles?: string[]) => {
      await db.ensureInit();
      const cfg = getConfig();
      const workspaceRoot = vscode.workspace.workspaceFolders?.[0].uri.fsPath;
      if (!workspaceRoot) { return; }

      const files = changedFiles ?? await detectRecentlyChangedFiles(workspaceRoot);

      setStatus('updating');
      await backgroundScanner.handleAgentRunComplete(files, workspaceRoot, {
        excludePatterns:     cfg.excludePatterns,
        supportedExtensions: cfg.supportedExtensions,
      });

      vscode.window.setStatusBarMessage('$(check) CodeLens: graph updated after agent run', 3000);
    }),

    // Copy MCP config to clipboard
    vscode.commands.registerCommand('codelens-graph.copyMcpConfig', () => {
      const workspaceRoot = vscode.workspace.workspaceFolders?.[0].uri.fsPath;
      if (!workspaceRoot) { return; }
      const mcpConfigPath = require('path').join(workspaceRoot, '.codelens', 'mcp.json');
      const fs = require('fs');
      if (!fs.existsSync(mcpConfigPath)) {
        vscode.window.showWarningMessage('MCP config not found — run Build Graph first.');
        return;
      }
      const config = fs.readFileSync(mcpConfigPath, 'utf-8');
      vscode.env.clipboard.writeText(config);
      vscode.window.showInformationMessage(
        'MCP config copied! Use the relevant section for .vscode/mcp.json, ~/.claude.json, or .cursor/mcp.json'
      );
    }),

    // View MCP usage report — shows how agents are using CodeLens tools
    vscode.commands.registerCommand('codelens-graph.viewMcpUsage', async () => {
      const workspaceRoot = vscode.workspace.workspaceFolders?.[0].uri.fsPath;
      if (!workspaceRoot) {
        vscode.window.showWarningMessage('No workspace folder open.');
        return;
      }
      const logs   = readRecentLogs(workspaceRoot, 200);
      const report = formatUsageReport(logs);
      const doc    = await vscode.workspace.openTextDocument({ language: 'markdown', content: report });
      await vscode.window.showTextDocument(doc);
    }),

    // Show MCP usage report — how agent used the server, token savings
    vscode.commands.registerCommand('codelens-graph.showMcpUsage', async () => {
      const workspaceRoot = vscode.workspace.workspaceFolders?.[0].uri.fsPath;
      if (!workspaceRoot) { vscode.window.showWarningMessage('No workspace open.'); return; }
      const logs   = readRecentLogs(workspaceRoot, 200);
      const report = formatUsageReport(logs);
      const doc = await vscode.workspace.openTextDocument({ language: 'markdown', content: report });
      await vscode.window.showTextDocument(doc);
    }),

    // Regenerate skill/MCP config files (no rescan)
    vscode.commands.registerCommand('codelens-graph.regenerateSkills', async () => {
      await db.ensureInit();
      const workspaceRoot = vscode.workspace.workspaceFolders?.[0].uri.fsPath;
      if (!workspaceRoot) { return; }
      const dbStats = db.getStats();
      const stats: GraphStats = { ...dbStats, lastBuilt: Date.now(), buildDurationMs: 0 };
      const ides = await getOrPromptSelectedIdes(context, true); // Force prompt so user can change preferences
      const written = skillGenerator.generateAll(workspaceRoot, stats, ides);
      vscode.window.showInformationMessage(`CodeLens: Skills regenerated → ${written.join(', ')}`);
    }),
  );

  // ── 6. File system watcher → incremental graph updates ────────────────────

  const cfg = getConfig();
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0].uri.fsPath;
  const supported = cfg.supportedExtensions.join(',');

  if (cfg.autoRebuildOnSave && workspaceRoot) {
    const fsWatcher = vscode.workspace.createFileSystemWatcher(`**/*{${supported}}`);

    // Guard: skip any path inside an excluded directory so hot-saves in
    // node_modules / dist / .angular etc never trigger a re-index.
    const isExcludedPath = (fsPath: string): boolean => {
      const rel = path.relative(workspaceRoot, fsPath).replace(/\\/g, '/');
      const FAST_EXCLUDE = /(?:^|[/\\])(?:node_modules|\.codelens|\.angular|\.next|\.nuxt|\.vite|\.turbo|dist|build|\.git|\.trae|\.cursor|__pycache__|\.venv|target|vendor)(?:[/\\]|$)/;
      return FAST_EXCLUDE.test(rel);
    };

    fsWatcher.onDidChange(async uri => {
      if (isExcludedPath(uri.fsPath)) { return; }
      await db.ensureInit();
      await backgroundScanner.handleFileChanged(uri.fsPath, workspaceRoot, {
        excludePatterns:     cfg.excludePatterns,
        supportedExtensions: cfg.supportedExtensions,
      });
      refreshGraphPanel();
    });

    fsWatcher.onDidCreate(async uri => {
      if (isExcludedPath(uri.fsPath)) { return; }
      await db.ensureInit();
      await fileWatcher.handleFileCreate(uri.fsPath);
      refreshGraphPanel();
    });

    fsWatcher.onDidDelete(async uri => {
      if (isExcludedPath(uri.fsPath)) { return; }
      await db.ensureInit();
      const removedSymbols = db.getNodesByFile(uri.fsPath)
        .filter(node => node.type !== 'file' && node.type !== 'import')
        .map(node => node.name);
      db.deleteNodesByFile(uri.fsPath);
      db.resolveWorkspaceRelationships(uri.fsPath, removedSymbols);
      db.persist();
      refreshGraphPanel();
    });

    context.subscriptions.push(fsWatcher);
  }

  // ── 7. Auto-scan on activation (deferred to db.init() resolution) ────────


  // Refresh savings display every 30s — updates while agent is actively working
  const savingsTimer = setInterval(refreshSavings, 30_000);
  context.subscriptions.push({ dispose: () => clearInterval(savingsTimer) });

  context.subscriptions.push({ dispose: () => backgroundScanner.dispose() });
  console.log('[CodeLens Graph] Activated ✓');
}

// ─── deactivate ───────────────────────────────────────────────────────────────

export function deactivate(): void {
  backgroundScanner?.dispose();
  fileWatcher?.dispose();
  db?.close();
  console.log('[CodeLens Graph] Deactivated');
}

// ─── manualBuild ──────────────────────────────────────────────────────────────
// Triggered by the user explicitly. Shows progress UI unlike background scan.

async function manualBuild(context: vscode.ExtensionContext, _force = false): Promise<void> {
  await db.ensureInit();
  const folders = vscode.workspace.workspaceFolders;
  if (!folders?.length) {
    vscode.window.showWarningMessage('CodeLens Graph: No workspace folder open.');
    return;
  }

  const workspaceRoot = folders[0].uri.fsPath;
  const cfg = getConfig();
  setStatus('scanning');

  await vscode.window.withProgress({
    location:    vscode.ProgressLocation.Notification,
    title:       'CodeLens: Building knowledge graph…',
    cancellable: false,
  }, async (progress) => {
    try {
      const result = await scanner.scanWorkspace([workspaceRoot], {
        excludePatterns:     cfg.excludePatterns,
        supportedExtensions: cfg.supportedExtensions,
        onProgress: (current, total, filePath) => {
          progress.report({
            message:   `${Math.round((current / total) * 100)}%  ${path.basename(filePath)}`,
            increment: 100 / total,
          });
        },
      });

      const dbStats = db.getStats();
      const stats: GraphStats = { ...dbStats, lastBuilt: Date.now(), buildDurationMs: result.durationMs };

      setStatus('ready', dbStats.totalNodes, dbStats.totalEdges);
      refreshGraphPanel();
      statsViewProvider?.refresh();

      // Generate / update skill files
      const ides = await getOrPromptSelectedIdes(context);
      const written = skillGenerator.generateAll(workspaceRoot, stats, ides);

      vscode.window.showInformationMessage(
        `CodeLens Graph: ${result.filesScanned} files · ${result.nodesAdded} symbols · ${result.durationMs}ms` +
        ` | Skills → ${written.length} agent rule files updated`
      );
    } catch (err: any) {
      console.error('[CodeLens] Manual build failed:', err);
      vscode.window.showErrorMessage(`CodeLens build failed: ${err?.message || err}`);
      setStatus('error');
    }
  });
}

// ─── showGraphPanel ───────────────────────────────────────────────────────────

let lastSentVersion = '';

function getGraphVersion(): string {
  try {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0].uri.fsPath;
    if (workspaceRoot) {
      const dbPath = path.join(workspaceRoot, '.codelens', 'codelens-graph.db');
      if (fs.existsSync(dbPath)) {
        const stat = fs.statSync(dbPath);
        return `${stat.mtimeMs}:${stat.size}`;
      }
    }
  } catch { /* ignore */ }
  return '';
}

function buildGraphWebviewData() {
  const allFiles = db.getAllFiles('all').filter(f => !isNodeModulePath(f));
  const allNodes = allFiles.flatMap(f => db.getNodesByFile(f));
  const edgeMap  = new Map<string, import('./types').GraphEdge>();
  for (const n of allNodes) {
    for (const e of db.getEdgesFrom(n.id)) { edgeMap.set(e.id, e); }
    for (const e of db.getEdgesTo(n.id))   { edgeMap.set(e.id, e); }
  }
  return toWebviewData(allNodes, [...edgeMap.values()]);
}

async function showGraphPanel(context: vscode.ExtensionContext): Promise<void> {
  await db.ensureInit();
  if (graphPanel) {
    graphPanel.reveal(vscode.ViewColumn.Beside, false);
    return;
  }

  graphPanel = vscode.window.createWebviewPanel(
    'codelens-graph', 'CodeLens Graph',
    { viewColumn: vscode.ViewColumn.Beside, preserveFocus: false },
    {
      enableScripts: true,
      // retainContextWhenHidden keeps JS state (zoom, position, filter)
      // when the panel is hidden — critical for re-focus not losing data
      retainContextWhenHidden: true,
      localResourceRoots: [context.extensionUri],
    }
  );

  lastSentVersion = getGraphVersion();
  const nonce   = crypto.randomBytes(16).toString('hex');
  const initial = buildGraphWebviewData();
  graphPanel.webview.html = getGraphPanelHtml(initial, nonce);

  graphPanel.webview.onDidReceiveMessage(msg => {
    if (msg.command === 'openFile' && msg.filePath) {
      vscode.window.showTextDocument(vscode.Uri.file(msg.filePath), {
        selection: new vscode.Range(
          new vscode.Position(Math.max(0, (msg.line ?? 1) - 1), 0),
          new vscode.Position(Math.max(0, (msg.line ?? 1) - 1), 0)
        )
      });
    }
    if (msg.command === 'buildGraph') {
      vscode.commands.executeCommand('codelens-graph.buildGraph');
    }
    if (msg.command === 'ready') {
      // Webview JS finished loading. Only push if version changed!
      const currentVersion = getGraphVersion();
      if (currentVersion !== lastSentVersion) {
        lastSentVersion = currentVersion;
        const data = buildGraphWebviewData();
        graphPanel?.webview.postMessage({ command: 'updateGraph', ...data });
      }
      refreshSavings();
    }
  });

  // Re-push data whenever panel becomes visible (tab switch, editor layout change)
  graphPanel.onDidChangeViewState(e => {
    if (e.webviewPanel.visible) {
      setTimeout(() => {
        if (!graphPanel) { return; }
        const currentVersion = getGraphVersion();
        if (currentVersion !== lastSentVersion) {
          lastSentVersion = currentVersion;
          const data = buildGraphWebviewData();
          graphPanel.webview.postMessage({ command: 'updateGraph', ...data });
        }
      }, 120);
    }
  });

  graphPanel.onDidDispose(() => { graphPanel = undefined; });
}


// Push current MCP token savings into the stats sidebar and graph panel
function refreshSavings(): void {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0].uri.fsPath;
  if (!workspaceRoot) { return; }
  try {
    const logs  = readRecentLogs(workspaceRoot, 500);
    if (logs.length === 0) { return; }
    // Savings = estimated tokens a naive agent would spend reading files
    // minus what CodeLens tools actually cost.
    // Each codelens_context call replaces ~2000 tokens of file reads.
    // Each codelens_search call replaces ~400 tokens of grep + file reads.
    const toolCounts = logs.reduce((m, l) => { m[l.tool] = (m[l.tool] || 0) + 1; return m; }, {} as Record<string, number>);
    const saved = (toolCounts['codelens_context'] ?? 0) * 1800
                + (toolCounts['codelens_search']  ?? 0) * 400
                + (toolCounts['codelens_callers'] ?? 0) * 300
                + (toolCounts['codelens_callees'] ?? 0) * 300
                + (toolCounts['codelens_impact']  ?? 0) * 500
                + (toolCounts['codelens_node']    ?? 0) * 200
                + (toolCounts['codelens_files']   ?? 0) * 600;
    const calls = logs.length;
    statsViewProvider?.updateSavings(saved, calls);
    if (graphPanel?.visible) {
      graphPanel.webview.postMessage({ command: 'updateSavings', tokens: saved, calls });
    }
  } catch { /* non-fatal */ }
}

function refreshGraphPanel(): void {
  if (!graphPanel?.visible) { return; }
  lastSentVersion = getGraphVersion();
  const data = buildGraphWebviewData();
  graphPanel.webview.postMessage({ command: 'updateGraph', ...data });
}

// ─── showContextPreview ───────────────────────────────────────────────────────

async function showContextPreview(): Promise<void> {
  try {
    await db.ensureInit();
    const task = await vscode.window.showInputBox({
      prompt:      'Describe the AI agent task',
      placeHolder: 'e.g. "add rate limiting to auth middleware"',
    });
    if (!task) { return; }

    const modeChoice = await vscode.window.showQuickPick(['short', 'deep'], {
      title: 'Select Context Detail Level',
      placeHolder: 'short (file map + signatures) or deep (includes code snippets)',
    });
    if (!modeChoice) { return; }
    const mode = modeChoice as 'short' | 'deep';

    const cfg    = getConfig();
    const ctx    = contextBuilder.build(task, cfg.maxGraphDepth, cfg.maxTokenBudget, mode);
    const output = contextBuilder.buildSystemPromptInjection(ctx, mode);

    const doc = await vscode.workspace.openTextDocument({ language: 'markdown', content: [
      `# CodeLens Agent Context`,
      `**Task:** ${task}`,
      `**Tokens:** ~${ctx.tokenEstimate}  |  **Symbols:** ${ctx.subgraph.nodes.length}`,
      '',
      '```', output, '```',
      '',
      ctx.warnings.length
        ? '## ⚠️ Warnings\n' + ctx.warnings.map(w => `- ${w}`).join('\n')
        : '## ✅ No conflicts detected',
    ].join('\n') });

    await vscode.window.showTextDocument(doc);
  } catch (err: any) {
    vscode.window.showErrorMessage(`CodeLens: Failed to show context preview: ${err?.message || err}`);
  }
}

// ─── searchSymbol ─────────────────────────────────────────────────────────────

async function searchSymbol(): Promise<void> {
  try {
    await db.ensureInit();
    const query = await vscode.window.showInputBox({
      prompt: 'Search symbol in graph', placeHolder: 'function / class / variable name…',
    });
    if (!query) { return; }

    const results = db.searchNodes(query, 20);
    if (!results.length) {
      vscode.window.showInformationMessage(`No symbols found for "${query}"`);
      return;
    }

    const selected = await vscode.window.showQuickPick(
      results.map(n => ({
        label:       `$(symbol-${n.type === 'function' ? 'method' : n.type}) ${n.name}`,
        description: `${n.type} · ${path.basename(n.filePath)}:${n.line}`,
        detail:      n.signature?.slice(0, 120),
        node:        n,
      })),
      { matchOnDescription: true, matchOnDetail: true }
    );

    if (selected) {
      await vscode.window.showTextDocument(vscode.Uri.file(selected.node.filePath), {
        selection: new vscode.Range(
          new vscode.Position(Math.max(0, selected.node.line - 1), 0),
          new vscode.Position(Math.max(0, selected.node.line - 1), 0)
        )
      });
    }
  } catch (err: any) {
    vscode.window.showErrorMessage(`CodeLens: Search symbol failed: ${err?.message || err}`);
  }
}

// ─── detectRecentlyChangedFiles ───────────────────────────────────────────────
// Fallback: if the agent doesn't pass changed files, detect files modified in
// the last 5 minutes.

async function detectRecentlyChangedFiles(workspaceRoot: string): Promise<string[]> {
  const uris = await vscode.workspace.findFiles(
    '**/*',
    '{**/node_modules/**,**/dist/**,**/build/**,**/.git/**,**/.codelens/**,**/out/**,**/output/**}',
    200
  );
  const fiveMinutesAgo = Date.now() - 5 * 60 * 1000;
  const fs = require('fs');
  return uris
    .map(u => u.fsPath)
    .filter(fp => {
      try { return fs.statSync(fp).mtimeMs > fiveMinutesAgo; }
      catch { return false; }
    });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

// Hard-coded fallback used when user has not customised the setting.
// Kept in sync with ALWAYS_EXCLUDE_DIRS in workspaceScanner.ts so the
// VS Code file-watcher also ignores the same paths.
const DEFAULT_EXCLUDE_PATTERNS = [
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
];

function getConfig() {
  const cfg = vscode.workspace.getConfiguration('codeLensGraph');
  return {
    autoRebuildOnSave:   cfg.get<boolean>('autoRebuildOnSave', true),
    maxGraphDepth:       cfg.get<number>('maxGraphDepth', 2),
    maxTokenBudget:      cfg.get<number>('maxTokenBudget', 2000),
    excludePatterns:     cfg.get<string[]>('excludePatterns', DEFAULT_EXCLUDE_PATTERNS),
    supportedExtensions: cfg.get<string[]>('supportedExtensions',
      ['.ts','.tsx','.js','.jsx','.mjs','.py','.go','.rs','.java','.cs','.cpp','.c','.rb','.php','.swift','.kt']),
  };
}

type StatusState = 'idle' | 'scanning' | 'updating' | 'ready' | 'error';

function setStatus(state: StatusState, nodes?: number, edges?: number): void {
  switch (state) {
    case 'scanning':
      statusBarItem.text    = '$(loading~spin) CodeLens: scanning…';
      statusBarItem.tooltip = 'Building knowledge graph in background…';
      break;
    case 'updating':
      statusBarItem.text    = '$(loading~spin) CodeLens: updating…';
      statusBarItem.tooltip = 'Updating graph after agent run…';
      break;
    case 'ready':
      statusBarItem.text    = `$(type-hierarchy) CodeLens: ${nodes ?? '?'} symbols`;
      statusBarItem.tooltip = `Graph ready · ${nodes} nodes · ${edges} edges\nClick to open graph viewer`;
      break;
    case 'error':
      statusBarItem.text    = '$(warning) CodeLens: error';
      statusBarItem.tooltip = 'Graph error — check Output panel for details';
      break;
    default:
      statusBarItem.text    = '$(type-hierarchy) CodeLens Graph';
      statusBarItem.tooltip = 'Click to open graph viewer';
  }
}

async function getOrPromptSelectedIdes(context: vscode.ExtensionContext, forcePrompt = false): Promise<string[]> {
  const selected = context.workspaceState.get<string[]>('selectedIdes');
  if (selected !== undefined && !forcePrompt) {
    return selected;
  }

  const items: vscode.QuickPickItem[] = [
    { label: 'vscode', description: 'VS Code rules & project mcp.json' },
    { label: 'cursor', description: 'Cursor rules (.cursor/rules/codelens.mdc)' },
    { label: 'antigravity', description: 'Antigravity rules (.agents/AGENTS.md)' },
    { label: 'Claude', description: 'Claude Code rules (CLAUDE.md)' },
    { label: 'Winsurf', description: 'Windsurf rules (.windsurfrules)' }
  ];

  const choice = await vscode.window.showQuickPick(items, {
    title: 'CodeLens Graph: Select IDE Configurations to Install Automatically',
    placeHolder: 'Select IDEs (Press Space to select, Enter to confirm, Escape to skip/cancel)',
    canPickMany: true,
    ignoreFocusOut: true
  });

  if (choice === undefined) {
    if (selected === undefined) {
      await context.workspaceState.update('selectedIdes', []);
      return [];
    }
    return selected;
  }

  const result = choice.map(item => item.label);
  await context.workspaceState.update('selectedIdes', result);
  return result;
}
