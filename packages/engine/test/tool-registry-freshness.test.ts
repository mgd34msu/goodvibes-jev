import { expect, test } from 'bun:test';
import { SqliteDecisionLog, withDecisionLog, type JudgmentPort } from '@goodvibes-jev/judgment';
import { choiceAnswer, fakePort } from '@goodvibes-jev/judgment/testing';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { ToolRegistry } from '../sdk/src/platform/tools/registry.ts';
import { ToolInputProjectionError, type ToolInputProjector } from '../sdk/src/platform/tools/input-projection.ts';
import type { Tool } from '../sdk/src/platform/types/tools.ts';
import { executeToolCalls, type ToolExecutionDeps } from '../sdk/src/platform/core/orchestrator-tool-runtime.ts';
import { PermissionManager, type PermissionConfigReader } from '../sdk/src/platform/permissions/manager.ts';
import { PolicyRuntimeState } from '../sdk/src/platform/runtime/permissions/policy-runtime.ts';
import { forgetGateReadings, gateReadingsPort } from './_helpers/gate-readings.ts';

const TOOL_NAME = 'registry_freshness_fixture';
const PRIVATE_MARKER = 'synthetic-private-freshness-marker';
const args = () => ({ model: 'catalog-model-a' });

function fixture() {
  const parameters = {
    type: 'object',
    properties: { model: { type: 'string', enum: ['catalog-model-a', 'catalog-model-b'] } },
    required: ['model'],
    additionalProperties: false,
  };
  const counts = { projects: 0, capture: 0, owner: 0, result: 0, reads: 0, bodies: 0, replacements: 0, releases: 0 };
  const controls = {
    capture: () => {},
    owner: () => {},
    result: () => {},
    project: async () => {},
  };
  const owner = new AbortController();
  const caller = new AbortController();
  const result = new AbortController();
  const registry = new ToolRegistry();
  const tool: Tool = {
    definition: { name: TOOL_NAME, description: 'Bounded in-memory registry freshness fixture.', parameters },
    async execute(received) {
      counts.bodies++;
      expect(received).toEqual(args());
      expect(Object.isFrozen(received)).toBe(true);
      return { success: true, output: 'synthetic result' };
    },
  };
  // An accidental repair is an explicit test failure, never a live reader call.
  const reader = fakePort(() => { counts.reads++; throw new Error('Unexpected fixture judgment'); });
  let assertProjectCurrent: (() => void) | undefined;
  const projector: ToolInputProjector = {
    signal: owner.signal,
    assertCurrent() { counts.owner++; controls.owner(); },
    async project(request) {
      counts.projects++;
      assertProjectCurrent = request.assertCurrent;
      request.assertCurrent();
      await controls.project();
      return {
        status: 'projected', args: args(), signal: result.signal,
        assertCurrent() { counts.result++; controls.result(); },
        async release() { counts.releases++; },
      };
    },
  };
  const options = {
    signal: caller.signal, port: reader.port,
    assertCurrent() { counts.capture++; controls.capture(); },
  };
  registry.register(tool, { inputProjection: projector });
  return { registry, tool, parameters, projector, options, counts, controls, owner, caller, result,
    checkProjectCurrent() { expect(assertProjectCurrent).toBeDefined(); assertProjectCurrent!(); },
  };
}

type Fixture = ReturnType<typeof fixture>;

function assertValueFree(error: unknown): void {
  expect(error).toBeInstanceOf(Error);
  expect(String(error)).not.toContain(PRIVATE_MARKER);
  expect(JSON.stringify(error)).not.toContain(PRIVATE_MARKER);
}

function expectRefused(check: () => unknown): void {
  let failure: unknown;
  try { check(); } catch (error) { failure = error; }
  assertValueFree(failure);
}

async function expectRefusedAsync(check: () => Promise<unknown>): Promise<void> {
  let failure: unknown;
  try { await check(); } catch (error) { failure = error; }
  assertValueFree(failure);
}

function authorityCounts(f: Fixture) {
  return [f.counts.capture, f.counts.owner, f.counts.result];
}

