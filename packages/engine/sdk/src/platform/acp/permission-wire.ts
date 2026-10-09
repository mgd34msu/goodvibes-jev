/** Final ACP response fence, after SDK dispatch and immediately before stdio write. */
import { snapshotJudgmentInput } from '../gate/judgment-input.js';
import type { RequestPermissionRequest, RequestPermissionResponse } from './protocol.js';
import type { admitExternalRequest } from '../permissions/external-request.js';

type Admission = Awaited<ReturnType<typeof admitExternalRequest>>;
interface WireScope { readonly assertCurrent: () => void; readonly close: () => void; }
interface PendingPermission {
  readonly id: string;
  readonly request?: RequestPermissionRequest;
  readonly toolCallId: string;
  readonly scope: WireScope;
  readonly lifetime: AbortController;
  invalid: boolean;
  finished: boolean;
  response?: RequestPermissionResponse;
  responseText?: string;
  admission?: Admission;
  cleanup?: () => void;
  claim?: boolean;
}
const cancelled = () => ({ outcome: { outcome: 'cancelled' as const } });
function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
function key(id: unknown): string | undefined { return typeof id === 'string' || (typeof id === 'number' && Number.isFinite(id)) ? `${typeof id}:${id}` : undefined; }

export class AcpPermissionWire {
  private readonly requests = new Map<string, PendingPermission>();
  private readonly byTool = new Map<string, PendingPermission>();
  private readonly pending = new Set<PendingPermission>();
  private readonly responses = new WeakMap<object, PendingPermission>();
  constructor(private readonly captureScope: () => WireScope) {}

  /** Already parsed JSON transport input, before the SDK projects its schema. */
  observe(message: unknown): void {
    if (!record(message) || message.method !== 'session/request_permission') return;
    const id = key(message.id), params = message.params;
    if (!id || !record(params) || !record(params.toolCall) || typeof params.toolCall.toolCallId !== 'string') return;
    const toolCallId = params.toolCall.toolCallId;
    const prior = this.requests.get(id) ?? this.byTool.get(toolCallId);
    if (prior) { prior.invalid = true; prior.lifetime.abort(); this.finish(prior); }
    if (this.pending.size >= 1024) { this.close(); throw new Error('ACP pending permission capacity reached'); }
    let request: RequestPermissionRequest | undefined;
    try { request = snapshotJudgmentInput(params) as RequestPermissionRequest; } catch { /* protected frames cannot be selected */ }
    const pending: PendingPermission = { id, ...(request ? { request } : {}), toolCallId, scope: this.captureScope(),
      lifetime: new AbortController(), invalid: !request || !!prior, finished: false };
    this.requests.set(id, pending); this.byTool.set(toolCallId, pending); this.pending.add(pending);
  }

  /** A closure over this exact request incarnation, not a later lookup by reused ID. */
  binding(toolCallId: string) {
    const pending = this.byTool.get(toolCallId);
    if (!pending) return undefined;
    const assertCurrent = () => {
      pending.lifetime.signal.throwIfAborted(); pending.scope.assertCurrent();
      if (pending.finished || pending.invalid || this.requests.get(pending.id) !== pending || this.byTool.get(toolCallId) !== pending)
        throw new Error('ACP permission wire owner changed');
    };
    return { request: pending.request, signal: pending.lifetime.signal, assertCurrent,
      bindTerminal: (response: RequestPermissionResponse) => { this.responses.set(response, pending); },
      defer: (response: RequestPermissionResponse, admission: Admission, claim: boolean, cleanup: () => void) => {
        assertCurrent(); if (pending.response) throw new Error('ACP permission response already bound');
        pending.response = response; pending.responseText = JSON.stringify(response); pending.admission = admission; pending.claim = claim; pending.cleanup = cleanup;
        this.responses.set(response, pending);
      },
    };
  }

  /** Called by the SDK message sink; validation, claim and byte write are synchronous. */
  write(message: unknown, send: (chunk: Uint8Array) => void): void {
    const id = record(message) ? key(message.id) : undefined;
    const responseOwner = record(message) && record(message.result) ? this.responses.get(message.result) : undefined;
    const pending = responseOwner ?? (id ? this.requests.get(id) : undefined);
    if (responseOwner?.finished) return; // a replay never writes twice
    if (!pending || !record(message) || 'method' in message) {
      send(new TextEncoder().encode(JSON.stringify(message) + '\n')); return;
    }
    let bytes: Uint8Array;
    try {
      if (pending.invalid || pending.finished || this.requests.get(id!) !== pending
        || !pending.response || message.result !== pending.response || JSON.stringify(message.result) !== pending.responseText)
        throw new Error('ACP permission response is not its original bound result');
      pending.scope.assertCurrent(); pending.admission?.assertCurrent();
      bytes = new TextEncoder().encode(JSON.stringify(message) + '\n');
      if (pending.claim) pending.admission!.claim();
      pending.scope.assertCurrent();
    } catch {
      bytes = new TextEncoder().encode(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: cancelled() }) + '\n');
    }
    // A throwing/partially writing sink is never retried with a second response.
    try { send(bytes); } finally { this.finish(pending); }
  }

  private finish(pending: PendingPermission): void {
    if (pending.finished) return;
    pending.finished = true;
    if (this.requests.get(pending.id) === pending) this.requests.delete(pending.id);
    if (this.byTool.get(pending.toolCallId) === pending) this.byTool.delete(pending.toolCallId);
    this.pending.delete(pending); pending.lifetime.abort();
    pending.admission?.close(); pending.cleanup?.(); pending.scope.close();
  }
  close(): void { for (const pending of this.pending) this.finish(pending); }
}
