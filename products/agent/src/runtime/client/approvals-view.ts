/**
 * approvals-view.ts, what this surface shows when it shows approvals.
 *
 * ── The problem this solves ────────────────────────────────────────────────
 *
 * An ask raised on this surface no longer stops in this process. It is posted
 * to the adopted daemon (`approvals.raise`) and prompted here, and the daemon's
 * record is the one every surface sees, that is the whole point of the parity
 * contract: the phone, the web UI and this terminal are looking at ONE list.
 *
 * The local `ApprovalBroker` was left rendering the panel, and after the split
 * it holds only what still arrives in-process: asks handed over by the
 * distributed-runtime bridge. So the panel had become a partial view that
 * looked total. An owner with three asks waiting on the daemon read "no
 * pending approvals" and believed it.
 *
 * ── What this does ─────────────────────────────────────────────────────────
 *
 * Reads `approvals.list` over the verb caller and UNIONS it with whatever the
 * local broker still legitimately holds. Neither side is dropped: the daemon's
 * record is canonical for anything both know about, and a bridge-delivered ask
 * the daemon has not been told about still shows.
 *
 * ── How transitions arrive ─────────────────────────────────────────────────
 *
 * The daemon publishes every transition of every ask, raised, claimed,
 * approved, denied, cancelled, expired, on `control.approval_update`, with the
 * whole record in the frame. This view consumes that stream, so an ask raised
 * on a phone appears here the moment the daemon records it and a decision made
 * elsewhere clears it just as fast. The 15-second re-read this panel used to
 * live on is retained UNDERNEATH as the fallback: the stream can be refused (no
 * daemon, a 401, a proxy that will not hold a connection) and it can drop, and
 * a permission ask is not something to be blind about. Without a stream the
 * panel polls exactly as it always did, and each poll tick also retries the
 * stream, that retry is the entire reconnect story. `liveUpdates` on the
 * snapshot says which of the two modes is in force, because "as of now" and "as
 * of up to fifteen seconds ago" are different claims.
 *
 * ── Honest degrade ─────────────────────────────────────────────────────────
 *
 * The one thing this must never do is render an empty list when the truth is
 * "nobody could be asked". An empty list and an unreachable daemon look
 * identical on screen and mean opposite things, so a snapshot carries the
 * reason as a value: `hostRecordRead` says whether the daemon's list was
 * actually read, and `unavailableReason` names what stopped it, a daemon
 * turned off in settings, a missing operator token, a 404 from a host that has
 * not wired the verb, a connection refused. The reason is the verb layer's own
 * words (see daemon-verbs.ts: refusals are values, failures are throws), not a
 * sentence invented here.
 *
 * The local rows still render while the host is unreadable. They are real asks;
 * hiding them would trade one dishonesty for another. What the caller must show
 * alongside them is {@link describeApprovalsUnavailable}.
 */
import type { SharedApprovalRecord } from '@goodvibes-jev/engine/sdk/platform/control-plane';
import type {
  ApprovalUpdateNotice,
  ApprovalUpdateSubscription,
  DaemonVerbCaller,
} from '@goodvibes-jev/engine/sdk/platform/runtime/client';
import { describeConnectedHostVerbError } from './daemon-verbs.ts';

/** The `approvals.list` reply shape this reads; the verb returns more. */
interface ApprovalsListReply {
  readonly approvals?: unknown;
}

export interface ApprovalsPanelSnapshot {
  /** The daemon's record unioned with the local broker's, daemon rows first. */
  readonly approvals: readonly SharedApprovalRecord[];
  /** True only when the daemon's own list was actually read on the last refresh. */
  readonly hostRecordRead: boolean;
  /**
   * Why the daemon's record could not be read, in the verb layer's own words.
   * `null` exactly when {@link hostRecordRead} is true.
   */
  readonly unavailableReason: string | null;
  /** How many of {@link approvals} came from the local broker rather than the host. */
  readonly localOnlyCount: number;
  /**
   * True while `control.approval_update` is open and feeding this view, so an
   * ask raised anywhere appears here the moment the daemon records it. False
   * means the panel is on its periodic re-read instead, and a transition can be
   * up to one interval old, a real difference the panel is allowed to say.
   */
  readonly liveUpdates: boolean;
}