test.each(['reordered-enumerable-keys', 'descriptor-flags-only'] as const)(
  'fresh captures preserve canonical equivalence for %s through preparation and dispatch', async change => {
    const f = fixture();
    const projected = await f.registry.projectCall('equivalent', TOOL_NAME, args(), f.options);
    const revision = projected.schemaRevision;
    if (change === 'reordered-enumerable-keys') {
      f.tool.definition = {
        parameters: { additionalProperties: false, required: ['model'],
          properties: { model: { enum: ['catalog-model-a', 'catalog-model-b'], type: 'string' } }, type: 'object' },
        description: f.tool.definition.description, name: TOOL_NAME,
      };
    } else {
      Object.defineProperty(f.tool.definition, 'description', { writable: false, configurable: false });
      Object.defineProperty(f.parameters.properties.model.enum, '0', { writable: false, configurable: false });
    }
    for (let attempt = 0; attempt < 3; attempt++) {
      const before = authorityCounts(f);
      f.registry.assertProjectedSnapshot(projected);
      expect(authorityCounts(f)).toEqual(before);
      f.registry.assertProjected(projected);
      expect(f.counts.owner).toBeGreaterThan(before[1]!);
      f.checkProjectCurrent();
    }
    const prepared = await f.registry.prepareCall('equivalent', TOOL_NAME, projected.args, f.options);
    expect(prepared.schemaRevision).toBe(revision);
    let claims = 0;
    let callbacksAtClaim: number[] = [];
    expect(await f.registry.executePrepared(prepared, () => {
      claims++; callbacksAtClaim = authorityCounts(f);
    })).toMatchObject({ success: true });
    expect(authorityCounts(f)).toEqual(callbacksAtClaim);
    expect(claims).toBe(1);
    expect(f.counts).toMatchObject({ projects: 1, bodies: 1, reads: 0, releases: 1 });
  },
);

const definitionChanges = [
  { name: 'changed-enum-member', mutate(f: Fixture) { f.parameters.properties.model.enum[1] = 'catalog-model-c'; } },
  { name: 'inserted-credential-value', mutate(f: Fixture) { f.parameters.properties.model.enum[1] = `password=${PRIVATE_MARKER}`; } },
  { name: 'removed-enumerability', mutate(f: Fixture) { Object.defineProperty(f.tool.definition, 'description', { enumerable: false }); } },
] as const;

test.each([...definitionChanges])('freshness rejects $name before live callbacks, judgment or dispatch', async ({ mutate }) => {
  const f = fixture();
  const projected = await f.registry.projectCall('changed', TOOL_NAME, args(), f.options);
  const prepared = await f.registry.prepareCall('changed', TOOL_NAME, projected.args, f.options);
  const before = authorityCounts(f);
  mutate(f);
  expectRefused(() => f.checkProjectCurrent());
  expectRefused(() => f.registry.assertProjected(projected));
  expectRefused(() => f.registry.assertProjectedSnapshot(projected));
  expectRefused(() => f.registry.assertPrepared(prepared));
  let claims = 0;
  await expectRefusedAsync(() => f.registry.executePrepared(prepared, () => { claims++; }));
  expect(authorityCounts(f)).toEqual(before);
  expect(claims).toBe(0);
  expect(f.counts).toMatchObject({ projects: 1, bodies: 0, reads: 0, releases: 1 });
});

test('a new projection still privacy-screens a changed definition before its projector', async () => {
  const f = fixture();
  const prior = await f.registry.projectCall('screened', TOOL_NAME, args(), f.options);
  await f.registry.releaseProjected(prior);
  f.parameters.properties.model.enum[1] = `password=${PRIVATE_MARKER}`;
  const before = authorityCounts(f);
  await expect(f.registry.projectCall('fresh-acquisition', TOOL_NAME, args(), f.options))
    .rejects.toMatchObject({ problem: 'credential-material' });
  expect(authorityCounts(f)).toEqual(before);
  expect(f.counts).toMatchObject({ projects: 1, reads: 0, bodies: 0 });
});

