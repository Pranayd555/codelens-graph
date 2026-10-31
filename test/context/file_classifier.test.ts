import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { FileClassifier } from '../../src/context/fileClassifier';

const classifier = new FileClassifier();
const classify = (p: string) => classifier.classify(p);

describe('FileClassifier.classify', () => {
  // Each category is reachable both by a directory in the path and by the file name.
  const cases: Array<[string, string, string]> = [
    ['API routes / controllers', '/repo/src/routes/index.ts', '/repo/src/userController.ts'],
    ['API routes / controllers', '/repo/src/api/v1.ts', '/repo/src/eventHandler.ts'],
    ['Middleware', '/repo/src/middleware/index.ts', '/repo/src/authGuard.ts'],
    ['Middleware', '/repo/src/middlewares/index.ts', '/repo/src/logInterceptor.ts'],
    ['Services / business logic', '/repo/src/services/index.ts', '/repo/src/paymentService.ts'],
    ['Services / business logic', '/repo/src/domain/index.ts', '/repo/src/cacheManager.ts'],
    ['Data models / schemas', '/repo/src/models/index.ts', '/repo/src/userSchema.ts'],
    ['Data models / schemas', '/repo/src/db/index.ts', '/repo/src/addColumnMigration.ts'],
    ['Utility / helpers', '/repo/src/utils/index.ts', '/repo/src/stringHelper.ts'],
    ['Utility / helpers', '/repo/src/lib/index.ts', '/repo/src/common.ts'],
    ['Configuration', '/repo/src/config/index.ts', '/repo/src/appConfig.ts'],
    ['Configuration', '/repo/src/settings/index.ts', '/repo/src/constants.ts'],
    ['Frontend components', '/repo/src/components/index.ts', '/repo/src/dateWidget.tsx'],
    ['Frontend components', '/repo/src/pages/index.tsx', '/repo/src/homeView.tsx'],
    ['Template assets', '/repo/src/templates/index.ts', '/repo/src/mainLayout.ts'],
    ['Template assets', '/repo/src/themes/index.ts', '/repo/src/assetLoader.ts'],
    ['Tests', '/repo/src/tests/index.ts', '/repo/src/index.test.ts'],
    ['Tests', '/repo/src/__tests__/index.ts', '/repo/src/index.spec.ts'],
    ['Tests', '/repo/e2e/index.ts', '/repo/src/index_test.py'],
    ['Scripts / CLI', '/repo/scripts/index.ts', '/repo/src/seed.ts'],
    ['Scripts / CLI', '/repo/bin/index.js', '/repo/src/generateDocs.ts'],
    ['Authentication / security', '/repo/src/auth/index.ts', '/repo/src/jwt.ts'],
    ['Authentication / security', '/repo/src/security/index.ts', '/repo/src/oauthClient.ts'],
  ];

  for (const [label, byPath, byName] of cases) {
    it(`${label}: ${byPath} (path) and ${byName} (name)`, () => {
      assert.equal(classify(byPath), label);
      assert.equal(classify(byName), label);
    });
  }

  it('falls back to "Other"', () => {
    assert.equal(classify('/repo/src/index.ts'), 'Other');
    assert.equal(classify('/repo/main.py'), 'Other');
  });

  it('normalises Windows separators', () => {
    assert.equal(classify('C:\\repo\\src\\services\\index.ts'), 'Services / business logic');
    assert.equal(classify('C:\\repo\\src\\utils\\index.ts'), 'Utility / helpers');
    assert.equal(classify('C:\\repo\\src\\index.ts'), 'Other');
  });

  it('is case-insensitive', () => {
    assert.equal(classify('/repo/src/Services/Index.ts'), 'Services / business logic');
    assert.equal(classify('/repo/src/UserCONTROLLER.ts'), 'API routes / controllers');
  });

  it('uses category order: an earlier category wins over a later one', () => {
    // Routes come before Services, so a controller under services/ is a route.
    assert.equal(classify('/repo/src/services/userController.ts'), 'API routes / controllers');
    // Name patterns are substring matches.
    assert.equal(classify('/repo/src/pipeline.ts'), 'Middleware');
    assert.equal(classify('/repo/src/environment.ts'), 'Configuration');
  });

  it('only matches directory patterns on whole path segments (with a leading slash)', () => {
    // "utils/" at the very start of a relative path has no leading "/".
    assert.equal(classify('utils/index.ts'), 'Other');
    assert.equal(classify('/repo/myutilsdir2/index.ts'), 'Other');
  });

  it('classifies unit-test files as Tests, wherever they live', { todo: 'BUG: category order (fileClassifier.ts:13-69) puts *.test.* files under services/routes/... in that category instead of Tests' }, () => {
    assert.equal(classify('/repo/src/services/__tests__/emailService.test.ts'), 'Tests');
    assert.equal(classify('/repo/src/routes/auth.test.ts'), 'Tests');
    assert.equal(classify('/repo/test/userService.test.ts'), 'Tests');
  });
});

