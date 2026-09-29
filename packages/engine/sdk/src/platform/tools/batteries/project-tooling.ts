/**
 * `engine.tools.project-tooling`: what inspect mode `project`
 * (tools/inspect/project.ts detectProject) reports when the files alone do
 * not settle it. Facts stay code: a single manifest names the ecosystem, the
 * package.json `packageManager` field (corepack) or a single lockfile names
 * the package manager. Each question is asked only for what those facts left
 * open, all in one request:
 *
 * - `project_type`: the main ecosystem when several manifests exist. Replaces
 *   the fixed order package.json, Cargo.toml, pyproject/requirements, go.mod,
 *   Makefile.
 * - `package_manager`: when there is no field and zero or several lockfiles.
 *   Replaces the order bun, yarn, pnpm and the npm default.
 * - `test_framework`: the test runner a Node project uses. Replaces the
 *   ladder over dependency names (vitest, jest, bun) and substrings of the
 *   test script.
 * - `entry_point` (state: one candidate file): when package.json declares no
 *   entry point (main, module, browser, bin, exports), is this JavaScript or
 *   TypeScript file one of the project's entry points? Asked, one request
 *   per file, about the source files at the root and directly in src/ and
 *   the files the package.json scripts name. Replaces the fixed list of
 *   seven paths (src/index.ts, src/index.js, index.ts, index.js,
 *   src/main.ts, src/main.js, main.ts).
 *
 * Band: low stakes. The answers are labels in an inspection report. A reading
 * that does not act leaves the field as the report's unknown value (a file
 * is listed as an entry point only on a yes that acts).
 */
import { defineBattery, oneOf, STAKES_BANDS, yesNo } from '@goodvibes-jev/judgment';

export const PROJECT_TYPE_OPTIONS = {
  nodejs: 'A JavaScript or TypeScript project run with Node, Bun or Deno.',
  rust: 'A Rust project built with Cargo.',
  python: 'A Python project.',
  go: 'A Go module.',
  make: 'A project built mainly by a Makefile in another language (C, C++ or similar).',
} as const;

export const PACKAGE_MANAGER_OPTIONS = {
  npm: 'npm.',
  bun: 'Bun.',
  yarn: 'Yarn.',
  pnpm: 'pnpm.',
} as const;

export const TEST_FRAMEWORK_OPTIONS = {
  vitest: 'Vitest.',
  jest: 'Jest.',
  bun: 'The Bun test runner (bun test).',
  node: 'The Node built-in test runner (node --test).',
  mocha: 'Mocha.',
  ava: 'AVA.',
  playwright: 'Playwright Test.',
  cypress: 'Cypress.',
  other: 'Some other test runner.',
  none: 'The project has no test runner set up.',
} as const;

export type TestFrameworkReading = keyof typeof TEST_FRAMEWORK_OPTIONS;

/** What the reading sees: the files present and the package.json fields that bear on tooling. */
export type ProjectToolingView = {
  manifests: string[];
  lockfiles: string[];
  scripts: { [name: string]: string };
  dependencies: string[];
  /** Source files by extension, counted in a bounded walk of the project (dependency and build folders skipped). */
  sourceFiles?: { [extension: string]: number };
};

const view = (manifests: string[], lockfiles: string[], scripts: Record<string, string> = {}, dependencies: string[] = [], sourceFiles?: Record<string, number>): ProjectToolingView => ({ manifests, lockfiles, scripts, dependencies, ...(sourceFiles ? { sourceFiles } : {}) });

const LOW = STAKES_BANDS.low.confidence;

/** Lines of a candidate file the entry_point reading carries. */
export const ENTRY_POINT_HEAD_LINES = 40;

/** What the entry_point reading sees: the file, its first lines, and the package.json scripts. */
export type EntryPointView = { file: string; head: string; scripts: { [name: string]: string } };

export function entryPointView(file: string, content: string, scripts: Record<string, string>): EntryPointView {
  return { file, head: content.split('\n').slice(0, ENTRY_POINT_HEAD_LINES).join('\n'), scripts };
}

const SERVER_SCRIPTS = { dev: 'tsx watch server.ts', start: 'node dist/server.js', build: 'tsc -p .' };
const LIBRARY_SCRIPTS = { build: 'tsup src/index.ts', test: 'vitest run' };

