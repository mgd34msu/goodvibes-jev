import type { RuntimeEventProvenance } from '../../events/occurrence.js';
import type { SystemMessagePresentation } from './system-message-presentation.js';

/** The runtime event restated by one of this module's operator-feed lines. */
export interface RuntimeEventNotice {
  readonly type: string;
  /** Present only when the producer supplied shared occurrence provenance beside the line. */
  readonly key?: string | undefined;
  readonly title: string;
  readonly level: 'info' | 'warning';
  /** The line's detail, without its bracket tag or status mark. */
  readonly detail: string;
}

/**
 * Match only the declared formats emitted below, never classify arbitrary
 * prose. Contract ids are kept whole, exactly as the producer prints them.
 * Entity ids are not event identities: an agent can wake, and an older
 * contract snapshot can be imported and resumed under the same id. Current
 * lines without declared provenance stay keyless rather than coalescing distinct outcomes.
 */
const RUNTIME_EVENT_NOTICE_LINES: ReadonlyArray<{
  readonly pattern: RegExp;
  readonly type: string;
  readonly title: string;
  readonly level: 'info' | 'warning';
}> = [
  { pattern: /^\[Response cancelled\]$/, type: 'TURN_CANCEL', title: 'Response cancelled', level: 'info' },
  { pattern: /^\[Agents\] \u2713 \S+ (\S+): ".*" \u2014 completed in \d+s \(\d+ tool calls\)$/s, type: 'AGENT_COMPLETED', title: 'Agent finished', level: 'info' },
  { pattern: /^\[Agents\] \u2717 \S+ (\S+): ".*" \u2014 failed in \d+s: .*/s, type: 'AGENT_FAILED', title: 'Agent failed', level: 'warning' },
  { pattern: /^\[Contract\] \u2713 (\S+) PASSED: \d+ of \d+ criteria met, \d+ corrections$/, type: 'CONTRACT_PASSED', title: 'Workstream passed', level: 'info' },
  { pattern: /^\[Contract\] \u2717 (\S+) FAILED: /s, type: 'CONTRACT_FAILED', title: 'Workstream failed', level: 'warning' },
  { pattern: /^\[Contract\] (\S+) cancelled: .* \(\d+ files modified\)$/s, type: 'CONTRACT_CANCELLED', title: 'Workstream cancelled', level: 'warning' },
  { pattern: /^\[Contract\] Commit committed for (\S+)(?: \(\S+\))?: /s, type: 'CONTRACT_COMMITTED', title: 'Changes committed', level: 'info' },
  { pattern: /^\[Contract\] Commit applied for (\S+)(?: \(\S+\))?: /s, type: 'CONTRACT_COMMITTED', title: 'Changes applied', level: 'info' },
  { pattern: /^\[Contract\] Commit skipped for (\S+)(?: \(\S+\))?: /s, type: 'CONTRACT_COMMITTED', title: 'Commit skipped', level: 'info' },
  { pattern: /^\[Contract\] Commit failed for (\S+)(?: \(\S+\))?: /s, type: 'CONTRACT_COMMITTED', title: 'Commit failed', level: 'warning' },
  { pattern: /^\[Contract\] \S+ started: /s, type: 'CONTRACT_CREATED', title: 'Workstream started', level: 'info' },
  { pattern: /^\[Contract\] \S+ (?:queued|shaping|planning|checking-plan|running|judging|fixing|committing|awaiting-owner|passed|failed|cancelled) -> (?:queued|shaping|planning|checking-plan|running|judging|fixing|committing|awaiting-owner|passed|failed|cancelled)$/, type: 'CONTRACT_STATUS_CHANGED', title: 'Workstream status changed', level: 'info' },
  { pattern: /^\[Contract\] \u2713 Check \S+ of (?:unit|group|deliverable) \S+: \d+\/\d+ criteria met, pass$/, type: 'CONTRACT_CHECKED', title: 'Check passed', level: 'info' },
  { pattern: /^\[Contract\] \u2717 Check \S+ of (?:unit|group|deliverable) \S+: \d+\/\d+ criteria met, (?:nudge|await-owner|stall)$/, type: 'CONTRACT_CHECKED', title: 'Check needs attention', level: 'warning' },
  { pattern: /^\[Contract\] Nudged unit \S+ \([^\n)]*\)(?: on [^\n]+)?$/, type: 'CONTRACT_NUDGED', title: 'Corrections requested', level: 'info' },
  { pattern: /^\[Contract\] Criterion \S+ of unit \S+ regressed \(met at \S+\)$/, type: 'CONTRACT_CRITERION_REGRESSED', title: 'Requirement regressed', level: 'warning' },
  { pattern: /^\[Contract\] (?:unit|group|deliverable) \S+ stalled, routed to (?:split|fresh|owner): /s, type: 'CONTRACT_STALLED', title: 'Workstream stalled', level: 'warning' },
  { pattern: /^\[Contract\] \S+ needs the owner: /s, type: 'CONTRACT_ESCALATED', title: 'Owner decision needed', level: 'warning' },
  { pattern: /^\[Contract\]\s+\u2713 Gate: .+ passed$/, type: 'CONTRACT_GATE_RESULT', title: 'Quality check passed', level: 'info' },
  { pattern: /^\[Contract\]\s+[\u2713\u2717] Gate: .+ skipped$/, type: 'CONTRACT_GATE_RESULT', title: 'Quality check skipped', level: 'info' },
  { pattern: /^\[Contract\]\s+\u2717 Gate: .+ FAILED$/, type: 'CONTRACT_GATE_RESULT', title: 'Quality check failed', level: 'warning' },
];

/** Read a declared operator-feed line, or return undefined for an unrelated line. */
export function runtimeEventOfNotice(text: string, runtimeEvent?: RuntimeEventProvenance): RuntimeEventNotice | undefined {
  const line = text.trim();
  for (const entry of RUNTIME_EVENT_NOTICE_LINES) {
    if (!entry.pattern.test(line)) continue;
    const detail = line.replace(/^\[[^\]\n]+\]\s*/, '').replace(/^[\u2713\u2717]\s*/, '');
    return { type: entry.type, title: entry.title, level: entry.level, detail, key: runtimeEventKey(entry.type, runtimeEvent) };
  }
  return undefined;
}

/**
 * Only producer-declared occurrence provenance can identify duplicate delivery.
 * Older payloads and text-only notices stay keyless. A new wake or imported
 * contract resume mints a new id even when its entity, text and usage repeat.
 */
export function runtimeEventKey(type: string, payload: unknown): string | undefined {
  if (!RUNTIME_EVENT_NOTICE_LINES.some((entry) => entry.type === type)) return undefined;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || !('type' in payload) || payload.type !== type
    || !('occurrenceId' in payload) || typeof payload.occurrenceId !== 'string'
    || payload.occurrenceId.trim().length === 0) return undefined;
  return JSON.stringify([type, payload.occurrenceId]);
}

/** Both a declared producer occurrence and its exact wire format are required. */
export function declaredNoticePresentation(text: string, provenance?: RuntimeEventProvenance): SystemMessagePresentation | undefined {
  if (!provenance) return undefined;
  const notice = runtimeEventOfNotice(text, provenance);
  if (!notice || notice.type !== provenance.type) return undefined;
  return Object.freeze({ activity: notice.type === 'AGENT_COMPLETED' || notice.type === 'AGENT_FAILED' ? 'agent' : 'system',
    severity: notice.level, event: notice.type === 'AGENT_COMPLETED' || notice.type === 'AGENT_FAILED' ? 'task_transition'
      : notice.type === 'TURN_CANCEL' ? 'system_notice' : 'contract_state' });
}
