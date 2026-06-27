import * as fs   from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { GraphNode, GraphEdge, ParsedFile, Param, NodeType, CallReference } from '../types';
import { isConfigPath, isNodeModulePath } from '../utils';

// ─── Language → WASM mapping ──────────────────────────────────────────────────

const EXTENSION_MAP: Record<string, { language: string; wasm: string }> = {
  '.ts':   { language: 'typescript', wasm: 'tree-sitter-typescript.wasm' },
  '.tsx':  { language: 'tsx',        wasm: 'tree-sitter-tsx.wasm'        },
  '.js':   { language: 'javascript', wasm: 'tree-sitter-javascript.wasm' },
  '.jsx':  { language: 'javascript', wasm: 'tree-sitter-javascript.wasm' },
  '.mjs':  { language: 'javascript', wasm: 'tree-sitter-javascript.wasm' },
  '.py':   { language: 'python',     wasm: 'tree-sitter-python.wasm'     },
  '.go':   { language: 'go',         wasm: 'tree-sitter-go.wasm'         },
  '.rs':   { language: 'rust',       wasm: 'tree-sitter-rust.wasm'       },
  '.java': { language: 'java',       wasm: 'tree-sitter-java.wasm'       },
  '.cs':   { language: 'c_sharp',    wasm: 'tree-sitter-c_sharp.wasm'    },
  '.cpp':  { language: 'cpp',        wasm: 'tree-sitter-cpp.wasm'        },
  '.cc':   { language: 'cpp',        wasm: 'tree-sitter-cpp.wasm'        },
  '.c':    { language: 'c',          wasm: 'tree-sitter-c.wasm'          },
  '.h':    { language: 'c',          wasm: 'tree-sitter-c.wasm'          },
  '.rb':   { language: 'ruby',       wasm: 'tree-sitter-ruby.wasm'       },
  '.php':  { language: 'php',        wasm: 'tree-sitter-php.wasm'        },
  '.swift':{ language: 'swift',      wasm: 'tree-sitter-swift.wasm'      },
  '.kt':   { language: 'kotlin',     wasm: 'tree-sitter-kotlin.wasm'     },
};

const KEYWORDS = new Set([
  'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default', 'delete', 'do',
  'else', 'export', 'extends', 'finally', 'for', 'function', 'if', 'import', 'in', 'instanceof',
  'new', 'return', 'super', 'switch', 'this', 'throw', 'try', 'typeof', 'var', 'void', 'while',
  'with', 'yield', 'let', 'static', 'enum', 'await', 'implements', 'package', 'protected',
  'interface', 'private', 'public', 'def', 'elif', 'except', 'func', 'fn', 'struct', 'impl', 'mut',
  'pub', 'use', 'type', 'and', 'or', 'not'
]);

// ─── Helpers ──────────────────────────────────────────────────────────────────

export function makeNodeId(filePath: string, name: string, line: number): string {
  return `${filePath}::${name}::${line}`;
}
export function makeEdgeId(from: string, type: string, to: string): string {
  return `${from}--${type}-->${to}`;
}
function contentHash(s: string): string {
  return crypto.createHash('sha1').update(s).digest('hex').slice(0, 12);
}

// ─── Tree-sitter node type queries per language ───────────────────────────────
// Maps language → which AST node types map to which GraphNode types,
// and which child fields contain the name, params, return type.

interface LangQuery {
  nodeTypes:    Record<string, NodeType>;   // treeSitterType → our NodeType
  nameField:    string;                     // field that holds the identifier
  paramsField?: string;
  returnField?: string;
  bodyField?:   string;
  importTypes:  string[];                   // AST node types that are imports
  callTypes:    string[];                   // AST node types that are function calls
  callNamePath: string[];                   // how to get the name from a call node
}

