import { createPersonalOpsInputProjector } from '../../tools/agent-personal-ops-ingress.ts';
import { runPersonalOpsRead } from '../../tools/agent-harness-personal-ops.ts';
import { registerAgentHarnessTool } from '../../tools/agent-harness-tool.ts';
import { ordinaryResearchOwner, cleanupResearchScreeningFixtures, researchScreeningFixture, exactSensitiveSpans } from '../helpers/research-screening.ts';
import { bindAgentResearchSourceOwner } from '../../agent/protected-research-report.ts';
import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { installJudgmentPort, JudgmentPortMissingError } from '@goodvibes-jev/engine/errors';
import { ToolRegistry } from '@goodvibes-jev/engine/sdk/platform/tools';
import { SqliteDecisionLog, withDecisionLog } from '@goodvibes-jev/judgment';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import type { CommandContext, CommandRegistry } from '../../input/command-registry.ts';
import { rankHarnessCatalog } from '../../tools/agent-harness-catalog-ranking.ts';
import { buildPersonalOpsIntakeCandidates, selectConnectorTool } from '../../tools/agent-harness-personal-ops-intake.ts';
import { resolveRunRecord } from '../../tools/agent-harness-personal-ops-runner.ts';
import { createAgentPersonalOpsTool, registerAgentPersonalOpsTool } from '../../tools/agent-personal-ops-tool.ts';
import { LANE_IDS, type PersonalOpsConnectorSignal, type PersonalOpsLane, type PersonalOpsLiveRecord, type PersonalOpsWorkflow } from '../../tools/agent-harness-personal-ops-types.ts';

afterAll(cleanupResearchScreeningFixtures);
const rankingOptions = () => ({ sourceOwner: ordinaryResearchOwner() });

let previous: ReturnType<typeof installJudgmentPort>;
beforeEach(() => { previous = installJudgmentPort(undefined); });
afterEach(() => { installJudgmentPort(previous); });

function readings(probabilities: Readonly<Record<string, number>>) {
  return fakePort((_name, _question, rawState) => {
    const state = rawState as unknown as { candidate: { name: string } };
    return noulAnswer(probabilities[state.candidate.name] ?? 0.01);
  });
}
const workflows = ['inbox-draft-reply', 'inbox-triage-briefing', 'calendar-agenda-briefing', 'calendar-conflict-scan'].map((id): PersonalOpsWorkflow => ({
  id, label: id, status: 'ready', summary: id, next: 'inspect', modelRoute: 'inspect exact schema', inspectRoutes: ['inspect'], prerequisites: [], runBoundary: 'separate confirmation',
}));
function record(id: string, effect: PersonalOpsLiveRecord['effect'] = 'read-only'): PersonalOpsLiveRecord {
  return { id, label: id, summary: id, status: 'ready', modelRoute: id, userRoute: id, effect };
}
function lanes(): PersonalOpsLane[] {
  return LANE_IDS.map((id) => ({ id, label: id, status: 'ready', outcome: 'fixture', current: 'fixture', next: 'inspect', userRoute: id, modelRoute: id, signals: [], workflows,
    liveRecords: [record('host-tasks-list'), record('workplan-add'), record('reminder-create')],
  }));
}
function connector(): PersonalOpsConnectorSignal {
  return { id: 'connector', kind: 'mcp-server', label: 'fixture', status: 'ready', summary: 'fixture', modelRoute: 'inspect', toolCount: 3, capabilityTags: ['inbox-read'],
    readTools: [
      { name: 'search_inbox', effect: 'read-only', capability: 'inbox-read', description: 'An unrelated capability whose name overlaps the request.' },
      { name: 'opaque_operation', effect: 'read-only', capability: 'inbox-read', description: 'The operation selected by the recorded reading.' },
      { name: 'write_hidden_in_reads', effect: 'confirmed-effect', capability: 'inbox-read' },
    ],
  };
}
const context = { extensions: {}, clients: {}, ops: {}, workspace: {}, platform: { config: {} }, session: { runtime: {} } } as CommandContext;
function caller() {
  const toolRegistry = new ToolRegistry(); bindAgentResearchSourceOwner(toolRegistry, ordinaryResearchOwner());
  return createAgentPersonalOpsTool({ commandContext: context, commandRegistry: {} as CommandRegistry, toolRegistry });
}

