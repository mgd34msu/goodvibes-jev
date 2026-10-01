/**
 * phone-node-client.ts, this web app acting as a paired device node.
 *
 * The loop is the SDK peer contract verbatim: request pairing, wait for the
 * operator to approve, verify with the challenge to receive a peer token, then
 * heartbeat and pull `device.capability` work, run it against the browser
 * bindings, and complete it. Nothing in this file is web-specific except the
 * capability bindings it calls, which is the seam a native node replaces.
 *
 * Authority stays on the host. This node never decides whether a capability may
 * run, by the time work reaches the queue the host has already confirmed it
 * with the person or matched a durable grant. What the node owns is the
 * platform action and an honest activity log of everything it did, so the
 * person holding the phone can see what happened on it.
 *
 * The peer token is persisted so a reload does not re-pair, and it is validated
 * by USE, not by presence: a token the daemon rejects (revoked, rotated, or
 * from a daemon that has forgotten this node) is discarded on the spot and the
 * node returns to unpaired rather than retrying forever against a credential
 * that will never work again.
 *
 * Executed-work markers are persisted too (see PhoneNodeStorage.writeExecuted),
 * a bounded record of which work item ids this node has already run a
 * capability for. Without it, a tab that dies between running a capability and
 * its completion report landing would come back from reload with no memory of
 * having already fired that real, user-visible action, and the redelivered
 * item would run it a second time.
 */
import {
  announcedCapabilities,
  readBrowserBindings,
  runWebNodeCapability,
  WEB_NODE_CONTRACT_VERSION,
  WEB_NODE_KIND,
  type BrowserBindings,
  type CapabilityRunResult,
} from './capability-bindings';

/** Where the peer token is kept between reloads. */
export const PHONE_NODE_TOKEN_KEY = 'goodvibes.webui.phoneNode';

export type PhoneNodeStatus = 'unpaired' | 'pairing' | 'awaiting-approval' | 'connected' | 'error';

export interface PhoneNodeIdentity {
  readonly nodeId: string;
  readonly token: string;
  readonly label: string;
}

export interface PhoneNodeActivity {
  readonly at: number;
  readonly capabilityId: string;
  readonly ok: boolean;
  readonly detail: string;
}

/** A capability's outcome, remembered so a redelivered work item can be re-reported without re-running it. */
export interface ExecutedWorkRecord {
  readonly status: 'completed' | 'failed';
  readonly result: unknown;
  readonly error: string | undefined;
}

export interface PhoneNodeState {
  readonly status: PhoneNodeStatus;
  readonly nodeId: string;
  readonly label: string;
  readonly announced: readonly string[];
  readonly pendingRequestId: string;
  readonly message: string;
  readonly activity: readonly PhoneNodeActivity[];
}

/** Where the executed-work markers are kept between reloads, see PhoneNodeStorage.writeExecuted. */
export const PHONE_NODE_EXECUTED_KEY = 'goodvibes.webui.phoneNode.executed';

/** Storage the node keeps its identity in; injected so tests do not need a browser. */
export interface PhoneNodeStorage {
  read(): PhoneNodeIdentity | null;
  write(identity: PhoneNodeIdentity): void;
  clear(): void;
  /**
   * Executed-work markers, [workId, outcome] pairs, oldest first. Read once at
   * construction to seed the in-memory dedupe map; written after every capability
   * run so a reload between running it and the completion report landing does
   * not lose the fact that it already ran. Optional: a storage that omits these
   * (an older test double, say) only loses redelivery protection ACROSS a
   * reload, pumpOnce()'s in-memory map still covers the lost-report-without-
   * reload case on its own.
   */
  readExecuted?(): readonly (readonly [string, ExecutedWorkRecord])[];
  writeExecuted?(entries: readonly (readonly [string, ExecutedWorkRecord])[]): void;
}

