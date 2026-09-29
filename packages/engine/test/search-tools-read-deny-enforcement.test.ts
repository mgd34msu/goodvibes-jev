/**
 * search-tools-read-deny-enforcement.test.ts
 *
 * A read Jev reads as touching secrets is high stakes and is held behind an ask
 * in the normal preset. This suite pins that search / list / map tools (find
 * content = grep, find files = glob, and repo_map) honor the SAME per-file read
 * decision, so a file whose read is
 * restricted never leaks its CONTENT through a search, while path-only listings
 * still show the path marked access-restricted.
 *
 * Coverage:
 *   1. PermissionManager.readAccess: a path Jev reads as touching secrets is
 *      restricted in the normal preset and allowed in auto (which runs high
 *      stakes); an ordinary file is allowed.
 *   2. find content mode: a restricted file's match text is excluded and the
 *      withheld count is surfaced; allow-all returns it.
 *   3. find files mode: a restricted file's path is listed but flagged
 *      access_restricted, with the withheld count surfaced.
 *   4. repo_map: a restricted file keeps its ranked path but its exported
 *      symbols are withheld and the line is flagged.
 *   5. The exec guard's catastrophic reading is independent of read access.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PermissionManager, type PermissionConfigReader } from '../sdk/src/platform/permissions/manager.js';
import type { PolicyRuntimeState } from '../sdk/src/platform/runtime/permissions/policy-runtime.js';
import type { PermissionMode } from '../sdk/src/platform/config/schema.js';
import { useGateReadings } from './_helpers/gate-readings.ts';
import { createFindTool } from '../sdk/src/platform/tools/find/executor.js';
import { createRepoMapTool } from '../sdk/src/platform/tools/repo-map/index.js';
import type { ReadAccessFilter } from '../sdk/src/platform/tools/shared/read-access.js';
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

describe('readAccess: the read decision search tools reuse', () => {
  useGateReadings([['id_rsa', { mutates: false, secrets: true }], ['"rm -rf /"', { mutates: true, catastrophic: true }]]);

  test('the normal preset restricts a path Jev reads as touching secrets but allows a normal file', async () => {
    const manager = makeManager('prompt');
    expect(await manager.readAccess(CREDENTIAL_PATH)).toBe('restricted');
    expect(await manager.readAccess(NORMAL_PATH)).toBe('allow');
  });

  test('the auto preset returns the credential path (it runs high-stakes calls)', async () => {
    const manager = makeManager('allow-all');
    expect(await manager.readAccess(CREDENTIAL_PATH)).toBe('allow');
  });

  test('the exec guard\'s catastrophic reading is independent of read access', async () => {
    expect((await guardExecCommand('rm -rf /')).allowed).toBe(false);
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
