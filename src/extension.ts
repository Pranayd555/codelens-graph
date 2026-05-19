// ─── VS Code extension entry point ───────────────────────────────────────────
// This file is loaded by VS Code when the extension activates.
// It wires together: DB → parser → scanner → watcher → context builder → UI.

import * as vscode from 'vscode';
import * as path from 'path';
import * as crypto from 'crypto';

import { GraphDB }          from './graph/graphDB';
import { ASTParser }        from './ingestion/astParser';
import { WorkspaceScanner } from './ingestion/workspaceScanner';
import { FileWatcher }      from './ingestion/fileWatcher';
import { ContextBuilder }   from './context/contextBuilder';
import { GraphDiffer }      from './graph/differ';
import { getGraphPanelHtml, toWebviewData } from './ui/graphPanel';
import { GraphStats }       from './types';

// ─── Global extension state ───────────────────────────────────────────────────

let db:             GraphDB;
let parser:         ASTParser;
let scanner:        WorkspaceScanner;
let watcher:        FileWatcher;
let contextBuilder: ContextBuilder;
let differ:         GraphDiffer;

let graphPanel:     vscode.WebviewPanel | undefined;
let statusBarItem:  vscode.StatusBarItem;
let lastBuildStats: GraphStats | undefined;

// ─── activate ─────────────────────────────────────────────────────────────────
// Called once when VS Code loads the extension.

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  console.log('[CodeLens Graph] Activating…');

  // ── 1. Initialize core services ──────────────────────────────────────────

  db             = new GraphDB(context.globalStorageUri.fsPath);
  parser         = new ASTParser();
  scanner        = new WorkspaceScanner(parser, db);
  watcher        = new FileWatcher(scanner);
  contextBuilder = new ContextBuilder(db);
  differ         = new GraphDiffer(db);

  await db.init();

  // ── 2. Status bar item ────────────────────────────────────────────────────

  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBarItem.command = 'codelens-graph.showGraph';
  updateStatusBar('idle');
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);

  // ── 3. Register commands ──────────────────────────────────────────────────

  context.subscriptions.push(

    vscode.commands.registerCommand('codelens-graph.buildGraph', async () => {
      await buildGraph(context);
    }),

    vscode.commands.registerCommand('codelens-graph.rebuildGraph', async () => {
      await buildGraph(context, true);
    }),

    vscode.commands.registerCommand('codelens-graph.showGraph', () => {
      showGraphPanel(context);
    }),

    vscode.commands.registerCommand('codelens-graph.showContext', async () => {
      await showContextPreview();
    }),

    vscode.commands.registerCommand('codelens-graph.searchSymbol', async () => {
      await searchSymbol();
    }),
  );

  // ── 4. File system watcher (auto-update on save) ──────────────────────────

  const config = getConfig();
  if (config.autoRebuildOnSave) {
    const supported = config.supportedExtensions.join(',');
    const fsWatcher = vscode.workspace.createFileSystemWatcher(`**/*{${supported}}`);

    fsWatcher.onDidChange(uri => watcher.handleFileChange(uri.fsPath).then(() => {
      refreshGraphPanel();
      updateStatusBar('idle');
    }));
    fsWatcher.onDidCreate(uri => watcher.handleFileCreate(uri.fsPath).then(() => {
      refreshGraphPanel();
    }));
    fsWatcher.onDidDelete(uri => {
      db.deleteNodesByFile(uri.fsPath);
      db.persist();
      refreshGraphPanel();
    });

    context.subscriptions.push(fsWatcher);
  }

  // ── 5. Auto-build on first activation if workspace has files ─────────────

  const stats = db.getStats();
  if (stats.totalNodes === 0 && vscode.workspace.workspaceFolders?.length) {
    // First time: build automatically in the background
    buildGraph(context).catch(console.error);
  } else {
    updateStatusBar('ready', stats.totalNodes, stats.totalEdges);
  }

  console.log('[CodeLens Graph] Activated ✓');
}

// ─── deactivate ────────────────────────────────────────────────────────────────

