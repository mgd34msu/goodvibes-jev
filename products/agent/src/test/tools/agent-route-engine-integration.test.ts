import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { installJudgmentPort, JudgmentPortMissingError } from '@goodvibes-jev/engine/errors';
import { ChannelPluginRegistry } from '@goodvibes-jev/engine/sdk/platform/channels';
import { ToolRegistry, ToolInputProjectionError } from '@goodvibes-jev/engine/sdk/platform/tools';
import type { Tool } from '@goodvibes-jev/engine/sdk/platform/types';
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
import { AGENT_WORKSPACE_CATEGORIES } from '../../input/agent-workspace-categories.ts';
import { bindAgentResearchSourceOwner } from '../../agent/protected-research-report.ts';
import { ordinaryResearchOwner, cleanupResearchScreeningFixtures, researchScreeningFixture } from '../helpers/research-screening.ts';

afterAll(cleanupResearchScreeningFixtures);

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
function caller(kind: 'route' | 'harness', channels = new ChannelPluginRegistry(), commandContext = context, sourceOwner = ordinaryResearchOwner()) {
  const registry = new ToolRegistry(); bindAgentResearchSourceOwner(registry, sourceOwner);
  const ownedContext: CommandContext = { ...commandContext, extensions: { ...commandContext.extensions, toolRegistry: registry } };
  return kind === 'route'
    ? createAgentRouteTool(ownedContext, { channelRegistry: channels }, registry)
    : createAgentHarnessTool({ commandContext: ownedContext, commandRegistry: {} as CommandRegistry, toolRegistry: registry, taskRouteSources: { channelRegistry: channels } });
}
const args = { action: 'plan', mode: 'route_decision', query: 'change the theme setting', includeParameters: true, limit: 1 };

function observeInvocation(pending: ReturnType<Tool['execute']>) {
  return pending.then(result => ({ status: 'resolved' as const, result }),
    (error: unknown) => ({ status: 'rejected' as const, error }));
}

/** Start follows actual native acquisition; an earlier refusal is still a failure. */
async function waitForReadingStart(began: Promise<void>, pending: ReturnType<Tool['execute']>): Promise<void> {
  const first = await Promise.race([began.then(() => ({ status: 'started' as const })), observeInvocation(pending)]);
  if (first.status === 'rejected') throw first.error;
  if (first.status !== 'started') throw new Error('Native reading completed without reaching the deferred reader');
}

