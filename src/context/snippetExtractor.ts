import * as fs   from 'fs';
import * as path from 'path';
import { GraphNode } from '../types';
import { isPathInside } from '../utils';
import { detectModuleSystem, formatImport, importSpecifier } from './importHints';

// ─── How many lines of body to include in a snippet ──────────────────────────
// Enough to understand the function without reading the whole file.
const MAX_SNIPPET_LINES = 12;
const MAX_SNIPPET_CHARS = 600; // hard cap — prevents large functions blowing the budget

// ─── SnippetExtractor ─────────────────────────────────────────────────────────
// Reads the actual source lines for a node from disk.
// Called at context-build time, NOT at parse time — keeps the DB lean.

export class SnippetExtractor {

  // Node paths come from the graph DB, which a cloned repo could ship pre-built,
  // so only files inside the workspace root are ever read.
  constructor(private getWorkspaceRoot: () => string | null) {}

  private canRead(filePath: string): boolean {
    const root = this.getWorkspaceRoot();
    return root !== null && isPathInside(filePath, root);
  }

  // Returns the signature line + up to MAX_SNIPPET_LINES of body.
  // Truncates gracefully if the function is large.
  extractSnippet(node: GraphNode): string | null {
    if (node.type === 'file' || node.type === 'import') { return null; }
    if (!this.canRead(node.filePath)) { return null; }

    try {
      const lines = fs.readFileSync(node.filePath, 'utf-8').split('\n');
      const start = Math.max(0, node.line - 1);           // line is 1-based
      const end   = Math.min(
        lines.length,
        node.endLine > node.line
          ? Math.min(node.endLine, start + MAX_SNIPPET_LINES)
          : start + MAX_SNIPPET_LINES
      );

      const snippet = lines.slice(start, end).join('\n');

      // Hard char cap — truncate with marker
      if (snippet.length > MAX_SNIPPET_CHARS) {
        return snippet.slice(0, MAX_SNIPPET_CHARS) + '\n  // … (truncated)';
      }

      return snippet;
    } catch {
      return null; // file deleted or unreadable
    }
  }

  // Returns just the signature line — cheapest option, ~1 token
  extractSignatureLine(node: GraphNode): string | null {
    if (!this.canRead(node.filePath)) { return null; }
    try {
      const lines  = fs.readFileSync(node.filePath, 'utf-8').split('\n');
      const lineNo = Math.max(0, node.line - 1);
      return lines[lineNo]?.trimEnd() ?? null;
    } catch {
      return null;
    }
  }

  // Returns the import path of a symbol relative to a consumer file.
  // e.g. given node at backend/utils/emailService.js and consumer at backend/routes/auth.js
  // returns  "../utils/emailService"
  resolveImportPath(node: GraphNode, fromFilePath: string): string {
    return importSpecifier(node.filePath, path.dirname(fromFilePath));
  }

  // How fromFilePath (written in `language`) would import node — ready to
  // paste, in that file's module system. Null when there's no useful hint.
  buildImportStatement(node: GraphNode, fromFilePath: string, language: string): string | null {
    const system = detectModuleSystem(fromFilePath, this.getWorkspaceRoot());
    return formatImport(node, this.resolveImportPath(node, fromFilePath), language, system);
  }

  // How code in the workspace imports node, with the path relative to the
  // workspace root (no importing file is known) and the module system of the
  // file that defines it.
  buildWorkspaceImportStatement(node: GraphNode): string | null {
    const root = this.getWorkspaceRoot();
    if (!root || node.type === 'file' || node.type === 'import') { return null; }
    const system = detectModuleSystem(node.filePath, root);
    return formatImport(node, importSpecifier(node.filePath, root), node.language, system);
  }
}
