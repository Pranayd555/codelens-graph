import * as fs   from 'fs';
import * as path from 'path';

// ─── MCP Usage Logger ─────────────────────────────────────────────────────────
// Writes a JSONL log of every tool call so you can verify:
//   1. Which tools the agent called
//   2. Token cost of each call
//   3. Whether it used triage first
//   4. Whether it avoided unnecessary file reads
//
// Log file: <workspaceRoot>/.codelens/mcp-usage.jsonl
// View with: cat .codelens/mcp-usage.jsonl | tail -50

export interface ToolCallLog {
  ts:         string;   // ISO timestamp
  tool:       string;   // tool name
  input:      Record<string, unknown>;
  outputLen:  number;   // characters in response (÷4 ≈ tokens)
  tokensEst:  number;   // rough token estimate
  durationMs: number;   // how long the tool took
  sessionId:  string;   // groups calls within one MCP session
}

// Approximate token cost per tool call (based on typical response sizes)
const TOOL_TOKEN_COST: Record<string, number> = {
  codelens_triage:       10,
  codelens_search:       50,
  codelens_node:         80,
  codelens_files:        120,
  codelens_relations:    100,
  codelens_context:      400,
  codelens_impact:       300,
  codelens_status:       30,
  codelens_text_search:  60,
  codelens_dependencies: 80,
};

export class MCPLogger {
  private logPath: string;
  private sessionId: string;

  constructor(workspaceRoot: string) {
    const dir = path.join(workspaceRoot, '.codelens');
    fs.mkdirSync(dir, { recursive: true });
    this.logPath  = path.join(dir, 'mcp-usage.jsonl');
    this.sessionId = Date.now().toString(36);
  }

  log(tool: string, input: Record<string, unknown>, outputText: string, durationMs: number): void {
    const outputLen = outputText.length;
    const tokensEst = Math.ceil(outputLen / 4);

    const entry: ToolCallLog = {
      ts:         new Date().toISOString(),
      tool,
      input:      this.sanitiseInput(input),
      outputLen,
      tokensEst,
      durationMs,
      sessionId:  this.sessionId,
    };

    try {
      fs.appendFileSync(this.logPath, JSON.stringify(entry) + '\n', 'utf-8');
    } catch {
      // Non-fatal — logging should never crash the MCP server
    }
  }

  // Print a session summary to stderr (visible in VS Code MCP output panel)
  summarise(): void {
    try {
      if (!fs.existsSync(this.logPath)) { return; }

      const lines = fs.readFileSync(this.logPath, 'utf-8')
        .split('\n').filter(Boolean);

      // Only look at this session's calls
      const sessionCalls = lines
        .map(l => { try { return JSON.parse(l) as ToolCallLog; } catch { return null; } })
        .filter((l): l is ToolCallLog => l !== null && l.sessionId === this.sessionId);

      if (sessionCalls.length === 0) { return; }

      const totalTokens  = sessionCalls.reduce((s, c) => s + c.tokensEst, 0);
      const toolCounts   = sessionCalls.reduce((m, c) => {
        m[c.tool] = (m[c.tool] || 0) + 1; return m;
      }, {} as Record<string, number>);

      // Estimate tokens saved vs naive file-reading (avg 2000 tokens per file read)
      const contextCalls = toolCounts['codelens_context'] || 0;
      const searchCalls  = toolCounts['codelens_search']  || 0;
      const savedEstimate = contextCalls * 1800 + searchCalls * 400;

      console.error('\n[CodeLens MCP] Session summary:');
      console.error(`  Tool calls: ${sessionCalls.length}`);
      console.error(`  Tokens used: ~${totalTokens}`);
      console.error(`  Tokens saved vs raw file reads: ~${savedEstimate}`);
      console.error(`  Tools used: ${Object.entries(toolCounts).map(([k,v]) => `${k}×${v}`).join(', ')}`);

      const usedTriage = (toolCounts['codelens_triage'] || 0) > 0;
      if (!usedTriage && sessionCalls.length > 2) {
        console.error('  ⚠️  Agent skipped codelens_triage — add it to your system prompt');
      }
    } catch {
      // Non-fatal
    }
  }

