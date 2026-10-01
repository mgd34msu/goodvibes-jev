/**
 * approvals.ts, tolerant readers + display helpers for approvals.* (existing
 * verb family; per-hunk selection lives in packages/sdk/src/platform/
 * control-plane/approval-hunk-apply.ts).
 *
 * Edit hunks are read DEFENSIVELY off `request.args.edits`, mirrors the SDK's
 * own `readApprovalEditHunks` (approval-hunk-apply.ts): a request whose args
 * are not edit-shaped (no `edits` array, empty, or any entry missing
 * path/find/replace) simply has no hunks to render, never a crash.
 *
 * PARITY CONTRACT: this module never computes a modified-edit result. It only
 * reads hunks for display and packages a selected-index array for
 * `approvals.approve`. The daemon (S3's moved `buildModifiedEditArgs`) is the
 * single source of the applied result, see goodvibes.ts's ApprovalApproveInput
 * doc and the ApprovalsTasksView component, which sends indices only.
 */

import type { ApprovalActionResult, ApprovalAttribution, ApprovalAuditRecord, ApprovalEditHunk, ApprovalRecord, ApprovalRememberOption, ApprovalStatus } from './goodvibes';

/** APPROVAL_STATUS_SCHEMA (operator-contract-schemas-runtime.ts) at time of writing. */
export const KNOWN_APPROVAL_STATUSES: readonly ApprovalStatus[] = [
  'pending',
  'claimed',
  'approved',
  'denied',
  'cancelled',
  'expired',
];

const TERMINAL_APPROVAL_STATUSES = new Set<ApprovalStatus>(['approved', 'denied', 'cancelled', 'expired']);

export function isTerminalApprovalStatus(status: ApprovalStatus): boolean {
  return TERMINAL_APPROVAL_STATUSES.has(status);
}

/** True only for a status this surface may act on directly (never claimed-by-another, never terminal). */
export function isActionableApproval(record: ApprovalRecord): boolean {
  return record.status === 'pending';
}

function isEditHunkLike(value: unknown): value is ApprovalEditHunk {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.path === 'string'
    && typeof candidate.find === 'string'
    && typeof candidate.replace === 'string'
    && (candidate.id === undefined || typeof candidate.id === 'string')
  );
}

/**
 * Extract a validated edit-hunk list from an approval's request args, or null
 * if the args are not edit-shaped. Mirrors the SDK's readApprovalEditHunks
 * exactly so "this approval has hunks to render" agrees with "the daemon will
 * accept a selectedHunks index array for it".
 */
export function readApprovalEditHunks(record: ApprovalRecord): ApprovalEditHunk[] | null {
  const edits = record.request.args.edits;
  if (!Array.isArray(edits) || edits.length === 0) return null;
  const items: ApprovalEditHunk[] = [];
  for (const entry of edits) {
    if (!isEditHunkLike(entry)) return null;
    items.push(entry);
  }
  return items;
}

export function isEditApproval(record: ApprovalRecord): boolean {
  return record.request.tool === 'edit' && readApprovalEditHunks(record) !== null;
}

/**
 * For a resolved, approved edit approval: was it a per-hunk subset rather
 * than the whole request? The daemon's `decision.modifiedArgs.edits` carries
 * the filtered hunk list only when a `selectedHunks` subset was sent
 * (APPROVAL_APPROVE_INPUT_SCHEMA's selectedHunks doc, operator-contract-
 * schemas-runtime.ts), comparing its length against the original request's
 * hunk count is enough to say "partial (2/5 hunks)" from data already on the
 * record, no extra wire call. Returns null when not applicable: not
 * approved, no edit hunks on the request, or modifiedArgs absent/covers
 * every hunk (a full approval).
 */
export function partialApprovalLabel(record: ApprovalRecord): string | null {
  if (record.status !== 'approved') return null;
  const originalHunks = readApprovalEditHunks(record);
  if (!originalHunks || originalHunks.length === 0) return null;
  const modifiedEdits = record.decision?.modifiedArgs?.edits;
  if (!Array.isArray(modifiedEdits) || modifiedEdits.length >= originalHunks.length) return null;
  return `partial (${modifiedEdits.length}/${originalHunks.length} hunks)`;
}