export function deactivate(): void {
  watcher?.dispose();
  db?.close();
  console.log('[CodeLens Graph] Deactivated');
}

// ─── buildGraph ───────────────────────────────────────────────────────────────

async function buildGraph(context: vscode.ExtensionContext, force = false): Promise<void> {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders?.length) {
    vscode.window.showWarningMessage('CodeLens Graph: No workspace folder open.');
    return;
  }

  const config = getConfig();
  updateStatusBar('building');

  await vscode.window.withProgress({
    location: vscode.ProgressLocation.Notification,
    title: 'CodeLens: Building knowledge graph…',
    cancellable: false,
  }, async (progress) => {
    const rootPaths = folders.map(f => f.uri.fsPath);

    const result = await scanner.scanWorkspace(rootPaths, {
      excludePatterns: config.excludePatterns,
      supportedExtensions: config.supportedExtensions,
      onProgress: (current, total, filePath) => {
        const pct = Math.round((current / total) * 100);
        progress.report({
          message: `${pct}%  ${path.basename(filePath)}`,
          increment: 100 / total,
        });
      },
    });

    const dbStats = db.getStats();
    lastBuildStats = {
      ...dbStats,
      lastBuilt: Date.now(),
      buildDurationMs: result.durationMs,
    };

    updateStatusBar('ready', dbStats.totalNodes, dbStats.totalEdges);
    refreshGraphPanel();

    vscode.window.showInformationMessage(
      `CodeLens Graph built: ${result.filesScanned} files · ${result.nodesAdded} symbols · ${result.edgesAdded} edges  (${result.durationMs}ms)`
    );

    if (result.errors.length > 0) {
      console.warn('[CodeLens] Parse errors:', result.errors.slice(0, 10));
    }
  });
}

// ─── showGraphPanel ────────────────────────────────────────────────────────────

function showGraphPanel(context: vscode.ExtensionContext): void {
  if (graphPanel) {
    graphPanel.reveal();
    return;
  }

  graphPanel = vscode.window.createWebviewPanel(
    'codelens-graph',
    'CodeLens Graph',
    vscode.ViewColumn.Beside,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
    }
  );

  // Load all nodes and edges for initial render
  const allFiles = db.getAllFiles();
  const allNodes: ReturnType<typeof db.getNodesByFile>[number][] = [];
  for (const f of allFiles) { allNodes.push(...db.getNodesByFile(f)); }

  // Collect all edges
  const allEdges: ReturnType<typeof db.getEdgesFrom>[number][] = [];
  for (const node of allNodes) { allEdges.push(...db.getEdgesFrom(node.id)); }

  const webviewData = toWebviewData(allNodes, allEdges);
  const nonce = crypto.randomBytes(16).toString('hex');
  graphPanel.webview.html = getGraphPanelHtml(webviewData, nonce);

  // Handle messages from webview (e.g. click → open file)
  graphPanel.webview.onDidReceiveMessage(msg => {
    if (msg.command === 'openFile' && msg.filePath) {
      const uri = vscode.Uri.file(msg.filePath);
      vscode.window.showTextDocument(uri, {
        selection: new vscode.Range(
          new vscode.Position(Math.max(0, (msg.line ?? 1) - 1), 0),
          new vscode.Position(Math.max(0, (msg.line ?? 1) - 1), 0)
        )
      });
    }
  });

  graphPanel.onDidDispose(() => { graphPanel = undefined; });
}

// Push updated graph data to an open webview panel
function refreshGraphPanel(): void {
  if (!graphPanel) { return; }

  const allFiles = db.getAllFiles();
  const allNodes: ReturnType<typeof db.getNodesByFile>[number][] = [];
  for (const f of allFiles) { allNodes.push(...db.getNodesByFile(f)); }

  const allEdges: ReturnType<typeof db.getEdgesFrom>[number][] = [];
  for (const node of allNodes) { allEdges.push(...db.getEdgesFrom(node.id)); }

  const webviewData = toWebviewData(allNodes, allEdges);
  graphPanel.webview.postMessage({ command: 'updateGraph', ...webviewData });
}