export function browserPhoneNodeStorage(): PhoneNodeStorage {
  return {
    read(): PhoneNodeIdentity | null {
      try {
        const raw = window.localStorage.getItem(PHONE_NODE_TOKEN_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw) as Partial<PhoneNodeIdentity>;
        // Validated by shape, not by presence, a half-written entry is
        // discarded rather than used to build a request that cannot succeed.
        if (typeof parsed.nodeId !== 'string' || !parsed.nodeId) return null;
        if (typeof parsed.token !== 'string' || !parsed.token) return null;
        return { nodeId: parsed.nodeId, token: parsed.token, label: typeof parsed.label === 'string' ? parsed.label : 'Phone' };
      } catch {
        return null;
      }
    },
    write(identity: PhoneNodeIdentity): void {
      try {
        window.localStorage.setItem(PHONE_NODE_TOKEN_KEY, JSON.stringify(identity));
      } catch {
        // A browser refusing storage means re-pairing after a reload, not a crash.
      }
    },
    clear(): void {
      try {
        window.localStorage.removeItem(PHONE_NODE_TOKEN_KEY);
        window.localStorage.removeItem(PHONE_NODE_EXECUTED_KEY);
      } catch {
        // Nothing to do; the identity is dropped in memory regardless.
      }
    },
    readExecuted(): readonly (readonly [string, ExecutedWorkRecord])[] {
      try {
        const raw = window.localStorage.getItem(PHONE_NODE_EXECUTED_KEY);
        if (!raw) return [];
        const parsed = JSON.parse(raw) as unknown;
        // Shape-validated the same way identity is: a half-written or foreign
        // entry is dropped rather than fed back in as a false dedupe marker.
        if (!Array.isArray(parsed)) return [];
        return parsed.filter((entry): entry is [string, ExecutedWorkRecord] => (
          Array.isArray(entry) && entry.length === 2 && typeof entry[0] === 'string'
        ));
      } catch {
        return [];
      }
    },
    writeExecuted(entries: readonly (readonly [string, ExecutedWorkRecord])[]): void {
      try {
        window.localStorage.setItem(PHONE_NODE_EXECUTED_KEY, JSON.stringify(entries));
      } catch {
        // A browser refusing storage loses redelivery protection across a reload,
        // not a crash, pumpOnce()'s in-memory map still covers the same-tab case.
      }
    },
  };
}

export interface PhoneNodeClientOptions {
  readonly baseUrl: string;
  readonly label: string;
  readonly storage: PhoneNodeStorage;
  /**
   * HTTP transport. Typed as the call signature rather than `typeof fetch` so a
   * test can supply a plain function without also implementing the browser's
   * non-standard extras (`preconnect`).
   */
  readonly fetchImpl?: ((input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) | undefined;
  readonly bindings?: BrowserBindings | undefined;
  readonly runCapability?: ((capabilityId: string, input: Record<string, unknown>) => Promise<CapabilityRunResult>) | undefined;
  readonly onState?: ((state: PhoneNodeState) => void) | undefined;
  readonly pullIntervalMs?: number | undefined;
  readonly heartbeatIntervalMs?: number | undefined;
  readonly maxActivityRows?: number | undefined;
}

interface PairRequestResponse {
  readonly request?: { readonly id?: string };
  readonly challenge?: string;
}

interface PairVerifyResponse {
  readonly peer?: { readonly id?: string };
  readonly token?: { readonly value?: string };
}

interface WorkItem {
  readonly id: string;
  readonly type?: string;
  readonly command?: string;
  readonly payload?: unknown;
}

/** Activity rows are bounded, an append-only log in a long-lived tab is a leak. */
const DEFAULT_MAX_ACTIVITY = 50;

/**
 * Bounded the same way the activity log is: a long-lived tab must not grow this
 * without limit, and the daemon's lease window (tens of seconds) is far shorter
 * than what it would take to evict a still-relevant entry at this cap.
 */
const DEFAULT_MAX_EXECUTED = 50;

export class PhoneNodeClient {
  private readonly options: PhoneNodeClientOptions;
  private readonly fetchImpl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  private readonly bindings: BrowserBindings;
  private identity: PhoneNodeIdentity | null;
  private state: PhoneNodeState;
  private pullTimer: ReturnType<typeof setInterval> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private pendingChallenge = '';
  private busy = false;
  /**
   * Work item ids whose capability has already run, keyed to their reported
   * outcome. Checked at the top of runWork() so a redelivery, caused by our
   * completion report never landing (lost network, or the tab dying between
   * running the capability and posting the report), retries only the report,
   * never the capability itself. Seeded from storage.readExecuted() at
   * construction so this survives a reload, not just a lost report within the
   * same tab. See runWork(), rememberExecuted(), and completeWork().
   */
  private readonly executedWork: Map<string, ExecutedWorkRecord>;

  constructor(options: PhoneNodeClientOptions) {
    this.options = options;
    this.fetchImpl = options.fetchImpl ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
    this.bindings = options.bindings ?? readBrowserBindings();
    this.executedWork = new Map(options.storage.readExecuted?.() ?? []);
    this.identity = options.storage.read();
    this.state = {
      status: this.identity ? 'connected' : 'unpaired',
      nodeId: this.identity?.nodeId ?? '',
      label: this.identity?.label ?? options.label,
      announced: announcedCapabilities(this.bindings),
      pendingRequestId: '',
      message: this.identity
        ? 'Paired. Waiting for requests.'
        : 'Not paired yet. Ask to pair, then approve it from the desktop.',
      activity: [],
    };
  }

  getState(): PhoneNodeState {
    return this.state;
  }

  private setState(patch: Partial<PhoneNodeState>): void {
    this.state = { ...this.state, ...patch };
    this.options.onState?.(this.state);
  }

