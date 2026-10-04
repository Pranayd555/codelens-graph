import * as vscode from 'vscode';
import * as path   from 'path';
import * as crypto from 'crypto';
import * as fs     from 'fs';
import * as os     from 'os';

import { GraphDB }            from './graph/graphDB';
import { ASTParser }          from './ingestion/astParser';
import { WorkspaceScanner, ScanOptions } from './ingestion/workspaceScanner';
import { ContextBuilder }     from './context/contextBuilder';
import { GraphDiffer }        from './graph/differ';
import { SkillGenerator }     from './agent/skillGenerator';
import { BackgroundScanner }  from './agent/backgroundScanner';
import { getGraphPanelHtml, toWebviewData } from './ui/graphPanel';
import { readRecentLogs, formatUsageReport } from './mcp/mcpLogger';
import { StatsViewProvider }   from './ui/statsView';
import { IndexedFoldersProvider, FolderItem, listChildFolders } from './ui/indexedFoldersView';
import {
  IndexScope, normalizeFolders, isInScope, toggleFolder, suggestFolders,
  countFilesByFolder, folderCount, CONTAINER_FOLDER_NAMES,
} from './ingestion/indexScope';
import { GraphStats }         from './types';
import { isNodeModulePath }   from './utils';

// ─── Extension-wide state ─────────────────────────────────────────────────────

let db:                GraphDB;
let parser:            ASTParser;
let scanner:           WorkspaceScanner;
let contextBuilder:    ContextBuilder;
let differ:            GraphDiffer;
let skillGenerator:    SkillGenerator;
let backgroundScanner: BackgroundScanner;

let graphPanel:       vscode.WebviewPanel | undefined;
let statusBarItem:    vscode.StatusBarItem;
let statsViewProvider: StatsViewProvider;
let currentStatus: StatusState = 'idle';
let deactivated = false;
let agentSetupOffered = false;
let awaitingFolderSelection = false;
let indexedFoldersProvider: IndexedFoldersProvider | undefined;
let scopeChangeTimer: ReturnType<typeof setTimeout> | undefined;

// Settings edits arrive in bursts (several checkbox clicks); re-scan once they settle.
const SCOPE_CHANGE_DEBOUNCE_MS = 800;

