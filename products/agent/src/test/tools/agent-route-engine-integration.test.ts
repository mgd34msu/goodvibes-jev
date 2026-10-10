import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { installJudgmentPort, JudgmentPortMissingError } from '@goodvibes-jev/engine/errors';
import { ChannelPluginRegistry } from '@goodvibes-jev/engine/sdk/platform/channels';
import { ToolRegistry } from '@goodvibes-jev/engine/sdk/platform/tools';
import { TASK_ROUTES } from '@goodvibes-jev/engine/sdk/platform/routing';
import { actionOf, readingsOf, SqliteDecisionLog, withDecisionLog } from '@goodvibes-jev/judgment';
import { fakePort, choiceAnswer, noulAnswer } from '@goodvibes-jev/judgment/testing';
import type { CommandContext, CommandRegistry } from '../../input/command-registry.ts';
import { createAgentRouteTool } from '../../tools/agent-route-tool.ts';
import { createAgentHarnessTool } from '../../tools/agent-harness-tool.ts';
import { taskRoutePort } from '../helpers/task-route-readings.ts';
import { createTestProviderRegistry } from '../helpers/test-managers.ts';
import { listWorkspaceActions } from '../../tools/agent-harness-workspace-actions.ts';
import { listHarnessModes } from '../../tools/agent-harness-mode-catalog.ts';

const context = { extensions: {}, ops: {}, workspace: {}, platform: { config: {} }, session: { runtime: {} } } as CommandContext;
let previous: ReturnType<typeof installJudgmentPort>;
beforeEach(() => { previous = installJudgmentPort(undefined); });
afterEach(() => { installJudgmentPort(previous); });

function fixture(pick = 'host-runtime-diagnostics', named = 'none', namedKind = 'messaging channel or notification target') {
  return fakePort((name, question, rawState) => {
    const state = rawState as unknown as { context?: { kind?: string }; candidates?: { id: string }[]; candidate?: { id: string } };
    if (state.candidate) return noulAnswer(0.95);
    if (state.candidates) {
      const chosen = state.context?.kind ? (state.context.kind === namedKind ? named : 'none') : pick;
      if (name === 'pick') return choiceAnswer(question, chosen, 0.9);
      return noulAnswer(state.candidates[Number(name.slice(5))]?.id === chosen ? 0.94 : 0.01);
    }
    if (question.type === 'choice') return choiceAnswer(question, ({ lane: 'none', channelTask: 'send', policyTarget: 'none' } as Record<string, string>)[name]!);
    return noulAnswer(0.01);
  });
}
function caller(kind: 'route' | 'harness', channels = new ChannelPluginRegistry(), commandContext = context) {
  return kind === 'route'
    ? createAgentRouteTool(commandContext, { channelRegistry: channels })
    : createAgentHarnessTool({ commandContext, commandRegistry: {} as CommandRegistry, toolRegistry: new ToolRegistry(), taskRouteSources: { channelRegistry: channels } });
}
const args = { action: 'plan', mode: 'route_decision', query: 'change the theme setting', includeParameters: true, limit: 1 };