export function riskTone(riskLevel: string): string {
  switch (riskLevel) {
    case 'critical':
      return 'bad';
    case 'high':
      return 'warning';
    case 'medium':
      return 'neutral';
    default:
      return 'ok';
  }
}

export function statusTone(status: ApprovalStatus): string {
  switch (status) {
    case 'pending':
      return 'warning';
    case 'claimed':
      return 'neutral';
    case 'approved':
      return 'ok';
    case 'denied':
    case 'expired':
      return 'bad';
    case 'cancelled':
      return 'neutral';
    default:
      return 'neutral';
  }
}

export function statusLabel(status: string): string {
  return status.trim() || 'unknown';
}

export function sortApprovalsNewestFirst(approvals: readonly ApprovalRecord[]): ApprovalRecord[] {
  return [...approvals].sort((a, b) => b.updatedAt - a.updatedAt);
}

/** A short, human summary of a hunk for the checkbox row label. */
export function hunkSummary(hunk: ApprovalEditHunk): string {
  const find = hunk.find.length > 60 ? `${hunk.find.slice(0, 60)}…` : hunk.find;
  return `${hunk.path}: "${find}"`;
}

/**
 * The full decision trail, oldest first (the wire already appends in
 * chronological order, see approval-broker.ts's `buildAudit` call sites,
 * but this never assumes ordering it does not itself guarantee). `audit` is
 * absent, never null, on a mixed-version or pre-audit record, never inferred
 * as "no history", just "not reported here".
 */
export function auditTrail(record: ApprovalRecord): readonly ApprovalAuditRecord[] {
  return record.audit ?? [];
}

/** One-line, human summary of a single decision-trail entry for the detail card. */
export function auditEntryLabel(entry: ApprovalAuditRecord): string {
  const surface = entry.actorSurface ? ` (${entry.actorSurface})` : '';
  const note = entry.note ? `: ${entry.note}` : '';
  return `${entry.action} by ${entry.actor}${surface}${note}`;
}

/**
 * One-line, human-honest summary of who/what asked, for a non-foreground
 * approval, read only from `record.request.attribution`'s discriminated
 * `kind`, never inferred. Null on a foreground ask (the common case, no
 * `attribution` on the wire).
 */
export function attributionLabel(attribution: ApprovalAttribution | undefined): string | null {
  if (!attribution) return null;
  switch (attribution.kind) {
    case 'background-agent':
      return attribution.template
        ? `Asked on behalf of agent ${attribution.agentId} (${attribution.template})`
        : `Asked on behalf of agent ${attribution.agentId}`;
    case 'mcp-server':
      return `Requested by MCP server "${attribution.serverName}"`;
    case 'sandbox-escalation':
      return `Sandbox "${attribution.sandbox}" wants host access: ${attribution.escalations.join(', ')}`;
    case 'exec-prompt':
      return `Command waiting on its terminal: ${attribution.command}`;
    default:
      return null;
  }
}

// ─── Remember tiers + exec-prompt asks (snapshot rounds 4-6) ────────────────

function isRememberOptionLike(value: unknown): value is ApprovalRememberOption {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.tier === 'string'
    && typeof candidate.label === 'string'
    && typeof candidate.detail === 'string'
  );
}

/**
 * The remember-tier options offered on an ask, read defensively off
 * `request.rememberOptions` (a record from a pre-tier daemon simply offers
 * none). Options render VERBATIM, label/detail come from the SDK's
 * buildRememberOptions, never re-derived policy language.
 */
export function readRememberOptions(record: ApprovalRecord): ApprovalRememberOption[] {
  const options = record.request.rememberOptions;
  if (!Array.isArray(options)) return [];
  return options.filter(isRememberOptionLike);
}

/** The remember tiers that persist as durable permissions.rules.* records. */
const DURABLE_REMEMBER_TIERS = new Set(['exact', 'command-class', 'path', 'tool']);

export function isDurableRememberTier(tier: string): boolean {
  return DURABLE_REMEMBER_TIERS.has(tier);
}

/** The exec PTY prompt-answer ask shape (tool 'exec:prompt'). */
export interface ExecPromptAsk {
  readonly command: string;
  readonly prompt: string;
  readonly recentOutput: string;
}

