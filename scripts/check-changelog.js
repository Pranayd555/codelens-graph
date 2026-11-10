#!/usr/bin/env node
// Changelog check for pull requests (run by CI).
// - Into main (a release): package.json's version must be newer than main's,
//   changelog.md must have a non-empty section for it, and the Unreleased
//   section must be empty (its notes moved into the release).
// - Into any other branch: a change to the shipped code (src/, esbuild.js,
//   .vscodeignore, or package.json fields such as dependencies and
//   contributes) must add notes under `## [Unreleased]`.
//   Skipped for Dependabot, or with the `skip-changelog` label.
// Environment: BASE_REF (target branch), PR_AUTHOR, PR_LABELS (comma-separated).
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..');
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
const base = process.env.BASE_REF;
const labels = (process.env.PR_LABELS || '').split(',').map(s => s.trim()).filter(Boolean);
if (!base) { console.error('BASE_REF is not set'); process.exit(2); }

const changelog = fs.readFileSync(path.join(root, 'changelog.md'), 'utf8').replace(/\r\n/g, '\n');
function section(name) {
  const start = changelog.indexOf(`## [${name}]`);
  if (start < 0) { return null; }
  const bodyStart = changelog.indexOf('\n', start) + 1;
  const next = changelog.slice(bodyStart).search(/^## \[/m);
  return changelog.slice(bodyStart, next < 0 ? undefined : bodyStart + next).replace(/\n---\s*$/, '').trim();
}
const problems = [];

if (base === 'main') {
  const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
  const mainVersion = JSON.parse(git('show', 'origin/main:package.json')).version;
  if (version === mainVersion) {
    problems.push(`package.json still says ${version}, the version already on main. Run \`npm run release:prepare -- <next version>\` on dev first.`);
  }
  const notes = section(version);
  if (!notes) { problems.push(`changelog.md has no notes under "## [${version}]".`); }
  if (section('Unreleased')) {
    problems.push('changelog.md still has notes under "## [Unreleased]". They should be part of the release section.');
  }
  if (!problems.length) { console.log(`Release ${mainVersion} → ${version}: changelog section found.`); }
} else if (process.env.PR_AUTHOR === 'dependabot[bot]' || labels.includes('skip-changelog')) {
  console.log('Changelog check skipped (Dependabot or skip-changelog label).');
} else {
  // Compare with where the pull request started, not the base branch's tip:
  // when the base moves on (e.g. a release empties Unreleased), a run against
  // the older merge would otherwise see the difference as the PR's own notes.
  const forkPoint = git('merge-base', `origin/${base}`, 'HEAD').trim();
  const changed = git('diff', '--name-only', `${forkPoint}...HEAD`).split('\n').filter(Boolean);
  // package.json counts only when a field that reaches users changes; scripts
  // and devDependencies don't.
  const SHIPPED_FIELDS = ['dependencies', 'contributes', 'engines', 'main', 'activationEvents', 'capabilities', 'bin', 'extensionDependencies'];
  const manifestShips = () => {
    try {
      const before = JSON.parse(git('show', `${forkPoint}:package.json`));
      const after = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
      return SHIPPED_FIELDS.some(k => JSON.stringify(before[k]) !== JSON.stringify(after[k]));
    } catch {
      return true;
    }
  };
  const shipped = changed.filter(f => /^(src\/|esbuild\.js$|\.vscodeignore$)/.test(f) || (f === 'package.json' && manifestShips()));
  if (shipped.length) {
    const before = git('show', `${forkPoint}:changelog.md`).replace(/\r\n/g, '\n');
    const unreleasedBefore = (() => {
      const start = before.indexOf('## [Unreleased]');
      if (start < 0) { return ''; }
      const bodyStart = before.indexOf('\n', start) + 1;
      const next = before.slice(bodyStart).search(/^## \[/m);
      return before.slice(bodyStart, next < 0 ? undefined : bodyStart + next).replace(/\n---\s*$/, '').trim();
    })();
    const unreleased = section('Unreleased') || '';
    if (unreleased === unreleasedBefore) {
      problems.push(
        `This pull request changes shipped code (${shipped.slice(0, 3).join(', ')}${shipped.length > 3 ? ', …' : ''}) but adds nothing under "## [Unreleased]" in changelog.md.\n`
        + 'Add a line describing the change as a user would notice it, or add the `skip-changelog` label for changes users won\'t notice (refactors, comments).'
      );
    } else {
      console.log('Changelog updated under "## [Unreleased]".');
    }
  } else {
    console.log('No shipped code changed; no changelog entry needed.');
  }
}

if (problems.length) {
  for (const p of problems) { console.error(`::error::${p.replace(/\n/g, '%0A')}`); }
  process.exit(1);
}
