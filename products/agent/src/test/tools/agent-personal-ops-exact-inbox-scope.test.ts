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
import { describePersonalOpsLane, runPersonalOpsRead } from '../../tools/agent-harness-personal-ops.ts';
import { cleanupResearchScreeningFixtures, ordinaryResearchOwner } from '../helpers/research-screening.ts';

// Authored synthetic protocol controls: the complete native catalog and real
// source/permission owners are exercised without genuine semantic claims.
afterAll(cleanupResearchScreeningFixtures);
let previous: ReturnType<typeof installJudgmentPort>;
beforeEach(() => { previous = installJudgmentPort(undefined); });
afterEach(() => { installJudgmentPort(previous); });

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected original captured fixture state');
  return Object.fromEntries(Object.entries(value));
}

function fixture() {
  const thread = { threadId: 'synthetic-thread', subject: 'Synthetic selected inbox source', status: 'unread' };
  const event = { eventId: 'synthetic-event', title: 'Synthetic nonselected calendar source', status: 'confirmed' };
  const reminder = { reminderId: 'synthetic-reminder', title: 'Synthetic nonselected reminder source', status: 'pending',
    readRoute: 'synthetic_read reminderId:"synthetic-reminder"' };
  const security = [
    { name: 'synthetic-correspondence', connected: true, trustMode: 'sandbox', role: 'default', schemaFreshness: 'fresh', allowedHosts: ['synthetic.invalid'] },
    { name: 'synthetic-agenda', connected: true, trustMode: 'sandbox', role: 'default', schemaFreshness: 'fresh', allowedHosts: ['synthetic.invalid'] },
  ];
  const tools = [
    { serverName: security[0]!.name, toolName: 'opaque_peek', description: 'Read an isolated synthetic inbox thread by its reference.' },
    { serverName: security[0]!.name, toolName: 'opaque_send', description: 'Send the reviewed synthetic inbox draft to its thread.' },
    { serverName: security[1]!.name, toolName: 'opaque_agenda', description: 'Read an isolated synthetic calendar event by its reference.' },
  ];
  const schemas = new Map(tools.map(tool => [`mcp:${tool.serverName}:${tool.toolName}`, {
    inputSchema: { type: 'object', properties: { reference: { type: 'string', description: 'Identifier of the isolated thread or event.' } }, required: ['reference'] },
  }]));
  const counters = { lists: 0, schemaReads: [] as string[], calls: 0 };
  const inbox = { getSnapshot: () => ({ threads: [thread] }) };
  const calendar = { getSnapshot: () => ({ events: [event] }) };
  const reminders = { getSnapshot: () => ({ reminders: [reminder] }) };
  const api = {
    listServerSecurity() { return security; },
    async listAllTools() { counters.lists++; return tools; },
    async getToolSchema(qualifiedName: string) { counters.schemaReads.push(qualifiedName); return schemas.get(qualifiedName) ?? null; },
    async callTool() { counters.calls++; throw new Error('Refused fixture must never execute an MCP tool'); },
  };
  // No installed interactive session or provider: these are native host DTOs
  // and an inert local MCP API, not a fabricated tool invocation authority.
  const context = { platform: { config: {}, readModels: { personalOps: { inboxThreads: inbox, calendarEvents: calendar, reminders } } },
    clients: { mcpApi: api }, session: { runtime: { sessionId: 'exact-inbox-synthetic' } } } as unknown as CommandContext;
  return { context, thread, event, reminder, security, tools, schemas, counters, api };
}

