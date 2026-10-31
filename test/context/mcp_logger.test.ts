import { describe, it, afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { MCPLogger, ToolCallLog, readRecentLogs, formatUsageReport } from '../../src/mcp/mcpLogger';
import { makeTempDir } from './fixtures';

const logFile = (root: string) => path.join(root, '.codelens', 'mcp-usage.jsonl');

const readLines = (root: string): ToolCallLog[] =>
  fs.readFileSync(logFile(root), 'utf-8').split('\n').filter(Boolean).map(l => JSON.parse(l));

function entry(partial: Partial<ToolCallLog>): ToolCallLog {
  return {
    ts: '2026-01-02T03:04:05.000Z', tool: 'codelens_search', input: {}, outputLen: 40,
    tokensEst: 10, durationMs: 5, sessionId: 's1', ...partial,
  };
}

describe('MCPLogger', () => {
  let tmp: ReturnType<typeof makeTempDir>;
  beforeEach(() => { tmp = makeTempDir('codelens-log-'); });
  afterEach(() => tmp.cleanup());

  it('creates <workspace>/.codelens and appends one JSON line per call', () => {
    const logger = new MCPLogger(tmp.dir);
    assert.ok(fs.statSync(path.join(tmp.dir, '.codelens')).isDirectory());
    logger.log('codelens_triage', { task: 'x' }, 'abcde', 7);
    logger.log('codelens_search', { query: 'foo', limit: 5 }, '', 3);

    const raw = fs.readFileSync(logFile(tmp.dir), 'utf-8');
    assert.ok(raw.endsWith('\n'));
    const [a, b] = readLines(tmp.dir);
    assert.deepEqual(Object.keys(a).sort(), ['durationMs', 'input', 'outputLen', 'sessionId', 'tokensEst', 'tool', 'ts']);
    assert.equal(a.tool, 'codelens_triage');
    assert.deepEqual(a.input, { task: 'x' });
    assert.equal(a.outputLen, 5);
    assert.equal(a.tokensEst, 2, 'ceil(5 / 4)');
    assert.equal(a.durationMs, 7);
    assert.ok(!Number.isNaN(Date.parse(a.ts)));
    assert.equal(b.tokensEst, 0);
    assert.deepEqual(b.input, { query: 'foo', limit: 5 });
    assert.equal(a.sessionId, b.sessionId, 'one logger = one session');
    assert.ok(a.sessionId.length > 0);
  });

  it('appends to an existing log rather than replacing it', () => {
    new MCPLogger(tmp.dir).log('codelens_status', {}, 'x', 1);
    new MCPLogger(tmp.dir).log('codelens_status', {}, 'y', 1);
    assert.equal(readLines(tmp.dir).length, 2);
  });

  it('truncates long string inputs to 200 characters and keeps other values', () => {
    const logger = new MCPLogger(tmp.dir);
    const long = 'q'.repeat(500);
    logger.log('codelens_context', { task: long, exact: 'e'.repeat(200), depth: 3, flags: ['a'] }, 'out', 1);
    const [line] = readLines(tmp.dir);
    assert.equal(line.input.task, 'q'.repeat(200) + '…');
    assert.equal(line.input.exact, 'e'.repeat(200));
    assert.equal(line.input.depth, 3);
    assert.deepEqual(line.input.flags, ['a']);
  });

  it('never throws when the log cannot be written', () => {
    const logger = new MCPLogger(tmp.dir);
    fs.mkdirSync(logFile(tmp.dir)); // a directory where the log file should be
    assert.doesNotThrow(() => logger.log('codelens_status', {}, 'x', 1));
    assert.doesNotThrow(() => logger.summarise());
  });

  describe('summarise', () => {
    it('prints this session\'s totals and savings to stderr', (t) => {
      const errors: string[] = [];
      t.mock.method(console, 'error', (msg: string) => { errors.push(msg); });
      // Another session's line in the same file is ignored.
      fs.mkdirSync(path.join(tmp.dir, '.codelens'), { recursive: true });
      fs.writeFileSync(logFile(tmp.dir), JSON.stringify(entry({ sessionId: 'other-session', tokensEst: 9999 })) + '\nnot json\n');

      const logger = new MCPLogger(tmp.dir);
      logger.log('codelens_triage', {}, 'x'.repeat(40), 1);   // 10 tokens
      logger.log('codelens_context', {}, 'x'.repeat(400), 1); // 100 tokens
      logger.log('codelens_search', {}, 'x'.repeat(8), 1);    // 2 tokens
      logger.log('codelens_search', {}, 'x'.repeat(8), 1);    // 2 tokens
      logger.summarise();

      const out = errors.join('\n');
      assert.match(out, /Tool calls: 4\b/);
      assert.match(out, /Tokens used: ~114\b/);
      assert.match(out, /Tokens saved vs raw file reads: ~2600\b/, '1 context × 1800 + 2 search × 400');
      assert.match(out, /codelens_search×2/);
      assert.match(out, /codelens_triage×1/);
      assert.doesNotMatch(out, /skipped codelens_triage/);
    });

    it('warns when more than two calls skipped triage', (t) => {
      const errors: string[] = [];
      t.mock.method(console, 'error', (msg: string) => { errors.push(msg); });
      const logger = new MCPLogger(tmp.dir);
      for (let i = 0; i < 3; i++) { logger.log('codelens_search', {}, 'x', 1); }
      logger.summarise();
      assert.match(errors.join('\n'), /skipped codelens_triage/);
    });

    it('is silent with no log file or no calls in this session', (t) => {
      const errors: string[] = [];
      t.mock.method(console, 'error', (msg: string) => { errors.push(msg); });
      const logger = new MCPLogger(tmp.dir);
      logger.summarise();
      fs.writeFileSync(logFile(tmp.dir), JSON.stringify(entry({ sessionId: 'someone-else' })) + '\n');
      logger.summarise();
      assert.deepEqual(errors, []);
    });
  });
});

describe('readRecentLogs', () => {
  let tmp: ReturnType<typeof makeTempDir>;
  beforeEach(() => { tmp = makeTempDir('codelens-log-'); });
  afterEach(() => tmp.cleanup());

  const writeLog = (lines: string[]) => {
    fs.mkdirSync(path.join(tmp.dir, '.codelens'), { recursive: true });
    fs.writeFileSync(logFile(tmp.dir), lines.join('\n') + '\n');
  };

  it('returns [] when there is no log', () => {
    assert.deepEqual(readRecentLogs(tmp.dir), []);
  });

  it('returns the last `limit` entries, oldest first', () => {
    writeLog(Array.from({ length: 10 }, (_, i) => JSON.stringify(entry({ tool: `t${i}` }))));
    assert.deepEqual(readRecentLogs(tmp.dir, 3).map(l => l.tool), ['t7', 't8', 't9']);
    assert.equal(readRecentLogs(tmp.dir).length, 10, 'default limit (100) covers all');
    assert.equal(readRecentLogs(tmp.dir, 50).length, 10);
  });

  it('skips corrupt and blank lines', () => {
    writeLog([
      JSON.stringify(entry({ tool: 'a' })),
      '{"truncated": ',
      '',
      'garbage',
      JSON.stringify(entry({ tool: 'b' })),
    ]);
    assert.deepEqual(readRecentLogs(tmp.dir).map(l => l.tool), ['a', 'b']);
  });

  it('applies the limit before dropping corrupt lines', () => {
    // Documents current behaviour: corrupt lines use up part of the limit.
    writeLog([JSON.stringify(entry({ tool: 'a' })), JSON.stringify(entry({ tool: 'b' })), 'garbage']);
    assert.deepEqual(readRecentLogs(tmp.dir, 2).map(l => l.tool), ['b']);
  });

  it('handles CRLF line endings', () => {
    fs.mkdirSync(path.join(tmp.dir, '.codelens'), { recursive: true });
    fs.writeFileSync(logFile(tmp.dir), JSON.stringify(entry({ tool: 'a' })) + '\r\n' + JSON.stringify(entry({ tool: 'b' })) + '\r\n');
    assert.deepEqual(readRecentLogs(tmp.dir).map(l => l.tool), ['a', 'b']);
  });

  it('returns [] when the log path is unreadable', () => {
    fs.mkdirSync(logFile(tmp.dir), { recursive: true });
    assert.deepEqual(readRecentLogs(tmp.dir), []);
  });

  it('round-trips what MCPLogger writes', () => {
    const logger = new MCPLogger(tmp.dir);
    logger.log('codelens_triage', { task: 't' }, 'abcd', 2);
    logger.log('codelens_node', { id: 'n' }, 'abcdefgh', 4);
    const logs = readRecentLogs(tmp.dir);
    assert.deepEqual(logs.map(l => [l.tool, l.tokensEst, l.durationMs]), [['codelens_triage', 1, 2], ['codelens_node', 2, 4]]);
  });
});

describe('formatUsageReport', () => {
  it('explains how to connect when there are no calls', () => {
    const report = formatUsageReport([]);
    assert.match(report, /^No MCP tool calls recorded yet\./);
    assert.doesNotMatch(report, /# CodeLens MCP Usage Report/);
  });

  const logs: ToolCallLog[] = [
    entry({ sessionId: 'old', ts: '2026-01-01T10:00:00.000Z', tool: 'codelens_triage', tokensEst: 3, durationMs: 1, input: { task: 'find auth' } }),
    entry({ sessionId: 'old', ts: '2026-01-01T10:00:05.000Z', tool: 'codelens_context', tokensEst: 500, durationMs: 20, input: { task: 'z'.repeat(100) } }),
    entry({ sessionId: 'old', ts: '2026-01-01T10:00:09.000Z', tool: 'codelens_search', tokensEst: 40, durationMs: 4, input: { query: 'auth', limit: 5 } }),
    entry({ sessionId: 'old', ts: '2026-01-01T10:00:10.000Z', tool: 'codelens_search', tokensEst: 60, durationMs: 6, input: { query: 'login' } }),
    entry({ sessionId: 'new', ts: '2026-02-03T08:30:00.000Z', tool: 'mystery_tool', tokensEst: 7, durationMs: 2, input: {} }),
  ];

  const sessionBlock = (report: string, n: number) => report.split(/\n(?=## Session )/).find(b => b.startsWith(`## Session ${n} `))!;

  it('reports totals across sessions', () => {
    const report = formatUsageReport(logs);
    assert.match(report, /^# CodeLens MCP Usage Report$/m);
    assert.match(report, /^Total calls: 5 across 2 session\(s\)$/m);
  });

  it('lists the most recent session first, headed by its first call time', () => {
    const report = formatUsageReport(logs);
    assert.match(sessionBlock(report, 1), /^## Session 1 — 2026-02-03 08:30$/m);
    assert.match(sessionBlock(report, 2), /^## Session 2 — 2026-01-01 10:00$/m);
  });

  it('sums tokens and duration and estimates savings per session', () => {
    const old = sessionBlock(formatUsageReport(logs), 2);
    assert.match(old, /^- Calls: 4 \| Tokens used: ~603 \| Duration: 31ms$/m);
    assert.match(old, /^- Estimated tokens saved vs file reading: ~2600$/m, '1 context × 1800 + 2 search × 400');
    assert.match(old, /^- Triage used: ✅ yes$/m);

    const recent = sessionBlock(formatUsageReport(logs), 1);
    assert.match(recent, /^- Calls: 1 \| Tokens used: ~7 \| Duration: 2ms$/m);
    assert.match(recent, /^- Estimated tokens saved vs file reading: ~0$/m);
    assert.match(recent, /^- Triage used: ❌ no/m);
  });

  it('breaks calls down per tool, most used first', () => {
    const old = sessionBlock(formatUsageReport(logs), 2);
    const tools = [...old.matchAll(/^ {2}· (\S+) ×(\d+)/gm)].map(m => `${m[1]}×${m[2]}`);
    assert.equal(tools[0], 'codelens_search×2');
    assert.deepEqual(new Set(tools), new Set(['codelens_search×2', 'codelens_triage×1', 'codelens_context×1']));
    // Unknown tools fall back to the default per-call estimate.
    assert.match(sessionBlock(formatUsageReport(logs), 1), /· mystery_tool ×1 \(~50 tokens\)/);
  });

  it('lists every call with its time, tool, trimmed input and cost', () => {
    const old = sessionBlock(formatUsageReport(logs), 2);
    assert.match(old, /^ {2}10:00:00 \[codelens_triage\] task="find auth" → 3 tokens, 1ms$/m);
    assert.match(old, /^ {2}10:00:09 \[codelens_search\] query="auth", limit="5" → 40 tokens, 4ms$/m);
    assert.match(old, new RegExp(`task="${'z'.repeat(60)}" → 500 tokens`), 'input values are cut to 60 characters');
  });

  it('per-tool token figures agree with the session\'s "Tokens used"', { todo: 'BUG: mcpLogger.ts:403-404 prices the tool breakdown from a static table (TOOL_TOKEN_COST), not the logged tokensEst' }, () => {
    const old = sessionBlock(formatUsageReport(logs), 2);
    const total = Number(old.match(/Tokens used: ~(\d+)/)![1]);
    const perTool = [...old.matchAll(/^ {2}· \S+ ×\d+ \(~(\d+) tokens\)$/gm)].reduce((s, m) => s + Number(m[1]), 0);
    assert.equal(perTool, total);
  });
});
