import * as vscode from 'vscode';
import { GraphDB } from '../graph/graphDB';

// ─── StatsViewProvider ────────────────────────────────────────────────────────
// Provides the HTML for the "Graph Stats" sidebar webview view.
// Must be registered with vscode.window.registerWebviewViewProvider.

export class StatsViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewId = 'codelens-graph.statsView';

  private view?: vscode.WebviewView;

  constructor(private db: GraphDB, private context: vscode.ExtensionContext) {}

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    this.view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.context.extensionUri],
    };

    webviewView.webview.html = this.getHtml();

    // Handle messages from the webview (button clicks)
    webviewView.webview.onDidReceiveMessage(msg => {
      switch (msg.command) {
        case 'buildGraph':
          vscode.commands.executeCommand('codelens-graph.buildGraph');
          break;
        case 'showGraph':
          vscode.commands.executeCommand('codelens-graph.showGraph');
          break;
        case 'searchSymbol':
          vscode.commands.executeCommand('codelens-graph.searchSymbol');
          break;
        case 'copyMcpConfig':
          vscode.commands.executeCommand('codelens-graph.copyMcpConfig');
          break;
        case 'showContext':
          vscode.commands.executeCommand('codelens-graph.showContext');
          break;
      }
    });

    // Push initial data as soon as view resolves
    this.refresh();
  }

  // Called from extension whenever graph changes
  refresh(): void {
    if (!this.view) { return; }
    const stats  = this.db.getStats();
    const issues = this.db.getNodesWithUndefinedRefs().length;
    this.view.webview.postMessage({ command: 'update', stats, issues });
  }

  private getHtml(): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }

  body {
    font-family: var(--vscode-font-family, -apple-system, sans-serif);
    font-size: var(--vscode-font-size, 13px);
    color: var(--vscode-foreground, #ccc);
    background: transparent;
    padding: 8px;
  }

  .section { margin-bottom: 14px; }

  .stat-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 6px;
    margin-bottom: 10px;
  }

  .stat-card {
    background: var(--vscode-input-background, #3c3c3c);
    border: 1px solid var(--vscode-panel-border, #444);
    border-radius: 6px;
    padding: 8px 10px;
    text-align: center;
  }

  .stat-card .value {
    font-size: 20px;
    font-weight: 600;
    color: var(--vscode-textLink-foreground, #4ec9b0);
    line-height: 1.2;
  }

  .stat-card .label {
    font-size: 10px;
    color: var(--vscode-descriptionForeground, #888);
    margin-top: 2px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }

  .stat-card.warn .value { color: #f44747; }
  .stat-card.ok   .value { color: #4ec9b0; }

  .type-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 3px 0;
    border-bottom: 1px solid var(--vscode-panel-border, #333);
    font-size: 11px;
  }
  .type-row:last-child { border-bottom: none; }

  .type-dot {
    width: 8px; height: 8px;
    border-radius: 50%;
    display: inline-block;
    margin-right: 5px;
    flex-shrink: 0;
  }

  .type-name { flex: 1; }
  .type-count {
    color: var(--vscode-descriptionForeground, #888);
    font-size: 11px;
    font-weight: 500;
  }

  .btn {
    display: block;
    width: 100%;
    margin-bottom: 5px;
    padding: 5px 10px;
    background: var(--vscode-button-background, #0e639c);
    color: var(--vscode-button-foreground, #fff);
    border: none;
    border-radius: 4px;
    cursor: pointer;
    font-size: 11px;
    text-align: left;
  }
  .btn:hover { background: var(--vscode-button-hoverBackground, #1177bb); }
  .btn.secondary {
    background: var(--vscode-input-background, #3c3c3c);
    color: var(--vscode-foreground, #ccc);
    border: 1px solid var(--vscode-panel-border, #555);
  }
  .btn.secondary:hover { background: var(--vscode-list-hoverBackground, #4c4c4c); }

  .section-title {
    font-size: 10px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.8px;
    color: var(--vscode-descriptionForeground, #888);
    margin-bottom: 6px;
  }

  .empty-state {
    text-align: center;
    padding: 20px 10px;
    color: var(--vscode-descriptionForeground, #888);
    font-size: 12px;
  }

  .empty-state .icon { font-size: 28px; margin-bottom: 8px; }

  .mcp-status {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 11px;
    padding: 5px 8px;
    border-radius: 4px;
    background: var(--vscode-input-background, #3c3c3c);
    margin-bottom: 5px;
  }

  .dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
  .dot.green  { background: #4ec9b0; }
  .dot.yellow { background: #dcdcaa; }
  .dot.red    { background: #f44747; }
</style>
</head>
<body>

<div id="empty-state" class="empty-state" style="display:none">
  <div class="icon">⬡</div>
  <div>Graph not built yet</div>
  <div style="margin-top:4px;font-size:11px">Run <strong>Build Graph</strong> to index your codebase</div>
</div>

<div id="main-content">

  <div class="section">
    <div class="section-title">Graph</div>
    <div class="stat-grid">
      <div class="stat-card">
        <div class="value" id="val-nodes">–</div>
        <div class="label">Symbols</div>
      </div>
      <div class="stat-card">
        <div class="value" id="val-edges">–</div>
        <div class="label">Relations</div>
      </div>
      <div class="stat-card">
        <div class="value" id="val-files">–</div>
        <div class="label">Files</div>
      </div>
      <div class="stat-card" id="card-issues">
        <div class="value" id="val-issues">–</div>
        <div class="label">Issues</div>
      </div>
    </div>
  </div>

  <div class="section" id="type-breakdown">
    <div class="section-title">By type</div>
    <div id="type-list"></div>
  </div>

  <div class="section">
    <div class="section-title">MCP Server</div>
    <div class="mcp-status">
      <div class="dot green"></div>
      <span>8 tools available</span>
    </div>
    <div style="font-size:10px;color:var(--vscode-descriptionForeground);margin-bottom:6px">
      codelens_search · codelens_context · codelens_callers<br>
      codelens_impact · codelens_node · codelens_files…
    </div>
    <button class="btn secondary" onclick="send('copyMcpConfig')">⎘ Copy MCP Config</button>
  </div>

  <div class="section">
    <div class="section-title">Actions</div>
    <button class="btn" onclick="send('buildGraph')">⟳ Build / Rebuild Graph</button>
    <button class="btn secondary" onclick="send('showGraph')">⬡ Open Graph Explorer</button>
    <button class="btn secondary" onclick="send('searchSymbol')">⌕ Search Symbol</button>
    <button class="btn secondary" onclick="send('showContext')">⊙ Preview Agent Context</button>
  </div>

</div>

<script>
  const vscode = acquireVsCodeApi();
  function send(cmd) { vscode.postMessage({ command: cmd }); }

  const TYPE_COLORS = {
    function:  '#4ec9b0', method: '#569cd6', class: '#c586c0',
    interface: '#dcdcaa', variable: '#9cdcfe', property: '#ce9178',
    import:    '#555',    enum: '#f44747',    type: '#d7ba7d',
    file:      '#888',
  };

  window.addEventListener('message', ev => {
    const { command, stats, issues } = ev.data;
    if (command !== 'update') { return; }

    const empty = !stats || stats.totalNodes === 0;
    document.getElementById('empty-state').style.display  = empty ? 'block' : 'none';
    document.getElementById('main-content').style.display = empty ? 'none'  : 'block';

    if (empty) { return; }

    document.getElementById('val-nodes').textContent  = fmt(stats.totalNodes);
    document.getElementById('val-edges').textContent  = fmt(stats.totalEdges);
    document.getElementById('val-files').textContent  = fmt(stats.fileCount);
    document.getElementById('val-issues').textContent = fmt(issues);

    const issueCard = document.getElementById('card-issues');
    issueCard.className = 'stat-card ' + (issues > 0 ? 'warn' : 'ok');

    // Type breakdown
    const byType = stats.byType ?? {};
    const sorted = Object.entries(byType)
      .filter(([,v]) => v > 0)
      .sort((a, b) => b[1] - a[1]);

    const list = document.getElementById('type-list');
    list.innerHTML = sorted.map(([type, count]) =>
      '<div class="type-row">' +
        '<span class="type-dot" style="background:' + (TYPE_COLORS[type] ?? '#888') + '"></span>' +
        '<span class="type-name">' + type + '</span>' +
        '<span class="type-count">' + fmt(count) + '</span>' +
      '</div>'
    ).join('');
  });

  function fmt(n) {
    if (n == null) { return '–'; }
    return n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n);
  }
</script>
</body>
</html>`;
  }
}