test.each(['capture', 'owner', 'result'] as const)('a %s callback cannot mutate the definition after its first freshness check', async callback => {
  const f = fixture();
  const projected = await f.registry.projectCall('callback-mutation', TOOL_NAME, args(), f.options);
  f.controls[callback] = () => { f.parameters.properties.model.enum[1] = `password=${PRIVATE_MARKER}`; };
  expectRefused(() => f.registry.assertProjected(projected));
  expect(f.counts).toMatchObject({ projects: 1, reads: 0, bodies: 0 });
  await f.registry.releaseProjected(projected);
  expect(f.counts.releases).toBe(1);
});

const executableMetadata = ['definition-getter', 'executor-getter', 'enum-getter', 'hidden-getter', 'hidden-nested-getter',
  'definition-proxy', 'enum-proxy', 'hidden-proxy', 'hidden-nested-proxy'] as const;

test.each([...executableMetadata])('freshness rejects %s without invoking getters or proxy traps', async kind => {
  const f = fixture();
  const projected = await f.registry.projectCall('executable-metadata', TOOL_NAME, args(), f.options);
  const prepared = await f.registry.prepareCall('executable-metadata', TOOL_NAME, projected.args, f.options);
  const before = authorityCounts(f);
  let traps = 0;
  const getter = { get() { traps++; return PRIVATE_MARKER; }, configurable: true };
  const proxy = new Proxy({}, {
    get() { traps++; throw new Error(PRIVATE_MARKER); },
    ownKeys() { traps++; throw new Error(PRIVATE_MARKER); },
    getPrototypeOf() { traps++; throw new Error(PRIVATE_MARKER); },
    getOwnPropertyDescriptor() { traps++; throw new Error(PRIVATE_MARKER); },
  });
  if (kind === 'definition-getter') Object.defineProperty(f.tool, 'definition', getter);
  if (kind === 'executor-getter') Object.defineProperty(f.tool, 'execute', getter);
  if (kind === 'enum-getter') Object.defineProperty(f.parameters.properties.model.enum, '1', { ...getter, enumerable: true });
  if (kind === 'hidden-getter') Object.defineProperty(f.tool.definition, 'hidden', getter);
  if (kind === 'hidden-nested-getter') Object.defineProperty(f.tool.definition, 'hidden', { value: Object.defineProperty({}, 'nested', getter) });
  if (kind === 'definition-proxy') f.tool.definition = proxy as Tool['definition'];
  if (kind === 'enum-proxy') f.parameters.properties.model.enum[1] = proxy as unknown as string;
  if (kind === 'hidden-proxy') Object.defineProperty(f.tool.definition, 'hidden', { value: proxy });
  if (kind === 'hidden-nested-proxy') Object.defineProperty(f.tool.definition, 'hidden', { value: { nested: proxy } });
  expectRefused(() => f.checkProjectCurrent());
  expectRefused(() => f.registry.assertProjected(projected));
  expectRefused(() => f.registry.assertPrepared(prepared));
  let claims = 0;
  await expectRefusedAsync(() => f.registry.executePrepared(prepared, () => { claims++; }));
  expect(traps).toBe(0);
  expect(claims).toBe(0);
  expect(authorityCounts(f)).toEqual(before);
  expect(f.counts).toMatchObject({ projects: 1, reads: 0, bodies: 0, releases: 1 });
});

