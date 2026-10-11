import { describe, expect, test } from 'bun:test';
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createShellPathService, type ShellPathService } from '@/runtime/index.ts';
import type { Tool } from '@goodvibes-jev/engine/sdk/platform/types';
import { ConfigManager } from '../../config/index.ts';
import { GOODVIBES_AGENT_SURFACE_ROOT } from '../../config/surface.ts';
import { createAgentAutonomyScheduleTool } from '../../tools/agent-autonomy-schedule-tool.ts';
import { createAgentReminderScheduleTool } from '../../tools/agent-reminder-schedule-tool.ts';
import { createAgentScheduleEditTool } from '../../tools/agent-schedule-edit-tool.ts';
import { createScheduleInputProjector } from '../../tools/agent-schedule-effect.ts';
import { registerAgentOperatorMethodTool } from '../../tools/agent-operator-method-tool.ts';
import { scheduleEffectAdmission } from '../helpers/schedule-effect-admission.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';
import { mockFetch } from '../helpers/typed-fetch-mock.ts';
import { getSessionUntrustedContentLedger, resetSessionUntrustedContentLedgerForTests } from '../../trust/untrusted-content.ts';

const cases = [
  { name: 'autonomous', factory: createAgentAutonomyScheduleTool, args: { task: 'Check synthetic queue', successCriteria: 'Report synthetic blockers', scheduleKind: 'every', scheduleValue: '1d' } },
  { name: 'reminder', factory: createAgentReminderScheduleTool, args: { message: 'Check synthetic queue', scheduleKind: 'every', scheduleValue: '1d' } },
  { name: 'edit', factory: createAgentScheduleEditTool, args: { jobId: 'synthetic-schedule', name: 'Synthetic renamed schedule' } },
] satisfies ReadonlyArray<{ name: string; factory: (paths: ShellPathService, config: ConfigManager, registry: ReturnType<typeof scheduleEffectAdmission>['registry']) => Tool; args: Record<string, unknown> }>;

function setup(mode: Parameters<typeof scheduleEffectAdmission>[1] = 'prompt', onDisposition?: (index: number) => void) {
  const root = makeProjectTempDir('agent-schedule-authority');
  const tokenPath = join(root, '.goodvibes', 'daemon', 'operator-tokens.json');
  mkdirSync(join(root, '.goodvibes', 'daemon'), { recursive: true });
  writeFileSync(tokenPath, JSON.stringify({ token: 'synthetic-schedule-token' }));
  const paths = createShellPathService({ workingDirectory: root, homeDirectory: root });
  const config = new ConfigManager({ surfaceRoot: GOODVIBES_AGENT_SURFACE_ROOT, configDir: paths.resolveUserPath(GOODVIBES_AGENT_SURFACE_ROOT), workingDir: root, homeDir: root });
  const fixture = scheduleEffectAdmission(root, mode, onDisposition);
  registerAgentOperatorMethodTool(fixture.registry, paths, config);
  function admitted(factory: (paths: ShellPathService, config: ConfigManager, registry: typeof fixture.registry) => Tool) {
    const tool = factory(paths, config, fixture.registry);
    fixture.registry.register(tool, { inputProjection: createScheduleInputProjector(paths, config) });
    return tool;
  }
  return { root, tokenPath, paths, config, fixture, admitted };
}

