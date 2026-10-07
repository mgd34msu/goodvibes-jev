import { afterEach, beforeEach, expect, test } from 'bun:test';
import { SqliteDecisionLog, withDecisionLog, type JudgmentPort, type JudgmentRequest, type Questions } from '@goodvibes-jev/judgment';
import { choiceAnswer, fakePort } from '@goodvibes-jev/judgment/testing';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { PermissionManager, type PermissionConfigReader } from '../sdk/src/platform/permissions/manager.ts';
import type { AutonomousChoiceProjection } from '../sdk/src/platform/permissions/autonomous-input-projection.ts';
import type { AutonomousToolChoices, AutonomousToolSource } from '../sdk/src/platform/permissions/autonomous.ts';
import { PolicyRuntimeState } from '../sdk/src/platform/runtime/permissions/policy-runtime.ts';
import { ToolRegistry, type PreparedToolCall } from '../sdk/src/platform/tools/registry.ts';
import type { ProjectedToolCall, ToolInputProjectionRequest } from '../sdk/src/platform/tools/input-projection.ts';
import { gateReadingsPort, forgetGateReadings } from './_helpers/gate-readings.ts';

const RAW = 'https://synthetic.invalid/reference?pat=SYNTHETIC_CATALOG_ONLY';
const SAFE = 'https://synthetic.invalid/reference';
const INITIAL = 'https://synthetic.invalid/initial';
let previous: ReturnType<typeof installJudgmentPort>;
let log: SqliteDecisionLog;
let requests: JudgmentRequest<Questions>[];
let select: (request: JudgmentRequest<Questions>) => string;
let onRequest: (() => void) | undefined;
beforeEach(() => {
  forgetGateReadings(); log = new SqliteDecisionLog(':memory:'); requests = []; select = () => 'act'; onRequest = undefined;
  const gate = gateReadingsPort();
  const semantic = fakePort((name, question, state) => choiceAnswer(question,
    name === 'boolean_value' ? 'true' : select({ state } as JudgmentRequest<Questions>), 0.99));
  const inner: JudgmentPort = { model: gate.port.model, async ask(request) {
    request.beforeAttempt?.(); requests.push(request as JudgmentRequest<Questions>); onRequest?.();
    return 'disposition' in request.questions || 'boolean_value' in request.questions ? semantic.port.ask(request) : gate.port.ask(request);
  } };
  previous = installJudgmentPort(withDecisionLog(inner, log));
});
afterEach(() => { installJudgmentPort(previous); log[Symbol.dispose](); forgetGateReadings(); });

function latch() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

function fixture(options: { beforeProject?: (request: ToolInputProjectionRequest) => Promise<void>; onCurrent?: (request: ToolInputProjectionRequest) => void; onChoices?: () => void; beforeRelease?: () => Promise<void>; held?: boolean } = {}) {
  const source: { goal: string; criteria: string[] } = { goal: 'Read the synthetic reference', criteria: ['Preserve exact source identity'] };
  const sourceOf = (): AutonomousToolSource => source;
  const revisions = [{ ref: { id: 'reference-alternative', revision: 'host-v1', kind: 'revise-action' as const },
    toolName: 'fetch', args: { url: RAW, enabled: 'enabled' } }];
  const conditions = [{ id: 'host-condition', revision: 'condition-v1' }];
  const choices: AutonomousToolChoices = { revisions, resumeConditions: conditions };
  let directory = '/synthetic/catalog';
  const config = { getAutonomousSnapshot: () => ({ permissions: { mode: 'prompt', tools: {} }, autoApprove: false, directory }),
    getSnapshot: () => ({ permissions: { mode: 'prompt', tools: {} } }), getWorkingDirectory: () => directory,
    isAutoApproveEnabled: () => false } as PermissionConfigReader;
  const manager = new PermissionManager(undefined, config, new PolicyRuntimeState(), null, null, null, { autonomousChoices: () => { options.onChoices?.(); return choices; } });
  const registry = new ToolRegistry();
  const projected: ToolInputProjectionRequest[] = [];
  const released: string[] = [];
  const executed: Record<string, unknown>[] = [];
  const tool = { definition: { name: 'fetch', description: 'Synthetic intercepted reference reader', parameters: {
    type: 'object', properties: { url: { type: 'string' }, enabled: { type: 'boolean' } }, required: ['url'], additionalProperties: false,
  } }, execute: async (args: Record<string, unknown>) => { executed.push(args); return { success: true, output: 'intercepted' }; } };
  const registration = { inputProjection: { async project(request: ToolInputProjectionRequest) {
    projected.push(request);
    await options.beforeProject?.(request);
    if (options.held && request.args.url === RAW) return { status: 'held' as const };
    const url = request.args.url === RAW ? SAFE : request.args.url;
    return { status: 'projected' as const, args: { ...request.args, url },
      assertCurrent: () => options.onCurrent?.(request),
      assertRepairedArgs: (args: Record<string, unknown>) => {
        if (args.url !== url || (args.enabled !== request.args.enabled && args.enabled !== true)) throw new Error('Synthetic binding changed');
      }, release: async () => { await options.beforeRelease?.(); released.push(String(request.args.url)); } };
  } } };
  registry.register(tool, registration);
  return { manager, registry, source, sourceOf, revisions, conditions, projected, released, executed, tool, registration,
    changeDirectory: () => { directory = '/synthetic/changed'; } };
}

