import { isNativePairedPrincipal } from './native-paired-principal.ts';
import { realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createOperatorSdk } from '@goodvibes-jev/engine/operator-sdk';
import { createOperatorWorkLedgerReadClient } from '@goodvibes-jev/engine/sdk/platform/workflow/work-ledger/operator-read-client';
import { createOperatorNativeWorkSubmissionClient } from '@goodvibes-jev/engine/sdk/platform/workflow/work-ledger/native-submission-client';
import type { NativeWorkSubmissionBinding } from './native-work-submission.ts';

export interface NativeSubmissionHost { readonly baseUrl: string; readonly token: string; readonly workspace: string; readonly journalPath?: string; }
export function nativeSubmissionIdentity(host: NativeSubmissionHost, projectId: string): string {
  return createHash('sha256').update(JSON.stringify([host.baseUrl, host.token, realpathSync(host.workspace), projectId, host.journalPath ?? null])).digest('hex');
}
export function createNativeWorkSubmissionBinding(host: NativeSubmissionHost, projectId: string): NativeWorkSubmissionBinding {
  const operator = createOperatorSdk({ baseUrl: host.baseUrl, authToken: host.token });
  const reader = createOperatorWorkLedgerReadClient(operator, projectId);
  const client = createOperatorNativeWorkSubmissionClient(operator, projectId);
  return { client,
    readPrincipal: signal => operator.invoke('control.auth.current', {}, { signal }).then(auth => {
      // authMode is intentionally not consulted: shared and paired tokens share
      // that coarse label. This exact principal comes from the live host.
      if (!isNativePairedPrincipal(auth)) {
        throw Object.assign(new Error('Native submission requires an existing paired principal'), { code: 'NATIVE_SUBMISSION_UNSUPPORTED_AUTHORITY' });
      }
      return auth.principalId!;
    }),
    readSnapshot: () => reader.readSnapshot(), dispose() {
    try { client.dispose(); } finally { try { reader.dispose(); } finally { operator.dispose(); } }
  } };
}