// onStartupFinished already defers activation until VS Code's own startup is
// done. This extra pause lets the extensions that activate alongside us
// (language servers, git, linters) do their startup work before we index.
const STARTUP_SETTLE_MS = 4_000;

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
  contextBuilder = new ContextBuilder(db);
  differ         = new GraphDiffer(db);
  skillGenerator = new SkillGenerator(db);
  backgroundScanner = new BackgroundScanner(db, scanner, skillGenerator,
    () => context.workspaceState.get<string[]>('selectedIdes'));

  // Indexing and the agent-setup prompt happen in the background once VS Code
  // has settled; activation itself returns immediately.
  void startup(context);

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

  // ── 3b. Indexed Folders view: checkboxes mirror codeLensGraph.includeFolders
  const viewRoot = vscode.workspace.workspaceFolders?.[0].uri.fsPath;
  if (viewRoot) {
    indexedFoldersProvider = new IndexedFoldersProvider(viewRoot, () => getConfig().includeFolders);
    const foldersView = vscode.window.createTreeView('codelens-graph.indexedFolders', {
      treeDataProvider: indexedFoldersProvider,
      manageCheckboxStateManually: true,
    });
    foldersView.onDidChangeCheckboxState(async event => {
      let folders = getConfig().includeFolders;
      for (const [item, state] of event.items) {
        if (!(item instanceof FolderItem)) { continue; }
        const next = toggleFolder(folders, item.relPath, state === vscode.TreeItemCheckboxState.Checked,
          relDir => listChildFolders(viewRoot, relDir));
        if (next === null) {
          vscode.window.showWarningMessage('CodeLens Graph: at least one folder must stay indexed.');
          indexedFoldersProvider?.refresh();
          return;
        }
        folders = next;
      }
      await saveIncludeFolders(folders);
    });
    context.subscriptions.push(foldersView);
  }

  context.subscriptions.push(
    vscode.commands.registerCommand('codelens-graph.selectIndexedFolders', () => selectIndexedFolders(context)),
    vscode.commands.registerCommand('codelens-graph.indexEntireWorkspace', async () => {
      await context.workspaceState.update('codelens.indexEntireWorkspace', true);
      await saveIncludeFolders([]);
      if (awaitingFolderSelection) { void indexWorkspace(context); }
    }),
    vscode.commands.registerCommand('codelens-graph.refreshIndexedFolders', () => refreshFolderCounts()),

    // Changing the scope (or what counts as indexable) reconciles the graph:
    // only added/removed folders cost anything; unchanged files are skipped.
    vscode.workspace.onDidChangeConfiguration(event => {
      const scopeChanged = ['includeFolders', 'excludePatterns', 'supportedExtensions']
        .some(key => event.affectsConfiguration('codeLensGraph.' + key));
      if (!scopeChanged) { return; }
      indexedFoldersProvider?.refresh();
      if (scopeChangeTimer) { clearTimeout(scopeChangeTimer); }
      scopeChangeTimer = setTimeout(() => {
        scopeChangeTimer = undefined;
        if (deactivated || !vscode.workspace.isTrusted || context.workspaceState.get<boolean>('graphCleared')) { return; }
        console.log('[CodeLens] Index scope changed — reconciling the graph.');
        void indexWorkspace(context);
      }, SCOPE_CHANGE_DEBOUNCE_MS);
    }),
    { dispose: () => { if (scopeChangeTimer) { clearTimeout(scopeChangeTimer); } } },
  );

  // ── 4. Background scanner callbacks (was 3) ──────────────────────────────

  backgroundScanner.onStatus(state => {
    if (state === 'scanning')  { setStatus('scanning'); }
    if (state === 'updating')  { setStatus('updating'); }
    if (state === 'ready')     {
      const s = db.getStats();
      setStatus('ready', s.totalNodes, s.totalEdges);
      refreshAll();
    }
    if (state === 'error')     { setStatus('error'); }
  });

  backgroundScanner.onComplete(stats => {
    setStatus('ready', stats.totalNodes, stats.totalEdges);
    refreshAll();
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
      const workspaceRoot = vscode.workspace.workspaceFolders?.[0].uri.fsPath;
      if (!workspaceRoot) { return; }

      const files = changedFiles ?? await detectRecentlyChangedFiles(workspaceRoot);

      setStatus('updating');
      await backgroundScanner.handleAgentRunComplete(files, currentScope(), scanOptions());

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
      await configureAgents(context);
    }),

    // Clear configuration files (user-triggered)
    vscode.commands.registerCommand('codelens-graph.clearConfig', async () => {
      try {
        const choice = await vscode.window.showWarningMessage(
          'Are you sure you want to clear all configurations and directories created by CodeLens Graph?',
          'Yes',
          'Cancel'
        );
        if (choice !== 'Yes') { return; }

        const workspaceRoot = vscode.workspace.workspaceFolders?.[0].uri.fsPath;
        if (!workspaceRoot) { return; }

        // 1. Stop incremental indexing, then close and reset the database connection
        backgroundScanner.setAcceptingChanges(false);
        db?.close();

        // 2. Clear configurations and directories on disk
        skillGenerator.clearAll(workspaceRoot);

        // 3. Clear stored workspace state and set cleared flag
        await context.workspaceState.update('selectedIdes', undefined);
        await context.workspaceState.update('graphCleared', true);

        // 4. Reset extension status
        setStatus('idle');
        statsViewProvider?.refresh();

        vscode.window.showInformationMessage('CodeLens Graph: Configurations and directories cleared successfully.');
      } catch (err: any) {
        vscode.window.showErrorMessage(`CodeLens: Failed to clear configurations: ${err?.message || err}`);
      }
    }),
  );

  // ── 6. File system watcher → incremental graph updates ────────────────────

  const cfg = getConfig();
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0].uri.fsPath;
  const supported = cfg.supportedExtensions.join(',');

  if (cfg.autoRebuildOnSave && workspaceRoot) {
    const fsWatcher = vscode.workspace.createFileSystemWatcher(`**/*{${supported}}`);

    // Only files the scanner would index (in the selected folders, not
    // excluded). Deletes are let through for folders (no extension), since a
    // deleted folder arrives as one event; non-indexed paths are no-ops.
    const isExcludedPath = (fsPath: string, change: 'change' | 'delete'): boolean => {
      const scope = currentScope();
      if (!isInScope(fsPath, scope) || isNodeModulePath(fsPath)) { return true; }
      if (change === 'delete' && !path.extname(fsPath)) { return false; }
      return !scanner.isFileAllowed(fsPath, scope, scanOptions());
    };
    // Events are batched (a git checkout can fire hundreds) and applied in the
    // background; the scanner refreshes the UI once per batch via onStatus.
    const queueChange = (uri: vscode.Uri, change: 'change' | 'delete') => {
      if (isExcludedPath(uri.fsPath, change)) { return; }
      backgroundScanner.queueFileChange(uri.fsPath, change, workspaceRoot);
    };
    fsWatcher.onDidChange(uri => queueChange(uri, 'change'));
    fsWatcher.onDidCreate(uri => queueChange(uri, 'change'));
    fsWatcher.onDidDelete(uri => queueChange(uri, 'delete'));

    context.subscriptions.push(fsWatcher);
  }

  // ── 6b. Dependency manifest: refresh when package.json or a lockfile changes
  if (workspaceRoot) {
    const manifestWatcher = vscode.workspace.createFileSystemWatcher(
      '**/{package.json,package-lock.json,npm-shrinkwrap.json,yarn.lock,pnpm-lock.yaml}'
    );
    let manifestTimer: ReturnType<typeof setTimeout> | undefined;
    const onManifestChange = (uri: vscode.Uri) => {
      if (isNodeModulePath(uri.fsPath) || !isInScope(uri.fsPath, currentScope())) { return; }
      if (manifestTimer) { clearTimeout(manifestTimer); }
      manifestTimer = setTimeout(() => {
        manifestTimer = undefined;
        if (db.isInitialized() && !context.workspaceState.get<boolean>('graphCleared')) {
          void backgroundScanner.refreshDependencies(workspaceRoot);
        }
      }, 2_000);
    };
    manifestWatcher.onDidChange(onManifestChange);
    manifestWatcher.onDidCreate(onManifestChange);
    manifestWatcher.onDidDelete(onManifestChange);
    context.subscriptions.push(manifestWatcher, { dispose: () => { if (manifestTimer) { clearTimeout(manifestTimer); } } });
  }

  // ── 7. Active Workspace registry update ──────────────────────────────────
  if (activeWorkspaceRoot) {
    updateActiveWorkspaceRegistry(activeWorkspaceRoot);
    context.subscriptions.push(
      vscode.window.onDidChangeWindowState(e => {
        if (e.focused) {
          updateActiveWorkspaceRegistry(activeWorkspaceRoot);
        }
      })
    );
  }

  // Refresh savings display every 30s — updates while agent is actively working
  const savingsTimer = setInterval(refreshSavings, 30_000);
  context.subscriptions.push({ dispose: () => clearInterval(savingsTimer) });

  context.subscriptions.push({ dispose: () => backgroundScanner.dispose() });
  console.log('[CodeLens Graph] Activated ✓');
}

