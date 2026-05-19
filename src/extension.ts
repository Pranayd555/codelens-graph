import * as vscode from 'vscode';
import * as path   from 'path';
import * as crypto from 'crypto';

import { GraphDB }            from './graph/graphDB';
import { ASTParser }          from './ingestion/astParser';
import { WorkspaceScanner }   from './ingestion/workspaceScanner';
import { FileWatcher }        from './ingestion/fileWatcher';
import { ContextBuilder }     from './context/contextBuilder';
import { GraphDiffer }        from './graph/differ';
import { SkillGenerator }     from './agent/skillGenerator';
import { BackgroundScanner }  from './agent/backgroundScanner';
import { getGraphPanelHtml, toWebviewData } from './ui/graphPanel';
import { GraphStats }         from './types';

// ─── Extension-wide state ─────────────────────────────────────────────────────

let db:                GraphDB;
let parser:            ASTParser;
let scanner:           WorkspaceScanner;
let fileWatcher:       FileWatcher;
let contextBuilder:    ContextBuilder;
let differ:            GraphDiffer;
let skillGenerator:    SkillGenerator;
let backgroundScanner: BackgroundScanner;

let graphPanel:    vscode.WebviewPanel | undefined;
let statusBarItem: vscode.StatusBarItem;

// ─── activate ─────────────────────────────────────────────────────────────────

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  console.log('[CodeLens Graph] Activating…');

  // ── 1. Boot all services ──────────────────────────────────────────────────

  db             = new GraphDB(context.globalStorageUri.fsPath);
  parser         = new ASTParser();
  scanner        = new WorkspaceScanner(parser, db);
  fileWatcher    = new FileWatcher(scanner);
  contextBuilder = new ContextBuilder(db);
  differ         = new GraphDiffer(db);
  skillGenerator = new SkillGenerator(db);
  backgroundScanner = new BackgroundScanner(db, scanner, skillGenerator);

  await db.init();

  // ── 2. Status bar ──────────────────────────────────────────────────────────

  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBarItem.command = 'codelens-graph.showGraph';
  setStatus('idle');
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);

  // ── 3. Background scanner callbacks ───────────────────────────────────────

  backgroundScanner.onStatus(state => {
    if (state === 'scanning')  { setStatus('scanning'); }
    if (state === 'updating')  { setStatus('updating'); }
    if (state === 'ready')     {
      const s = db.getStats();
      setStatus('ready', s.totalNodes, s.totalEdges);
      refreshGraphPanel();
    }
    if (state === 'error')     { setStatus('error'); }
  });

  backgroundScanner.onComplete(stats => {
    setStatus('ready', stats.totalNodes, stats.totalEdges);
    refreshGraphPanel();
  });

  backgroundScanner.onSkills(written => {
    // Silent — only notify first time so user knows what happened
    const shownKey = 'codelens.skillsNotified';
    if (!context.globalState.get(shownKey)) {
      context.globalState.update(shownKey, true);
      vscode.window.showInformationMessage(
        `CodeLens Graph: AI agent rules written to ${written.length} locations ` +
        `(.cursor/rules, .github/copilot-instructions.md, .clinerules…). ` +
        `Your AI agent will now use the graph automatically.`,
        'Show Graph'
      ).then(choice => { if (choice === 'Show Graph') { showGraphPanel(context); } });
    }
  });

  // ── 4. Commands ───────────────────────────────────────────────────────────

  context.subscriptions.push(

    // Manual full rebuild (user-triggered)
    vscode.commands.registerCommand('codelens-graph.buildGraph', async () => {
      await manualBuild(context);
    }),

    vscode.commands.registerCommand('codelens-graph.rebuildGraph', async () => {
      await manualBuild(context, true);
    }),

    // Graph viewer
    vscode.commands.registerCommand('codelens-graph.showGraph', () => {
      showGraphPanel(context);
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
    vscode.commands.registerCommand('codelens-graph.getContextForTask', async (taskDescription?: string) => {
      const task = taskDescription
        ?? await vscode.window.showInputBox({ prompt: 'Task description for context lookup' });
      if (!task) { return; }

      const cfg = getConfig();
      const agentCtx = contextBuilder.build(task, cfg.maxGraphDepth, cfg.maxTokenBudget);
      const injection = contextBuilder.buildSystemPromptInjection(agentCtx);

      // Write to a temp file the agent can read
      const workspaceRoot = vscode.workspace.workspaceFolders?.[0].uri.fsPath;
      if (workspaceRoot) {
        const outPath = path.join(workspaceRoot, '.codelens', 'agent-context.md');
        const fs = require('fs');
        fs.mkdirSync(path.dirname(outPath), { recursive: true });
        fs.writeFileSync(outPath, injection, 'utf-8');
      }

      // Also show in editor so agent can read it inline
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

    // Regenerate just the skill files (no rescan)
    vscode.commands.registerCommand('codelens-graph.regenerateSkills', () => {
      const workspaceRoot = vscode.workspace.workspaceFolders?.[0].uri.fsPath;
      if (!workspaceRoot) { return; }
      const dbStats = db.getStats();
      const stats: GraphStats = { ...dbStats, lastBuilt: Date.now(), buildDurationMs: 0 };
      const written = skillGenerator.generateAll(workspaceRoot, stats);
      vscode.window.showInformationMessage(`CodeLens: Skills regenerated → ${written.join(', ')}`);
    }),
  );

  // ── 5. File system watcher → incremental graph updates ────────────────────

  const cfg = getConfig();
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0].uri.fsPath;
  const supported = cfg.supportedExtensions.join(',');

  if (cfg.autoRebuildOnSave && workspaceRoot) {
    const fsWatcher = vscode.workspace.createFileSystemWatcher(`**/*{${supported}}`);

    fsWatcher.onDidChange(async uri => {
      // Skip files inside .codelens/ to avoid self-triggering
      if (uri.fsPath.includes('.codelens')) { return; }
      await backgroundScanner.handleFileChanged(uri.fsPath, workspaceRoot, {
        excludePatterns:     cfg.excludePatterns,
        supportedExtensions: cfg.supportedExtensions,
      });
      refreshGraphPanel();
    });

    fsWatcher.onDidCreate(async uri => {
      if (uri.fsPath.includes('.codelens')) { return; }
      await fileWatcher.handleFileCreate(uri.fsPath);
      refreshGraphPanel();
    });

    fsWatcher.onDidDelete(uri => {
      db.deleteNodesByFile(uri.fsPath);
      db.persist();
      refreshGraphPanel();
    });

    context.subscriptions.push(fsWatcher);
  }

  // ── 6. Auto-scan on activation (the core of autonomous operation) ─────────

  if (workspaceRoot) {
    const stats = db.getStats();

    if (stats.totalNodes === 0) {
      // First time: scan immediately (with a small delay to not block VS Code startup)
      backgroundScanner.scheduleInitialScan(workspaceRoot, {
        excludePatterns:     cfg.excludePatterns,
        supportedExtensions: cfg.supportedExtensions,
      }, context);
    } else {
      // Already have a graph: just regenerate skills (fast, no rescan needed)
      setStatus('ready', stats.totalNodes, stats.totalEdges);
      const fullStats: GraphStats = { ...stats, lastBuilt: Date.now(), buildDurationMs: 0 };
      skillGenerator.generateAll(workspaceRoot, fullStats);
      console.log(`[CodeLens] Existing graph loaded: ${stats.totalNodes} nodes. Skills refreshed.`);
    }
  }

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

    // Generate / update skill files
    const written = skillGenerator.generateAll(workspaceRoot, stats);

    vscode.window.showInformationMessage(
      `CodeLens Graph: ${result.filesScanned} files · ${result.nodesAdded} symbols · ${result.durationMs}ms` +
      ` | Skills → ${written.length} agent rule files updated`
    );
  });
}