type Fixture = ReturnType<typeof fixture>;
async function execute(f: Fixture, sourceId = 'catalog-source', signal?: AbortSignal) {
  let projection: AutonomousChoiceProjection | undefined;
  let initial: ProjectedToolCall | undefined;
  const admissions = [];
  const preparedCalls: PreparedToolCall[] = [];
  const consumedRevisions: string[] = [];
  let permittedRevisionIds: readonly string[] | undefined;
  try {
    projection = await f.manager.projectAutonomousChoices(sourceId, 'original-call', f.sourceOf, f.registry, signal);
    initial = await f.registry.projectCall('original-call', 'fetch', { url: INITIAL }, { signal });
    let args = initial.args;
    for (let attempt = 0; attempt < 4; attempt++) {
      const preparation = f.manager.autonomousPreparation(sourceId, f.sourceOf, signal, undefined, projection);
      const prepared = await f.registry.prepareCall('original-call', 'fetch', args, { signal, port: preparation.port });
      preparedCalls.push(prepared); preparation.assertCurrent();
      const admission = await f.manager.admitAutonomous(sourceId, prepared.name, prepared.args, {
        sourceOf: f.sourceOf, signal, choiceProjection: projection, consumedRevisions, ...(permittedRevisionIds ? { permittedRevisionIds } : {}),
        schemaRevision: prepared.schemaRevision, preparationDecisionIds: prepared.judgmentDecisionIds,
        assertPrepared: () => f.registry.assertPrepared(prepared),
      });
      admissions.push(admission);
      permittedRevisionIds ??= admission.revisionIds;
      if (admission.revision) { consumedRevisions.push(admission.revision.ref.id); args = admission.revision.args; continue; }
      const result = admission.result.approved ? await f.registry.executePrepared(prepared, admission.claim, { signal }) : admission.result;
      return { result, admissions, preparedCalls };
    }
    throw new Error('Synthetic revision budget exceeded');
  } finally {
    if (initial) await f.registry.releaseProjected(initial);
    if (projection) await f.manager.releaseAutonomousChoices(projection);
  }
}

test('all offered alternatives are projected before initial admission, including unselected inputs', async () => {
  const f = fixture({ beforeProject: async () => { expect(requests).toHaveLength(0); } });
  const result = await execute(f);
  expect(result.result).toMatchObject({ success: true });
  expect(f.projected.map(item => item.args.url)).toEqual([RAW, INITIAL]);
  const semantic = requests.find(request => 'disposition' in request.questions)!;
  const serialized = JSON.stringify(requests);
  expect(serialized).toContain(SAFE);
  expect(serialized).not.toContain('SYNTHETIC_CATALOG_ONLY');
  expect(JSON.stringify(log.query({}))).not.toContain('SYNTHETIC_CATALOG_ONLY');
  const offered = (semantic.state as unknown as { offeredChoices: { continuations: { ref: { id: string; revision: string } }[] } }).offeredChoices.continuations[0]!;
  expect(offered.ref.id).toBe('reference-alternative');
  expect(offered.ref.revision).not.toBe('host-v1');
  expect(offered.ref.revision).toMatch(/^[0-9a-f]{64}$/);
  expect(f.executed).toEqual([{ url: INITIAL }]);
  expect(f.released.sort()).toEqual([INITIAL, RAW].sort());
});

