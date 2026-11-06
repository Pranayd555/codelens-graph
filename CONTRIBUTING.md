# Contributing to CodeLens Graph

Thanks for helping! CodeLens Graph is a VS Code extension plus a standalone MCP server that builds a code graph AI agents can query. This guide covers setup, how issues and pull requests work, how the changelog is kept, and how releases happen.

## Branches

- **`dev`** is the default branch. All pull requests target `dev`.
- **`main`** holds released code only. It changes through a release pull request from `dev` (maintainers).
- `dev` is protected: a pull request can only merge when all required checks pass (tests on Ubuntu, Windows and macOS, coverage, packaging).

## Setup

You need [Node.js 22](https://nodejs.org) or later and VS Code.

```bash
git clone https://github.com/Pranayd555/codelens-graph.git
cd codelens-graph
npm ci
npm run compile          # build into dist/
```

Press **F5** in VS Code to launch an Extension Development Host with your build. A development build never touches your real agent configs or the `~/.codelens/mcp.js` launcher.

## Tests

```bash
npm test                 # all tests (about a minute)
npm run test:coverage    # with a per-file coverage table
npx tsc --noEmit         # type check
```

Run a single area while you work, e.g. `node --require ts-node/register --test "test/parser/**/*.test.ts"`. [`test/README.md`](test/README.md) explains the layout and conventions. In short:

- Every change comes with tests. CI runs them on **Windows, Linux and macOS**, so use `path.join` and guard platform-specific expectations.
- Tests never touch your real home directory; code that reads `os.homedir()` gets a temp "fake home".
- **Known bugs are `todo` tests**: a test for the correct behaviour, marked `it('…', { todo: 'BUG #21: …' }, …)`. It runs and fails without failing the suite, and the number is the issue that tracks it.

## Picking up an issue

1. Start from the pinned [tracking issue (#50)](https://github.com/Pranayd555/codelens-graph/issues/50), or browse by label:
   - [`good first issue`](https://github.com/Pranayd555/codelens-graph/labels/good%20first%20issue): small and self-contained.
   - [`help wanted`](https://github.com/Pranayd555/codelens-graph/labels/help%20wanted): bigger pieces of work.
   - `area:parser`, `area:graph`, `area:context`, `area:mcp`, `area:ingestion`, `area:ui`, `area:tests`: which part of the code.
   - `priority:high`, `priority:medium`, `priority:low`: how much it matters to users.
2. Comment on the issue that you're taking it, so two people don't work on the same thing.
3. For anything bigger than a bug fix, describe your approach in the issue first and wait for a maintainer to agree. It saves rework.

Most bug issues include a **Reproduce** command that runs the `todo` test showing the bug. The issue is done when that test passes and you've removed its `todo` option, so it guards the fix from then on.

If you change what the parser stores for unchanged files (new symbols, scope rules, …), bump `PARSER_VERSION` in `src/ingestion/astParser.ts`, so existing users' indexes are re-parsed once after they update.

## Making a change

1. Branch from `dev`: `fix/<short-name>` or `feat/<short-name>`.
2. Keep pull requests small and focused on one issue.
3. Add or update tests, and run `npm test` and `npx tsc --noEmit`.
4. Update the changelog (see below).
5. Open the pull request against `dev`, fill in the template, and write `Fixes #<issue>` so the issue closes when it merges.

CI must pass on all three operating systems before review. Each pull request's CI run also builds a VSIX you can download from the run's **Artifacts** to try the change in VS Code. Maintainers squash-merge contributor pull requests, so you don't need to tidy your commit history.

## Changelog

[`changelog.md`](changelog.md) is the release notes users see on the Marketplace, so it's kept up to date with every change rather than written at release time.

- **Every pull request that changes the shipped extension adds a line under `## [Unreleased]`**, in the right group (`### Added`, `### Fixed`, `### Changed`, `### Security`, `### Removed`). "Shipped" means `src/`, `esbuild.js`, `.vscodeignore`, or `package.json` fields that reach users (`dependencies`, `contributes`, `engines`, …).
- Write it **as a user would notice it**: what was wrong or what's new, not which function changed. Mention the issue, e.g. `(#30)`.
- The **Changelog** check enforces this on pull requests. For changes users won't notice (refactors, comments, test-only changes inside `src/`), a maintainer can add the `skip-changelog` label. Dependabot pull requests are skipped automatically.
- Don't change the version or add a version heading; that happens at release time.

## Code style

Match the surrounding code: comment density, naming and idioms. Comments explain *why*, not *what*. Avoid new runtime dependencies: everything ships bundled in `dist/`, so talk to a maintainer first if you need one.

## Releases (maintainers)

1. On `dev`, prepare the release:
   ```bash
   npm run release:prepare -- 0.4.0
   ```
   This turns `## [Unreleased]` into `## [0.4.0] - <today>` with a new, empty Unreleased section above it, and sets the version in `package.json`, `package-lock.json` and the README. Read the notes through, then commit `Release 0.4.0` (through a pull request into `dev`, like any change).
2. Open a pull request from `dev` to `main`. Its **Changelog** check verifies that the version was bumped, that the changelog has notes for it, and that nothing is left under Unreleased. Merge it with a merge commit once CI is green.
3. Tag the merge commit on `main`:
   ```bash
   git checkout main && git pull
   git tag v0.4.0 && git push origin v0.4.0
   ```
4. The **Release** workflow checks that the tag matches `package.json` and is on `main`, runs the tests, packages and checks the VSIX, publishes to the VS Code Marketplace and Open VSX with trusted publishing (no stored tokens), and creates a GitHub Release whose notes are that version's changelog section.
5. Fast-forward `dev` to `main`, so the release merge commit isn't counted as "behind".

## Reporting bugs and security issues

Use the issue forms for bugs and feature requests. Please report security problems privately; see [SECURITY.md](SECURITY.md).

By participating you agree to follow our [Code of Conduct](CODE_OF_CONDUCT.md).
