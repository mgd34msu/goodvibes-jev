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
      const value = await operator.invoke(...args);
      if (!current()) throw new Error('Native intake host selection changed');
      return value;
    } finally { operator.dispose(); }
  }) as OperatorRemoteClient['invoke'];
  const client = createOperatorNativeConversationIntakeClient({ invoke }, projectId);
  const execution = createOperatorNativeWorkExecutionClient({ invoke }, projectId);
  return {
    client, execution,
    async readPrincipal(signal) {
      const auth = await invoke('control.auth.current', {}, { signal });
      if (!auth.authenticated || !auth.admin || auth.principalKind !== 'token' || !auth.principalId || auth.principalId === 'shared-token'
        || auth.principalId.length > 200 || !['read:work-ledger', 'write:work-ledger'].every(scope => auth.scopes.includes('*') || auth.scopes.includes(scope))) {
        throw new Error('Native intake requires an existing paired principal');
      }
      return auth.principalId;
    },
    dispose() { try { client.dispose(); } finally { execution.dispose(); } },
  };
}
