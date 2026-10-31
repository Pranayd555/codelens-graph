import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { SkillGenerator } from '../../src/agent/skillGenerator';
import { launcherConfigPath } from '../../src/agent/mcpLauncher';
import { GraphStats } from '../../src/types';
import { TestWorkspace } from '../helpers';
import { FakeHome, read, listTree } from './sandbox';

const START = '<!-- CODELENS_MANAGED_START -->';
const END = '<!-- CODELENS_MANAGED_END -->';

const stats = (totalNodes = 12, fileCount = 3): GraphStats => ({
  totalNodes, fileCount, totalEdges: 5, byType: {} as GraphStats['byType'], lastBuilt: 0, buildDurationMs: 0,
});

// The IDE ids the extension stores in workspaceState('selectedIdes') and the
// files each one owns (see AGENT_RULE_FILES and the quick pick in extension.ts).
const IDE_FILES: Record<string, string[]> = {
  vscode: ['.vscode/codelens.instructions.md', '.vscode/mcp.json'],
  cursor: ['.cursor/rules/codelens.mdc'],
  antigravity: ['.agents/AGENTS.md'],
  Claude: ['CLAUDE.md'],
  Winsurf: ['.windsurfrules'],
};
const ALL_IDES = Object.keys(IDE_FILES);
const INTERNAL = ['.codelens/.gitignore', '.codelens/README.md', '.codelens/instructions.md', '.codelens/mcp.json'];
const INTERNAL_WRITTEN = ['.codelens/README.md', '.codelens/mcp.json', '.codelens/instructions.md'];

const count = (text: string, needle: string) => text.split(needle).length - 1;
const OLD = new Date('2020-01-01T00:00:00Z');

