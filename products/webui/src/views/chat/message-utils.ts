import { asRecord, bestId, compactJson, firstArray, firstString } from '../../lib/object';

export function messageText(message: unknown): string {
  const direct = firstString(message, ['body', 'content', 'text', 'message', 'delta']);
  if (direct) return direct;
  const parts = firstArray(message, ['parts', 'content']);
  return parts.map((part) => firstString(part, ['text', 'content', 'body'])).filter(Boolean).join('\n');
}

export function messageAttachments(message: unknown): unknown[] {
  const record = asRecord(message);
  if (Array.isArray(record.attachments)) return record.attachments;
  if (Array.isArray(record.artifacts)) return record.artifacts;
  return [];
}

export function attachmentLabel(attachment: unknown): string {
  return firstString(attachment, ['label', 'filename', 'name', 'artifactId', 'id']) || 'Attachment';
}

export function attachmentMeta(attachment: unknown): string {
  const record = asRecord(attachment);
  const mimeType = firstString(attachment, ['mimeType', 'type']);
  const sizeBytes = Number(record.sizeBytes ?? record.size);
  const size = Number.isFinite(sizeBytes) && sizeBytes > 0
    ? sizeBytes > 1024 * 1024
      ? `${(sizeBytes / 1024 / 1024).toFixed(1)} MB`
      : `${Math.max(1, Math.round(sizeBytes / 1024))} KB`
    : '';
  return [mimeType, size].filter(Boolean).join(' · ');
}

export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error(`Failed to read ${file.name}`));
    reader.onload = () => {
      const value = typeof reader.result === 'string' ? reader.result : '';
      resolve(value.includes(',') ? value.split(',').pop() ?? '' : value);
    };
    reader.readAsDataURL(file);
  });
}

export function uploadedArtifactId(uploaded: unknown): string {
  return firstString(asRecord(uploaded).artifact, ['id', 'artifactId'])
    || firstString(uploaded, ['artifactId', 'id']);
}

export function roleOf(message: unknown): string {
  return firstString(message, ['role', 'author', 'kind', 'source']) || 'message';
}

export function messageTone(message: unknown): string {
  const role = roleOf(message).toLowerCase();
  if (role.includes('user')) return 'user';
  if (role.includes('assistant') || role.includes('agent') || role.includes('model')) return 'assistant';
  if (role.includes('system')) return 'system';
  return 'neutral';
}

/**
 * Earliest instant a real chat message can carry. Anything before it (0, a
 * small counter, an unset field defaulted to the epoch) is a missing time, not
 * a moment in 1969 or 1970, so it renders as nothing at all.
 */
const EARLIEST_PLAUSIBLE_MS = Date.UTC(2000, 0, 1);
/** Values in this range are epoch SECONDS (a 10-digit Unix time), not milliseconds. */
const LATEST_PLAUSIBLE_SECONDS = 1e11;

/**
 * The message's creation time in epoch milliseconds, or null when it is
 * missing, zero, unparseable or implausibly early. Accepts epoch ms, epoch
 * seconds, numeric strings and ISO strings.
 */
export function messageTimeMs(message: unknown): number | null {
  const record = asRecord(message);
  const raw = record.createdAt ?? record.timestamp ?? record.time;
  let value: number;
  if (typeof raw === 'number') {
    value = raw;
  } else if (typeof raw === 'string' && raw.trim()) {
    const numeric = Number(raw);
    value = Number.isFinite(numeric) ? numeric : Date.parse(raw);
  } else {
    return null;
  }
  if (!Number.isFinite(value) || value <= 0) return null;
  if (value < LATEST_PLAUSIBLE_SECONDS && value * 1000 >= EARLIEST_PLAUSIBLE_MS) value *= 1000;
  if (value < EARLIEST_PLAUSIBLE_MS) return null;
  return value;
}

/**
 * A short, human time for the hover row under a message: "3:42 PM" today,
 * "Sep 28, 3:42 PM" earlier this year, "Sep 28, 2025, 3:42 PM" before that.
 * Returns '' when the time is missing (never an epoch date, never "unknown").
 */
export function messageTimestamp(message: unknown, now: number = Date.now()): string {
  const ms = messageTimeMs(message);
  if (ms === null) return '';
  const date = new Date(ms);
  const today = new Date(now);
  const sameDay = date.getFullYear() === today.getFullYear()
    && date.getMonth() === today.getMonth()
    && date.getDate() === today.getDate();
  if (sameDay) return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return date.toLocaleString([], {
    month: 'short',
    day: 'numeric',
    ...(date.getFullYear() === today.getFullYear() ? {} : { year: 'numeric' }),
    hour: 'numeric',
    minute: '2-digit',
  });
}

