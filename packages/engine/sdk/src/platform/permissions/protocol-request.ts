import { types as nodeTypes } from 'node:util';
/** Fixed protocol identity positions. This module describes data, never authority. */
import { createHash } from 'node:crypto';
import { canonicalJson, type EntryType } from '@goodvibes-jev/judgment';
import { captureOwnedJson, snapshotJudgmentInput } from '../gate/judgment-input.js';
import { captureAutonomousChoices } from './autonomous.js';

const brand: unique symbol = Symbol('captured-protocol-request');
export interface CapturedProtocolRequest { readonly [brand]: true }
interface Captured { readonly wire: unknown; readonly meaning: unknown; readonly revision: string }
const captures = new WeakMap<CapturedProtocolRequest, Captured>();
type Kind = 'acp-permission' | 'mcp-elicitation' | 'mcp-input-required';

function identity(value: unknown, numeric: boolean): void {
  if (typeof value !== 'string' && !(numeric && typeof value === 'number' && Number.isFinite(value))) throw new Error('Invalid protocol identity');
  captureAutonomousChoices({ resumeConditions: [{ id: String(value), revision: 'protocol' }] });
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function capture(value: unknown, kind: Kind): CapturedProtocolRequest {
  const wire = captureOwnedJson(value, nodeTypes.isProxy);
  if (!record(wire)) throw new Error('Invalid protocol request');
  if (kind === 'acp-permission') {
    identity(wire.sessionId, false);
    if (!record(wire.toolCall) || !Array.isArray(wire.options)) throw new Error('Invalid ACP permission');
    identity(wire.toolCall.toolCallId, false);
    for (const option of wire.options) { if (!record(option)) throw new Error('Invalid ACP option'); identity(option.optionId, false); }
  } else if (kind === 'mcp-elicitation') identity(wire.requestId, true);
  else if (wire.inputRequests !== undefined && !record(wire.inputRequests)) throw new Error('Invalid MCP input requests');

  function project(entry: unknown, path: readonly string[]): unknown {
    const acpIdentity = kind === 'acp-permission' && (
      (path.length === 1 && path[0] === 'sessionId')
      || (path.length === 2 && path[0] === 'toolCall' && path[1] === 'toolCallId')
      || (path.length === 3 && path[0] === 'options' && /^(0|[1-9][0-9]*)$/.test(path[1]!) && path[2] === 'optionId'));
    if (acpIdentity || (kind === 'mcp-elicitation' && path.length === 1 && path[0] === 'requestId')) return '[protocol identity]';
    if (kind === 'mcp-input-required' && path.length === 1 && path[0] === 'inputRequests' && record(entry)) {
      // Only the map's keys are identities. Entire request values remain raw data.
      return Object.entries(entry).map(([id, request], index) => { identity(id, true); return { request: project(request, [...path, id]), ordinal: index }; });
    }
    if (!entry || typeof entry !== 'object') return entry;
    const projected: Record<string, unknown> | unknown[] = Array.isArray(entry) ? new Array(entry.length) : Object.create(null) as Record<string, unknown>;
    for (const [key, child] of Object.entries(entry)) Object.defineProperty(projected, key, { value: project(child, [...path, key]), enumerable: true });
    return projected;
  }
  const meaning = snapshotJudgmentInput(project(wire, []));
  const revision = createHash('sha256').update(canonicalJson(wire as EntryType)).digest('hex');
  const token: CapturedProtocolRequest = Object.freeze({ [brand]: true as const });
  captures.set(token, Object.freeze({ wire, meaning, revision }));
  return token;
}
export function captureAcpPermissionRequest(value: unknown): CapturedProtocolRequest { return capture(value, 'acp-permission'); }
export function captureMcpElicitationRequest(value: unknown): CapturedProtocolRequest { return capture(value, 'mcp-elicitation'); }
export function captureMcpInputRequired(value: unknown): CapturedProtocolRequest { return capture(value, 'mcp-input-required'); }
export function readProtocolRequest(value: unknown): Captured {
  const found = value !== null && typeof value === 'object' ? captures.get(value as CapturedProtocolRequest) : undefined;
  if (!found) throw new Error('Protocol capture requires an owned request');
  return found;
}
