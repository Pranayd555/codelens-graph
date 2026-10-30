import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { PARSER_VERSION } from '../src/ingestion/astParser';
import { TestWorkspace } from './helpers';

// Unchanged files are normally skipped by size and mtime. When the parser's
// output changes, indexes built by an older parser must be re-parsed once.
describe('Re-parsing indexes built by an older parser', () => {
  const ws = new TestWorkspace();
  const service = 'src/service.js';
  const junk = { id: '', type: 'variable' as const, name: '{ stale }', line: 1, endLine: 1, language: 'javascript', updatedAt: 0, filePath: '' };

  before(async () => {
    ws.write('src/db.js', 'function dbAll() { return []; }\nmodule.exports = { dbAll };\n');
    ws.write(service, "const { dbAll } = require('./db');\nfunction list() { return dbAll(); }\nmodule.exports = { list };\n");
    junk.filePath = ws.path(service);
    junk.id = `${junk.filePath}::stale`;
    await ws.scan();
  });

  after(() => ws.close());

  const hasJunk = () => ws.db.getNodesByFile(ws.path(service)).some(n => n.name === '{ stale }');

  it('records the parser version after a full scan', () => {
    assert.equal(ws.db.getMetaValue('parser_version'), PARSER_VERSION);
  });

  it('skips unchanged files when the parser version matches', async () => {
    ws.db.upsertNodes([junk]);
    const result = await ws.scan();
    assert.equal(result.filesScanned, 0);
    assert.ok(hasJunk(), 'an unchanged file is not re-parsed');
  });

  it('re-parses unchanged files once when the index was built by another parser version', async () => {
    ws.db.setMetaValue('parser_version', '1');
    const result = await ws.scan();
    assert.ok(result.filesScanned >= 2, `expected every file re-parsed, got ${result.filesScanned}`);
    assert.ok(!hasJunk(), 'stale nodes from the old parser are replaced');
    assert.equal(ws.db.getMetaValue('parser_version'), PARSER_VERSION);
    assert.deepStrictEqual(ws.callsFrom('list'), ['dbAll@src/db.js']);

    const again = await ws.scan();
    assert.equal(again.filesScanned, 0, 'the next scan skips unchanged files again');
  });

  it('re-parses an index written before parser versions were recorded', async () => {
    (ws.db as any).db.run(`DELETE FROM meta WHERE key = 'parser_version'`);
    assert.equal(ws.db.getMetaValue('parser_version'), null);
    ws.db.upsertNodes([junk]);
    await ws.scan();
    assert.ok(!hasJunk());
    assert.equal(ws.db.getMetaValue('parser_version'), PARSER_VERSION);
  });
});
