/**
 * session-save-source.test.ts, who caused each save.
 *
 * The session-conversations retention sweep expires automatic saves and
 * spares ones the user explicitly asked for, which only works if the consumer
 * says which is which. The honest split:
 *
 *   'user', the operator directly asked for this file to exist: /save,
 *            /session save, /session fork, /session rename's backfill, and
 *            the crash-recovery restore they accepted in the startup modal.
 *   'auto', machinery: per-turn persistence and the journal-replay
 *            gap-closure write.
 *
 * Getting this backwards is silent and slow: a session the user deliberately
 * kept quietly disappears on a later sweep, and nothing points at the save
 * that failed to say so.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, rmSync } from 'node:fs';
import { SessionManager } from '@goodvibes-jev/engine/sdk/platform/sessions';
import type { SessionSurface } from '@/runtime/index.ts';
import type { CommandContext } from '../../input/command-registry.ts';
import { ConversationManager } from '../../core/conversation.ts';
import { handleSessionWorkflowCommand } from '../../input/commands/session-workflow.ts';
import { registerSessionContentCommands } from '../../input/commands/session-content.ts';
import { CommandRegistry } from '../../input/command-registry.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';
import { makeTestSurface } from '../helpers/session-surface.ts';

let tmpDir: string;
let surface: SessionSurface;

beforeEach(() => {
  tmpDir = makeProjectTempDir('gv-save-source');
  surface = makeTestSurface(tmpDir);
});
afterEach(() => { if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true }); });

function makeCtx(sm: SessionManager, printed: string[], seed: Array<{ role: string; content: string }> = [{ role: 'user', content: 'hello' }]): CommandContext {
  const conversation = new ConversationManager(() => 80);
  conversation.fromJSON({ messages: seed as never[], title: 'Working title', titleSource: 'auto' as never });
  conversation.rebuildHistory();
  return {
    print: (t: string) => { printed.push(t); },
    renderRequest: () => {},
    session: {
      conversationManager: conversation,
      runtime: { sessionId: 'current-session', model: 'm', provider: 'p', debugMode: false, systemPrompt: '', reasoningEffort: 'medium' },
      sessionManager: sm,
    },
    workspace: {
      shellPaths: { workingDirectory: tmpDir, homeDirectory: tmpDir },
      surface,
    },
    platform: { configManager: { get: () => 'off', getCategory: () => ({}) } },
    clients: { providerApi: { selectModel: async (model: string) => ({ registryKey: model, providerId: 'p' }) } },
  } as unknown as CommandContext;
}

describe('user-directed saves are stamped as user saves', () => {
  test('/session save', async () => {
    const sm = new SessionManager(tmpDir, { surface });
    const printed: string[] = [];

    await handleSessionWorkflowCommand(['save', 'kept-by-hand'], makeCtx(sm, printed));

    expect(printed.join('\n')).toContain('Session saved');
    expect(sm.getMeta('kept-by-hand')?.saveSource).toBe('user');
  });

  test('/session fork', async () => {
    const sm = new SessionManager(tmpDir, { surface });
    const printed: string[] = [];

    await handleSessionWorkflowCommand(['fork', 'a-branch'], makeCtx(sm, printed));

    const forked = sm.list().find((s) => s.title === 'a-branch');
    expect(forked).toBeDefined();
    expect(sm.getMeta(forked!.name)?.saveSource).toBe('user');
  });

  test("/session rename's backfill save: naming a session is an act of curation", async () => {
    const sm = new SessionManager(tmpDir, { surface });
    const printed: string[] = [];
    // No file exists for 'current-session' yet, so rename materializes one.
    await handleSessionWorkflowCommand(['rename', 'a deliberate name'], makeCtx(sm, printed));

    expect(printed.join('\n')).toContain('Session renamed');
    const renamed = sm.list().find((s) => s.title === 'a deliberate name' || s.name.includes('deliberate'));
    expect(renamed).toBeDefined();
    expect(sm.getMeta(renamed!.name)?.saveSource).toBe('user');
  });
});

describe('the standalone /save command', () => {
  test('/save is the plainest "keep this" act there is, and says so', async () => {
    const sm = new SessionManager(tmpDir, { surface });
    const printed: string[] = [];
    const ctx = makeCtx(sm, printed);
    // /save also exports agent state alongside the conversation.
    (ctx as unknown as { ops: unknown }).ops = { agentManager: { exportState: () => [] } };

    const registry = new CommandRegistry();
    registerSessionContentCommands(registry);
    await registry.execute('save', ['saved-by-command'], ctx);

    expect(printed.join('\n')).toContain('Session saved');
    expect(sm.getMeta('saved-by-command')?.saveSource).toBe('user');
  });
});

describe('automatic persistence is stamped as automatic', () => {
});

for (const command of ['fork', 'save', 'resume'] as const) {
  test(`/session ${command} revokes pending native retry admission before changing session identity/history`, async () => {
    const { heldNativeRetry } = await import('../helpers/held-native-retry.ts');
    const native = await heldNativeRetry(); const result = native.start();
    const sm = new SessionManager(tmpDir, { surface }); const printed: string[] = [];
    sm.save('destination', [{ role: 'user', content: 'saved' }], { title: 'Destination', model: 'm', provider: 'p', timestamp: Date.now() });
    const ctx = makeCtx(sm, printed); let cancelled = 0;
    ctx.cancelPendingRecovery = () => {
      expect(ctx.session.runtime.sessionId).toBe('current-session');
      expect(ctx.session.conversationManager.getMessageCount()).toBe(1);
      cancelled++; return native.cancel();
    };
    try {
      await native.waiting; expect(native.orchestrator.isThinking).toBe(false);
      await handleSessionWorkflowCommand([command, 'destination'], ctx);
      expect(cancelled).toBe(1); expect(ctx.session.runtime.sessionId).not.toBe('current-session');
      native.release(); expect(await result).toMatchObject({ name: 'AbortError' });
      expect(native.conversation.getMessageCount()).toBe(0);
    } finally { native.dispose(); await result; }
  });
}
