// This file is the HTML/JS content of the VS Code webview panel.
// It renders the graph using D3 force simulation.
// Kept as a string template so it compiles without a DOM environment.

export function getGraphPanelHtml(
  graphData: { nodes: Array<{ id: string; name: string; type: string; file: string; line: number }>; edges: Array<{ source: string; target: string; type: string }> },
  nonce: string
): string {
  const dataJson = JSON.stringify(graphData);

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy"
  content="default-src 'none'; script-src 'nonce-${nonce}' https://cdnjs.cloudflare.com; style-src 'unsafe-inline';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>CodeLens Graph</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: var(--vscode-editor-background, #1e1e1e); color: var(--vscode-editor-foreground, #d4d4d4); font-family: var(--vscode-font-family, monospace); overflow: hidden; }
  #toolbar { display: flex; align-items: center; gap: 8px; padding: 8px 12px; background: var(--vscode-sideBar-background, #252526); border-bottom: 1px solid var(--vscode-panel-border, #333); }
  #search { flex: 1; background: var(--vscode-input-background, #3c3c3c); border: 1px solid var(--vscode-input-border, #555); color: var(--vscode-input-foreground, #d4d4d4); padding: 4px 8px; border-radius: 4px; font-size: 12px; }
  .filter-btn { padding: 3px 8px; font-size: 11px; border-radius: 3px; border: 1px solid #555; cursor: pointer; background: #3c3c3c; color: #d4d4d4; }
  .filter-btn.active { background: #0e639c; border-color: #0e639c; color: #fff; }
  #canvas { width: 100vw; height: calc(100vh - 42px); }
  .node circle { stroke-width: 1.5px; cursor: pointer; transition: r 0.15s; }
  .node circle:hover { stroke-width: 3px; }
  .node text { font-size: 10px; fill: #d4d4d4; pointer-events: none; }
  .link { stroke-opacity: 0.5; stroke-width: 1px; }
  .link.calls      { stroke: #569cd6; }
  .link.imports    { stroke: #4ec9b0; }
  .link.contains   { stroke: #555; }
  .link.inherits   { stroke: #c586c0; }
  .link.implements { stroke: #dcdcaa; }
  .link.uses_type  { stroke: #9cdcfe; }
  #tooltip { position: fixed; pointer-events: none; background: #252526; border: 1px solid #444; border-radius: 6px; padding: 10px 14px; font-size: 12px; max-width: 320px; display: none; z-index: 100; line-height: 1.6; }
  #stats-bar { position: fixed; bottom: 8px; right: 12px; font-size: 11px; color: #888; }
  #legend { position: fixed; bottom: 8px; left: 12px; font-size: 11px; display: flex; gap: 12px; flex-wrap: wrap; }
  .legend-item { display: flex; align-items: center; gap: 4px; }
  .legend-dot { width: 10px; height: 10px; border-radius: 50%; }
</style>
</head>
<body>
<div id="toolbar">
  <input id="search" type="text" placeholder="Search symbols…" />
  <button class="filter-btn active" data-type="all">All</button>
  <button class="filter-btn" data-type="function">Functions</button>
  <button class="filter-btn" data-type="class">Classes</button>
  <button class="filter-btn" data-type="method">Methods</button>
  <button class="filter-btn" data-type="variable">Variables</button>
  <button class="filter-btn" data-type="interface">Interfaces</button>
</div>
<svg id="canvas"></svg>
<div id="tooltip"></div>
<div id="stats-bar"></div>
<div id="legend">
  <div class="legend-item"><div class="legend-dot" style="background:#569cd6"></div>calls</div>
  <div class="legend-item"><div class="legend-dot" style="background:#4ec9b0"></div>imports</div>
  <div class="legend-item"><div class="legend-dot" style="background:#c586c0"></div>inherits</div>
  <div class="legend-item"><div class="legend-dot" style="background:#dcdcaa"></div>implements</div>
</div>

<script nonce="${nonce}" src="https://cdnjs.cloudflare.com/ajax/libs/d3/7.8.5/d3.min.js"></script>
<script nonce="${nonce}">
const RAW = ${dataJson};

// ── Color per node type ────────────────────────────────────────────────────────
const TYPE_COLOR = {
  file:       '#888888',
  class:      '#c586c0',
  interface:  '#dcdcaa',
  function:   '#4ec9b0',
  method:     '#569cd6',
  variable:   '#9cdcfe',
  property:   '#ce9178',
  import:     '#555555',
  export:     '#6a9955',
  enum:       '#f44747',
  type:       '#d7ba7d',
  decorator:  '#b5cea8',
};

const TYPE_RADIUS = {
  file:      10,
  class:     14,
  interface: 12,
  function:  9,
  method:    8,
  variable:  6,
  property:  5,
  import:    4,
  enum:      11,
  type:      8,
  default:   6,
};

// ── State ─────────────────────────────────────────────────────────────────────
let activeFilter = 'all';
let searchQuery  = '';
let simulation;
let allNodes = [...RAW.nodes];
let allEdges = [...RAW.edges];

// ── Setup SVG ─────────────────────────────────────────────────────────────────
const svg    = d3.select('#canvas');
const width  = () => window.innerWidth;
const height = () => window.innerHeight - 42;

svg.attr('width', width()).attr('height', height());

const container = svg.append('g');

// Zoom + pan
svg.call(d3.zoom().scaleExtent([0.1, 8]).on('zoom', e => {
  container.attr('transform', e.transform);
}));

// Arrow markers for directed edges
const defs = svg.append('defs');
['calls','imports','inherits','implements','uses_type'].forEach(type => {
  defs.append('marker')
    .attr('id', 'arrow-' + type)
    .attr('viewBox', '0 0 10 10').attr('refX', 18).attr('refY', 5)
    .attr('markerWidth', 6).attr('markerHeight', 6)
    .attr('orient', 'auto-start-reverse')
    .append('path').attr('d', 'M2 1L8 5L2 9').attr('fill', 'none')
    .attr('stroke', type === 'calls' ? '#569cd6' : type === 'imports' ? '#4ec9b0' : type === 'inherits' ? '#c586c0' : '#dcdcaa')
    .attr('stroke-width', 1.5);
});

// ── Render function ────────────────────────────────────────────────────────────
function render() {
  container.selectAll('*').remove();

  const visibleNodes = allNodes.filter(n => {
    if (activeFilter !== 'all' && n.type !== activeFilter) return false;
    if (searchQuery && !n.name.toLowerCase().includes(searchQuery)) return false;
    return true;
  });
  const visibleIds = new Set(visibleNodes.map(n => n.id));
  const visibleEdges = allEdges.filter(e =>
    visibleIds.has(typeof e.source === 'object' ? e.source.id : e.source) &&
    visibleIds.has(typeof e.target === 'object' ? e.target.id : e.target)
  );

  // Clone so D3 mutation doesn't affect original
  const nodes = visibleNodes.map(d => ({...d, x: width()/2 + (Math.random()-0.5)*200, y: height()/2 + (Math.random()-0.5)*200}));
  const nodeById = new Map(nodes.map(n => [n.id, n]));
  const edges = visibleEdges.map(e => ({
    ...e,
    source: nodeById.get(typeof e.source === 'object' ? e.source.id : e.source) || e.source,
    target: nodeById.get(typeof e.target === 'object' ? e.target.id : e.target) || e.target,
  }));

  // Force simulation
  if (simulation) simulation.stop();
  simulation = d3.forceSimulation(nodes)
    .force('link', d3.forceLink(edges).id(d => d.id).distance(80).strength(0.5))
    .force('charge', d3.forceManyBody().strength(-120))
    .force('center', d3.forceCenter(width()/2, height()/2))
    .force('collision', d3.forceCollide().radius(d => (TYPE_RADIUS[d.type] || 6) + 6));

  // Edges
  const link = container.append('g').selectAll('line')
    .data(edges).join('line')
    .attr('class', d => 'link ' + (d.type || ''))
    .attr('marker-end', d => ['calls','imports','inherits','implements','uses_type'].includes(d.type) ? 'url(#arrow-'+d.type+')' : null);

  // Nodes
  const node = container.append('g').selectAll('g.node')
    .data(nodes).join('g').attr('class', 'node')
    .call(d3.drag()
      .on('start', (ev, d) => { if (!ev.active) simulation.alphaTarget(0.3).restart(); d.fx = d.x; d.fy = d.y; })
      .on('drag',  (ev, d) => { d.fx = ev.x; d.fy = ev.y; })
      .on('end',   (ev, d) => { if (!ev.active) simulation.alphaTarget(0); d.fx = null; d.fy = null; })
    )
    .on('mouseover', showTooltip)
    .on('mouseout',  hideTooltip)
    .on('click', (ev, d) => {
      // Post message to VS Code extension to open the file
      vscode.postMessage({ command: 'openFile', filePath: d.file, line: d.line });
    });

  node.append('circle')
    .attr('r', d => TYPE_RADIUS[d.type] || 6)
    .attr('fill', d => TYPE_COLOR[d.type] || '#888')
    .attr('stroke', d => d3.color(TYPE_COLOR[d.type] || '#888').darker(1));

  node.append('text')
    .attr('dy', d => -(TYPE_RADIUS[d.type] || 6) - 3)
    .attr('text-anchor', 'middle')
    .text(d => d.name.length > 20 ? d.name.slice(0, 18) + '…' : d.name);

  simulation.on('tick', () => {
    link.attr('x1', d => d.source.x).attr('y1', d => d.source.y)
        .attr('x2', d => d.target.x).attr('y2', d => d.target.y);
    node.attr('transform', d => \`translate(\${d.x},\${d.y})\`);
  });

  d3.select('#stats-bar').text(
    \`\${nodes.length} nodes · \${edges.length} edges · \${allNodes.length} total\`
  );
}

// ── Tooltip ────────────────────────────────────────────────────────────────────
const tooltip = document.getElementById('tooltip');
function showTooltip(ev, d) {
  tooltip.style.display = 'block';
  tooltip.style.left = (ev.clientX + 12) + 'px';
  tooltip.style.top  = (ev.clientY + 12) + 'px';
  tooltip.innerHTML =
    \`<b>\${d.name}</b> <span style="color:#888">\${d.type}</span><br>\` +
    \`<span style="color:#888;font-size:11px">\${d.file?.split('/').pop() ?? ''} : \${d.line ?? ''}</span>\`;
}
function hideTooltip() { tooltip.style.display = 'none'; }

// ── Controls ───────────────────────────────────────────────────────────────────
document.querySelectorAll('.filter-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    activeFilter = btn.dataset.type;
    render();
  });
});

document.getElementById('search').addEventListener('input', ev => {
  searchQuery = ev.target.value.toLowerCase();
  render();
});

window.addEventListener('resize', () => {
  svg.attr('width', width()).attr('height', height());
  if (simulation) simulation.force('center', d3.forceCenter(width()/2, height()/2)).alpha(0.1).restart();
});

// VS Code API for sending messages back to extension
const vscode = typeof acquireVsCodeApi !== 'undefined' ? acquireVsCodeApi() : { postMessage: () => {} };

// Receive messages from extension (e.g. graph update)
window.addEventListener('message', ev => {
  if (ev.data.command === 'updateGraph') {
    allNodes = ev.data.nodes;
    allEdges = ev.data.edges;
    render();
  }
});

// Initial render
render();
</script>
</body>
</html>`;
}

// ─── Convert DB nodes/edges to webview-friendly format ────────────────────────

import { GraphNode, GraphEdge } from './types';

export function toWebviewData(nodes: GraphNode[], edges: GraphEdge[]) {
  return {
    nodes: nodes.map(n => ({
      id:   n.id,
      name: n.name,
      type: n.type,
      file: n.filePath,
      line: n.line,
    })),
    edges: edges.map(e => ({
      source: e.fromId,
      target: e.toId,
      type:   e.type,
    })),
  };
}