describe('FileClassifier.groupFiles', () => {
  it('groups by category, largest group first, keeping input order inside a group', () => {
    const groups = classifier.groupFiles([
      '/r/src/utils/a.ts',
      '/r/src/services/s1.ts',
      '/r/src/services/s2.ts',
      '/r/src/services/s3.ts',
      '/r/src/utils/b.ts',
      '/r/src/main.ts',
    ]);
    assert.deepEqual([...groups.keys()], ['Services / business logic', 'Utility / helpers', 'Other']);
    assert.deepEqual(groups.get('Services / business logic'), ['/r/src/services/s1.ts', '/r/src/services/s2.ts', '/r/src/services/s3.ts']);
    assert.deepEqual(groups.get('Utility / helpers'), ['/r/src/utils/a.ts', '/r/src/utils/b.ts']);
  });

  it('returns an empty map for no files', () => {
    assert.equal(classifier.groupFiles([]).size, 0);
  });
});

describe('FileClassifier.buildCategoryHint', () => {
  const files = [
    '/r/src/services/s1.ts', '/r/src/services/s2.ts', '/r/src/services/s3.ts',
    '/r/src/services/s4.ts', '/r/src/services/s5.ts',
    '/r/src/utils/u1.ts', '/r/src/utils/u2.ts',
    '/r/src/auth/login.ts',
    '/r/src/models/user.ts',
    '/r/src/main.ts',
  ];

  it('returns an empty string for no files', () => {
    assert.equal(classifier.buildCategoryHint([], ['anything']), '');
  });

  it('lists the largest category first with a count, up to 4 names and "+N more"', () => {
    const hint = classifier.buildCategoryHint(files, ['login']);
    const first = hint.split('\n')[0];
    assert.equal(first, '**Services / business logic** (5): s1.ts, s2.ts, s3.ts, s4.ts +1 more');
  });

  it('includes categories whose label or file paths match a task keyword', () => {
    const byPath = classifier.buildCategoryHint(files, ['login']);
    assert.match(byPath, /^\*\*Authentication \/ security\*\* \(1\): login\.ts$/m);
    const byLabel = classifier.buildCategoryHint(files, ['models']);
    assert.match(byLabel, /^\*\*Data models \/ schemas\*\* \(1\): user\.ts$/m);
  });

  it('pads with further categories (up to 4 lines) when fewer than 3 are relevant', () => {
    const small = ['/r/src/utils/u1.ts', '/r/src/auth/a.ts', '/r/src/models/m.ts', '/r/src/main.ts', '/r/src/services/s.ts'];
    const lines = classifier.buildCategoryHint(small, ['nomatch']).split('\n');
    assert.equal(lines.length, 4);
    assert.equal(new Set(lines).size, lines.length, 'no duplicated lines');
  });

  it('skips irrelevant categories once at least 3 are relevant', () => {
    // Enough relevant categories: no padding happens and irrelevant ones are skipped.
    const hint = classifier.buildCategoryHint(files, ['services', 'utils', 'auth', 'models']);
    const labels = hint.split('\n').map(l => l.match(/^\*\*(.+?)\*\*/)?.[1]);
    assert.deepEqual(labels, ['Services / business logic', 'Utility / helpers', 'Authentication / security', 'Data models / schemas']);
  });

  it('lists each category at most once', { todo: 'BUG: padding (fileClassifier.ts:125-131) re-adds a category already shown with 4+ files, because its 3-file entry text differs' }, () => {
    const hint = classifier.buildCategoryHint(files, ['nomatch']);
    const labels = hint.split('\n').map(l => l.match(/^\*\*(.+?)\*\*/)?.[1]);
    assert.equal(new Set(labels).size, labels.length, `duplicated category in:\n${hint}`);
  });
});
