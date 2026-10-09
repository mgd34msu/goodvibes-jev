import { Orchestrator, ConversationManager, type OrchestratorOptions } from '@goodvibes-jev/engine/sdk/platform/core';
import { ToolRegistry } from '@goodvibes-jev/engine/sdk/platform/tools';
import { createOperatorNativeConversationIntakeClient, type NativeConversationIntakeResult } from '@goodvibes-jev/engine/sdk/platform/workflow/work-ledger/native-intake-client';
import { runOwnedTurnRetry } from '../../core/turn-cancellation.ts';

type NativeRetryPhase = 'prepared' | 'submit-entered' | 'admission-held' | 'cancel-requested' | 'abort-relayed' | 'released' | 'admission-returned';
export type NativeRetryOutcome = {
  readonly phases: readonly NativeRetryPhase[];
  readonly signalAborted: boolean;
  readonly messageCount: number;
} & ({ readonly status: 'fulfilled' } | { readonly status: 'rejected'; readonly reason: unknown });

/** Real SDK admission held after the product's memory await, before submission. */
export async function heldNativeRetry() {
  const phases: NativeRetryPhase[] = [];
  let releaseGate!: () => void; let entered!: () => void;
  const gate = new Promise<void>(resolve => { releaseGate = resolve; });
  const release = () => { phases.push('released'); releaseGate(); };
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  const id = crypto.randomUUID(); const text = 'Explain the recorded change';
  const result: NativeConversationIntakeResult = { kind: 'turn', projectId: 'p', requestId: id, route: 'answer', text,
    sourceRef: { version: 1, inputId: id, sourceId: id, sourceRevision: 'r1', sessionId: 's' } };
  const client = createOperatorNativeConversationIntakeClient({ async invoke<T>(method: string) {
    if (method.endsWith('.get')) { phases.push('admission-held'); entered(); await gate; phases.push('admission-returned'); }
    return structuredClone(result) as T;
  } }, 'p');
  const permit = client.bindTurn(await client.capture({ requestId: id, inputId: id, text, unsupportedSources: [] }));
  const conversation = new ConversationManager();
  const orchestrator = new Orchestrator({ conversation, getViewportHeight: () => 0, scrollToEnd() {}, toolRegistry: new ToolRegistry(),
    permissionManager: { getMode: () => 'prompt' } as OrchestratorOptions['permissionManager'], services: { agentManager: { list: () => [], spawn: () => { throw new Error('Unexpected legacy spawn'); } },
      contractRunner: { list: () => [] }, contractIntake: { intake: async () => { throw new Error('Unexpected legacy intake'); } } } });
  orchestrator.bindNativeConversationProject('p');
  const controller = new AbortController();
  const start = (signal: AbortSignal = controller.signal, isCurrent = () => !signal.aborted): Promise<NativeRetryOutcome> => {
    // Keep fulfillment distinct from rejection(undefined). Snapshot synchronous
    // phases at settlement so a failure explains the ordering without adding
    // waits or allowing later disposal to rewrite the evidence.
    const snapshot = () => ({ phases: [...phases], signalAborted: signal.aborted, messageCount: conversation.getMessageCount() });
    return runOwnedTurnRetry({
      prepare: async () => { phases.push('prepared'); },
      submit: () => { phases.push('submit-entered'); return orchestrator.handleUserInput(text, undefined, { nativeConversationTurnPermit: permit }); },
      abort: () => { phases.push('abort-relayed'); orchestrator.abort(); }, isCurrent, signal,
    }).then(
      () => ({ status: 'fulfilled' as const, ...snapshot() }),
      reason => ({ status: 'rejected' as const, reason: reason as unknown, ...snapshot() }),
    );
  };
  return { orchestrator, conversation, waiting, release, start, cancel: () => { phases.push('cancel-requested'); controller.abort(); return true; },
    dispose: () => { controller.abort(); orchestrator.abort(); release(); orchestrator.dispose(); client.dispose(); } };
}
