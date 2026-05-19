import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { GraphNode, GraphEdge, ParsedFile, Param, NodeType } from '../types';

interface LangConfig {
  language: string;
  wasmFile: string;
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

export function makeNodeId(filePath: string, name: string, line: number): string {
  return `${filePath}::${name}::${line}`;
}

export function makeEdgeId(fromId: string, type: string, toId: string): string {
  return `${fromId}--${type}-->${toId}`;
}

function contentHash(content: string): string {
  return crypto.createHash('sha1').update(content).digest('hex').slice(0, 12);
}

// ─── Scope analyser ───────────────────────────────────────────────────────────
// Given a function body, determines:
//   1. Which identifiers are used but NEVER defined or imported in scope
//   2. Which local variables are declared inside the function
//   3. Which constructors are called via `new`
//
// This is what catches `genAI is not defined` style bugs.

function analyseScope(
  body: string,
  params: Param[],
  fileImportedNames: string[],         // names imported at file level
  fileModuleLevelVars: string[],        // const/let/var at module level
  language: string
): { undefinedRefs: string[]; localVars: string[]; instantiates: string[] } {

  const lines = body.split('\n');

  // Collect local declarations inside this function
  const localVars: string[] = [];
  const localDeclarationPatterns: RegExp[] = [];

  if (language === 'javascript' || language === 'typescript') {
    localDeclarationPatterns.push(
      /(?:const|let|var)\s+(\w+)\s*=/g,          // const x =
      /(?:const|let|var)\s+\{([^}]+)\}/g,         // const { a, b } =
      /(?:const|let|var)\s+\[([^\]]+)\]/g,         // const [a, b] =
      /for\s*\(\s*(?:const|let|var)\s+(\w+)/g,    // for (const x
      /catch\s*\(\s*(\w+)\s*\)/g,                  // catch (err)
    );
  } else if (language === 'python') {
    localDeclarationPatterns.push(
      /^\s+(\w+)\s*=/gm,                           // x = ... (indented)
      /for\s+(\w+)\s+in/g,                         // for x in
      /except\s+\w+\s+as\s+(\w+)/g,               // except Exception as e
    );
  }

  for (const pattern of localDeclarationPatterns) {
    let m: RegExpExecArray | null;
    // Reset lastIndex for global patterns
    pattern.lastIndex = 0;
    while ((m = pattern.exec(body)) !== null) {
      // Handle destructuring: { a, b, c } → split by comma
      const captured = m[1];
      if (!captured) continue;
      if (captured.includes(',')) {
        captured.split(',').map(s => s.trim().replace(/\s*:.*/, '').replace(/\s*=.*/, ''))
          .filter(s => /^\w+$/.test(s))
          .forEach(v => localVars.push(v));
      } else if (/^\w+$/.test(captured)) {
        localVars.push(captured);
      }
    }
  }

  // All names that are legitimately in scope for this function
  const inScope = new Set<string>([
    ...params.map(p => p.name),
    ...localVars,
    ...fileImportedNames,
    ...fileModuleLevelVars,
    // JS/TS builtins
    'console','process','require','module','exports','__dirname','__filename',
    'setTimeout','setInterval','clearTimeout','clearInterval','Promise','Error',
    'JSON','Math','Object','Array','String','Number','Boolean','Date','RegExp',
    'Map','Set','WeakMap','WeakSet','Symbol','Buffer','global','window','document',
    'undefined','null','true','false','NaN','Infinity','this','super','arguments',
    // Node builtins
    'fs','path','http','https','url','crypto','os','events','stream','util',
    // Common patterns
    'async','await','typeof','instanceof','in','of','new','delete','void','throw',
    'return','if','else','for','while','do','switch','case','break','continue',
    'try','catch','finally','class','extends','import','export','const','let','var',
    'function','=>', 'yield', 'from',
  ]);

  // Find all identifiers used in a call/access pattern that are NOT in scope
  // Patterns: identifier(  /  new Identifier  /  identifier.method  but NOT .identifier
  const undefinedRefs: string[] = [];
  const seen = new Set<string>();

