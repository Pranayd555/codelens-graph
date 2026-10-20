import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { ASTParser } from '../src/ingestion/astParser';
import { GraphDB } from '../src/graph/graphDB';
import { GraphEdge } from '../src/types';

describe('CommonJS Require Ingestion & Scope Analysis', () => {
  const parser = new ASTParser();
  let tempDir: string;

  before(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codelens-cjs-test-'));
  });

  after(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  it('correctly parses destructured CommonJS require and prevents undefinedRefs', async () => {
    const filePath = path.join(tempDir, 'consumer.js');
    const content = `
const { dbAll, dbGet } = require('../utils/dbAsync');

async function fetchUsers() {
  const users = await dbAll('SELECT * FROM users');
  const user = await dbGet('SELECT * FROM users WHERE id = 1');
  return { users, user };
}
`;
    fs.writeFileSync(filePath, content);
    const parsed = await parser.parseFileAsync(filePath);

    // 1. Check import node emitted
    const importNodes = parsed.nodes.filter(n => n.type === 'import');
    assert.strictEqual(importNodes.length, 1, 'Should emit exactly 1 import node');
    assert.strictEqual(importNodes[0].name, '../utils/dbAsync', 'Import node name should be module path');
    assert.ok(importNodes[0].signature?.includes('dbAll'), 'Import node signature should include dbAll');
    assert.ok(importNodes[0].signature?.includes('dbGet'), 'Import node signature should include dbGet');

    // 2. Check import edge emitted
    const importEdges = parsed.edges.filter(e => e.type === 'imports');
    assert.strictEqual(importEdges.length, 1, 'Should emit 1 imports edge from file to import node');

    // 3. Ensure no invalid variable node with destructuring pattern name was created
    const varNodes = parsed.nodes.filter(n => n.type === 'variable');
    const invalidVar = varNodes.find(n => n.name.includes('{') || n.name.includes('dbAll') || n.name.includes('dbGet'));
    assert.strictEqual(invalidVar, undefined, 'Should not emit variable node for require statement or with { pattern } name');

    // 4. Ensure scope analysis does not mark dbAll or dbGet as undefinedRefs
    const fnNode = parsed.nodes.find(n => n.type === 'function' && n.name === 'fetchUsers');
    assert.ok(fnNode, 'fetchUsers function node should exist');
    assert.deepStrictEqual(fnNode.undefinedRefs ?? [], [], 'undefinedRefs should be empty');
  });

  it('correctly handles default/single identifier require', async () => {
    const filePath = path.join(tempDir, 'single_require.js');
    const content = `
const logger = require('./logger');

function logInfo(msg) {
  logger.info(msg);
}
`;
    fs.writeFileSync(filePath, content);
    const parsed = await parser.parseFileAsync(filePath);

    const importNode = parsed.nodes.find(n => n.type === 'import' && n.name === './logger');
    assert.ok(importNode, 'Import node for ./logger should exist');

    const fnNode = parsed.nodes.find(n => n.name === 'logInfo');
    assert.ok(fnNode, 'logInfo function should exist');
    assert.deepStrictEqual(fnNode.undefinedRefs ?? [], [], 'logger should be in-scope and not undefined');
  });

  it('correctly handles aliased destructuring in CommonJS require and resolves call edge', async () => {
    const wsDir = path.join(tempDir, 'alias-ws');
    const dotCodeLens = path.join(wsDir, '.codelens');
    const utilsDir = path.join(wsDir, 'utils');
    fs.mkdirSync(dotCodeLens, { recursive: true });
    fs.mkdirSync(utilsDir, { recursive: true });

    const dbPath = path.join(utilsDir, 'db.js');
    fs.writeFileSync(dbPath, `
function dbAll(query) { return []; }
module.exports = { dbAll };
`);

    const consumerPath = path.join(wsDir, 'consumer.js');
    // Prettier formatting with no space before colon: { dbAll: myDbAll }
    const content = `
const { dbAll: myDbAll } = require('./utils/db');

async function query() {
  return await myDbAll('SELECT 1');
}
`;
    fs.writeFileSync(consumerPath, content);

    const parsedDb = await parser.parseFileAsync(dbPath);
    const parsedConsumer = await parser.parseFileAsync(consumerPath);

    // Verify import node & scope
    const importNode = parsedConsumer.nodes.find(n => n.type === 'import' && n.name === './utils/db');
    assert.ok(importNode, 'Import node should exist');
    assert.ok(importNode.signature?.includes('dbAll: myDbAll'));

    const fnNode = parsedConsumer.nodes.find(n => n.name === 'query');
    assert.ok(fnNode, 'query function should exist');
    assert.deepStrictEqual(fnNode.undefinedRefs ?? [], [], 'myDbAll should be in-scope and not undefined');

    // Verify call edge resolution via GraphDB
    const graphDb = new GraphDB(dotCodeLens);
    await graphDb.init();
    graphDb.upsertNodes([...parsedDb.nodes, ...parsedConsumer.nodes]);
    graphDb.upsertEdges([...parsedDb.edges, ...parsedConsumer.edges]);
    graphDb.upsertCallRefs([...parsedDb.callRefs, ...parsedConsumer.callRefs]);
    await graphDb.resolveWorkspaceRelationships();

    const queryNode = parsedConsumer.nodes.find(n => n.name === 'query')!;
    const targetDbAll = parsedDb.nodes.find(n => n.name === 'dbAll')!;
    const calls = graphDb.getEdgesFrom(queryNode.id, 'calls');
    const aliasCallEdge = calls.find((e: GraphEdge) => e.toId === targetDbAll.id);

    assert.ok(aliasCallEdge, 'GraphDB should create a "calls" edge from query to dbAll through aliased require');

    graphDb.close();
  });

  it('does not create invalid variable node for non-require destructuring', async () => {
    const filePath = path.join(tempDir, 'non_require_destruct.js');
    const content = `
const { x, y } = getCoordinates();

function printCoords() {
  console.log(x, y);
}
`;
    fs.writeFileSync(filePath, content);
    const parsed = await parser.parseFileAsync(filePath);

    const invalidVar = parsed.nodes.find(n => n.name.includes('{') || n.name.includes('}'));
    assert.strictEqual(invalidVar, undefined, 'No variable node named { x, y } should be emitted');
  });

  it('does not mask real undefined warnings for unbound pattern identifiers or function-scoped requires', async () => {
    // Case 1: Key name in alias destructuring is not bound locally
    const file1 = path.join(tempDir, 'unbound_key.js');
    fs.writeFileSync(file1, `
const { dbAll: myDbAll } = require('./db');
function f() { return dbAll(); }
`);
    const parsed1 = await parser.parseFileAsync(file1);
    const fn1 = parsed1.nodes.find(n => n.name === 'f')!;
    assert.ok(fn1.undefinedRefs?.includes('dbAll'), 'dbAll should be flagged as undefined when only myDbAll was bound');

    // Case 2: Default value identifier in destructuring pattern is not an imported symbol
    const file2 = path.join(tempDir, 'unbound_default.js');
    fs.writeFileSync(file2, `
const { a = fallbackFn } = require('./x');
function g() { return fallbackFn(); }
`);
    const parsed2 = await parser.parseFileAsync(file2);
    const fn2 = parsed2.nodes.find(n => n.name === 'g')!;
    assert.ok(fn2.undefinedRefs?.includes('fallbackFn'), 'fallbackFn should be flagged as undefined');

    // Case 3: Require inside a local function should not leak to file-level scope
    const file3 = path.join(tempDir, 'scoped_require.js');
    fs.writeFileSync(file3, `
function lazy() {
  const { dbGet } = require('./db');
  return dbGet();
}
function other() {
  return dbGet();
}
`);
    const parsed3 = await parser.parseFileAsync(file3);
    const fnLazy = parsed3.nodes.find(n => n.name === 'lazy')!;
    assert.deepStrictEqual(fnLazy.undefinedRefs ?? [], [], 'lazy function should have no undefinedRefs');

    const fnOther = parsed3.nodes.find(n => n.name === 'other')!;
    assert.ok(fnOther.undefinedRefs?.includes('dbGet'), 'other function should flag dbGet as undefined');
  });

  it('resolves cross-file call edge via GraphDB when multiple files define the same symbol name', async () => {
    const wsDir = path.join(tempDir, 'collision-ws');
    const dotCodeLens = path.join(wsDir, '.codelens');
    const utilsDir = path.join(wsDir, 'utils');
    const legacyDir = path.join(wsDir, 'legacy');
    const controllersDir = path.join(wsDir, 'controllers');
    fs.mkdirSync(dotCodeLens, { recursive: true });
    fs.mkdirSync(utilsDir, { recursive: true });
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.mkdirSync(controllersDir, { recursive: true });

    // utils/dbAsync.js defines dbAll
    const dbAsyncPath = path.join(utilsDir, 'dbAsync.js');
    fs.writeFileSync(dbAsyncPath, `
function dbAll(sql) {
  return ['async'];
}
module.exports = { dbAll };
`);

    // legacy/db.js also defines dbAll (name collision)
    const legacyDbPath = path.join(legacyDir, 'db.js');
    fs.writeFileSync(legacyDbPath, `
function dbAll(sql) {
  return ['legacy'];
}
module.exports = { dbAll };
`);

    // userController.js requires specifically '../utils/dbAsync'
    const controllerPath = path.join(controllersDir, 'userController.js');
    fs.writeFileSync(controllerPath, `
const { dbAll } = require('../utils/dbAsync');

async function getUsers() {
  return dbAll('SELECT * FROM users');
}
`);

    // Parse all files
    const parsedDbAsync = await parser.parseFileAsync(dbAsyncPath);
    const parsedLegacyDb = await parser.parseFileAsync(legacyDbPath);
    const parsedController = await parser.parseFileAsync(controllerPath);

    // Initialize GraphDB
    const db = new GraphDB(dotCodeLens);
    await db.init();

    db.upsertNodes([...parsedDbAsync.nodes, ...parsedLegacyDb.nodes, ...parsedController.nodes]);
    db.upsertEdges([...parsedDbAsync.edges, ...parsedLegacyDb.edges, ...parsedController.edges]);
    db.upsertCallRefs([...parsedDbAsync.callRefs, ...parsedLegacyDb.callRefs, ...parsedController.callRefs]);

    // Resolve call edges across workspace
    await db.resolveWorkspaceRelationships();

    // Verify call edge was created from getUsers to utils/dbAsync.js dbAll (and NOT legacy/db.js)
    const getUsersNode = parsedController.nodes.find(n => n.name === 'getUsers')!;
    const correctDbAllNode = parsedDbAsync.nodes.find(n => n.name === 'dbAll')!;
    const legacyDbAllNode = parsedLegacyDb.nodes.find(n => n.name === 'dbAll')!;

    const outgoingCalls = db.getEdgesFrom(getUsersNode.id, 'calls');
    const edgeToCorrect = outgoingCalls.find((e: GraphEdge) => e.toId === correctDbAllNode.id);
    const edgeToLegacy = outgoingCalls.find((e: GraphEdge) => e.toId === legacyDbAllNode.id);

    assert.ok(edgeToCorrect, 'GraphDB should create a cross-file "calls" edge to utils/dbAsync.js');
    assert.strictEqual(edgeToLegacy, undefined, 'GraphDB should NOT link to legacy/db.js');

    db.close();
  });
});
