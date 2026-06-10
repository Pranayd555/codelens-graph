const esbuild  = require('esbuild');
const path     = require('path');
const fs       = require('fs');

const production = process.argv.includes('--production');
const watch      = process.argv.includes('--watch');

// ─── Shared options ───────────────────────────────────────────────────────────
const sharedOptions = {
  bundle:    true,
  platform:  'node',
  target:    'node20',
  format:    'cjs',
  sourcemap: !production,
  minify:    production,
  logLevel:  'info',
};

// ─── Copy WASM files needed at runtime ───────────────────────────────────────
// sql.js, web-tree-sitter, and tree-sitter-wasms all load .wasm files from
// disk at runtime — esbuild cannot inline them. We copy them into dist/ so
// the packaged extension finds them relative to the bundle.

function copyWasmFiles() {
  const wasmTargetDir = path.join(__dirname, 'dist', 'wasm');
  fs.mkdirSync(wasmTargetDir, { recursive: true });

  const copies = [
    // sql.js wasm
    {
      src: path.join(__dirname, 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm'),
      dest: path.join(wasmTargetDir, 'sql-wasm.wasm'),
    },
    // web-tree-sitter wasm
    {
      src: path.join(__dirname, 'node_modules', 'web-tree-sitter', 'tree-sitter.wasm'),
      dest: path.join(wasmTargetDir, 'tree-sitter.wasm'),
    },
  ];

  // Copy all tree-sitter language grammars
  const grammarSrc = path.join(__dirname, 'node_modules', 'tree-sitter-wasms', 'out');
  if (fs.existsSync(grammarSrc)) {
    for (const file of fs.readdirSync(grammarSrc)) {
      if (file.endsWith('.wasm')) {
        copies.push({ src: path.join(grammarSrc, file), dest: path.join(wasmTargetDir, file) });
      }
    }
  }

  let copied = 0;
  for (const { src, dest } of copies) {
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, dest);
      copied++;
    }
  }
  console.log(`Copied ${copied} WASM files to dist/wasm/`);
}

// ─── WASM path resolver plugin ────────────────────────────────────────────────
// Intercepts require('sql.js') and require('web-tree-sitter') at bundle time
// so they look for WASM files relative to __dirname (dist/wasm/) instead of
// their original node_modules location.

const wasmPathPlugin = {
  name: 'wasm-path',
  setup(build) {
    // Rewrite sql.js to a thin wrapper that sets locateFile to our dist/wasm/
    build.onResolve({ filter: /^sql\.js$/ }, () => ({
      path: require.resolve('./node_modules/sql.js/dist/sql-wasm.js'),
    }));
  },
};

async function buildAll() {
  copyWasmFiles();

  const builds = [
    // ── 1. VS Code extension (does NOT include vscode module) ────────────────
    {
      ...sharedOptions,
      entryPoints: ['src/extension.ts'],
      outfile:     'dist/extension.js',
      external:    ['vscode'],
      define: {
        // Tell sql.js where to find its wasm file at runtime
        'process.env.SQL_WASM_PATH': JSON.stringify(''),
      },
      plugins: [wasmPathPlugin],
    },
    // ── 2. MCP standalone binary (no vscode) ─────────────────────────────────
    {
      ...sharedOptions,
      entryPoints: ['src/mcp/mcpEntry.ts'],
      outfile:     'dist/mcp.js',
      external:    [],          // bundle everything — no vscode dep
      banner:      { js: '#!/usr/bin/env node' },
      plugins:     [wasmPathPlugin],
    },
  ];

  if (watch) {
    // Watch mode — only for extension (faster dev cycle)
    const ctx = await esbuild.context({ ...builds[0], logLevel: 'info' });
    await ctx.watch();
    console.log('Watching extension…');
  } else {
    for (const opts of builds) {
      await esbuild.build(opts);
    }
  }
}

buildAll().catch(err => {
  console.error(err);
  process.exit(1);
});