/** The full date and time for a timestamp's tooltip, '' when missing. */
export function messageTimestampTitle(message: unknown): string {
  const ms = messageTimeMs(message);
  return ms === null ? '' : new Date(ms).toLocaleString();
}

export function messageCreatedAt(message: unknown): number {
  const record = asRecord(message);
  if (typeof record.createdAt === 'number') return record.createdAt;
  if (typeof record.timestamp === 'number') return record.timestamp;
  if (typeof record.time === 'number') return record.time;
  return 0;
}

export function assistantContentFromCompletedTurn(payload: unknown, fallback: string): string {
  const envelope = asRecord(asRecord(payload).envelope);
  return firstString(envelope, ['body', 'content', 'text', 'message'])
    || firstString(payload, ['body', 'content', 'text', 'message', 'response'])
    || fallback;
}

export function companionEventType(eventName: string, payload: unknown): string {
  return firstString(payload, ['type']) || eventName.replace(/^companion-chat\./, '');
}

/**
 * Every value the turn lifecycle can be in, across useChatSend.ts (send/lineage
 * mutations) and useChatStream.ts (SSE event handlers), the single source of
 * truth ChatView's TurnState is derived from. A literal passed to setTurnState
 * that is not in this tuple is now a compile error instead of a silent typo
 * (see the sibling goodvibes-app repo's message-utils.ts, same pattern).
 */
export const TURN_STATES = [
  'idle',
  'sending',
  'sending while reconnecting',
  'submitted',
  'running',
  'streaming',
  'tooling',
  'syncing',
  'stopping',
  'stopped locally',
  'stopped',
  'reconnecting',
  'completed',
  'error',
  'send failed',
  'session expired',
  'stream paused',
  'stream error',
] as const;

export type TurnState = (typeof TURN_STATES)[number];

/**
 * The turn lifecycle's state AND its explanatory message as one value (see
 * ChatView.tsx's `turn` useState and IDLE_TURN_PHASE), so the two can never be
 * independently stale: every mutation, including the reset on session switch,
 * sets both fields in a single setState call. Before this, turnState and
 * turnError were separate useState strings and the session-switch reset only
 * cleared turnError, letting a terminal turnState (e.g. 'send failed') from an
 * old session bleed into a new one's header.
 */
export interface TurnPhase {
  readonly state: TurnState;
  readonly error: string;
}

export const IDLE_TURN_PHASE: TurnPhase = { state: 'idle', error: '' };

/**
 * States for which a turn is genuinely in flight (drives the streaming indicator, the
 * Stop control, and the 1s message-poll fallback). 'reconnecting' and 'sending while
 * reconnecting' are included deliberately: an SSE drop mid-turn (or a send that starts
 * while the stream is backing off) does not mean the turn stopped, it means the live
 * channel is temporarily down while the daemon keeps working. 'stream paused' and
 * 'session expired' are deliberately EXCLUDED, those mean the automatic reconnect gave
 * up (or the token died), so nothing is actively streaming any more; isStreaming must
 * go false rather than keep asserting a live turn that no longer has a path to resume.
 */
export const ACTIVE_TURN_STATES: readonly string[] = [
  'sending',
  'submitted',
  'running',
  'streaming',
  'tooling',
  'reconnecting',
  'sending while reconnecting',
  // A server-side stop has been requested; the stream stays open awaiting the
  // terminal turn.cancelled event.
  'stopping',
];

/**
 * Derive a concise, human chat title from the first user message, the client-side
 * auto-title (there is deliberately no server auto-title verb; the daemon exposes only
 * companion.chat.sessions.update, which this feeds). Takes the first non-empty line,
 * collapses whitespace, caps the length on a word boundary, and strips trailing
 * punctuation. Returns '' when there is nothing meaningful to title from, so the caller
 * can leave the existing title untouched rather than write an empty one.
 */