  private note(capabilityId: string, ok: boolean, detail: string): void {
    const max = this.options.maxActivityRows ?? DEFAULT_MAX_ACTIVITY;
    const activity = [{ at: Date.now(), capabilityId, ok, detail }, ...this.state.activity].slice(0, max);
    this.setState({ activity });
  }

  private url(path: string): string {
    return `${this.options.baseUrl.replace(/\/$/, '')}${path}`;
  }

  private async post(path: string, body: unknown, token?: string): Promise<{ status: number; json: unknown }> {
    const response = await this.fetchImpl(this.url(path), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body ?? {}),
    });
    let json: unknown;
    try {
      json = await response.json();
    } catch {
      json = null;
    }
    return { status: response.status, json };
  }

  /** Ask the daemon to pair this browser as a device node. */
  async requestPairing(): Promise<void> {
    this.setState({ status: 'pairing', message: 'Asking the daemon to pair…' });
    const announced = announcedCapabilities(this.bindings);
    const { status, json } = await this.post('/api/remote/pair/request', {
      peerKind: 'device',
      label: this.options.label,
      platform: typeof navigator === 'undefined' ? 'web' : navigator.platform || 'web',
      deviceFamily: 'phone',
      clientMode: 'device-node',
      capabilities: announced,
      commands: announced,
      metadata: {
        deviceNode: {
          nodeKind: WEB_NODE_KIND,
          contractVersion: WEB_NODE_CONTRACT_VERSION,
          capabilities: announced,
          secureContext: this.bindings.isSecureContext,
        },
      },
    });
    if (status >= 400) {
      this.setState({ status: 'error', message: `The daemon refused the pairing request (HTTP ${status}).` });
      return;
    }
    const parsed = json as PairRequestResponse;
    const requestId = parsed.request?.id ?? '';
    this.pendingChallenge = parsed.challenge ?? '';
    if (!requestId || !this.pendingChallenge) {
      this.setState({ status: 'error', message: 'The daemon answered without a pairing challenge.' });
      return;
    }
    this.setState({
      status: 'awaiting-approval',
      pendingRequestId: requestId,
      announced,
      message: 'Waiting for approval on the desktop. Approve this device there, then press Finish pairing.',
    });
  }

  /** Complete pairing once the operator has approved the request. */
  async verifyPairing(): Promise<void> {
    if (!this.state.pendingRequestId || !this.pendingChallenge) {
      this.setState({ status: 'error', message: 'There is no pairing request to finish. Ask to pair again.' });
      return;
    }
    const { status, json } = await this.post('/api/remote/pair/verify', {
      requestId: this.state.pendingRequestId,
      challenge: this.pendingChallenge,
    });
    if (status >= 400) {
      this.setState({
        status: 'awaiting-approval',
        message: status === 409 || status === 403
          ? 'Not approved yet. Approve this device on the desktop, then press Finish pairing again.'
          : `Pairing could not be finished (HTTP ${status}).`,
      });
      return;
    }
    const parsed = json as PairVerifyResponse;
    const nodeId = parsed.peer?.id ?? '';
    const token = parsed.token?.value ?? '';
    if (!nodeId || !token) {
      this.setState({ status: 'error', message: 'The daemon approved pairing but returned no device token.' });
      return;
    }
    this.identity = { nodeId, token, label: this.options.label };
    this.options.storage.write(this.identity);
    this.pendingChallenge = '';
    this.setState({
      status: 'connected',
      nodeId,
      pendingRequestId: '',
      message: 'Paired. Waiting for requests.',
    });
  }

  /** Forget this device's pairing locally. */
  unpair(): void {
    this.stop();
    this.identity = null;
    this.executedWork.clear();
    this.options.storage.clear();
    this.setState({ status: 'unpaired', nodeId: '', pendingRequestId: '', message: 'This device is no longer paired here.' });
  }

  /**
   * A rejected token is discarded rather than retried: it means the operator
   * revoked or rotated it, and no amount of retrying will make it work again.
   */
  private handleAuthFailure(): void {
    this.stop();
    this.identity = null;
    this.executedWork.clear();
    this.options.storage.clear();
    this.setState({
      status: 'unpaired',
      nodeId: '',
      message: 'The daemon no longer accepts this device\'s token. It was revoked or rotated. Pair again to reconnect.',
    });
  }

  private async heartbeat(): Promise<void> {
    if (!this.identity) return;
    const announced = announcedCapabilities(this.bindings);
    const { status } = await this.post('/api/remote/heartbeat', {
      capabilities: announced,
      commands: announced,
      clientMode: 'device-node',
      metadata: {
        deviceNode: {
          nodeKind: WEB_NODE_KIND,
          contractVersion: WEB_NODE_CONTRACT_VERSION,
          capabilities: announced,
          secureContext: this.bindings.isSecureContext,
        },
      },
    }, this.identity.token);
    if (status === 401 || status === 403) {
      this.handleAuthFailure();
      return;
    }
    if (this.state.announced.join(',') !== announced.join(',')) this.setState({ announced });
  }

  /** Pull one batch of work and run it. */
  async pumpOnce(): Promise<void> {
    if (!this.identity || this.busy) return;
    this.busy = true;
    try {
      const { status, json } = await this.post('/api/remote/work/pull', { maxItems: 3 }, this.identity.token);
      if (status === 401 || status === 403) {
        this.handleAuthFailure();
        return;
      }
      if (status >= 400) return;
      const items = Array.isArray((json as { work?: unknown }).work) ? (json as { work: WorkItem[] }).work : [];
      for (const item of items) await this.runWork(item);
    } finally {
      this.busy = false;
    }
  }

  private async runWork(item: WorkItem): Promise<void> {
    if (!this.identity) return;
    const executed = this.executedWork.get(item.id);
    if (executed) {
      // Redelivered: the daemon's lease on this item expired before our completion
      // report landed (dropped network, or this tab died between running the
      // capability and posting the report), so the queue offered it again. The
      // capability already fired its real, user-visible side effect once; report
      // the outcome we already have rather than running it a second time.
      await this.completeWork(item.id, executed.status, executed.result, executed.error);
      return;
    }
    const payload = (item.payload && typeof item.payload === 'object' && !Array.isArray(item.payload)
      ? item.payload
      : {}) as Record<string, unknown>;
    const capabilityId = typeof payload.capabilityId === 'string' ? payload.capabilityId : (item.command ?? '');
    if (item.type !== 'device.capability' || !capabilityId) {
      await this.completeWork(item.id, 'failed', undefined, 'This node only serves device.capability work.');
      return;
    }
    const input = (payload.input && typeof payload.input === 'object' && !Array.isArray(payload.input)
      ? payload.input
      : {}) as Record<string, unknown>;
    const runner = this.options.runCapability
      ?? ((id: string, capabilityInput: Record<string, unknown>) => runWebNodeCapability(id, capabilityInput, this.bindings));
    const result = await runner(capabilityId, input);
    this.note(capabilityId, result.ok, result.ok ? 'Served' : (result.error ?? 'Failed'));
    const status = result.ok ? 'completed' : 'failed';
    const completionResult = {
      contractVersion: WEB_NODE_CONTRACT_VERSION,
      capabilityId,
      ok: result.ok,
      ...(result.error ? { error: result.error } : {}),
      ...(result.data === undefined ? {} : { data: result.data }),
      ...(result.mediaBase64 ? { mediaBase64: result.mediaBase64, mediaType: result.mediaType } : {}),
    };
    const completionError = result.ok ? undefined : result.error;
    // Marker persisted BEFORE the report is attempted: if completeWork's POST
    // never lands, a later redelivery of this same item id must still find the
    // marker and skip straight to re-reporting, not re-run the capability.
    this.rememberExecuted(item.id, status, completionResult, completionError);
    await this.completeWork(item.id, status, completionResult, completionError);
  }

  /**
   * Remember a capability's outcome for item.id, evicting the oldest entry past
   * the cap, and persist the whole bounded set synchronously (writeExecuted is a
   * plain localStorage.setItem under browserPhoneNodeStorage, it returns before
   * this function does) so a tab dying immediately afterward still has the
   * marker on the next reload.
   */
  private rememberExecuted(workId: string, status: 'completed' | 'failed', result: unknown, error: string | undefined): void {
    this.executedWork.set(workId, { status, result, error });
    while (this.executedWork.size > DEFAULT_MAX_EXECUTED) {
      const oldestKey = this.executedWork.keys().next().value;
      if (oldestKey === undefined) break;
      this.executedWork.delete(oldestKey);
    }
    this.options.storage.writeExecuted?.([...this.executedWork.entries()]);
  }

  private async completeWork(workId: string, status: 'completed' | 'failed', result: unknown, error?: string): Promise<void> {
    if (!this.identity) return;
    await this.post(`/api/remote/work/${encodeURIComponent(workId)}/complete`, {
      workId,
      status,
      ...(result === undefined ? {} : { result }),
      ...(error ? { error } : {}),
    }, this.identity.token);
  }

  /** Start heartbeating and pulling work. */
  start(): void {
    if (!this.identity) return;
    this.stop();
    void this.heartbeat();
    void this.pumpOnce();
    this.heartbeatTimer = setInterval(() => { void this.heartbeat(); }, this.options.heartbeatIntervalMs ?? 30_000);
    this.pullTimer = setInterval(() => { void this.pumpOnce(); }, this.options.pullIntervalMs ?? 2_000);
  }

  stop(): void {
    if (this.pullTimer) { clearInterval(this.pullTimer); this.pullTimer = null; }
    if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; }
  }
}