const LANG_QUERIES: Record<string, LangQuery> = {
  typescript: {
    nodeTypes: {
      function_declaration:           'function',
      function_expression:            'function',
      arrow_function:                 'function',
      method_definition:              'method',
      class_declaration:              'class',
      abstract_class_declaration:     'class',
      interface_declaration:          'interface',
      type_alias_declaration:         'type',
      enum_declaration:               'enum',
      lexical_declaration:            'variable',
      variable_declaration:           'variable',
    },
    nameField:    'name',
    paramsField:  'parameters',
    returnField:  'return_type',
    bodyField:    'body',
    importTypes:  ['import_statement', 'import_require_clause'],
    callTypes:    ['call_expression'],
    callNamePath: ['function'],
  },
  javascript: {
    nodeTypes: {
      function_declaration:  'function',
      function_expression:   'function',
      arrow_function:        'function',
      method_definition:     'method',
      class_declaration:     'class',
      lexical_declaration:   'variable',
      variable_declaration:  'variable',
    },
    nameField:    'name',
    paramsField:  'parameters',
    bodyField:    'body',
    importTypes:  ['import_statement'],
    callTypes:    ['call_expression'],
    callNamePath: ['function'],
  },
  python: {
    nodeTypes: {
      function_definition:   'function',
      async_function_def:    'function',
      class_definition:      'class',
      assignment:            'variable',
      augmented_assignment:  'variable',
    },
    nameField:    'name',
    paramsField:  'parameters',
    returnField:  'return_type',
    bodyField:    'body',
    importTypes:  ['import_statement', 'import_from_statement'],
    callTypes:    ['call'],
    callNamePath: ['function'],
  },
  go: {
    nodeTypes: {
      function_declaration:  'function',
      method_declaration:    'method',
      type_declaration:      'class',
      var_declaration:       'variable',
      const_declaration:     'variable',
    },
    nameField:    'name',
    paramsField:  'parameters',
    returnField:  'result',
    bodyField:    'body',
    importTypes:  ['import_declaration'],
    callTypes:    ['call_expression'],
    callNamePath: ['function'],
  },
  rust: {
    nodeTypes: {
      function_item:  'function',
      impl_item:      'class',
      struct_item:    'class',
      trait_item:     'interface',
      enum_item:      'enum',
      let_declaration:'variable',
    },
    nameField:    'name',
    paramsField:  'parameters',
    returnField:  'return_type',
    bodyField:    'body',
    importTypes:  ['use_declaration'],
    callTypes:    ['call_expression'],
    callNamePath: ['function'],
  },
  java: {
    nodeTypes: {
      method_declaration:        'method',
      class_declaration:         'class',
      interface_declaration:     'interface',
      enum_declaration:          'enum',
      field_declaration:         'variable',
      constructor_declaration:   'method',
    },
    nameField:    'name',
    paramsField:  'formal_parameters',
    returnField:  'type',
    bodyField:    'body',
    importTypes:  ['import_declaration'],
    callTypes:    ['method_invocation'],
    callNamePath: ['name'],
  },
};

// tsx shares with typescript
LANG_QUERIES['tsx'] = LANG_QUERIES['typescript'];
// c_sharp, cpp, c, ruby, php, swift, kotlin — fallback to regex for now
// (they'll use the RegexFallback parser below)

// ─── TreeSitterParser ─────────────────────────────────────────────────────────

export class TreeSitterParser {
  // Lazily initialised — we only load WASM when we first need it
  private Parser: typeof import('web-tree-sitter') | null = null;
  private languages   = new Map<string, import('web-tree-sitter')>();
  private wasmDir: string;
  private initialised = false;

  constructor(wasmDir?: string) {
    if (wasmDir) {
      this.wasmDir = wasmDir;
    } else {
      // When bundled with esbuild: __dirname = dist/, WASM files are in dist/wasm/
      // When running from tsc: __dirname = out/ingestion/, fall back to node_modules
      const distWasm = path.join(__dirname, 'wasm');
      const nodeModulesWasm = path.join(__dirname, '..', '..', 'node_modules', 'tree-sitter-wasms', 'out');
      this.wasmDir = require('fs').existsSync(distWasm) ? distWasm : nodeModulesWasm;
    }
  }

