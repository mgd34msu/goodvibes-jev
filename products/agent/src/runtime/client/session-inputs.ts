/**
 * session-inputs.ts, the inbound half of the session wire, for this product.
 *
 * The SDK's `createWireSessionDispatch` takes a `SessionInputsWireClient`: two
 * methods over `sessions.inputs.list` and `sessions.inputs.deliver`. It is
 * declared structurally there precisely so each product supplies its own,
 * because building it is the same connection-resolution concern the verb caller
 * already keeps product-side (see client/daemon-verbs.ts).
 *
 * This is that client, over the one gateway-method route this agent uses for
 * every verb. Nothing here is policy: the poller decides what to do with an
 * input, the daemon decides what an input IS, and this shapes two calls.
 */
import type { DaemonVerbCaller, SessionInputsWireClient } from '@goodvibes-jev/engine/sdk/platform/runtime/client';
import type { SharedSessionInputRecord } from '@goodvibes-jev/engine/sdk/platform/control-plane';

/** What `sessions.inputs.list` answers with, tolerating a bare array. */
function readInputs(payload: unknown): readonly SharedSessionInputRecord[] {
  if (Array.isArray(payload)) return payload as readonly SharedSessionInputRecord[];
  const inputs = (payload as { inputs?: unknown } | null)?.inputs;
  return Array.isArray(inputs) ? inputs as readonly SharedSessionInputRecord[] : [];
}

/**
 * Build the inbound-inputs wire client.
 *
 * Neither method swallows a failure: the dispatch poller that owns this treats
 * a rejected list as "retry next tick" and a rejected deliver as "leave it
 * queued", and it can only do that if the failure actually reaches it.
 */
export function createAgentSessionInputsClient(verbs: DaemonVerbCaller): SessionInputsWireClient {
  return {
    async listInputs(sessionId, options) {
      const payload = await verbs.invoke<unknown>('sessions.inputs.list', {
        sessionId,
        ...(options.state === undefined ? {} : { state: options.state }),
        ...(options.since === undefined ? {} : { since: options.since }),
        ...(options.limit === undefined ? {} : { limit: options.limit }),
      });
      return { inputs: readInputs(payload) };
    },

    async deliverInput(sessionId, inputId, options) {
      return await verbs.invoke<unknown>('sessions.inputs.deliver', {
        sessionId,
        inputId,
        ...(options?.consumed === undefined ? {} : { consumed: options.consumed }),
        // The agent answering this input, and (once its turn ends) what it
        // said. Both travel because the run happens HERE: without them the
        // daemon has no reply binding for a channel message it dispatched to
        // this process, and no answer to deliver back to that conversation.
        ...(options?.agentId === undefined ? {} : { agentId: options.agentId }),
        ...(options?.answer === undefined ? {} : { answer: options.answer }),
        ...(options?.status === undefined ? {} : { status: options.status }),
      });
    },
  };
}
