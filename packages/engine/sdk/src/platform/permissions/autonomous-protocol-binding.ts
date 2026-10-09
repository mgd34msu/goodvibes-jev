import { readProtocolRequest } from './protocol-request.js';
/** Canonical hashes after typed capture: protocol identities are not raw action material. */
import { createHash } from 'node:crypto';
import { canonicalJson, type EntryType } from '@goodvibes-jev/judgment';
import { snapshotJudgmentInput } from '../gate/judgment-input.js';
import { captureAutonomousChoices, captureAutonomousSource } from './autonomous.js';

// Same canonical bytes as judgment.hashState, without requiring a Bun global.
function hashCaptured(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value as EntryType)).digest('hex');
}

export function autonomousSourceRevision(source: unknown): string {
  return hashCaptured(captureAutonomousSource(source));
}

export function externalRequestRevision(connectionId: string, destination: string, args: Record<string, unknown>, protocolSubject?: unknown): string {
  const connection = captureAutonomousChoices({ resumeConditions: [{ id: connectionId, revision: 'connection' }] }).resumeConditions![0]!.id;
  const payload = snapshotJudgmentInput({ destination, args }) as Record<string, unknown>;
  return hashCaptured(Object.freeze({ connection, ...payload, ...(protocolSubject ? { protocolRevision: readProtocolRequest(protocolSubject).revision } : {}) }));
}

export function externalSourceRequestRevision(request: unknown, source: unknown): string {
  return hashCaptured(Object.freeze({ request: readProtocolRequest(request).wire, source: captureAutonomousSource(source) }));
}
