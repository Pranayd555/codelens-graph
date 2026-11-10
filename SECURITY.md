# Security policy

## Reporting a vulnerability

Please **don't open a public issue** for security problems. Report them privately through GitHub: [**Report a vulnerability**](https://github.com/Pranayd555/codelens-graph/security/advisories/new) (Security tab → Advisories).

Include what an attacker could do, the steps to reproduce, and the CodeLens Graph version. You'll get an answer within a few days; we'll agree on a fix and a disclosure date with you, and credit you in the release notes if you'd like.

## Supported versions

Security fixes go into the latest release. Please update to it before reporting.

## What's in scope

CodeLens Graph reads the workspace you open and serves it to AI agents through an MCP server, so these are especially relevant:

- The MCP server reading or writing files **outside the workspace** (directly, through `..` paths, symlinks, or a tampered `.codelens/codelens-graph.db`).
- Agent-controlled tool arguments (e.g. `workspace`) reaching directories CodeLens doesn't manage.
- Regex or search input that can hang the server.
- Script injection into the graph or stats webviews through symbol names, paths or file contents.
- CodeLens changing files it shouldn't (agent configs, instruction files, `.gitignore`) or losing user content in them.
