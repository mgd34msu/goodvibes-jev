/**
 * approval-store.ts, the persisted owner approvals a checkout spends.
 *
 * ── What this holds ───────────────────────────────────────────────────────
 *
 * `OwnerApproval` records the SDK's own factory minted (`grantOwnerApproval`,
 * platform/security/owner-approval.ts), one per purchase the owner has
 * approved and `payments.checkout.begin` has not yet consumed. The SDK's
 * `OwnerApprovalStore` keeps them in process memory, which is right for a
 * surface whose gesture and action share a process. This daemon's approve
 * verb and its begin verb are separate control-plane calls that may straddle
 * a daemon restart, so the records live in a file, the same convention every
 * other payments store here follows (`payments-cards.json` and friends,
 * composed by runtime/payments-composition.ts).
 *
 * ── The four properties, kept ─────────────────────────────────────────────
 *
 * The SDK's ruling names four properties and this store must not weaken any:
 *
 *  1. Owner-direct only: `grant` passes `surface: 'owner-direct'` from ITS
 *     OWN code path, never from an argument, so nothing a caller sends can
 *     name a different surface. The verb that calls `grant` is itself behind
 *     this daemon's confirmation gate (`assertConfirmed`, register.ts).
 *  2. Content-bound: the fingerprint is the SDK's, over the exact fields the
 *     owner approved, and `take` matches with `checkOwnerApproval`, never by
 *     action id alone.
 *  3. Short-lived: TTL is the SDK's `OWNER_APPROVAL_TTL_MS` (five minutes),
 *     not configurable through the wire, and expired records are swept on
 *     every access and at load.
 *  4. Single use: `take` removes what it returns, and the removal is
 *     persisted before the approval is handed back, so a taken approval
 *     cannot be respent after a restart. A persist that fails rolls the
 *     removal back and throws, leaving the approval intact rather than in a
 *     state where memory and disk disagree about whether it is spendable.
 *
 * ── Durability conventions ────────────────────────────────────────────────
 *
 * Same as `DurableBudgetLedger` (budget-store.ts): a missing file is the
 * ordinary first-boot case and starts empty silently; a file that exists but
 * cannot be parsed, or does not hold this store's shape, is data loss for a
 * store that authorizes spending, so it is logged as a warning naming the
 * file and the store starts empty; entries that fail the record checks are
 * dropped with a warning rather than trusted. Writes are atomic
 * (`atomicWriteFileSync`, mode 0600).
 */
import { existsSync, readFileSync } from 'node:fs';
import { atomicWriteFileSync } from '../../config/atomic-write.js';
import { logger } from '../../utils/logger.js';
import {
  checkOwnerApproval,
  grantOwnerApproval,
  type ApprovalMismatch,
  type OwnerApproval,
} from '../../security/owner-approval.js';

const APPROVALS_FILE_VERSION = 1;

/**
 * Bounded the way the SDK's own store is: a caller that mints without
 * spending must not grow the file without limit. The oldest grant is evicted
 * to make room, which is also the least spendable one, since TTLs expire in
 * grant order.
 */
const MAX_PENDING_APPROVALS = 16;

interface ApprovalsFile {
  readonly version: number;
  readonly approvals: readonly OwnerApproval[];
}

function isOwnerApproval(value: unknown): value is OwnerApproval {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record['action'] === 'string'
    && typeof record['grantedAt'] === 'string'
    && typeof record['expiresAt'] === 'string'
    && Number.isFinite(Date.parse(record['expiresAt'] as string))
    && record['surface'] === 'owner-direct'
    && (record['contentFingerprint'] === null || typeof record['contentFingerprint'] === 'string');
}

/** Read the persisted approvals, or an empty list for "start empty". */
function loadInitialApprovals(filePath: string): OwnerApproval[] {
  if (!existsSync(filePath)) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(filePath, 'utf-8'));
  } catch (error) {
    logger.warn(
      'Owner-approval file could not be read; starting with no pending approvals rather than guessing. '
      + 'Any approval granted before this must be granted again.',
      { filePath, error: error instanceof Error ? error.message : String(error) },
    );
    return [];
  }
  if (
    typeof parsed !== 'object'
    || parsed === null
    || !Array.isArray((parsed as Partial<ApprovalsFile>).approvals)
  ) {
    logger.warn(
      'Owner-approval file does not hold the expected shape; starting with no pending approvals rather than guessing.',
      { filePath },
    );
    return [];
  }
  const rows = (parsed as ApprovalsFile).approvals;
  const approvals = rows.filter(isOwnerApproval);
  if (approvals.length !== rows.length) {
    logger.warn(
      'Owner-approval file held entries that do not match the approval record shape; those entries were '
      + 'dropped rather than trusted.',
      { filePath },
    );
  }
  return approvals;
}

/** What `take` reports when nothing matched, so the refusal can say which way it missed. */
export interface ApprovalTakeMiss {
  readonly approval: null;
  readonly mismatch: ApprovalMismatch;
}

export interface ApprovalTakeHit {
  readonly approval: OwnerApproval;
}

/**
 * The persisted, single-use, content-bound approvals this daemon's checkout
 * spends. See the module header for the properties this must keep.
 */