export interface ApprovalsView {
  /** The last refreshed snapshot. Never blocks; never lies about staleness. */
  snapshot(): ApprovalsPanelSnapshot;
  /** Re-read the daemon's record now, and return the resulting snapshot. */
  refresh(): Promise<ApprovalsPanelSnapshot>;
  /** Begin refreshing on a cadence. Idempotent; the timer is unref'd. */
  start(): void;
  /** Stop the cadence. Idempotent. */
  stop(): void;
}

export interface ApprovalsViewOptions {
  readonly verbs: DaemonVerbCaller;
  /**
   * The in-process broker. Still a real source: the distributed-runtime bridge
   * hands asks to it, and those exist nowhere else.
   */
  readonly localBroker: { listApprovals(limit?: number): readonly SharedApprovalRecord[] };
  /** Cadence for {@link ApprovalsView.start} while there is no push stream. Default 15s. */
  readonly refreshIntervalMs?: number | undefined;
  /**
   * Cadence while the push stream IS open. Default 2 minutes: the stream
   * carries every transition, so this is a reconciliation against the daemon's
   * list rather than the way transitions arrive.
   */
  readonly liveRefreshIntervalMs?: number | undefined;
  /**
   * Open the `control.approval_update` stream. Supplied by the composition
   * (which owns host resolution and the token); omitted, the view simply polls,
   * which is what it did before push existed.
   *
   * Resolving to null means the stream could not be opened, a value, not a
   * throw, exactly as {@link watchApprovalUpdates} reports it. The view keeps
   * polling and says so in its snapshot.
   */
  readonly subscribe?: ((handlers: {
    readonly onUpdate: (notice: ApprovalUpdateNotice) => void;
    readonly onTerminate: (error: unknown) => void;
  }) => Promise<ApprovalUpdateSubscription | null>) | undefined;
}

const DEFAULT_REFRESH_INTERVAL_MS = 15_000;
const DEFAULT_LIVE_REFRESH_INTERVAL_MS = 120_000;

/**
 * The statuses that keep an ask on the panel.
 *
 * `claimed` counts: another surface is answering it, and hiding it would make
 * the ask look answered before anyone decided anything.
 */
const WAITING_STATUSES: ReadonlySet<string> = new Set(['pending', 'claimed']);

/**
 * Apply one pushed transition to the host rows this view holds.
 *
 * The frame carries the whole record, so this is the application of the
 * daemon's own record rather than a local guess: an ask that is still waiting
 * is inserted or replaced in place, and one that has been decided, cancelled or
 * expired leaves. Exported because this rule is the interesting part of push
 * and is worth driving directly.
 */
export function applyApprovalUpdate(
  rows: readonly SharedApprovalRecord[],
  record: SharedApprovalRecord,
): readonly SharedApprovalRecord[] {
  const withoutIt = rows.filter((row) => row.id !== record.id);
  if (!WAITING_STATUSES.has(record.status)) return withoutIt;
  const index = rows.findIndex((row) => row.id === record.id);
  if (index < 0) return [...rows, record];
  const next = [...rows];
  next[index] = record;
  return next;
}

function isApprovalRecord(value: unknown): value is SharedApprovalRecord {
  if (!value || typeof value !== 'object') return false;
  const row = value as { id?: unknown; status?: unknown };
  return typeof row.id === 'string' && row.id.length > 0 && typeof row.status === 'string';
}

/**
 * The daemon's coalescing identity for an ask: one session, one tool call.
 *
 * Used only as a SECOND dedupe key, after id. An ask this surface raised is
 * recorded on the daemon under the daemon's id, and the bridge may hand the
 * same ask to the local broker under a different one; counting it twice would
 * tell the owner two people are waiting on one question.
 */
function coalescingKey(record: SharedApprovalRecord): string | null {
  const sessionId = typeof record.sessionId === 'string' ? record.sessionId : '';
  const callId = typeof record.callId === 'string' ? record.callId : '';
  if (callId.length === 0) return null;
  return `${sessionId} ${callId}`;
}

