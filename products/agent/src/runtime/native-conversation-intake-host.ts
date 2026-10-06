import { createNativeHostedTurnClient } from './native-hosted-turn.ts';
import { isNativePairedPrincipal } from './native-paired-principal.ts';
import { createOperatorNativeWorkExecutionClient } from '@goodvibes-jev/engine/sdk/platform/workflow/work-ledger/native-execution-client';
import { createOperatorSdk, type OperatorRemoteClient } from '@goodvibes-jev/engine/operator-sdk';
import { createOperatorNativeConversationIntakeClient } from '@goodvibes-jev/engine/sdk/platform/workflow/work-ledger/native-intake-client';
import type { NativeSubmissionHost } from './native-work-submission-host.ts';
import type { NativeConversationIntakeBinding } from './native-conversation-intake.ts';

export function createNativeConversationIntakeBinding(host: NativeSubmissionHost, projectId: string, current: () => boolean = () => true): NativeConversationIntakeBinding {
  // The engine may verify a queued permit after this intake operation has detached.
  // Each verification opens a fresh connection, fenced to the exact selected host.
  const invoke = (async (...args: Parameters<OperatorRemoteClient['invoke']>) => {
    if (!current()) throw new Error('Native intake host selection changed');
    const operator = createOperatorSdk({ baseUrl: host.baseUrl, authToken: host.token });
    try {
      // A prior principal read cannot authorize a later private-pairing call.
      // This also fences retained permits that outlive the initial binding.
      if (host.expectedPrincipalId !== undefined && args[0] !== 'control.auth.current') {
        const auth = await operator.invoke('control.auth.current', {}, args[2]);
        if (!current()) throw new Error('Native intake host selection changed');
        if (!isNativePairedPrincipal(auth, host.expectedPrincipalId)) throw new Error('Native intake paired authority changed');
      }
      const value = await operator.invoke(...args);
      if (!current()) throw new Error('Native intake host selection changed');
      return value;
    } finally { operator.dispose(); }
  }) as OperatorRemoteClient['invoke'];
  let principalId: string | undefined;
  const hostedInvoke = (async (...args: Parameters<OperatorRemoteClient['invoke']>) => {
    // Refresh paired authority and project immediately before every hosted call.
    // A status read grants no permission to make a later mutation.
    const options = args[2];
    const auth = await invoke('control.auth.current', {}, options);
    if (!isNativePairedPrincipal(auth, host.expectedPrincipalId) || !principalId || auth.principalId !== principalId
      || !(auth.scopes.includes('*') || auth.scopes.includes('write:sessions'))) throw new Error('Native hosted turn authority changed');
    const project = await invoke('workLedger.project', {}, options);
    if (project.projectId !== projectId) throw new Error('Native hosted turn project changed');
    return invoke(...args);
  }) as OperatorRemoteClient['invoke'];
  const client = createOperatorNativeConversationIntakeClient({ invoke }, projectId);
  const execution = createOperatorNativeWorkExecutionClient({ invoke }, projectId);
  return {
    client, execution, hostedTurn: createNativeHostedTurnClient({ invoke: hostedInvoke }, projectId),
    async readPrincipal(signal) {
      const auth = await invoke('control.auth.current', {}, { signal });
      if (!isNativePairedPrincipal(auth, host.expectedPrincipalId)) {
        throw new Error('Native intake requires an existing paired principal');
      }
      principalId = auth.principalId!;
      return principalId;
    },
    dispose() { try { client.dispose(); } finally { execution.dispose(); } },
  };
}