// ─── deactivate ───────────────────────────────────────────────────────────────

export function deactivate(): void {
  deactivated = true;
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0].uri.fsPath;
  if (workspaceRoot) {
    updateActiveWorkspaceRegistry(workspaceRoot, true);
  }
  backgroundScanner?.dispose();
  db?.close();
  console.log('[CodeLens Graph] Deactivated');
}

function updateActiveWorkspaceRegistry(workspacePath: string, remove = false): void {
  try {
    const registryDir = path.join(os.homedir(), '.codelens');
    const registryPath = path.join(registryDir, 'active-workspaces.json');
    
    fs.mkdirSync(registryDir, { recursive: true });
    
    let registry: { windows: Record<string, { path: string; lastActive: number }> } = { windows: {} };
    if (fs.existsSync(registryPath)) {
      try {
        registry = JSON.parse(fs.readFileSync(registryPath, 'utf-8'));
      } catch {
        // ignore corruption
      }
    }
    
    if (!registry.windows) {
      registry.windows = {};
    }
    
    const currentPid = String(process.pid);
    
    if (remove) {
      delete registry.windows[currentPid];
    } else {
      registry.windows[currentPid] = {
        path: workspacePath,
        lastActive: Date.now()
      };
    }
    
    // Clean up stale PIDs
    for (const pid of Object.keys(registry.windows)) {
      if (pid === currentPid) { continue; }
      try {
        process.kill(Number(pid), 0);
      } catch (err: any) {
        if (err.code === 'ESRCH') {
          delete registry.windows[pid];
        }
      }
    }
    
    fs.writeFileSync(registryPath, JSON.stringify(registry, null, 2), 'utf-8');
  } catch (err) {
    console.error('[CodeLens] Failed to update active workspace registry:', err);
  }
}

