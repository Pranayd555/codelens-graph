import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const SCRIPTS = path.join(__dirname, '..', '..', 'scripts');

// A throwaway git repo with the release scripts and a minimal project, where
// "origin/<base>" is the state a pull request is compared against.
class Repo {
  readonly root = fs.mkdtempSync(path.join(os.tmpdir(), 'codelens-release-'));

  constructor() {
    fs.cpSync(SCRIPTS, path.join(this.root, 'scripts'), { recursive: true });
    this.write('package.json', '{\n  "name": "codelens-graph",\n  "version": "0.3.1",\n  "main": "./dist/extension.js"\n}\n');
    this.write('package-lock.json', JSON.stringify({ name: 'codelens-graph', version: '0.3.1', lockfileVersion: 3, packages: { '': { name: 'codelens-graph', version: '0.3.1' } } }, null, 2) + '\n');
    this.write('README.md', 'code --install-extension codelens-graph-0.3.1.vsix\n');
    this.write('changelog.md', '# Changelog\n\n---\n\n## [Unreleased]\n\n---\n\n## [0.3.1] - 2026-10-06\n\n### Changed\n- Old notes.\n\n---\n');
    this.write('src/a.ts', 'export const a = 1;\n');
    this.git('init', '-q', '-b', 'dev');
    this.commit('initial');
    this.git('update-ref', 'refs/remotes/origin/main', 'HEAD');
    this.git('update-ref', 'refs/remotes/origin/dev', 'HEAD');
  }

  write(rel: string, text: string): void {
    const file = path.join(this.root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  }
  read(rel: string): string { return fs.readFileSync(path.join(this.root, rel), 'utf8'); }
  git(...args: string[]): string {
    return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd: this.root, encoding: 'utf8' });
  }
  commit(message: string): void { this.git('add', '-A'); this.git('commit', '-q', '-m', message); }

  run(script: string, args: string[] = [], env: Record<string, string> = {}) {
    const res = spawnSync(process.execPath, [path.join(this.root, 'scripts', script), ...args], {
      cwd: this.root, encoding: 'utf8', env: { ...process.env, ...env },
    });
    return { code: res.status, out: res.stdout + res.stderr };
  }
  check(base: string, env: Record<string, string> = {}) {
    return this.run('check-changelog.js', [], { BASE_REF: base, PR_AUTHOR: 'someone', PR_LABELS: '', ...env });
  }
  addUnreleasedNote(note: string): void {
    this.write('changelog.md', this.read('changelog.md').replace('## [Unreleased]\n', `## [Unreleased]\n\n### Fixed\n- ${note}\n`));
  }
  cleanup(): void { fs.rmSync(this.root, { recursive: true, force: true }); }
}