// ─── showContextPreview ───────────────────────────────────────────────────────

async function showContextPreview(): Promise<void> {
  const task = await vscode.window.showInputBox({
    prompt: 'Describe the task the AI agent will work on',
    placeHolder: 'e.g. "add email validation to the user registration form"',
  });

  if (!task) { return; }

  const config = getConfig();
  const agentContext = contextBuilder.build(task, config.maxGraphDepth, config.maxTokenBudget);
  const injection    = contextBuilder.buildSystemPromptInjection(agentContext);

  // Show in a new editor tab
  const doc = await vscode.workspace.openTextDocument({
    language: 'markdown',
    content: [
      `# CodeLens Agent Context Preview`,
      `**Task:** ${task}`,
      `**Estimated tokens:** ${agentContext.tokenEstimate}`,
      `**Relevant symbols found:** ${agentContext.subgraph.nodes.length}`,
      '',
      '## System Prompt Injection',
      '```',
      injection,
      '```',
      '',
      '## Warnings',
      agentContext.warnings.length > 0
        ? agentContext.warnings.map(w => `- ⚠️ ${w}`).join('\n')
        : '_No conflicts detected._',
    ].join('\n'),
  });

  await vscode.window.showTextDocument(doc);
}

// ─── searchSymbol ─────────────────────────────────────────────────────────────

async function searchSymbol(): Promise<void> {
  const query = await vscode.window.showInputBox({
    prompt: 'Search for a symbol in the graph',
    placeHolder: 'function name, class, variable…',
  });

  if (!query) { return; }

  const results = db.searchNodes(query, 20);
  if (results.length === 0) {
    vscode.window.showInformationMessage(`No symbols found matching "${query}"`);
    return;
  }

  const items = results.map(n => ({
    label:       `$(symbol-${n.type === 'function' ? 'method' : n.type}) ${n.name}`,
    description: `${n.type} — ${path.basename(n.filePath)}:${n.line}`,
    detail:      n.signature?.slice(0, 100),
    node:        n,
  }));

  const selected = await vscode.window.showQuickPick(items, {
    matchOnDescription: true,
    matchOnDetail: true,
    placeHolder: `${results.length} symbols found`,
  });

  if (selected) {
    const uri = vscode.Uri.file(selected.node.filePath);
    await vscode.window.showTextDocument(uri, {
      selection: new vscode.Range(
        new vscode.Position(Math.max(0, selected.node.line - 1), 0),
        new vscode.Position(Math.max(0, selected.node.line - 1), 0)
      )
    });
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getConfig() {
  const cfg = vscode.workspace.getConfiguration('codeLensGraph');
  return {
    autoRebuildOnSave:    cfg.get<boolean>('autoRebuildOnSave', true),
    maxGraphDepth:        cfg.get<number>('maxGraphDepth', 2),
    maxTokenBudget:       cfg.get<number>('maxTokenBudget', 2000),
    excludePatterns:      cfg.get<string[]>('excludePatterns', ['**/node_modules/**','**/dist/**','**/build/**','**/.git/**','**/out/**']),
    supportedExtensions:  cfg.get<string[]>('supportedExtensions', ['.ts','.tsx','.js','.jsx','.py','.go','.rs','.java','.cs','.cpp','.c','.rb','.php']),
  };
}

function updateStatusBar(state: 'idle' | 'building' | 'ready', nodes?: number, edges?: number): void {
  if (state === 'building') {
    statusBarItem.text = '$(loading~spin) CodeLens: building…';
    statusBarItem.tooltip = 'Building knowledge graph…';
  } else if (state === 'ready' && nodes !== undefined) {
    statusBarItem.text = `$(type-hierarchy) CodeLens: ${nodes} symbols`;
    statusBarItem.tooltip = `CodeLens Graph: ${nodes} nodes, ${edges} edges\nClick to open graph viewer`;
  } else {
    statusBarItem.text = '$(type-hierarchy) CodeLens Graph';
    statusBarItem.tooltip = 'Click to open graph viewer';
  }
}