/**
 * Daemon rows, then the local rows neither key already covers.
 *
 * Exported for the suite: the union rule is the interesting part and is worth
 * driving directly rather than only through a live view.
 */
export function unionApprovalRecords(
  hostRecords: readonly SharedApprovalRecord[],
  localRecords: readonly SharedApprovalRecord[],
): { readonly approvals: readonly SharedApprovalRecord[]; readonly localOnlyCount: number } {
  const seenIds = new Set<string>();
  const seenCalls = new Set<string>();
  const approvals: SharedApprovalRecord[] = [];

  for (const record of hostRecords) {
    if (seenIds.has(record.id)) continue;
    seenIds.add(record.id);
    const key = coalescingKey(record);
    if (key !== null) seenCalls.add(key);
    approvals.push(record);
  }

  let localOnlyCount = 0;
  for (const record of localRecords) {
    if (seenIds.has(record.id)) continue;
    const key = coalescingKey(record);
    if (key !== null && seenCalls.has(key)) continue;
    seenIds.add(record.id);
    if (key !== null) seenCalls.add(key);
    approvals.push(record);
    localOnlyCount += 1;
  }

  return { approvals, localOnlyCount };
}

/**
 * The one line a surface prints when the daemon's record could not be read.
 *
 * Returns null when it WAS read, there is nothing to disclose then, and a
 * caller that prints unconditionally would train the owner to ignore it.
 */
export function describeApprovalsUnavailable(snapshot: ApprovalsPanelSnapshot): string | null {
  if (snapshot.hostRecordRead) return null;
  const reason = snapshot.unavailableReason ?? 'the reason was not reported.';
  const held = snapshot.approvals.length;
  const shown = held === 0
    ? 'Nothing is shown below, and that is not the same as nothing waiting.'
    : held === 1
      ? '1 ask raised in this process is shown below; anything waiting on the host is not.'
      : `${held} asks raised in this process are shown below; anything waiting on the host is not.`;
  return `Approvals on the connected host could not be read: ${reason} ${shown}`;
}

