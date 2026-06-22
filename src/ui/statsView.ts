import * as vscode from 'vscode';
import { GraphDB } from '../graph/graphDB';

export class StatsViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewId = 'codelens-graph.statsView';

  private view?: vscode.WebviewView;
  // Cache last stats so we can re-send immediately when view becomes visible
  private lastStats: object | null = null;
  private lastIssues = 0;

  constructor(private db: GraphDB, private context: vscode.ExtensionContext) {}

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _ctx: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    this.view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.context.extensionUri],
    };

    webviewView.webview.html = this.getHtml();

    // When the panel becomes visible again (user switches back to sidebar),
    // re-send the last known data immediately — before the JS listener is
    // guaranteed to be ready, so we use a small delay.
    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) {
        // Small delay ensures webview JS has parsed and registered its listener
        setTimeout(() => this.sendData(), 150);
      }
    });

    webviewView.webview.onDidReceiveMessage(msg => {
      switch (msg.command) {
        case 'ready':
          // Webview signals it's ready — send data immediately
          this.sendData();
          break;
        case 'buildGraph':
          vscode.commands.executeCommand('codelens-graph.buildGraph'); break;
        case 'showGraph':
          vscode.commands.executeCommand('codelens-graph.showGraph'); break;
        case 'searchSymbol':
          vscode.commands.executeCommand('codelens-graph.searchSymbol'); break;
        case 'copyMcpConfig':
          vscode.commands.executeCommand('codelens-graph.copyMcpConfig'); break;
        case 'showContext':
          vscode.commands.executeCommand('codelens-graph.showContext'); break;
        case 'showMcpUsage':
          vscode.commands.executeCommand('codelens-graph.showMcpUsage'); break;
      }
    });

    // Initial data — with delay so JS listener is registered
    setTimeout(() => this.sendData(), 200);
  }

  refresh(): void {
    if (!this.view?.visible) {
      // Compute and cache even when hidden — will be sent on next visibility
      const stats  = this.db.getStats();
      const issues = this.db.getNodesWithUndefinedRefs().length;
      this.lastStats  = stats;
      this.lastIssues = issues;
      return;
    }
    this.sendData();
  }

  private sendData(): void {
    if (!this.view) { return; }
    const stats  = this.db.getStats();
    const issues = this.db.getNodesWithUndefinedRefs().length;
    this.lastStats  = stats;
    this.lastIssues = issues;
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
  font-family: var(--vscode-font-family, system-ui, sans-serif);
  font-size: var(--vscode-font-size, 13px);
  color: var(--vscode-foreground, #ccc);
  background: transparent;
  padding: 10px 8px;
}
.section { margin-bottom: 16px; }
.section-title {
  font-size: 10px; font-weight: 700;
  text-transform: uppercase; letter-spacing: 0.8px;
  color: var(--vscode-descriptionForeground, #888);
  margin-bottom: 7px;
}
.stat-grid {
  display: grid; grid-template-columns: 1fr 1fr; gap: 6px; margin-bottom: 2px;
}
.stat-card {
  background: var(--vscode-input-background, #3c3c3c);
  border: 1px solid var(--vscode-panel-border, #3d3d3d);
  border-radius: 8px; padding: 10px 8px; text-align: center;
  transition: border-color 0.2s;
}
.stat-card:hover { border-color: var(--vscode-focusBorder, #007acc); }
.stat-card .value {
  font-size: 22px; font-weight: 700; line-height: 1.1;
  color: var(--vscode-textLink-foreground, #4ec9b0);
}
.stat-card .label {
  font-size: 10px; color: var(--vscode-descriptionForeground, #888);
  margin-top: 3px; text-transform: uppercase; letter-spacing: 0.4px;
}
.stat-card.warn .value { color: #f85149; }
.stat-card.ok   .value { color: #3fb950; }

.type-row {
  display: flex; align-items: center;
  padding: 4px 2px; border-bottom: 1px solid var(--vscode-panel-border, #2d2d2d);
  font-size: 11px; gap: 6px;
}
.type-row:last-child { border-bottom: none; }
.type-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
.type-name { flex: 1; color: var(--vscode-foreground, #ccc); }
.type-bar-wrap {
  width: 60px; height: 4px;
  background: var(--vscode-input-background, #3c3c3c);
  border-radius: 2px; overflow: hidden;
}
.type-bar { height: 100%; border-radius: 2px; transition: width 0.4s; }
.type-count { color: var(--vscode-descriptionForeground, #888); font-size: 11px; min-width: 28px; text-align: right; }

.mcp-badge {
  display: flex; align-items: center; gap: 7px;
  padding: 6px 9px; border-radius: 7px;
  background: var(--vscode-input-background, #3c3c3c);
  border: 1px solid var(--vscode-panel-border, #3d3d3d);
  font-size: 11px; margin-bottom: 6px;
}
.dot { width: 8px; height: 8px; border-radius: 50%; }
.dot.green  { background: #3fb950; box-shadow: 0 0 4px #3fb950; }
.dot.grey   { background: #8b949e; }
.tool-list {
  font-size: 10px; color: var(--vscode-descriptionForeground, #888);
  margin-bottom: 7px; line-height: 1.6;
}

.btn {
  display: block; width: 100%; margin-bottom: 5px;
  padding: 6px 10px; border-radius: 6px; border: none;
  cursor: pointer; font-size: 11px; font-weight: 500;
  text-align: left; transition: opacity 0.15s;
}
.btn:hover { opacity: 0.85; }
.btn-primary {
  background: var(--vscode-button-background, #0e639c);
  color: var(--vscode-button-foreground, #fff);
}
.btn-secondary {
  background: var(--vscode-input-background, #3c3c3c);
  color: var(--vscode-foreground, #ccc);
  border: 1px solid var(--vscode-panel-border, #3d3d3d) !important;
}

.empty-state {
  text-align: center; padding: 24px 12px;
  color: var(--vscode-descriptionForeground, #888);
}
.empty-icon { font-size: 32px; margin-bottom: 10px; opacity: 0.5; }
.empty-title { font-size: 13px; font-weight: 600; color: var(--vscode-foreground, #ccc); margin-bottom: 6px; }
.empty-desc  { font-size: 11px; line-height: 1.5; margin-bottom: 14px; }

#skeleton { animation: pulse 1.5s ease-in-out infinite; }
@keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.4} }
.skel-card {
  background: var(--vscode-input-background, #3c3c3c);
  border-radius: 8px; height: 58px;
}
</style>
</head>
<body>

<!-- Skeleton shown while waiting for first data -->
<div id="skeleton">
  <div class="section">
    <div class="section-title">Graph</div>
    <div class="stat-grid">
      <div class="skel-card"></div>
      <div class="skel-card"></div>
      <div class="skel-card"></div>
      <div class="skel-card"></div>
    </div>
  </div>
</div>

<div id="empty-state" style="display:none">
  <div class="empty-icon">⬡</div>
  <div class="empty-title">Graph not built yet</div>
  <div class="empty-desc">CodeLens indexes your codebase automatically on first open. Click below if it hasn't started.</div>
  <button class="btn btn-primary" onclick="send('buildGraph')">⟳ Build Graph Now</button>
</div>

<div id="main" style="display:none">

  <div class="section">
    <div class="section-title">Graph</div>
    <div class="stat-grid">
      <div class="stat-card">
        <div class="value" id="v-nodes">–</div>
        <div class="label">Symbols</div>
      </div>
      <div class="stat-card">
        <div class="value" id="v-edges">–</div>
        <div class="label">Relations</div>
      </div>
      <div class="stat-card">
        <div class="value" id="v-files">–</div>
        <div class="label">Files</div>
      </div>
      <div class="stat-card" id="card-issues">
        <div class="value" id="v-issues">–</div>
        <div class="label">Issues</div>
      </div>
    </div>
  </div>

  <div class="section">
    <div class="section-title">By Type</div>
    <div id="type-list"></div>
  </div>

  <div class="section">
    <div class="section-title">MCP Server</div>
    <div class="mcp-badge">
      <div class="dot green" id="mcp-dot"></div>
      <span id="mcp-label">9 tools available</span>
    </div>
    <div class="tool-list">
      codelens_triage · codelens_search · codelens_context<br>
      codelens_callers · codelens_impact · codelens_node<br>
      codelens_files · codelens_callees · codelens_status
    </div>
    <button class="btn btn-secondary" onclick="send('copyMcpConfig')">⎘ Copy MCP Config</button>
    <button class="btn btn-secondary" onclick="send('showMcpUsage')">📊 Show Usage Report</button>
  </div>

  <div class="section">
    <div class="section-title">Actions</div>
    <button class="btn btn-primary"    onclick="send('buildGraph')">⟳ Build / Rebuild Graph</button>
    <button class="btn btn-secondary"  onclick="send('showGraph')">⬡ Open Graph Explorer</button>
    <button class="btn btn-secondary"  onclick="send('searchSymbol')">⌕ Search Symbol</button>
    <button class="btn btn-secondary"  onclick="send('showContext')">⊙ Preview Agent Context</button>
  </div>

</div>

<script>
const vscode = acquireVsCodeApi();
function send(cmd) { vscode.postMessage({ command: cmd }); }

const TYPE_COLORS = {
  function:'#4ec9b0', method:'#569cd6', class:'#c586c0',
  interface:'#dcdcaa', variable:'#9cdcfe', property:'#ce9178',
  import:'#555', enum:'#f44747', type:'#d7ba7d', file:'#888',
};

let maxByType = 1;

window.addEventListener('message', ev => {
  const { command, stats, issues } = ev.data;
  if (command !== 'update') { return; }

  const empty = !stats || stats.totalNodes === 0;

  document.getElementById('skeleton').style.display    = 'none';
  document.getElementById('empty-state').style.display = empty ? 'block' : 'none';
  document.getElementById('main').style.display        = empty ? 'none'  : 'block';

  if (empty) { return; }

  document.getElementById('v-nodes').textContent  = fmt(stats.totalNodes);
  document.getElementById('v-edges').textContent  = fmt(stats.totalEdges);
  document.getElementById('v-files').textContent  = fmt(stats.fileCount);
  document.getElementById('v-issues').textContent = fmt(issues);

  const issueCard = document.getElementById('card-issues');
  issueCard.className = 'stat-card ' + (issues > 0 ? 'warn' : 'ok');

  const byType = stats.byType ?? {};
  const sorted = Object.entries(byType)
    .filter(([,v]) => Number(v) > 0)
    .sort(([,a],[,b]) => Number(b) - Number(a));

  maxByType = Math.max(1, ...sorted.map(([,v]) => Number(v)));

  document.getElementById('type-list').innerHTML = sorted.map(([type, count]) => {
    const pct = Math.round((Number(count) / maxByType) * 100);
    const col = TYPE_COLORS[type] || '#888';
    return '<div class="type-row">' +
      '<div class="type-dot" style="background:' + col + '"></div>' +
      '<span class="type-name">' + type + '</span>' +
      '<div class="type-bar-wrap"><div class="type-bar" style="width:' + pct + '%;background:' + col + '"></div></div>' +
      '<span class="type-count">' + fmt(Number(count)) + '</span>' +
    '</div>';
  }).join('');
});

function fmt(n) {
  if (n == null || n === undefined) { return '–'; }
  return n >= 1000 ? (n/1000).toFixed(1)+'k' : String(n);
}

// Signal to extension that JS is ready to receive data
vscode.postMessage({ command: 'ready' });
</script>
</body>
</html>`;
  }
}