test.each(['overlong-string', 'too-many-nodes', 'oversized-sparse-array', 'too-deep', 'cycle', 'non-finite', 'symbol', 'custom-prototype'] as const)(
  'fresh capture retains the bounded plain-JSON rejection for %s', async kind => {
    const f = fixture();
    const projected = await f.registry.projectCall('malformed', TOOL_NAME, args(), f.options);
    const before = authorityCounts(f);
    let malformed: unknown;
    if (kind === 'overlong-string') malformed = PRIVATE_MARKER + 'x'.repeat(1_000_001);
    if (kind === 'too-many-nodes') malformed = Object.fromEntries(Array.from({ length: 20_001 }, (_, index) => [`entry-${index}`, null]));
    if (kind === 'oversized-sparse-array') malformed = new Array(20_001);
    if (kind === 'too-deep') {
      malformed = PRIVATE_MARKER;
      for (let level = 0; level < 66; level++) malformed = { nested: malformed };
    }
    if (kind === 'cycle') { const cycle: Record<string, unknown> = { marker: PRIVATE_MARKER }; cycle.self = cycle; malformed = cycle; }
    if (kind === 'non-finite') malformed = Infinity;
    if (kind === 'symbol') malformed = { [Symbol('unsupported')]: PRIVATE_MARKER };
    if (kind === 'custom-prototype') malformed = Object.create({ marker: PRIVATE_MARKER });
    Object.defineProperty(f.tool.definition, 'malformed', { value: malformed, enumerable: true });
    expectRefused(() => f.registry.assertProjected(projected));
    expectRefused(() => f.registry.assertProjectedSnapshot(projected));
    expect(authorityCounts(f)).toEqual(before);
    expect(f.counts).toMatchObject({ projects: 1, reads: 0, bodies: 0 });
    await f.registry.releaseProjected(projected);
    expect(f.counts.releases).toBe(1);
  },
);

test.each(['executor', 'projector', 'owner-callback', 'owner-signal-identity', 'registration', 'owner-abort', 'caller-abort', 'result-abort', 'capture-authority'] as const)(
  'an unchanged schema never caches authority across %s revocation', async revoke => {
    const f = fixture();
    const projected = await f.registry.projectCall('revoked', TOOL_NAME, args(), f.options);
    const prepared = await f.registry.prepareCall('revoked', TOOL_NAME, projected.args, f.options);
    const revision = prepared.schemaRevision;
    if (revoke === 'executor') f.tool.execute = async () => { f.counts.replacements++; return { success: true }; };
    if (revoke === 'projector') f.projector.project = async () => { f.counts.replacements++; return { status: 'held' }; };
    if (revoke === 'owner-callback') Object.defineProperty(f.projector, 'assertCurrent', { value: () => { f.counts.replacements++; } });
    if (revoke === 'owner-signal-identity') Object.defineProperty(f.projector, 'signal', { value: new AbortController().signal });
    if (revoke === 'registration') { f.registry.unregister(TOOL_NAME); f.registry.register(f.tool, { inputProjection: f.projector }); }
    if (revoke === 'owner-abort') f.owner.abort(new Error(PRIVATE_MARKER));
    if (revoke === 'caller-abort') f.caller.abort(new Error(PRIVATE_MARKER));
    if (revoke === 'result-abort') f.result.abort(new Error(PRIVATE_MARKER));
    if (revoke === 'capture-authority') f.controls.capture = () => { throw new Error(PRIVATE_MARKER); };
    let claims = 0;
    await expectRefusedAsync(() => f.registry.executePrepared(prepared, () => { claims++; }));
    expect(prepared.schemaRevision).toBe(revision);
    expect(claims).toBe(0);
    expect(f.counts).toMatchObject({ projects: 1, reads: 0, bodies: 0, replacements: 0, releases: 1 });
  },
);

test.each(['enum-mutation', 'credential-insertion', 'owner-abort', 'caller-abort', 'registration'] as const)(
  'the final admission callback cannot bypass fresh identity checks with %s', async revoke => {
    const f = fixture();
    const prepared = await f.registry.prepareCall('final-admission', TOOL_NAME, args(), f.options);
    let claims = 0;
    let callbacksAtClaim: number[] = [];
    await expectRefusedAsync(() => f.registry.executePrepared(prepared, () => {
      claims++; callbacksAtClaim = authorityCounts(f);
      if (revoke === 'enum-mutation') f.parameters.properties.model.enum[1] = 'catalog-model-c';
      if (revoke === 'credential-insertion') f.parameters.properties.model.enum[1] = `password=${PRIVATE_MARKER}`;
      if (revoke === 'owner-abort') f.owner.abort(new Error(PRIVATE_MARKER));
      if (revoke === 'caller-abort') f.caller.abort(new Error(PRIVATE_MARKER));
      if (revoke === 'registration') { f.registry.unregister(TOOL_NAME); f.registry.register(f.tool, { inputProjection: f.projector }); }
    }));
    expect(claims).toBe(1);
    expect(authorityCounts(f)).toEqual(callbacksAtClaim);
    expect(f.counts).toMatchObject({ projects: 1, reads: 0, bodies: 0, releases: 1 });
  },
);

