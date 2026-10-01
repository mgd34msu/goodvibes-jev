/**
 * resume-notice.ts, the boot-time "previous session found" transcript notice.
 *
 * item 1: a supervision-journey audit of 1.7.0 found that the TUI
 * accumulates rich resumable state on disk (a saved conversation, workspace
 * checkpoints, contract history) but never surfaces any of it at startup,
 * an operator has no way to know it exists short of already knowing the
 * right command. This module builds ONE compact, honest system-message block
 * printed after the splash and before the first prompt, summarizing exactly
 * what real state exists and how to reach it.
 *
 * Honesty constraints (verified against the actual runtime, not assumed):
 *   - `/resume` and `/sessions` both exist and both work: `/resume`
 *     (session.ts) opens a zero-typing picker over saved sessions when
 *     called bare, and resumes directly when given an id/name; `/sessions`
 *     (session-content.ts) forwards a `resume <id>` subcommand to the same
 *     `/session resume` path. All three spellings, `/resume <id>`,
 *     `/session resume <id>`, `/sessions resume <id>`, reach the identical
 *     resume routine. This notice leads with the zero-typing picker
 *     (`/resume`) and keeps the direct, exact-id form (`/session resume
 *     <id>`) as a secondary hint, for the case of already knowing which
 *     session to reach for.
 *   - `/checkpoints` works with zero arguments and behaves correctly at any
 *     checkpoint count (including zero), advertised whenever the checkpoint
 *     manager is available in this session.
 *   - `/recall` (memory) is only advertised when the memory API is actually
 *     wired up in this session (context.clients?.knowledgeApi?.memory),
 *     some runtimes don't have it, and claiming it works there would not be
 *     honest.
 *   - Every clause is independently gated on real data: a claim about
 *     checkpoints/chain history is only made when that data is known; "no
 *     chain history" means no chain clause is printed, not a fabricated one.
 *   - A live crash-recovery snapshot is NOT this notice's business any more.
 *     It used to get a clause here, which meant an operator's only route back
 *     to a crashed session was reading a sentence and retyping a command. It
 *     is now an explicit ask-then-retire modal raised right after first
 *     render, see runtime/recovery-prompt.ts. Keeping a passive clause here
 *     as well would announce the same snapshot twice.
 */

import { readLastSessionPointer } from '@goodvibes-jev/engine/sdk/platform/runtime/operations';
import type { SessionSurface } from '@goodvibes-jev/engine/sdk/platform/runtime/operations';
import type { ContractView } from '@goodvibes-jev/engine/sdk/platform/contract';
import type { SessionManager } from '@goodvibes-jev/engine/sdk/platform/sessions';
import type { WorkspaceCheckpointManager } from '@goodvibes-jev/engine/sdk/platform/workspace';
import type { SystemMessageRouter } from '../core/system-message-router.ts';

/** Recorded lifecycle outcomes are authoritative; active persisted work is resumable. */
export type ContractOutcome = 'passed' | 'failed' | 'cancelled' | 'interrupted';

export function describeContractOutcome(contract: Pick<ContractView, 'status'>): ContractOutcome {
  return contract.status === 'passed' || contract.status === 'failed' || contract.status === 'cancelled'
    ? contract.status
    : 'interrupted';
}

/** Pick the most recently completed (or, if still interrupted, most recently created) chain from a set. Null if the set is empty. */
export function mostRecentContract(chains: readonly ContractView[]): ContractView | null {
  if (chains.length === 0) return null;
  return [...chains].sort((a, b) => (b.completedAt ?? b.createdAt ?? 0) - (a.completedAt ?? a.createdAt ?? 0))[0]!;
}

// ─── Notice text ─────────────────────────────────────────────────────────────