function reader(source: ReturnType<typeof fixture>, beforeAnswer?: (name: string, state: unknown) => void) {
  const native = getOperatorContract().operator.methods;
  const selected = native.find(method => method.invokable !== false);
  if (!selected) throw new Error('Native fixture needs one invokable original method');
  const expected = new Map(native.map(method => [method.id, JSON.stringify(captureModelReadingInput(method))]));
  const expectedServers = new Map(source.security.map(server => [server.name, JSON.stringify(captureModelReadingInput({ server,
    tools: source.tools.filter(tool => tool.serverName === server.name).map(tool => ({ ...tool,
      schema: source.schemas.get(`mcp:${tool.serverName}:${tool.toolName}`) ?? null })) }))]));
  const expectedContracts = new Map(source.tools.map(tool => [tool.toolName, JSON.stringify({ server: tool.serverName,
    tool: tool.toolName, description: tool.description, inputSchema: source.schemas.get(`mcp:${tool.serverName}:${tool.toolName}`)?.inputSchema ?? null })]));
  const seen = new Map<string, number>();
  const negatives = new Set(['lineHasCredential', 'spanIsCredential', 'credentialRemains', 'identifying',
    'mutates', 'outward', 'secrets', 'obfuscated', 'catastrophic', 'cardDetails', 'irreversible', 'beyondProject', 'weakensSecurity',
    'flagsRisk', 'needsNetwork', 'needsPrivilege', 'platform_source', 'platform_requested']);
  const fake = fakePort((name, question, state) => {
    beforeAnswer?.(name, state);
    if (name === 'match' && question.type === 'noul') {
      const current = object(state), candidate = object(current.candidate);
      if (typeof candidate.name !== 'string' || typeof candidate.evidenceJson !== 'string') throw new Error('Missing complete fixture candidate');
      const metadata = expected.get(candidate.name);
      if (metadata !== undefined) {
        expect(candidate.evidenceJson).toBe(metadata);
        seen.set(candidate.name, (seen.get(candidate.name) ?? 0) + 1);
        // Declared synthetic settled membership, identical in full/selected paths.
        return noulAnswer(candidate.name === selected.id ? 0.999 : 0.001);
      }
      const server = expectedServers.get(candidate.name);
      if (server === undefined) throw new Error('Unscripted catalog candidate');
      expect(candidate.evidenceJson).toBe(server);
      if (current.query !== 'inbox' && current.query !== 'calendar') throw new Error('Unscripted connector lane');
      return noulAnswer(candidate.name === (current.query === 'inbox' ? source.security[0]!.name : source.security[1]!.name) ? 0.999 : 0.001);
    }
    if (name === 'lane' && question.type === 'choice') {
      const contract = object(state);
      if (typeof contract.tool !== 'string' || JSON.stringify(contract) !== expectedContracts.get(contract.tool)) throw new Error('Unscripted complete tool contract');
      return choiceAnswer(question, contract.tool === 'opaque_agenda' ? 'calendar' : 'inbox', 0.999);
    }
    if (name === 'role' && question.type === 'choice') {
      const sample = object(state), contract = object(sample.contract);
      if (sample.field !== 'reference' || typeof contract.tool !== 'string'
        || JSON.stringify(contract) !== expectedContracts.get(contract.tool)
        || JSON.stringify(sample.inputSchema) !== JSON.stringify(contract.inputSchema)) throw new Error('Unscripted complete field contract');
      return choiceAnswer(question, 'record', 0.999);
    }
    if (question.type === 'noul' && negatives.has(name)) {
      if (name === 'mutates' || name === 'outward' || name === 'secrets') {
        const entry = object(state);
        if (typeof entry.server === 'string') {
          const { arguments: _arguments, ...contract } = entry;
          if (typeof contract.tool !== 'string' || JSON.stringify(contract) !== expectedContracts.get(contract.tool)) throw new Error('Unscripted complete effect contract');
          return noulAnswer(contract.tool === 'opaque_send' && name !== 'secrets' ? 0.999 : 0.001);
        }
      }
      return noulAnswer(0.001);
    }
    if (question.type === 'choice') {
      const label = name === 'kind' && Object.hasOwn(question.criteria, 'owner_profile') ? 'other'
        : name === 'kind' ? 'read' : name === 'hazard' ? 'none' : name === 'family' || name === 'capability' ? 'generic'
          : name === 'disposition' ? 'act' : undefined;
      if (label && Object.hasOwn(question.criteria, label)) return choiceAnswer(question, label, 0.999);
    }
    throw new Error(`Unscripted exact-inbox protocol question ${name}`);
  });
  return { fake, native, seen };
}

const readingOptions = () => ({ sourceOwner: ordinaryResearchOwner() });
const readId = 'mcp:synthetic-correspondence:opaque_peek';
const sendId = 'mcp:synthetic-correspondence:opaque_send';

