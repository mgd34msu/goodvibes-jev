import { hashState, type JsonValue } from '@goodvibes-jev/judgment';
import type { EvidenceCommand } from './evidence.js';

/** Decode a host exec envelope, never parse an assistant claim as execution.
 * The complete original receipt remains retained, with all execution ids. */
export function commandObservation<T extends EvidenceCommand>(command: T) {
  let value: unknown;
  try { value = JSON.parse(command.head); } catch { return command; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return command;
  const result = value as Record<string, JsonValue>;
  if (result['cmd'] !== command.command || typeof result['exit_code'] !== 'number' || !Number.isSafeInteger(result['exit_code'])
    || typeof result['stdout'] !== 'string' || typeof result['stderr'] !== 'string' || typeof result['success'] !== 'boolean') return command;
  return { ...command, head: result['stdout'], stderr: result['stderr'], exitCode: result['exit_code'],
    executionSucceeded: result['success'], toolCallSucceeded: command.success,
    captureContext: Object.fromEntries(Object.entries(result).filter(([key]) => !['cmd', 'exit_code', 'success', 'stdout', 'stderr'].includes(key))),
    sourceCapture: { digest: hashState(command.head), bytes: Buffer.byteLength(command.head),
      meaning: 'head is the complete actual stdout and stderr is the complete actual stderr decoded from this host exec result; cmd exactly matches the recorded tool command. exitCode and executionSucceeded describe that child execution; success describes the outer tool call. The complete original capture envelope remains in the native command receipt under its unchanged execution identity. This decoding is not a new execution or semantic approval.' },
  };
}
