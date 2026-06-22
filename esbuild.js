const esbuild = require('esbuild');
const path    = require('path');
const fs      = require('fs');

const production = process.argv.includes('--production');
const watch      = process.argv.includes('--watch');

// ── Copy WASM files to dist/wasm/ ─────────────────────────────────────────────
function copyWasmFiles() {
  const dest = path.join(__dirname, 'dist', 'wasm');
  fs.mkdirSync(dest, { recursive: true });

  const sources = [
    path.join(__dirname, 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm'),
    path.join(__dirname, 'node_modules', 'web-tree-sitter', 'tree-sitter.wasm'),
  ];

  const grammarDir = path.join(__dirname, 'node_modules', 'tree-sitter-wasms', 'out');
  if (fs.existsSync(grammarDir)) {
    for (const f of fs.readdirSync(grammarDir)) {
      if (f.endsWith('.wasm')) { sources.push(path.join(grammarDir, f)); }
    }
  }

  let copied = 0;
  for (const src of sources) {
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, path.join(dest, path.basename(src)));
      copied++;
    }
  }
  console.log(`Copied ${copied} WASM files → dist/wasm/`);
}

// ── Shared build options ──────────────────────────────────────────────────────
const shared = {
  bundle:    true,
  platform:  'node',
  target:    'node20',
  format:    'cjs',
  sourcemap: !production,
  minify:    production,
  logLevel:  'info',
};

// ── Post-build: make mcp.js executable ────────────────────────────────────────
// esbuild banner adds shebang INSIDE the JS which breaks require().
// Instead we write a tiny launcher wrapper after the bundle is built.
function writeMcpLauncher() {
  const mcpBundle  = path.join(__dirname, 'dist', 'mcp.js');
  const mcpWrapper = path.join(__dirname, 'dist', 'mcp-run.js');

  // The bundle itself has no shebang — it's a plain CJS module.
  // The launcher is the executable entry point that just requires it.
  const wrapper = `#!/usr/bin/env node\nrequire('./mcp.js');\n`;
  fs.writeFileSync(mcpWrapper, wrapper, { mode: 0o755 });
  console.log('MCP launcher written → dist/mcp-run.js');
}

async function buildAll() {
  copyWasmFiles();

  // 1. VS Code extension bundle (vscode excluded, no shebang)
  await esbuild.build({
    ...shared,
    entryPoints: ['src/extension.ts'],
    outfile:     'dist/extension.js',
    external:    ['vscode'],
  });

  // 2. MCP server bundle — plain CJS, NO shebang banner
  //    VS Code runs it as: node /path/to/dist/mcp.js <workspace>
  //    so it must be a valid CJS file, not a shell script.
  await esbuild.build({
    ...shared,
    entryPoints: ['src/mcp/mcpEntry.ts'],
    outfile:     'dist/mcp.js',
    external:    [],
    // NO banner — shebang in the middle of minified JS causes SyntaxError
  });

  writeMcpLauncher();
}

async function buildWatch() {
  copyWasmFiles();
  const ctx = await esbuild.context({
    ...shared,
    entryPoints: ['src/extension.ts'],
    outfile:     'dist/extension.js',
    external:    ['vscode'],
    logLevel:    'info',
  });
  await ctx.watch();
  console.log('Watching extension…');
}

if (watch) { buildWatch().catch(e => { console.error(e); process.exit(1); }); }
else       { buildAll().catch(e => { console.error(e); process.exit(1); }); }
