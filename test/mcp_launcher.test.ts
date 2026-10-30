import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { installLauncher, launcherPath, launcherConfigPath, migrateAgentConfigs } from '../src/agent/mcpLauncher';

// A fake home directory with editor extension folders whose "servers" report
// which version was started and with what arguments.
class FakeHome {
  readonly root = fs.mkdtempSync(path.join(os.tmpdir(), 'codelens-home-'));
  readonly out = path.join(this.root, 'started.json');

  install(editorDir: string, folder: string): string {
    const entry = path.join(this.root, editorDir, 'extensions', folder, 'dist', 'mcp.js');
    fs.mkdirSync(path.dirname(entry), { recursive: true });
    fs.writeFileSync(entry, `require('fs').writeFileSync(process.env.CODELENS_TEST_OUT, JSON.stringify({ folder: ${JSON.stringify(folder)}, args: process.argv.slice(2) }));\n`);
    return entry;
  }

  uninstall(editorDir: string, folder: string): void {
    fs.rmSync(path.join(this.root, editorDir, 'extensions', folder), { recursive: true, force: true });
  }

  // Runs the launcher the way an agent does: node <launcher> --auto
  start(): { status: number | null; started?: { folder: string; args: string[] }; stderr: string } {
    fs.rmSync(this.out, { force: true });
    const env = { ...process.env, HOME: this.root, USERPROFILE: this.root, CODELENS_TEST_OUT: this.out };
    const run = spawnSync(process.execPath, [launcherPath(this.root), '--auto'], { env, encoding: 'utf-8' });
    const started = fs.existsSync(this.out) ? JSON.parse(fs.readFileSync(this.out, 'utf-8')) : undefined;
    return { status: run.status, started, stderr: run.stderr };
  }

  write(rel: string, text: string): string {
    const filePath = path.join(this.root, ...rel.split('/'));
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, text);
    return filePath;
  }

  read(rel: string): string {
    return fs.readFileSync(path.join(this.root, ...rel.split('/')), 'utf-8');
  }

  cleanup(): void { fs.rmSync(this.root, { recursive: true, force: true }); }
}

describe('MCP launcher survives extension updates', () => {
  let home: FakeHome;
  beforeEach(() => { home = new FakeHome(); });
  afterEach(() => home.cleanup());

  it('starts the newest installed version across editors and passes arguments through', () => {
    const vscode = home.install('.vscode', 'pranaydas.codelens-graph-0.3.1');
    home.install('.cursor', 'pranaydas.codelens-graph-0.2.4-universal');
    home.install('.antigravity-ide', 'pranaydas.codelens-graph-0.3.2-universal');
    installLauncher(vscode, '0.3.1', home.root);

    const run = home.start();
    assert.equal(run.status, 0, run.stderr);
    assert.deepStrictEqual(run.started, { folder: 'pranaydas.codelens-graph-0.3.2-universal', args: ['--auto'] });
  });

  it('keeps working after an update deletes the version that wrote it', () => {
    const old = home.install('.vscode', 'pranaydas.codelens-graph-0.3.1');
    installLauncher(old, '0.3.1', home.root);
    // VS Code updates: installs 0.3.2 and deletes 0.3.1, before CodeLens runs again.
    home.install('.vscode', 'pranaydas.codelens-graph-0.3.2');
    home.uninstall('.vscode', 'pranaydas.codelens-graph-0.3.1');

    assert.equal(home.start().started?.folder, 'pranaydas.codelens-graph-0.3.2');
  });

  it('skips versions VS Code has marked obsolete but not deleted yet', () => {
    const current = home.install('.vscode', 'pranaydas.codelens-graph-0.3.1');
    home.install('.vscode', 'pranaydas.codelens-graph-0.3.9');
    home.write('.vscode/extensions/.obsolete', JSON.stringify({ 'pranaydas.codelens-graph-0.3.9': true }));
    installLauncher(current, '0.3.1', home.root);

    assert.equal(home.start().started?.folder, 'pranaydas.codelens-graph-0.3.1');
  });

  it('uses the writing extension when it is installed outside the known folders', () => {
    const custom = path.join(home.root, 'portable', 'pranaydas.codelens-graph-0.4.0', 'dist', 'mcp.js');
    fs.mkdirSync(path.dirname(custom), { recursive: true });
    fs.writeFileSync(custom, `require('fs').writeFileSync(process.env.CODELENS_TEST_OUT, JSON.stringify({ folder: 'portable', args: process.argv.slice(2) }));\n`);
    home.install('.vscode', 'pranaydas.codelens-graph-0.3.1');
    installLauncher(custom, '0.4.0', home.root);

    assert.equal(home.start().started?.folder, 'portable');
  });

  it('is not steered back to an older version by an older editor starting up', () => {
    const custom = path.join(home.root, 'portable', 'pranaydas.codelens-graph-0.4.0', 'dist', 'mcp.js');
    fs.mkdirSync(path.dirname(custom), { recursive: true });
    fs.writeFileSync(custom, `require('fs').writeFileSync(process.env.CODELENS_TEST_OUT, JSON.stringify({ folder: 'portable', args: [] }));\n`);
    const older = home.install('.cursor', 'pranaydas.codelens-graph-0.2.4-universal');
    installLauncher(custom, '0.4.0', home.root);
    installLauncher(older, '0.2.4', home.root);

    assert.equal(home.start().started?.folder, 'portable');
  });

  it('only rewrites the launcher when its content changes', () => {
    const entry = home.install('.vscode', 'pranaydas.codelens-graph-0.3.1');
    assert.equal(installLauncher(entry, '0.3.1', home.root), true);
    assert.equal(installLauncher(entry, '0.3.1', home.root), false);
  });

  it('fails with a clear message when CodeLens is not installed anywhere', () => {
    const entry = home.install('.vscode', 'pranaydas.codelens-graph-0.3.1');
    installLauncher(entry, '0.3.1', home.root);
    home.uninstall('.vscode', 'pranaydas.codelens-graph-0.3.1');

    const run = home.start();
    assert.equal(run.status, 1);
    assert.match(run.stderr, /No installed CodeLens Graph extension was found/);
  });
});

