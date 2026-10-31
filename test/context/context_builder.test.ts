import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { ContextBuilder } from '../../src/context/contextBuilder';
import { AgentContext } from '../../src/types';
import { TestWorkspace } from '../helpers';
import { insertFile, renderedSymbols, section, symbolsOf } from './fixtures';

// A small app: a mailer service, a route using it, a helper it forgets to
// import, a stale copy of the service, a config file and an installed package.
describe('ContextBuilder on a small app', () => {
  const ws = new TestWorkspace();
  let cb: ContextBuilder;

  before(async () => {
    ws.write('src/services/emailService.ts', [
      'export function sendEmail(to: string, body: string): boolean {',
      '  return formatBody(body).length > 0;',
      '}',
      'export function formatBody(b: string): string {',
      '  return b.trim();',
      '}',
      '',
    ].join('\n'));
    ws.write('src/routes/auth.ts', [
      "import { sendEmail } from '../services/emailService';",
      'export function registerUser(name: string) {',
      "  sendEmail(name, 'welcome');",
      '  return hashPassword(name);',
      '}',
      '',
    ].join('\n'));
    ws.write('src/utils/crypto.ts', 'export function hashPassword(p: string): string {\n  return p;\n}\n');
    ws.write('src/legacy/emailService.ts', 'export function sendEmail(x: string) {\n  return missingThing(x);\n}\n');
    ws.write('src/models/user.ts', 'export class User {\n  name = "";\n}\n');
    ws.write('vite.config.ts', 'export function emailConfig() {\n  return {};\n}\n');
    await ws.scan();
    // node_modules is never scanned; index a package as a pre-built index would.
    insertFile(ws.db, ws.path('node_modules/mailer/index.js'), [{ name: 'sendMailRaw', language: 'javascript', line: 1, endLine: 1 }], { language: 'javascript' });
    cb = new ContextBuilder(ws.db);
  });

  after(() => ws.close());

  describe('symbol selection and ordering', () => {
    it('selects the symbols named in the task plus their graph neighbours', () => {
      const ctx = cb.build('fix sendEmail in registerUser flow', 1, 5000);
      const names = symbolsOf(ctx);
      assert.equal(names.filter(n => n === 'sendEmail').length, 2, 'both copies of sendEmail');
      assert.ok(names.includes('registerUser'));
      assert.ok(names.includes('formatBody'), 'callee of sendEmail');
      assert.ok(names.includes('hashPassword'), 'callee of registerUser');
      assert.ok(!names.includes('User'), 'unrelated class');
      assert.ok(!names.includes('emailConfig'), 'config files are out of workspace scope');
      assert.ok(!names.includes('sendMailRaw'), 'node_modules is out of workspace scope');

      const entryNames = ctx.entryPoints.map(id => ws.db.getNode(id)?.name);
      assert.ok(entryNames.includes('sendEmail') && entryNames.includes('registerUser'));
      assert.ok(!entryNames.includes('formatBody'), 'neighbours are not entry points');
      assert.equal(ctx.depVisibility, 'hidden');
      assert.equal(ctx.taskDescription, 'fix sendEmail in registerUser flow');
    });

    it('ranks symbols named in the task above neighbours, and file/import nodes last', () => {
      const ctx = cb.build('fix sendEmail in registerUser flow', 1, 5000);
      const nodes = ctx.subgraph.nodes;
      const lastNamed = Math.max(...nodes.map((n, i) => (['sendEmail', 'registerUser'].includes(n.name) ? i : -1)));
      const firstNeighbour = nodes.findIndex(n => n.name === 'formatBody' || n.name === 'hashPassword');
      assert.ok(lastNamed < firstNeighbour, `order: ${nodes.map(n => n.name).join(', ')}`);
      const firstStructural = nodes.findIndex(n => n.type === 'file' || n.type === 'import');
      assert.ok(nodes.slice(firstStructural).every(n => n.type === 'file' || n.type === 'import'));
    });

    it('renders symbols in the same order as the subgraph', () => {
      const ctx = cb.build('fix sendEmail in registerUser flow', 1, 5000);
      assert.deepEqual(renderedSymbols(cb.buildSystemPromptInjection(ctx)), symbolsOf(ctx));
    });

    it('finds nothing for a task made only of stop words', () => {
      const ctx = cb.build('please fix the code and make it build', 2, 2000);
      assert.deepEqual(ctx.entryPoints, []);
      assert.deepEqual(ctx.subgraph.nodes, []);
      assert.deepEqual(ctx.warnings, []);
      assert.deepEqual(ctx.diagnoses, []);
      const out = cb.buildSystemPromptInjection(ctx);
      assert.equal(section(out, 'Relevant symbols')?.trim(), '');
      assert.equal(section(out, 'Existing symbols'), null);
      assert.ok(section(out, 'All workspace files'), 'the file overview is still there');
    });
  });

  describe('scope', () => {
    it('"workspace" hides node_modules and config files', () => {
      const ctx = cb.build('email mailer sendMailRaw emailConfig', 1, 5000, 'short', 'workspace');
      assert.ok(ctx.subgraph.nodes.every(n => !n.filePath.includes('node_modules') && !n.filePath.endsWith('vite.config.ts')));
      assert.ok(ctx.existingFiles.every(f => !f.includes('node_modules') && !f.endsWith('vite.config.ts')));
      assert.equal(ctx.existingFiles.length, 5);
      assert.equal(ctx.depVisibility, 'hidden');
    });

    it('"deps" keeps only node_modules and config files', () => {
      const ctx = cb.build('sendMailRaw', 1, 5000, 'short', 'deps');
      assert.deepEqual(symbolsOf(ctx), ['sendMailRaw']);
      assert.deepEqual(ctx.existingFiles.map(f => path.basename(f)).sort(), ['index.js', 'vite.config.ts']);
      assert.equal(ctx.depVisibility, 'full');
    });

    it('"all" includes workspace, node_modules and config symbols', () => {
      const ctx = cb.build('sendEmail sendMailRaw emailConfig', 0, 5000, 'short', 'all');
      const names = symbolsOf(ctx);
      for (const n of ['sendEmail', 'sendMailRaw', 'emailConfig']) { assert.ok(names.includes(n), n); }
      assert.equal(ctx.existingFiles.length, 7);
      assert.equal(ctx.depVisibility, 'full');
    });

    it('"deps" finds symbols defined in config files', { todo: 'BUG: deps search SQL (graphDB.ts:731) only matches node_modules/.json/.md paths, so vite.config.ts symbols are never entry points although contextBuilder.ts:62-63 treats config files as deps' }, () => {
      const ctx = cb.build('emailConfig', 0, 5000, 'short', 'deps');
      assert.deepEqual(symbolsOf(ctx), ['emailConfig']);
    });
  });

  describe('diagnoses', () => {
    it('points an undefined reference to its definition with a ready import', () => {
      const ctx = cb.build('registerUser', 0, 5000);
      const d = ctx.diagnoses.find(x => x.symbol === 'hashPassword');
      assert.ok(d, 'diagnosis for hashPassword');
      assert.equal(d.severity, 'error');
      assert.equal(d.type, 'undefined_ref');
      assert.equal(d.message, '"registerUser" uses "hashPassword" which is not imported or declared');
      assert.equal(path.normalize(d.filePath), path.normalize(ws.path('src/routes/auth.ts')));
      assert.equal(d.line, 2);
      assert.equal(d.suggestion, `"hashPassword" is defined in ${ws.node('hashPassword').filePath}:1. Add: import { hashPassword } from '../utils/crypto';`);
    });

    it('says when an undefined reference is not defined anywhere', () => {
      const ctx = cb.build('legacy sendEmail', 0, 5000);
      const d = ctx.diagnoses.find(x => x.symbol === 'missingThing');
      assert.ok(d);
      assert.equal(d.suggestion, '"missingThing" is not defined anywhere in the codebase — check spelling or add the definition');
    });

    it('renders errors with fixes and flags undefined refs on the symbol', () => {
      const ctx = cb.build('registerUser', 0, 5000);
      const out = cb.buildSystemPromptInjection(ctx);
      const errors = section(out, 'Errors to fix')!;
      assert.match(errors, /^- \*\*"registerUser" uses "hashPassword" which is not imported or declared\*\*$/m);
      assert.match(errors, /^ {2}→ Fix: "hashPassword" is defined in .*crypto\.ts:1\. Add: import \{ hashPassword \} from '\.\.\/utils\/crypto';$/m);
      assert.match(section(out, 'Relevant symbols')!, /^- \*\*⚠️ Undefined refs:\*\* `hashPassword`$/m);
    });

    it('warns about a symbol that exists in several files', () => {
      const ctx = cb.build('sendEmail', 0, 5000);
      const dups = ctx.diagnoses.filter(d => d.type === 'duplicate_symbol');
      assert.equal(dups.length, 2, 'one per copy');
      for (const d of dups) {
        assert.equal(d.severity, 'warning');
        assert.equal(d.symbol, 'sendEmail');
        assert.match(d.message, /^"sendEmail" \(function\) exists in 2 places: /);
      }
      assert.match(section(cb.buildSystemPromptInjection(ctx), 'Warnings')!, /^- "sendEmail" \(function\) exists in 2 places/m);
    });

    it('recommends one and the same copy of a duplicated symbol', { todo: 'BUG: contextBuilder.ts:268 suggests "Use the existing one at <this node>", so each copy tells the agent to use itself' }, () => {
      const ctx = cb.build('sendEmail', 0, 5000);
      const suggestions = new Set(ctx.diagnoses.filter(d => d.type === 'duplicate_symbol').map(d => d.suggestion));
      assert.equal(suggestions.size, 1, [...suggestions].join('\n'));
    });

    it('lists duplicate locations as short paths', { todo: 'BUG: contextBuilder.ts:258 splits on "/" only, so on Windows the whole absolute path is printed' }, () => {
      const ctx = cb.build('sendEmail', 0, 5000);
      for (const d of ctx.diagnoses.filter(x => x.type === 'duplicate_symbol')) {
        assert.ok(!d.message.includes(ws.root), d.message);
        assert.match(d.message, /exists in 2 places: (legacy|services)\/emailService\.ts:1$/);
      }
    });
  });

  describe('"Existing symbols — do not recreate"', () => {
    it('warns for each symbol named in the task with its location, callers and export status', () => {
      const ctx = cb.build('fix sendEmail', 0, 5000);
      const services = ctx.warnings.find(w => w.includes('services/emailService.ts'));
      assert.ok(services);
      assert.equal(services.split('\n')[0], '"sendEmail" (function) already exists at .../src/services/emailService.ts:1');
      assert.match(services, /\n {4}Signature: function sendEmail\(to: string, body: string\): boolean \{/);
      assert.match(services, /\n {4}Called by: registerUser/);
      assert.match(services, /\n {4}Already exported — import it, do not recreate/);
      const legacy = ctx.warnings.find(w => w.includes('legacy/emailService.ts'));
      assert.ok(legacy && !legacy.includes('Called by'), 'no callers for the stale copy');

      const out = cb.buildSystemPromptInjection(ctx);
      const sec = section(out, 'Existing symbols — do not recreate')!;
      assert.match(sec, /^- "sendEmail" \(function\) already exists at \.\.\.\/src\/services\/emailService\.ts:1$/m);
    });

    it('warns about existing files whose name matches the task, with their category', () => {
      const ctx = cb.build('crypto hashing', 0, 5000);
      assert.ok(ctx.warnings.includes('File already exists [Utility / helpers]: .../src/utils/crypto.ts'), ctx.warnings.join('\n'));
      assert.equal(new Set(ctx.warnings).size, ctx.warnings.length, 'no duplicates');
    });

    it('omits the section when nothing matches', () => {
      // Matches formatBody by name and sendEmail by signature, names neither.
      const ctx = cb.build('format body text', 0, 5000);
      assert.ok(symbolsOf(ctx).includes('formatBody'));
      assert.deepEqual(ctx.warnings, []);
      assert.equal(section(cb.buildSystemPromptInjection(ctx), 'Existing symbols'), null);
    });
  });

  describe('rendering', () => {
    it('describes each symbol: location, import, signature, params, callers and callees', () => {
      const ctx = cb.build('fix sendEmail in registerUser flow', 1, 5000);
      const out = cb.buildSystemPromptInjection(ctx);
      assert.match(out, /^## Codebase Context \(CodeLens Graph\)$/m);
      assert.match(out, /^Token estimate: ~\d+$/m);
      const block = out.split('\n#### ').find(b => b.startsWith('[function] `sendEmail`') && b.includes('services/'))!;
      assert.match(block, /^- \*\*Location:\*\* `\.\.\.\/src\/services\/emailService\.ts:1`$/m);
      assert.match(block, /^- \*\*Import as:\*\* `import \{ sendEmail \} from '\.\/src\/services\/emailService';` \(path from workspace root\)$/m);
      assert.match(block, /^- \*\*Signature:\*\* `function sendEmail\(to: string, body: string\): boolean \{`$/m);
      assert.match(block, /^- \*\*Params:\*\* `to: string`, `body: string`$/m);
      assert.match(block, /^- \*\*Used by:\*\* registerUser$/m);
      assert.match(block, /^- \*\*Calls:\*\* formatBody$/m);
      for (const title of ['Relevant symbols', 'Existing symbols']) {
        assert.doesNotMatch(section(out, title)!, /\\/, `no backslash paths in "${title}"`);
      }
    });

    it('short mode has no snippets; deep mode adds fenced source for each symbol', () => {
      const short = cb.build('registerUser', 0, 5000, 'short');
      const shortOut = cb.buildSystemPromptInjection(short, 'short');
      assert.doesNotMatch(shortOut, /Snippet:|```/);

      const deep = cb.build('registerUser', 0, 5000, 'deep');
      const deepOut = cb.buildSystemPromptInjection(deep, 'deep');
      assert.match(deepOut, /- \*\*Snippet:\*\*\n```typescript\nexport function registerUser\(name: string\) \{\n {2}sendEmail\(name, 'welcome'\);\n {2}return hashPassword\(name\);\n\}\n```/);
      assert.ok(deep.tokenEstimate > short.tokenEstimate, 'snippets cost tokens');
    });

    it('lists file categories at the top and all files at the bottom', () => {
      const ctx = cb.build('email', 0, 5000);
      const out = cb.buildSystemPromptInjection(ctx);
      const map = section(out, 'File map (by category)')!;
      assert.match(map, /^\*\*Services \/ business logic\*\* \(2\): emailService\.ts, emailService\.ts$/m);
      const all = section(out, 'All workspace files')!;
      for (const line of ['**Services / business logic:** emailService.ts, emailService.ts', '**API routes / controllers:** auth.ts', '**Utility / helpers:** crypto.ts', '**Data models / schemas:** user.ts']) {
        assert.ok(all.split('\n').includes(line), `${line}\n---\n${all}`);
      }
      assert.ok(!all.includes('vite.config.ts'), 'config files are not workspace files');
      assert.ok(out.indexOf('### File map') < out.indexOf('### Relevant symbols'));
      assert.ok(out.trimEnd().endsWith(all.trimEnd()), 'file list is the last section');
    });

    it('serialize() is the same text as buildSystemPromptInjection()', () => {
      const ctx = cb.build('sendEmail', 1, 5000, 'deep');
      assert.equal(cb.serialize(ctx), cb.buildSystemPromptInjection(ctx));
      assert.equal(cb.serialize(ctx, 'deep'), cb.buildSystemPromptInjection(ctx, 'deep'));
    });

    it('tokenEstimate matches the size of the rendered text', () => {
      for (const mode of ['short', 'deep'] as const) {
        const ctx = cb.build('fix sendEmail in registerUser flow', 2, 5000, mode);
        const rendered = cb.buildSystemPromptInjection(ctx, mode);
        // The estimate is taken before its own value is printed in the header.
        assert.ok(Math.abs(ctx.tokenEstimate - Math.ceil(rendered.length / 4)) <= 2, `${ctx.tokenEstimate} vs ${rendered.length / 4}`);
      }
    });

    it('lists dependency and config metadata when depVisibility is "metadata"', () => {
      insertFile(ws.db, ws.path('node_modules/mailer/package.json'), [], { signature: 'mailer@2.1.0' });
      insertFile(ws.db, ws.path('node_modules/@types/mailer/index.d.ts'), []);
      const ctx: AgentContext = { ...cb.build('nothing relevant here', 0, 5000), depVisibility: 'metadata' };
      const deps = section(cb.buildSystemPromptInjection(ctx), 'Dependencies & Configurations (metadata-only)')!;
      const lines = deps.split('\n').filter(Boolean);
      assert.ok(lines.includes('- node_modules/mailer (mailer@2.1.0)'), deps);
      assert.ok(lines.includes('- node_modules/@types/mailer/index.d.ts (type definitions)'), deps);
      assert.ok(lines.includes('- vite.config.ts (config)'), deps);
      assert.ok(!deps.includes('index.js'), 'plain package sources are not listed');
      assert.equal(section(cb.buildSystemPromptInjection({ ...ctx, depVisibility: 'hidden' }), 'Dependencies & Configurations'), null);
    });
  });
});
