import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { ConfigManager } from '../../config/index.ts';
import { GOODVIBES_AGENT_SURFACE_ROOT } from '../../config/surface.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';
import { createAgentHarnessTool } from '../../tools/agent-harness-tool.ts';
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { ConversationManager } from '../../core/conversation.ts';
import { sessionSummary } from '../../tools/agent-harness-session-metadata.ts';
import type { CommandContext } from '../../input/command-registry.ts';
const configRoots: string[] = [];
function fixturePlatform() {
  const root = makeProjectTempDir('harness-config-owner');
  configRoots.push(root);
  const configManager = new ConfigManager({
    surfaceRoot: GOODVIBES_AGENT_SURFACE_ROOT,
    configDir: join(root, '.goodvibes', GOODVIBES_AGENT_SURFACE_ROOT),
    workingDir: root,
    homeDir: root,
  });
  return { config: configManager.getAll(), configManager };
}
let previous: ReturnType<typeof installJudgmentPort>;
beforeEach(() => { previous = installJudgmentPort(fakePort(() => noulAnswer(0.5)).port); });
afterEach(() => {
  installJudgmentPort(previous);
  for (const root of configRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});
test('unsettled transcript count does not make unrelated saved-session metadata unavailable', async () => {
  const conversation = new ConversationManager(() => 100); conversation.addSystemMessage('[Approval] Waiting for a decision');
  const ctx = { session: { conversationManager: conversation, runtime: { sessionId: 'session', model: 'fixture', provider: 'fixture' }, sessionManager: { list: () => [], search: () => [] } }, workspace: {} } as unknown as CommandContext;
  const summary = await sessionSummary(ctx, {});
  expect(summary.status).toBe('available');
  expect(summary.sessions).toEqual([]);
  expect(summary.current).toMatchObject({ sessionId: 'session', messageCount: 1, transcript: { status: 'unavailable', events: null, groups: null } });
});

for (const changed of ['abort', 'session-manager']) test(`actual harness sessions refuses ${changed} during a paused noncooperating read`, async () => {
  let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve; });
  let resume!: () => void; const paused = new Promise<void>(resolve => { resume = resolve; });
  const fake = fakePort(() => noulAnswer(0.99));
  const tails: Array<ReturnType<typeof fake.port.ask>> = [];
  installJudgmentPort({ model: fake.port.model, ask(request) {
    const tail = (async () => { entered(); await paused; return fake.port.ask(request); })();
    tails.push(tail); return tail;
  } });
  const conversation = new ConversationManager(() => 100); conversation.addSystemMessage('[Approval] Waiting');
  const ctx = { platform: fixturePlatform(), session: { conversationManager: conversation, runtime: { sessionId: 'session' }, sessionManager: { list: () => [], search: () => [] } }, workspace: {} } as unknown as CommandContext;
  const tool = createAgentHarnessTool({ commandContext: ctx } as Parameters<typeof createAgentHarnessTool>[0]);
  const controller = new AbortController();
  let delivered = 0;
  const outcome = tool.execute({ mode: 'sessions' }, { signal: controller.signal }).then(
    value => { delivered++; return { status: 'resolved' as const, value }; },
    (error: unknown) => ({ status: 'rejected' as const, error }));
  try {
    await started;
    if (changed === 'abort') controller.abort(new Error('private cancellation reason'));
    else { Object.defineProperty(ctx.session, 'sessionManager', { value: { list: () => [], search: () => [] } }); resume(); }
    // Cancellation must settle even though the provider has not cooperated.
    const answer = await outcome;
    if (changed === 'abort') {
      expect(answer.status).toBe('rejected');
      if (answer.status !== 'rejected') throw new Error('Cancelled session read published a result.');
      expect(answer.error).toBe(controller.signal.reason); expect(delivered).toBe(0);
    } else {
      expect(answer.status).toBe('resolved');
      if (answer.status !== 'resolved') throw answer.error;
      expect(answer.value.success).toBe(false);
      expect(JSON.stringify(answer.value)).not.toContain('"status":"available"');
    }
  } finally { resume(); controller.abort(); await outcome; await Promise.allSettled(tails); }
});
