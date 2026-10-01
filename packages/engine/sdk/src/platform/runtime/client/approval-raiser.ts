/**
 * approval-raiser.ts, how a permission ask leaves a surface that is a client.
 *
 * ── What changed ───────────────────────────────────────────────────────────
 *
 * A surface product used to construct its OWN `ApprovalBroker`, and every ask
 * went into it: raised in-process, prompted at that surface, decided there,
 * stored there. When the surface also hosted the daemon that was coherent. Once
 * the daemon is a separate process it is not, an ask raised there was invisible
 * to every other surface, to the daemon's attention machinery, and to the phone
 * that was supposed to be able to answer it.
 *
 * So the ask goes to the daemon (`approvals.raise`) AND prompts locally, and the
 * first real answer wins. The daemon owns the record; the surface is one
 * participant that happens to be sitting in front of the user.
 *
 * ── The shape, precisely ───────────────────────────────────────────────────
 *
 * 1. Raise the ask on the daemon. The verb returns the pending record
 *    immediately, it deliberately does not park an HTTP request across a
 *    person's attention span.
 * 2. Prompt locally at the same time.
 * 3. Watch the raised id for a decision made elsewhere. The channel for that is
 *    `control.approval_update`, which carries every transition of the record the
 *    moment the broker records it, so a decision made on a phone reaches this
 *    surface in the time one SSE frame takes, not in the time one poll interval
 *    takes. A product wires the stream in through `subscribeApprovalUpdates`.
 *
 *    Polling `approvals.list` remains as the FALLBACK, and it is a real one, not
 *    a formality: a client with no stream seam wired, or one whose stream the
 *    daemon refused, still gets its answer. There is also one read immediately
 *    after subscribing, because a decision can land between the raise and the
 *    subscription and a push channel cannot deliver what happened before it
 *    opened.
 * 4. Whichever answers first is the decision. If the local prompt answered, the
 *    daemon is TOLD (`approvals.approve`/`approvals.deny`) so its record, the
 *    one every other surface reads, matches what happened here.
 *
 * ── When the daemon is not reachable ───────────────────────────────────────
 *
 * The ask is prompted locally and answered locally, and that is the honest
 * outcome: a user in front of a surface can still approve their own tool call
 * with no daemon running. Nothing is silently swallowed and nothing pretends a
 * remote record exists. The refusal reason is logged once per process so a
 * misconfigured control plane is visible without a line per ask.
 *
 * ── Consumer lifetime ─────────────────────────────────────────────────────
 *
 * A remote decision resolves the ask; the prompt this surface already drew stays
 * on screen until the user dismisses it, and its answer is ignored (the decision
 * has been taken). This mirrors what the in-process broker did with a
 * `localPrompt` racing a wire decision, there is no cancel channel into a drawn
 * prompt. A consumer abort is forwarded as optional execution options to the
 * local renderer, ends this caller's wait and closes its observations. Late
 * prompt answers are ignored. The daemon's wire-owned record is not cancelled:
 * retiring one remote consumer safely needs a separate ownership protocol.
 */
import { logger, summarizeError } from '../../utils/index.js';
import { assertPermissionActive, awaitPermission } from '../../permissions/cancellation.js';
import type { PermissionExecutionOptions, PermissionPromptDecision, PermissionPromptRequest } from '../../permissions/prompt.js';
import type { ApprovalRaiser } from '../permissions/permission-composition.js';
import type { DaemonVerbCaller } from './daemon-verbs.js';
import type { ApprovalUpdateNotice, ApprovalUpdateSubscription } from './approval-updates.js';

/**
 * How this surface opens the approval-update stream. A product supplies it
 * because resolving a base URL and proving this surface may subscribe are
 * trust-boundary concerns the SDK core deliberately never reaches into, the
 * same carve-out `DaemonVerbCaller` records.
 *
 * Returning null means "no stream right now", which is a supported answer:
 * the raiser falls back to reading the record on an interval.
 */
export type ApprovalUpdateSubscriber = (
  onUpdate: (notice: ApprovalUpdateNotice) => void,
) => Promise<ApprovalUpdateSubscription | null>;

/** The local ask: draw a prompt on this surface and resolve with what the user chose. */
export type LocalPermissionPrompt = (request: PermissionPromptRequest, options?: PermissionExecutionOptions) => Promise<PermissionPromptDecision>;

/** How often the raised id is re-read while the local prompt is open. */
const DEFAULT_POLL_INTERVAL_MS = 750;

