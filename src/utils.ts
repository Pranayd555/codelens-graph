import * as path from 'path';

export const CONFIG_WHITELIST = new Set([
  'package.json', 'tsconfig.json', 'jsconfig.json',
  'vite.config.ts', 'tailwind.config.js',
  'dockerfile', 'readme.md', 'pyproject.toml', 'go.mod',
  'jest.config.js', 'jest.config.ts',
  'vitest.config.ts', 'vitest.config.js',
  'playwright.config.ts',
  '.env.example',
  'nest-cli.json',
  'angular.json',
  'next.config.js', 'next.config.ts',
  'nuxt.config.ts',
  'requirements.txt', 'setup.py', 'poetry.lock',
  'cargo.toml', 'cargo.lock', 'go.sum',
  'package-lock.json'
]);

export function isNodeModulePath(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, '/');
  return normalized.includes('/node_modules/') || normalized.split('/').includes('node_modules');
}

export function isConfigPath(filePath: string): boolean {
  const name = path.basename(filePath).toLowerCase();
  
  // Whitelist check
  if (CONFIG_WHITELIST.has(name)) { return true; }
  
  // Pattern check for *.config.{ts,js,mjs,json}
  if (/\.config\.(ts|js|mjs|json)$/i.test(name)) { return true; }

  return false;
}

export function shouldIndexNodeModuleFile(filePath: string): boolean {
  const name = path.basename(filePath).toLowerCase();
  const normalized = filePath.replace(/\\/g, '/');
  const parts = normalized.split('/node_modules/');
  const afterNodeModules = parts[1] || '';
  if (!afterNodeModules) return false;

  // Always: package.json, readme.md
  if (name === 'package.json' || name === 'readme.md') return true;

  // .d.ts: only index.d.ts or types field entry points
  if (name.endsWith('.d.ts')) {
    const segs = afterNodeModules.split('/');
    const isScoped = segs[0]?.startsWith('@');
    const maxParts = isScoped ? 3 : 2; // e.g. @types/react/index.d.ts (3) vs lodash/index.d.ts (2)
    if (segs.length <= maxParts) {
      return true;
    }
  }

  return false;
}
