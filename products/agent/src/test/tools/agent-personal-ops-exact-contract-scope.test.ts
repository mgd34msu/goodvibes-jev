import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { getOperatorContract } from '@goodvibes-jev/engine/sdk/contracts';
import { DEFAULT_CONFIG, type PermissionMode } from '@goodvibes-jev/engine/sdk/platform/config';
import { PermissionManager, type PermissionConfigReader } from '@goodvibes-jev/engine/sdk/platform/permissions';
import { PolicyRuntimeState } from '@goodvibes-jev/engine/sdk/platform/runtime/security';
import { ToolRegistry, ToolInputProjectionError, assertCurrentToolInvocation } from '@goodvibes-jev/engine/sdk/platform/tools';
import { SqliteDecisionLog, withDecisionLog } from '@goodvibes-jev/judgment';
import { choiceAnswer, fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import type { CommandContext } from '../../input/command-registry.ts';
import { captureModelReadingInput } from '../../tools/agent-harness-model-reading-source.ts';
import { describePersonalOpsLane } from '../../tools/agent-harness-personal-ops.ts';
import { cleanupResearchScreeningFixtures, ordinaryResearchOwner } from '../helpers/research-screening.ts';

// These are authored synthetic protocol controls, not genuine semantic readings.
// The original native catalog, complete schemas and source owners remain real.
afterAll(cleanupResearchScreeningFixtures);
let previous: ReturnType<typeof installJudgmentPort>;
beforeEach(() => { previous = installJudgmentPort(undefined); });
afterEach(() => { installJudgmentPort(previous); });

function fixture() {
  const thread = { threadId: 'synthetic-thread', subject: 'Synthetic nonselected inbox source', status: 'unread' };
  const reminder = { reminderId: 'synthetic-reminder', title: 'Synthetic selected reminder', status: 'pending',
    readRoute: 'synthetic_read reminderId:"synthetic-reminder"' };
  const inbox = { getSnapshot: () => ({ threads: [thread] }) };
  const reminders = { getSnapshot: () => ({ reminders: [reminder] }) };
  const context = { platform: { config: {}, readModels: { personalOps: { inboxThreads: inbox, reminders } } }, clients: {},
    session: { runtime: { sessionId: 'exact-lane-synthetic' } } } as unknown as CommandContext;
  return { context, thread, reminder, inbox };
}

function reader(beforeAnswer?: (name: string, state: unknown) => void) {
  const native = getOperatorContract().operator.methods;
  const selected = native.find(method => method.invokable !== false);
  if (!selected) throw new Error('Native fixture needs one invokable original method');
  const expected = new Map(native.map(method => [method.id, JSON.stringify(captureModelReadingInput(method))]));
  const seen = new Map<string, number>();
  const negatives = new Set(['lineHasCredential', 'spanIsCredential', 'credentialRemains', 'identifying',
    'mutates', 'outward', 'secrets', 'obfuscated', 'catastrophic', 'cardDetails', 'irreversible', 'beyondProject', 'weakensSecurity',
    'flagsRisk', 'needsNetwork', 'needsPrivilege', 'platform_source', 'platform_requested']);
  const fake = fakePort((name, question, state) => {
    beforeAnswer?.(name, state);
    if (name === 'match' && question.type === 'noul') {
      if (!state || typeof state !== 'object' || !('candidate' in state)) throw new Error('Missing original candidate');
      const candidate = state.candidate;
      if (!candidate || typeof candidate !== 'object' || !('name' in candidate) || typeof candidate.name !== 'string'
        || !('evidenceJson' in candidate) || typeof candidate.evidenceJson !== 'string') throw new Error('Missing complete method metadata');
      const originalEvidence = expected.get(candidate.name);
      if (originalEvidence === undefined) throw new Error('Unregistered original method metadata');
      expect(candidate.evidenceJson).toBe(originalEvidence);
      seen.set(candidate.name, (seen.get(candidate.name) ?? 0) + 1);
      return noulAnswer(candidate.name === selected.id ? 0.999 : 0.001);
    }
    if (question.type === 'noul' && negatives.has(name)) return noulAnswer(0.001);
    if (question.type === 'choice') {
      const label = name === 'kind' && Object.hasOwn(question.criteria, 'owner_profile') ? 'other'
        : name === 'kind' ? 'read' : name === 'hazard' ? 'none' : name === 'family' || name === 'capability' ? 'generic'
          : name === 'disposition' ? 'act' : name === 'lane' ? 'neither' : undefined;
      if (label && Object.hasOwn(question.criteria, label)) return choiceAnswer(question, label, 0.999);
    }
    throw new Error(`Unscripted exact-lane protocol question ${name}`);
  });
  return { fake, native, expected, seen };
}

const readingOptions = () => ({ sourceOwner: ordinaryResearchOwner() });

describe('Personal Ops exact native lane contract dependencies', () => {
  test('literal notes matches the full query result while query and target keep all four complete selections', async () => {
    const { context } = fixture();
    const exactReader = reader(); installJudgmentPort(exactReader.fake.port);
    const exact = await describePersonalOpsLane(context, { laneId: 'notes', includeParameters: true }, readingOptions());
    expect(exact).toMatchObject({ status: 'found', lane: { id: 'notes', status: 'ready' } });
    expect(exactReader.seen.size).toBe(0);
    for (const args of [{ query: 'notes', includeParameters: true }, { target: 'notes', includeParameters: true }]) {
      const fullReader = reader(); installJudgmentPort(fullReader.fake.port);
      expect(await describePersonalOpsLane(context, args, readingOptions())).toEqual(exact);
      expect(fullReader.seen.size).toBe(fullReader.native.length);
      expect([...fullReader.seen.values()].every(count => count === 4)).toBe(true);
    }
  }, 60_000);

  test('literal reminders keeps every complete original method candidate and the full result fields', async () => {
    const { context } = fixture();
    const exactReader = reader(); installJudgmentPort(exactReader.fake.port);
    const exact = await describePersonalOpsLane(context, { laneId: 'reminders', includeParameters: true }, readingOptions());
    expect(exact).toMatchObject({ status: 'found', lane: { id: 'reminders', status: 'ready', liveRecords: expect.any(Array) } });
    expect(exactReader.seen.size).toBe(exactReader.native.length);
    expect([...exactReader.seen.values()].every(count => count === 1)).toBe(true);
    expect(Math.max(...[...exactReader.expected.values()].map(value => value.length))).toBeGreaterThan(40_000);
    const fullReader = reader(); installJudgmentPort(fullReader.fake.port);
    expect(await describePersonalOpsLane(context, { query: 'reminders', includeParameters: true }, readingOptions())).toEqual(exact);
    expect(fullReader.seen.size).toBe(fullReader.native.length);
    expect([...fullReader.seen.values()].every(count => count === 4)).toBe(true);
  }, 60_000);

  test('unsupported hidden metadata in a nonselected provider remains held without invoking its accessor', async () => {
    const { context, thread } = fixture(); let getters = 0, published = 0;
    Object.defineProperty(thread, 'opaqueMetadata', { configurable: true, enumerable: false, get() { getters++; return 'unused'; } });
    const scripted = reader(); installJudgmentPort(scripted.fake.port);
    await expect(describePersonalOpsLane(context, { laneId: 'notes' }, { ...readingOptions(), retainCurrent() { published++; } })).rejects.toThrow();
    expect(getters).toBe(0); expect(published).toBe(0); expect(scripted.seen.size).toBe(0);
  });

  test('exact notes still acquires all raw MCP schemas and refuses malformed nonselected schema metadata', async () => {
    const { context } = fixture(); let lists = 0, schemas = 0, getters = 0;
    const schema = { inputSchema: { type: 'object', properties: {} } };
    Object.defineProperty(schema, 'opaqueMetadata', { enumerable: false, get() { getters++; return 'unused'; } });
    const withMcp = { ...context, clients: { ...context.clients, mcpApi: {
      async listAllTools() { lists++; return [{ serverName: 'synthetic', toolName: 'opaque_operation', description: 'Synthetic unrelated operation' }]; },
      async getToolSchema() { schemas++; return schema; },
    } } } as unknown as CommandContext;
    const scripted = reader(); installJudgmentPort(scripted.fake.port);
    await expect(describePersonalOpsLane(withMcp, { laneId: 'notes' }, readingOptions())).rejects.toThrow();
    expect(lists).toBe(1); expect(schemas).toBe(1); expect(getters).toBe(0); expect(scripted.seen.size).toBe(0);
  });

  test('a nonselected provider changing during its actual privacy read prevents selected publication', async () => {
    const { context, thread } = fixture(); let changed = false, published = 0;
    const scripted = reader((name, state) => {
      if (!changed && name !== 'match' && JSON.stringify(state).includes(thread.subject)) {
        changed = true; thread.subject = 'Competing native nonselected inbox source';
      }
    });
    installJudgmentPort(scripted.fake.port);
    await expect(describePersonalOpsLane(context, { laneId: 'notes' }, { ...readingOptions(), retainCurrent() { published++; } })).rejects.toThrow();
    expect(changed).toBe(true); expect(published).toBe(0);
  });

  test('caller cancellation during a later reminders response prevents further selections or publication', async () => {
    const { context } = fixture(); const controller = new AbortController(); let matches = 0, published = 0;
    const scripted = reader(name => { if (name === 'match' && ++matches === 17) controller.abort(new Error('Synthetic caller cancellation')); });
    installJudgmentPort(scripted.fake.port);
    await expect(describePersonalOpsLane(context, { laneId: 'reminders' }, { ...readingOptions(), signal: controller.signal,
      retainCurrent() { published++; } })).rejects.toThrow();
    expect(matches).toBeGreaterThanOrEqual(17); expect(matches).toBeLessThanOrEqual(32); expect(published).toBe(0);
  });

  test('native port retirement during a reminders response cannot publish a selected lane', async () => {
    const { context } = fixture(); let matches = 0, published = 0;
    const scripted = reader(name => { if (name === 'match' && ++matches === 17) installJudgmentPort(undefined); });
    installJudgmentPort(scripted.fake.port);
    await expect(describePersonalOpsLane(context, { laneId: 'reminders' }, { ...readingOptions(), retainCurrent() { published++; } })).rejects.toThrow();
    expect(matches).toBeGreaterThanOrEqual(17); expect(matches).toBeLessThanOrEqual(32); expect(published).toBe(0);
  });

  test('a real recorded permission admission remains live during the exact notes source read', async () => {
    const { context } = fixture(); let mode: PermissionMode = 'prompt', entered = false, revoked = false, published = 0;
    const directory = '/synthetic/exact-lane';
    const permissions = () => ({ ...DEFAULT_CONFIG.permissions, mode, tools: {} });
    const configReader: PermissionConfigReader = {
      getAutonomousSnapshot: () => ({ permissions: permissions(), autoApprove: false, directory }),
      getSnapshot: () => ({ permissions: permissions() }), isAutoApproveEnabled: () => false, getWorkingDirectory: () => directory,
    };
    const manager = new PermissionManager(undefined, configReader, new PolicyRuntimeState()), registry = new ToolRegistry(manager);
    registry.register({ definition: { name: 'native_exact_lane_read', description: 'Inspect the isolated synthetic local lane.',
      parameters: { type: 'object', properties: { laneId: { type: 'string', enum: ['notes'] } }, required: ['laneId'], additionalProperties: false } },
      async execute(args, executionOptions) {
        entered = true;
        expect(assertCurrentToolInvocation(args, executionOptions)).toBe(true);
        const lane = await describePersonalOpsLane(context, args, { ...readingOptions(), signal: executionOptions?.signal,
          assertCurrent() { if (!assertCurrentToolInvocation(args, executionOptions)) throw new ToolInputProjectionError('held'); } });
        published++; return { success: true, output: JSON.stringify(lane) };
      },
    });
    const scripted = reader(() => { if (entered && !revoked) { revoked = true; mode = 'plan'; } });
    using log = new SqliteDecisionLog(':memory:'); installJudgmentPort(withDecisionLog(scripted.fake.port, log));
    const call = await registry.prepareCall('synthetic-exact-lane-revocation', 'native_exact_lane_read', { laneId: 'notes' });
    const admission = await manager.admitAutonomous('synthetic-exact-lane-revocation', 'native_exact_lane_read', call.args, {
      sourceOf: () => ({ goal: 'Inspect an isolated local synthetic note lane', criteria: ['No external effects or real private source'] }),
      schemaRevision: call.schemaRevision, preparedCall: { registry, call },
    });
    expect(admission.result.autonomousDecision?.outcome).toBe('act');
    await expect(registry.executePrepared(call, admission)).rejects.toBeInstanceOf(ToolInputProjectionError);
    expect(entered).toBe(true); expect(revoked).toBe(true); expect(published).toBe(0);
  });
});
