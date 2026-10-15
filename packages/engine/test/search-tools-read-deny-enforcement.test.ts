/**
 * Search, list and map tools honor explicit read-access decisions. Restricted
 * content stays withheld while path-only listings remain complete. Jev readings
 * do not add an implicit permission gate to reads or command parsing.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PermissionManager, type PermissionConfigReader } from '../sdk/src/platform/permissions/manager.js';
import type { PolicyRuntimeState } from '../sdk/src/platform/runtime/permissions/policy-runtime.js';
import type { PermissionMode } from '../sdk/src/platform/config/schema.js';
import { useGateReadings } from './_helpers/gate-readings.ts';
import { createFindTool } from '../sdk/src/platform/tools/find/executor.js';
import { createRepoMapTool } from '../sdk/src/platform/tools/repo-map/index.js';
import { partitionByReadAccess, type ReadAccessFilter } from '../sdk/src/platform/tools/shared/read-access.js';
import { guardExecCommand } from '../sdk/src/platform/tools/exec/ast-guard.js';

// ── PermissionManager harness ────────────────────────────────────────────────

function makeConfigReader(mode: PermissionMode): PermissionConfigReader {
  return {
    isAutoApproveEnabled: () => false,
    getWorkingDirectory: () => '/tmp/search-deny-tests',
    getSnapshot: () => ({ permissions: { mode, backgroundAgents: 'inherit', tools: {} } }),
  } as unknown as PermissionConfigReader;
}

function makePolicyRuntimeState(): Pick<PolicyRuntimeState, 'recordPermissionRequest' | 'recordPermissionDecision' | 'getRegistry'> {
  return {
    recordPermissionRequest: () => {},
    recordPermissionDecision: () => {},
    getRegistry: () => ({ getCurrent: () => undefined }) as unknown as ReturnType<PolicyRuntimeState['getRegistry']>,
  };
}

function makeManager(mode: PermissionMode): PermissionManager {
  return new PermissionManager(
    async () => ({ approved: false, remember: false }),
    makeConfigReader(mode),
    makePolicyRuntimeState(),
    null,
    null,
  );
}

const CREDENTIAL_PATH = '/home/someone/.ssh/id_rsa';
const NORMAL_PATH = '/home/someone/project/src/index.ts';

test('large cached access batches yield to input and retain every decision in order', async () => {
  const paths = Array.from({ length: 1000 }, (_, i) => `${i}`);
  let ticks = 0;
  const timer = setInterval(() => { ticks++; }, 0);
  try {
    const result = await partitionByReadAccess(paths, path => path, async path => {
      const until = performance.now() + 0.05;
      while (performance.now() < until) { /* Local cached-policy work */ }
      return Number(path) % 2 === 0;
    });
    expect(ticks).toBeGreaterThan(0);
    expect(result.allowed).toEqual(paths.filter(path => Number(path) % 2 === 0));
    expect(result.restricted).toEqual(paths.filter(path => Number(path) % 2 !== 0));
  } finally { clearInterval(timer); }
});

describe('readAccess: the read decision search tools reuse', () => {
  useGateReadings([['id_rsa', { mutates: false, secrets: true }], ['"rm -rf /"', { mutates: true, catastrophic: true }]]);

  test('Jev readings do not impose read restrictions in the normal preset', async () => {
    const manager = makeManager('prompt');
    expect(await manager.readAccess(CREDENTIAL_PATH)).toBe('allow');
    expect(await manager.readAccess(NORMAL_PATH)).toBe('allow');
  });

  test('the auto preset permits reads without an explicit deny', async () => {
    const manager = makeManager('allow-all');
    expect(await manager.readAccess(CREDENTIAL_PATH)).toBe('allow');
  });

  test('Jev readings do not impose an extra exec gate', async () => {
    expect((await guardExecCommand('rm -rf /')).allowed).toBe(true);
  });
});

// ── find tool: content (grep) + files (glob) ─────────────────────────────────

let work: string;

beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), 'search-deny-'));
  writeFileSync(join(work, 'public.txt'), 'line one\nSECRETMARK here\nline three\n');
  writeFileSync(join(work, 'secret.txt'), 'nothing\nSECRETMARK here too\nmore\n');
});

afterAll(() => {
  rmSync(work, { recursive: true, force: true });
});

/** Restrict any file whose absolute path ends with `secret.txt`. */
const restrictSecret: ReadAccessFilter = async (abs) => !abs.endsWith('secret.txt');

