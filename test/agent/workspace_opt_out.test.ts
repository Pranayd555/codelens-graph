import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { setWorkspaceDisabled, findDisabledWorkspace } from '../../src/workspaceOptOut';
import { FakeHome, read } from './sandbox';

describe('workspace opt-out list (~/.codelens/disabled-workspaces.json)', () => {
  let home: FakeHome;
  let projects: string;
  let optOutFile: string;

  beforeEach(() => {
    home = new FakeHome();
    projects = fs.mkdtempSync(path.join(os.tmpdir(), 'codelens-optout-'));
    optOutFile = home.path('.codelens/disabled-workspaces.json');
  });
  afterEach(() => {
    home.restore();
    fs.rmSync(projects, { recursive: true, force: true });
  });

  const project = (name: string) => path.join(projects, name);
  const stored = () => JSON.parse(read(optOutFile)).workspaces as string[];

  it('turning a workspace off records it in the per-user file, never inside the project', () => {
    const root = project('app');
    fs.mkdirSync(root);
    setWorkspaceDisabled(root, true);

    assert.deepEqual(stored(), [path.resolve(root)]);
    assert.deepEqual(fs.readdirSync(root), []);
    assert.equal(findDisabledWorkspace(root), path.resolve(root));
  });

  it('finds the turned-off workspace from any folder nested inside it', () => {
    const root = project('app');
    setWorkspaceDisabled(root, true);

    assert.equal(findDisabledWorkspace(path.join(root, 'src', 'deep', 'dir')), path.resolve(root));
    assert.equal(findDisabledWorkspace(root + path.sep), path.resolve(root));
  });

  it('does not match sibling folders that only share a name prefix, or parents', () => {
    setWorkspaceDisabled(project('app'), true);

    assert.equal(findDisabledWorkspace(project('app-two')), undefined);
    assert.equal(findDisabledWorkspace(path.join(project('application'), 'src')), undefined);
    assert.equal(findDisabledWorkspace(projects), undefined);
  });

  it('turning it back on removes the entry and keeps the others', () => {
    setWorkspaceDisabled(project('a'), true);
    setWorkspaceDisabled(project('b'), true);
    setWorkspaceDisabled(project('a'), false);

    assert.deepEqual(stored(), [path.resolve(project('b'))]);
    assert.equal(findDisabledWorkspace(project('a')), undefined);
    assert.equal(findDisabledWorkspace(project('b')), path.resolve(project('b')));
  });

  it('turning the same workspace off twice keeps a single entry', () => {
    setWorkspaceDisabled(project('a'), true);
    setWorkspaceDisabled(path.join(project('a'), 'sub', '..'), true);
    assert.deepEqual(stored(), [path.resolve(project('a'))]);
  });

  it('turning a workspace on does not create the file when nothing was ever turned off', () => {
    setWorkspaceDisabled(project('a'), false);
    assert.equal(fs.existsSync(optOutFile), false);
    assert.equal(fs.existsSync(home.path('.codelens')), false);
    assert.equal(findDisabledWorkspace(project('a')), undefined);
  });

  it('matches paths case-insensitively on Windows', { skip: process.platform !== 'win32' && 'Windows-only path semantics' }, () => {
    const root = project('MyApp');
    setWorkspaceDisabled(root, true);

    assert.equal(findDisabledWorkspace(project('myapp').toUpperCase()), path.resolve(root));
    assert.equal(findDisabledWorkspace(path.join(project('MYAPP'), 'Src')), path.resolve(root));

    setWorkspaceDisabled(project('myapp'), false);
    assert.deepEqual(stored(), []);
  });

  it('matches paths case-sensitively elsewhere', { skip: process.platform === 'win32' && 'POSIX-only path semantics' }, () => {
    setWorkspaceDisabled(project('MyApp'), true);
    assert.equal(findDisabledWorkspace(project('myapp')), undefined);
  });

  it('treats a corrupt file as an empty list and repairs it on the next change', () => {
    home.write('.codelens/disabled-workspaces.json', '{ not json');
    assert.equal(findDisabledWorkspace(project('a')), undefined);

    setWorkspaceDisabled(project('a'), true);
    assert.deepEqual(stored(), [path.resolve(project('a'))]);
  });

  it('ignores a file with the wrong shape or non-string entries', () => {
    home.write('.codelens/disabled-workspaces.json', JSON.stringify({ workspaces: 'nope' }));
    assert.equal(findDisabledWorkspace(project('a')), undefined);

    home.write('.codelens/disabled-workspaces.json',
      JSON.stringify({ workspaces: [42, null, { p: 1 }, path.resolve(project('a'))] }));
    assert.equal(findDisabledWorkspace(project('a')), path.resolve(project('a')));

    // Rewriting drops the junk entries.
    setWorkspaceDisabled(project('b'), true);
    assert.deepEqual(stored(), [path.resolve(project('a')), path.resolve(project('b'))]);
  });

  it('logs instead of throwing when the file cannot be written', () => {
    // A directory where the file should be makes the write fail.
    fs.mkdirSync(optOutFile, { recursive: true });
    const errors: unknown[][] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => { errors.push(args); };
    try {
      assert.doesNotThrow(() => setWorkspaceDisabled(project('a'), true));
    } finally {
      console.error = original;
    }
    assert.equal(errors.length, 1);
    assert.match(String(errors[0][0]), /Failed to record the workspace on\/off choice/);
  });
});