test('selected owned alternative is reused, freshly repaired and freshly admitted with recorded provenance', async () => {
  const f = fixture(); let selections = 0;
  select = () => ++selections === 1 ? 'revise_0' : 'act';
  const result = await execute(f);
  expect(result.admissions.map(item => item.result.autonomousDecision?.outcome)).toEqual(['revise', 'act']);
  expect(f.projected).toHaveLength(2); // catalog plus initial, never a second projection of the selected catalog input
  expect(f.projected.every(item => item.callId === 'original-call')).toBe(true);
  expect(f.executed).toEqual([{ url: SAFE, enabled: true }]);
  expect(result.preparedCalls[1]!.judgmentDecisionIds).toHaveLength(1);
  const receipt = result.admissions[1]!.result.autonomousDecision!;
  expect(receipt.judgmentDecisionIds).toContain(result.preparedCalls[1]!.judgmentDecisionIds[0]!);
  for (const id of receipt.judgmentDecisionIds) expect(log.get(id)?.status).toBe('answered');
  expect(result.admissions[1]!.revisionIds).toEqual([]);
  expect(JSON.stringify(requests)).not.toContain('SYNTHETIC_CATALOG_ONLY');
  expect(f.released.sort()).toEqual([INITIAL, RAW].sort());
  await expect(execute(f)).rejects.toThrow('claimed');
});

test.each(['source', 'catalog', 'host-revision', 'condition', 'authority', 'registration', 'schema'] as const)(
  '%s mutation while catalog projection is pending fails before model access and cleans partial capture', async kind => {
    const started = latch(); const resume = latch();
    const f = fixture({ beforeProject: async () => { started.resolve(); await resume.promise; } });
    const pending = f.manager.projectAutonomousChoices('catalog-source', 'original-call', f.sourceOf, f.registry);
    await started.promise;
    if (kind === 'source') f.source.criteria[0] = 'Changed criterion';
    if (kind === 'catalog') f.revisions[0]!.args.url = 'https://synthetic.invalid/changed';
    if (kind === 'host-revision') f.revisions[0]!.ref.revision = 'host-v2';
    if (kind === 'condition') f.conditions[0]!.revision = 'condition-v2';
    if (kind === 'authority') f.changeDirectory();
    if (kind === 'registration') { f.registry.unregister('fetch'); f.registry.register(f.tool, f.registration); }
    if (kind === 'schema') f.tool.definition.description = 'Changed schema description';
    resume.resolve();
    await expect(pending).rejects.toBeDefined();
    expect(requests).toHaveLength(0); expect(f.executed).toHaveLength(0);
    expect(f.released).toEqual([RAW]);
  },
);

test('held alternative stops the logical call before preparation and releases already captured alternatives', async () => {
  const f = fixture({ held: true });
  f.revisions.unshift({ ref: { id: 'safe-first', revision: 'host-v1', kind: 'revise-action' },
    toolName: 'fetch', args: { url: SAFE, enabled: 'enabled' } });
  await expect(execute(f)).rejects.toMatchObject({ problem: 'held' });
  expect(requests).toHaveLength(0); expect(f.executed).toHaveLength(0);
  expect(f.projected).toHaveLength(2); expect(f.released).toEqual([SAFE]);
});

test('declared inline material retains the complete raw privacy floor before projection', async () => {
  const f = fixture(); f.revisions[0]!.args.url = 'https://synthetic.invalid/reference?password=synthetic';
  await expect(execute(f)).rejects.toMatchObject({ problem: 'credential-material' });
  expect(f.projected).toHaveLength(0); expect(requests).toHaveLength(0);
});