// ─── manualBuild ──────────────────────────────────────────────────────────────
// Triggered by the user explicitly. Shows progress UI unlike background scan.

async function manualBuild(context: vscode.ExtensionContext, force = false): Promise<void> {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders?.length) {
    vscode.window.showWarningMessage('CodeLens Graph: No workspace folder open.');
    return;
  }
  if (!vscode.workspace.isTrusted) {
    vscode.window.showWarningMessage('CodeLens Graph only indexes trusted workspaces. Trust this workspace to build the graph.');
    return;
  }
  await context.workspaceState.update('graphCleared', false);
  await db.ensureInit();
  awaitingFolderSelection = false;
  backgroundScanner.setAcceptingChanges(true);

  const stats = await vscode.window.withProgress({
    location:    vscode.ProgressLocation.Notification,
    title:       'CodeLens: Building knowledge graph…',
    cancellable: false,
  }, progress => backgroundScanner.runFullScan(currentScope(), {
    ...scanOptions(),
    force,
    onProgress: (current, total, filePath) => {
      progress.report({
        message:   `${Math.round((current / total) * 100)}%  ${path.basename(filePath)}`,
        increment: 100 / total,
      });
    },
  }));

  if (!stats) {
    vscode.window.showErrorMessage('CodeLens build failed. See the Extension Host log for details.');
    return;
  }
  vscode.window.showInformationMessage(
    `CodeLens Graph: ${stats.totalNodes} symbols indexed. Dependencies continue indexing in the background.`
  );
  void backgroundScanner.whenIdle().then(() => offerAgentSetup(context));
}

// ─── showGraphPanel ───────────────────────────────────────────────────────────

let lastSentVersion = -1;

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

  lastSentVersion = db.getVersion();
  const nonce   = crypto.randomBytes(16).toString('hex');
  const initial = buildGraphWebviewData();
  const d3Uri   = graphPanel.webview.asWebviewUri(
    vscode.Uri.joinPath(context.extensionUri, 'dist', 'node_modules', 'd3', 'dist', 'd3.min.js')
  );
  graphPanel.webview.html = getGraphPanelHtml(initial, nonce, d3Uri.toString());

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
      // Send current status so panel knows if it's scanning
      graphPanel?.webview.postMessage({ command: 'setStatus', status: currentStatus });

      // Webview JS finished loading. Only push if version changed!
      const currentVersion = db.getVersion();
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
        const currentVersion = db.getVersion();
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
    // Each codelens_context call replaces ~1800 tokens of file reads.
    // Each codelens_search call replaces ~400 tokens of grep + file reads.
    const toolCounts = logs.reduce((m, l) => { m[l.tool] = (m[l.tool] || 0) + 1; return m; }, {} as Record<string, number>);
    const saved = (toolCounts['codelens_context'] ?? 0) * 1800
                + (toolCounts['codelens_search']  ?? 0) * 400
                + (toolCounts['codelens_relations'] ?? 0) * 300
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
  if (currentStatus === 'idle' && !db.isInitialized()) {
    graphPanel.webview.postMessage({ command: 'updateGraph', nodes: [], edges: [] });
    return;
  }
  lastSentVersion = db.getVersion();
  const data = buildGraphWebviewData();
  graphPanel.webview.postMessage({ command: 'updateGraph', ...data });
}

