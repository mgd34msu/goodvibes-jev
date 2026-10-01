/**
 * daemon-verbs.ts, this product's plug into the SDK's client seams.
 *
 * ── What is here and what deliberately is not ─────────────────────────────
 *
 * The POLICY for every seam this agent crosses, raising an approval, writing a
 * daemon-owned setting, storing a credential, receiving inbound session work,
 * answering a conversation-rewind question, reaching a paired phone, lives in
 * `@goodvibes-jev/engine/sdk/platform/runtime/client`. Each of those modules takes
 * one thing: a `DaemonVerbCaller`, two methods.
 *
 * This file is that one thing, for this product. Resolving WHICH host this
 * agent talks to is a consumer trust-boundary concern the SDK core deliberately
 * never reaches into (the carve-out recorded beside the spine transports), and
 * this agent already had the resolution, `createSpineConnectionResolver` plus
 * the connected-host operator token. So the resolution stays here and the seams
 * are shared, which is the split that lets both surface products use one
 * implementation of each policy without either handing its trust decisions to
 * the other.
 *
 * ── Why one route rather than two ─────────────────────────────────────────
 *
 * Every catalogued verb is served over the generic gateway-method route
 * regardless of the transport it DECLARES, and most of what this agent needs is
 * declared `ws` with no REST path of its own: `approvals.raise`,
 * `credentials.set`/`delete`, `rewind.conversation.*`, the `devices.*` family.
 * A typed-client-first path would therefore fall through to this route for the
 * majority of calls anyway, so this uses it for all of them: one code path, one
 * failure mode, and no verb that works only because it happened to have a REST
 * binding.
 *
 * ── Refusals are values; failures are throws ──────────────────────────────
 *
 * `probe()` answers with the honest reason rather than throwing it, because
 * callers use it to degrade or to print a line instead of crashing a turn. Once
 * a request is actually made, a non-2xx throws, including the 404 that means
 * "this host has not wired that verb", which is a real answer about the host
 * and must never be laundered into an empty result.
 */
import { resolveConnectedHostDialEnabled } from '@goodvibes-jev/engine/sdk/platform/config';
import type { ConfigManager } from '@goodvibes-jev/engine/sdk/platform/config';
import type { DaemonReachability, DaemonVerbCaller } from '@goodvibes-jev/engine/sdk/platform/runtime/client';
import { readConnectedHostOperatorToken, connectedHostTokenRequiredMessage } from '../connected-host-auth.ts';
import { connectedHostBaseUrl } from '../../config/connected-host-dial.ts';

/**
 * The connected host's dial address, derived the same way the spine derives it.
 *
 * The wildcard→loopback mapping this function used to carry alone now lives in
 * config/connected-host-dial.ts, so every other dial site gets it too.
 */
function resolveConnectedHostBaseUrl(configManager: Pick<ConfigManager, 'get'>): string {
  return connectedHostBaseUrl(
    configManager.get('controlPlane.host'),
    configManager.get('controlPlane.port'),
  );
}

export interface AgentDaemonVerbCallerOptions {
  readonly configManager: ConfigManager;
  readonly homeDirectory: string | (() => string);
  /** Injectable for tests, so a seam under test never reaches a real port. */
  readonly fetchImpl?: typeof fetch;
}

interface ResolvedConnection {
  readonly baseUrl: string;
  readonly token: string;
}

/**
 * Resolve the connected host, or the honest reason there is not one.
 *
 * Every refusal names what is missing and what to do about it, because this is
 * the text a person reads when a setting will not save or an ask will not
 * leave this process.
 */
