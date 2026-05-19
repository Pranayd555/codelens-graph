import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { GraphNode, GraphEdge, ParsedFile, Param, NodeType } from '../types';

// ─── Language config ───────────────────────────────────────────────────────────
// Maps file extension → tree-sitter language name + grammar WASM file.
// Grammar WASM files are downloaded via the grammars/download.js script.

interface LangConfig {
  language: string;
  wasmFile: string;   // relative to grammars/ directory
}

const EXTENSION_MAP: Record<string, LangConfig> = {
  '.ts':   { language: 'typescript', wasmFile: 'tree-sitter-typescript.wasm' },
  '.tsx':  { language: 'typescript', wasmFile: 'tree-sitter-typescript.wasm' },
  '.js':   { language: 'javascript', wasmFile: 'tree-sitter-javascript.wasm' },
  '.jsx':  { language: 'javascript', wasmFile: 'tree-sitter-javascript.wasm' },
  '.py':   { language: 'python',     wasmFile: 'tree-sitter-python.wasm'     },
  '.go':   { language: 'go',         wasmFile: 'tree-sitter-go.wasm'         },
  '.rs':   { language: 'rust',       wasmFile: 'tree-sitter-rust.wasm'       },
  '.java': { language: 'java',       wasmFile: 'tree-sitter-java.wasm'       },
  '.cs':   { language: 'c_sharp',    wasmFile: 'tree-sitter-c_sharp.wasm'    },
  '.cpp':  { language: 'cpp',        wasmFile: 'tree-sitter-cpp.wasm'        },
  '.c':    { language: 'c',          wasmFile: 'tree-sitter-c.wasm'          },
  '.rb':   { language: 'ruby',       wasmFile: 'tree-sitter-ruby.wasm'       },
  '.php':  { language: 'php',        wasmFile: 'tree-sitter-php.wasm'        },
};

// ─── Node ID helpers ───────────────────────────────────────────────────────────

export function makeNodeId(filePath: string, name: string, line: number): string {
  // Stable, unique ID for a symbol. Uses relative path for portability.
  return `${filePath}::${name}::${line}`;
}

export function makeEdgeId(fromId: string, type: string, toId: string): string {
  return `${fromId}--${type}-->${toId}`;
}

function contentHash(content: string): string {
  return crypto.createHash('sha1').update(content).digest('hex').slice(0, 12);
}

// ─── Regex-based fallback parser ──────────────────────────────────────────────
// When tree-sitter WASM files are not yet downloaded, we fall back to regex.
// This covers the most common symbols well enough for early development.

class RegexParser {

  parse(filePath: string, content: string, language: string): ParsedFile {
    const lines = content.split('\n');
    const nodes: GraphNode[] = [];
    const edges: GraphEdge[] = [];
    const now = Date.now();
    const hash = contentHash(content);

    // File node
    const fileNode: GraphNode = {
      id: makeNodeId(filePath, '__file__', 0),
      type: 'file',
      name: path.basename(filePath),
      filePath,
      line: 0,
      endLine: lines.length,
      language,
      size: Buffer.byteLength(content),
      lastModified: fs.statSync(filePath).mtimeMs,
      hash,
      updatedAt: now,
    };
    nodes.push(fileNode);

    // Language-specific patterns
    const patterns = this.getPatterns(language);

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lineNo = i + 1;

      for (const pattern of patterns) {
        const match = pattern.regex.exec(line);
        if (!match) { continue; }

        const name = match[pattern.nameGroup];
        if (!name || name.trim() === '') { continue; }

        // Collect doc comment from preceding lines
        const docComment = this.extractDocComment(lines, i);

        // Extract modifiers from the line
        const modifiers = this.extractModifiers(line, language);

        // Extract params for functions/methods
        const params = pattern.hasParams
          ? this.extractParams(match[pattern.paramsGroup ?? 0] ?? '')
          : undefined;

        // Find end line (rough: scan for matching brace or indent)
        const endLine = this.findEndLine(lines, i, language);

        const node: GraphNode = {
          id: makeNodeId(filePath, name, lineNo),
          type: pattern.nodeType,
          name,
          filePath,
          line: lineNo,
          endLine,
          language,
          signature: line.trim().slice(0, 200),
          returnType: pattern.returnGroup ? match[pattern.returnGroup]?.trim() : undefined,
          params,
          modifiers,
          docComment,
          hash: contentHash(line),
          updatedAt: now,
        };

        nodes.push(node);

        // file --contains--> symbol
        edges.push({
          id: makeEdgeId(fileNode.id, 'contains', node.id),
          fromId: fileNode.id,
          toId: node.id,
          type: 'contains',
        });
      }
    }