export function deriveChatTitle(text: string, maxLength = 52): string {
  const firstLine = text.split('\n').map((line) => line.trim()).find((line) => line.length > 0) ?? '';
  const collapsed = firstLine.replace(/\s+/g, ' ').trim();
  if (!collapsed) return '';
  if (collapsed.length <= maxLength) return collapsed.replace(/[\s.,;:!?-]+$/, '');
  const clipped = collapsed.slice(0, maxLength);
  const lastSpace = clipped.lastIndexOf(' ');
  const onWordBoundary = lastSpace > maxLength * 0.5 ? clipped.slice(0, lastSpace) : clipped;
  return `${onWordBoundary.replace(/[\s.,;:!?-]+$/, '')}…`;
}

export function deliveryState(message: unknown): 'sent' | 'failed' | 'local' | 'cancelled' | 'queued' | '' {
  const state = firstString(message, ['deliveryState', 'status', 'state']).toLowerCase();
  // Exact daemon markers first, 'cancelled' (an assistant partial whose turn
  // was stopped) and 'queued' (a user message whose turn has not started)
  // must never fall through to the 'sent' default and masquerade as normal.
  if (state === 'cancelled') return 'cancelled';
  if (state === 'queued') return 'queued';
  if (state.includes('fail') || state.includes('error')) return 'failed';
  if (state.includes('local') || state.includes('pending')) return 'local';
  if (messageTone(message) === 'user') return 'sent';
  return '';
}

export { bestId };

/**
 * A completed tool call folded into an assistant message once its turn ends,
 * built client-side from the live `turn.tool_call` / `turn.tool_result` stream
 * events (see useChatStream's toolActivityByMessageId). This is NOT part of
 * the daemon's persisted message shape (CompanionChatMessage carries no tool
 * fields), so it is only ever present for a turn this browser tab actually
 * watched run live, never fabricated for history fetched from the server.
 */
export interface CompletedToolCall {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly toolInput?: unknown;
  readonly result?: unknown;
  readonly isError: boolean;
  /** When this browser saw turn.tool_call (epoch ms, client clock). */
  readonly startedAt?: number;
  /** When this browser saw the matching turn.tool_result (epoch ms, client clock). */
  readonly finishedAt?: number;
}

/** Common tool names mapped to the short, human label used in the folded summary line. */
const TOOL_FRIENDLY_LABELS: Readonly<Record<string, string>> = {
  read: 'read',
  write: 'write',
  edit: 'edit',
  bash: 'exec',
  exec: 'exec',
  grep: 'search',
  glob: 'search',
  websearch: 'web search',
  webfetch: 'web fetch',
  task: 'agent',
};

/** A short, human label for a tool name, falls back to the raw name when unrecognized. */
export function toolFriendlyLabel(toolName: string): string {
  const normalized = toolName.trim().toLowerCase();
  return TOOL_FRIENDLY_LABELS[normalized] ?? (toolName.trim() || 'tool');
}

/** Common argument keys, checked in order, used to surface a tool call's one key argument. */
const KEY_ARG_FIELDS = ['file_path', 'filePath', 'path', 'command', 'pattern', 'query', 'url', 'prompt'];

