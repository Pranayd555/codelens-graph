# Contributing to CodeLens Graph

Thanks for helping! CodeLens Graph is a VS Code extension plus a standalone MCP server that builds a code graph AI agents can query. This guide covers setup, the workflow for issues and pull requests, and how releases happen.

## Branches

- **`dev`** is the default branch. All pull requests target `dev`.
- **`main`** holds released code only. It changes through a release PR from `dev` (maintainers).

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
- **Known bugs are `todo` tests**: a test for the correct behaviour, marked `it('…', { todo: 'BUG: …' }, …)`. Many issues point at one. Fixing the bug means making that test pass and **removing its `todo` option**.

## Picking up an issue

1. Look for issues labelled [`good first issue`](https://github.com/Pranayd555/codelens-graph/labels/good%20first%20issue) or [`help wanted`](https://github.com/Pranayd555/codelens-graph/labels/help%20wanted).
2. Comment on the issue that you're taking it, so two people don't work on the same thing.
3. For anything bigger than a bug fix, describe your approach in the issue first and wait for a maintainer to agree — it saves rework.

## Making a change

1. Branch from `dev`: `fix/<short-name>` or `feat/<short-name>`.
2. Keep pull requests small and focused on one issue.
3. Add or update tests, and run `npm test` and `npx tsc --noEmit`.
4. Add a line under `## [Unreleased]` in [`changelog.md`](changelog.md) describing the change **as a user would notice it**.
5. Open the PR against `dev`, fill in the template, and write `Fixes #<issue>` so the issue closes when it merges.

CI must pass on all three operating systems before review. Each PR's CI run also builds a VSIX you can download from the run's **Artifacts** to try the change in VS Code. Maintainers squash-merge contributor PRs, so you don't need to tidy your commit history.

## Code style

Match the surrounding code: comment density, naming and idioms. Comments explain *why*, not *what*. Avoid new runtime dependencies — everything ships bundled in `dist/`; talk to a maintainer first if you need one.

## Releases (maintainers)

1. Bump `version` in `package.json` (and `package-lock.json`), and turn `## [Unreleased]` in `changelog.md` into `## [x.y.z] - YYYY-MM-DD`.
2. Open a PR from `dev` to `main` and merge it once CI is green.
3. Tag the merge commit on `main` and push the tag:
   ```bash
   git checkout main && git pull
   git tag vX.Y.Z && git push origin vX.Y.Z
   ```
4. The **Release** workflow checks that the tag matches `package.json`, runs the tests, packages and checks the VSIX, publishes it to the VS Code Marketplace and Open VSX, and creates a GitHub Release with the changelog section as notes.
5. Fast-forward `dev` to `main` afterwards so the release merge commit isn't counted as "behind".

## Reporting bugs and security issues

Use the issue forms for bugs and feature requests. Please report security problems privately — see [SECURITY.md](SECURITY.md).

By participating you agree to follow our [Code of Conduct](CODE_OF_CONDUCT.md).