    // Extract import edges
    const importEdges = this.extractImports(filePath, content, language, fileNode.id, now);
    nodes.push(...importEdges.nodes);
    edges.push(...importEdges.edges);

    // Extract call relationships (basic)
    const callEdges = this.extractCalls(nodes, content, filePath);
    edges.push(...callEdges);

    return { filePath, language, nodes, edges, parseErrors: [] };
  }

  // ── Patterns per language ──────────────────────────────────────────────────

  private getPatterns(language: string): Array<{
    regex: RegExp;
    nodeType: NodeType;
    nameGroup: number;
    hasParams: boolean;
    paramsGroup?: number;
    returnGroup?: number;
  }> {
    switch (language) {
      case 'typescript':
      case 'javascript':
        return [
          // class Foo / export class Foo extends Bar
          { regex: /(?:export\s+)?(?:abstract\s+)?class\s+(\w+)/, nodeType: 'class', nameGroup: 1, hasParams: false },
          // interface Foo
          { regex: /(?:export\s+)?interface\s+(\w+)/, nodeType: 'interface', nameGroup: 1, hasParams: false },
          // type Foo =
          { regex: /(?:export\s+)?type\s+(\w+)\s*=/, nodeType: 'type', nameGroup: 1, hasParams: false },
          // enum Foo
          { regex: /(?:export\s+)?enum\s+(\w+)/, nodeType: 'enum', nameGroup: 1, hasParams: false },
          // function foo(params): ReturnType
          { regex: /(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\(([^)]*)\)\s*(?::\s*([\w<>[\]|&\s]+))?/, nodeType: 'function', nameGroup: 1, hasParams: true, paramsGroup: 2, returnGroup: 3 },
          // const foo = (params) => / const foo = async (params) =>
          { regex: /(?:export\s+)?const\s+(\w+)\s*=\s*(?:async\s+)?\(([^)]*)\)\s*(?::\s*([\w<>[\]|&\s]+))?\s*=>/, nodeType: 'function', nameGroup: 1, hasParams: true, paramsGroup: 2, returnGroup: 3 },
          // const foo = function
          { regex: /(?:export\s+)?const\s+(\w+)\s*=\s*(?:async\s+)?function/, nodeType: 'function', nameGroup: 1, hasParams: false },
          // method inside class: foo(params): ReturnType { / async foo(
          { regex: /^\s+(?:public\s+|private\s+|protected\s+|static\s+|async\s+|override\s+)*(\w+)\s*\(([^)]*)\)\s*(?::\s*([\w<>[\]|&\s]+))?/, nodeType: 'method', nameGroup: 1, hasParams: true, paramsGroup: 2, returnGroup: 3 },
          // const/let/var at module level
          { regex: /^(?:export\s+)?(?:const|let|var)\s+(\w+)\s*(?::\s*([\w<>[\]|&\s]+))?\s*=/, nodeType: 'variable', nameGroup: 1, hasParams: false },
        ];

      case 'python':
        return [
          // class Foo(Base):
          { regex: /^class\s+(\w+)/, nodeType: 'class', nameGroup: 1, hasParams: false },
          // def foo(params):
          { regex: /^def\s+(\w+)\s*\(([^)]*)\)/, nodeType: 'function', nameGroup: 1, hasParams: true, paramsGroup: 2 },
          // method (indented def)
          { regex: /^\s+def\s+(\w+)\s*\(([^)]*)\)/, nodeType: 'method', nameGroup: 1, hasParams: true, paramsGroup: 2 },
          // module-level variable
          { regex: /^(\w+)\s*=\s*/, nodeType: 'variable', nameGroup: 1, hasParams: false },
        ];

      case 'go':
        return [
          // type Foo struct
          { regex: /^type\s+(\w+)\s+struct/, nodeType: 'class', nameGroup: 1, hasParams: false },
          // type Foo interface
          { regex: /^type\s+(\w+)\s+interface/, nodeType: 'interface', nameGroup: 1, hasParams: false },
          // func Foo(params) ReturnType
          { regex: /^func\s+(?:\([^)]+\)\s+)?(\w+)\s*\(([^)]*)\)/, nodeType: 'function', nameGroup: 1, hasParams: true, paramsGroup: 2 },
        ];

      case 'rust':
        return [
          { regex: /^(?:pub\s+)?struct\s+(\w+)/,        nodeType: 'class',     nameGroup: 1, hasParams: false },
          { regex: /^(?:pub\s+)?trait\s+(\w+)/,         nodeType: 'interface', nameGroup: 1, hasParams: false },
          { regex: /^(?:pub\s+)?enum\s+(\w+)/,          nodeType: 'enum',      nameGroup: 1, hasParams: false },
          { regex: /^(?:pub\s+)?(?:async\s+)?fn\s+(\w+)\s*\(([^)]*)\)/, nodeType: 'function', nameGroup: 1, hasParams: true, paramsGroup: 2 },
        ];

      default:
        return [
          // Generic: catch function/class-like patterns
          { regex: /(?:function|func|def|fn)\s+(\w+)\s*\(/, nodeType: 'function', nameGroup: 1, hasParams: false },
          { regex: /(?:class|struct|interface)\s+(\w+)/,     nodeType: 'class',    nameGroup: 1, hasParams: false },
        ];
    }
  }

  // ── Import extraction ──────────────────────────────────────────────────────

  private extractImports(
    filePath: string,
    content: string,
    language: string,
    fileNodeId: string,
    now: number
  ): { nodes: GraphNode[]; edges: GraphEdge[] } {
    const nodes: GraphNode[] = [];
    const edges: GraphEdge[] = [];
    const lines = content.split('\n');

    const importPatterns: Record<string, RegExp[]> = {
      typescript: [
        /^import\s+.*from\s+['"]([^'"]+)['"]/,
        /^import\s+['"]([^'"]+)['"]/,
        /require\s*\(\s*['"]([^'"]+)['"]\s*\)/,
      ],
      javascript: [
        /^import\s+.*from\s+['"]([^'"]+)['"]/,
        /require\s*\(\s*['"]([^'"]+)['"]\s*\)/,
      ],
      python: [
        /^import\s+([\w.]+)/,
        /^from\s+([\w.]+)\s+import/,
      ],
      go: [/^\s+"([\w./]+)"/],
      rust: [/^use\s+([\w::]+)/],
    };

    const patterns = importPatterns[language] ?? importPatterns['javascript'];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      for (const pattern of patterns) {
        const match = pattern.exec(line);
        if (!match) { continue; }

        const source = match[1];
        const importNodeId = makeNodeId(filePath, `__import__${source}`, i + 1);

        nodes.push({
          id: importNodeId,
          type: 'import',
          name: source,
          filePath,
          line: i + 1,
          endLine: i + 1,
          language,
          signature: line.trim(),
          updatedAt: now,
        });

        edges.push({
          id: makeEdgeId(fileNodeId, 'imports', importNodeId),
          fromId: fileNodeId,
          toId: importNodeId,
          type: 'imports',
          metadata: { source },
        });
      }
    }

    return { nodes, edges };
  }

  // ── Call extraction ────────────────────────────────────────────────────────
  // Match function body content against known function names to find calls.

  private extractCalls(nodes: GraphNode[], content: string, filePath: string): GraphEdge[] {
    const edges: GraphEdge[] = [];
    const functionNodes = nodes.filter(n => n.type === 'function' || n.type === 'method');

    for (const caller of functionNodes) {
      // Get this function's body (rough: lines between its start and end)
      const bodyLines = content.split('\n').slice(caller.line, caller.endLine);
      const body = bodyLines.join('\n');

      for (const callee of functionNodes) {
        if (callee.id === caller.id) { continue; }
        // Look for callee.name( in the body
        const callPattern = new RegExp(`\\b${callee.name}\\s*\\(`, 'g');
        if (callPattern.test(body)) {
          edges.push({
            id: makeEdgeId(caller.id, 'calls', callee.id),
            fromId: caller.id,
            toId: callee.id,
            type: 'calls',
          });
        }
      }
    }

    return edges;
  }

  // ── Utility helpers ────────────────────────────────────────────────────────

  private extractDocComment(lines: string[], lineIndex: number): string | undefined {
    const docLines: string[] = [];
    let i = lineIndex - 1;

    // Walk backwards collecting comment lines
    while (i >= 0) {
      const l = lines[i].trim();
      if (l.startsWith('//') || l.startsWith('*') || l.startsWith('/*') || l.startsWith('#')) {
        docLines.unshift(l.replace(/^\/\/\s?|^\*\s?|^#\s?|^\/\*\*?\s?/, ''));
        i--;
      } else {
        break;
      }
    }

    return docLines.length > 0 ? docLines.join(' ').trim() : undefined;
  }

  private extractModifiers(line: string, _language: string): string[] {
    const modifiers: string[] = [];
    const keywords = ['export', 'default', 'async', 'public', 'private', 'protected',
                      'static', 'abstract', 'readonly', 'override', 'const', 'let', 'var'];
    for (const kw of keywords) {
      if (new RegExp(`\\b${kw}\\b`).test(line)) { modifiers.push(kw); }
    }
    return modifiers;
  }

  private extractParams(paramsStr: string): Param[] {
    if (!paramsStr.trim()) { return []; }

    return paramsStr.split(',').map(p => {
      p = p.trim();
      if (!p) { return null; }

      const rest = p.startsWith('...');
      if (rest) { p = p.slice(3); }

      // name: type = default
      const [nameType, defaultValue] = p.split('=').map(s => s.trim());
      const [name, type] = nameType.split(':').map(s => s.trim());

      return { name: name || p, type: type?.trim(), defaultValue, rest } as Param;
    }).filter(Boolean) as Param[];
  }

  private findEndLine(lines: string[], startIndex: number, language: string): number {
    // For brace-based languages, count braces
    if (['typescript', 'javascript', 'java', 'go', 'rust', 'cpp', 'c', 'cs'].includes(language)) {
      let depth = 0;
      let foundOpen = false;
      for (let i = startIndex; i < Math.min(startIndex + 200, lines.length); i++) {
        for (const ch of lines[i]) {
          if (ch === '{') { depth++; foundOpen = true; }
          if (ch === '}') { depth--; }
        }
        if (foundOpen && depth === 0) { return i + 1; }
      }
    }

    // For Python: use indentation
    if (language === 'python') {
      const baseIndent = lines[startIndex].match(/^\s*/)?.[0].length ?? 0;
      for (let i = startIndex + 1; i < lines.length; i++) {
        const l = lines[i];
        if (l.trim() === '') { continue; }
        const indent = l.match(/^\s*/)?.[0].length ?? 0;
        if (indent <= baseIndent) { return i; }
      }
    }

    return Math.min(startIndex + 50, lines.length);
  }
}

// ─── ASTParser (public API) ───────────────────────────────────────────────────

export class ASTParser {
  private regexParser = new RegexParser();
  // tree-sitter parsers would go here once WASM files are loaded
  // private treeSitterParsers: Map<string, Parser> = new Map();

  getSupportedExtensions(): string[] {
    return Object.keys(EXTENSION_MAP);
  }

  getLanguageForFile(filePath: string): string | null {
    const ext = path.extname(filePath).toLowerCase();
    return EXTENSION_MAP[ext]?.language ?? null;
  }

  canParse(filePath: string): boolean {
    return this.getLanguageForFile(filePath) !== null;
  }

  // ── Main parse entry point ───────────────────────────────────────────────

  parseFile(filePath: string): ParsedFile {
    const language = this.getLanguageForFile(filePath);
    if (!language) {
      return { filePath, language: 'unknown', nodes: [], edges: [], parseErrors: [`Unsupported file: ${filePath}`] };
    }

    let content: string;
    try {
      content = fs.readFileSync(filePath, 'utf-8');
    } catch (err) {
      return { filePath, language, nodes: [], edges: [], parseErrors: [`Cannot read file: ${err}`] };
    }

    // Skip empty or very large files (>500KB)
    if (!content.trim() || content.length > 500_000) {
      return { filePath, language, nodes: [], edges: [], parseErrors: [] };
    }

    try {
      // Use regex parser (swap in tree-sitter parser here once WASM files present)
      return this.regexParser.parse(filePath, content, language);
    } catch (err) {
      return { filePath, language, nodes: [], edges: [], parseErrors: [`Parse error: ${err}`] };
    }
  }

  // Parse multiple files and merge results
  parseFiles(filePaths: string[]): ParsedFile[] {
    return filePaths.map(fp => this.parseFile(fp));
  }
}
