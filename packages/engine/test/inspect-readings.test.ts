/**
 * The inspect tool's project and frontend analyzers: facts decide in code
 * (manifests, lockfiles, Prisma model names, declared frameworks, Tailwind
 * variants, React error boundary methods), and what the files do not settle
 * is read by engine.tools.project-tooling and engine.tools.frontend-finding.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  declaredApiFrameworks,
  detectProject,
  generateApiSpec,
  inspectApi,
  inspectApiSync,
  parsePrismaSchema,
  validateApiSpec,
} from '../sdk/src/platform/tools/inspect/project.ts';
import {
  inspectAccessibility,
  inspectClientBoundary,
  inspectErrorBoundary,
  inspectHooks,
  inspectOverflow,
  inspectResponsive,
  inspectSizing,
  inspectStacking,
  inspectTailwind,
} from '../sdk/src/platform/tools/inspect/frontend.ts';
import { useToolReadings } from './_helpers/tool-readings.ts';

const readings = useToolReadings([
  ['"manifests":["package.json","Cargo.toml"]', { projectType: 'rust' }],
  ['"lockfiles":[]', { packageManager: 'bun', testFramework: 'bun' }],
  ['"line":"<img src={photo} />"', { finding: true }],
  ['"line":"<div className=\\"overflow-y-auto\\">"', { finding: 'uncertain' }],
  ['"line":"<main className=\\"w-[1200px]\\">"', { finding: true }],
  ['fetchResults(query)', { finding: true }],
  ['"module":"next/headers"', { finding: true }],
  ['"value":"z-50 / z-index: 50"', { finding: true }],
  ['"file":"server/app.js"', { entryPoint: true }],
  ['"file":"src/index.ts"', { entryPoint: 'uncertain' }],
  [`"line":"app.get('/health', handler);"`, { route: true }],
  [`"line":"router.post('/login', login);"`, { route: 'uncertain' }],
  ['"file":"pages/api/cart.ts"', { serves: ['POST', 'DELETE'] }],
]);

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'gv-inspect-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const write = (file: string, content: string) => {
  mkdirSync(join(root, file, '..'), { recursive: true });
  writeFileSync(join(root, file), content);
};

describe('detectProject', () => {
  test('one manifest and one lockfile are facts; only the test runner is read', async () => {
    write(
      'package.json',
      JSON.stringify({ name: 'shop', scripts: { test: 'vitest run' }, devDependencies: { vitest: '1' } }),
    );
    write('pnpm-lock.yaml', '');
    const info = await detectProject(root);
    expect(info.type).toBe('nodejs');
    expect(info.packageManager).toBe('pnpm');
    expect(info.testFramework).toBeUndefined(); // the fake reads 'none'
    expect(readings.requests).toHaveLength(1);
    expect(Object.keys(readings.requests[0]?.questions ?? {})).toEqual(['test_framework']);
  });

  test('the corepack packageManager field settles the package manager', async () => {
    write('package.json', JSON.stringify({ packageManager: 'yarn@4.1.0' }));
    write('package-lock.json', '{}');
    write('bun.lock', '');
    expect((await detectProject(root)).packageManager).toBe('yarn');
  });

  test('no lockfile: the package manager and test runner are read', async () => {
    write('package.json', JSON.stringify({ scripts: { test: 'bun test' } }));
    const info = await detectProject(root);
    expect(info.packageManager).toBe('bun');
    expect(info.testFramework).toBe('bun:test');
  });

  test('several manifests: the main ecosystem is read with source file counts', async () => {
    write('package.json', JSON.stringify({ scripts: { docs: 'vitepress build' } }));
    write('Cargo.toml', '[package]');
    write('src/lib.rs', '');
    const info = await detectProject(root);
    expect(info.type).toBe('rust');
    expect(info.packageManager).toBe('none');
    const state = readings.requests[0]!.state as { sourceFiles: Record<string, number> };
    expect(state.sourceFiles['.rs']).toBe(1);
  });

  test('entry points package.json declares are facts: main, bin and exports targets except types', async () => {
    write(
      'package.json',
      JSON.stringify({
        main: './dist/index.js',
        bin: { tool: './bin/tool.js' },
        exports: { '.': { types: './dist/index.d.ts', import: './dist/index.js' }, './cli': './dist/cli.js' },
      }),
    );
    write('src/index.ts', '');
    const info = await detectProject(root);
    expect(info.entryPoints).toEqual(['dist/index.js', 'bin/tool.js', 'dist/cli.js']);
    expect(readings.requests.flatMap((request) => Object.keys(request.questions ?? {}))).not.toContain('entry_point');
  });

  test('with no declared entry point, root, src and script-named files are read; only a yes that acts is listed', async () => {
    write('package.json', JSON.stringify({ scripts: { start: 'node server/app.js' } }));
    write('server/app.js', "require('http').createServer().listen(3000);\n");
    write('src/index.ts', 'export const x = 1;\n');
    write('vite.config.ts', 'export default {};\n');
    write('README.md', '# app\n');
    const info = await detectProject(root);
    expect(info.entryPoints).toEqual(['server/app.js']);
    const asked = readings.requests
      .filter((request) => 'entry_point' in (request.questions ?? {}))
      .map((request) => (request.state as { file: string }).file);
    expect(asked.sort()).toEqual(['server/app.js', 'src/index.ts', 'vite.config.ts']);
  });

  test('a project with no manifest asks nothing', async () => {
    expect((await detectProject(root)).type).toBe('unknown');
    expect(readings.requests).toHaveLength(0);
  });
});

describe('parsePrismaSchema', () => {
  test('a field is a relation only when its type is a declared model', () => {
    const info = parsePrismaSchema(
      'model User {\n  id String @id\n  posts Post[]\n  createdAt DateTime\n}\nmodel Post {\n  id String @id\n  author User\n}\n',
    );
    const user = info.models.find((model) => model.name === 'User')!;
    expect(user.fields.map((field) => [field.name, field.isRelation])).toEqual([
      ['id', false],
      ['posts', true],
      ['createdAt', false],
    ]);
  });
});

describe('inspectApi auto', () => {
  test('scans every declared framework, not the first in a fixed order', async () => {
    write('package.json', JSON.stringify({ dependencies: { next: '14', express: '4' } }));
    write('app/api/users/route.ts', 'export async function GET() {}\n');
    write('server.ts', "app.get('/health', handler);\n");
    expect(await declaredApiFrameworks(root)).toEqual(['nextjs', 'express']);
    const routes = await inspectApi(root, 'auto');
    expect(routes.map((route) => route.path).sort()).toEqual(['/api/users', '/health']);
  });
});

describe('route readings', () => {
  test('verb calls with a path and a handler are read; the receiver name decides nothing', async () => {
    write(
      'server.ts',
      [
        "import express from 'express';",
        'const app = express();',
        "app.get('/health', handler);",
        "router.post('/login', login);",
        "const users = cache.get('users', { fresh: true });",
        "const page = params.get('page');",
      ].join('\n'),
    );
    const routes = await inspectApi(root, 'express');
    expect(routes).toEqual([
      { method: 'GET', path: '/health', file: 'server.ts', line: 3 },
      { method: 'POST', path: '/login', file: 'server.ts', line: 4, reading: 'uncertain' },
    ]);
    const lines = readings.requests.map((request) => request.state as { line: string; framework: string });
    expect(lines.map((state) => state.line)).toEqual([
      "app.get('/health', handler);",
      "router.post('/login', login);",
      "const users = cache.get('users', { fresh: true });",
    ]);
    expect(lines.every((state) => state.framework === 'express')).toBe(true);
  });

  test('a pages/api handler is read for all seven methods in one request', async () => {
    write('pages/api/cart.ts', 'export default function handler(req, res) {}\n');
    const routes = await inspectApi(root, 'nextjs');
    expect(routes.map((route) => `${route.method} ${route.path}`)).toEqual(['POST /api/cart', 'DELETE /api/cart']);
    expect(readings.requests).toHaveLength(1);
    expect(Object.keys(readings.requests[0]?.questions ?? {})).toEqual([
      'serves_get',
      'serves_post',
      'serves_put',
      'serves_patch',
      'serves_delete',
      'serves_head',
      'serves_options',
    ]);
  });

  test('api sync finds path fetches in any folder: a path URL only resolves in a document', async () => {
    write('server.ts', "app.get('/health', handler);\n");
    write('components/Status.tsx', "const res = await fetch('/health');\nconst other = await fetch('/missing');\n");
    const sync = await inspectApiSync(root, 'express');
    expect(sync.fetch_calls.map((call) => `${call.file}:${call.url}`)).toEqual([
      'components/Status.tsx:/health',
      'components/Status.tsx:/missing',
    ]);
    expect(sync.unmatched_fetches.map((call) => call.url)).toEqual(['/missing']);
  });

  test("the spec and its validation use each route's own method", () => {
    const routes = [
      { method: 'POST', path: '/api/cart', file: 'pages/api/cart.ts', line: 1 },
      { method: 'DELETE', path: '/api/cart', file: 'pages/api/cart.ts', line: 1 },
    ];
    expect(Object.keys(generateApiSpec(routes).paths['/api/cart'] ?? {})).toEqual(['post', 'delete']);
    const result = validateApiSpec(JSON.stringify({ paths: { '/api/cart': { get: {} } } }), routes);
    expect(result.mismatched_methods).toEqual([
      { path: '/api/cart', spec_methods: ['GET'], code_methods: ['POST', 'DELETE'] },
    ]);
  });
});

describe('frontend readings', () => {
  test('accessibility: every element of a checked kind is read; a no is dismissed', async () => {
    const issues = await inspectAccessibility(
      '<img src={photo} />\n<img\n  src={logo}\n  alt="Logo"\n/>\n<input type="hidden" name="id" />\n',
      'Card.tsx',
    );
    expect(issues).toEqual([expect.objectContaining({ line: 1, code: 'img-alt', reading: 'real' })]);
    expect(readings.requests).toHaveLength(2); // the hidden input is not a candidate
  });

  test('hooks: the reading decides whether a dependency is missing', async () => {
    const info = await inspectHooks(
      'useEffect(() => {\n  fetchResults(query).then(setResults);\n}, []);\nconst v = useMemo(() => compute(a), [a]);\n',
      'Search.tsx',
    );
    expect(info.hooks.map((hook) => [hook.line, hook.deps, hook.omitsDependency])).toEqual([
      [1, [], 'yes'],
      [4, ['a'], 'no'],
    ]);
    expect(info.missingDepsCount).toBe(1);
  });

  test('overflow and sizing: uncertain readings are shown, dismissed ones are not', async () => {
    const overflow = await inspectOverflow(
      '<div className="overflow-y-auto">\n<div className="overflow-hidden rounded-full">\n',
      'Panel.tsx',
    );
    expect(overflow.issues).toEqual([
      expect.objectContaining({ line: 1, kind: 'scroll_no_height', reading: 'uncertain' }),
    ]);
    const sizing = await inspectSizing('<main className="w-[1200px]">\n<Icon className="w-5 h-5" />\n', 'Page.tsx');
    expect(sizing.items.filter((item) => item.flagged).map((item) => item.value)).toEqual(['w-[1200px]']);
    expect(sizing.hardcodedCount).toBe(1);
  });

  test('stacking: a value shared by lines is read once with every line; z-50 and z-index: 50 are one value', async () => {
    const info = await inspectStacking(
      '<div className="fixed z-50">\n.toast { z-index: 50; }\n<span className="z-10">\n<b className="z-10 md:z-10">\n<i className="z-20">\n',
      'Page.tsx',
    );
    expect(info.zIndexItems).toHaveLength(6);
    expect(info.potentialConflicts).toEqual([{ values: ['z-50', 'z-index: 50'], lines: [1, 2], reading: 'real' }]);
    expect(readings.requests).toHaveLength(2);
  });

  test('client boundary: directive after comments, and each import is read once', async () => {
    const info = await inspectClientBoundary(
      "// page shell\n'use client';\nimport { cookies } from 'next/headers';\nimport React from 'react';\nimport { x } from 'react';\n",
      'page.tsx',
    );
    expect(info.directive).toBe('use client');
    expect(info.serverOnlyImports).toEqual(['next/headers']);
    expect(readings.requests).toHaveLength(2);
  });
});

describe('frontend spec checks (code)', () => {
  test('error boundaries by React definition, not by name', () => {
    const content = [
      "import { ErrorBoundary as Guard } from 'react-error-boundary';",
      'class Catcher extends React.Component {',
      '  static getDerivedStateFromError() { return { failed: true }; }',
      '}',
      'class FancyErrorBoundaryLooking extends React.Component { render() { return null; } }',
      'export const App = () => <Guard fallback={null}><Checkout /></Guard>;',
    ].join('\n');
    const info = inspectErrorBoundary(content, 'App.tsx');
    expect(info.boundaryComponents).toEqual(['Catcher', 'Guard']);
    expect(info.coveredRoutes).toEqual(['Checkout']);
  });

  test('tailwind: variant-prefixed utilities do not conflict with unprefixed ones', () => {
    const info = inspectTailwind('<div className="hidden md:flex p-2 p-4">\n', 'Nav.tsx');
    expect(info.conflicts.map((conflict) => conflict.classes)).toEqual([['p-2', 'p-4']]);
  });

  test('responsive: mobile-first means breakpoint prefixes and no max-* variants', () => {
    expect(inspectResponsive('<div className="w-full md:w-1/2">', 'a.tsx').hasMobileFirst).toBe(true);
    expect(inspectResponsive('<div className="w-1/2 max-md:w-full">', 'a.tsx').hasMobileFirst).toBe(false);
    expect(inspectResponsive('<div className="w-full">', 'a.tsx').hasMobileFirst).toBe(false);
  });
});
