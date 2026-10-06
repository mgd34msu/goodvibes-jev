import { createNativeHostFetch } from './client/native-host-fetch.ts';
import { realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createOperatorSdk, type OperatorRemoteClient } from '@goodvibes-jev/engine/operator-sdk';
import { createOperatorWorkLedgerReadClient } from '@goodvibes-jev/engine/sdk/platform/workflow/work-ledger/operator-read-client';
import { createOperatorNativeWorkSubmissionClient } from '@goodvibes-jev/engine/sdk/platform/workflow/work-ledger/native-submission-client';
import type { NativeWorkSubmissionBinding } from './native-work-submission.ts';

export interface NativeSubmissionHost { readonly baseUrl: string; readonly token: string; readonly workspace: string; readonly journalPath?: string; readonly credentialIdentity?: string; }
export function nativeSubmissionIdentity(host: NativeSubmissionHost, projectId: string): string {
  return createHash('sha256').update(JSON.stringify([host.baseUrl, host.token, realpathSync(host.workspace), projectId, host.journalPath ?? null, host.credentialIdentity ?? null])).digest('hex');
}
export function createNativeWorkSubmissionBinding(host: NativeSubmissionHost, projectId: string, current: () => boolean = () => true): NativeWorkSubmissionBinding {
  let disposed = false;
  const operator = createOperatorSdk({ baseUrl: host.baseUrl, authToken: host.token, fetchImpl: createNativeHostFetch({ current: () => !disposed && current() }) });
  const invoke = (async (...args: Parameters<OperatorRemoteClient['invoke']>) => {
    if (disposed || !current()) throw new Error('Native submission host selection changed');
    const value = await operator.invoke(...args);
    if (disposed || !current()) throw new Error('Native submission host selection changed');
    return value;
  }) as OperatorRemoteClient['invoke'];
  const reader = createOperatorWorkLedgerReadClient({ invoke }, projectId);
  const client = createOperatorNativeWorkSubmissionClient({ invoke }, projectId);
  return { client,
    readPrincipal: signal => invoke('control.auth.current', {}, { signal }).then(auth => {
      // authMode is intentionally not consulted: shared and paired tokens share
      // that coarse label. This exact principal comes from the live host.
      if (!auth.authenticated || !auth.admin || auth.principalKind !== 'token' || !auth.principalId || auth.principalId === 'shared-token'
        || auth.principalId.length > 200 || !['read:work-ledger', 'write:work-ledger'].every(scope => auth.scopes.includes('*') || auth.scopes.includes(scope))) {
        throw Object.assign(new Error('Native submission requires an existing paired principal'), { code: 'NATIVE_SUBMISSION_UNSUPPORTED_AUTHORITY' });
      }
      return auth.principalId;
    }),
    readSnapshot: () => reader.readSnapshot(), dispose() {
    disposed = true;
    try { client.dispose(); } finally { try { reader.dispose(); } finally { operator.dispose(); } }
  } };
}