  // new ClassName() — detect instantiations
  const instantiates: string[] = [];
  const newPattern = /\bnew\s+([A-Z]\w*)\s*\(/g;
  let nm: RegExpExecArray | null;
  while ((nm = newPattern.exec(body)) !== null) {
    instantiates.push(nm[1]);
  }

  // identifier used as function call or standalone (not after a dot)
  const usagePattern = /(?<![.\w])([a-zA-Z_$][a-zA-Z0-9_$]*)\s*(?:\(|\.)/g;
  let um: RegExpExecArray | null;
  while ((um = usagePattern.exec(body)) !== null) {
    const name = um[1];
    if (seen.has(name)) continue;
    seen.add(name);
    if (!inScope.has(name) && /^[a-zA-Z_$]/.test(name) && name.length > 1) {
      undefinedRefs.push(name);
    }
  }

  return {
    undefinedRefs: [...new Set(undefinedRefs)],
    localVars:     [...new Set(localVars)],
    instantiates:  [...new Set(instantiates)],
  };
}

// ─── Regex-based parser ────────────────────────────────────────────────────────

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

    // ── Step 1: extract imports first so scope analysis can use them ──────────
    const importResult = this.extractImports(filePath, content, language, fileNode.id, now);
    nodes.push(...importResult.nodes);
    edges.push(...importResult.edges);

    // Names available at file scope from imports
    const fileImportedNames = importResult.importedNames;

    // ── Step 2: extract module-level variable names ───────────────────────────
    const fileModuleLevelVars = this.extractModuleLevelVars(content, language);

    // ── Step 3: parse all symbols ─────────────────────────────────────────────
    const patterns = this.getPatterns(language);

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lineNo = i + 1;

      for (const pattern of patterns) {
        const match = pattern.regex.exec(line);
        if (!match) { continue; }

        const name = match[pattern.nameGroup];
        if (!name || name.trim() === '') { continue; }

        const docComment = this.extractDocComment(lines, i);
        const modifiers   = this.extractModifiers(line, language);
        const params       = pattern.hasParams
          ? this.extractParams(match[pattern.paramsGroup ?? 0] ?? '')
          : undefined;
        const endLine = this.findEndLine(lines, i, language);

        // ── FIX 1: scope analysis on every function/method body ──────────────
        let undefinedRefs: string[] | undefined;
        let localVars: string[] | undefined;
        let instantiates: string[] | undefined;

        if (pattern.nodeType === 'function' || pattern.nodeType === 'method') {
          const bodyLines = lines.slice(i, endLine);
          const body = bodyLines.join('\n');
          const scope = analyseScope(
            body,
            params ?? [],
            fileImportedNames,
            fileModuleLevelVars,
            language
          );
          if (scope.undefinedRefs.length > 0)  undefinedRefs = scope.undefinedRefs;
          if (scope.localVars.length > 0)       localVars = scope.localVars;
          if (scope.instantiates.length > 0)    instantiates = scope.instantiates;
        }

        const node: GraphNode = {
          id: makeNodeId(filePath, name, lineNo),
          type: pattern.nodeType,
          name,
          filePath,
          line: lineNo,
          endLine,
          language,
          signature:   line.trim().slice(0, 200),
          returnType:  pattern.returnGroup ? match[pattern.returnGroup]?.trim() : undefined,
          params,
          modifiers,
          docComment,
          undefinedRefs,
          localVars,
          instantiates,
          hash: contentHash(line),
          updatedAt: now,
        };

        nodes.push(node);

        edges.push({
          id: makeEdgeId(fileNode.id, 'contains', node.id),
          fromId: fileNode.id,
          toId: node.id,
          type: 'contains',
        });

        // ── FIX 2: emit undefined_ref edges so graph can traverse them ────────
        if (undefinedRefs) {
          for (const ref of undefinedRefs) {
            edges.push({
              id: makeEdgeId(node.id, 'undefined_ref', `${filePath}::${ref}::0`),
              fromId: node.id,
              toId:   `${filePath}::${ref}::0`,   // placeholder — resolved at query time
              type:   'undefined_ref',
              metadata: { symbolName: ref },
            });
          }
        }

        // ── FIX 3: emit instantiates edges ────────────────────────────────────
        if (instantiates) {
          for (const cls of instantiates) {
            edges.push({
              id: makeEdgeId(node.id, 'instantiates', `__class__::${cls}`),
              fromId: node.id,
              toId:   `__class__::${cls}`,
              type:   'instantiates',
              metadata: { className: cls },
            });
          }
        }
      }
    }

    // ── Step 4: call relationships ─────────────────────────────────────────────
    const callEdges = this.extractCalls(nodes, content);
    edges.push(...callEdges);