for (const kind of ['route', 'harness'] as const) describe(`${kind} engine task-route consumer`, () => {
  test('uses engine readings rather than request keywords, preserving plan schema and real catalog IDs', async () => {
    const fake = fixture();
    installJudgmentPort(fake.port);
    const result = await caller(kind).execute({ ...args });
    expect(result.success).toBe(true);
    if (!result.success) throw new Error(result.error);
    const body = JSON.parse(result.output!);
    expect(body).toMatchObject({ status: 'ready', request: args.query, routesConsidered: 1, alternatives: [], preferred: { id: 'host-runtime-diagnostics', confidence: 'high', score: 0.94, requiresConfirmation: false, modelRoute: 'host action:"status" includeParameters:true' } });
    expect(body.nextAction).toContain('read-only');
    const workspaceIds = new Set((await listWorkspaceActions(context, { limit: 1000 })).map(record => record.id));
    const modeIds = new Set(((await listHarnessModes({ limit: 1000 })).modes as { id: string }[]).map(record => record.id));
    expect(body.workspaceMatches.length).toBe(6);
    expect(body.workspaceMatches.every((record: { id: string }) => workspaceIds.has(record.id))).toBe(true);
    expect(body.harnessModeMatches.every((record: { id: string }) => modeIds.has(record.id))).toBe(true);
    expect(fake.requests.some(request => Object.keys(request.questions).length === TASK_ROUTES.length + 1)).toBe(true);
    expect(fake.requests.some(request => request.context?.site === 'agent.task-route.catalog')).toBe(true);
    const native = AGENT_WORKSPACE_CATEGORIES.flatMap(category => category.actions.map(action => ({ category, action })))
      .find(({ action }) => action.id === 'personal-ops-google-connect');
    expect(native).toBeDefined();
    const read = fake.requests.find(request => request.context?.site === 'agent.task-route.catalog'
      && request.state && typeof request.state === 'object' && !Array.isArray(request.state)
      && request.state.candidate && typeof request.state.candidate === 'object' && !Array.isArray(request.state.candidate)
      && request.state.candidate.name === native?.action.id);
    expect(read).toBeDefined();
    if (!read?.state || typeof read.state !== 'object' || Array.isArray(read.state)
      || !read.state.candidate || typeof read.state.candidate !== 'object' || Array.isArray(read.state.candidate)
      || typeof read.state.candidate.evidenceJson !== 'string') throw new Error('Missing complete workspace candidate');
    const evidence = JSON.parse(read.state.candidate.evidenceJson);
    expect(evidence.action).toEqual(native!.action);
    expect(evidence.category.detail).toBe(native!.category.detail);
    expect(evidence.action.detail.length).toBeGreaterThan(56);
  });

  test.each([0.5, 0.57])('catalog reading %s stays typed and never publishes a ready route', async probability => {
    using log = new SqliteDecisionLog(':memory:');
    const fake = taskRoutePort({ [args.query]: {
      pick: 'host-runtime-diagnostics', catalogFits: { 'document-run-compare': probability, document_ops: probability },
    } });
    installJudgmentPort(withDecisionLog(fake.port, log));
    const result = await caller(kind).execute({ ...args });
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
    const result = await caller(kind).execute({ ...args });
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
    const result = await caller(kind).execute({ ...args });
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
    const result = await caller(kind).execute({ ...args });
    expect(result.success).toBe(true);
    if (!result.success) throw new Error(result.error);
    const body = JSON.parse(result.output!);
    expect(body.workspaceMatches.map((record: { id: string }) => record.id)).toEqual(['document-run-compare']);
    expect(body.harnessModeMatches.map((record: { id: string }) => record.id)).toEqual(['document_ops', 'route_decision']);
  });

  test('waits for asynchronous readings, and passes the caller cancellation signal', async () => {
    const fake = fixture();
    let started!: () => void;
    const began = new Promise<void>(resolve => { started = resolve; });
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const controller = new AbortController();
    const seen: (AbortSignal | undefined)[] = [];
    const deferredRequests: Promise<unknown>[] = [];
    installJudgmentPort({ ...fake.port, ask: request => {
      const work = (async () => { seen.push(request.signal); started(); await gate; return fake.port.ask(request); })();
      deferredRequests.push(work); return work;
    } });
    let settled = false;
    const pending = caller(kind).execute({ ...args }, { signal: controller.signal });
    const outcome = observeInvocation(pending).then(result => { settled = true; return result; });
    try {
      await waitForReadingStart(began, pending);
      await Bun.sleep(10);
      expect(seen.length).toBeGreaterThan(0);
      expect(settled).toBe(false);
      expect(seen.every(signal => signal !== undefined && !signal.aborted)).toBe(true);
      release();
      const result = await pending;
      expect(result.success).toBe(true);
      if (result.success) expect(JSON.parse(result.output!).preferred.id).toBe('host-runtime-diagnostics');
      const reason = new Error('Original route caller canceled');
      controller.abort(reason);
      expect(seen.every(signal => signal?.aborted && signal.reason === reason)).toBe(true);
    } finally {
      release();
      controller.abort();
      await outcome;
      await Promise.allSettled(deferredRequests);
    }
  });

  test('reports missing and failed readings without returning a keyword plan', async () => {
    const tool = caller(kind);
    if (kind === 'route') await expect(tool.execute({ ...args })).rejects.toThrow(JudgmentPortMissingError);
    else expect(await tool.execute({ ...args })).toMatchObject({ success: false });
    installJudgmentPort({ model: 'fixture', ask: async () => { throw new Error('fixture reading unavailable'); } });
    if (kind === 'route') await expect(tool.execute({ ...args })).rejects.toThrow('fixture reading unavailable');
    else expect(await tool.execute({ ...args })).toMatchObject({ success: false, error: expect.stringContaining('fixture reading unavailable') });
  });

  test('catalog ranking failure is not swallowed as empty matches', async () => {
    const fake = fixture();
    installJudgmentPort({ ...fake.port, ask: async request => {
      if (request.context?.site === 'agent.task-route.catalog') throw new Error('fixture catalog unavailable');
      return fake.port.ask(request);
    } });
    if (kind === 'route') await expect(caller(kind).execute({ ...args })).rejects.toThrow('fixture catalog unavailable');
    else expect(await caller(kind).execute({ ...args })).toMatchObject({ success: false, error: expect.stringContaining('fixture catalog unavailable') });
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
    if (kind === 'route') await expect(tool.execute({ ...args })).rejects.toThrow();
    else expect(await tool.execute({ ...args })).toMatchObject({ success: false });
  });

  test('a registry change during pending readings cannot publish a stale target', async () => {
    const channels = new ChannelPluginRegistry();
    channels.register({ id: 'fixture-teams-adapter', surface: 'msteams', displayName: 'Microsoft Teams', capabilities: [] });
    const fake = fixture('channels', 'msteams');
    let started!: () => void;
    const began = new Promise<void>(resolve => { started = resolve; });
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const deferredRequests: Promise<unknown>[] = [];
    installJudgmentPort({ ...fake.port, ask: request => {
      const work = (async () => { started(); await gate; return fake.port.ask(request); })();
      deferredRequests.push(work); return work;
    } });
    const pending = caller(kind, channels).execute({ ...args });
    const outcome = observeInvocation(pending);
    try {
      await waitForReadingStart(began, pending);
      channels.unregister('fixture-teams-adapter');
      release();
      await expect(pending).rejects.toBeInstanceOf(ToolInputProjectionError);
    } finally {
      release();
      await outcome;
      await Promise.allSettled(deferredRequests);
    }
  });

  test('original channel retirement during complete catalog screening prevents verification and rank dispatch', async () => {
    const channels = new ChannelPluginRegistry();
    channels.register({ id: 'fixture-teams-adapter', surface: 'msteams', displayName: 'Microsoft Teams', capabilities: [] });
    const fake = fixture(); installJudgmentPort(fake.port);
    let started!: () => void;
    const began = new Promise<void>(resolve => { started = resolve; });
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const capturedBatches: Array<readonly string[]> = [];
    const native = AGENT_WORKSPACE_CATEGORIES.flatMap(category => category.actions.map(action => ({ category, action })));
    const screening = researchScreeningFixture({ async beforeProposal(source) {
      // This is the real ranker's exact query/complete-candidate framing, not
      // the preceding invocation or named-target screening source.
      if (source.parts[0] !== args.query || source.parts.length < 2) return;
      let workspaceSource = false;
      for (const part of source.parts.slice(1)) {
        const candidate: unknown = JSON.parse(part);
        if (!Array.isArray(candidate) || candidate.length !== 3 || typeof candidate[0] !== 'string'
          || typeof candidate[1] !== 'string') throw new Error('Original complete catalog candidate is missing');
        if (native.some(({ action }) => action.id === candidate[0])) workspaceSource = true;
      }
      capturedBatches.push([...source.parts]); if (workspaceSource) started(); await gate;
    } });
    const pending = caller(kind, channels, context, screening.owner).execute({ ...args });
    const outcome = observeInvocation(pending);
    try {
      await waitForReadingStart(began, pending);
      expect(capturedBatches.length).toBeGreaterThan(0);
      let completeNativeAction = false;
      for (const part of capturedBatches.flatMap(parts => parts.slice(1))) {
        const candidate: unknown = JSON.parse(part);
        if (!Array.isArray(candidate)) throw new Error('Captured native catalog frame is missing');
        const original = native.find(({ action }) => action.id === candidate[0]);
        if (original) {
          expect(candidate[2]).toEqual({ action: original.action, category: {
            id: original.category.id, label: original.category.label, group: original.category.group,
            summary: original.category.summary, detail: original.category.detail,
          } });
          completeNativeAction = true;
        }
      }
      expect(completeNativeAction).toBe(true);
      channels.unregister('fixture-teams-adapter');
      release();
      await expect(pending).rejects.toBeInstanceOf(ToolInputProjectionError);
      const originalCatalogSources = new Set(capturedBatches.map(parts => JSON.stringify(parts)));
      const verification = screening.calls.filter(call => call.path === '/v1/systemone');
      expect(verification.some(call => {
        const state = call.body.state;
        if (!state || typeof state !== 'object' || Array.isArray(state) || !('parts' in state)) return false;
        return originalCatalogSources.has(JSON.stringify(state.parts));
      })).toBe(false);
      expect(fake.requests.some(request => request.context?.site === 'agent.task-route.catalog')).toBe(false);
    } finally {
      release();
      await outcome;
      await screening.owner.close();
    }
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
    let started!: () => void;
    const began = new Promise<void>(resolve => { started = resolve; });
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const deferredRequests: Promise<unknown>[] = [];
    installJudgmentPort({ ...fake.port, ask: request => {
      const work = (async () => { started(); await gate; return fake.port.ask(request); })();
      deferredRequests.push(work); return work;
    } });
    const controller = new AbortController();
    const pending = caller(kind).execute({ ...args }, { signal: controller.signal });
    const outcome = observeInvocation(pending);
    try {
      await waitForReadingStart(began, pending);
      await Bun.sleep(10); controller.abort(); release();
      await expect(pending).rejects.toBe(controller.signal.reason);
    } finally {
      release();
      controller.abort();
      await outcome;
      await Promise.allSettled(deferredRequests);
    }
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
    const pending = caller(kind, undefined, commandContext).execute({ ...args }, { signal: controller.signal })
      .then(value => { settled = true; return value; }, error => { settled = true; return error; });
    let sourceReleased = false;
    const releaseSource = () => {
      if (sourceReleased) return;
      sourceReleased = true;
      if (late === 'resolve') release([{ providerId: 'late-provider', status: 'available' }]);
      else fail(new Error('late snapshot failure is observed'));
    };
    try {
      await Promise.race([began, pending.then(result => { throw new Error('Native source settled before its deferred acquisition', { cause: result }); })]); controller.abort();
      // The regression must finish before releasing the non-cancellable source.
      for (let tick = 0; tick < 20 && !settled; tick++) await Promise.resolve();
      expect(settled).toBe(true);
      const result = await pending;
      expect(result).toBe(controller.signal.reason);
      expect(laterReads).toBe(0);
      expect(fake.requests).toHaveLength(0);
      releaseSource();
      await snapshot.catch(() => undefined);
      for (let tick = 0; tick < 20; tick++) await Promise.resolve();
      expect(laterReads).toBe(0);
      expect(fake.requests).toHaveLength(0);
    } finally {
      controller.abort();
      releaseSource();
      await snapshot.catch(() => undefined);
      await pending;
    }
  });

  test('pre-aborted catalog access starts no source read', async () => {
    let reads = 0;
    const commandContext = { ...context, platform: { ...context.platform, readModels: {
      externalMemoryProviders: () => { reads++; return []; },
    } } } as unknown as CommandContext;
    const controller = new AbortController(); controller.abort();
    const pending = caller(kind, undefined, commandContext).execute({ ...args }, { signal: controller.signal });
    await expect(pending).rejects.toBe(controller.signal.reason);
    expect(reads).toBe(0);
  });

  test('an already-aborted plan starts no readings or effects', async () => {
    const fake = fixture();
    installJudgmentPort(fake.port);
    const controller = new AbortController(); controller.abort();
    await expect(caller(kind).execute({ ...args }, { signal: controller.signal })).rejects.toBe(controller.signal.reason);
    expect(fake.requests).toHaveLength(0);
  });
});