function resolveConnection(options: AgentDaemonVerbCallerOptions): ResolvedConnection | { readonly reason: string } {
  const { configManager } = options;
  // A context whose config manager cannot answer (a narrow embed, a partially
  // wired test double) is one more case of "no host can be resolved", never an
  // exception to raise from a probe.
  if (typeof (configManager as { get?: unknown } | null)?.get !== 'function') {
    return { reason: 'no config manager is wired here, so no connected host can be resolved.' };
  }
  // `daemon.connectedHost.enabled`, NOT `daemon.enabled`.
  //
  // `daemon.enabled` answers whether this surface ADOPTS a session daemon of
  // its own. It is the wrong question here, and asking it was a real defect:
  // on a machine with `daemon.enabled: false` and a connected host that was
  // live and answering, this gate refused every call through this caller, the
  // session-inputs poll (every two seconds, thousands of log lines an hour),
  // the conversation-rewind host registration, the approvals update stream and
  // the hosted-conversation handoff, while the session spine, the memory
  // spine and the operator tools dialed the SAME host without trouble, because
  // none of them read the flag. Half the product believed there was no daemon.
  //
  // The two meanings are now two settings. This one is the dial permission.
  if (!resolveConnectedHostDialEnabled(configManager)) {
    return {
      reason: 'this surface is set not to dial a connected host (daemon.connectedHost.enabled=false), '
        + 'nothing to reach. Set it to true in settings, then retry.',
    };
  }
  const homeDirectory = typeof options.homeDirectory === 'function' ? options.homeDirectory() : options.homeDirectory;
  const token = readConnectedHostOperatorToken(homeDirectory);
  if (!token.token) {
    return { reason: connectedHostTokenRequiredMessage(token.path) };
  }
  return { baseUrl: resolveConnectedHostBaseUrl(configManager), token: token.token };
}

/**
 * The same host resolution the verb caller uses, for the ONE consumer that
 * needs the address rather than a call: the `control.approval_update` stream.
 *
 * A stream is not a verb, it is a long-lived GET on the control plane's event
 * endpoint, so it cannot go through `invoke`. It must still reach exactly the
 * host `invoke` reaches, with exactly the token `invoke` sends, or the approvals list
 * would end up polling one daemon and streaming from another. Exporting the
 * resolution (rather than duplicating it) is what guarantees that.
 *
 * Returns the honest reason instead of throwing, same as `probe()`: a caller
 * that cannot open a stream keeps whatever fallback it had.
 */
export function resolveConnectedHostConnection(
  options: AgentDaemonVerbCallerOptions,
): { readonly baseUrl: string; readonly token: string } | { readonly reason: string } {
  return resolveConnection(options);
}

/** A non-2xx from the host, carrying the status so callers can classify it. */
export class ConnectedHostVerbError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'ConnectedHostVerbError';
    this.status = status;
  }
}

/**
 * Render a thrown verb error honestly: a 404 means this host has not wired a
 * handler for the verb (a live host that simply does not implement it yet),
 * never "no result" or a fabricated empty state.
 */
export function describeConnectedHostVerbError(error: unknown): string {
  if (error instanceof ConnectedHostVerbError) {
    if (error.status === 404) {
      return 'the connected host returned 404, this verb is not wired up on that host yet.';
    }
    if (error.status === 401 || error.status === 403) {
      return `the connected host rejected the request (${error.status}): ${error.message}`;
    }
    return `the request failed (${error.status}): ${error.message}`;
  }
  return error instanceof Error ? error.message : String(error);
}

/**
 * Build the verb caller every client seam in this product is handed.
 *
 * The connection is re-resolved per call rather than captured once: the token
 * file is written by a pairing step that may land after this process started,
 * and a caller that captured an absent token at boot would keep refusing for
 * the life of the process.
 */
export function createAgentDaemonVerbCaller(options: AgentDaemonVerbCallerOptions): DaemonVerbCaller {
  const fetchImpl = options.fetchImpl ?? fetch;

  const probe = (): DaemonReachability => {
    const resolved = resolveConnection(options);
    return 'reason' in resolved ? { available: false, reason: resolved.reason } : { available: true };
  };

  return {
    probe,
    invoke: async <T,>(methodId: string, input?: unknown): Promise<T> => {
      const resolved = resolveConnection(options);
      if ('reason' in resolved) throw new Error(`cannot invoke '${methodId}': ${resolved.reason}`);
      const response = await fetchImpl(
        `${resolved.baseUrl}/api/control-plane/methods/${encodeURIComponent(methodId)}/invoke`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${resolved.token}`, 'Content-Type': 'application/json' },
          // The envelope the route requires: `body` must be PRESENT even when
          // empty, or the route refuses with a 400 naming the shape it wanted.
          body: JSON.stringify({ body: input ?? {} }),
        },
      );
      const payload = await response.json().catch(() => null) as unknown;
      if (!response.ok) {
        const described = payload && typeof payload === 'object' && 'error' in payload
          ? String((payload as { error: unknown }).error)
          : `HTTP ${response.status}`;
        throw new ConnectedHostVerbError(`'${methodId}' failed: ${described}`, response.status);
      }
      return payload as T;
    },
  };
}