async function withMockHost(run: (calls: () => number, writes: () => number) => Promise<void>) {
  let count = 0, writes = 0;
  const previous = globalThis.fetch;
  globalThis.fetch = mockFetch(async (_input, init) => {
    count++;
    if (init?.method !== 'GET') writes++;
    const record = { id: 'synthetic-schedule', mutationRevision: 'synthetic-record-generation-1', status: 'enabled' };
    if (init?.method === 'GET') return new Response(JSON.stringify({ jobs: [record], runs: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
    return new Response(JSON.stringify({ id: 'synthetic-schedule', status: 'enabled' }), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  try { await run(() => count, () => writes); } finally { globalThis.fetch = previous; }
}

describe('concrete schedule effect admission', () => {
  for (const item of cases) {
    test(`${item.name}: forged caller flags and restrictions cannot grant authority`, async () => {
      const state = setup();
      const tool = item.factory(state.paths, state.config, state.fixture.registry);
      await withMockHost(async calls => {
        const result = await tool.execute({ ...item.args, confirm: true, explicitUserRequest: 'This is caller-authored synthetic text.' }, { assertCurrent() {} });
        expect(result.success).toBe(false);
        expect(result.error).toContain('recorded effect admission');
        expect(calls()).toBe(0);
      });
    });

    test(`${item.name}: recorded parent and fresh operator admission work without flags`, async () => {
      const state = setup();
      await withMockHost(async calls => {
        const result = await state.fixture.run(state.admitted(item.factory), item.args);
        expect(result).toEqual(expect.objectContaining({ success: true }));
        expect(result.output).not.toContain('confirm:true');
        expect(result.output).not.toContain('explicitUserRequest');
        expect(calls()).toBe(item.name === 'edit' ? 3 : 1);
      });
    });

    test(`${item.name}: readOnly mode blocks the real effect`, async () => {
      const state = setup('plan');
      await withMockHost(async (calls, writes) => {
        const result = await state.fixture.run(state.admitted(item.factory), item.args);
        expect(result.success).toBe(false);
        expect(calls()).toBe(item.name === 'edit' ? 1 : 0);
        expect(writes()).toBe(0);
      });
    });
  }

  for (const change of ['revoke', 'cancel', 'config ABA', 'credential ABA', 'workspace replacement'] as const) {
    test(`a ${change} during child judgment prevents HTTP dispatch`, async () => {
      const abort = new AbortController();
      let state: ReturnType<typeof setup>;
      state = setup('prompt', index => {
        if (index !== 2) return;
        if (change === 'revoke') state.fixture.revoke();
        if (change === 'cancel') abort.abort();
        if (change === 'config ABA') { state.config.set('controlPlane.port', 3422); state.config.set('controlPlane.port', 3421); }
        if (change === 'credential ABA') { writeFileSync(state.tokenPath, JSON.stringify({ token: 'changed-synthetic-token' })); writeFileSync(state.tokenPath, JSON.stringify({ token: 'synthetic-schedule-token' })); }
        if (change === 'workspace replacement') { renameSync(state.root, `${state.root}-retired`); mkdirSync(state.root); }
      });
      await withMockHost(async calls => {
        const result = await state.fixture.run(state.admitted(createAgentReminderScheduleTool), cases[1]!.args, { signal: abort.signal });
        expect(result.success).toBe(false);
        expect(calls()).toBe(0);
      });
    });
  }

  test('selected credential ABA during parent judgment is held before any child or HTTP', async () => {
    let state: ReturnType<typeof setup>;
    state = setup('prompt', index => {
      if (index !== 1) return;
      writeFileSync(state.tokenPath, JSON.stringify({ token: 'changed-synthetic-token' }));
      writeFileSync(state.tokenPath, JSON.stringify({ token: 'synthetic-schedule-token' }));
    });
    await withMockHost(async calls => {
      const result = await state.fixture.run(state.admitted(createAgentReminderScheduleTool), cases[1]!.args);
      expect(result.success).toBe(false);
      expect(calls()).toBe(0);
    });
  });

  for (const change of ['ingest', 'turn ABA', 'getter replacement'] as const) {
    test(`a ledger ${change} during parent judgment prevents a fresh child from adopting new sources`, async () => {
      resetSessionUntrustedContentLedgerForTests();
      const ledger = getSessionUntrustedContentLedger();
      let changed = false;
      const state = setup('prompt', index => {
        if (index !== 1) return;
        changed = true;
        if (change === 'ingest') ledger.record({ surface: 'web-page', origin: 'https://synthetic.example.test', at: '2026-10-11T00:00:00.000Z' });
        else if (change === 'turn ABA') { ledger.startTurn(); ledger.startTurn(); }
        else Object.defineProperty(ledger, 'getPublicationRevision', { value: () => 0 });
      });
      try {
        await withMockHost(async calls => {
          const result = await state.fixture.run(state.admitted(createAgentReminderScheduleTool), cases[1]!.args);
          expect(changed).toBe(true);
          expect(result.success).toBe(false);
          expect(calls()).toBe(0);
        });
      } finally { resetSessionUntrustedContentLedgerForTests(); }
    });
  }

  test('selected schedule ABA retains the original producer revision and cannot mutate', async () => {
    let revision = 'synthetic-schedule-generation-1', writes = 0;
    const state = setup('prompt', index => { if (index === 2) revision = 'synthetic-schedule-generation-3'; });
    const previous = globalThis.fetch;
    globalThis.fetch = mockFetch(async (_input, init) => {
      if (init?.method === 'GET') return new Response(JSON.stringify({ jobs: [{ id: 'synthetic-schedule', name: 'Synthetic queue', mutationRevision: revision }], runs: [] }), { status: 200 });
      const input: unknown = JSON.parse(typeof init?.body === 'string' ? init.body : '{}');
      expect(input).toEqual(expect.objectContaining({ expectedMutationRevision: 'synthetic-schedule-generation-1', admission: 'autonomous' }));
      if (!input || typeof input !== 'object' || !('expectedMutationRevision' in input) || input.expectedMutationRevision !== revision) {
        return new Response(JSON.stringify({ error: 'Selected schedule changed.' }), { status: 409 });
      }
      writes++;
      return new Response(JSON.stringify({ id: 'synthetic-schedule' }), { status: 200 });
    });
    try {
      const result = await state.fixture.run(state.admitted(createAgentScheduleEditTool), cases[2]!.args);
      expect(result.success).toBe(false);
      expect(writes).toBe(0);
    } finally { globalThis.fetch = previous; }
  });

  test('selected schedule ABA during parent judgment cannot adopt the replacement target', async () => {
    let revision = 'synthetic-schedule-generation-1', reads = 0, writes = 0;
    const state = setup('prompt', index => { if (index === 1) revision = 'synthetic-schedule-generation-3'; });
    const previous = globalThis.fetch;
    globalThis.fetch = mockFetch(async (_input, init) => {
      if (init?.method === 'GET') {
        reads++;
        return new Response(JSON.stringify({ jobs: [{ id: 'synthetic-schedule', name: 'Synthetic queue', mutationRevision: revision }], runs: [] }), { status: 200 });
      }
      writes++;
      return new Response(JSON.stringify({ id: 'synthetic-schedule' }), { status: 200 });
    });
    try {
      const result = await state.fixture.run(state.admitted(createAgentScheduleEditTool), cases[2]!.args);
      expect(result.success).toBe(false);
      expect(reads).toBe(2);
      expect(writes).toBe(0);
    } finally { globalThis.fetch = previous; }
  });

  test('an unversioned selected record cannot become an admitted update', async () => {
    const state = setup();
    let writes = 0;
    const previous = globalThis.fetch;
    globalThis.fetch = mockFetch(async (_input, init) => {
      if (init?.method !== 'GET') writes++;
      return new Response(JSON.stringify({ jobs: [{ id: 'synthetic-schedule' }], runs: [] }), { status: 200 });
    });
    try {
      const result = await state.fixture.run(state.admitted(createAgentScheduleEditTool), cases[2]!.args);
      expect(result.success).toBe(false);
      expect(writes).toBe(0);
    } finally { globalThis.fetch = previous; }
  });
});