describe('Personal Ops exact native inbox contract dependencies', () => {
  test('literal inbox has the complete full-path DTO while query and target retain all four complete method selections', async () => {
    const source = fixture();
    const exactReader = reader(source); installJudgmentPort(exactReader.fake.port);
    const exact = await describePersonalOpsLane(source.context, { laneId: 'inbox', includeParameters: true }, readingOptions());
    expect(exact).toMatchObject({ status: 'found', lane: { id: 'inbox', status: 'ready', methodIds: expect.any(Array),
      connectorSignals: expect.any(Array), workflows: expect.any(Array), liveRecords: expect.any(Array) } });
    expect(exactReader.seen.size).toBe(exactReader.native.length);
    expect([...exactReader.seen.values()].every(count => count === 1)).toBe(true);
    expect(source.counters.schemaReads).toEqual([...source.schemas.keys()]);
    for (const args of [{ query: 'inbox', includeParameters: true }, { target: 'inbox', includeParameters: true }]) {
      const fullReader = reader(source); installJudgmentPort(fullReader.fake.port);
      expect(await describePersonalOpsLane(source.context, args, readingOptions())).toEqual(exact);
      expect(fullReader.seen.size).toBe(fullReader.native.length);
      expect([...fullReader.seen.values()].every(count => count === 4)).toBe(true);
    }
    expect(source.counters.calls).toBe(0);
  }, 60_000);

  test('explicit inbox records preserve missing identity, required fields, recorded-admission boundary and send refusal without MCP effects', async () => {
    const source = fixture();
    for (const [args, expected] of [
      [{ laneId: 'inbox', recordId: 'mcp:synthetic-agenda:opaque_agenda' }, { status: 'missing_lookup' }],
      [{ laneId: 'inbox', recordId: readId }, { status: 'missing_fields', missingFields: ['reference'] }],
      [{ laneId: 'inbox', recordId: readId, fields: { reference: 'synthetic-thread' } }, { status: 'needs_admission', inputPreview: { reference: 'synthetic-thread' } }],
      [{ laneId: 'inbox', recordId: sendId, fields: { reference: 'synthetic-thread' } }, { status: 'blocked', reason: 'not_read_only' }],
    ] satisfies readonly (readonly [Parameters<typeof runPersonalOpsRead>[1], Record<string, unknown>])[]) {
      const scripted = reader(source); installJudgmentPort(scripted.fake.port);
      expect(await runPersonalOpsRead(source.context, args, readingOptions())).toMatchObject(expected);
      expect(scripted.seen.size).toBe(scripted.native.length);
      expect([...scripted.seen.values()].every(count => count === 1)).toBe(true);
    }
    expect(source.counters.lists).toBe(4); expect(source.counters.schemaReads).toHaveLength(4 * source.tools.length);
    expect(source.counters.calls).toBe(0);
  }, 60_000);

  test('query and target reads retain full populations and the same selected record boundary', async () => {
    const source = fixture();
    const exactReader = reader(source); installJudgmentPort(exactReader.fake.port);
    const exact = await runPersonalOpsRead(source.context, { laneId: 'inbox', recordId: readId,
      fields: { reference: 'synthetic-thread' } }, readingOptions());
    expect(exact).toMatchObject({ status: 'needs_admission' });
    for (const lookup of [{ query: readId }, { target: readId }, { recordId: readId, query: 'synthetic extra lookup' }]) {
      const fullReader = reader(source); installJudgmentPort(fullReader.fake.port);
      expect(await runPersonalOpsRead(source.context, { laneId: 'inbox', ...lookup,
        fields: { reference: 'synthetic-thread' } }, readingOptions())).toEqual(exact);
      expect(fullReader.seen.size).toBe(fullReader.native.length);
      expect([...fullReader.seen.values()].every(count => count === 4)).toBe(true);
    }
    expect(source.counters.calls).toBe(0);
  }, 60_000);

  test('all raw MCP schemas remain captured without invoking hidden nonselected accessors', async () => {
    const source = fixture(); let getters = 0, published = 0;
    const schema = source.schemas.get('mcp:synthetic-agenda:opaque_agenda');
    if (!schema) throw new Error('Missing original nonselected schema');
    const scripted = reader(source); installJudgmentPort(scripted.fake.port);
    Object.defineProperty(schema, 'opaqueMetadata', { configurable: true, enumerable: false, get() { getters++; return 'unused'; } });
    await expect(describePersonalOpsLane(source.context, { laneId: 'inbox' }, { ...readingOptions(), retainCurrent(_guard, key) { if (key === 'personal-ops-lanes') published++; } })).rejects.toThrow();
    expect(source.counters.schemaReads).toEqual([...source.schemas.keys()]);
    expect(scripted.seen.size).toBe(0); expect(getters).toBe(0); expect(published).toBe(0);
  });

  test('hidden nonselected provider metadata remains refused without accessor calls or selected publication', async () => {
    const source = fixture(); let getters = 0, published = 0;
    const scripted = reader(source); installJudgmentPort(scripted.fake.port);
    Object.defineProperty(source.event, 'opaqueMetadata', { enumerable: false, get() { getters++; return 'unused'; } });
    await expect(describePersonalOpsLane(source.context, { laneId: 'inbox' },
      { ...readingOptions(), retainCurrent(_guard, key) { if (key === 'personal-ops-lanes') published++; } })).rejects.toThrow();
    expect(getters).toBe(0); expect(published).toBe(0); expect(source.counters.calls).toBe(0);
  });

  test('a nonselected calendar source changing during its actual privacy read prevents inbox record publication', async () => {
    const source = fixture(); let changed = false, published = 0;
    const scripted = reader(source, (name, state) => {
      if (!changed && name !== 'match' && JSON.stringify(state).includes(source.event.title)) {
        changed = true; source.event.title = 'Competing native nonselected calendar source';
      }
    });
    installJudgmentPort(scripted.fake.port);
    await expect(runPersonalOpsRead(source.context, { laneId: 'inbox', recordId: readId, fields: { reference: 'synthetic-thread' } },
      { ...readingOptions(), retainCurrent(_guard, key) { if (key === 'personal-ops-lanes') published++; } })).rejects.toThrow();
    expect(changed).toBe(true); expect(published).toBe(0); expect(source.counters.calls).toBe(0);
  }, 60_000);

  test('caller cancellation during the complete inbox method response prevents later selection and publication', async () => {
    const source = fixture(); const controller = new AbortController(); let matches = 0, published = 0;
    const scripted = reader(source, name => { if (name === 'match' && ++matches === 17) controller.abort(new Error('Synthetic caller cancellation')); });
    installJudgmentPort(scripted.fake.port);
    await expect(runPersonalOpsRead(source.context, { laneId: 'inbox', recordId: readId }, { ...readingOptions(), signal: controller.signal,
      retainCurrent(_guard, key) { if (key === 'personal-ops-lanes') published++; } })).rejects.toThrow();
    expect(matches).toBeGreaterThanOrEqual(17); expect(matches).toBeLessThanOrEqual(32); expect(published).toBe(0); expect(source.counters.calls).toBe(0);
  });

  test('native reader retirement during the inbox method response cannot publish or execute a record', async () => {
    const source = fixture(); let matches = 0, published = 0;
    const scripted = reader(source, name => { if (name === 'match' && ++matches === 17) installJudgmentPort(undefined); });
    installJudgmentPort(scripted.fake.port);
    await expect(runPersonalOpsRead(source.context, { laneId: 'inbox', recordId: readId }, { ...readingOptions(), retainCurrent(_guard, key) { if (key === 'personal-ops-lanes') published++; } })).rejects.toThrow();
    expect(matches).toBeGreaterThanOrEqual(17); expect(matches).toBeLessThanOrEqual(32); expect(published).toBe(0); expect(source.counters.calls).toBe(0);
  });

  test('a recorded native admission remains live through the literal inbox source read and refuses revocation before publication', async () => {
    const source = fixture(); let mode: PermissionMode = 'prompt', entered = false, revoked = false, published = 0;
    const directory = '/synthetic/exact-inbox';
    const permissions = () => ({ ...DEFAULT_CONFIG.permissions, mode, tools: {} });
    const configReader: PermissionConfigReader = {
      getAutonomousSnapshot: () => ({ permissions: permissions(), autoApprove: false, directory }),
      getSnapshot: () => ({ permissions: permissions() }), isAutoApproveEnabled: () => false, getWorkingDirectory: () => directory,
    };
    const manager = new PermissionManager(undefined, configReader, new PolicyRuntimeState()), registry = new ToolRegistry(manager);
    registry.register({ definition: { name: 'native_exact_inbox_read', description: 'Inspect the isolated synthetic inbox lane without provider effects.',
      parameters: { type: 'object', properties: { laneId: { type: 'string', enum: ['inbox'] } }, required: ['laneId'], additionalProperties: false } },
      async execute(args, executionOptions) {
        entered = true; expect(assertCurrentToolInvocation(args, executionOptions)).toBe(true);
        const lane = await describePersonalOpsLane(source.context, args, { ...readingOptions(), signal: executionOptions?.signal,
          assertCurrent() { if (!assertCurrentToolInvocation(args, executionOptions)) throw new ToolInputProjectionError('held'); } });
        published++; return { success: true, output: JSON.stringify(lane) };
      },
    });
    const scripted = reader(source, () => { if (entered && !revoked) { revoked = true; mode = 'plan'; } });
    using log = new SqliteDecisionLog(':memory:'); installJudgmentPort(withDecisionLog(scripted.fake.port, log));
    const call = await registry.prepareCall('synthetic-exact-inbox-revocation', 'native_exact_inbox_read', { laneId: 'inbox' });
    const admission = await manager.admitAutonomous('synthetic-exact-inbox-revocation', 'native_exact_inbox_read', call.args, {
      sourceOf: () => ({ goal: 'Inspect an isolated synthetic inbox lane', criteria: ['No external effects or real private source'] }),
      schemaRevision: call.schemaRevision, preparedCall: { registry, call },
    });
    expect(admission.result.autonomousDecision?.outcome).toBe('act');
    await expect(registry.executePrepared(call, admission)).rejects.toBeInstanceOf(ToolInputProjectionError);
    expect(entered).toBe(true); expect(revoked).toBe(true); expect(published).toBe(0); expect(source.counters.calls).toBe(0);
  });
});