export interface ClientApprovalRaiserOptions {
  readonly verbs: DaemonVerbCaller;
  /** The prompt this surface draws. Late-bound: the UI layer patches it in after boot. */
  readonly localPrompt: () => LocalPermissionPrompt;
  /**
   * How this surface names itself when it reports its own decision back. The
   * daemon records it on the approval, so every other surface can see WHERE the
   * answer came from; there is no honest default, so each product states its own.
   */
  readonly actor: string;
  /** The live session id an ask belongs to, when there is one. */
  readonly sessionId?: () => string | null | undefined;
  /**
   * The push channel for decisions made elsewhere. Omitted ⇒ this surface
   * reads the record on an interval instead, which still works and is slower.
   */
  readonly subscribeApprovalUpdates?: ApprovalUpdateSubscriber | undefined;
  /** Poll interval override (tests), and the fallback interval. */
  readonly pollIntervalMs?: number;
  /** Injectable sleep (tests). */
  readonly sleep?: (ms: number) => Promise<void>;
}

interface RaisedRecord {
  readonly id: string;
  readonly status?: string | undefined;
  readonly decision?: {
    readonly approved?: boolean | undefined;
    readonly remember?: boolean | undefined;
    readonly note?: string | undefined;
  } | undefined;
}

/** A record the daemon considers answered, mapped to the decision this surface returns. */
function readRemoteDecision(record: RaisedRecord | null | undefined): PermissionPromptDecision | null {
  if (!record) return null;
  const status = record.status;
  if (status === 'approved') return { approved: true, remember: record.decision?.remember === true };
  if (status === 'denied' || status === 'expired' || status === 'cancelled') {
    return { approved: false, remember: record.decision?.remember === true };
  }
  return null;
}

let unreachableLogged = false;

/** Own the decision fields before checking whether a borrowed callback cancelled. */
function localDecisionSnapshot(decision: PermissionPromptDecision): PermissionPromptDecision {
  const { approved, remember, rememberTier, reason, modifiedArgs } = decision;
  return {
    approved,
    ...(remember === undefined ? {} : { remember }),
    ...(rememberTier === undefined ? {} : { rememberTier }),
    ...(reason === undefined ? {} : { reason }),
    ...(modifiedArgs === undefined ? {} : { modifiedArgs }),
  };
}

