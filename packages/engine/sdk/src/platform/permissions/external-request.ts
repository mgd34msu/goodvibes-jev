import { readProtocolRequest, type CapturedProtocolRequest } from './protocol-request.js';
import { autonomousSourceRevision, externalRequestRevision } from './autonomous-protocol-binding.js';
import { captureExternalRequestEvidence } from './external-request-evidence.js';
/** ACP/MCP use the same recorded autonomous admission as native tools. No human fallback. */
import { randomUUID } from 'node:crypto';
import type { JudgmentPort } from '@goodvibes-jev/judgment';
import { snapshotJudgmentInput } from '../gate/judgment-input.js';
import { captureAutonomousSource, type AutonomousToolSource } from './autonomous.js';
import { awaitPermission } from './cancellation.js';
import type { PermissionManager } from './manager.js';

/** Trusted transport-owned lifetime; never reconstructed from remote protocol params. */
export interface ExternalRequestScope {
  readonly connectionId: string;
  readonly destination: string;
  readonly signal: AbortSignal;
  readonly assertCurrent: () => void;
}

export interface ExternalPermissionHost {
  readonly port: JudgmentPort;
  readonly permissionManager: Pick<PermissionManager, 'admitAutonomous'>;
  readonly config: { onDidInvalidate(listener: () => void): () => void };
  readonly signal: AbortSignal;
}

/** The original host goal and facts, scoped to an actual pending operation. */
export interface ExternalOperationSource {
  readonly operationId?: string | undefined;
  readonly sourceOf: () => AutonomousToolSource;
  /** Already-authorized, exact possible form answers; Jev may select, never invent them. */
  readonly inputFacts?: readonly Readonly<Record<string, unknown>>[] | undefined;
  readonly assertCurrent: () => void;
  readonly signal?: AbortSignal | undefined;
}

export async function admitExternalRequest(host: ExternalPermissionHost, transport: ExternalRequestScope,
  operation: ExternalOperationSource, input: { readonly tool: string; readonly args: Record<string, unknown>; readonly supportingDecisionIds?: readonly string[]; readonly serverPolicy?: Readonly<Record<string, unknown>>; readonly protocolSubject?: CapturedProtocolRequest }) {
  const externalRequestEvidence = captureExternalRequestEvidence({ destination: transport.destination, ...(input.serverPolicy ? { serverPolicy: input.serverPolicy } : {}) });
  if (!host.port.recorder) throw new Error('External protocol admission requires a recorded judgment owner');
  const invalidation = new AbortController();
  const unsubscribe = host.config.onDidInvalidate(() => invalidation.abort());
  const signal = AbortSignal.any([host.signal, transport.signal, invalidation.signal, ...(operation.signal ? [operation.signal] : [])]);
  const assertCurrent = (): void => { signal.throwIfAborted(); transport.assertCurrent(); operation.assertCurrent(); };
  try {
    assertCurrent();
    const source = captureAutonomousSource(operation.sourceOf());
    const sourceRevision = autonomousSourceRevision(source);
    const protocol = input.protocolSubject ? readProtocolRequest(input.protocolSubject) : undefined;
    const payload = snapshotJudgmentInput(input.args, input.tool) as Record<string, unknown>;
    const args = protocol ? snapshotJudgmentInput({ ...payload, protocolRequest: protocol.meaning }, input.tool) as Record<string, unknown> : payload;
    const sourceOf = () => {
      assertCurrent();
      const current = captureAutonomousSource(operation.sourceOf());
      if (autonomousSourceRevision(current) !== sourceRevision) throw new Error('External operation source changed');
      return source;
    };
    const admission = await awaitPermission(() => host.permissionManager.admitAutonomous(randomUUID(), input.tool, args, {
      externalRequestEvidence, signal, sourceOf, assertPrepared: assertCurrent, ...(input.supportingDecisionIds ? { preparationDecisionIds: input.supportingDecisionIds } : {}),
      schemaRevision: externalRequestRevision(transport.connectionId, transport.destination, args, input.protocolSubject),
      decoratePort: () => host.port,
    }), signal);
    assertCurrent();
    let finished = false;
    return {
      result: admission.result,
      assertCurrent,
      claim() {
        if (finished) throw new Error('External response already consumed');
        assertCurrent(); admission.claim(); assertCurrent(); finished = true; unsubscribe();
      },
      close() { if (!finished) { finished = true; unsubscribe(); } },
    };
  } catch (error) { unsubscribe(); throw error; }
}