describe('SkillGenerator', () => {
  // SkillGenerator only needs the DB handle; one opened index is shared, and
  // every test gets its own empty workspace folder.
  let dbHolder: TestWorkspace;
  let home: FakeHome;
  let ws: TestWorkspace;
  let gen: SkillGenerator;

  before(async () => {
    dbHolder = new TestWorkspace();
    await dbHolder.open();
  });
  after(() => dbHolder.close());

  beforeEach(() => {
    home = new FakeHome();
    ws = new TestWorkspace();
    gen = new SkillGenerator(dbHolder.db);
  });
  afterEach(() => {
    ws.close();
    home.restore();
  });

  const file = (rel: string) => read(ws.path(rel));
  const exists = (rel: string) => fs.existsSync(ws.path(rel));
  const tree = () => listTree(ws.root);
  const backdate = (rel: string) => fs.utimesSync(ws.path(rel), OLD, OLD);
  const mtime = (rel: string) => fs.statSync(ws.path(rel)).mtimeMs;

  describe('writeInternalFiles', () => {
    it("writes only CodeLens's own files under .codelens/", () => {
      const written = gen.writeInternalFiles(ws.root, stats());

      assert.deepEqual(written, INTERNAL_WRITTEN);
      assert.deepEqual(tree(), INTERNAL);
      assert.equal(file('.codelens/.gitignore'), '*\n');
    });

    it('README links to the other files with forward-slash file URLs', () => {
      gen.writeInternalFiles(ws.root, stats());
      const readme = file('.codelens/README.md');
      const fwd = ws.root.replace(/\\/g, '/');
      assert.ok(readme.includes(`(file:///${fwd}/.codelens/instructions.md)`), readme);
      assert.ok(readme.includes(`(file:///${fwd}/.codelens/mcp.json)`), readme);
      assert.ok(!readme.includes('\\'));
    });

    it('instructions.md carries the live counts and the managed rules section', () => {
      gen.writeInternalFiles(ws.root, stats(4321, 87));
      const md = file('.codelens/instructions.md');
      assert.match(md, /\*\*4321 symbols\*\* across \*\*87 files\*\*/);
      assert.equal(count(md, START), 1);
      assert.equal(count(md, END), 1);
      assert.ok(md.indexOf(START) < md.indexOf(END));
    });

    it('mcp.json lists a codelens server entry for every supported agent', () => {
      gen.writeInternalFiles(ws.root, stats());
      const config = JSON.parse(file('.codelens/mcp.json'));
      const entry = config.vscode.servers.codelens.args[0];
      assert.deepEqual(config.vscode.servers.codelens, { command: 'node', args: [entry, '--auto'] });
      assert.deepEqual(config.cursor.codelens.args, [entry, '--auto']);
      assert.deepEqual(config.Claude.codelens, { type: 'stdio', command: 'node', args: [entry, '--auto'] });
      assert.deepEqual(config.Winsurf.codelens.args, [entry, '--auto']);
      assert.equal(config.Claude._add_to, '~/.claude.json');
    });
  });

  describe('MCP server entry path', () => {
    const entryPath = () => {
      gen.writeInternalFiles(ws.root, stats());
      return JSON.parse(file('.codelens/mcp.json')).vscode.servers.codelens.args[0] as string;
    };

    it("falls back to this extension's own server when no launcher is installed in ~/.codelens", () => {
      // Under ts-node the module's __dirname is src/agent; bundled, it is dist/.
      const expected = path.resolve(__dirname, '../../src/agent/mcp.js').replace(/\\/g, '/');
      assert.equal(entryPath(), expected);
    });

    it('points at the stable ~/.codelens/mcp.js launcher once it exists', () => {
      home.write('.codelens/mcp.js', '// launcher');
      const entry = entryPath();
      assert.equal(entry, launcherConfigPath(home.root));
      assert.ok(!entry.includes('\\'));
      assert.ok(entry.endsWith('/.codelens/mcp.js'));
    });

    it('uses the same entry in .vscode/mcp.json', () => {
      home.write('.codelens/mcp.js', '// launcher');
      gen.generateAll(ws.root, stats(), ['vscode']);
      assert.deepEqual(JSON.parse(file('.vscode/mcp.json')).servers.codelens,
        { command: 'node', args: [launcherConfigPath(home.root), '--auto'] });
    });
  });

  describe('generateAll per agent selection', () => {
    for (const ide of ALL_IDES) {
      it(`'${ide}' writes ${IDE_FILES[ide].join(' + ')} and nothing for the other agents`, () => {
        const written = gen.generateAll(ws.root, stats(), [ide]);
        assert.deepEqual(tree(), [...INTERNAL, ...IDE_FILES[ide]].sort());
        for (const rel of IDE_FILES[ide]) { assert.ok(written.includes(rel), `${rel} in ${written}`); }
      });
    }

    it('with no agents selected writes only .codelens/ files', () => {
      assert.deepEqual(gen.generateAll(ws.root, stats(), []), INTERNAL_WRITTEN);
      assert.deepEqual(gen.generateAll(ws.root, stats()), INTERNAL_WRITTEN);
      assert.deepEqual(tree(), INTERNAL);
    });

    it("matches ids exactly as the extension stores them ('Claude', 'Winsurf')", () => {
      gen.generateAll(ws.root, stats(), ['claude', 'windsurf', 'VSCode']);
      assert.deepEqual(tree(), INTERNAL);
    });

    it('owned rule files get their frontmatter header followed by the managed section', () => {
      gen.generateAll(ws.root, stats(), ['vscode', 'cursor']);
      const vscode = file('.vscode/codelens.instructions.md');
      assert.ok(vscode.startsWith(`---\napplyTo: "**"\n---\n\n${START}`), vscode.slice(0, 80));
      const cursor = file('.cursor/rules/codelens.mdc');
      assert.ok(cursor.startsWith('---\ndescription: CodeLens Graph'), cursor.slice(0, 80));
      assert.match(cursor, /alwaysApply: true\n---\n\n<!-- CODELENS_MANAGED_START -->/);
    });

    it('.vscode/mcp.json registers the codelens server', () => {
      gen.generateAll(ws.root, stats(), ['vscode']);
      const config = JSON.parse(file('.vscode/mcp.json'));
      assert.deepEqual(Object.keys(config.servers), ['codelens']);
      assert.equal(config.servers.codelens.command, 'node');
      assert.equal(config.servers.codelens.args[1], '--auto');
    });

    it('agent rule files do not embed live counts, so they stay stable across saves', () => {
      gen.generateAll(ws.root, stats(1, 1), ALL_IDES);
      const before = Object.fromEntries(tree().map(rel => [rel, file(rel)]));
      gen.generateAll(ws.root, stats(999, 99), ALL_IDES);
      for (const rel of tree()) {
        if (rel === '.codelens/instructions.md') { assert.notEqual(file(rel), before[rel]); continue; }
        assert.equal(file(rel), before[rel], rel);
      }
    });
  });

  describe("managed sections in the user's own files", () => {
    it("appends the section to an existing CLAUDE.md without losing the user's content", () => {
      ws.write('CLAUDE.md', '# My rules\n\nAlways write tests.\n');
      gen.generateAll(ws.root, stats(), ['Claude']);

      const text = file('CLAUDE.md');
      assert.ok(text.startsWith('# My rules\n\nAlways write tests.\n\n' + START), text.slice(0, 80));
      assert.ok(text.endsWith(END + '\n'));
      assert.equal(count(text, START), 1);
    });

    it('regenerating is idempotent: still one section, user content intact', () => {
      ws.write('.windsurfrules', 'user rule one\nuser rule two\n');
      gen.generateAll(ws.root, stats(), ['Winsurf']);
      const first = file('.windsurfrules');
      gen.generateAll(ws.root, stats(), ['Winsurf']);
      gen.generateAll(ws.root, stats(), ['Winsurf']);
      assert.equal(file('.windsurfrules'), first);
      assert.equal(count(first, START), 1);
      assert.ok(first.startsWith('user rule one\nuser rule two\n'));
    });

    it('replaces an outdated section and keeps the user content around it', () => {
      ws.write('.agents/AGENTS.md', `# Top\n\n${START}\nold rules\n${END}\n\n## Bottom\n`);
      gen.generateAll(ws.root, stats(), ['antigravity']);

      const text = file('.agents/AGENTS.md');
      assert.ok(!text.includes('old rules'));
      assert.equal(count(text, START), 1);
      assert.ok(text.includes('# Top'));
      assert.ok(text.includes('## Bottom'));
      assert.ok(text.indexOf('## Bottom') < text.indexOf(START), 'section moves to the end');
    });

    it("deselecting an agent strips the section but keeps the user's file", () => {
      ws.write('CLAUDE.md', '# My rules\n\nAlways write tests.\n');
      gen.generateAll(ws.root, stats(), ['Claude']);
      gen.generateAll(ws.root, stats(), []);

      const text = file('CLAUDE.md');
      assert.ok(!text.includes(START) && !text.includes(END));
      assert.ok(text.includes('# My rules'));
      assert.ok(text.includes('Always write tests.'));
    });

    it('deselecting deletes the files CodeLens created that hold no user content', () => {
      gen.generateAll(ws.root, stats(), ALL_IDES);
      gen.generateAll(ws.root, stats(), []);
      assert.deepEqual(tree(), INTERNAL);
    });

    it('deselecting one agent leaves the others in place', () => {
      gen.generateAll(ws.root, stats(), ALL_IDES);
      gen.generateAll(ws.root, stats(), ALL_IDES.filter(ide => ide !== 'cursor'));
      assert.equal(exists('.cursor/rules/codelens.mdc'), false);
      for (const ide of ALL_IDES.filter(i => i !== 'cursor')) {
        for (const rel of IDE_FILES[ide]) { assert.ok(exists(rel), rel); }
      }
    });

    it('never touches files without a managed section on deselect', () => {
      ws.write('CLAUDE.md', 'just mine\n');
      backdate('CLAUDE.md');
      gen.generateAll(ws.root, stats(), []);
      assert.equal(file('CLAUDE.md'), 'just mine\n');
      assert.equal(mtime('CLAUDE.md'), OLD.getTime());
    });

    it('strips sections left by older versions from files no longer managed', () => {
      const legacy = ['.cursorrules', '.github/copilot-instructions.md', '.clinerules', 'CONVENTIONS.md'];
      ws.write('.cursorrules', `${START}\nold\n${END}\n`);
      ws.write('.github/copilot-instructions.md', `Use tabs.\n\n${START}\nold\n${END}\n`);
      ws.write('.clinerules', 'no section here\n');
      ws.write('CONVENTIONS.md', `${START}\nold\n${END}`);

      const written = gen.generateAll(ws.root, stats(), ALL_IDES);
      for (const rel of legacy) { assert.ok(!written.includes(rel)); }
      assert.equal(exists('.cursorrules'), false);
      assert.equal(exists('CONVENTIONS.md'), false);
      assert.equal(file('.github/copilot-instructions.md').trim(), 'Use tabs.');
      assert.equal(file('.clinerules'), 'no section here\n');
    });

    it("removeAll keeps the user's other lines when a section in the middle is removed", () => {
      ws.write('CLAUDE.md', `# Top\n\n${START}\nold\n${END}\n\n## Bottom\n`);
      gen.removeAll(ws.root);
      const lines = file('CLAUDE.md').split(/\r?\n/).filter(l => l.trim());
      assert.deepEqual(lines, ['# Top', '## Bottom']);
    });

    it('keeps a user file that only has frontmatter across regenerations and deselect', { todo: 'BUG: user frontmatter is treated as empty, so it is dropped on the 2nd generate and the file is deleted on deselect' }, () => {
      ws.write('CLAUDE.md', '---\ntitle: mine\n---\n');
      gen.generateAll(ws.root, stats(), ['Claude']);
      gen.generateAll(ws.root, stats(), ['Claude']);
      assert.ok(file('CLAUDE.md').startsWith('---\ntitle: mine\n---'), 'frontmatter kept on regenerate');
      gen.generateAll(ws.root, stats(), []);
      assert.ok(exists('CLAUDE.md'), 'user file kept on deselect');
      assert.equal(file('CLAUDE.md').trim(), '---\ntitle: mine\n---');
    });

    it('keeps user content that follows a start marker whose end marker was deleted', { todo: 'BUG: an orphan START marker is kept, so the next removal cuts from it to the new END and deletes the user text in between' }, () => {
      ws.write('CLAUDE.md', `# Mine\n${START}\nold\n\n## Keep me\n`);
      gen.generateAll(ws.root, stats(), ['Claude']);
      gen.generateAll(ws.root, stats(), []);
      assert.ok(exists('CLAUDE.md'));
      assert.ok(file('CLAUDE.md').includes('## Keep me'));
    });
  });

  describe('writes only when content changes', () => {
    it("leaves every file's mtime alone when regenerating identical content", () => {
      ws.write('CLAUDE.md', '# Mine\n');
      gen.generateAll(ws.root, stats(), ALL_IDES);
      const files = tree();
      for (const rel of files) { backdate(rel); }

      gen.generateAll(ws.root, stats(), ALL_IDES);
      for (const rel of files) { assert.equal(mtime(rel), OLD.getTime(), `${rel} was rewritten`); }
    });

    it('ignores CRLF vs LF differences (e.g. after a git checkout with autocrlf)', () => {
      gen.generateAll(ws.root, stats(), ['Claude', 'cursor']);
      for (const rel of ['CLAUDE.md', '.cursor/rules/codelens.mdc']) {
        fs.writeFileSync(ws.path(rel), file(rel).replace(/\n/g, '\r\n'));
        backdate(rel);
      }
      gen.generateAll(ws.root, stats(), ['Claude', 'cursor']);
      assert.equal(mtime('CLAUDE.md'), OLD.getTime());
      assert.equal(mtime('.cursor/rules/codelens.mdc'), OLD.getTime());
    });

    it('rewrites only the file whose content changed', () => {
      gen.generateAll(ws.root, stats(1, 1), ['Claude']);
      for (const rel of tree()) { backdate(rel); }
      gen.generateAll(ws.root, stats(2, 2), ['Claude']);
      assert.notEqual(mtime('.codelens/instructions.md'), OLD.getTime());
      assert.equal(mtime('CLAUDE.md'), OLD.getTime());
      assert.equal(mtime('.codelens/mcp.json'), OLD.getTime());
    });

    it('restores an owned rule file the user edited', () => {
      gen.generateAll(ws.root, stats(), ['cursor']);
      const original = file('.cursor/rules/codelens.mdc');
      fs.writeFileSync(ws.path('.cursor/rules/codelens.mdc'), 'tampered');
      gen.generateAll(ws.root, stats(), ['cursor']);
      assert.equal(file('.cursor/rules/codelens.mdc'), original);
    });
  });

  describe('.vscode/mcp.json', () => {
    const userConfig = {
      inputs: [{ id: 'token', type: 'promptString' }],
      servers: { github: { command: 'gh', args: ['mcp'] } },
    };

    it("adds codelens next to the user's servers and keeps other keys", () => {
      ws.write('.vscode/mcp.json', JSON.stringify(userConfig));
      gen.generateAll(ws.root, stats(), ['vscode']);

      const config = JSON.parse(file('.vscode/mcp.json'));
      assert.deepEqual(config.inputs, userConfig.inputs);
      assert.deepEqual(config.servers.github, userConfig.servers.github);
      assert.ok(config.servers.codelens);
    });

    it('deselecting vscode removes only the codelens server', () => {
      ws.write('.vscode/mcp.json', JSON.stringify(userConfig));
      gen.generateAll(ws.root, stats(), ['vscode']);
      gen.generateAll(ws.root, stats(), []);
      assert.deepEqual(JSON.parse(file('.vscode/mcp.json')), userConfig);
    });

    it('drops an emptied servers object but keeps the file when other keys remain', () => {
      ws.write('.vscode/mcp.json', JSON.stringify({ inputs: [] }));
      gen.generateAll(ws.root, stats(), ['vscode']);
      gen.generateAll(ws.root, stats(), []);
      assert.deepEqual(JSON.parse(file('.vscode/mcp.json')), { inputs: [] });
    });

    it('deletes the file when codelens was its only content', () => {
      gen.generateAll(ws.root, stats(), ['vscode']);
      gen.generateAll(ws.root, stats(), []);
      assert.equal(exists('.vscode/mcp.json'), false);
    });

    it('leaves a config without a codelens server, or an unparsable one, alone on deselect', () => {
      ws.write('.vscode/mcp.json', JSON.stringify(userConfig));
      backdate('.vscode/mcp.json');
      gen.generateAll(ws.root, stats(), []);
      assert.equal(mtime('.vscode/mcp.json'), OLD.getTime());

      ws.write('.vscode/mcp.json', '{ broken');
      gen.generateAll(ws.root, stats(), []);
      assert.equal(file('.vscode/mcp.json'), '{ broken');
    });

    it('replaces a corrupt config with a valid one when vscode is selected', () => {
      ws.write('.vscode/mcp.json', '{ broken');
      gen.generateAll(ws.root, stats(), ['vscode']);
      assert.deepEqual(Object.keys(JSON.parse(file('.vscode/mcp.json')).servers), ['codelens']);
    });
  });

  describe('clearAll', () => {
    it('removes everything CodeLens created and nothing the user owns', () => {
      ws.write('CLAUDE.md', '# Mine\n');
      ws.write('.vscode/settings.json', '{}');
      ws.write('.vscode/mcp.json', JSON.stringify({ servers: { other: { command: 'x' } } }));
      ws.write('.cursor/other.txt', 'keep');
      ws.write('.gitignore', 'node_modules/\n# CodeLens Graph local index\n.codelens/\n');
      ws.write('src/app.ts', 'export const x = 1;\n');
      ws.write('.codelens/codelens-graph.db', 'index'); // the index lives in .codelens/ too
      gen.generateAll(ws.root, stats(), ALL_IDES);

      gen.clearAll(ws.root);

      assert.deepEqual(tree(), ['.cursor/other.txt', '.gitignore', '.vscode/mcp.json', '.vscode/settings.json', 'CLAUDE.md', 'src/app.ts']);
      assert.equal(file('CLAUDE.md').trim(), '# Mine');
      assert.deepEqual(JSON.parse(file('.vscode/mcp.json')), { servers: { other: { command: 'x' } } });
      assert.equal(file('.gitignore').trim(), 'node_modules/');
    });

    it('keeps the .gitignore lines around the old CodeLens block intact', { todo: 'BUG: removeGitignore regex eats the newline before and after the block, joining the neighbouring lines (node_modules/dist/)' }, () => {
      ws.write('.gitignore', 'node_modules/\n# CodeLens Graph local index\n.codelens/\ndist/\n');
      gen.clearAll(ws.root);
      assert.equal(file('.gitignore'), 'node_modules/\ndist/\n');
    });

    it('removes the folders it emptied', () => {
      gen.generateAll(ws.root, stats(), ALL_IDES);
      gen.clearAll(ws.root);
      assert.deepEqual(fs.readdirSync(ws.root), []);
    });

    it('is safe to call on a workspace CodeLens never touched', () => {
      ws.write('README.md', 'hi');
      ws.write('.gitignore', 'dist/\n');
      assert.doesNotThrow(() => gen.clearAll(ws.root));
      assert.deepEqual(tree(), ['.gitignore', 'README.md']);
      assert.equal(file('.gitignore'), 'dist/\n');
    });
  });
});