    return { filePath, language, nodes, edges, parseErrors: [] };
  }

  // ── Module-level var names ─────────────────────────────────────────────────

  private extractModuleLevelVars(content: string, language: string): string[] {
    const names: string[] = [];
    const lines = content.split('\n');

    for (const line of lines) {
      if (language === 'javascript' || language === 'typescript') {
        // Only non-indented declarations = module level
        const m = /^(?:export\s+)?(?:const|let|var)\s+(\w+)/.exec(line);
        if (m) names.push(m[1]);
        // Also grab require() assignments: const X = require(...)
        const r = /^(?:const|let|var)\s+\{([^}]+)\}\s*=\s*require/.exec(line);
        if (r) {
          r[1].split(',').map(s => s.trim().split(':')[0].trim())
            .filter(s => /^\w+$/.test(s))
            .forEach(n => names.push(n));
        }
        // function declarations at top level
        const f = /^(?:async\s+)?function\s+(\w+)/.exec(line);
        if (f) names.push(f[1]);
        // class declarations
        const c = /^(?:export\s+)?class\s+(\w+)/.exec(line);
        if (c) names.push(c[1]);
      } else if (language === 'python') {
        const m = /^(\w+)\s*=/.exec(line);
        if (m && !['if','while','for','return','raise','import','from','class','def'].includes(m[1])) {
          names.push(m[1]);
        }
      }
    }
    return [...new Set(names)];
  }

  // ── Pattern definitions ────────────────────────────────────────────────────

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
          { regex: /(?:export\s+)?(?:abstract\s+)?class\s+(\w+)/, nodeType: 'class', nameGroup: 1, hasParams: false },
          { regex: /(?:export\s+)?interface\s+(\w+)/, nodeType: 'interface', nameGroup: 1, hasParams: false },
          { regex: /(?:export\s+)?type\s+(\w+)\s*=/, nodeType: 'type', nameGroup: 1, hasParams: false },
          { regex: /(?:export\s+)?enum\s+(\w+)/, nodeType: 'enum', nameGroup: 1, hasParams: false },
          { regex: /(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\(([^)]*)\)\s*(?::\s*([\w<>[\]|&\s]+))?/, nodeType: 'function', nameGroup: 1, hasParams: true, paramsGroup: 2, returnGroup: 3 },
          { regex: /(?:export\s+)?const\s+(\w+)\s*=\s*(?:async\s+)?\(([^)]*)\)\s*(?::\s*([\w<>[\]|&\s]+))?\s*=>/, nodeType: 'function', nameGroup: 1, hasParams: true, paramsGroup: 2, returnGroup: 3 },
          { regex: /(?:export\s+)?const\s+(\w+)\s*=\s*(?:async\s+)?function/, nodeType: 'function', nameGroup: 1, hasParams: false },
          { regex: /^\s+(?:public\s+|private\s+|protected\s+|static\s+|async\s+|override\s+)*(\w+)\s*\(([^)]*)\)\s*(?::\s*([\w<>[\]|&\s]+))?/, nodeType: 'method', nameGroup: 1, hasParams: true, paramsGroup: 2, returnGroup: 3 },
          { regex: /^(?:export\s+)?(?:const|let|var)\s+(\w+)\s*(?::\s*([\w<>[\]|&\s]+))?\s*=/, nodeType: 'variable', nameGroup: 1, hasParams: false },
        ];

      case 'python':
        return [
          { regex: /^class\s+(\w+)/, nodeType: 'class', nameGroup: 1, hasParams: false },
          { regex: /^def\s+(\w+)\s*\(([^)]*)\)/, nodeType: 'function', nameGroup: 1, hasParams: true, paramsGroup: 2 },
          { regex: /^\s+def\s+(\w+)\s*\(([^)]*)\)/, nodeType: 'method', nameGroup: 1, hasParams: true, paramsGroup: 2 },
          { regex: /^(\w+)\s*=\s*/, nodeType: 'variable', nameGroup: 1, hasParams: false },
        ];

      case 'go':
        return [
          { regex: /^type\s+(\w+)\s+struct/, nodeType: 'class', nameGroup: 1, hasParams: false },
          { regex: /^type\s+(\w+)\s+interface/, nodeType: 'interface', nameGroup: 1, hasParams: false },
          { regex: /^func\s+(?:\([^)]+\)\s+)?(\w+)\s*\(([^)]*)\)/, nodeType: 'function', nameGroup: 1, hasParams: true, paramsGroup: 2 },
        ];

      case 'rust':
        return [
          { regex: /^(?:pub\s+)?struct\s+(\w+)/,  nodeType: 'class',     nameGroup: 1, hasParams: false },
          { regex: /^(?:pub\s+)?trait\s+(\w+)/,   nodeType: 'interface', nameGroup: 1, hasParams: false },
          { regex: /^(?:pub\s+)?enum\s+(\w+)/,    nodeType: 'enum',      nameGroup: 1, hasParams: false },
          { regex: /^(?:pub\s+)?(?:async\s+)?fn\s+(\w+)\s*\(([^)]*)\)/, nodeType: 'function', nameGroup: 1, hasParams: true, paramsGroup: 2 },
        ];

      default:
        return [
          { regex: /(?:function|func|def|fn)\s+(\w+)\s*\(/, nodeType: 'function', nameGroup: 1, hasParams: false },
          { regex: /(?:class|struct|interface)\s+(\w+)/,    nodeType: 'class',    nameGroup: 1, hasParams: false },
        ];
    }
  }

  // ── Import extraction (now also returns imported names for scope analysis) ─

  private extractImports(
    filePath: string,
    content: string,
    language: string,
    fileNodeId: string,
    now: number
  ): { nodes: GraphNode[]; edges: GraphEdge[]; importedNames: string[] } {
    const nodes: GraphNode[] = [];
    const edges: GraphEdge[] = [];
    const importedNames: string[] = [];
    const lines = content.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      if (language === 'javascript' || language === 'typescript') {
        // import { A, B } from 'x'
        const namedImport = /^import\s+\{([^}]+)\}\s*from\s*['"]([^'"]+)['"]/.exec(line);
        if (namedImport) {
          namedImport[1].split(',').map(s => s.trim().split(/\s+as\s+/).pop()!.trim())
            .filter(s => /^\w+$/.test(s))
            .forEach(n => importedNames.push(n));
          this.pushImportNodes(nodes, edges, filePath, namedImport[2], line, i + 1, fileNodeId, language, now);
          continue;
        }
        // import X from 'x'  /  import * as X from 'x'
        const defaultImport = /^import\s+(?:\*\s+as\s+)?(\w+)\s*(?:,\s*\{[^}]*\})?\s*from\s*['"]([^'"]+)['"]/.exec(line);
        if (defaultImport) {
          importedNames.push(defaultImport[1]);
          this.pushImportNodes(nodes, edges, filePath, defaultImport[2], line, i + 1, fileNodeId, language, now);
          continue;
        }
        // const X = require('x')
        const requireDefault = /^(?:const|let|var)\s+(\w+)\s*=\s*require\s*\(['"]([^'"]+)['"]\)/.exec(line);
        if (requireDefault) {
          importedNames.push(requireDefault[1]);
          this.pushImportNodes(nodes, edges, filePath, requireDefault[2], line, i + 1, fileNodeId, language, now);
          continue;
        }
        // const { A, B } = require('x')
        const requireDestructure = /^(?:const|let|var)\s+\{([^}]+)\}\s*=\s*require\s*\(['"]([^'"]+)['"]\)/.exec(line);
        if (requireDestructure) {
          requireDestructure[1].split(',').map(s => s.trim().split(':')[0].trim())
            .filter(s => /^\w+$/.test(s))
            .forEach(n => importedNames.push(n));
          this.pushImportNodes(nodes, edges, filePath, requireDestructure[2], line, i + 1, fileNodeId, language, now);
        }
      } else if (language === 'python') {
        const imp1 = /^import\s+([\w.]+)(?:\s+as\s+(\w+))?/.exec(line);
        if (imp1) { importedNames.push(imp1[2] ?? imp1[1].split('.').pop()!); continue; }
        const imp2 = /^from\s+[\w.]+\s+import\s+(.+)/.exec(line);
        if (imp2) {
          imp2[1].split(',').map(s => s.trim().split(/\s+as\s+/).pop()!.trim())
            .filter(s => /^\w+$/.test(s))
            .forEach(n => importedNames.push(n));
        }
      }
    }

    return { nodes, edges, importedNames: [...new Set(importedNames)] };
  }

  private pushImportNodes(
    nodes: GraphNode[], edges: GraphEdge[],
    filePath: string, source: string, line: string,
    lineNo: number, fileNodeId: string, language: string, now: number
  ) {
    const importNodeId = makeNodeId(filePath, `__import__${source}`, lineNo);
    nodes.push({
      id: importNodeId, type: 'import', name: source,
      filePath, line: lineNo, endLine: lineNo, language,
      signature: line.trim(), updatedAt: now,
    });
    edges.push({
      id: makeEdgeId(fileNodeId, 'imports', importNodeId),
      fromId: fileNodeId, toId: importNodeId, type: 'imports',
      metadata: { source },
    });
  }

  // ── Call extraction ────────────────────────────────────────────────────────

  private extractCalls(nodes: GraphNode[], content: string): GraphEdge[] {
    const edges: GraphEdge[] = [];
    const functionNodes = nodes.filter(n => n.type === 'function' || n.type === 'method');

    for (const caller of functionNodes) {
      const bodyLines = content.split('\n').slice(caller.line, caller.endLine);
      const body = bodyLines.join('\n');

      for (const callee of functionNodes) {
        if (callee.id === caller.id) { continue; }
        const callPattern = new RegExp(`\\b${callee.name}\\s*\\(`, 'g');
        if (callPattern.test(body)) {
          edges.push({
            id: makeEdgeId(caller.id, 'calls', callee.id),
            fromId: caller.id, toId: callee.id, type: 'calls',
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
    while (i >= 0) {
      const l = lines[i].trim();
      if (l.startsWith('//') || l.startsWith('*') || l.startsWith('/*') || l.startsWith('#')) {
        docLines.unshift(l.replace(/^\/\/\s?|^\*\s?|^#\s?|^\/\*\*?\s?/, ''));
        i--;
      } else { break; }
    }
    return docLines.length > 0 ? docLines.join(' ').trim() : undefined;
  }

  private extractModifiers(line: string, _language: string): string[] {
    const modifiers: string[] = [];
    const keywords = ['export','default','async','public','private','protected',
                      'static','abstract','readonly','override','const','let','var'];
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
      const [nameType, defaultValue] = p.split('=').map(s => s.trim());
      const [name, type] = nameType.split(':').map(s => s.trim());
      return { name: name || p, type: type?.trim(), defaultValue, rest } as Param;
    }).filter(Boolean) as Param[];
  }

  private findEndLine(lines: string[], startIndex: number, language: string): number {
    if (['typescript','javascript','java','go','rust','cpp','c','cs'].includes(language)) {
      let depth = 0, foundOpen = false;
      for (let i = startIndex; i < Math.min(startIndex + 300, lines.length); i++) {
        for (const ch of lines[i]) {
          if (ch === '{') { depth++; foundOpen = true; }
          if (ch === '}') { depth--; }
        }
        if (foundOpen && depth === 0) { return i + 1; }
      }
    }
    if (language === 'python') {
      const baseIndent = lines[startIndex].match(/^\s*/)?.[0].length ?? 0;
      for (let i = startIndex + 1; i < lines.length; i++) {
        const l = lines[i];
        if (l.trim() === '') { continue; }
        if ((l.match(/^\s*/)?.[0].length ?? 0) <= baseIndent) { return i; }
      }
    }
    return Math.min(startIndex + 80, lines.length);
  }
}

// ─── Public ASTParser ─────────────────────────────────────────────────────────

export class ASTParser {
  private regexParser = new RegexParser();

  getSupportedExtensions(): string[] { return Object.keys(EXTENSION_MAP); }
  getLanguageForFile(fp: string): string | null { return EXTENSION_MAP[path.extname(fp).toLowerCase()]?.language ?? null; }
  canParse(fp: string): boolean { return this.getLanguageForFile(fp) !== null; }

  parseFile(filePath: string): ParsedFile {
    const language = this.getLanguageForFile(filePath);
    if (!language) {
      return { filePath, language: 'unknown', nodes: [], edges: [], parseErrors: [`Unsupported: ${filePath}`] };
    }
    let content: string;
    try { content = fs.readFileSync(filePath, 'utf-8'); }
    catch (err) { return { filePath, language, nodes: [], edges: [], parseErrors: [`Cannot read: ${err}`] }; }
    if (!content.trim() || content.length > 500_000) {
      return { filePath, language, nodes: [], edges: [], parseErrors: [] };
    }
    try { return this.regexParser.parse(filePath, content, language); }
    catch (err) { return { filePath, language, nodes: [], edges: [], parseErrors: [`Parse error: ${err}`] }; }
  }

  parseFiles(filePaths: string[]): ParsedFile[] {
    return filePaths.map(fp => this.parseFile(fp));
  }
}