export const projectTooling = defineBattery({
  name: 'engine.tools.project-tooling',
  version: 2,
  description: 'A project\'s main ecosystem, package manager, test runner and entry points, when its manifest, lockfile and package.json facts do not settle them.',
  accuracyFloor: 0.85,
  items: {
    project_type: oneOf('`manifests` are the build manifests at the root of a code project, `sourceFiles` counts its source files by extension, and `scripts` and `dependencies` come from its package.json if it has one. Which ecosystem is most of the project\'s own source code written in? A package.json that only runs documentation, formatting or release tooling does not make a project a Node project, and a Makefile that only runs another ecosystem\'s commands does not make it a Makefile project.', PROJECT_TYPE_OPTIONS, LOW),
    package_manager: oneOf('`lockfiles` are the package lockfiles at the root of a JavaScript project and `scripts` are its package.json scripts. Which package manager does the project use?', PACKAGE_MANAGER_OPTIONS, LOW),
    test_framework: oneOf('`scripts` are the package.json scripts and `dependencies` the package names of a JavaScript project. Which test runner runs its tests?', TEST_FRAMEWORK_OPTIONS, LOW),
    entry_point: yesNo('`file` is a JavaScript or TypeScript file in a project whose package.json declares no entry point; `head` is the file\'s first lines and `scripts` the package.json scripts. Is this file one of the project\'s entry points: a program that a script, a runtime or a bundler starts directly, or the module the project offers to its users as its main module? Configuration files (such as vite.config.ts or jest.config.js), tests, scripts that only support development, and modules that only other project files import are not entry points.', STAKES_BANDS.low.yesNo),
  },
  fixtures: [
    { name: 'napi addon is node', state: view(['package.json', 'Cargo.toml'], ['package-lock.json'], { build: 'napi build --release', test: 'jest' }, ['@napi-rs/cli', 'jest'], { '.ts': 48, '.js': 6, '.rs': 3 }), expect: { project_type: 'nodejs', test_framework: 'jest' } },
    { name: 'rust crate with a docs site package.json', state: view(['Cargo.toml', 'package.json'], [], { docs: 'vitepress build docs' }, ['vitepress'], { '.rs': 112, '.md': 30, '.ts': 1 }), expect: { project_type: 'rust' } },
    { name: 'python service with a makefile', state: view(['pyproject.toml', 'Makefile'], [], {}, [], { '.py': 64, '.toml': 1 }), expect: { project_type: 'python' } },
    { name: 'go module with a makefile', state: view(['go.mod', 'Makefile'], [], {}, [], { '.go': 88 }), expect: { project_type: 'go' } },
    { name: 'c project with a makefile and a tooling package.json', state: view(['Makefile', 'package.json'], [], { format: 'prettier --write docs' }, ['prettier'], { '.c': 41, '.h': 23 }), expect: { project_type: 'make' } },
    { name: 'no lockfile, bun scripts', state: view(['package.json'], [], { dev: 'bun run --watch src/index.ts', test: 'bun test' }, ['@types/bun']), expect: { package_manager: 'bun', test_framework: 'bun' } },
    { name: 'no lockfile, pnpm scripts', state: view(['package.json'], [], { build: 'pnpm -r build', test: 'pnpm -r test' }), expect: { package_manager: 'pnpm' } },
    { name: 'no lockfile, plain npm scripts', state: view(['package.json'], [], { start: 'node server.js', test: 'node --test' }), expect: { package_manager: 'npm', test_framework: 'node' } },
    { name: 'yarn and npm lockfiles, yarn scripts', state: view(['package.json'], ['yarn.lock', 'package-lock.json'], { test: 'yarn jest' }, ['jest']), expect: { package_manager: 'yarn', test_framework: 'jest' } },
    { name: 'vitest via script', state: view(['package.json'], ['pnpm-lock.yaml'], { test: 'vitest run' }, ['vitest', 'typescript']), expect: { test_framework: 'vitest' } },
    { name: 'mocha', state: view(['package.json'], ['package-lock.json'], { test: 'mocha "test/**/*.spec.js"' }, ['mocha', 'chai']), expect: { test_framework: 'mocha' } },
    { name: 'ava', state: view(['package.json'], ['package-lock.json'], { test: 'ava' }, ['ava']), expect: { test_framework: 'ava' } },
    { name: 'playwright only', state: view(['package.json'], ['package-lock.json'], { test: 'playwright test' }, ['@playwright/test']), expect: { test_framework: 'playwright' } },
    { name: 'cypress only', state: view(['package.json'], ['yarn.lock'], { 'test:e2e': 'cypress run' }, ['cypress']), expect: { test_framework: 'cypress' } },
    { name: 'tap', state: view(['package.json'], ['package-lock.json'], { test: 'tap test/*.js' }, ['tap']), expect: { test_framework: 'other' } },
    { name: 'server started by the scripts', state: entryPointView('server.ts', "import express from 'express';\nimport { routes } from './src/routes.js';\n\nconst app = express();\napp.use(routes);\napp.listen(Number(process.env.PORT ?? 3000), () => console.log('listening'));\n", SERVER_SCRIPTS), expect: { entry_point: 'yes' } },
    { name: 'library index that the build bundles', state: entryPointView('src/index.ts', "export { parse } from './parse.js';\nexport { format } from './format.js';\nexport type { Options } from './types.js';\n", LIBRARY_SCRIPTS), expect: { entry_point: 'yes' } },
    { name: 'cli with a shebang', state: entryPointView('cli.js', "#!/usr/bin/env node\nimport { run } from './lib/run.js';\n\nrun(process.argv.slice(2)).catch((error) => {\n  console.error(error.message);\n  process.exit(1);\n});\n", { test: 'node --test' }), expect: { entry_point: 'yes' } },
    { name: 'vite config', state: entryPointView('vite.config.ts', "import { defineConfig } from 'vite';\nimport react from '@vitejs/plugin-react';\n\nexport default defineConfig({ plugins: [react()] });\n", { dev: 'vite', build: 'vite build' }), expect: { entry_point: 'no' } },
    { name: 'helper module imported by the server', state: entryPointView('src/routes.ts', "import { Router } from 'express';\nimport { listUsers } from './users.js';\n\nexport const routes = Router();\nroutes.get('/users', listUsers);\n", SERVER_SCRIPTS), expect: { entry_point: 'no' } },
    { name: 'a test file', state: entryPointView('src/parse.test.ts', "import { expect, test } from 'vitest';\nimport { parse } from './parse.js';\n\ntest('parses a number', () => {\n  expect(parse('1')).toBe(1);\n});\n", LIBRARY_SCRIPTS), expect: { entry_point: 'no' } },
    { name: 'no tests', state: view(['package.json'], ['package-lock.json'], { start: 'node index.js', test: 'echo "Error: no test specified" && exit 1' }, ['express']), expect: { test_framework: 'none' } },
  ],
});