/** The single most identifying argument of a tool call's input, for the compact fold line. */
export function toolKeyArg(toolInput: unknown): string {
  const record = asRecord(toolInput);
  for (const field of KEY_ARG_FIELDS) {
    const value = record[field];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

/** A tool result rendered as honest text, strings pass through, anything else is compact JSON. */
export function toolResultText(result: unknown): string {
  if (result === undefined || result === null) return '';
  if (typeof result === 'string') return result;
  return compactJson(result);
}

/**
 * Verb phrases for the one-line tool summary ("Read 2 files, searched the web").
 * Each entry turns a count into a phrase; tools not listed fall back to
 * "used <name>" with a count.
 */
const TOOL_PHRASES: Readonly<Record<string, (count: number) => string>> = {
  read: (n) => `read ${n} file${n === 1 ? '' : 's'}`,
  write: (n) => `wrote ${n} file${n === 1 ? '' : 's'}`,
  edit: (n) => `edited ${n} file${n === 1 ? '' : 's'}`,
  exec: (n) => `ran ${n} command${n === 1 ? '' : 's'}`,
  search: (n) => (n === 1 ? 'searched the code' : `searched the code ${n} times`),
  'web search': (n) => (n === 1 ? 'searched the web' : `searched the web ${n} times`),
  'web fetch': (n) => `read ${n} web page${n === 1 ? '' : 's'}`,
  agent: (n) => `ran ${n} agent${n === 1 ? '' : 's'}`,
};

/** Whole seconds between the first call starting and the last one finishing, or null. */
export function toolActivityDurationMs(calls: readonly Pick<CompletedToolCall, 'startedAt' | 'finishedAt'>[]): number | null {
  const starts = calls.map((call) => call.startedAt).filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
  const ends = calls.map((call) => call.finishedAt).filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
  if (!starts.length || !ends.length) return null;
  const duration = Math.max(...ends) - Math.min(...starts);
  return duration >= 0 ? duration : null;
}

/** "4 s", "1 min 12 s", "<1 s". */
export function formatToolDuration(ms: number): string {
  if (ms < 1000) return '<1 s';
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest ? `${minutes} min ${rest} s` : `${minutes} min`;
}

/**
 * The collapsed tool row's one line, e.g. "Read 2 files, searched the web · 4 s".
 * Real counts only; the duration appears only when this browser timed the calls,
 * and failures are counted rather than hidden.
 */
export function describeToolActivity(calls: readonly CompletedToolCall[]): string {
  if (calls.length === 0) return '';
  const counts = new Map<string, number>();
  for (const call of calls) {
    const label = toolFriendlyLabel(call.toolName);
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  const phrases = [...counts.entries()].map(([label, count]) => {
    const phrase = TOOL_PHRASES[label];
    if (phrase) return phrase(count);
    return count > 1 ? `used ${label} ${count} times` : `used ${label}`;
  });
  const failed = calls.filter((call) => call.isError).length;
  if (failed) phrases.push(`${failed} failed`);
  const sentence = phrases.join(', ');
  const line = sentence.charAt(0).toUpperCase() + sentence.slice(1);
  const duration = toolActivityDurationMs(calls);
  return duration === null ? line : `${line} · ${formatToolDuration(duration)}`;
}

/**
 * What the working line under the last message says while a turn runs, named
 * from the live state (never a generic spinner). Returns '' when nothing is in
 * flight.
 */
export function workingStatusLabel(
  turnState: string,
  activeToolNames: readonly string[],
  hasLiveText: boolean,
): string {
  if (turnState === 'stopping') return 'Stopping…';
  if (turnState === 'reconnecting' || turnState === 'sending while reconnecting') return 'Reconnecting to your daemon…';
  if (activeToolNames.length > 0) {
    const counts = new Map<string, number>();
    for (const name of activeToolNames) {
      const label = toolFriendlyLabel(name);
      counts.set(label, (counts.get(label) ?? 0) + 1);
    }
    const running = [...counts.entries()].map(([label, count]) => {
      switch (label) {
        case 'read': return count > 1 ? `Reading ${count} files` : 'Reading a file';
        case 'write': return count > 1 ? `Writing ${count} files` : 'Writing a file';
        case 'edit': return count > 1 ? `Editing ${count} files` : 'Editing a file';
        case 'exec': return count > 1 ? `Running ${count} commands` : 'Running a command';
        case 'search': return 'Searching the code';
        case 'web search': return 'Searching the web';
        case 'web fetch': return 'Reading a web page';
        case 'agent': return count > 1 ? `Running ${count} agents` : 'Running an agent';
        default: return `Using ${label}`;
      }
    });
    const sentence = running.map((phrase, index) => (index === 0 ? phrase : phrase.charAt(0).toLowerCase() + phrase.slice(1)));
    return `${sentence.join(', ')}…`;
  }
  if (turnState === 'sending') return 'Sending…';
  if (turnState === 'tooling') return 'Working with tools…';
  if (turnState === 'syncing') return 'Loading the reply…';
  if (turnState === 'streaming') return hasLiveText ? 'Writing…' : 'Thinking…';
  if (turnState === 'running' || turnState === 'submitted') return 'Thinking…';
  return '';
}

/**
 * Plain words for a turn that ended somewhere other than a normal reply, shown
 * as a quiet line above the composer. '' for idle, in-flight and completed turns.
 */
export function settledTurnLabel(turnState: string): string {
  switch (turnState) {
    case 'stream paused': return 'Live updates are off. Replies still arrive by periodic refresh.';
    case 'stream error': return 'The live stream failed.';
    case 'send failed': return 'The message was not sent.';
    case 'session expired': return 'Your sign-in expired.';
    case 'stopped': return 'Stopped.';
    case 'stopped locally': return 'Stopped showing the reply. This daemon cannot stop the turn itself.';
    case 'error': return 'The reply failed.';
    default: return '';
  }
}