export function createApprovalsView(options: ApprovalsViewOptions): ApprovalsView {
  const pollIntervalMs = options.refreshIntervalMs ?? DEFAULT_REFRESH_INTERVAL_MS;
  const liveIntervalMs = options.liveRefreshIntervalMs ?? DEFAULT_LIVE_REFRESH_INTERVAL_MS;
  let timer: ReturnType<typeof setInterval> | null = null;
  let inFlight: Promise<ApprovalsPanelSnapshot> | null = null;
  let started = false;
  let subscription: ApprovalUpdateSubscription | null = null;
  let opening: Promise<void> | null = null;
  let liveUpdates = false;

  const build = (
    hostRecords: readonly SharedApprovalRecord[],
    unavailableReason: string | null,
  ): ApprovalsPanelSnapshot => {
    const { approvals, localOnlyCount } = unionApprovalRecords(hostRecords, options.localBroker.listApprovals());
    return {
      approvals,
      hostRecordRead: unavailableReason === null,
      unavailableReason,
      localOnlyCount,
      liveUpdates,
    };
  };

  // Before the first read, the honest posture is "the host's record has not
  // been read yet", not "the host is fine and there is nothing pending". The
  // host half is kept as its own value rather than sliced back out of the
  // union, so `snapshot()` can rebuild against a broker that changed since the
  // last round trip without guessing which rows came from where.
  let hostRows: readonly SharedApprovalRecord[] = [];
  let hostReason: string | null = 'the connected host has not been read yet.';

  const readHost = async (): Promise<{
    readonly rows: readonly SharedApprovalRecord[];
    readonly reason: string | null;
  }> => {
    const reachability = options.verbs.probe();
    if (!reachability.available) {
      return { rows: [], reason: reachability.reason ?? 'no connected host could be resolved.' };
    }
    try {
      const reply = await options.verbs.invoke<ApprovalsListReply>('approvals.list');
      const rows = Array.isArray(reply?.approvals) ? reply.approvals : [];
      // A reply whose shape this build does not recognise is a real answer
      // about the host, not an empty list: report it rather than render zero.
      const records = rows.filter(isApprovalRecord);
      if (records.length !== rows.length) {
        return {
          rows: records,
          reason: `the connected host returned ${rows.length - records.length} approval row(s) this build could not read.`,
        };
      }
      return { rows: records, reason: null };
    } catch (error) {
      return { rows: [], reason: describeConnectedHostVerbError(error) };
    }
  };

  const refresh = (): Promise<ApprovalsPanelSnapshot> => {
    // Single-flight: the cadence and an on-demand read must not stack two
    // requests whose replies could land out of order and swap the snapshot back.
    if (inFlight) return inFlight;
    inFlight = readHost()
      .then(({ rows, reason }) => {
        hostRows = rows;
        hostReason = reason;
        return build(hostRows, hostReason);
      })
      .finally(() => { inFlight = null; });
    return inFlight;
  };

  // The timer runs at whichever cadence matches the current mode. Re-armed
  // whenever the mode changes, so adopting push actually relaxes the polling
  // rather than leaving both running at the old rate.
  const armTimer = (): void => {
    if (!started) return;
    if (timer !== null) clearInterval(timer);
    timer = setInterval(() => { void tick(); }, liveUpdates ? liveIntervalMs : pollIntervalMs);
    timer.unref?.();
  };

  /**
   * One periodic pass: re-read the daemon's list, and, while push is not
   * carrying transitions, try to open the stream again. That retry is the
   * whole reconnect story: a stream that dropped or was refused at boot is
   * re-attempted on the cadence the panel is already running, with no separate
   * backoff state machine to get wrong.
   */
  const tick = (): void => {
    void refresh();
    if (!liveUpdates) void openStream();
  };

  const openStream = (): Promise<void> => {
    if (!options.subscribe || subscription !== null || opening !== null || !started) return Promise.resolve();
    opening = options.subscribe({
      onUpdate: (notice) => {
        const record = notice.approval as unknown;
        if (!isApprovalRecord(record)) return;
        // The frame carries the daemon's whole record, so the panel advances
        // without a follow-up read: an ask appears the moment it is raised and
        // leaves the moment anyone decides it, on any surface.
        hostRows = applyApprovalUpdate(hostRows, record);
        // A transition arriving IS a successful read of the daemon's record,
        // so a view whose first poll had failed stops claiming it is blind.
        hostReason = null;
      },
      onTerminate: () => {
        subscription = null;
        if (!liveUpdates) return;
        liveUpdates = false;
        // Back to the 15s re-read, which is the behavior this view had before
        // push existed. Nothing is lost; transitions are just up to an interval
        // old again until the next tick reopens the stream.
        armTimer();
      },
    })
      .then((opened) => {
        // A stop() that landed while the stream was still opening must still
        // close it: the subscription exists on the daemon by then, and dropping
        // the handle would leave this process holding an event stream nothing
        // reads until the process exits.
        if (!started) {
          opened?.close();
          return;
        }
        subscription = opened;
        if (opened === null || liveUpdates) return;
        liveUpdates = true;
        armTimer();
      })
      .catch(() => {
        // `subscribe` is documented to report failure as null rather than throw;
        // a caller that throws anyway leaves the view polling, which is the same
        // honest degrade.
        subscription = null;
      })
      .finally(() => { opening = null; });
    return opening;
  };

  return {
    // Rebuilt on every read so a broker change between refreshes shows without
    // waiting for the next host round trip; the host half is whatever the last
    // refresh established, including its reason.
    snapshot: (): ApprovalsPanelSnapshot => build(hostRows, hostReason),
    refresh,
    start: (): void => {
      if (started) return;
      started = true;
      void refresh();
      // Push first, poll underneath it. The stream is the fast path and the
      // poll is what happens when there is no stream, neither one waits on
      // the other to be established.
      void openStream();
      armTimer();
    },
    stop: (): void => {
      started = false;
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
      subscription?.close();
      subscription = null;
      liveUpdates = false;
    },
  };
}
