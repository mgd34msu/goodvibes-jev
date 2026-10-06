import { isNativePairedPrincipal } from './native-paired-principal.ts';
import { realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createOperatorSdk, type OperatorRemoteClient } from '@goodvibes-jev/engine/operator-sdk';
import { createOperatorWorkLedgerReadClient } from '@goodvibes-jev/engine/sdk/platform/workflow/work-ledger/operator-read-client';
import { createOperatorNativeWorkSubmissionClient } from '@goodvibes-jev/engine/sdk/platform/workflow/work-ledger/native-submission-client';
import type { NativeWorkSubmissionBinding } from './native-work-submission.ts';

export interface NativeSubmissionHost {
  readonly baseUrl: string; readonly token: string; readonly workspace: string; readonly journalPath?: string;
  readonly selectionIdentity?: string; readonly expectedPrincipalId?: string;
}
export function nativeSubmissionIdentity(host: NativeSubmissionHost, projectId: string): string {
  return createHash('sha256').update(JSON.stringify([host.baseUrl, host.token, realpathSync(host.workspace), projectId, host.journalPath ?? null,
    host.selectionIdentity ?? null, host.expectedPrincipalId ?? null])).digest('hex');
}
export function createNativeWorkSubmissionBinding(host: NativeSubmissionHost, projectId: string, current: () => boolean = () => true): NativeWorkSubmissionBinding {
  const operator = createOperatorSdk({ baseUrl: host.baseUrl, authToken: host.token });
  const reader = createOperatorWorkLedgerReadClient(operator, projectId);
  const readPrincipal = async (signal?: AbortSignal): Promise<string> => {
    if (!current()) throw new Error('Native submission host selection changed');
    const auth = await operator.invoke('control.auth.current', {}, { signal });
    if (!current()) throw new Error('Native submission host selection changed');
    // authMode is intentionally not consulted: shared and paired tokens share
    // that coarse label. This exact principal comes from the live host.
    if (!isNativePairedPrincipal(auth, host.expectedPrincipalId)) {
      throw Object.assign(new Error('Native submission requires an existing paired principal'), { code: 'NATIVE_SUBMISSION_UNSUPPORTED_AUTHORITY' });
    }
    return auth.principalId!;
  };
  const invoke = (async (...args: Parameters<OperatorRemoteClient['invoke']>) => {
    if (!current()) throw new Error('Native submission host selection changed');
    // Private pairing records bind the credential to this exact live principal,
    // including immediately before retry or submission after earlier reads.
    if (host.expectedPrincipalId !== undefined) await readPrincipal(args[2]?.signal);
    if (!current()) throw new Error('Native submission host selection changed');
    return operator.invoke(...args);
  }) as OperatorRemoteClient['invoke'];
  const client = createOperatorNativeWorkSubmissionClient({ invoke }, projectId);
  return { client, readPrincipal,
    readSnapshot: () => reader.readSnapshot(), dispose() {
    try { client.dispose(); } finally { try { reader.dispose(); } finally { operator.dispose(); } }
  } };
}