describe('Agent configs pointing at a versioned install folder', () => {
  let home: FakeHome;
  let launcher: string;
  const versioned = 'c:/Users/me/.vscode/extensions/pranaydas.codelens-graph-0.3.0/dist/mcp.js';
  const versionedWin = 'C:\\Users\\me\\.cursor\\extensions\\pranaydas.codelens-graph-0.2.4-universal\\dist\\mcp-run.js';
  const devBuild = 'C:/Users/me/projects/codelens-graph/dist/mcp.js';

  beforeEach(() => {
    home = new FakeHome();
    launcher = launcherConfigPath(home.root);
  });
  afterEach(() => home.cleanup());

  it('rewrites only the CodeLens path in ~/.claude.json, keeping everything else', () => {
    const original = {
      numStartups: 42,
      oauthAccount: { emailAddress: 'someone@example.com' },
      mcpServers: {
        codelens: { type: 'stdio', command: 'node', args: [versioned, '--auto'], env: {} },
        other: { command: 'npx', args: ['some-server', versioned.replace('codelens-graph', 'other-tool')] },
      },
      projects: {
        'C:/work/a': { allowedTools: [], mcpServers: { 'codelens-graph': { command: 'node', args: [versionedWin, '--auto'] } } },
        'C:/work/dev': { mcpServers: { codelens: { command: 'node', args: [devBuild, '--auto'] } } },
      },
    };
    home.write('.claude.json', JSON.stringify(original, null, 2));

    assert.deepStrictEqual(migrateAgentConfigs(home.root), [path.join(home.root, '.claude.json')]);

    const expected = structuredClone(original);
    expected.mcpServers.codelens.args = [launcher, '--auto'];
    expected.projects['C:/work/a'].mcpServers['codelens-graph'].args = [launcher, '--auto'];
    assert.equal(home.read('.claude.json'), JSON.stringify(expected, null, 2), 'only the versioned paths change, formatting kept');
  });

  it('updates Cursor and Windsurf configs and workspace .mcp.json / .cursor / .vscode files', () => {
    home.write('.cursor/mcp.json', JSON.stringify({ mcpServers: { codelens: { command: 'node', args: [versioned, '--auto'] } } }, null, 4) + '\n');
    home.write('.codeium/windsurf/mcp_config.json', JSON.stringify({ mcpServers: { codelens: { command: 'node', args: [versionedWin] } } }));
    const ws = path.join(home.root, 'project');
    home.write('project/.mcp.json', JSON.stringify({ mcpServers: { codelens: { command: 'node', args: [versioned, '--auto'] } } }, null, 2));
    home.write('project/.vscode/mcp.json', JSON.stringify({ servers: { codelens: { command: 'node', args: [versioned, '--auto'] } } }, null, 2));

    const changed = migrateAgentConfigs(home.root, ws).map(f => path.relative(home.root, f).split(path.sep).join('/')).sort();
    assert.deepStrictEqual(changed, ['.codeium/windsurf/mcp_config.json', '.cursor/mcp.json', 'project/.mcp.json', 'project/.vscode/mcp.json']);
    assert.ok(home.read('.cursor/mcp.json').startsWith('{\n    "mcpServers"'), '4-space indentation kept');
    assert.ok(home.read('.cursor/mcp.json').endsWith('}\n'), 'trailing newline kept');
    assert.equal(JSON.parse(home.read('project/.vscode/mcp.json')).servers.codelens.args[0], launcher);
  });

  it('leaves files alone when there is nothing to change, or they are not plain JSON', () => {
    home.write('.cursor/mcp.json', JSON.stringify({ mcpServers: { codelens: { command: 'node', args: [devBuild] } } }));
    const jsonc = '{\n  // comment\n  "mcpServers": { "codelens": { "command": "node", "args": ["' + versioned + '"] } }\n}\n';
    home.write('.codeium/windsurf/mcp_config.json', jsonc);
    const before = fs.statSync(path.join(home.root, '.cursor', 'mcp.json')).mtimeMs;

    assert.deepStrictEqual(migrateAgentConfigs(home.root), []);
    assert.equal(fs.statSync(path.join(home.root, '.cursor', 'mcp.json')).mtimeMs, before);
    assert.equal(home.read('.codeium/windsurf/mcp_config.json'), jsonc);
  });

  it('is idempotent', () => {
    home.write('.claude.json', JSON.stringify({ mcpServers: { codelens: { command: 'node', args: [versioned] } } }, null, 2));
    assert.equal(migrateAgentConfigs(home.root).length, 1);
    assert.equal(migrateAgentConfigs(home.root).length, 0);
  });
});