describe('PersonalOps canonical catalog readings', () => {
  test('intent uses the reading despite contradictory keywords and preserves probability order', async () => {
    const fake = readings({ 'capture-scratchpad-note': 0.96, 'routine-review-or-promotion': 0.85 });
    installJudgmentPort(fake.port);
    const result = await buildPersonalOpsIntakeCandidates('email inbox calendar reminder', lanes(), true, rankingOptions());
    expect(result.candidates.map(({ id }) => id)).toEqual(['capture-scratchpad-note', 'routine-review-or-promotion']);
    expect(result.candidates[0]?.judgment?.probability).toBeCloseTo(0.96);
    expect(result.judgments).toHaveLength(10);
    expect(fake.requests.every((request) => request.context?.battery === 'engine.tools.registry-rank')).toBe(true);
    expect(fake.requests.every((request) => request.context?.site === 'agent.personal-ops.intake')).toBe(true);
  });

  test('uncertain intake carries its reading without selecting connector operations', async () => {
    const fake = readings({ 'inbox-draft-reply': 0.5 });
    installJudgmentPort(fake.port);
    const all = lanes();
    all[0] = { ...all[0]!, connectorSignals: [connector()] };
    const result = await buildPersonalOpsIntakeCandidates('inbox reply', all, true, rankingOptions());
    expect(result.candidates[0]?.judgment?.reading.verdict).toBe('uncertain');
    expect(result.candidates[0]?.operation).toBeUndefined();
    expect(result.candidates[0]?.confidence).toBe('low');
    expect(fake.requests).toHaveLength(10);
  });

  test('negative intake never manufactures a task or preferred route', async () => {
    installJudgmentPort(readings({}).port);
    const result = await caller().execute({ action: 'intake', query: 'send email' });
    expect(result.success).toBe(true);
    const output = JSON.parse(String(result.output));
    expect(output.status).toBe('deferred');
    expect(output.candidates).toEqual([]);
    expect(output.preferred).toBeUndefined();
    expect(output.laneRoute).toBeUndefined();
    expect(output.judgments).toHaveLength(10);
  });

  test('real personal_ops facade reaches the engine reader and preserves effect boundaries', async () => {
    installJudgmentPort(readings({ 'capture-scratchpad-note': 0.98 }).port);
    const result = await caller().execute({ action: 'intake', query: 'email calendar send' });
    const output = JSON.parse(String(result.output));
    expect(output.preferred.id).toBe('capture-scratchpad-note');
    expect(output.preferred.judgment.reading.verdict).toBe('yes');
    expect(output.policy).toContain('explicit confirmation');
  });

  test('connector relevance comes from Jev, never token weights or a wrong-effect row', async () => {
    const fake = readings({ 'connector:opaque_operation': 0.98, 'connector:write_hidden_in_reads': 0.999 });
    installJudgmentPort(fake.port);
    const lane = { ...lanes()[0]!, connectorSignals: [connector()] };
    const selected = await selectConnectorTool(lane, 'read-only', 'inbox-read', 'search inbox', rankingOptions());
    expect(selected?.tool.name).toBe('opaque_operation');
    expect(selected?.judgment.probability).toBeCloseTo(0.98);
    expect(fake.requests).toHaveLength(2);
  });

  test('unsure or negative connector readings do not select a lexical fallback', async () => {
    const lane = { ...lanes()[0]!, connectorSignals: [connector()] };
    for (const probability of [0.5, 0.01]) {
      installJudgmentPort(readings({ 'connector:search_inbox': probability }).port);
      expect(await selectConnectorTool(lane, 'read-only', 'inbox-read', 'search inbox', rankingOptions())).toBeUndefined();
    }
  });

  test('record lookup keeps exact identity and refuses missing explicit ids without judgment', async () => {
    const all = lanes();
    const options = { laneId: 'tasks', recordId: 'host-tasks-list', target: '', query: '' };
    const exact = await resolveRunRecord(all, options);
    expect(exact && !('status' in exact) && exact.record.id).toBe('host-tasks-list');
    expect(await resolveRunRecord(all, { ...options, recordId: 'host-tasks', query: 'host-tasks-list' })).toBeNull();
  });

  test('semantic record lookup defers uncertain matches without executable selection', async () => {
    installJudgmentPort(readings({ 'tasks:host-tasks-list': 0.5 }).port);
    expect(await resolveRunRecord(lanes(), { laneId: 'tasks', recordId: '', target: '', query: 'host tasks' }, rankingOptions())).toMatchObject({ status: 'deferred', reason: 'uncertain_record_reading' });
    installJudgmentPort(readings({ 'tasks:workplan-add': 0.95 }).port);
    const result = await resolveRunRecord(lanes(), { laneId: 'tasks', recordId: '', target: '', query: 'host tasks' }, rankingOptions());
    expect(result).toMatchObject({ status: 'selection_required', reason: 'exact_record_identity_required', candidates: [{ recordId: 'workplan-add' }] });
  });

  test('a missing port stays a typed failure through the actual facade', async () => {
    await expect(caller().execute({ action: 'intake', query: 'email calendar' })).rejects.toBeInstanceOf(JudgmentPortMissingError);
  });

  test('an unavailable reader is not replaced by a substring response', async () => {
    installJudgmentPort({ model: 'fixture', ask: async () => { throw new Error('reader unavailable'); } });
    await expect(caller().execute({ action: 'lane', query: 'mail' })).rejects.toThrow('reader unavailable');
  });

  test('already aborted facade options stop before discovery or reading', async () => {
    const controller = new AbortController(); controller.abort(new Error('cancelled'));
    const fake = readings({ 'capture-scratchpad-note': 0.98 }); installJudgmentPort(fake.port);
    await expect(caller().execute({ action: 'intake', query: 'notes' }, { signal: controller.signal })).rejects.toThrow('cancelled');
    expect(fake.requests).toHaveLength(0);
  });

  test('late answers cannot return a plan after cancellation; signal reaches the reader', async () => {
    const controller = new AbortController();
    const fake = readings({ 'capture-scratchpad-note': 0.98 });
    let start!: () => void; const started = new Promise<void>((resolve) => { start = resolve; });
    let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; });
    const signals: (AbortSignal | undefined)[] = [];
    installJudgmentPort({ ...fake.port, ask: async (request) => { signals.push(request.signal); start(); await gate; return fake.port.ask(request); } });
    const pending = caller().execute({ action: 'intake', query: 'notes' }, { signal: controller.signal });
    await started; controller.abort(new Error('cancelled late')); release();
    await expect(pending).rejects.toThrow('cancelled late');
    expect(signals.every((signal) => signal === controller.signal)).toBe(true);
  });

  test('each candidate returns the canonical decision receipt', async () => {
    const log = new SqliteDecisionLog(':memory:');
    try {
      installJudgmentPort(withDecisionLog(readings({ one: 0.9, two: 0.01 }).port, log));
      const result = await rankHarnessCatalog([{ id: 'one', description: 'one' }, { id: 'two', description: 'two' }], 'query', (entry) => entry, 'agent.personal-ops.intake', rankingOptions());
      expect(result.matches).toHaveLength(1);
      for (const judgment of result.judgments) expect(judgment.decisionId).toBeDefined();
    } finally { log[Symbol.dispose](); }
  });
  test('full credential input is refused before local or hosted transmission, including after the display cap', async () => {
    const fixture = researchScreeningFixture();
    const fake = readings({ one: 0.99 }); installJudgmentPort(fake.port);
    for (const [query, description] of [
      ['Authorization: Bearer synthetic-credential', 'ordinary'],
      ['ordinary', 'x'.repeat(700) + ' Authorization: Bearer synthetic-credential'],
    ]) {
      await expect(rankHarnessCatalog([{ id: 'one', description: description! }], query!, (entry) => entry, 'agent.personal-ops.intake', { sourceOwner: fixture.owner })).rejects.toThrow();
    }
    expect(fixture.calls).toHaveLength(0);
    expect(fake.requests).toHaveLength(0);
  });

  test('card-shaped arbitrary and legacy review filenames still refuse before transmission', async () => {
    const fixture = researchScreeningFixture();
    const fake = readings({ one: 0.99 }); installJudgmentPort(fake.port);
    for (const filename of ['notes-4111111111111111.json', 'Inbox-review-cards-1791559463008.json']) {
      await expect(rankHarnessCatalog([{ id: 'one', description: `Saved inbox review: ${filename}` }],
        'review inbox', (entry) => entry, 'agent.personal-ops.queue', { sourceOwner: fixture.owner }))
        .rejects.toMatchObject({ problem: 'card-material' });
    }
    expect(fixture.calls).toHaveLength(0);
    expect(fake.requests).toHaveLength(0);
  });

  test('complete query and candidate identity/description are screened for PII before hosted ranking', async () => {
    const sensitive = 'synthetic-private-contact';
    const fixture = researchScreeningFixture({ spans: exactSensitiveSpans([sensitive]) });
    const fake = fakePort(() => noulAnswer(0.95)); installJudgmentPort(fake.port);
    await rankHarnessCatalog([{ id: sensitive, description: `ordinary ${sensitive} ` + 'x'.repeat(700) + sensitive }], `plan ${sensitive}`, (entry) => entry, 'agent.personal-ops.intake', { sourceOwner: fixture.owner });
    expect(JSON.stringify(fixture.calls)).toContain('x'.repeat(700) + sensitive);
    expect(JSON.stringify(fake.requests)).not.toContain(sensitive);
    expect(JSON.stringify(fake.requests)).toContain('[redacted]');
    expect((fake.requests[0]!.state as unknown as { candidate: { description: string } }).candidate.description.length).toBe(600);
  });

  test('missing local owner and uncertain local screening never contact the catalog reader', async () => {
    const fake = readings({ one: 0.95 }); installJudgmentPort(fake.port);
    const entries = [{ id: 'one', description: 'ordinary' }];
    await expect(rankHarnessCatalog(entries, 'ordinary', (entry) => entry, 'agent.personal-ops.intake')).rejects.toThrow();
    const fixture = researchScreeningFixture({ complete: 0.5 });
    await expect(rankHarnessCatalog(entries, 'ordinary', (entry) => entry, 'agent.personal-ops.intake', { sourceOwner: fixture.owner })).rejects.toThrow();
    expect(fake.requests).toHaveLength(0);
  });

  test('source accessors are not executed or transmitted', async () => {
    const fixture = researchScreeningFixture(); let accessed = 0;
    const entry = { id: 'one', get description() { accessed++; return 'private'; } };
    await expect(rankHarnessCatalog([entry], 'ordinary', (value) => value, 'agent.personal-ops.intake', { sourceOwner: fixture.owner })).rejects.toThrow();
    expect(accessed).toBe(0); expect(fixture.calls).toHaveLength(0);
  });

  test('revoking source authority during an awaited reading suppresses late results', async () => {
    const fixture = researchScreeningFixture(); const fake = readings({ one: 0.95 });
    let started!: () => void; const first = new Promise<void>((resolve) => { started = resolve; });
    let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; });
    installJudgmentPort({ ...fake.port, ask: async (request) => { started(); await gate; return fake.port.ask(request); } });
    const pending = rankHarnessCatalog([{ id: 'one', description: 'ordinary' }], 'ordinary', (entry) => entry, 'agent.personal-ops.intake', { sourceOwner: fixture.owner });
    await first; fixture.lifetime.abort(); release();
    await expect(pending).rejects.toThrow();
  });

  test('cancellation during local screening sends no catalog request', async () => {
    let started!: () => void; const first = new Promise<void>((resolve) => { started = resolve; });
    let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; });
    const fixture = researchScreeningFixture({ beforeProposal: async () => { started(); await gate; } });
    const fake = readings({ one: 0.95 }); installJudgmentPort(fake.port);
    const controller = new AbortController();
    const pending = rankHarnessCatalog([{ id: 'one', description: 'ordinary' }], 'ordinary', (entry) => entry, 'agent.personal-ops.intake', { sourceOwner: fixture.owner, signal: controller.signal });
    await first; controller.abort(); release();
    await expect(pending).rejects.toThrow();
    expect(fake.requests).toHaveLength(0);
  });

  for (const name of ['personal_ops', 'agent_harness'] as const) test(`${name} registered ingress screens before any generic reader`, async () => {
    const sensitive = 'synthetic-private-contact';
    const fixture = researchScreeningFixture({ spans: exactSensitiveSpans([sensitive]) });
    const registry = new ToolRegistry(); bindAgentResearchSourceOwner(registry, fixture.owner);
    if (name === 'personal_ops') registerAgentPersonalOpsTool(registry, {} as CommandRegistry, context);
    else registerAgentHarnessTool(registry, {} as CommandRegistry, context);
    const args = name === 'personal_ops' ? { action: 'intake', query: sensitive } : { mode: 'personal_ops_intake', query: sensitive };
    const fake = readings({ 'capture-scratchpad-note': 0.95 }); installJudgmentPort(fake.port);
    await expect(registry.execute('protected-personal-ops', name, args)).rejects.toThrow();
    expect(fake.requests).toHaveLength(0);
    expect(fixture.calls.length).toBeGreaterThan(0);
    const calls = fixture.calls.length;
    await expect(registry.projectCall('credential-personal-ops', name, { ...args, query: 'x'.repeat(700) + ' Authorization: Bearer synthetic-credential' })).rejects.toThrow();
    expect(fixture.calls).toHaveLength(calls);
    const clear = await registry.projectCall('clear-personal-ops', name, { ...args, query: 'ordinary request' });
    expect(clear.args.query).toBe('ordinary request');
    fixture.lifetime.abort();
    expect(() => registry.assertProjected(clear)).toThrow();
    expect(fake.requests).toHaveLength(0);
    await registry.releaseProjected(clear);
  });

  test('ordinary status and briefing remain available through registered dispatch without a screening owner', async () => {
    const registry = new ToolRegistry(); registerAgentPersonalOpsTool(registry, {} as CommandRegistry, context);
    for (const action of ['status', 'overview', 'briefing', 'daily']) {
      expect((await registry.execute(`ordinary-${action}`, 'personal_ops', { action })).success).toBe(true);
    }
  });

  test('unrelated harness projection preserves the original owner and rejects a repaired protected route', async () => {
    const registry = new ToolRegistry(); const args = { mode: 'other', query: 'ordinary' };
    let delegated: unknown; let repaired = 0;
    const context = Object.freeze({});
    const projector = createPersonalOpsInputProjector(registry, { async project(request) {
      delegated = request;
      return { status: 'projected', args: request.args, executionContext: context, assertRepairedArgs: () => { repaired++; } };
    } });
    const request = { callId: 'delegate', name: 'agent_harness', args, assertCurrent: () => {} };
    const result = await projector.project(request);
    expect(delegated).toBe(request);
    expect(result.status).toBe('projected');
    if (result.status !== 'projected') throw new Error('projection held');
    expect(result.args).toBe(args); expect(result.executionContext).toBe(context);
    result.assertRepairedArgs?.(args); expect(repaired).toBe(1);
    expect(() => result.assertRepairedArgs?.({ mode: 'personal_ops_intake', query: 'private' })).toThrow();
  });

  test('replacing the judgment binding while a reading is pending fences its late result', async () => {
    const fixture = researchScreeningFixture(); const fake = readings({ one: 0.95 });
    let started!: () => void; const first = new Promise<void>((resolve) => { started = resolve; });
    let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; });
    installJudgmentPort({ ...fake.port, ask: async (request) => { started(); await gate; return fake.port.ask(request); } });
    const pending = rankHarnessCatalog([{ id: 'one', description: 'ordinary' }], 'ordinary', (entry) => entry, 'agent.personal-ops.intake', { sourceOwner: fixture.owner });
    await first; installJudgmentPort(readings({ one: 0.99 }).port); release();
    await expect(pending).rejects.toThrow();
  });

  test('exact connector read retains confirmation and forwards the same cancellation signal to MCP', async () => {
    const calls: { name: string; signal?: AbortSignal }[] = [];
    const api = {
      listServerSecurity: () => [{ name: 'gmail', connected: true, trustMode: 'trusted', role: 'read', schemaFreshness: 'fresh', allowedHosts: [] }],
      listAllTools: async () => [{ serverName: 'gmail', toolName: 'search_messages', description: 'Search inbox messages' }],
      getToolSchema: async () => ({ inputSchema: { type: 'object', properties: {}, required: [] } }),
      callTool: async (name: string, _fields: unknown, options?: { signal?: AbortSignal }) => { calls.push({ name, signal: options?.signal }); return { messages: [] }; },
    };
    const runtime = { sessionId: 'original' };
    const source = { ...context, clients: { mcpApi: api }, session: { runtime } } as unknown as CommandContext;
    const controller = new AbortController();
    const args = { laneId: 'inbox', recordId: 'mcp:gmail:search_messages', fields: {}, explicitUserRequest: 'Read my inbox' };
    expect(await runPersonalOpsRead(source, args, { signal: controller.signal })).toMatchObject({ status: 'needs_confirmation' });
    expect(calls).toEqual([]);
    expect(await runPersonalOpsRead(source, { ...args, confirm: true }, { signal: controller.signal })).toMatchObject({ status: 'executed' });
    expect(calls).toEqual([{ name: 'mcp:gmail:search_messages', signal: controller.signal }]);
    api.getToolSchema = async () => { runtime.sessionId = 'changed'; return { inputSchema: { type: 'object', properties: {}, required: [] } }; };
    expect(await runPersonalOpsRead(source, { ...args, confirm: true }, { signal: controller.signal })).toMatchObject({ status: 'deferred', reason: 'personal_ops_source_changed' });
    expect(calls).toHaveLength(1);
  });

  test('PAN-shaped private receipt metadata is captured as data but never sent to either screening or ranking', async () => {
    const receiptId = 'receipt-4242424242424242-uuid';
    const fixture = researchScreeningFixture(); const fake = readings({ one: 0.95 }); installJudgmentPort(fake.port);
    const entry = { id: 'one', description: 'ordinary catalog description', receipt: { id: receiptId } };
    const result = await rankHarnessCatalog([entry], 'ordinary', ({ id, description }) => ({ id, description }), 'agent.personal-ops.intake', { sourceOwner: fixture.owner });
    expect(result.matches[0]?.entry.receipt.id).toBe(receiptId);
    expect(JSON.stringify(fixture.calls)).not.toContain(receiptId);
    expect(JSON.stringify(fake.requests)).not.toContain(receiptId);
    const localCalls = fixture.calls.length, hostedCalls = fake.requests.length;
    for (const transmitted of [{ ...entry, description: receiptId }, { ...entry, id: receiptId }, { ...entry, description: 'x'.repeat(700) + receiptId }]) {
      await expect(rankHarnessCatalog([transmitted], 'ordinary', ({ id, description }) => ({ id, description }), 'agent.personal-ops.intake', { sourceOwner: fixture.owner })).rejects.toThrow();
    }
    expect(fixture.calls).toHaveLength(localCalls); expect(fake.requests).toHaveLength(hostedCalls);
  });

  test('private DTO capture refuses proxies, serialization hooks and cycles without invoking them', async () => {
    let invoked = 0;
    const cycle: Record<string, unknown> = {}; cycle.self = cycle;
    for (const metadata of [new Proxy({}, { ownKeys() { invoked++; return []; } }), { toJSON() { invoked++; return {}; } }, cycle]) {
      await expect(rankHarnessCatalog([{ id: 'one', description: 'ordinary', metadata }], 'ordinary', ({ id, description }) => ({ id, description }), 'agent.personal-ops.intake', rankingOptions())).rejects.toThrow();
    }
    expect(invoked).toBe(0);
  });

});