/**
 * Read an exec-prompt ask, a RUNNING command blocked on its terminal, from
 * an approval record. Detected by the attribution's discriminated kind first,
 * with the tool id as the fallback tell (both stamped by the SDK's
 * buildExecPromptAnswerHandler). Field values come from `request.args`
 * ({ command, prompt, recentOutput }); missing strings degrade to '' so a
 * partial record still renders as an exec prompt rather than a generic ask.
 * Null when this is not an exec-prompt ask.
 */
export function readExecPromptAsk(record: ApprovalRecord): ExecPromptAsk | null {
  const isExecPrompt = record.request.attribution?.kind === 'exec-prompt' || record.request.tool === 'exec:prompt';
  if (!isExecPrompt) return null;
  const args = record.request.args;
  const readString = (value: unknown): string => (typeof value === 'string' ? value : '');
  const attribution = record.request.attribution;
  return {
    command: readString(args.command) || (attribution?.kind === 'exec-prompt' ? attribution.command : ''),
    prompt: readString(args.prompt) || (attribution?.kind === 'exec-prompt' ? attribution.prompt : ''),
    recentOutput: readString(args.recentOutput),
  };
}

/**
 * The remember tier the daemon actually recorded for this resolved approval,
 * read from the response's authoritative `recorded` block, never from what the
 * client sent. The HTTP route forwards the requested tier into broker
 * resolution and reports the tier it recorded (or null) back in that block, so
 * this is a fact, not an optimistic claim. Falls back to the resolved record's
 * decision snapshot for a daemon predating the block. Returns the tier or null.
 */
export function recordedRememberTier(result: ApprovalActionResult | undefined): string | null {
  const block = result?.recorded;
  if (block) {
    return typeof block.rememberTier === 'string' && block.rememberTier.length > 0 ? block.rememberTier : null;
  }
  const tier = result?.approval?.decision?.rememberTier;
  return typeof tier === 'string' && tier.length > 0 ? tier : null;
}

/**
 * Whether the daemon persisted the decision's free-text reason (a deny reason,
 * or an approve note), from the `recorded` block. Falls back to the presence
 * of a reason on the resolved record's decision for a pre-block daemon.
 */
export function recordedReasonStored(result: ApprovalActionResult | undefined): boolean {
  const block = result?.recorded;
  if (block) return block.reasonStored;
  const reason = result?.approval?.decision?.reason;
  return typeof reason === 'string' && reason.length > 0;
}

/**
 * Whether the daemon delivered the decision's modifiedArgs to the waiting run
 * (e.g. an exec-prompt answer reaching the blocked command), from the
 * `recorded` block. Falls back to an answer stamped on the resolved record's
 * decision.modifiedArgs for a pre-block daemon.
 */
export function recordedAnswerDelivered(result: ApprovalActionResult | undefined): boolean {
  const block = result?.recorded;
  if (block) return block.modifiedArgsDelivered;
  return typeof result?.approval?.decision?.modifiedArgs?.answer === 'string';
}

/**
 * The optional model-judgment verdict for a sandbox-escalation ask
 * (`sandbox-model-judgment` flag), read from `record.metadata.judgmentVerdict`
 *, the ONE place the daemon's annotate-only judgment tier stamps a verdict on
 * the wire (createSandboxEscalationApprovalHandler, sandbox-escalation.ts).
 * Absent when the judgment tier is off, unwired, or auto-approved the ask
 * (auto-approve never reaches a broker request, so no record exists to stamp).
 * Read defensively, `metadata` is an open `Record<string, unknown>` this
 * client never runtime-validates.
 */
export function judgmentVerdict(record: ApprovalRecord): string | null {
  const value = record.metadata.judgmentVerdict;
  return typeof value === 'string' ? value : null;
}

/** Badge tone for a model-judgment verdict, mirrors riskTone's ok/warning/neutral vocabulary. */
export function judgmentTone(verdict: string): string {
  switch (verdict) {
    case 'looks-safe':
      return 'ok';
    case 'flags-risk':
      return 'warning';
    default:
      return 'neutral';
  }
}

/** Human label for a model-judgment verdict badge. */
export function judgmentLabel(verdict: string): string {
  switch (verdict) {
    case 'looks-safe':
      return 'model judgment: looks safe';
    case 'flags-risk':
      return 'model judgment: flags risk';
    default:
      return 'model judgment: unavailable';
  }
}