async function runFind(tool: ReturnType<typeof createFindTool>, query: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await tool.execute({ queries: [{ id: 'q', ...query }] });
  expect(res.success).toBe(true);
  const parsed = JSON.parse(res.output as string) as Record<string, unknown>;
  return parsed['q'] as Record<string, unknown>;
}

describe('find content mode (grep): restricted file content is excluded', () => {
  let previous: ReturnType<typeof installJudgmentPort>;
  beforeEach(() => {
    previous = installJudgmentPort(fakePort((name) => {
      if (name !== 'backtracking') throw new Error(`Unexpected content-search reading: ${name}`);
      return noulAnswer(0.001);
    }).port);
  });
  afterEach(() => { installJudgmentPort(previous); });

  test('a restricted file contributes no match text and the withheld count is surfaced', async () => {
    const tool = createFindTool(work, null, undefined, restrictSecret);
    const result = await runFind(tool, { mode: 'content', pattern: 'SECRETMARK', path: '.' });
    const matches = (result.matches as Array<{ file: string }>) ?? [];
    expect(matches.length).toBeGreaterThan(0);
    expect(matches.every((m) => !m.file.endsWith('secret.txt'))).toBe(true);
    const warnings = (result.warnings as string[]) ?? [];
    expect(warnings.some((w) => w.includes('access-restricted file'))).toBe(true);
  });

  test('with no filter (allow-all), the same file is returned', async () => {
    const tool = createFindTool(work, null, undefined, undefined);
    const result = await runFind(tool, { mode: 'content', pattern: 'SECRETMARK', path: '.' });
    const matches = (result.matches as Array<{ file: string }>) ?? [];
    expect(matches.some((m) => m.file.endsWith('secret.txt'))).toBe(true);
    const warnings = (result.warnings as string[]) ?? [];
    expect(warnings.some((w) => w.includes('access-restricted'))).toBe(false);
  });
});

describe('find files mode (glob): restricted path is listed but flagged', () => {
  test('the restricted path is present and marked access_restricted, with a withheld count', async () => {
    const tool = createFindTool(work, null, undefined, restrictSecret);
    const result = await runFind(tool, { mode: 'files', patterns: ['**/*.txt'], path: '.' });
    const files = (result.files as string[]) ?? [];
    expect(files.some((f) => f.endsWith('secret.txt'))).toBe(true); // existence not hidden
    const restricted = (result.access_restricted as string[]) ?? [];
    expect(restricted.some((f) => f.endsWith('secret.txt'))).toBe(true);
    expect(restricted.some((f) => f.endsWith('public.txt'))).toBe(false);
    const warnings = (result.warnings as string[]) ?? [];
    expect(warnings.some((w) => w.includes('access-restricted file'))).toBe(true);
  });

  test('with no filter, nothing is marked restricted', async () => {
    const tool = createFindTool(work, null, undefined, undefined);
    const result = await runFind(tool, { mode: 'files', patterns: ['**/*.txt'], path: '.' });
    expect(result.access_restricted).toBeUndefined();
  });
});

// ── repo_map ─────────────────────────────────────────────────────────────────

describe('repo_map: restricted file keeps its path but withholds exports', () => {
  let mapRoot: string;

  beforeAll(() => {
    mapRoot = mkdtempSync(join(tmpdir(), 'search-deny-map-'));
    mkdirSync(join(mapRoot, 'src'), { recursive: true });
    writeFileSync(join(mapRoot, 'src', 'consumer.ts'), "import { core } from './core.js';\nexport const consumer = core;\n");
    writeFileSync(join(mapRoot, 'src', 'core.ts'), 'export const core = 1;\nexport function coreFn() { return core; }\n');
  });

  afterAll(() => {
    rmSync(mapRoot, { recursive: true, force: true });
  });

  test('restricted file is flagged and its exported symbols are withheld', async () => {
    const restrictCore: ReadAccessFilter = async (abs) => !abs.endsWith(join('src', 'core.ts'));
    const tool = createRepoMapTool({ projectRoot: mapRoot, readAccessFilter: restrictCore });
    const res = await tool.execute({});
    expect(res.success).toBe(true);
    const output = res.output as string;
    expect(output).toContain('core.ts');
    expect(output).toContain('[access-restricted]');
    expect(output).not.toContain('exports: core');
    expect(output).toContain('access-restricted file');
  });

  test('with no filter, the same file exposes its exports', async () => {
    const tool = createRepoMapTool({ projectRoot: mapRoot });
    const res = await tool.execute({});
    const output = res.output as string;
    expect(output).toContain('exports: core');
    expect(output).not.toContain('[access-restricted]');
  });
});