test('mutation while the projector awaits is rejected before returned metadata can become a reusable call', async () => {
  const f = fixture();
  let start!: () => void;
  let resume!: () => void;
  const started = new Promise<void>(resolve => { start = resolve; });
  const finished = new Promise<void>(resolve => { resume = resolve; });
  f.controls.project = async () => { start(); await finished; };
  const pending = f.registry.projectCall('awaited-projection', TOOL_NAME, args(), f.options);
  await started;
  const before = authorityCounts(f);
  f.parameters.properties.model.enum[1] = `password=${PRIVATE_MARKER}`;
  resume();
  await expect(pending).rejects.toBeInstanceOf(ToolInputProjectionError);
  expect(authorityCounts(f)).toEqual(before);
  expect(f.counts).toMatchObject({ projects: 1, reads: 0, bodies: 0, releases: 1 });
});

test.each(['unchanged-control', 'source-revoked', 'schema-revoked'] as const)(
  'real recorded autonomous admission retains %s at the final hook', async mode => {
    forgetGateReadings();
    using log = new SqliteDecisionLog(':memory:');
    const gate = gateReadingsPort();
    const decision = fakePort((_name, question) => choiceAnswer(question, 'act', 0.99));
    let reads = 0;
    const boundedReader: JudgmentPort = { model: gate.port.model, async ask(request) {
      expect(++reads).toBeLessThan(32);
      request.beforeAttempt?.();
      return 'disposition' in request.questions ? decision.port.ask(request) : gate.port.ask(request);
    } };
    const previous = installJudgmentPort(withDecisionLog(boundedReader, log));
    const f = fixture();
    const source = { goal: 'Read the synthetic model catalog', criteria: ['Use the exact registered model'] };
    const config: PermissionConfigReader = {
      getAutonomousSnapshot: () => ({ permissions: { mode: 'prompt', tools: {} }, autoApprove: false, directory: '/synthetic/freshness' }),
      getSnapshot: () => ({ permissions: { mode: 'prompt', tools: {} } }),
      isAutoApproveEnabled: () => false, getWorkingDirectory: () => '/synthetic/freshness',
    } as PermissionConfigReader;
    const manager = new PermissionManager(undefined, config, new PolicyRuntimeState(), null, null, null, {});
    let hooks = 0;
    const deps: ToolExecutionDeps = {
      autonomousSource: () => source, permissionManager: manager, toolRegistry: f.registry,
      hookDispatcher: { async fire(event) {
        if (event.phase === 'Pre') {
          hooks++;
          if (mode === 'source-revoked') source.criteria[0] = 'Changed source criterion';
          if (mode === 'schema-revoked') f.parameters.properties.model.enum[1] = `password=${PRIVATE_MARKER}`;
        }
        return { ok: true, decision: 'allow' };
      } },
      runtimeBus: null, sessionId: 'registry-freshness',
      emitterContext: () => ({ sessionId: 'registry-freshness', traceId: 'synthetic', source: 'orchestrator' }),
    };
    try {
      const results = await executeToolCalls(deps, 'turn-freshness', [{ id: 'admitted-call', name: TOOL_NAME, arguments: args() }]);
      expect(hooks).toBe(1);
      expect(reads).toBeGreaterThan(0);
      expect(log.query({ site: 'engine.gate.autonomous-tool' })).toHaveLength(1);
      expect(results[0]?.success).toBe(mode === 'unchanged-control');
      expect(f.counts.bodies).toBe(mode === 'unchanged-control' ? 1 : 0);
      expect(f.counts.releases).toBe(1);
      expect(JSON.stringify(results)).not.toContain(PRIVATE_MARKER);
      expect(JSON.stringify(log.query())).not.toContain(PRIVATE_MARKER);
    } finally { installJudgmentPort(previous); forgetGateReadings(); }
  },
);