export interface ResumeNoticeFacts {
  /** Number of user turns in the last saved session. Null when there is no prior session (or it could not be read). */
  readonly turnCount: number | null;
  /** Session id of the last saved session, needed to build a truthful, directly-runnable resume hint. Null when there is no prior session. */
  readonly lastSessionId: string | null;
  /** Number of workspace checkpoints. Null when the checkpoint manager is unavailable in this session (not the same as zero). */
  readonly checkpointCount: number | null;
  /** Outcome of the most recently known contract. Null when there is no chain history at all. */
  readonly lastContractOutcome: ContractOutcome | null;
  /** Whether /recall (memory) is wired up in this session. */
  readonly memoryAvailable: boolean;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/**
 * Build the boot resume notice text, or null when there is nothing to
 * report (no prior session, no checkpoints ever taken, no chain history,
 * a clean/new working directory prints nothing, respecting quiet startup).
 */
export function buildResumeNotice(facts: ResumeNoticeFacts): string | null {
  const hasSession = facts.lastSessionId !== null && facts.turnCount !== null;
  const checkpointsKnown = facts.checkpointCount !== null;
  const checkpointCount = facts.checkpointCount ?? 0;
  const hasCheckpoints = checkpointsKnown && checkpointCount > 0;
  const hasChainHistory = facts.lastContractOutcome !== null;

  if (!hasSession && !hasCheckpoints && !hasChainHistory) return null;

  const summary: string[] = [];
  if (hasSession) summary.push(plural(facts.turnCount!, 'turn'));
  // Show the checkpoint count whenever it's knowable and there's a reason to
  // (anchored to an existing session, or checkpoints genuinely exist even
  // without one), never guessed when the manager is unavailable.
  if (checkpointsKnown && (hasSession || hasCheckpoints)) summary.push(plural(checkpointCount, 'checkpoint'));
  if (hasChainHistory) summary.push(`last workstream: ${facts.lastContractOutcome}`);

  const lead = hasSession ? 'Previous session found' : 'Workspace history found';
  let notice = `${lead}: ${summary.join(', ')}`;

  const hints: string[] = [];
  // Lead with the zero-typing picker (/resume), keep the direct exact-id
  // form as a secondary hint, see the header doc for why both are honest.
  if (hasSession) hints.push(`/resume to continue (or /session resume ${facts.lastSessionId} directly)`);
  if (hasCheckpoints) hints.push('/checkpoints to browse');
  if (facts.memoryAvailable) hints.push('/recall for memory');
  if (hints.length > 0) notice += `: ${hints.join(' · ')}`;

  return notice;
}

// ─── Fact gathering (I/O) ────────────────────────────────────────────────────

export interface ResumeNoticeDeps {
  /** The app's declare-once session-storage handle, the same one the runtime writes the pointer through. */
  readonly surface: SessionSurface;
  /** Only `load()` is needed, kept narrow for testability. */
  readonly sessionManager: Pick<SessionManager, 'load'>;
  /** Undefined when checkpoints are not wired up in this session at all. Only `list()` is needed. */
  readonly checkpointManager: Pick<WorkspaceCheckpointManager, 'list'> | undefined;
  /** The full known-chain set from contractRunner.list, gathered after shared contract recovery. */
  readonly contractHistory: readonly ContractView[];
  readonly memoryAvailable: boolean;
  readonly router: Pick<SystemMessageRouter, 'high'>;
}

/**
 * Read the last session's real turn count from its saved JSONL file. A user
 * turn is one stored message with role 'user', the number of times the
 * operator spoke, which is what "N turns" means to a human reading the
 * notice (as opposed to a raw message count, which double-counts replies).
 * Returns null when there is no last-session pointer, or the pointed-to
 * session file is missing/corrupt, never a claim about a session that
 * cannot actually be resumed.
 */
function readLastSessionTurns(deps: Pick<ResumeNoticeDeps, 'surface' | 'sessionManager'>): { turnCount: number; lastSessionId: string } | null {
  const lastSessionId = readLastSessionPointer({ surface: deps.surface });
  if (!lastSessionId) return null;
  try {
    const { messages } = deps.sessionManager.load(lastSessionId);
    const turnCount = messages.filter((m) => (m as { role?: unknown }).role === 'user').length;
    return { turnCount, lastSessionId };
  } catch {
    // Pointer file present but the session it points to is gone/corrupt,
    // there is nothing truthful to resume.
    return null;
  }
}

async function readCheckpointCount(mgr: ResumeNoticeDeps['checkpointManager']): Promise<number | null> {
  if (!mgr) return null;
  try {
    return (await mgr.list()).length;
  } catch {
    // Checkpoint manager present but its cached init() rejection makes every
    // call fail forever (see services.ts), treat as "unknown", not zero.
    return null;
  }
}

/**
 * Gather real facts from disk/services and, if there is anything to report,
 * print ONE compact system message via `deps.router.high`. No-op (and no
 * message) when there is no prior session, no checkpoints, and no chain
 * history, a fresh working directory stays quiet. Nothing here ever mutates
 * the conversation: this is a report, not a restore.
 */
export async function announceResumeState(deps: ResumeNoticeDeps): Promise<void> {
  const session = readLastSessionTurns(deps);
  const checkpointCount = await readCheckpointCount(deps.checkpointManager);
  const lastChain = mostRecentContract(deps.contractHistory);

  const notice = buildResumeNotice({
    turnCount: session?.turnCount ?? null,
    lastSessionId: session?.lastSessionId ?? null,
    checkpointCount,
    lastContractOutcome: lastChain ? describeContractOutcome(lastChain) : null,
    memoryAvailable: deps.memoryAvailable,
  });

  if (notice) deps.router.high(notice);
}
