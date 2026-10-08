import { Orchestrator, ConversationManager, type OrchestratorOptions } from '@goodvibes-jev/engine/sdk/platform/core';
import { ToolRegistry } from '@goodvibes-jev/engine/sdk/platform/tools';
import { createOperatorNativeConversationIntakeClient, type NativeConversationIntakeResult } from '@goodvibes-jev/engine/sdk/platform/workflow/work-ledger/native-intake-client';
import { runOwnedTurnRetry } from '../../core/turn-cancellation.ts';

/** Real SDK admission held after the product's memory await, before submission. */
export async function heldNativeRetry() {
  let release!: () => void; let entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  const id = crypto.randomUUID(); const text = 'Explain the recorded change';
  const result: NativeConversationIntakeResult = { kind: 'turn', projectId: 'p', requestId: id, route: 'answer', text,
    sourceRef: { version: 1, inputId: id, sourceId: id, sourceRevision: 'r1', sessionId: 's' } };
  const client = createOperatorNativeConversationIntakeClient({ async invoke<T>(method: string) {
    if (method.endsWith('.get')) { entered(); await gate; }
    return structuredClone(result) as T;
  } }, 'p');
  const permit = client.bindTurn(await client.capture({ requestId: id, inputId: id, text, unsupportedSources: [] }));
  const conversation = new ConversationManager();
  const orchestrator = new Orchestrator({ conversation, getViewportHeight: () => 0, scrollToEnd() {}, toolRegistry: new ToolRegistry(),
    permissionManager: { getMode: () => 'prompt' } as OrchestratorOptions['permissionManager'], services: { agentManager: { list: () => [], spawn: () => { throw new Error('Unexpected legacy spawn'); } },
      contractRunner: { list: () => [] }, contractIntake: { intake: async () => { throw new Error('Unexpected legacy intake'); } } } });
  orchestrator.bindNativeConversationProject('p');
  const controller = new AbortController();
  const start = (signal: AbortSignal = controller.signal, isCurrent = () => !signal.aborted) => runOwnedTurnRetry({
    prepare: async () => {}, submit: () => orchestrator.handleUserInput(text, undefined, { nativeConversationTurnPermit: permit }),
    abort: () => orchestrator.abort(), isCurrent, signal,
  }).then(() => undefined, error => error as unknown);
  return { orchestrator, conversation, waiting, release, start, cancel: () => { controller.abort(); return true; },
    dispose: () => { controller.abort(); orchestrator.abort(); release(); orchestrator.dispose(); client.dispose(); } };
}