function refreshAll(): void {
  refreshGraphPanel();
  statsViewProvider?.refresh();
  refreshSavings();
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
    autoRebuildOnSave:      cfg.get<boolean>('autoRebuildOnSave', true),
    maxGraphDepth:          cfg.get<number>('maxGraphDepth', 2),
    maxTokenBudget:         cfg.get<number>('maxTokenBudget', 2000),
    excludePatterns:        cfg.get<string[]>('excludePatterns', DEFAULT_EXCLUDE_PATTERNS),
    includeFolders:         normalizeFolders(cfg.get<string[]>('includeFolders', [])),
    largeWorkspaceThreshold: cfg.get<number>('largeWorkspaceThreshold', 5000),
    supportedExtensions:    cfg.get<string[]>('supportedExtensions',
      ['.ts','.tsx','.js','.jsx','.mjs','.py','.go','.rs','.java','.cs','.cpp','.c','.rb','.php','.swift','.kt']),
  };
}

type StatusState = 'idle' | 'scanning' | 'updating' | 'ready' | 'error' | 'needsFolders';

function setStatus(state: StatusState, nodes?: number, edges?: number): void {
  currentStatus = state;
  statusBarItem.command = 'codelens-graph.showGraph';
  statsViewProvider?.setStatus(state);
  if (graphPanel) {
    graphPanel.webview.postMessage({ command: 'setStatus', status: state });
  }
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
    case 'needsFolders':
      statusBarItem.text    = '$(list-tree) CodeLens: choose folders';
      statusBarItem.tooltip = 'Large workspace — choose which folders to index';
      statusBarItem.command = 'codelens-graph.selectIndexedFolders';
      return;
    case 'error':
      statusBarItem.text    = '$(warning) CodeLens: error';
      statusBarItem.tooltip = 'Graph error — check Output panel for details';
      break;
    default:
      statusBarItem.text    = '$(type-hierarchy) CodeLens Graph';
      statusBarItem.tooltip = 'Click to open graph viewer';
  }
}

// ─── Startup ──────────────────────────────────────────────────────────────────
// Never blocks activation and never waits on the user before indexing:
//   1. wait until the workspace is trusted and VS Code has settled
//   2. index in the background (unchanged files are skipped, so this is cheap
//      on later startups and catches edits made while VS Code was closed)
//   3. only then, with this window focused, offer the one-time agent setup

async function startup(context: vscode.ExtensionContext): Promise<void> {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0].uri.fsPath;
  if (!workspaceRoot) { return; }
  try {
    await db.init();
    const stats = db.getStats();
    if (stats.totalNodes > 0) { setStatus('ready', stats.totalNodes, stats.totalEdges); }
    statsViewProvider?.refresh();

    if (context.workspaceState.get<boolean>('graphCleared')) {
      setStatus('idle');
      return;
    }

    await whenWorkspaceTrusted(context);
    await new Promise(resolve => setTimeout(resolve, STARTUP_SETTLE_MS));
    if (deactivated) { return; }

    // Never indexed, no folders selected, and very large: ask before indexing.
    const scope = currentScope();
    if (stats.totalNodes === 0 && !scope.folders.length
        && !context.workspaceState.get<boolean>('codelens.indexEntireWorkspace')) {
      const fileCount = await backgroundScanner.countIndexableFiles(scope, scanOptions());
      if (fileCount > getConfig().largeWorkspaceThreshold) {
        console.log(`[CodeLens] ${fileCount} indexable files — asking which folders to index.`);
        await offerFolderSelection(context, fileCount);
        return;
      }
    }

    console.log('[CodeLens] Startup settled — indexing in the background.');
    await indexWorkspace(context);
  } catch (err) {
    console.error('[CodeLens] Startup failed:', err);
    setStatus('error');
  }
}

// Brings the graph in line with the folder selection (only added/removed or
// changed files cost anything), then offers agent setup once.
async function indexWorkspace(context: vscode.ExtensionContext): Promise<void> {
  awaitingFolderSelection = false;
  backgroundScanner.setAcceptingChanges(true);
  await backgroundScanner.runFullScan(currentScope(), scanOptions());
  await backgroundScanner.whenIdle();
  if (deactivated) { return; }
  await offerAgentSetup(context);
}

