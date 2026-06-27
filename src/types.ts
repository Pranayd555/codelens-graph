// ─── Node types ────────────────────────────────────────────────────────────────

export type NodeType =
  | 'file'
  | 'class'
  | 'interface'
  | 'function'
  | 'method'
  | 'variable'
  | 'property'
  | 'import'
  | 'export'
  | 'enum'
  | 'type'
  | 'decorator';

// ─── Edge types ────────────────────────────────────────────────────────────────

export type EdgeType =
  | 'contains'
  | 'calls'
  | 'imports'
  | 'inherits'
  | 'implements'
  | 'uses_type'
  | 'instantiates'
  | 'exports'
  | 'references'
  | 'modifies'
  | 'depends-on'
  | 'peer-dependency'
  | 'undefined_ref';   // NEW: symbol used in body but never defined/imported

// ─── Graph node ────────────────────────────────────────────────────────────────

export interface GraphNode {
  id: string;
  type: NodeType;
  name: string;
  filePath: string;
  line: number;
  endLine: number;
  language: string;

  signature?: string;
  returnType?: string;
  params?: Param[];
  modifiers?: string[];
  docComment?: string;

  // NEW: identifiers used inside this function that are never defined or imported
  undefinedRefs?: string[];

  // NEW: local variables defined inside this function (scope map)
  localVars?: string[];

  // NEW: external symbols this function instantiates via `new`
  instantiates?: string[];

  size?: number;
  lastModified?: number;
  hash?: string;
  updatedAt: number;
}

export interface Param {
  name: string;
  type?: string;
  defaultValue?: string;
  rest?: boolean;
}

// ─── Graph edge ────────────────────────────────────────────────────────────────

export interface GraphEdge {
  id: string;
  fromId: string;
  toId: string;
  type: EdgeType;
  metadata?: Record<string, string>;
}

// A source-level call retained independently from its resolved graph edge.
// Keeping this durable lets the graph repair relationships when a callee is
// added, removed, renamed, or moved without reparsing every caller.
export interface CallReference {
  id: string;
  fromId: string;
  filePath: string;
  symbolName: string;
  qualifier?: string;
  line: number;
}

// ─── Snapshot ──────────────────────────────────────────────────────────────────

export interface GraphSnapshot {
  id: string;
  timestamp: number;
  agentRunId?: string;
  nodeCount: number;
  edgeCount: number;
  changedNodeIds: string[];
  addedNodeIds: string[];
  removedNodeIds: string[];
}

// ─── Parsed file ───────────────────────────────────────────────────────────────

export interface ParsedFile {
  filePath: string;
  language: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  callRefs: CallReference[];
  parseErrors: string[];
}

// ─── Agent context ─────────────────────────────────────────────────────────────

export interface AgentContext {
  taskDescription: string;
  entryPoints: string[];
  subgraph: {
    nodes: GraphNode[];
    edges: GraphEdge[];
  };
  existingFiles: string[];
  warnings: string[];
  // NEW: diagnosed issues found in the relevant subgraph
  diagnoses: Diagnosis[];
  tokenEstimate: number;
  generatedAt: number;
  depVisibility?: 'full' | 'metadata' | 'hidden';
}

// NEW: a concrete issue the graph found that the agent should fix
export interface Diagnosis {
  severity: 'error' | 'warning' | 'info';
  type: 'undefined_ref' | 'duplicate_symbol' | 'missing_import' | 'stale_import';
  message: string;
  filePath: string;
  line?: number;
  symbol?: string;
  suggestion?: string;
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
