/**
 * delegated-task-notices.ts, the plain title of each delegated-task line.
 *
 * runtime/agent-runtime-events.ts writes one "[Delegated task] …" line per
 * delegated agent that finishes, fails or runs out of turns. The notification
 * history keeps each such event as one entry under a plain title, with the
 * line's detail as the body (core/notices.ts). The test drives the real
 * producer through delegatedTaskEventOfNotice so the lines and this table
 * cannot drift apart.
 */

export interface DelegatedTaskNotice {
  /** The runtime event the line restates. */
  readonly type: 'AGENT_COMPLETED' | 'AGENT_FAILED';
  readonly title: string;
  readonly level: 'info' | 'warning';
  /** The line without its bracket tag. */
  readonly detail: string;
}

const DELEGATED_TASK_LINES: ReadonlyArray<{ readonly pattern: RegExp; readonly type: DelegatedTaskNotice['type']; readonly title: string; readonly level: DelegatedTaskNotice['level'] }> = [
  { pattern: /^\[Delegated task\] \S+ \S+ completed in \d+s /s, type: 'AGENT_COMPLETED', title: 'Delegated task finished', level: 'info' },
  { pattern: /^\[Delegated task\] \S+ \S+ spent its turn budget in \d+s, /s, type: 'AGENT_FAILED', title: 'Delegated task ran out of turns', level: 'warning' },
  { pattern: /^\[Delegated task\] \S+ \S+ failed in \d+s /s, type: 'AGENT_FAILED', title: 'Delegated task failed', level: 'warning' },
];

/** The delegated-task event a system line restates, or undefined for any other line. */
export function delegatedTaskEventOfNotice(text: string): DelegatedTaskNotice | undefined {
  const line = text.trim();
  const match = DELEGATED_TASK_LINES.find((entry) => entry.pattern.test(line));
  if (!match) return undefined;
  return { type: match.type, title: match.title, level: match.level, detail: line.replace(/^\[Delegated task\]\s*/, '') };
}
