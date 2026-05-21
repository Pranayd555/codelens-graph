import { GraphNode, GraphEdge } from '../types';

export function toWebviewData(nodes: GraphNode[], edges: GraphEdge[]) {
  return {
    nodes: nodes.map(n => ({
      id:   n.id,
      name: n.name,
      type: n.type,
      file: n.filePath,
      line: n.line,
      undefinedRefs: n.undefinedRefs ?? [],
    })),
    edges: edges.map(e => ({
      source: e.fromId,
      target: e.toId,
      type:   e.type,
    })),
  };
}

export function getGraphPanelHtml(
  graphData: ReturnType<typeof toWebviewData>,
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
  body {
    background: var(--vscode-editor-background, #1e1e1e);
    color: var(--vscode-editor-foreground, #d4d4d4);
    font-family: var(--vscode-font-family, monospace);
    overflow: hidden;
  }
  #toolbar {
    display: flex; align-items: center; gap: 8px;
    padding: 8px 12px;
    background: var(--vscode-sideBar-background, #252526);
    border-bottom: 1px solid var(--vscode-panel-border, #333);
    flex-wrap: wrap;
  }
  #search {
    flex: 1; min-width: 120px;
    background: var(--vscode-input-background, #3c3c3c);
    border: 1px solid var(--vscode-input-border, #555);
    color: var(--vscode-input-foreground, #d4d4d4);
    padding: 4px 8px; border-radius: 4px; font-size: 12px;
  }
  .filter-btn {
    padding: 3px 8px; font-size: 11px; border-radius: 3px;
    border: 1px solid #555; cursor: pointer;
    background: #3c3c3c; color: #d4d4d4; white-space: nowrap;
  }
  .filter-btn.active { background: #0e639c; border-color: #0e639c; color: #fff; }
  #canvas { width: 100vw; height: calc(100vh - 48px); display: block; }
  .node circle { stroke-width: 1.5px; cursor: pointer; transition: r 0.15s; }
  .node circle:hover { stroke-width: 3px; }
  .node text { font-size: 10px; fill: #d4d4d4; pointer-events: none; user-select: none; }
  .link { stroke-opacity: 0.45; stroke-width: 1px; fill: none; }
  .link.calls      { stroke: #569cd6; }
  .link.imports    { stroke: #4ec9b0; }
  .link.contains   { stroke: #444; }
  .link.inherits   { stroke: #c586c0; }
  .link.implements { stroke: #dcdcaa; }
  .link.uses_type  { stroke: #9cdcfe; }
  #tooltip {
    position: fixed; pointer-events: none;
    background: #1e1e1e; border: 1px solid #555;
    border-radius: 6px; padding: 10px 14px; font-size: 12px;
    max-width: 320px; display: none; z-index: 100; line-height: 1.6;
    box-shadow: 0 4px 12px rgba(0,0,0,0.5);
  }
  #stats-bar { position: fixed; bottom: 8px; right: 12px; font-size: 11px; color: #666; }
  #legend {
    position: fixed; bottom: 8px; left: 12px;
    font-size: 10px; display: flex; gap: 10px; flex-wrap: wrap; color: #888;
  }
  .legend-item { display: flex; align-items: center; gap: 4px; }
  .legend-dot { width: 8px; height: 8px; border-radius: 50%; }

  /* Empty state */
  #empty-state {
    display: none; position: absolute;
    top: 50%; left: 50%; transform: translate(-50%, -50%);
    text-align: center; color: #666;
  }
  #empty-state .icon { font-size: 48px; margin-bottom: 12px; }
  #empty-state h2 { font-size: 16px; margin-bottom: 8px; color: #888; }
  #empty-state p  { font-size: 13px; line-height: 1.5; }
  #empty-state button {
    margin-top: 14px; padding: 7px 16px;
    background: #0e639c; color: #fff;
    border: none; border-radius: 4px; cursor: pointer; font-size: 13px;
  }

  /* Loading spinner */
  #loading {
    display: none; position: absolute;
    top: 50%; left: 50%; transform: translate(-50%, -50%);
    text-align: center; color: #666; font-size: 13px;
  }
  .spinner {
    width: 32px; height: 32px; margin: 0 auto 12px;
    border: 3px solid #333; border-top-color: #4ec9b0;
    border-radius: 50%; animation: spin 0.8s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }

  /* Undefined ref highlight */
  .node.has-issues circle { stroke: #f44747 !important; stroke-width: 2px !important; }
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
  <button class="filter-btn" data-type="issues">⚠ Issues</button>
</div>

<svg id="canvas"></svg>

<div id="empty-state">
  <div class="icon">⬡</div>
  <h2>Graph not built yet</h2>
  <p>Run <strong>CodeLens: Build Knowledge Graph</strong><br>to index your codebase.</p>
  <button onclick="vscode.postMessage({command:'buildGraph'})">Build Graph</button>
</div>

<div id="loading">
  <div class="spinner"></div>
  Rendering graph…
</div>

<div id="tooltip"></div>
<div id="stats-bar"></div>
<div id="legend">
  <div class="legend-item"><div class="legend-dot" style="background:#569cd6"></div>calls</div>
  <div class="legend-item"><div class="legend-dot" style="background:#4ec9b0"></div>imports</div>
  <div class="legend-item"><div class="legend-dot" style="background:#c586c0"></div>inherits</div>
  <div class="legend-item"><div class="legend-dot" style="background:#f44747"></div>⚠ has issues</div>
</div>

<script nonce="${nonce}" src="https://cdnjs.cloudflare.com/ajax/libs/d3/7.8.5/d3.min.js"></script>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();

// ── Initial data injected at HTML generation time ─────────────────────────────
let RAW = ${dataJson};

// ── Color + size config ───────────────────────────────────────────────────────
const TYPE_COLOR = {
  file: '#888', class: '#c586c0', interface: '#dcdcaa',
  function: '#4ec9b0', method: '#569cd6', variable: '#9cdcfe',
  property: '#ce9178', import: '#444', export: '#6a9955',
  enum: '#f44747', type: '#d7ba7d', decorator: '#b5cea8',
};
const TYPE_R = {
  file: 10, class: 14, interface: 12, function: 9,
  method: 8, variable: 6, property: 5, import: 3,
  enum: 11, type: 8,
};

// ── State ─────────────────────────────────────────────────────────────────────
let activeFilter = 'all';
let searchQuery  = '';
let simulation   = null;

// ── Bootstrap ─────────────────────────────────────────────────────────────────
function bootstrap() {
  if (!RAW.nodes || RAW.nodes.length === 0) {
    document.getElementById('empty-state').style.display = 'block';
    document.getElementById('loading').style.display     = 'none';
    return;
  }
  document.getElementById('empty-state').style.display = 'none';
  document.getElementById('loading').style.display     = 'block';
  // Defer render so loading spinner shows
  setTimeout(render, 60);
}

// ── Setup SVG ─────────────────────────────────────────────────────────────────
const svg = d3.select('#canvas');
const W   = () => window.innerWidth;
const H   = () => window.innerHeight - 48;
svg.attr('width', W()).attr('height', H());

const container = svg.append('g');
svg.call(
  d3.zoom().scaleExtent([0.05, 10]).on('zoom', e => {
    container.attr('transform', e.transform);
  })
);

// Arrow markers
const defs = svg.append('defs');
['calls','imports','inherits','implements','uses_type'].forEach(type => {
  const colors = { calls:'#569cd6', imports:'#4ec9b0', inherits:'#c586c0', implements:'#dcdcaa', uses_type:'#9cdcfe' };
  defs.append('marker')
    .attr('id', 'arr-' + type)
    .attr('viewBox','0 0 10 10').attr('refX',18).attr('refY',5)
    .attr('markerWidth',5).attr('markerHeight',5)
    .attr('orient','auto-start-reverse')
    .append('path').attr('d','M2 2L8 5L2 8')
    .attr('fill','none').attr('stroke', colors[type] || '#888')
    .attr('stroke-width',1.5).attr('stroke-linecap','round');
});

// ── Render ─────────────────────────────────────────────────────────────────────
function render() {
  document.getElementById('loading').style.display = 'none';
  container.selectAll('*').remove();

  // Apply filters
  const visNodes = RAW.nodes.filter(n => {
    if (activeFilter === 'issues') return n.undefinedRefs && n.undefinedRefs.length > 0;
    if (activeFilter !== 'all' && n.type !== activeFilter) return false;
    if (searchQuery && !n.name.toLowerCase().includes(searchQuery)) return false;
    return true;
  });

  const visIds   = new Set(visNodes.map(n => n.id));
  const visEdges = RAW.edges.filter(e => {
    const src = typeof e.source === 'object' ? e.source.id : e.source;
    const tgt = typeof e.target === 'object' ? e.target.id : e.target;
    return visIds.has(src) && visIds.has(tgt) && e.type !== 'contains';
  });

  if (visNodes.length === 0) {
    document.getElementById('stats-bar').textContent = 'No symbols match filter';
    return;
  }

  // Deep-clone so D3 mutations don't corrupt RAW
  const nodes = visNodes.map(d => ({ ...d }));
  const byId  = new Map(nodes.map(n => [n.id, n]));
  const edges = visEdges.map(e => ({
    ...e,
    source: byId.get(typeof e.source==='object'?e.source.id:e.source) || e.source,
    target: byId.get(typeof e.target==='object'?e.target.id:e.target) || e.target,
  }));

  // Force simulation
  if (simulation) { simulation.stop(); }
  simulation = d3.forceSimulation(nodes)
    .force('link', d3.forceLink(edges).id(d => d.id).distance(80).strength(0.4))
    .force('charge', d3.forceManyBody().strength(-100))
    .force('center', d3.forceCenter(W()/2, H()/2))
    .force('collision', d3.forceCollide().radius(d => (TYPE_R[d.type]||6) + 8));

  // Draw edges
  const link = container.append('g')
    .selectAll('line').data(edges).join('line')
    .attr('class', d => 'link ' + (d.type||''))
    .attr('marker-end', d => ['calls','imports','inherits','implements','uses_type'].includes(d.type)
      ? 'url(#arr-'+d.type+')' : null);

  // Draw nodes
  const node = container.append('g')
    .selectAll('g.node').data(nodes).join('g')
    .attr('class', d => 'node' + (d.undefinedRefs && d.undefinedRefs.length ? ' has-issues' : ''))
    .call(
      d3.drag()
        .on('start', (ev, d) => { if (!ev.active) simulation.alphaTarget(0.3).restart(); d.fx=d.x; d.fy=d.y; })
        .on('drag',  (ev, d) => { d.fx=ev.x; d.fy=ev.y; })
        .on('end',   (ev, d) => { if (!ev.active) simulation.alphaTarget(0); d.fx=null; d.fy=null; })
    )
    .on('mouseover', showTooltip)
    .on('mousemove', moveTooltip)
    .on('mouseout',  hideTooltip)
    .on('click', (ev, d) => {
      ev.stopPropagation();
      vscode.postMessage({ command: 'openFile', filePath: d.file, line: d.line });
    });

  node.append('circle')
    .attr('r',    d => TYPE_R[d.type] || 6)
    .attr('fill', d => TYPE_COLOR[d.type] || '#888')
    .attr('stroke', d => d3.color(TYPE_COLOR[d.type]||'#888').darker(0.8));

  node.append('text')
    .attr('dy', d => -(TYPE_R[d.type]||6) - 3)
    .attr('text-anchor', 'middle')
    .text(d => d.name.length > 18 ? d.name.slice(0,16)+'…' : d.name);

  simulation.on('tick', () => {
    link
      .attr('x1', d => d.source.x).attr('y1', d => d.source.y)
      .attr('x2', d => d.target.x).attr('y2', d => d.target.y);
    node.attr('transform', d => \`translate(\${d.x},\${d.y})\`);
  });

  document.getElementById('stats-bar').textContent =
    \`Showing \${nodes.length} of \${RAW.nodes.length} symbols · \${edges.length} edges\`;
}

// ── Tooltip ────────────────────────────────────────────────────────────────────
const tip = document.getElementById('tooltip');
function showTooltip(ev, d) {
  const warn = d.undefinedRefs && d.undefinedRefs.length
    ? \`<br><span style="color:#f44747;font-size:10px">⚠ undef: \${d.undefinedRefs.join(', ')}</span>\`
    : '';
  tip.style.display = 'block';
  tip.innerHTML =
    \`<strong>\${d.name}</strong> <span style="color:#888">\${d.type}</span>\${warn}<br>\` +
    \`<span style="color:#666;font-size:11px">\${(d.file||'').split(/[\\/\\\\]/).pop()}: \${d.line||''}</span>\`;
  moveTooltip(ev);
}
function moveTooltip(ev) {
  tip.style.left = (ev.clientX + 14) + 'px';
  tip.style.top  = (ev.clientY + 14) + 'px';
}
function hideTooltip() { tip.style.display = 'none'; }

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
  searchQuery = ev.target.value.toLowerCase().trim();
  render();
});

window.addEventListener('resize', () => {
  svg.attr('width', W()).attr('height', H());
  if (simulation) simulation.force('center', d3.forceCenter(W()/2, H()/2)).alpha(0.1).restart();
});

// ── Messages from extension ────────────────────────────────────────────────────
window.addEventListener('message', ev => {
  if (ev.data.command === 'updateGraph') {
    RAW = { nodes: ev.data.nodes, edges: ev.data.edges };
    bootstrap();
  }
});

// ── Initial render ─────────────────────────────────────────────────────────────
bootstrap();
</script>
</body>
</html>`;
}
