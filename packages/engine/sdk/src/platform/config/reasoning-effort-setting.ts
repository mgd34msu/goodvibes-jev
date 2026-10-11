/** Reasoning levels ordered from least to most reasoning spend. */
export const REASONING_EFFORT_SEVERITY: readonly string[] = [
  'none',
  'instant',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
];

/** Position in the severity ordering, or -1 when the level is not a known one. */
export function reasoningEffortRank(level: string): number {
  return REASONING_EFFORT_SEVERITY.indexOf(level);
}

/**
 * Levels the model currently in use resolved to, published by the runtime so
 * `provider.reasoningEffort` can be validated at set-time against the real
 * options rather than a fixed list. Null means no model has published yet.
 *
 * This unkeyed slot serves embedders that run one session per process. A daemon
 * hosting several sessions at once publishes under each session's own id
 * instead, so the model on one session cannot decide what is valid on another.
 */
let activeReasoningEffortOptions: readonly string[] | null = null;

const activeReasoningEffortOptionsBySession = new Map<string, readonly string[]>();

/**
 * How many sessions keep published levels. Entries are only dropped when a
 * session goes quiet for this many other sessions' turns, so the bound exists
 * to stop a long-lived daemon accumulating one entry per session ever seen.
 */
const ACTIVE_REASONING_EFFORT_SESSION_LIMIT = 64;

/**
 * Publish a model's resolved levels; pass null to clear.
 *
 * @param sessionId Scopes the publication to one session. Omit it to write the
 *                  process-wide slot used when there is only ever one session.
 */
export function setActiveReasoningEffortOptions(
  values: readonly string[] | null,
  sessionId?: string,
): void {
  if (sessionId === undefined) {
    activeReasoningEffortOptions = values === null ? null : [...values];
    return;
  }
  if (values === null) {
    activeReasoningEffortOptionsBySession.delete(sessionId);
    return;
  }
  // Re-inserting moves the session to the newest end of the iteration order, so
  // the entry evicted below is always the least recently published one.
  activeReasoningEffortOptionsBySession.delete(sessionId);
  activeReasoningEffortOptionsBySession.set(sessionId, [...values]);
  while (activeReasoningEffortOptionsBySession.size > ACTIVE_REASONING_EFFORT_SESSION_LIMIT) {
    const oldest = activeReasoningEffortOptionsBySession.keys().next();
    if (oldest.done === true) break;
    activeReasoningEffortOptionsBySession.delete(oldest.value);
  }
}

/**
 * A model's resolved levels, or null when none have been published.
 *
 * With a session id, that session's own levels, falling back to the unkeyed
 * slot so an embedder that never passes a session id still reads its own
 * publication. Without one, only the unkeyed slot.
 */
export function getActiveReasoningEffortOptions(sessionId?: string): readonly string[] | null {
  if (sessionId !== undefined) {
    return activeReasoningEffortOptionsBySession.get(sessionId) ?? activeReasoningEffortOptions;
  }
  return activeReasoningEffortOptions;
}

/**
 * Whether a `provider.reasoningEffort` value is acceptable right now.
 *
 * Given a session id, the answer is that session's own resolved levels. Without
 * one, the config schema's validator has no session in hand, because the
 * setting itself is not per session, a level is acceptable when ANY session
 * that has published offers it. Rejecting a level valid on the session the user
 * is actually looking at, because a different session ran a turn more recently,
 * would be the multi-session bleed this scoping exists to prevent. A level no
 * live model offers is still rejected, and before anything has published the
 * known severity ladder is the floor, so a typo never gets through.
 */
export function isAcceptableReasoningEffortSetting(value: unknown, sessionId?: string): boolean {
  if (typeof value !== 'string' || value === '') return false;
  if (sessionId !== undefined) {
    const scoped = getActiveReasoningEffortOptions(sessionId);
    return scoped === null ? reasoningEffortRank(value) !== -1 : scoped.includes(value);
  }
  let published = false;
  if (activeReasoningEffortOptions !== null) {
    if (activeReasoningEffortOptions.includes(value)) return true;
    published = true;
  }
  for (const levels of activeReasoningEffortOptionsBySession.values()) {
    if (levels.includes(value)) return true;
    published = true;
  }
  return published ? false : reasoningEffortRank(value) !== -1;
}