export class DaemonApprovalStore {
  private approvals: OwnerApproval[];

  constructor(
    private readonly filePath: string,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.approvals = loadInitialApprovals(filePath);
    // Load-time sweep: an approval that expired while the daemon was down is
    // not spendable and not worth carrying. Quiet, and only writes when it
    // actually dropped something.
    if (this.sweep()) this.persist();
  }

  /**
   * Record an approval the owner has just given.
   *
   * `surface: 'owner-direct'` is supplied HERE, from the code path, which is
   * the property the SDK's factory exists to enforce; no argument of this
   * method can name a surface. Throws when the record cannot be persisted,
   * rolling the in-memory grant back first: an approval the disk never saw
   * must not be spendable from memory, or a restart changes what the owner
   * authorized.
   */
  grant(input: {
    readonly action: string;
    readonly content: Readonly<Record<string, string | undefined>>;
  }): OwnerApproval {
    this.sweep();
    const approval = grantOwnerApproval({
      action: input.action,
      surface: 'owner-direct',
      content: input.content,
      now: this.now,
    });
    // Unreachable through this class (the surface above is fixed), kept as a
    // thrown error rather than a narrowing cast so a future SDK change that
    // makes the factory refuse for a new reason fails loudly here.
    if (approval === null) throw new Error('grantOwnerApproval refused an owner-direct grant');
    const evicted = this.approvals.length >= MAX_PENDING_APPROVALS ? this.approvals.shift() : undefined;
    this.approvals.push(approval);
    try {
      this.persist();
    } catch (error) {
      this.approvals.pop();
      if (evicted) this.approvals.unshift(evicted);
      throw error;
    }
    if (evicted) {
      logger.warn(
        'Owner-approval store was full; the oldest pending approval was evicted to record this one.',
        { filePath: this.filePath, evictedAction: evicted.action, evictedGrantedAt: evicted.grantedAt },
      );
    }
    return approval;
  }

  /**
   * Spend the one approval matching this action and payload, if one is held.
   *
   * Removes what it returns, and persists the removal BEFORE returning, so a
   * spent approval is spent on disk too. A miss reports the closest mismatch
   * so the refusal can tell the owner whether to approve again (expired,
   * none) or to check what they approved (different content).
   */
  take(input: {
    readonly action: string;
    readonly content: Readonly<Record<string, string | undefined>>;
  }): ApprovalTakeHit | ApprovalTakeMiss {
    let closest: ApprovalMismatch = 'none';
    for (let index = 0; index < this.approvals.length; index += 1) {
      const candidate = this.approvals[index]!;
      const verdict = checkOwnerApproval({
        approval: candidate,
        action: input.action,
        contentInQuestion: input.content,
        // Deliberately `true` even though no taint finding is being cleared:
        // the SDK's check only compares the content fingerprint under this
        // flag (`checkOwnerApproval`, owner-approval.ts), and without the
        // comparison an unexpired approval authorizes by ACTION ID alone,
        // which is exactly the "matching on the verb, not on the deed"
        // failure the ruling names. Setting it also refuses the weak,
        // fingerprint-less form (`no-content-binding`), which this store
        // never mints but must not honor if one appears in the file.
        clearingContentTaint: true,
        now: this.now,
      });
      if (verdict.authorized) {
        this.approvals.splice(index, 1);
        try {
          this.persist();
        } catch (error) {
          this.approvals.splice(index, 0, candidate);
          throw error;
        }
        return { approval: candidate };
      }
      closest = closerMismatch(closest, verdict.mismatch);
    }
    // Swept AFTER matching, not before: an approval that expired must be
    // reported as `expired` (the owner approves again), not silently dropped
    // first and reported as `none` (the owner is told nothing was approved).
    // The sweep still runs on every miss, so expired records do not linger.
    if (this.sweep()) this.persist();
    return { approval: null, mismatch: closest };
  }

  /** Whether anything is currently spendable, for a status line or a test. */
  pendingCount(): number {
    this.sweep();
    return this.approvals.length;
  }

  /** Drop expired records. Returns true when it dropped any. */
  private sweep(): boolean {
    const nowMs = this.now().getTime();
    const before = this.approvals.length;
    this.approvals = this.approvals.filter((approval) => Date.parse(approval.expiresAt) > nowMs);
    return this.approvals.length !== before;
  }

  private persist(): void {
    const contents: ApprovalsFile = { version: APPROVALS_FILE_VERSION, approvals: this.approvals };
    atomicWriteFileSync(this.filePath, `${JSON.stringify(contents, null, 2)}\n`, { mode: 0o600, mkdirp: true });
  }
}

/**
 * Which mismatch is the more useful one to name, when several records each
 * missed differently. Content mismatches beat expiry beats wrong-action beats
 * nothing-held, because each earlier one implies the owner did something
 * closer to approving THIS purchase.
 */
function closerMismatch(current: ApprovalMismatch, candidate: ApprovalMismatch): ApprovalMismatch {
  const rank: Record<ApprovalMismatch, number> = {
    'none': 0,
    'different-action': 1,
    'expired': 2,
    'no-content-binding': 3,
    'different-content': 4,
  };
  return rank[candidate] > rank[current] ? candidate : current;
}
