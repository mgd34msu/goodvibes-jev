import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { installJudgmentPort, JudgmentPortMissingError } from '@goodvibes-jev/engine/errors';
import { ChannelPluginRegistry } from '@goodvibes-jev/engine/sdk/platform/channels';
import { ToolRegistry } from '@goodvibes-jev/engine/sdk/platform/tools';
import { TASK_ROUTES } from '@goodvibes-jev/engine/sdk/platform/routing';
import { fakePort, choiceAnswer, noulAnswer } from '@goodvibes-jev/judgment/testing';
import type { CommandContext, CommandRegistry } from '../../input/command-registry.ts';
import { createAgentRouteTool } from '../../tools/agent-route-tool.ts';
import { createAgentHarnessTool } from '../../tools/agent-harness-tool.ts';
import { listWorkspaceActions } from '../../tools/agent-harness-workspace-actions.ts';
import { listHarnessModes } from '../../tools/agent-harness-mode-catalog.ts';

const context = { extensions: {}, ops: {}, workspace: {}, platform: { config: {} }, session: { runtime: {} } } as CommandContext;
let previous: ReturnType<typeof installJudgmentPort>;
beforeEach(() => { previous = installJudgmentPort(undefined); });
afterEach(() => { installJudgmentPort(previous); });

function fixture(pick = 'host-runtime-diagnostics', named = 'none') {
  return fakePort((name, question, rawState) => {
    const state = rawState as unknown as { context?: { kind?: string }; candidates?: { id: string }[]; candidate?: { id: string } };
    if (state.candidate) return noulAnswer(0.95);
    if (state.candidates) {
      const chosen = state.context?.kind ? (state.context.kind === 'messaging channel or notification target' ? named : 'none') : pick;
      if (name === 'pick') return choiceAnswer(question, chosen, 0.9);
      return noulAnswer(state.candidates[Number(name.slice(5))]?.id === chosen ? 0.94 : 0.01);
    }
    if (question.type === 'choice') return choiceAnswer(question, ({ lane: 'none', channelTask: 'send', policyTarget: 'none' } as Record<string, string>)[name]!);
    return noulAnswer(0.01);
  });
}
function caller(kind: 'route' | 'harness', channels = new ChannelPluginRegistry()) {
  return kind === 'route'
    ? createAgentRouteTool(context, { channelRegistry: channels })
    : createAgentHarnessTool({ commandContext: context, commandRegistry: {} as CommandRegistry, toolRegistry: new ToolRegistry(), taskRouteSources: { channelRegistry: channels } });
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
    const modeIds = new Set((listHarnessModes({ limit: 1000 }).modes as { id: string }[]).map(record => record.id));
    expect(body.workspaceMatches.length).toBe(6);
    expect(body.workspaceMatches.every((record: { id: string }) => workspaceIds.has(record.id))).toBe(true);
    expect(body.harnessModeMatches.every((record: { id: string }) => modeIds.has(record.id))).toBe(true);
    expect(fake.requests.some(request => Object.keys(request.questions).length === TASK_ROUTES.length + 1)).toBe(true);
    expect(fake.requests.some(request => request.context?.site === 'agent.task-route.catalog')).toBe(true);
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

  test('an already-aborted plan starts no readings or effects', async () => {
    const fake = fixture();
    installJudgmentPort(fake.port);
    const controller = new AbortController(); controller.abort();
    if (kind === 'route') await expect(caller(kind).execute(args, { signal: controller.signal })).rejects.toThrow();
    else expect(await caller(kind).execute(args, { signal: controller.signal })).toMatchObject({ success: false });
    expect(fake.requests).toHaveLength(0);
  });
});