// Shown once per session for a large workspace that has never been indexed.
async function offerFolderSelection(context: vscode.ExtensionContext, fileCount: number): Promise<void> {
  awaitingFolderSelection = true;
  setStatus('needsFolders');
  await whenWindowFocused(context);
  if (deactivated || !awaitingFolderSelection) { return; }
  const choice = await vscode.window.showInformationMessage(
    `CodeLens Graph: this workspace has ${fileCount.toLocaleString()} source files. `
      + 'Choose which folders to index to keep the graph fast, or index everything.',
    'Choose Folders…', 'Index Everything', 'Not Now'
  );
  if (choice === 'Choose Folders…') {
    await selectIndexedFolders(context, true);
  } else if (choice === 'Index Everything') {
    await context.workspaceState.update('codelens.indexEntireWorkspace', true);
    await indexWorkspace(context);
  }
}

// Picker with per-folder file counts. On a first selection, common source
// roots (src/, lib/, packages/*, …) are pre-checked.
async function selectIndexedFolders(context: vscode.ExtensionContext, suggest = false): Promise<void> {
  const root = vscode.workspace.workspaceFolders?.[0].uri.fsPath;
  if (!root) { return; }
  const current = getConfig().includeFolders;
  const allFiles = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Window, title: 'CodeLens: counting files…' },
    () => scanner.listFiles({ workspaceRoot: root, folders: [] }, scanOptions())
  );
  const counts = countFilesByFolder(allFiles, root);
  indexedFoldersProvider?.setFileCounts(counts);

  const topLevel = listChildFolders(root, '');
  const candidates = new Set<string>();
  for (const folder of topLevel) {
    candidates.add(folder);
    if (CONTAINER_FOLDER_NAMES.has(folder.toLowerCase())) {
      for (const child of listChildFolders(root, folder)) { candidates.add(`${folder}/${child}`); }
    }
  }
  current.forEach(folder => candidates.add(folder));
  const preselected = current.length
    ? current
    : suggest ? suggestFolders(topLevel, relDir => listChildFolders(root, relDir)) : [];

  const ENTIRE = '$(root-folder) Entire workspace';
  type FolderPick = vscode.QuickPickItem & { folder?: string };
  const items: FolderPick[] = [
    { label: ENTIRE, description: `${allFiles.length} files`, picked: !preselected.length },
    ...[...candidates].sort().map(folder => ({
      label: folder,
      description: `${folderCount(counts, folder)} files`,
      folder,
      picked: preselected.some(p => p === folder || folder.startsWith(p + '/')),
    })),
  ];
  const picked = await vscode.window.showQuickPick(items, {
    canPickMany: true,
    ignoreFocusOut: true,
    title: 'CodeLens Graph — folders to index',
    placeHolder: 'Files directly in the workspace root are always indexed. Space to toggle, Enter to save.',
  });
  if (!picked?.length) { return; }

  const folders = picked.some(p => p.label === ENTIRE) ? [] : normalizeFolders(picked.map(p => p.folder));
  if (!folders.length) { await context.workspaceState.update('codelens.indexEntireWorkspace', true); }
  const unchanged = JSON.stringify(folders) === JSON.stringify(current);
  await saveIncludeFolders(folders);
  // Saving the same value fires no configuration change, so start indexing here.
  if (unchanged && awaitingFolderSelection) { void indexWorkspace(context); }
}

// The selection lives in workspace settings (.vscode/settings.json) so it can
// be shared with the team and read by a standalone MCP server.
async function saveIncludeFolders(folders: string[]): Promise<void> {
  await vscode.workspace.getConfiguration('codeLensGraph')
    .update('includeFolders', folders.length ? folders : undefined, vscode.ConfigurationTarget.Workspace);
  indexedFoldersProvider?.refresh();
}

async function refreshFolderCounts(): Promise<void> {
  const root = vscode.workspace.workspaceFolders?.[0].uri.fsPath;
  if (!root || !indexedFoldersProvider) { return; }
  const files = await scanner.listFiles({ workspaceRoot: root, folders: [] }, scanOptions());
  indexedFoldersProvider.setFileCounts(countFilesByFolder(files, root));
}

