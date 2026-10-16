import { expect, test } from 'bun:test';
import { executeAdmittedHeadlessTurn } from '../../cli/native-headless-turn.ts';
import type { BootstrapContext } from '../../runtime/bootstrap.ts';
import type { NativeConversationIntakeState } from '../../runtime/native-conversation-intake.ts';

for (const response of ['', '   ', 'Completed answer']) test(`headless exit reflects the delivered response ${JSON.stringify(response)}`, async () => {
  const handlers = new Map<string, (event: { payload: unknown }) => void>();
  const ctx = { runtime: { sessionId: 'session', model: 'model', provider: 'provider' },
    runtimeBus: { on(name: string, cb: (event: { payload: unknown }) => void) { handlers.set(name, cb); return () => handlers.delete(name); } },
    orchestrator: { abort() {}, bindNativeConversationProject() {}, async handleUserInput() {
      handlers.get('TURN_COMPLETED')?.({ payload: { response, stopReason: response.trim() ? 'completed' : 'empty_response' } });
    } },
  } as unknown as BootstrapContext;
  const state = { turnReady: true, turnPermit: {}, result: { kind: 'turn', projectId: 'project', text: 'request' } } as unknown as NativeConversationIntakeState;
  const result = await executeAdmittedHeadlessTurn(ctx, state, new AbortController().signal, 'json');
  expect(result.exitCode).toBe(response.trim() ? 0 : 1);
  expect(handlers.size).toBe(0);
});
