// ─── Node types ────────────────────────────────────────────────────────────────
// Every symbol in the codebase becomes one of these node types in the graph.

export type NodeType =
  | 'file'        // a source file
  | 'class'       // class declaration
  | 'interface'   // interface / type declaration
  | 'function'    // top-level function
  | 'method'      // method inside a class
  | 'variable'    // module-level variable or constant
  | 'property'    // property inside a class
  | 'import'      // import statement
  | 'export'      // export declaration
  | 'enum'        // enum declaration
  | 'type'        // type alias
  | 'decorator';  // decorator (TypeScript / Python)

// ─── Edge types ────────────────────────────────────────────────────────────────
// Relationships between nodes. These are directed (from → to).

export type EdgeType =
  | 'contains'      // file contains class; class contains method
  | 'calls'         // function/method calls another function/method
  | 'imports'       // file imports from another file or package
  | 'inherits'      // class extends another class
  | 'implements'    // class implements an interface
  | 'uses_type'     // variable/param uses a type
  | 'instantiates'  // new ClassName()
  | 'exports'       // file exports a symbol
  | 'references'    // variable / property references another symbol
  | 'modifies';     // agent run modified this node (tracked post-run)

// ─── Graph node ────────────────────────────────────────────────────────────────

export interface GraphNode {
  id: string;           // unique: "filePath::symbolName::line"
  type: NodeType;
  name: string;         // symbol name (e.g. "getUserById")
  filePath: string;     // absolute path
  line: number;         // line number where defined
  endLine: number;      // last line of the symbol
  language: string;     // "typescript" | "python" | etc.

  // Symbol-level detail
  signature?: string;   // full function/method signature
  returnType?: string;  // return type annotation
  params?: Param[];     // parameter list
  modifiers?: string[]; // public, private, static, async, export, etc.
  docComment?: string;  // JSDoc / docstring above the symbol

  // File-level metadata (only on file nodes)
  size?: number;        // bytes
  lastModified?: number; // unix timestamp

  // Graph state
  hash?: string;        // content hash — used to detect changes
  updatedAt: number;    // unix timestamp of last graph update
}

export interface Param {
  name: string;
  type?: string;
  defaultValue?: string;
  rest?: boolean;       // ...args
}

// ─── Graph edge ────────────────────────────────────────────────────────────────

export interface GraphEdge {
  id: string;           // "fromId::edgeType::toId"
  fromId: string;
  toId: string;
  type: EdgeType;
  metadata?: Record<string, string>; // e.g. { importedAs: "Router" }
}

// ─── Snapshot ──────────────────────────────────────────────────────────────────
// Created before and after every agent run.

export interface GraphSnapshot {
  id: string;           // uuid
  timestamp: number;
  agentRunId?: string;
  nodeCount: number;
  edgeCount: number;
  changedNodeIds: string[];
  addedNodeIds: string[];
  removedNodeIds: string[];
}

// ─── Parsed file (output of AST parser) ────────────────────────────────────────

export interface ParsedFile {
  filePath: string;
  language: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  parseErrors: string[];
}

// ─── Context payload (what gets injected into agents) ──────────────────────────

export interface AgentContext {
  taskDescription: string;
  entryPoints: string[];           // node ids most relevant to the task
  subgraph: {
    nodes: GraphNode[];
    edges: GraphEdge[];
  };
  existingFiles: string[];         // all files in scope
  warnings: string[];              // "X already exists at line Y — do not duplicate"
  tokenEstimate: number;
  generatedAt: number;
}

// ─── Graph stats ───────────────────────────────────────────────────────────────

export interface GraphStats {
  totalNodes: number;
  totalEdges: number;
  byType: Record<NodeType, number>;
  fileCount: number;
  lastBuilt: number;
  buildDurationMs: number;
}