function currentScope(): IndexScope {
  return {
    workspaceRoot: vscode.workspace.workspaceFolders?.[0].uri.fsPath ?? '',
    folders:       getConfig().includeFolders,
  };
}

function whenWorkspaceTrusted(context: vscode.ExtensionContext): Promise<void> {
  if (vscode.workspace.isTrusted) { return Promise.resolve(); }
  return new Promise(resolve => {
    const sub = vscode.workspace.onDidGrantWorkspaceTrust(() => { sub.dispose(); resolve(); });
    context.subscriptions.push(sub);
  });
}

function whenWindowFocused(context: vscode.ExtensionContext): Promise<void> {
  if (vscode.window.state.focused) { return Promise.resolve(); }
  return new Promise(resolve => {
    const sub = vscode.window.onDidChangeWindowState(state => {
      if (state.focused) { sub.dispose(); resolve(); }
    });
    context.subscriptions.push(sub);
  });
}

// The only prompt CodeLens shows on its own. It appears after indexing has
// finished, in the focused window, until the user picks agents or opts out.
async function offerAgentSetup(context: vscode.ExtensionContext): Promise<void> {
  const decided = () => context.workspaceState.get<string[]>('selectedIdes') !== undefined;
  if (agentSetupOffered || decided()) { return; }
  await whenWindowFocused(context);
  if (agentSetupOffered || decided() || deactivated) { return; }
  agentSetupOffered = true;
  console.log('[CodeLens] Offering agent setup.');

  const stats = db.getStats();
  const choice = await vscode.window.showInformationMessage(
    `CodeLens Graph indexed ${stats.totalNodes} symbols in ${stats.fileCount} files. `
      + 'Set up your AI agents (Claude Code, Cursor, Copilot, Windsurf) to use it?',
    'Choose Agents…', 'Not Now', "Don't Ask Again"
  );
  if (choice === 'Choose Agents…') {
    await configureAgents(context);
  } else if (choice === "Don't Ask Again") {
    await context.workspaceState.update('selectedIdes', []);
  }
}

async function configureAgents(context: vscode.ExtensionContext): Promise<void> {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0].uri.fsPath;
  if (!workspaceRoot) { return; }
  await db.ensureInit();
  const ides = await promptForIdes(context);
  if (ides === undefined) { return; }
  const stats: GraphStats = { ...db.getStats(), lastBuilt: Date.now(), buildDurationMs: 0 };
  const written = skillGenerator.generateAll(workspaceRoot, stats, ides);
  vscode.window.showInformationMessage(`CodeLens: Agent configuration updated → ${written.join(', ')}`);
}

function scanOptions(): ScanOptions {
  const cfg = getConfig();
  return {
    excludePatterns:        cfg.excludePatterns,
    supportedExtensions:    cfg.supportedExtensions,
  };
}

// Returns the chosen IDEs (and remembers them), or undefined if cancelled.
async function promptForIdes(context: vscode.ExtensionContext): Promise<string[] | undefined> {
  const selected = context.workspaceState.get<string[]>('selectedIdes');

  const items: vscode.QuickPickItem[] = [
    { label: 'vscode', description: 'VS Code rules & project mcp.json' },
    { label: 'cursor', description: 'Cursor rules (.cursor/rules/codelens.mdc)' },
    { label: 'antigravity', description: 'Antigravity rules (.agents/AGENTS.md)' },
    { label: 'Claude', description: 'Claude Code rules (CLAUDE.md)' },
    { label: 'Winsurf', description: 'Windsurf rules (.windsurfrules)' }
  ];

  for (const item of items) { item.picked = selected?.includes(item.label) ?? false; }

  const choice = await vscode.window.showQuickPick(items, {
    title: 'CodeLens Graph: Select IDE Configurations to Install Automatically',
    placeHolder: 'Select IDEs (Space to toggle, Enter to confirm, Escape to cancel)',
    canPickMany: true,
    ignoreFocusOut: true
  });

  if (choice === undefined) { return undefined; }

  const result = choice.map(item => item.label);
  await context.workspaceState.update('selectedIdes', result);
  return result;
}