for (const kind of ['route', 'harness'] as const) describe(`${kind} engine task-route consumer`, () => {
  test('uses engine readings rather than request keywords, preserving plan schema and real catalog IDs', async () => {
    const fake = fixture();
    installJudgmentPort(fake.port);
    const result = await caller(kind).execute(args);
    expect(result.success).toBe(true);
    if (!result.success) throw new Error(result.error);
    const body = JSON.parse(result.output!);
    expect(body).toMatchObject({ status: 'ready', request: args.query, routesConsidered: 1, alternatives: [], preferred: { id: 'host-runtime-diagnostics', confidence: 'high', score: 0.94, requiresConfirmation: false, modelRoute: 'host action:"status" includeParameters:true' } });
    expect(body.nextAction).toContain('read-only');
    const workspaceIds = new Set(listWorkspaceActions(context, { limit: 1000 }).map(record => record.id));
    const modeIds = new Set(((await listHarnessModes({ limit: 1000 })).modes as { id: string }[]).map(record => record.id));
    expect(body.workspaceMatches.length).toBe(6);
    expect(body.workspaceMatches.every((record: { id: string }) => workspaceIds.has(record.id))).toBe(true);
    expect(body.harnessModeMatches.every((record: { id: string }) => modeIds.has(record.id))).toBe(true);
    expect(fake.requests.some(request => Object.keys(request.questions).length === TASK_ROUTES.length + 1)).toBe(true);
    expect(fake.requests.some(request => request.context?.site === 'agent.task-route.catalog')).toBe(true);
  });

  test.each([0.5, 0.57])('catalog reading %s stays typed and never publishes a ready route', async probability => {
    using log = new SqliteDecisionLog(':memory:');
    const fake = taskRoutePort({ [args.query]: {
      pick: 'host-runtime-diagnostics', catalogFits: { 'document-run-compare': probability, document_ops: probability },
    } });
    installJudgmentPort(withDecisionLog(fake.port, log));
    const result = await caller(kind).execute(args);
    expect(result.success).toBe(true);
    if (!result.success) throw new Error(result.error);
    const body = JSON.parse(result.output!);
    expect(body.status).toBe('uncertain');
    expect(body.preferred).toBeUndefined();
    expect(body.workspaceMatches).toBeUndefined();
    expect(body.harnessModeMatches).toBeUndefined();
    const ranked = body.judgment.workspace.find((entry: { id: string }) => entry.id === 'document-run-compare');
    expect(ranked.probability).toBe(probability);
    expect(ranked.reading.outcome).not.toBe('act');
    const entry = log.get(ranked.decisionId)!;
    expect(entry.status).toBe('answered');
    expect(readingsOf(entry)).toMatchObject({ candidate: ranked.id, match: ranked.reading });
    expect(actionOf(log.get(body.judgment.selection.decisionId)!)).toBe('uncertain: no route published');
    expect(body.nextAction).not.toMatch(/human|approval|confirm|escalat/i);
  });

  test('uncertain effect slots cannot become an authorized or ordinary route', async () => {
    using log = new SqliteDecisionLog(':memory:');
    const fake = taskRoutePort({ [args.query]: { pick: 'host-runtime-diagnostics', slots: { changes: 0.5 } } });
    installJudgmentPort(withDecisionLog(fake.port, log));
    const result = await caller(kind).execute(args);
    if (!result.success) throw new Error(result.error);
    const body = JSON.parse(result.output!);
    expect(body.status).toBe('uncertain');
    expect(body.preferred).toBeUndefined();
    expect(body.judgment.slots.readings.changes).toMatchObject({ verdict: 'uncertain', probability: 0.5 });
    expect(actionOf(log.get(body.judgment.slots.decisionId)!)).toBe('uncertain: no route published');
  });

  test('an uncertain selector cannot disguise itself as main conversation', async () => {
    const fake = fakePort((name, question, state) => {
      if (question.type === 'choice') return choiceAnswer(question, Object.keys(question.criteria)[0]!, 0.5);
      return noulAnswer(0.5);
    });
    installJudgmentPort(fake.port);
    const result = await caller(kind).execute(args);
    if (!result.success) throw new Error(result.error);
    const body = JSON.parse(result.output!);
    expect(body.status).toBe('uncertain');
    expect(body.preferred).toBeUndefined();
    expect(body.judgment.selection.outcome).not.toBe('act');
  });

  test('catalog matches follow reading probabilities rather than local substring or registry order', async () => {
    installJudgmentPort(taskRoutePort({ [args.query]: {
      pick: 'host-runtime-diagnostics',
      catalogFits: { 'document-run-compare': 0.92, document_ops: 0.91, route_decision: 0.83 },
    } }).port);
    const result = await caller(kind).execute(args);
    expect(result.success).toBe(true);
    if (!result.success) throw new Error(result.error);
    const body = JSON.parse(result.output!);
    expect(body.workspaceMatches.map((record: { id: string }) => record.id)).toEqual(['document-run-compare']);
    expect(body.harnessModeMatches.map((record: { id: string }) => record.id)).toEqual(['document_ops', 'route_decision']);
  });

  test('waits for asynchronous readings, and passes the caller cancellation signal', async () => {
    const fake = fixture();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const controller = new AbortController();
    const seen: (AbortSignal | undefined)[] = [];
    installJudgmentPort({ ...fake.port, ask: async request => { seen.push(request.signal); await gate; return fake.port.ask(request); } });
    let settled = false;
    const pending = caller(kind).execute(args, { signal: controller.signal }).then(result => { settled = true; return result; });
    await Bun.sleep(10);
    expect(seen.length).toBeGreaterThan(0);
    expect(settled).toBe(false);
    expect(seen.every(signal => signal === controller.signal)).toBe(true);
    release();
    const result = await pending;
    expect(result.success).toBe(true);
    if (result.success) expect(JSON.parse(result.output!).preferred.id).toBe('host-runtime-diagnostics');
  });

  test('reports missing and failed readings without returning a keyword plan', async () => {
    const tool = caller(kind);
    if (kind === 'route') await expect(tool.execute(args)).rejects.toThrow(JudgmentPortMissingError);
    else expect(await tool.execute(args)).toMatchObject({ success: false });
    installJudgmentPort({ model: 'fixture', ask: async () => { throw new Error('fixture reading unavailable'); } });
    if (kind === 'route') await expect(tool.execute(args)).rejects.toThrow('fixture reading unavailable');
    else expect(await tool.execute(args)).toMatchObject({ success: false, error: expect.stringContaining('fixture reading unavailable') });
  });

  test('catalog ranking failure is not swallowed as empty matches', async () => {
    const fake = fixture();
    installJudgmentPort({ ...fake.port, ask: async request => {
      if (request.context?.site === 'agent.task-route.catalog') throw new Error('fixture catalog unavailable');
      return fake.port.ask(request);
    } });
    if (kind === 'route') await expect(caller(kind).execute(args)).rejects.toThrow('fixture catalog unavailable');
    else expect(await caller(kind).execute(args)).toMatchObject({ success: false, error: expect.stringContaining('fixture catalog unavailable') });
  });

  test('uses live channel registry IDs and rejects a reader inventing an absent named ID', async () => {
    const channels = new ChannelPluginRegistry();
    channels.register({ id: 'fixture-teams-adapter', surface: 'msteams', displayName: 'Microsoft Teams', capabilities: [] });
    const fake = fixture('channels', 'msteams');
    installJudgmentPort(fake.port);
    const tool = caller(kind, channels);
    const result = await tool.execute({ ...args, query: 'send message to Telegram' });
    expect(result.success).toBe(true);
    if (!result.success) throw new Error(result.error);
    expect(JSON.parse(result.output!).preferred).toMatchObject({ id: 'channel-delivery-boundary', modelRoute: 'channels action:"channel" target:"msteams" includeParameters:true', requiresConfirmation: true });
    channels.unregister('fixture-teams-adapter');
    channels.register({ id: 'fixture-slack-adapter', surface: 'slack', displayName: 'Slack', capabilities: [] });
    // The same tool closure must read the changed registry on the next call.
    if (kind === 'route') await expect(tool.execute(args)).rejects.toThrow();
    else expect(await tool.execute(args)).toMatchObject({ success: false });
  });

  test('a registry change during pending readings cannot publish a stale target', async () => {
    const channels = new ChannelPluginRegistry();
    channels.register({ id: 'fixture-teams-adapter', surface: 'msteams', displayName: 'Microsoft Teams', capabilities: [] });
    const fake = fixture('channels', 'msteams');
    let started!: () => void;
    const began = new Promise<void>(resolve => { started = resolve; });
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    installJudgmentPort({ ...fake.port, ask: async request => { started(); await gate; return fake.port.ask(request); } });
    const pending = caller(kind, channels).execute(args);
    await began;
    channels.unregister('fixture-teams-adapter');
    release();
    if (kind === 'route') await expect(pending).rejects.toThrow('context changed');
    else expect(await pending).toMatchObject({ success: false, error: expect.stringContaining('context changed') });
  });

  test('reads provider IDs from the real ProviderRegistry, not its query text', async () => {
    const providerRegistry = createTestProviderRegistry();
    const fake = fixture('model-provider-account-posture', 'openrouter', 'model provider');
    installJudgmentPort(fake.port);
    const result = await caller(kind, undefined, { ...context, provider: { providerRegistry } }).execute({ ...args, query: 'check Anthropic access' });
    expect(result.success).toBe(true);
    if (!result.success) throw new Error(result.error);
    expect(JSON.parse(result.output!).preferred.modelRoute).toBe('models action:"provider" providerId:"openrouter" includeParameters:true');
    const providerRead = fake.requests.find(request => (request.state as { context?: { kind?: string } }).context?.kind === 'model provider');
    expect(providerRead).toBeDefined();
    const ids = (providerRead!.state as { candidates: { id: string }[] }).candidates.map(candidate => candidate.id);
    const actual = [...new Set([...providerRegistry.listProviders().map(provider => provider.name), ...providerRegistry.getConfiguredProviderIds()])].sort();
    expect(ids).toEqual(actual);
  });

  test('cancellation while a reading is pending never publishes a completed plan', async () => {
    const fake = fixture();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    installJudgmentPort({ ...fake.port, ask: async request => { await gate; return fake.port.ask(request); } });
    const controller = new AbortController();
    const pending = caller(kind).execute(args, { signal: controller.signal });
    await Bun.sleep(10); controller.abort(); release();
    if (kind === 'route') await expect(pending).rejects.toThrow();
    else expect(await pending).toMatchObject({ success: false });
  });

  test.each(['resolve', 'reject'] as const)('abort stops waiting for a live catalog; late %s is discarded and no later source starts', async (late) => {
    const fake = fixture(); installJudgmentPort(fake.port);
    let started!: () => void;
    const began = new Promise<void>(resolve => { started = resolve; });
    let release!: (value: unknown) => void;
    let fail!: (error: Error) => void;
    const snapshot = new Promise<unknown>((resolve, reject) => { release = resolve; fail = reject; });
    let laterReads = 0;
    const commandContext = {
      ...context,
      platform: { ...context.platform, readModels: {
        externalMemoryProviders: () => { started(); return snapshot; },
        memoryProviders: () => { laterReads++; return []; },
      } },
    } as unknown as CommandContext;
    const controller = new AbortController();
    let settled = false;
    const pending = caller(kind, undefined, commandContext).execute(args, { signal: controller.signal })
      .then(value => { settled = true; return value; }, error => { settled = true; return error; });
    await began; controller.abort();
    // The regression must finish before releasing the non-cancellable source.
    for (let tick = 0; tick < 20 && !settled; tick++) await Promise.resolve();
    expect(settled).toBe(true);
    const result = await pending;
    if (kind === 'route') expect(result).toBeInstanceOf(Error);
    else expect(result).toMatchObject({ success: false });
    expect(laterReads).toBe(0);
    expect(fake.requests).toHaveLength(0);
    if (late === 'resolve') release([{ providerId: 'late-provider', status: 'available' }]);
    else fail(new Error('late snapshot failure is observed'));
    await snapshot.catch(() => undefined);
    for (let tick = 0; tick < 20; tick++) await Promise.resolve();
    expect(laterReads).toBe(0);
    expect(fake.requests).toHaveLength(0);
  });

  test('pre-aborted catalog access starts no source read', async () => {
    let reads = 0;
    const commandContext = { ...context, platform: { ...context.platform, readModels: {
      externalMemoryProviders: () => { reads++; return []; },
    } } } as unknown as CommandContext;
    const controller = new AbortController(); controller.abort();
    const pending = caller(kind, undefined, commandContext).execute(args, { signal: controller.signal });
    if (kind === 'route') await expect(pending).rejects.toThrow();
    else expect(await pending).toMatchObject({ success: false });
    expect(reads).toBe(0);
  });

  test('an already-aborted plan starts no readings or effects', async () => {
    const fake = fixture();
    installJudgmentPort(fake.port);
    const controller = new AbortController(); controller.abort();
    if (kind === 'route') await expect(caller(kind).execute(args, { signal: controller.signal })).rejects.toThrow();
    else expect(await caller(kind).execute(args, { signal: controller.signal })).toMatchObject({ success: false });
    expect(fake.requests).toHaveLength(0);
  });
});