export function createClientApprovalRaiser(options: ClientApprovalRaiserOptions): ApprovalRaiser {
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const sleep = async (ms: number, signal: AbortSignal): Promise<void> => {
    if (options.sleep) return awaitPermission(() => options.sleep!(ms), signal);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await awaitPermission(() => new Promise<void>((resolve) => {
        timer = setTimeout(resolve, ms); timer.unref?.();
      }), signal);
    } finally { if (timer !== undefined) clearTimeout(timer); }
  };

  const raiseOnDaemon = async (input: {
    request: PermissionPromptRequest;
    routeId?: string | undefined;
    metadata?: Record<string, unknown> | undefined;
  }): Promise<string | null> => {
    const probe = options.verbs.probe();
    if (!probe.available) {
      if (!unreachableLogged) {
        unreachableLogged = true;
        logger.info(`[approvals] asks are answered on this surface only: ${probe.reason}`);
      }
      return null;
    }
    const sessionId = options.sessionId?.() ?? undefined;
    try {
      const raised = await options.verbs.invoke<{ approval?: RaisedRecord }>('approvals.raise', {
        request: input.request,
        ...(sessionId ? { sessionId } : {}),
        ...(input.routeId === undefined ? {} : { routeId: input.routeId }),
        ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
      });
      return raised?.approval?.id ?? null;
    } catch (error) {
      logger.warn('[approvals] raising the ask on the daemon failed; prompting locally only', { error: summarizeError(error) });
      return null;
    }
  };

  const readRaised = async (approvalId: string, signal: AbortSignal): Promise<RaisedRecord | null> => {
    try {
      const listed = await awaitPermission(() => options.verbs.invoke<unknown>('approvals.list', { includeResolved: true }), signal);
      const records: readonly RaisedRecord[] = Array.isArray(listed)
        ? listed as readonly RaisedRecord[]
        : ((listed as { approvals?: readonly RaisedRecord[] } | null)?.approvals ?? []);
      return records.find((entry) => entry.id === approvalId) ?? null;
    } catch (error) {
      assertPermissionActive(signal);
      logger.debug('[approvals] reading the raised ask back failed', { error: summarizeError(error) });
      return null;
    }
  };

  /** The fallback: read the record back on an interval until it is answered. */
  const pollRemote = async (approvalId: string, done: () => boolean, signal: AbortSignal): Promise<PermissionPromptDecision | null> => {
    while (!done()) {
      await sleep(pollIntervalMs, signal);
      if (done()) return null;
      const decision = readRemoteDecision(await readRaised(approvalId, signal));
      if (decision) return decision;
    }
    return null;
  };

  /**
   * The push path: subscribe, then read once to close the gap between the raise
   * and the subscription, then wait for the frame that decides this id.
   *
   * Resolves null when the local prompt won, when the stream ended without a
   * decision, or when no stream could be opened, the caller falls back.
   */
  const watchRemoteOverStream = async (
    subscribe: ApprovalUpdateSubscriber,
    approvalId: string,
    done: () => boolean,
    signal: AbortSignal,
  ): Promise<{ readonly subscribed: boolean; readonly decision: PermissionPromptDecision | null }> => {
    let settle: ((decision: PermissionPromptDecision | null) => void) | null = null;
    const decided = new Promise<PermissionPromptDecision | null>((resolve) => { settle = resolve; });
    let subscription: ApprovalUpdateSubscription | null = null;
    let closed = false;
    const closeFailed = (): void => {
      // Cleanup diagnostics must not create another unhandled cleanup failure.
      try { logger.warn('[approvals] closing this approval observation failed'); } catch { /* best effort */ }
    };
    const close = (): void => {
      if (subscription && !closed) {
        closed = true;
        // A void callback may have an async implementation. Own both forms of
        // failure without waiting on or retrying borrowed disposal.
        try { void Promise.resolve(subscription.close()).then(undefined, closeFailed); }
        catch { closeFailed(); }
      }
    };
    signal.addEventListener('abort', close, { once: true });
    try {
      const opening = Promise.resolve().then(() => {
        assertPermissionActive(signal);
        return subscribe((notice) => {
          if (notice.approval.id !== approvalId) return;
          if (signal.aborted || done()) { settle?.(null); return; }
          const decision = readRemoteDecision(notice.approval);
          if (decision) settle?.(decision);
        });
      });
      // Keep ownership even if cancellation wins before acquisition completes.
      // The same close function covers the narrow handoff between promise jobs.
      void opening.then((acquired) => {
        subscription = acquired;
        if (signal.aborted) close();
      }, () => {});
      try {
        await awaitPermission(() => opening, signal);
      } catch (error) {
        assertPermissionActive(signal);
        logger.debug('[approvals] opening the approval-update stream failed; reading the record instead', { error: summarizeError(error) });
        return { subscribed: false, decision: null };
      }
      if (!subscription) return { subscribed: false, decision: null };
      const alreadyDecided = readRemoteDecision(await readRaised(approvalId, signal));
      if (alreadyDecided) return { subscribed: true, decision: alreadyDecided };
      if (done()) return { subscribed: true, decision: null };
      return { subscribed: true, decision: await awaitPermission(() => decided, signal) };
    } finally {
      signal.removeEventListener('abort', close);
      close();
    }
  };

  /** Resolve when the daemon's record for this id is answered. Never rejects. */
  const watchRemote = async (approvalId: string, done: () => boolean, signal: AbortSignal): Promise<PermissionPromptDecision | null> => {
    const subscribe = options.subscribeApprovalUpdates;
    if (subscribe) {
      const pushed = await watchRemoteOverStream(subscribe, approvalId, done, signal);
      if (pushed.subscribed) return pushed.decision;
    }
    return await pollRemote(approvalId, done, signal);
  };

  /** Tell the daemon what this surface decided, so its record is the truth. */
  const reportLocalDecision = async (approvalId: string, decision: PermissionPromptDecision, signal?: AbortSignal): Promise<void> => {
    try {
      const method = decision.approved ? 'approvals.approve' : 'approvals.deny';
      const input = {
        approvalId,
        actor: options.actor,
        actorSurface: options.actor,
        ...(decision.remember ? { remember: true } : {}),
      };
      assertPermissionActive(signal);
      await options.verbs.invoke(method, input);
    } catch (error) {
      if (signal?.aborted) return;
      // The user has already been served; a failed write-back is a
      // record-consistency problem, not a reason to re-ask them.
      logger.warn('[approvals] recording this surface\'s decision on the daemon failed', {
        approvalId,
        error: summarizeError(error),
      });
    }
  };

  return async (input) => {
    const signal = input.signal;
    assertPermissionActive(signal);
    const observations = new AbortController();
    const abort = (): void => observations.abort();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    let settled = false;
    try {
      const approvalId = await awaitPermission(() => raiseOnDaemon(input), signal);
      assertPermissionActive(signal);
      const prompt = options.localPrompt();
      const askLocal = (): Promise<PermissionPromptDecision> => awaitPermission(async () => {
        const decision = await prompt(input.request, { signal });
        assertPermissionActive(signal);
        return localDecisionSnapshot(decision);
      }, signal);
      if (approvalId === null) return await askLocal();

      const local = askLocal().then((decision) => {
        settled = true;
        return { source: 'local' as const, decision };
      });
      const remote = watchRemote(approvalId, () => settled, observations.signal).then((decision) => {
        if (decision) settled = true;
        return decision ? { source: 'remote' as const, decision } : null;
      });
      const winner = await awaitPermission(() => Promise.race([
        local,
        remote.then(async (result) => result ?? await local),
      ]), signal);
      assertPermissionActive(signal);
      if (winner.source === 'local') void reportLocalDecision(approvalId, winner.decision, signal);
      return winner.decision;
    } finally {
      settled = true;
      observations.abort();
      signal?.removeEventListener('abort', abort);
    }
  };
}
