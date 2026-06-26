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
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>CodeLens Graph</title>
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
body {
  background: #0d1117;
  color: #e6edf3;
  font-family: var(--vscode-font-family, 'Segoe UI', system-ui, sans-serif);
  overflow: hidden;
  user-select: none;
}

/* ── Toolbar ──────────────────────────────────────────────────────────────── */
#toolbar {
  position: fixed; top: 0; left: 0; right: 0; z-index: 50;
  display: flex; align-items: center; gap: 6px;
  padding: 8px 12px;
  background: rgba(13,17,23,0.95);
  border-bottom: 1px solid #30363d;
  backdrop-filter: blur(8px);
  flex-wrap: wrap;
}
#search {
  flex: 1; min-width: 140px; max-width: 260px;
  background: #161b22; border: 1px solid #30363d;
  color: #e6edf3; padding: 5px 10px; border-radius: 6px; font-size: 12px;
  outline: none;
}
#search:focus { border-color: #4ec9b0; box-shadow: 0 0 0 2px rgba(78,201,176,0.15); }
.filter-btn {
  padding: 4px 11px; font-size: 11px; font-weight: 500;
  border-radius: 6px; border: 1px solid #30363d;
  cursor: pointer; background: #161b22; color: #8b949e;
  transition: all 0.15s; white-space: nowrap;
}
.filter-btn:hover { border-color: #58a6ff; color: #e6edf3; }
.filter-btn.active { background: #1f6feb; border-color: #1f6feb; color: #fff; }
.filter-btn.issues.active { background: #da3633; border-color: #da3633; }

/* ── Canvas ───────────────────────────────────────────────────────────────── */
#canvas {
  position: fixed; top: 42px; left: 0; right: 0; bottom: 28px;
  width: 100%; height: calc(100vh - 70px);
}

/* ── Node styles ──────────────────────────────────────────────────────────── */
.node-group { cursor: pointer; }
.node-group .bg-circle {
  fill: transparent;
  stroke: transparent;
  transition: all 0.2s;
}
.node-group:hover .bg-circle {
  fill: rgba(255,255,255,0.04);
  stroke: rgba(255,255,255,0.1);
}
.node-group .symbol-circle {
  transition: r 0.15s, filter 0.15s;
}
.node-group:hover .symbol-circle {
  filter: brightness(1.4) drop-shadow(0 0 6px currentColor);
}
.node-group .node-label {
  font-size: 9.5px; fill: #8b949e;
  pointer-events: none;
  transition: fill 0.15s;
}
.node-group:hover .node-label { fill: #e6edf3; }
.node-group.has-issues .symbol-circle {
  stroke: #f85149 !important;
  stroke-width: 2px !important;
  filter: drop-shadow(0 0 4px #f85149);
}

/* Class container hull */
.class-hull {
  fill: rgba(197,134,192,0.06);
  stroke: rgba(197,134,192,0.25);
  stroke-width: 1px;
  stroke-dasharray: 4 3;
  rx: 10; ry: 10;
}
.class-hull:hover {
  fill: rgba(197,134,192,0.1);
  stroke: rgba(197,134,192,0.5);
}
.class-label {
  font-size: 11px; font-weight: 600;
  fill: rgba(197,134,192,0.7);
  pointer-events: none;
}

/* File container hull */
.file-hull {
  fill: rgba(136,136,136,0.04);
  stroke: rgba(136,136,136,0.15);
  stroke-width: 1px;
  stroke-dasharray: 2 4;
  rx: 8; ry: 8;
}
.file-label {
  font-size: 9px; fill: rgba(136,136,136,0.5);
  pointer-events: none;
}

/* ── Edge styles ──────────────────────────────────────────────────────────── */
.edge { fill: none; transition: stroke-opacity 0.15s; }
.edge.calls      { stroke: #58a6ff; stroke-opacity: 0.6; stroke-width: 1.5px; }
.edge.imports    { stroke: #4ec9b0; stroke-opacity: 0.5; stroke-width: 1px; }
.edge.inherits   { stroke: #bc8cff; stroke-opacity: 0.7; stroke-width: 1.5px; stroke-dasharray: 5 3; }
.edge.implements { stroke: #d2a679; stroke-opacity: 0.6; stroke-width: 1px; stroke-dasharray: 3 3; }
.edge.uses_type  { stroke: #9cdcfe; stroke-opacity: 0.4; stroke-width: 1px; }
.edge.contains   { stroke: rgba(255,255,255,0.08); stroke-width: 0.8px; stroke-dasharray: 2 3; }
.edge:hover      { stroke-opacity: 1 !important; }

/* ── Tooltip ─────────────────────────────────────────────────────────────── */
#tooltip {
  position: fixed; pointer-events: none;
  background: #161b22; border: 1px solid #30363d;
  border-radius: 8px; padding: 10px 14px;
  font-size: 12px; max-width: 300px; line-height: 1.6;
  box-shadow: 0 8px 24px rgba(0,0,0,0.4);
  display: none; z-index: 200;
}
#tooltip .tip-name  { font-weight: 600; color: #e6edf3; font-size: 13px; }
#tooltip .tip-type  { color: #8b949e; font-size: 11px; margin-left: 4px; }
#tooltip .tip-file  { color: #58a6ff; font-size: 11px; margin-top: 2px; }
#tooltip .tip-sig   { color: #8b949e; font-size: 10px; margin-top: 3px; font-family: monospace; }
#tooltip .tip-warn  { color: #f85149; font-size: 10px; margin-top: 3px; }

/* ── Legend / status ─────────────────────────────────────────────────────── */
#bottom-bar {
  position: fixed; bottom: 0; left: 0; right: 0;
  display: flex; align-items: center; justify-content: space-between;
  padding: 4px 12px;
  background: rgba(13,17,23,0.95); border-top: 1px solid #21262d;
  font-size: 10px; color: #8b949e;
}
#legend { display: flex; gap: 14px; flex-wrap: wrap; }
.leg { display: flex; align-items: center; gap: 4px; }
.leg-dot { width: 8px; height: 8px; border-radius: 50%; }
.leg-line { width: 16px; height: 2px; }

/* ── Empty / loading ─────────────────────────────────────────────────────── */
#empty-state {
  display: none; position: fixed;
  top: 50%; left: 50%; transform: translate(-50%, -50%);
  text-align: center; color: #8b949e;
}
#empty-state .icon { font-size: 48px; margin-bottom: 12px; opacity: 0.4; }
#empty-state h2 { font-size: 18px; margin-bottom: 8px; color: #e6edf3; }
#empty-state p { font-size: 13px; line-height: 1.6; }
#empty-state button {
  margin-top: 16px; padding: 8px 18px;
  background: #1f6feb; color: #fff;
  border: none; border-radius: 6px; cursor: pointer;
  font-size: 13px; font-weight: 500;
}
#empty-state button:hover { background: #388bfd; }
#loading {
  display: none; position: fixed;
  top: 50%; left: 50%; transform: translate(-50%, -50%);
  text-align: center; color: #8b949e; font-size: 13px;
}
.spinner {
  width: 32px; height: 32px; margin: 0 auto 12px;
  border: 3px solid #21262d; border-top-color: #4ec9b0;
  border-radius: 50%; animation: spin 0.7s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }


</style>
</head>
<body>

<div id="toolbar">
  <input id="search" type="text" placeholder="Search symbols…" autocomplete="off" />
  <button class="filter-btn active" data-type="all">All</button>
  <button class="filter-btn" data-type="function">Functions</button>
  <button class="filter-btn" data-type="class">Classes</button>
  <button class="filter-btn" data-type="method">Methods</button>
  <button class="filter-btn" data-type="variable">Variables</button>
  <button class="filter-btn" data-type="interface">Interfaces</button>
  <button class="filter-btn issues" data-type="issues">⚠ Issues</button>
</div>

<svg id="canvas"></svg>



<div id="empty-state">
  <div class="icon">⬡</div>
  <h2>Graph not built yet</h2>
  <p>CodeLens indexes your codebase automatically.<br>Click below if it hasn't started yet.</p>
  <button onclick="send('buildGraph')">Build Graph Now</button>
</div>

<div id="loading">
  <div class="spinner"></div>
  <div id="loading-text">Laying out graph…</div>
</div>

<div id="tooltip">
  <span class="tip-name" id="tt-name"></span><span class="tip-type" id="tt-type"></span>
  <div class="tip-file" id="tt-file"></div>
  <div class="tip-sig"  id="tt-sig"></div>
  <div class="tip-warn" id="tt-warn"></div>
</div>

<div id="bottom-bar">
  <div id="legend">
    <div class="leg"><div class="leg-dot" style="background:#4ec9b0"></div>function/method</div>
    <div class="leg"><div class="leg-dot" style="background:#c586c0"></div>class</div>
    <div class="leg"><div class="leg-dot" style="background:#9cdcfe"></div>variable</div>
    <div class="leg"><div class="leg-dot" style="background:#dcdcaa"></div>interface</div>
    <div class="leg"><div class="leg-line" style="background:#58a6ff"></div>calls</div>
    <div class="leg"><div class="leg-line" style="background:#4ec9b0"></div>imports</div>
    <div class="leg"><div class="leg-line" style="background:#bc8cff;height:1px;border-top:2px dashed #bc8cff"></div>inherits</div>
    <div class="leg"><div class="leg-dot" style="background:#f85149"></div>⚠ issues</div>
  </div>
  <div id="stats-bar">–</div>
</div>

<script nonce="${nonce}" src="https://cdnjs.cloudflare.com/ajax/libs/d3/7.8.5/d3.min.js"></script>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
function send(cmd, payload) { vscode.postMessage({ command: cmd, ...payload }); }

// ── Data ──────────────────────────────────────────────────────────────────────
let RAW = ${dataJson};

// ── Config ─────────────────────────────────────────────────────────────────────
const C = {
  file:       { color: '#6e7681',  r: 8  },
  class:      { color: '#c586c0',  r: 14 },
  interface:  { color: '#dcdcaa',  r: 11 },
  function:   { color: '#4ec9b0',  r: 8  },
  method:     { color: '#569cd6',  r: 7  },
  variable:   { color: '#9cdcfe',  r: 5  },
  property:   { color: '#ce9178',  r: 5  },
  import:     { color: '#3d4450',  r: 3  },
  enum:       { color: '#f44747',  r: 10 },
  type:       { color: '#d7ba7d',  r: 7  },
  decorator:  { color: '#b5cea8',  r: 5  },
};
const getR     = d => (C[d.type] || C.function).r;
const getColor = d => (C[d.type] || C.function).color;

// ── State ─────────────────────────────────────────────────────────────────────
let activeFilter = 'all';
let searchQuery  = '';
let simulation   = null;
let selectedNode = null;

// ── SVG setup ─────────────────────────────────────────────────────────────────
const svg  = d3.select('#canvas');
const W    = () => window.innerWidth;
const H    = () => window.innerHeight - 70;
svg.attr('width', W()).attr('height', H());

const root      = svg.append('g').attr('class', 'root');
const hullLayer = root.append('g').attr('class', 'hulls');
const edgeLayer = root.append('g').attr('class', 'edges');
const nodeLayer = root.append('g').attr('class', 'nodes');

svg.call(d3.zoom().scaleExtent([0.02, 12]).on('zoom', e => {
  root.attr('transform', e.transform);
}));

// Arrow markers for directed edges
const defs = svg.append('defs');
['calls','imports','inherits','implements'].forEach(type => {
  const colors = { calls:'#58a6ff', imports:'#4ec9b0', inherits:'#bc8cff', implements:'#d2a679' };
  defs.append('marker')
    .attr('id', 'arr-'+type)
    .attr('viewBox','0 0 8 8').attr('refX',16).attr('refY',4)
    .attr('markerWidth',5).attr('markerHeight',5).attr('orient','auto')
    .append('path').attr('d','M1 1L7 4L1 7')
    .attr('fill','none').attr('stroke', colors[type] || '#888')
    .attr('stroke-width',1.5).attr('stroke-linecap','round').attr('stroke-linejoin','round');
});

// ── Bootstrap ─────────────────────────────────────────────────────────────────
let hasRenderedOnce = false;

function bootstrap() {
  const hasNodes = RAW.nodes && RAW.nodes.length > 0;
  document.getElementById('empty-state').style.display = hasNodes ? 'none' : 'block';
  if (!hasNodes) { document.getElementById('loading').style.display = 'none'; return; }

  if (hasRenderedOnce) {
    // Already rendered once — skip spinner, re-render immediately (re-focus case)
    render();
    return;
  }

  document.getElementById('loading').style.display = 'block';
  document.getElementById('loading-text').textContent = \`Laying out \${RAW.nodes.length} symbols…\`;
  requestAnimationFrame(() => setTimeout(() => { hasRenderedOnce = true; render(); }, 80));
}

// ── Render ────────────────────────────────────────────────────────────────────
function render() {
  document.getElementById('loading').style.display = 'none';
  hullLayer.selectAll('*').remove();
  edgeLayer.selectAll('*').remove();
  nodeLayer.selectAll('*').remove();

  // ── Filter nodes ────────────────────────────────────────────────────────────
  let visNodes = RAW.nodes.filter(n => {
    if (n.type === 'import') { return false; }  // hide noisy import nodes
    if (activeFilter === 'issues') { return n.undefinedRefs && n.undefinedRefs.length > 0; }
    if (activeFilter !== 'all' && n.type !== activeFilter) { return false; }
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      if (!n.name.toLowerCase().includes(q)) { return false; }
    }
    return true;
  });

  const visIds = new Set(visNodes.map(n => n.id));

  // ── Filter edges ─────────────────────────────────────────────────────────────
  // Show structural edges (contains) as light connectors AND meaningful edges (calls etc)
  const SHOW_EDGE_TYPES = new Set(['calls','imports','inherits','implements','uses_type','contains']);
  const visEdges = RAW.edges.filter(e => {
    if (!SHOW_EDGE_TYPES.has(e.type)) { return false; }
    const src = typeof e.source === 'object' ? e.source.id : e.source;
    const tgt = typeof e.target === 'object' ? e.target.id : e.target;
    return visIds.has(src) && visIds.has(tgt);
  });

  if (visNodes.length === 0) {
    document.getElementById('stats-bar').textContent = 'No symbols match filter';
    return;
  }

  // Deep-clone nodes so D3 can mutate x/y
  const nodes  = visNodes.map(d => ({ ...d, x: undefined, y: undefined }));
  const byId   = new Map(nodes.map(n => [n.id, n]));

  const edges = visEdges.map(e => ({
    ...e,
    source: byId.get(typeof e.source==='object' ? e.source.id : e.source) ?? (typeof e.source==='object'?e.source.id:e.source),
    target: byId.get(typeof e.target==='object' ? e.target.id : e.target) ?? (typeof e.target==='object'?e.target.id:e.target),
  })).filter(e => typeof e.source === 'object' && typeof e.target === 'object');

  // ── Build class→children map for hull drawing ────────────────────────────
  const classChildren = new Map(); // classId → [childNodes]
  edges.filter(e => e.type === 'contains').forEach(e => {
    const parent = e.source;
    const child  = e.target;
    if (!parent || !child) { return; }
    if (parent.type === 'class' || parent.type === 'interface') {
      if (!classChildren.has(parent.id)) { classChildren.set(parent.id, []); }
      classChildren.get(parent.id).push(child);
    }
  });

  // ── Force simulation ──────────────────────────────────────────────────────
  if (simulation) { simulation.stop(); }

  // Separate forces: group class members tightly, push files apart
  simulation = d3.forceSimulation(nodes)
    .force('link', d3.forceLink(edges).id(d => d.id)
      .distance(e => {
        if (e.type === 'contains')   { return 40; }  // keep members close to class
        if (e.type === 'calls')      { return 100; }
        if (e.type === 'imports')    { return 120; }
        if (e.type === 'inherits')   { return 80; }
        return 90;
      })
      .strength(e => {
        if (e.type === 'contains')  { return 0.8; }  // strong pull between class and members
        if (e.type === 'inherits')  { return 0.6; }
        if (e.type === 'calls')     { return 0.3; }
        return 0.2;
      })
    )
    .force('charge', d3.forceManyBody()
      .strength(d => d.type === 'class' ? -300 : d.type === 'file' ? -200 : -80)
    )
    .force('center', d3.forceCenter(W()/2, H()/2))
    .force('collision', d3.forceCollide().radius(d => getR(d) + (d.type === 'class' ? 30 : 12)))
    .alphaDecay(0.02)    // slower cooling = better layout
    .velocityDecay(0.4);

  // ── Draw edges ────────────────────────────────────────────────────────────
  const link = edgeLayer.selectAll('path.edge')
    .data(edges).join('path')
    .attr('class', d => 'edge ' + (d.type||''))
    .attr('marker-end', d => ['calls','inherits','implements'].includes(d.type)
      ? \`url(#arr-\${d.type})\` : null);

  // ── Draw nodes ────────────────────────────────────────────────────────────
  const nodeGroups = nodeLayer.selectAll('g.node-group')
    .data(nodes, d => d.id)
    .join('g')
    .attr('class', d => 'node-group' + (d.undefinedRefs?.length ? ' has-issues' : ''))
    .call(d3.drag()
      .on('start', (ev, d) => { if (!ev.active) simulation.alphaTarget(0.3).restart(); d.fx=d.x; d.fy=d.y; })
      .on('drag',  (ev, d) => { d.fx=ev.x; d.fy=ev.y; })
      .on('end',   (ev, d) => { if (!ev.active) simulation.alphaTarget(0); d.fx=null; d.fy=null; })
    )
    .on('mouseover', (ev, d) => showTooltip(ev, d))
    .on('mousemove', moveTooltip)
    .on('mouseout',  hideTooltip)
    .on('click', (ev, d) => {
      ev.stopPropagation();
      send('openFile', { filePath: d.file, line: d.line });
    });

  // Hover background
  nodeGroups.append('circle')
    .attr('class', 'bg-circle')
    .attr('r', d => getR(d) + 10);

  // Main symbol circle
  nodeGroups.append('circle')
    .attr('class', 'symbol-circle')
    .attr('r', d => getR(d))
    .attr('fill', d => getColor(d))
    .attr('stroke', d => d3.color(getColor(d))?.darker(0.6).toString() || '#000')
    .attr('stroke-width', 1.5);

  // Label below
  nodeGroups.append('text')
    .attr('class', 'node-label')
    .attr('dy', d => getR(d) + 11)
    .attr('text-anchor', 'middle')
    .text(d => d.name.length > 16 ? d.name.slice(0, 14) + '…' : d.name);

  // ── Tick ──────────────────────────────────────────────────────────────────
  simulation.on('tick', () => {
    // Edges as curved paths for calls/inherits, straight for structural
    link.attr('d', d => {
      if (!d.source.x || !d.target.x) { return ''; }
      if (d.type === 'contains') {
        return \`M\${d.source.x},\${d.source.y}L\${d.target.x},\${d.target.y}\`;
      }
      // Curved path with offset so parallel edges don't overlap
      const dx = d.target.x - d.source.x;
      const dy = d.target.y - d.source.y;
      const dr = Math.sqrt(dx*dx + dy*dy) * 1.4;
      return \`M\${d.source.x},\${d.source.y}A\${dr},\${dr} 0 0,1 \${d.target.x},\${d.target.y}\`;
    });

    nodeGroups.attr('transform', d => \`translate(\${d.x ?? 0},\${d.y ?? 0})\`);

    // Draw class hulls after layout settles a bit
    drawHulls(nodes, classChildren);
  });

  document.getElementById('stats-bar').textContent =
    \`Showing \${nodes.length} of \${RAW.nodes.length} symbols · \${edges.length} edges\`;
}

// ── Class hull drawing ─────────────────────────────────────────────────────────
// Draws a rounded rect around each class and its members once they settle.
let hullTimer = null;
function drawHulls(nodes, classChildren) {
  if (hullTimer) { return; }
  hullTimer = setTimeout(() => {
    hullTimer = null;
    hullLayer.selectAll('*').remove();

    classChildren.forEach((children, classId) => {
      const classNode = nodes.find(n => n.id === classId);
      if (!classNode || !classNode.x) { return; }

      const allNodes = [classNode, ...children.filter(c => c.x != null)];
      if (allNodes.length < 2) { return; }

      const xs  = allNodes.map(n => n.x);
      const ys  = allNodes.map(n => n.y);
      const pad = 24;
      const x0  = Math.min(...xs) - pad;
      const y0  = Math.min(...ys) - pad;
      const x1  = Math.max(...xs) + pad;
      const y1  = Math.max(...ys) + pad;
      const w   = x1 - x0;
      const h   = y1 - y0;

      const g = hullLayer.append('g');
      g.append('rect')
        .attr('class', 'class-hull')
        .attr('x', x0).attr('y', y0)
        .attr('width', w).attr('height', h)
        .attr('rx', 12).attr('ry', 12);

      g.append('text')
        .attr('class', 'class-label')
        .attr('x', x0 + 8).attr('y', y0 + 14)
        .text(classNode.name);
    });
  }, 800); // draw hull after 800ms of simulation
}

// ── Tooltip ────────────────────────────────────────────────────────────────────
const tip = document.getElementById('tooltip');
function showTooltip(ev, d) {
  document.getElementById('tt-name').textContent = d.name;
  document.getElementById('tt-type').textContent = d.type;
  document.getElementById('tt-file').textContent = (d.file||'').split(/[\\/\\\\]/).slice(-2).join('/') + ':' + (d.line||'');
  document.getElementById('tt-sig').textContent  = '';
  document.getElementById('tt-warn').textContent = d.undefinedRefs?.length
    ? '⚠ undefined: ' + d.undefinedRefs.join(', ') : '';
  tip.style.display = 'block';
  moveTooltip(ev);
}
function moveTooltip(ev) {
  const tw = tip.offsetWidth;
  const th = tip.offsetHeight;
  let  lx = ev.clientX + 16;
  let  ly = ev.clientY + 16;
  if (lx + tw > window.innerWidth  - 10) { lx = ev.clientX - tw - 10; }
  if (ly + th > window.innerHeight - 10) { ly = ev.clientY - th - 10; }
  tip.style.left = lx + 'px';
  tip.style.top  = ly + 'px';
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
  searchQuery = ev.target.value.trim();
  render();
});

window.addEventListener('resize', () => {
  svg.attr('width', W()).attr('height', H());
  if (simulation) {
    simulation.force('center', d3.forceCenter(W()/2, H()/2)).alpha(0.1).restart();
  }
});

// ── Messages from extension ────────────────────────────────────────────────────
window.addEventListener('message', ev => {
  const msg = ev.data;

  if (msg.command === 'updateGraph') {
    const hadData = RAW.nodes && RAW.nodes.length > 0;
    RAW = { nodes: msg.nodes || [], edges: msg.edges || [] };
    if (!hadData) {
      // First load — full bootstrap with loading spinner
      bootstrap();
    } else {
      // Refresh — just re-render, no spinner, preserve zoom/pan
      render();
    }
  }

  if (msg.command === 'setStatus') {
    const el = document.getElementById('loading-text');
    if (el) { el.textContent = msg.text || 'Processing…'; }
  }
});

// Signal extension that JS is ready to receive data
// Must be AFTER addEventListener so we don't miss the response
vscode.postMessage({ command: 'ready' });

// ── Utils ──────────────────────────────────────────────────────────────────────
function escHtml(s) {
  return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function escAttr(s) {
  return String(s||'').replace(/\\\\/g,'\\\\\\\\').replace(/'/g,"\\\\'");
}

bootstrap();
</script>
</body>
</html>`;
}