test('released, forged, cross-source and foreign-manager handles cannot authorize preparation', async () => {
  const f = fixture(); const foreign = fixture();
  const handle = await f.manager.projectAutonomousChoices('catalog-source', 'original-call', f.sourceOf, f.registry);
  expect(Object.isFrozen(handle)).toBe(true); expect(Reflect.ownKeys(handle)).toEqual([]);
  expect(() => foreign.manager.autonomousPreparation('catalog-source', foreign.sourceOf, undefined, undefined, handle)).toThrow('another');
  expect(() => f.manager.autonomousPreparation('another-source', f.sourceOf, undefined, undefined, handle)).toThrow('another');
  expect(() => f.manager.autonomousPreparation('catalog-source', f.sourceOf, undefined, undefined, {} as AutonomousChoiceProjection)).toThrow('another');
  await f.manager.releaseAutonomousChoices(handle);
  await f.manager.releaseAutonomousChoices(handle);
  expect(() => f.manager.autonomousPreparation('catalog-source', f.sourceOf, undefined, undefined, handle)).toThrow('stale');
  expect(requests).toHaveLength(0); expect(f.released).toEqual([RAW]);
});

test('raw catalog mutation while admission is pending invalidates the decision before execution', async () => {
  const f = fixture(); onRequest = () => { f.revisions[0]!.args.url = 'https://synthetic.invalid/changed'; };
  await expect(execute(f)).rejects.toBeDefined();
  expect(f.executed).toHaveLength(0);
  expect(JSON.stringify(requests)).not.toContain('SYNTHETIC_CATALOG_ONLY');
  expect(f.released.sort()).toEqual([INITIAL, RAW].sort());
});

test('projected host-condition deferral resumes only under a freshly captured changed condition', async () => {
  const f = fixture(); select = () => 'defer_1';
  const first = await execute(f);
  expect(first.admissions[0]!.result.autonomousDecision).toMatchObject({ outcome: 'defer', until: { id: 'host-condition', revision: 'condition-v1' } });
  select = () => 'act';
  await expect(execute(f)).rejects.toThrow('waiting for its registered condition');
  expect(f.executed).toHaveLength(0);
  f.conditions[0]!.revision = 'condition-v2';
  await execute(f);
  expect(f.executed).toHaveLength(1);
});


test.each(['registration', 'authority'] as const)('late alternative callback cannot invalidate earlier %s behind the coherent snapshot', async kind => {
  let armed = false;
  const f = fixture({ onCurrent: request => {
    if (armed && request.name === 'find') {
      if (kind === 'registration') f.tool.definition.description = 'Changed by later alternative';
      else f.changeDirectory();
    }
  } });
  f.registry.register({ ...f.tool, definition: { ...f.tool.definition, name: 'find' } }, f.registration);
  f.revisions.push({ ref: { id: 'later-alternative', revision: 'host-v1', kind: 'revise-action' },
    toolName: 'find', args: { url: SAFE, enabled: 'enabled' } });
  const handle = await f.manager.projectAutonomousChoices('catalog-source', 'original-call', f.sourceOf, f.registry);
  armed = true;
  expect(() => f.manager.autonomousPreparation('catalog-source', f.sourceOf, undefined, undefined, handle)).toThrow();
  await f.manager.releaseAutonomousChoices(handle);
  expect(requests).toHaveLength(0);
});

test('concurrent catalog release callers both await complete owned cleanup', async () => {
  const cleanup = latch();
  const f = fixture({ beforeRelease: () => cleanup.promise });
  const handle = await f.manager.projectAutonomousChoices('catalog-source', 'original-call', f.sourceOf, f.registry);
  const first = f.manager.releaseAutonomousChoices(handle);
  const second = f.manager.releaseAutonomousChoices(handle);
  expect(first).toBe(second);
  expect(f.released).toEqual([]);
  cleanup.resolve(); await Promise.all([first, second]);
  expect(f.released).toEqual([RAW]);
});