// ─── showGraphPanel ───────────────────────────────────────────────────────────

function showGraphPanel(context: vscode.ExtensionContext): void {
  if (graphPanel) { graphPanel.reveal(); return; }

  graphPanel = vscode.window.createWebviewPanel(
    'codelens-graph', 'CodeLens Graph',
    vscode.ViewColumn.Beside,
    { enableScripts: true, retainContextWhenHidden: true }
  );

  const allFiles = db.getAllFiles();
  const allNodes = allFiles.flatMap(f => db.getNodesByFile(f));
  const allEdges = allNodes.flatMap(n => db.getEdgesFrom(n.id));
  const nonce    = crypto.randomBytes(16).toString('hex');

  graphPanel.webview.html = getGraphPanelHtml(toWebviewData(allNodes, allEdges), nonce);

  graphPanel.webview.onDidReceiveMessage(msg => {
    if (msg.command === 'openFile' && msg.filePath) {
      vscode.window.showTextDocument(vscode.Uri.file(msg.filePath), {
        selection: new vscode.Range(
          new vscode.Position(Math.max(0, (msg.line ?? 1) - 1), 0),
          new vscode.Position(Math.max(0, (msg.line ?? 1) - 1), 0)
        )
      });
    }
  });

  graphPanel.onDidDispose(() => { graphPanel = undefined; });
}

function refreshGraphPanel(): void {
  if (!graphPanel) { return; }
  const allFiles = db.getAllFiles();
  const allNodes = allFiles.flatMap(f => db.getNodesByFile(f));
  const allEdges = allNodes.flatMap(n => db.getEdgesFrom(n.id));
  graphPanel.webview.postMessage({ command: 'updateGraph', ...toWebviewData(allNodes, allEdges) });
}

// ─── showContextPreview ───────────────────────────────────────────────────────

async function showContextPreview(): Promise<void> {
  const task = await vscode.window.showInputBox({
    prompt:      'Describe the AI agent task',
    placeHolder: 'e.g. "add rate limiting to auth middleware"',
  });
  if (!task) { return; }

  const cfg    = getConfig();
  const ctx    = contextBuilder.build(task, cfg.maxGraphDepth, cfg.maxTokenBudget);
  const output = contextBuilder.buildSystemPromptInjection(ctx);

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
}

// ─── searchSymbol ─────────────────────────────────────────────────────────────

async function searchSymbol(): Promise<void> {
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
}

// ─── detectRecentlyChangedFiles ───────────────────────────────────────────────
// Fallback: if the agent doesn't pass changed files, detect files modified in
// the last 5 minutes.

async function detectRecentlyChangedFiles(workspaceRoot: string): Promise<string[]> {
  const uris = await vscode.workspace.findFiles(
    '**/*', '**/node_modules/**', 200
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

function getConfig() {
  const cfg = vscode.workspace.getConfiguration('codeLensGraph');
  return {
    autoRebuildOnSave:   cfg.get<boolean>('autoRebuildOnSave', true),
    maxGraphDepth:       cfg.get<number>('maxGraphDepth', 2),
    maxTokenBudget:      cfg.get<number>('maxTokenBudget', 2000),
    excludePatterns:     cfg.get<string[]>('excludePatterns',     ['**/node_modules/**','**/dist/**','**/build/**','**/.git/**','**/out/**','**/.codelens/**']),
    supportedExtensions: cfg.get<string[]>('supportedExtensions', ['.ts','.tsx','.js','.jsx','.py','.go','.rs','.java','.cs','.cpp','.c','.rb','.php']),
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