  async init(): Promise<void> {
    if (this.initialised) { return; }
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const Parser = require('web-tree-sitter');
      // Resolve tree-sitter.wasm — in dist/wasm/ when bundled, otherwise node_modules
      const treeSitterWasm = require('path').join(this.wasmDir, 'tree-sitter.wasm');
      const fallbackWasm   = require('path').join(
        require('path').dirname(require.resolve('web-tree-sitter')), 'tree-sitter.wasm'
      );
      const wasmPath = require('fs').existsSync(treeSitterWasm) ? treeSitterWasm : fallbackWasm;
      await Parser.init({ locateFile: () => wasmPath });
      this.Parser = Parser;
      this.initialised = true;
    } catch (e) {
      console.warn('[CodeLens] tree-sitter init failed, falling back to regex:', e);
    }
  }

  isReady(): boolean { return this.initialised && this.Parser !== null; }

  private async getLanguage(langName: string): Promise<import('web-tree-sitter') | null> {
    if (!this.Parser) { return null; }
    if (this.languages.has(langName)) { return this.languages.get(langName)!; }

    // Map our language names to WASM filenames
    const wasmName = `tree-sitter-${langName}.wasm`;
    const wasmPath = path.join(this.wasmDir, wasmName);

    if (!fs.existsSync(wasmPath)) {
      console.warn(`[CodeLens] WASM not found: ${wasmPath}`);
      return null;
    }

    try {
      const lang = await (this.Parser as any).Language.load(wasmPath);
      this.languages.set(langName, lang);
      return lang;
    } catch (e) {
      console.warn(`[CodeLens] Failed to load language ${langName}:`, e);
      return null;
    }
  }

  // ── Main parse ────────────────────────────────────────────────────────────

  async parseFile(filePath: string, content: string, language: string): Promise<ParsedFile> {
    if (!this.Parser) {
      return { filePath, language, nodes: [], edges: [], callRefs: [], parseErrors: ['tree-sitter not initialised'] };
    }

    const lang = await this.getLanguage(language);
    if (!lang) {
      return { filePath, language, nodes: [], edges: [], callRefs: [], parseErrors: [`No grammar for ${language}`] };
    }

    const parser = new (this.Parser as any)();
    parser.setLanguage(lang);

    let tree: any;
    try {
      tree = parser.parse(content);
    } catch (e) {
      return { filePath, language, nodes: [], edges: [], callRefs: [], parseErrors: [`Parse failed: ${e}`] };
    }

    const query = LANG_QUERIES[language];
    if (!query) {
      return { filePath, language, nodes: [], edges: [], callRefs: [], parseErrors: [`No query config for ${language}`] };
    }

    const lines   = content.split('\n');
    const now     = Date.now();
    const nodes:  GraphNode[] = [];
    const edges:  GraphEdge[] = [];
    const callRefs: CallReference[] = [];

    // File node
    const fileNode: GraphNode = {
      id:           makeNodeId(filePath, '__file__', 0),
      type:         'file',
      name:         path.basename(filePath),
      filePath,
      line:         0,
      endLine:      lines.length,
      language,
      size:         Buffer.byteLength(content),
      lastModified: fs.statSync(filePath).mtimeMs,
      hash:         contentHash(content),
      updatedAt:    now,
    };
    nodes.push(fileNode);

    // ── Collect file-level imports for scope analysis ─────────────────────
    const fileImportedNames: string[] = [];
    const fileModuleLevelVars: string[] = [];

    this.walkTree(tree.rootNode, (node: any) => {
      if (query.importTypes.includes(node.type)) {
        const names = this.extractImportNames(node, language);
        fileImportedNames.push(...names);
        const line = node.startPosition.row + 1;
        const importId = makeNodeId(filePath, `__import__${names.join(',')}`, line);
        nodes.push({
          id: importId, type: 'import',
          name: this.getImportSource(node, content) ?? names.join(','),
          filePath, line, endLine: node.endPosition.row + 1,
          language, signature: content.slice(node.startIndex, node.endIndex).slice(0, 120),
          updatedAt: now,
        });
        edges.push({
          id: makeEdgeId(fileNode.id, 'imports', importId),
          fromId: fileNode.id, toId: importId, type: 'imports',
        });
      }
    });

    // ── Walk all declaration nodes ─────────────────────────────────────────
    this.walkTree(tree.rootNode, (tsNode: any) => {
      const ourType = query.nodeTypes[tsNode.type];
      if (!ourType) { return; }

      // Get name
      const name = this.getNodeName(tsNode, query.nameField, content);
      if (!name || name === '__file__') { return; }
      if (KEYWORDS.has(name.toLowerCase())) { return; }

      const line    = tsNode.startPosition.row + 1;
      const endLine = tsNode.endPosition.row + 1;

      // Get params
      const params = query.paramsField
        ? this.extractParams(tsNode.childForFieldName?.(query.paramsField), content)
        : undefined;

      // Get return type
      const returnType = query.returnField
        ? tsNode.childForFieldName?.(query.returnField)?.text?.trim()
        : undefined;

      // Get modifiers (export, async, public, etc.)
      const modifiers = this.extractModifiers(tsNode, content);

      // Get docstring from preceding comment
      const docComment = this.extractDocComment(tsNode, lines);

      // Scope analysis on function/method bodies
      let undefinedRefs: string[] | undefined;
      let localVars:     string[] | undefined;
      let instantiates:  string[] | undefined;

      if (ourType === 'function' || ourType === 'method') {
        const body = query.bodyField
          ? tsNode.childForFieldName?.(query.bodyField)?.text ?? ''
          : content.slice(tsNode.startIndex, tsNode.endIndex);

        const scope = this.analyseScope(body, params ?? [], fileImportedNames, fileModuleLevelVars, language);
        if (scope.undefinedRefs.length)  undefinedRefs = scope.undefinedRefs;
        if (scope.localVars.length)      localVars     = scope.localVars;
        if (scope.instantiates.length)   instantiates  = scope.instantiates;
      }

      // Track module-level vars for scope analysis
      if (ourType === 'variable' && tsNode.startPosition.column === 0) {
        fileModuleLevelVars.push(name);
      }

      const nodeId = makeNodeId(filePath, name, line);
      const graphNode: GraphNode = {
        id: nodeId, type: ourType, name, filePath,
        line, endLine, language,
        signature:   content.slice(tsNode.startIndex, tsNode.startIndex + 200).split('\n')[0].trim(),
        returnType,
        params,
        modifiers,
        docComment,
        undefinedRefs,
        localVars,
        instantiates,
        hash:      contentHash(content.slice(tsNode.startIndex, tsNode.endIndex)),
        updatedAt: now,
      };

      nodes.push(graphNode);
      edges.push({
        id: makeEdgeId(fileNode.id, 'contains', nodeId),
        fromId: fileNode.id, toId: nodeId, type: 'contains',
      });

      // Emit undefined_ref edges
      if (undefinedRefs) {
        for (const ref of undefinedRefs) {
          edges.push({
            id: makeEdgeId(nodeId, 'undefined_ref', `${filePath}::${ref}::0`),
            fromId: nodeId,
            toId:   `${filePath}::${ref}::0`,
            type:   'undefined_ref',
            metadata: { symbolName: ref },
          });
        }
      }

      // Emit instantiates edges
      if (instantiates) {
        for (const cls of instantiates) {
          edges.push({
            id: makeEdgeId(nodeId, 'instantiates', `__class__::${cls}`),
            fromId: nodeId, toId: `__class__::${cls}`,
            type: 'instantiates', metadata: { className: cls },
          });
        }
      }
    });

    // Retain every call as a durable reference. The workspace-level resolver
    // links these to definitions after all files have been indexed.
    this.walkTree(tree.rootNode, (tsNode: any) => {
      if (!query.callTypes.includes(tsNode.type)) { return; }

      const calleeName = this.getCallName(tsNode, query.callNamePath, content);
      if (!calleeName) { return; }

      const enclosing = this.findEnclosingFunction(tsNode, nodes);
      if (!enclosing) { return; }

      const callTarget = tsNode.childForFieldName?.(query.callNamePath[0]);
      const qualifier = callTarget?.type === 'member_expression'
        ? callTarget.childForFieldName?.('object')?.text?.trim()
        : undefined;
      const line = tsNode.startPosition.row + 1;
      const column = tsNode.startPosition.column;

      callRefs.push({
        id: `${enclosing.id}::call::${calleeName}::${line}:${column}`,
        fromId: enclosing.id,
        filePath,
        symbolName: calleeName,
        qualifier,
        line,
      });
    });

    return { filePath, language, nodes, edges, callRefs, parseErrors: [] };
  }

  // ── Tree walking ──────────────────────────────────────────────────────────

  private walkTree(node: any, visit: (n: any) => void): void {
    visit(node);
    for (let i = 0; i < node.childCount; i++) {
      this.walkTree(node.child(i), visit);
    }
  }

  // ── Name extraction ───────────────────────────────────────────────────────

  private getNodeName(node: any, field: string, _content: string): string | null {
    // Try field name first
    const named = node.childForFieldName?.(field);
    if (named) { return named.text.trim(); }

    // For variable declarations: look for first identifier
    if (node.type === 'lexical_declaration' || node.type === 'variable_declaration') {
      for (let i = 0; i < node.childCount; i++) {
        const child = node.child(i);
        if (child.type === 'variable_declarator') {
          const id = child.childForFieldName?.('name');
          if (id) { return id.text.trim(); }
        }
      }
    }

    return null;
  }

  private getCallName(node: any, pathFields: string[], _content: string): string | null {
    let current = node;
    for (const field of pathFields) {
      current = current.childForFieldName?.(field);
      if (!current) { return null; }
    }
    // Handle member expressions: obj.method → extract "method"
    if (current.type === 'member_expression') {
      return current.childForFieldName?.('property')?.text?.trim() ?? null;
    }
    if (current.type === 'identifier') { return current.text.trim(); }
    return null;
  }

  private findEnclosingFunction(node: any, nodes: GraphNode[]): GraphNode | null {
    const line = node.startPosition.row + 1;
    // Find the innermost function/method that contains this line
    return nodes
      .filter(n => (n.type === 'function' || n.type === 'method') && n.line <= line && n.endLine >= line)
      .sort((a, b) => b.line - a.line)[0] ?? null;
  }

  // ── Import name extraction ────────────────────────────────────────────────

  private extractImportNames(node: any, language: string): string[] {
    const names: string[] = [];
    if (language === 'typescript' || language === 'javascript' || language === 'tsx') {
      // import { A, B } from 'x'  or  import X from 'x'
      this.walkTree(node, (n: any) => {
        if (n.type === 'identifier' || n.type === 'import_specifier') {
          const text = n.text.trim();
          if (text && /^\w+$/.test(text)) { names.push(text); }
        }
      });
    } else if (language === 'python') {
      this.walkTree(node, (n: any) => {
        if (n.type === 'dotted_name' || n.type === 'aliased_import') {
          names.push(n.text.split(' as ').pop()?.trim() ?? n.text.trim());
        }
      });
    }
    return [...new Set(names)].filter(n => n.length > 1);
  }

  private getImportSource(node: any, _content: string): string | null {
    // Look for string literal child (the module path)
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child.type === 'string' || child.type === 'string_literal') {
        return child.text.replace(/['"]/g, '').trim();
      }
    }

    const text = node.text?.trim?.() ?? '';
    const pythonFrom = /^from\s+([.\w]+)\s+import\b/.exec(text);
    if (pythonFrom) { return pythonFrom[1]; }
    const pythonImport = /^import\s+([.\w]+)/.exec(text);
    if (pythonImport) { return pythonImport[1]; }
    return null;
  }

  // ── Params extraction ─────────────────────────────────────────────────────

  private extractParams(paramsNode: any, _content: string): Param[] | undefined {
    if (!paramsNode) { return undefined; }
    const params: Param[] = [];

    for (let i = 0; i < paramsNode.childCount; i++) {
      const child = paramsNode.child(i);
      if (['identifier', 'required_parameter', 'optional_parameter',
           'rest_parameter', 'default_parameter', 'typed_parameter'].includes(child.type)) {
        const nameNode = child.childForFieldName?.('pattern') ?? child.childForFieldName?.('name') ?? child;
        const typeNode = child.childForFieldName?.('type');
        const defNode  = child.childForFieldName?.('value');
        const name     = nameNode.text.replace(/^\.\.\./, '').trim();
        if (name && /^\w+$/.test(name)) {
          params.push({
            name,
            type:         typeNode?.text?.replace(/^:\s*/, '').trim(),
            defaultValue: defNode?.text?.trim(),
            rest:         child.text.startsWith('...'),
          });
        }
      }
    }
    return params.length > 0 ? params : undefined;
  }

  // ── Modifier extraction ───────────────────────────────────────────────────

  private extractModifiers(node: any, _content: string): string[] {
    const mods: string[] = [];
    const modKeywords = new Set(['export', 'default', 'async', 'public', 'private',
                                  'protected', 'static', 'abstract', 'readonly', 'override']);
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (modKeywords.has(child.type) || modKeywords.has(child.text)) {
        mods.push(child.text.trim());
      }
    }
    // Check parent for export
    if (node.parent?.type === 'export_statement') { mods.push('export'); }
    return [...new Set(mods)];
  }

  // ── Doc comment extraction ────────────────────────────────────────────────

  private extractDocComment(node: any, lines: string[]): string | undefined {
    const startLine = node.startPosition.row;
    const docLines: string[] = [];
    let i = startLine - 1;
    while (i >= 0) {
      const l = lines[i]?.trim() ?? '';
      if (l.startsWith('//') || l.startsWith('*') || l.startsWith('/*') || l.startsWith('#')) {
        docLines.unshift(l.replace(/^\/\/\s?|^\*\s?|^#\s?|^\/\*\*?\s?/, ''));
        i--;
      } else { break; }
    }
    return docLines.length > 0 ? docLines.join(' ').trim() : undefined;
  }

  // ── Scope analysis (same logic as before, now applied to real AST bodies) ─

  private analyseScope(
    body: string, params: Param[],
    fileImportedNames: string[], fileModuleLevelVars: string[],
    language: string
  ): { undefinedRefs: string[]; localVars: string[]; instantiates: string[] } {
    const localVars: string[] = [];
    const localPatterns: RegExp[] = language === 'python'
      ? [/^\s+(\w+)\s*=/gm, /for\s+(\w+)\s+in/g, /except\s+\w+\s+as\s+(\w+)/g]
      : [/(?:const|let|var)\s+(\w+)\s*=/g, /(?:const|let|var)\s+\{([^}]+)\}/g,
         /for\s*\(\s*(?:const|let|var)\s+(\w+)/g, /catch\s*\(\s*(\w+)\s*\)/g];

    for (const pat of localPatterns) {
      pat.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = pat.exec(body)) !== null) {
        const cap = m[1];
        if (!cap) { continue; }
        if (cap.includes(',')) {
          cap.split(',').map(s => s.trim().replace(/[:\s=].*/, ''))
            .filter(s => /^\w+$/.test(s)).forEach(v => localVars.push(v));
        } else if (/^\w+$/.test(cap)) { localVars.push(cap); }
      }
    }

    const JS_BUILTINS = new Set([
      'console','process','require','module','exports','__dirname','__filename',
      'setTimeout','setInterval','clearTimeout','clearInterval','Promise','Error',
      'JSON','Math','Object','Array','String','Number','Boolean','Date','RegExp',
      'Map','Set','WeakMap','WeakSet','Symbol','Buffer','global','window','document',
      'undefined','null','true','false','NaN','Infinity','this','super','arguments',
      'async','await','typeof','instanceof','new','delete','void','throw','return',
      'if','else','for','while','do','switch','case','break','continue',
      'try','catch','finally','class','extends','import','export',
      'const','let','var','function','yield','from','of','in',
      'fs','path','http','https','crypto','os','events','util',
    ]);

    const inScope = new Set([
      ...params.map(p => p.name),
      ...localVars, ...fileImportedNames, ...fileModuleLevelVars,
      ...JS_BUILTINS,
    ]);

    const instantiates: string[] = [];
    const newPat = /\bnew\s+([A-Z]\w*)\s*\(/g;
    let nm: RegExpExecArray | null;
    while ((nm = newPat.exec(body)) !== null) { instantiates.push(nm[1]); }

    const undefinedRefs: string[] = [];
    const seen = new Set<string>();
    const usePat = /(?<![.\w])([a-zA-Z_$][a-zA-Z0-9_$]*)\s*(?:\(|\.)/g;
    let um: RegExpExecArray | null;
    while ((um = usePat.exec(body)) !== null) {
      const n = um[1];
      if (seen.has(n) || inScope.has(n) || n.length <= 1) { continue; }
      seen.add(n);
      undefinedRefs.push(n);
    }

    return {
      undefinedRefs: [...new Set(undefinedRefs)],
      localVars:     [...new Set(localVars)],
      instantiates:  [...new Set(instantiates)],
    };
  }
}

// ─── Regex fallback (for languages without WASM grammars) ────────────────────
// Kept lean — only used when tree-sitter can't parse a file.

class RegexFallbackParser {
  parse(filePath: string, content: string, language: string): ParsedFile {
    const lines = content.split('\n');
    const now   = Date.now();
    const nodes: GraphNode[] = [];
    const edges: GraphEdge[] = [];
    const callRefs: CallReference[] = [];

    const fileNode: GraphNode = {
      id: makeNodeId(filePath, '__file__', 0), type: 'file',
      name: path.basename(filePath), filePath,
      line: 0, endLine: lines.length, language,
      size: Buffer.byteLength(content),
      lastModified: fs.statSync(filePath).mtimeMs,
      hash: contentHash(content), updatedAt: now,
    };

    if (path.basename(filePath).toLowerCase() === 'package.json') {
      try {
        const pkgObj = JSON.parse(content);
        if (pkgObj.name) {
          fileNode.signature = `${pkgObj.name}@${pkgObj.version || '0.0.0'}`;
        }
      } catch { /* ignore invalid JSON */ }
    }

    nodes.push(fileNode);

    // If it's a simple config/metadata file, return just the file node
    if (['json', 'markdown', 'yaml', 'config'].includes(language)) {
      return { filePath, language, nodes, edges, callRefs, parseErrors: [] };
    }

    const patterns: Array<{ r: RegExp; t: NodeType }> = [
      { r: /(?:export\s+)?(?:abstract\s+)?class\s+(\w+)/,                     t: 'class'     },
      { r: /(?:export\s+)?interface\s+(\w+)/,                                  t: 'interface' },
      { r: /(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\(/,                 t: 'function'  },
      { r: /(?:export\s+)?const\s+(\w+)\s*=\s*(?:async\s+)?\(.*\)\s*=>/,      t: 'function'  },
      { r: /^\s+(?:public\s+|private\s+|protected\s+|static\s+|async\s+)*(\w+)\s*\(/, t: 'method' },
      { r: /^(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=/,                     t: 'variable'  },
    ];

    for (let i = 0; i < lines.length; i++) {
      for (const { r, t } of patterns) {
        const m = r.exec(lines[i]);
        if (!m || !m[1] || m[1] === '__file__') { continue; }
        if (KEYWORDS.has(m[1].toLowerCase())) { continue; }
        const nid = makeNodeId(filePath, m[1], i + 1);
        nodes.push({
          id: nid, type: t, name: m[1], filePath,
          line: i + 1, endLine: i + 50, language,
          signature: lines[i].trim().slice(0, 200),
          hash: contentHash(lines[i]), updatedAt: now,
        });
        edges.push({ id: makeEdgeId(fileNode.id, 'contains', nid), fromId: fileNode.id, toId: nid, type: 'contains' });
      }
    }

    return { filePath, language, nodes, edges, callRefs, parseErrors: [] };
  }
}

// ─── ASTParser — public API ───────────────────────────────────────────────────

export class ASTParser {
  private treeSitter  = new TreeSitterParser();
  private regexFallback = new RegexFallbackParser();
  private initPromise: Promise<void> | null = null;

  async ensureInit(): Promise<void> {
    if (!this.initPromise) {
      this.initPromise = this.treeSitter.init();
    }
    return this.initPromise;
  }

  getSupportedExtensions(): string[] { return Object.keys(EXTENSION_MAP); }

  getLanguageForFile(filePath: string): string | null {
    return EXTENSION_MAP[path.extname(filePath).toLowerCase()]?.language ?? null;
  }

  canParse(filePath: string): boolean {
    return this.getLanguageForFile(filePath) !== null;
  }

  async parseFileAsync(filePath: string): Promise<ParsedFile> {
    const ext = path.extname(filePath).toLowerCase();
    const isConfig = isConfigPath(filePath);
    const isNm = isNodeModulePath(filePath);

    let language = this.getLanguageForFile(filePath);
    if (!language) {
      if (ext === '.json') { language = 'json'; }
      else if (ext === '.md') { language = 'markdown'; }
      else if (ext === '.yml' || ext === '.yaml') { language = 'yaml'; }
      else if (isConfig || isNm) { language = 'config'; }
    }

    if (!language) {
      return { filePath, language: 'unknown', nodes: [], edges: [], callRefs: [], parseErrors: ['Unsupported extension'] };
    }

    let content: string;
    try { content = fs.readFileSync(filePath, 'utf-8'); }
    catch (e) { return { filePath, language, nodes: [], edges: [], callRefs: [], parseErrors: [`Cannot read: ${e}`] }; }

    if (!content.trim() || content.length > 1_000_000) {
      return { filePath, language, nodes: [], edges: [], callRefs: [], parseErrors: [] };
    }

    await this.ensureInit();

    if (['json', 'markdown', 'yaml', 'config'].includes(language)) {
      return this.regexFallback.parse(filePath, content, language);
    }

    // Try tree-sitter first — fall back to regex if language not supported
    if (this.treeSitter.isReady() && LANG_QUERIES[language]) {
      try {
        return await this.treeSitter.parseFile(filePath, content, language);
      } catch (e) {
        console.warn(`[CodeLens] tree-sitter failed for ${filePath}, using regex fallback:`, e);
      }
    }

    return this.regexFallback.parse(filePath, content, language);
  }

  // Synchronous wrapper for backward compat (uses regex only)
  parseFile(filePath: string): ParsedFile {
    const ext = path.extname(filePath).toLowerCase();
    const isConfig = isConfigPath(filePath);
    const isNm = isNodeModulePath(filePath);

    let language = this.getLanguageForFile(filePath);
    if (!language) {
      if (ext === '.json') { language = 'json'; }
      else if (ext === '.md') { language = 'markdown'; }
      else if (ext === '.yml' || ext === '.yaml') { language = 'yaml'; }
      else if (isConfig || isNm) { language = 'config'; }
    }

    if (!language) {
      return { filePath, language: 'unknown', nodes: [], edges: [], callRefs: [], parseErrors: ['Unsupported'] };
    }
    let content: string;
    try { content = fs.readFileSync(filePath, 'utf-8'); }
    catch (e) { return { filePath, language, nodes: [], edges: [], callRefs: [], parseErrors: [`Cannot read: ${e}`] }; }
    if (!content.trim() || content.length > 1_000_000) {
      return { filePath, language, nodes: [], edges: [], callRefs: [], parseErrors: [] };
    }
    return this.regexFallback.parse(filePath, content, language);
  }
}
