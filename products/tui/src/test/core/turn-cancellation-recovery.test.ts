import { expect, test } from 'bun:test';
import { Orchestrator, ConversationManager, type OrchestratorOptions } from '@goodvibes-jev/engine/sdk/platform/core';
import { ToolRegistry } from '@goodvibes-jev/engine/sdk/platform/tools';
import { createOperatorNativeConversationIntakeClient, type NativeConversationIntakeResult } from '@goodvibes-jev/engine/sdk/platform/workflow/work-ledger/native-intake-client';
import { createCancelGeneration, runOwnedTurnRetry } from '../../core/turn-cancellation.ts';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  return { promise, resolve };
}

for (const cause of ['grace expiry', 'real cancel action'] as const) {
  test(`${cause} aborts real native SDK admission after memory preparation and before TURN_SUBMITTED`, async () => {
    const gate = deferred(); const entered = deferred();
    const text = 'Explain the recorded change';
    const result: NativeConversationIntakeResult = { kind: 'turn', projectId: 'p', requestId: 'request', route: 'answer', text,
      sourceRef: { version: 1, inputId: `input-${cause}`, sourceId: `source-${cause}`, sourceRevision: 'r1', sessionId: 's' } };
    const client = createOperatorNativeConversationIntakeClient({ async invoke<T>(method: string) {
      if (method.endsWith('.get')) { entered.resolve(); await gate.promise; }
      return structuredClone(result) as T;
    } }, 'p');
    const captured = await client.capture({ requestId: 'request', inputId: result.sourceRef.inputId, text, unsupportedSources: [] });
    const permit = client.bindTurn(captured);
    const conversation = new ConversationManager();
    const orchestrator = new Orchestrator({ conversation, getViewportHeight: () => 0, scrollToEnd() {}, toolRegistry: new ToolRegistry(),
      permissionManager: { getMode: () => 'prompt' } as OrchestratorOptions['permissionManager'], services: { agentManager: { list: () => [], spawn: () => { throw new Error('Unexpected legacy spawn'); } },
      contractRunner: { list: () => [] }, contractIntake: { intake: async () => { throw new Error('Unexpected legacy intake'); } } } });
    orchestrator.bindNativeConversationProject('p');
    const authority = new AbortController();
    let prepared = false;
    const pending = runOwnedTurnRetry({ prepare: async () => { prepared = true; },
      submit: () => orchestrator.handleUserInput(text, undefined, { nativeConversationTurnPermit: permit }),
      abort: () => orchestrator.abort(), isCurrent: () => !authority.signal.aborted, signal: authority.signal });
    // Register rejection handling before releasing the held native validator.
    const outcome = pending.then(() => undefined, error => error as unknown);
    try {
      await entered.promise;
      expect(prepared).toBe(true); expect(orchestrator.isThinking).toBe(false);
      if (cause === 'real cancel action') {
        createCancelGeneration(orchestrator, { stop: () => false }, () => { authority.abort(); return true; })();
      } else authority.abort();
      gate.resolve();
      expect(await outcome).toMatchObject({ name: 'AbortError' });
      expect(conversation.getMessageCount()).toBe(0);
    } finally { authority.abort(); gate.resolve(); await outcome; orchestrator.dispose(); client.dispose(); }
  });
}

test('a revoked pre-memory retry never reaches prepare or submission', async () => {
  const authority = new AbortController(); authority.abort(); let entered = 0;
  await runOwnedTurnRetry({ prepare: async () => { entered++; }, submit: async () => { entered++; },
    abort() {}, isCurrent: () => false, signal: authority.signal });
  expect(entered).toBe(0);
});