test('admission captures the owned projection handle once before awaiting model access', async () => {
  const f = fixture();
  const handle = await f.manager.projectAutonomousChoices('catalog-source', 'original-call', f.sourceOf, f.registry);
  let accesses = 0;
  try {
    const admission = await f.manager.admitAutonomous('catalog-source', 'fetch', { url: INITIAL }, {
      sourceOf: f.sourceOf,
      get choiceProjection() { if (++accesses > 1) throw new Error('Projection handle reread'); return handle; },
    });
    expect(admission.result.autonomousDecision?.outcome).toBe('act');
    expect(accesses).toBe(1);
    expect(JSON.stringify(requests)).not.toContain('SYNTHETIC_CATALOG_ONLY');
  } finally { await f.manager.releaseAutonomousChoices(handle); }
});


test('empty catalogs preserve one coherent host read per preparation check and retain source freshness', async () => {
  const f = fixture(); f.revisions.length = 0;
  let reads = 0;
  const sourceOf = () => { reads++; return f.source; };
  const handle = await f.manager.projectAutonomousChoices('catalog-source', 'original-call', sourceOf, f.registry);
  const capturedReads = reads;
  const preparation = f.manager.autonomousPreparation('catalog-source', sourceOf, undefined, undefined, handle);
  expect(reads - capturedReads).toBe(1);
  preparation.assertCurrent();
  expect(reads - capturedReads).toBe(2);
  f.source.criteria.push('Changed host criterion');
  expect(() => preparation.assertCurrent()).toThrow('Autonomous admission authority, source or scope changed');
  expect(reads - capturedReads).toBe(3);
  await f.manager.releaseAutonomousChoices(handle);
  expect(f.projected).toHaveLength(0); expect(requests).toHaveLength(0);
});

test('empty catalogs keep their original cancellation and release binding without extra host callbacks', async () => {
  const f = fixture(); f.revisions.length = 0;
  const controller = new AbortController();
  const handle = await f.manager.projectAutonomousChoices('catalog-source', 'original-call', f.sourceOf, f.registry, controller.signal);
  controller.abort();
  expect(() => f.manager.autonomousPreparation('catalog-source', f.sourceOf, undefined, undefined, handle)).toThrow('cancelled');
  await f.manager.releaseAutonomousChoices(handle);
  expect(() => f.manager.autonomousPreparation('catalog-source', f.sourceOf, undefined, undefined, handle)).toThrow('stale');
  expect(f.projected).toHaveLength(0); expect(requests).toHaveLength(0);
});


test.each(['definition', 'execute'] as const)('empty-catalog final %s mutation remains a guard-sensitive negative control', async field => {
  for (const disableFinalPreparedCheck of [false, true]) {
    let frames = 0;
    let replacements = 0;
    const baselineClaims = log.query({ site: 'engine.gate.autonomous-tool' }).filter(entry => entry.status === 'answered' && entry.notes.some(note =>
      note.kind === 'action' && note.action.startsWith('autonomous:claim:'))).length;
    const f = fixture({ onChoices: () => {
      const claims = log.query({ site: 'engine.gate.autonomous-tool' }).filter(entry => entry.status === 'answered' && entry.notes.some(note =>
        note.kind === 'action' && note.action.startsWith('autonomous:claim:'))).length;
      if (claims > baselineClaims && ++frames === 2) {
        if (field === 'definition') f.tool.definition.description = 'Revoked at the exact final host frame';
        else f.tool.execute = async () => { replacements++; return { success: true, output: 'replacement' }; };
      }
    } });
    f.revisions.length = 0;
    // Deliberately remove only the callback-free prepared check in this
    // synthetic negative control. Production code is unchanged; every body here is intercepted.
    if (disableFinalPreparedCheck) f.registry.assertPrepared = () => {};
    const pending = execute(f);
    if (disableFinalPreparedCheck) {
      await expect(pending).resolves.toBeDefined();
      expect(f.executed).toHaveLength(1);
    } else {
      await expect(pending).rejects.toBeDefined();
      expect(f.executed).toHaveLength(0);
    }
    expect(frames).toBe(2);
    expect(replacements).toBe(0);
  }
});
