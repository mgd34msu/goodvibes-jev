import { createHash } from 'node:crypto';
import { workLedgerCommandSchema } from './types.js';

/** Identity capture only; host construction supplies these facts, not payload authority. */
export function captureLegacyImportAction(input: {
  readonly storeId: string; readonly projectId: string; readonly principalKind: string;
  readonly principalId: string; readonly command: unknown;
}) {
  const identity = [input.storeId, input.projectId, input.principalKind, input.principalId];
  if (identity.some(value => typeof value !== 'string' || !value.trim() || value.length > 4096)) throw new Error('Complete authenticated import identity required');
  const command = workLedgerCommandSchema.parse(input.command);
  if (command.type !== 'import_legacy' || command.manifest.projectId !== input.projectId) throw new Error('Import action project mismatch');
  const commandJson = JSON.stringify(command);
  const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
  return Object.freeze({ requestKey: hash([...identity, command.requestId]), actionId: hash([...identity, commandJson]), commandJson,
    storeId: input.storeId, projectId: input.projectId, principalKind: input.principalKind, principalId: input.principalId,
    requestId: command.requestId, manifestDigest: command.manifest.digest, expectedRevision: command.expectedRevision });
}