describe('release:prepare', () => {
  let repo: Repo;
  beforeEach(() => { repo = new Repo(); });
  afterEach(() => repo.cleanup());

  it('turns the Unreleased notes into a dated version section and bumps every version', () => {
    repo.addUnreleasedNote('A fix users notice.');
    const res = repo.run('prepare-release.js', ['0.4.0']);
    assert.equal(res.code, 0, res.out);

    const changelog = repo.read('changelog.md');
    assert.match(changelog, /## \[Unreleased\]\n\n---\n\n## \[0\.4\.0\] - \d{4}-\d{2}-\d{2}\n\n### Fixed\n- A fix users notice\.\n\n---\n\n## \[0\.3\.1\]/);
    assert.equal(JSON.parse(repo.read('package.json')).version, '0.4.0');
    assert.ok(repo.read('package.json').startsWith('{\n  "name"'), 'package.json formatting is kept');
    const lock = JSON.parse(repo.read('package-lock.json'));
    assert.deepEqual([lock.version, lock.packages[''].version], ['0.4.0', '0.4.0']);
    assert.equal(repo.read('README.md'), 'code --install-extension codelens-graph-0.4.0.vsix\n');

    const notes = repo.run('release-notes.js', ['0.4.0']);
    assert.equal(notes.out, '### Fixed\n- A fix users notice.\n');
  });

  it('refuses to release when there are no Unreleased notes', () => {
    const res = repo.run('prepare-release.js', ['0.4.0']);
    assert.equal(res.code, 1);
    assert.match(res.out, /Unreleased section of changelog\.md is empty/);
    assert.equal(JSON.parse(repo.read('package.json')).version, '0.3.1', 'nothing changed');
  });

  it('refuses a version that is not newer, or not a version', () => {
    repo.addUnreleasedNote('Something.');
    assert.match(repo.run('prepare-release.js', ['0.3.1']).out, /not newer/);
    assert.match(repo.run('prepare-release.js', ['0.3.0']).out, /not newer/);
    assert.match(repo.run('prepare-release.js', ['next']).out, /Usage/);
  });

  it('keeps CRLF line endings', () => {
    repo.write('changelog.md', repo.read('changelog.md').replace(/\n/g, '\r\n'));
    repo.write('changelog.md', repo.read('changelog.md').replace('## [Unreleased]\r\n', '## [Unreleased]\r\n\r\n- Note.\r\n'));
    assert.equal(repo.run('prepare-release.js', ['0.4.0']).code, 0);
    assert.ok(!/[^\r]\n/.test(repo.read('changelog.md')), 'all line breaks are CRLF');
  });
});

describe('Changelog check for pull requests', () => {
  let repo: Repo;
  beforeEach(() => { repo = new Repo(); });
  afterEach(() => repo.cleanup());

  describe('into dev', () => {
    it('fails when shipped code changes without an Unreleased note', () => {
      repo.write('src/a.ts', 'export const a = 2;\n');
      repo.commit('change');
      const res = repo.check('dev');
      assert.equal(res.code, 1);
      assert.match(res.out, /adds nothing under "## \[Unreleased\]"/);
      assert.match(res.out, /src\/a\.ts/);
    });

    it('passes when the pull request adds an Unreleased note', () => {
      repo.write('src/a.ts', 'export const a = 2;\n');
      repo.addUnreleasedNote('Changed a.');
      repo.commit('change');
      assert.equal(repo.check('dev').code, 0);
    });

    it('passes for changes that do not ship (docs, tests, CI)', () => {
      repo.write('CONTRIBUTING.md', 'Docs.\n');
      repo.write('test/x.test.ts', '// test\n');
      repo.commit('docs');
      const res = repo.check('dev');
      assert.equal(res.code, 0, res.out);
      assert.match(res.out, /No shipped code changed/);
    });

    it('counts package.json only when a field that reaches users changes', () => {
      repo.write('package.json', repo.read('package.json').replace('"main"', '"scripts": { "x": "y" },\n  "devDependencies": { "t": "1" },\n  "main"'));
      repo.commit('scripts and dev deps');
      assert.equal(repo.check('dev').code, 0, 'scripts and devDependencies do not ship');
      repo.write('package.json', repo.read('package.json').replace('"main"', '"dependencies": { "zod": "4" },\n  "main"'));
      repo.commit('runtime dep');
      assert.equal(repo.check('dev').code, 1, 'dependencies ship');
    });

    it('compares with where the branch started, not dev\'s tip, once a release has emptied Unreleased', () => {
      // dev has notes; a contributor branches off and changes code without a note.
      repo.addUnreleasedNote('Earlier fix.');
      repo.commit('notes on dev');
      repo.git('update-ref', 'refs/remotes/origin/dev', 'HEAD');
      repo.git('checkout', '-q', '-b', 'contrib');
      repo.write('src/a.ts', 'export const a = 2;\n');
      repo.commit('change without a note');
      // Meanwhile dev is released: its Unreleased section is now empty.
      repo.git('checkout', '-q', 'dev');
      assert.equal(repo.run('prepare-release.js', ['0.4.0']).code, 0);
      repo.commit('Release 0.4.0');
      repo.git('update-ref', 'refs/remotes/origin/dev', 'HEAD');
      repo.git('checkout', '-q', 'contrib');
      const res = repo.check('dev');
      assert.equal(res.code, 1, res.out);
      assert.match(res.out, /adds nothing under "## \[Unreleased\]"/);
    });

    it('is skipped for Dependabot and for the skip-changelog label', () => {
      repo.write('package.json', repo.read('package.json').replace('"main"', '"dependencies": { "x": "1" },\n  "main"'));
      repo.commit('deps');
      assert.equal(repo.check('dev', { PR_AUTHOR: 'dependabot[bot]' }).code, 0);
      assert.equal(repo.check('dev', { PR_LABELS: 'refactor,skip-changelog' }).code, 0);
      assert.equal(repo.check('dev').code, 1);
    });
  });

  describe('into main (a release)', () => {
    it('fails when the version was not bumped', () => {
      repo.addUnreleasedNote('Something.');
      repo.commit('notes');
      const res = repo.check('main');
      assert.equal(res.code, 1);
      assert.match(res.out, /still says 0\.3\.1/);
      assert.match(res.out, /still has notes under "## \[Unreleased\]"/);
    });

    it('passes after release:prepare', () => {
      repo.addUnreleasedNote('Something.');
      assert.equal(repo.run('prepare-release.js', ['0.4.0']).code, 0);
      repo.commit('Release 0.4.0');
      const res = repo.check('main');
      assert.equal(res.code, 0, res.out);
      assert.match(res.out, /Release 0\.3\.1 → 0\.4\.0/);
    });

    it('fails when the version has no changelog section', () => {
      repo.write('package.json', repo.read('package.json').replace('0.3.1', '0.4.0'));
      repo.commit('bump only');
      assert.match(repo.check('main').out, /no notes under "## \[0\.4\.0\]"/);
    });
  });
});