  // Remove sensitive content from logged inputs
  private sanitiseInput(input: Record<string, unknown>): Record<string, unknown> {
    const safe: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(input)) {
      if (typeof v === 'string' && v.length > 200) {
        safe[k] = v.slice(0, 200) + '…';
      } else {
        safe[k] = v;
      }
    }
    return safe;
  }
}

// ── Log file reader (for VS Code command to display usage) ─────────────────────

export function readRecentLogs(workspaceRoot: string, limit = 100): ToolCallLog[] {
  const logPath = path.join(workspaceRoot, '.codelens', 'mcp-usage.jsonl');
  if (!fs.existsSync(logPath)) { return []; }

  try {
    return fs.readFileSync(logPath, 'utf-8')
      .split('\n').filter(Boolean)
      .slice(-limit)
      .map(l => { try { return JSON.parse(l) as ToolCallLog; } catch { return null; } })
      .filter((l): l is ToolCallLog => l !== null);
  } catch {
    return [];
  }
}

export function formatUsageReport(logs: ToolCallLog[]): string {
  if (logs.length === 0) {
    return 'No MCP tool calls recorded yet.\n\nMake sure your AI agent is connected to the CodeLens MCP server.\nSee .codelens/README.md for setup instructions.';
  }

  // Group by session
  const sessions = new Map<string, ToolCallLog[]>();
  for (const log of logs) {
    if (!sessions.has(log.sessionId)) { sessions.set(log.sessionId, []); }
    sessions.get(log.sessionId)!.push(log);
  }

  const lines: string[] = [
    `# CodeLens MCP Usage Report`,
    `Generated: ${new Date().toISOString()}`,
    `Total calls: ${logs.length} across ${sessions.size} session(s)`,
    '',
  ];

  let sessionNum = 1;
  for (const [sid, calls] of [...sessions.entries()].reverse()) {
    const totalTokens   = calls.reduce((s, c) => s + c.tokensEst, 0);
    const totalDuration = calls.reduce((s, c) => s + c.durationMs, 0);
    const toolCounts    = calls.reduce((m, c) => { m[c.tool]=(m[c.tool]||0)+1; return m; }, {} as Record<string,number>);
    const contextCalls  = toolCounts['codelens_context'] || 0;
    const searchCalls   = toolCounts['codelens_search']  || 0;
    const savedEst      = contextCalls * 1800 + searchCalls * 400;
    const usedTriage    = (toolCounts['codelens_triage'] || 0) > 0;
    const firstCall     = calls[0].ts;

    lines.push(`## Session ${sessionNum++} — ${firstCall.slice(0,16).replace('T',' ')}`);
    lines.push(`- Calls: ${calls.length} | Tokens used: ~${totalTokens} | Duration: ${totalDuration}ms`);
    lines.push(`- Estimated tokens saved vs file reading: ~${savedEst}`);
    lines.push(`- Triage used: ${usedTriage ? '✅ yes' : '❌ no — agent skipped codelens_triage'}`);
    lines.push('- Tool breakdown:');
    for (const [tool, count] of Object.entries(toolCounts).sort(([,a],[,b]) => b-a)) {
      const estCost = TOOL_TOKEN_COST[tool] ?? 50;
      lines.push(`  · ${tool} ×${count} (~${estCost * count} tokens)`);
    }

    // Show individual calls
    lines.push('- Call log:');
    for (const call of calls) {
      const inputSummary = Object.entries(call.input)
        .map(([k, v]) => `${k}="${String(v).slice(0, 60)}"`)
        .join(', ');
      lines.push(`  ${call.ts.slice(11,19)} [${call.tool}] ${inputSummary} → ${call.tokensEst} tokens, ${call.durationMs}ms`);
    }
    lines.push('');
  }

  return lines.join('\n');
}
