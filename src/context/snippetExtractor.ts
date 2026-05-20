import * as fs   from 'fs';
import * as path from 'path';
import { GraphNode } from '../types';

// ─── How many lines of body to include in a snippet ──────────────────────────
// Enough to understand the function without reading the whole file.
const MAX_SNIPPET_LINES = 12;
const MAX_SNIPPET_CHARS = 600; // hard cap — prevents large functions blowing the budget

// ─── SnippetExtractor ─────────────────────────────────────────────────────────
// Reads the actual source lines for a node from disk.
// Called at context-build time, NOT at parse time — keeps the DB lean.

export class SnippetExtractor {

  // Returns the signature line + up to MAX_SNIPPET_LINES of body.
  // Truncates gracefully if the function is large.
  extractSnippet(node: GraphNode): string | null {
    if (node.type === 'file' || node.type === 'import') { return null; }

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
    const fromDir    = path.dirname(fromFilePath);
    const toFile     = node.filePath;
    let   rel        = path.relative(fromDir, toFile).replace(/\\/g, '/');

    // Strip known extensions so the import looks clean
    rel = rel.replace(/\.(ts|tsx|js|jsx|mjs|cjs)$/, '');

    // Ensure it starts with ./
    if (!rel.startsWith('.')) { rel = './' + rel; }
    return rel;
  }

  // Given a node, returns how to import it — ready to paste
  buildImportStatement(node: GraphNode, fromFilePath: string, language: string): string {
    const importPath = this.resolveImportPath(node, fromFilePath);
    const name       = node.name;

    if (language === 'typescript' || language === 'javascript') {
      const isDefault = node.modifiers?.includes('default');
      return isDefault
        ? `import ${name} from '${importPath}';`
        : `import { ${name} } from '${importPath}';`;
    }

    if (language === 'python') {
      const parts = importPath.replace(/^\.\//, '').replace(/\//g, '.');
      return `from ${parts} import ${name}`;
    }

    return `// import ${name} from '${importPath}'`;
  }
}
