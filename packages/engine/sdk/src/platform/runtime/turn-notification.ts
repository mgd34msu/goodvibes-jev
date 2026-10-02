/**
 * turn-notification.ts, the words every host notification uses to name the
 * work it is about.
 *
 * A notification is a message to a person who is looking at something else.
 * "GoodVibes: Response complete (42s)" tells them a turn ended and nothing
 * about which one or how it went. Every channel a host sends on (the desktop
 * popup, the in-terminal OSC 9 notice, an outbound webhook) builds its text
 * here, so the same turn is named the same way everywhere:
 *
 *   - the title is a short name for the turn: the conversation title when the
 *     user set one, otherwise the first line of the message that started this
 *     turn, otherwise the conversation's derived title. Trimmed at a word
 *     boundary to fit the channel. No model call: the name comes from text the
 *     host already holds.
 *   - the body is the outcome in plain words: done, failed or cancelled, the
 *     elapsed time, files changed, tool calls, agents started, the review
 *     score, and for a failure the reason.
 *
 * Privacy rule (behavior.notificationsMetadataOnly, read live): when the
 * setting is on, every channel sends metadata only, the outcome, counts,
 * elapsed time, and never the turn's name, a failure
 * reason, a command or a path, since those come from what the user typed or
 * what the model did. Only literal false permits content-bearing text,
 * including the turn name and outcome on an outbound webhook.
 */
import { readNotificationsMetadataOnly } from './notification-privacy.js';
import { notificationTool, notificationCategory, notificationSubject, notificationNumber, notificationOutcome, notificationOptionalText } from './notification-metadata.js';

function metadataOnly(options: NotificationTextOptions): boolean {
  return readNotificationsMetadataOnly(() => options?.metadataOnly);
}

/**
 * Character budgets per channel. A desktop popup shows a short title over a
 * body that wraps; an OSC 9 notice is one line the terminal hands to the OS;
 * a webhook body is read on a phone.
 */
export const NOTIFICATION_TEXT_LIMITS = {
  /** Desktop popup title (notify-send / osascript). */
  desktopTitle: 60,
  /** Desktop popup body. */
  desktopBody: 220,
  /** One-line in-terminal (OSC 9) notice. */
  terminal: 140,
  /** Outbound webhook body (title line + body line). */
  webhook: 400,
  /** The turn name inside a one-line notice. */
  name: 60,
} as const;

const ELLIPSIS = '…';

/**
 * The first non-empty line of `text`, whitespace collapsed, cut at the last
 * word boundary that fits `maxLength` (ellipsis included). A single word
 * longer than the budget is cut mid-word, since there is no boundary to use.
 * Returns '' for empty input.
 */
export function trimAtWordBoundary(text: string, maxLength: number): string {
  const firstLine = String(text ?? '')
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .find((line) => line.length > 0) ?? '';
  const max = Math.max(1, Math.floor(maxLength));
  if (firstLine.length <= max) return firstLine;
  if (max === 1) return ELLIPSIS;
  const room = max - ELLIPSIS.length;
  const cut = firstLine.lastIndexOf(' ', room);
  const head = cut > 0 ? firstLine.slice(0, cut) : firstLine.slice(0, room);
  return `${head.replace(/[\s,.;:–-]+$/u, '')}${ELLIPSIS}`;
}

/** What a host knows about a turn that it can name the turn from. */
export interface TurnNameSource {
  /** The conversation title (ConversationManager.title). */
  readonly title?: string | null | undefined;
  /** Who set the title: 'user' (e.g. /title) or 'system' (derived from the first message). */
  readonly titleSource?: 'user' | 'system' | null | undefined;
  /** The text of the user message that started this turn. */
  readonly turnText?: string | null | undefined;
}

/**
 * A short name for a turn, or null when nothing names it.
 *
 * A title the user set is a deliberate name and wins. Otherwise the turn's own
 * message names it better than the derived conversation title, which is the
 * first message of the whole session and would name every later turn after
 * the first one. The derived title is the last resort.
 */
export function resolveTurnName(source: TurnNameSource, maxLength: number = NOTIFICATION_TEXT_LIMITS.name): string | null {
  const title = trimAtWordBoundary(source.title ?? '', maxLength);
  if (source.titleSource === 'user' && title) return title;
  const turn = trimAtWordBoundary(source.turnText ?? '', maxLength);
  if (turn) return turn;
  return title || null;
}

/** How a turn ended. */
export type TurnOutcome = 'completed' | 'failed' | 'cancelled';

/** Everything a turn notification can say. Counts that are absent or zero are left out. */
export interface TurnNotificationFacts {
  readonly outcome: TurnOutcome;
  readonly elapsedMs: number;
  /** The turn's name (resolveTurnName). */
  readonly name?: string | null | undefined;
  /** Why a failed or cancelled turn stopped. */
  readonly reason?: string | null | undefined;
  readonly toolCalls?: number | undefined;
  readonly filesChanged?: number | undefined;
  readonly agentsStarted?: number | undefined;
  /** Latest review score seen during the turn, out of 10. */
  readonly reviewScore?: number | null | undefined;
  /** Session id retained for source compatibility; restricted text omits unproven identifiers. */
  readonly sessionId?: string | undefined;
  /** What finished, for the unnamed title ("GoodVibes: turn done"). Default 'turn'. */
  readonly subject?: string | undefined;
}

export interface NotificationTextOptions {
  /** behavior.notificationsMetadataOnly */
  readonly metadataOnly: boolean;
}

/** A title and a body, for channels that show both. */
export interface NotificationText {
  readonly title: string;
  readonly body: string;
}

/** '42s', '3m 5s', '1h 2m'. */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor((Number.isFinite(ms) ? ms : 0) / 1000));
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) {
    const seconds = total % 60;
    return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
  }
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

function formatScore(score: number): string {
  const rounded = Math.round(score * 10) / 10;
  return `${Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(1)}/10`;
}

function outcomeWord(outcome: TurnOutcome): string {
  const checked = notificationOutcome(outcome);
  return checked === 'completed' ? 'done' : checked;
}

function activityParts(facts: TurnNotificationFacts): string[] {
  const parts: string[] = [];
  const { filesChanged, toolCalls, agentsStarted, reviewScore } = facts;
  if (Number.isSafeInteger(filesChanged) && filesChanged! > 0) parts.push(plural(filesChanged!, 'file changed', 'files changed'));
  if (Number.isSafeInteger(toolCalls) && toolCalls! > 0) parts.push(plural(toolCalls!, 'tool call', 'tool calls'));
  if (Number.isSafeInteger(agentsStarted) && agentsStarted! > 0) parts.push(plural(agentsStarted!, 'agent started', 'agents started'));
  if (typeof reviewScore === 'number' && Number.isFinite(reviewScore) && reviewScore >= 0 && reviewScore <= 10) parts.push(`review ${formatScore(reviewScore)}`);
  return parts;
}

/**
 * The outcome sentence: "Done in 42s, 3 files changed, review 9/10",
 * "Failed after 12s: provider returned 500", "Cancelled after 8s".
 * Metadata-only drops the reason and session id: neither arbitrary text nor
 * an opaque-looking identifier proves non-private provenance.
 */
export function describeTurnOutcome(facts: TurnNotificationFacts, options: NotificationTextOptions): string {
  try {
    const elapsed = formatElapsed(notificationNumber(facts.elapsedMs));
    const outcome = notificationOutcome(facts.outcome);
    const lead = outcome === 'completed' ? `Done in ${elapsed}` : `${outcome === 'failed' ? 'Failed' : 'Cancelled'} after ${elapsed}`;
    const parts = [lead, ...activityParts(facts)];
    let text = parts.join(', ');
    if (metadataOnly(options)) return text;
    const reason = outcome === 'completed' ? '' : trimAtWordBoundary(notificationOptionalText(facts.reason), 160);
    if (reason) text += `: ${reason}`;
    return text;
  } catch {
    throw new TypeError('Invalid notification facts');
  }
}

/**
 * Title and body for a desktop popup (or any channel with both).
 * Named: title "Fix the login redirect", body "Done in 42s, 2 files changed".
 * Metadata only, or no name: title "GoodVibes: turn done".
 */
export function buildTurnNotification(
  facts: TurnNotificationFacts,
  options: NotificationTextOptions,
  limits: { readonly title?: number; readonly body?: number } = {},
): NotificationText {
  try {
    const titleMax = limits.title ?? NOTIFICATION_TEXT_LIMITS.desktopTitle;
    const bodyMax = limits.body ?? NOTIFICATION_TEXT_LIMITS.desktopBody;
    const restricted = metadataOnly(options);
    const name = restricted ? '' : trimAtWordBoundary(notificationOptionalText(facts.name), titleMax);
    const rawSubject = facts.subject;
    const subject = restricted ? notificationSubject(rawSubject) : rawSubject === undefined ? 'turn' : notificationOptionalText(rawSubject);
    const title = name || trimAtWordBoundary(`GoodVibes: ${subject} ${outcomeWord(facts.outcome)}`, titleMax);
    return { title, body: trimAtWordBoundary(describeTurnOutcome(facts, { metadataOnly: restricted }), bodyMax) };
  } catch {
    throw new TypeError('Invalid notification facts');
  }
}

/**
 * Join a title and body into one line of at most `maxLength` characters.
 * The body is kept whole when it can be; the title gives up room first but
 * keeps at least 20 characters (or the whole title, when shorter).
 */
export function joinNotificationLine(text: NotificationText, maxLength: number): string {
  const separator = ': ';
  const bodyFull = trimAtWordBoundary(text.body, maxLength);
  const minTitle = Math.min(20, text.title.length);
  const titleRoom = Math.max(minTitle, maxLength - bodyFull.length - separator.length);
  const title = trimAtWordBoundary(text.title, titleRoom);
  const body = trimAtWordBoundary(text.body, Math.max(1, maxLength - title.length - separator.length));
  return title ? `${title}${separator}${body}` : body;
}

/** One-line in-terminal (OSC 9) notice for a finished turn. */
export function buildTurnNotificationLine(
  facts: TurnNotificationFacts,
  options: NotificationTextOptions,
  maxLength: number = NOTIFICATION_TEXT_LIMITS.terminal,
): string {
  return joinNotificationLine(buildTurnNotification(facts, options, { title: NOTIFICATION_TEXT_LIMITS.name, body: maxLength }), maxLength);
}

/** Webhook body: the title on the first line, the outcome on the second. */
export function formatWebhookText(text: NotificationText, maxLength: number = NOTIFICATION_TEXT_LIMITS.webhook): string {
  const title = trimAtWordBoundary(text.title, Math.min(NOTIFICATION_TEXT_LIMITS.desktopTitle * 2, maxLength));
  const body = trimAtWordBoundary(text.body, Math.max(1, maxLength - title.length - 1));
  return title ? `${title}\n${body}` : body;
}

// ---------------------------------------------------------------------------
// Approval and budget notices
// ---------------------------------------------------------------------------

function firstString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function pathsFrom(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  const out: string[] = [];
  for (const item of list) {
    const path = item && typeof item === 'object' ? firstString((item as { path?: unknown }).path) : null;
    if (path && !out.includes(path)) out.push(path);
  }
  return out;
}

/**
 * What a tool call acts on, in the words a person would use: the command for
 * exec, the file for write and edit, the URL for fetch. Reads the permission
 * analysis target first, then the common argument shapes. Null when nothing
 * names it.
 */
export function describeToolTarget(args: Readonly<Record<string, unknown>> | null | undefined, analysisTarget?: string | null): string | null {
  const target = firstString(analysisTarget);
  if (target) return target;
  if (!args) return null;
  const commands = (args as { commands?: unknown }).commands;
  if (Array.isArray(commands) && commands.length > 0) {
    const first = commands[0];
    const cmd = first && typeof first === 'object' ? firstString((first as { cmd?: unknown }).cmd) : null;
    if (cmd) return commands.length > 1 ? `${cmd} (+${commands.length - 1} more)` : cmd;
  }
  for (const key of ['cmd', 'command', 'url', 'path', 'file_path'] as const) {
    const value = firstString(args[key]);
    if (value) return value;
  }
  const paths = [...pathsFrom(args['files']), ...pathsFrom(args['edits'])];
  if (paths.length > 0) return paths.length > 1 ? `${paths[0]} (+${paths.length - 1} more)` : paths[0]!;
  return null;
}

export interface ApprovalNotificationFacts {
  readonly tool: string;
  readonly category: string;
  /** describeToolTarget(...) */
  readonly target?: string | null | undefined;
  /** The name of the turn that asked. */
  readonly turnName?: string | null | undefined;
}

/**
 * Named: title "Approval needed: Fix the login redirect",
 * body "exec wants to run: bun test src/auth".
 * Metadata only: title "GoodVibes: approval needed",
 * body "exec (execute) is waiting for approval".
 */
export function buildApprovalNotification(facts: ApprovalNotificationFacts, options: NotificationTextOptions): NotificationText {
  try {
    const rawTool = facts.tool;
    const rawCategory = facts.category;
    if (typeof rawTool !== 'string' || typeof rawCategory !== 'string') throw new TypeError();
    const tool = notificationTool(rawTool) ?? 'A tool';
    const category = notificationCategory(rawCategory);
    const metadataBody = `${tool}${category ? ` (${category})` : ''} is waiting for approval`;
    if (metadataOnly(options)) return { title: 'GoodVibes: approval needed', body: metadataBody };
    const name = trimAtWordBoundary(notificationOptionalText(facts.turnName), NOTIFICATION_TEXT_LIMITS.desktopTitle - 'Approval needed: '.length);
    const title = name ? `Approval needed: ${name}` : 'GoodVibes: approval needed';
    const target = trimAtWordBoundary(notificationOptionalText(facts.target), 160);
    const body = target ? `${rawTool} is waiting for approval: ${target}` : metadataBody;
    return { title, body };
  } catch {
    throw new TypeError('Invalid notification facts');
  }
}

export interface BudgetNotificationFacts {
  readonly sessionCostUsd: number;
  readonly budgetUsd: number;
  readonly sessionId: string;
  readonly turnName?: string | null | undefined;
}

/** Typed facts supplied by a producer; delivery snapshots these before awaiting. */
export type NotificationDelivery =
  | { readonly kind: 'turn'; readonly facts: TurnNotificationFacts }
  | { readonly kind: 'approval'; readonly facts: ApprovalNotificationFacts }
  | { readonly kind: 'budget'; readonly facts: BudgetNotificationFacts };

/**
 * Named: title "Budget passed: Fix the login redirect",
 * body "Session cost $1.23 passed the $1.00 session budget during this turn".
 * Metadata only: title "GoodVibes: budget passed", body with costs only.
 */
export function buildBudgetNotification(facts: BudgetNotificationFacts, options: NotificationTextOptions): NotificationText {
  try {
    const cost = `$${notificationNumber(facts.sessionCostUsd).toFixed(2)}`;
    const budget = `$${notificationNumber(facts.budgetUsd).toFixed(2)}`;
    if (metadataOnly(options)) {
      return {
        title: 'GoodVibes: budget passed',
        body: `Session cost ${cost} passed the ${budget} budget`,
      };
    }
    const name = trimAtWordBoundary(notificationOptionalText(facts.turnName), NOTIFICATION_TEXT_LIMITS.desktopTitle - 'Budget passed: '.length);
    return {
      title: name ? `Budget passed: ${name}` : 'GoodVibes: budget passed',
      body: `Session cost ${cost} passed the ${budget} session budget${name ? ' during this turn' : ''}`,
    };
  } catch {
    throw new TypeError('Invalid notification facts');
  }
}

// ---------------------------------------------------------------------------
// Per-turn activity tally
// ---------------------------------------------------------------------------

/** Tools whose successful call changes files, and where their paths live. */
const FILE_CHANGING_TOOLS: ReadonlySet<string> = new Set(['write', 'edit']);

/**
 * Counts what one turn did, fed from the runtime event stream by the host:
 * tool calls finished, distinct files written or edited, agents started, the
 * latest review score. reset() at TURN_SUBMITTED, snapshot() at the turn's end.
 */
export class TurnActivityTally {
  private toolCalls = 0;
  private readonly pendingPaths = new Map<string, readonly string[]>();
  private readonly changedFiles = new Set<string>();
  private agents = 0;
  private score: number | null = null;

  reset(): void {
    this.toolCalls = 0;
    this.pendingPaths.clear();
    this.changedFiles.clear();
    this.agents = 0;
    this.score = null;
  }

  /** TOOL_RECEIVED: remember which files a write/edit call names. */
  noteToolReceived(callId: string, tool: string, args: Readonly<Record<string, unknown>> | null | undefined): void {
    if (!FILE_CHANGING_TOOLS.has(tool) || !args) return;
    if (args['dry_run'] === true) return;
    const paths = [...pathsFrom(args['files']), ...pathsFrom(args['edits'])];
    const single = firstString(args['path']);
    if (single) paths.push(single);
    if (paths.length > 0) this.pendingPaths.set(callId, paths);
  }

  /** TOOL_SUCCEEDED: count the call; its files count as changed. */
  noteToolSucceeded(callId: string): void {
    this.toolCalls += 1;
    const paths = this.pendingPaths.get(callId);
    if (paths) for (const path of paths) this.changedFiles.add(path);
    this.pendingPaths.delete(callId);
  }

  /** TOOL_FAILED / TOOL_CANCELLED: count the call; nothing changed. */
  noteToolFailed(callId: string): void {
    this.toolCalls += 1;
    this.pendingPaths.delete(callId);
  }

  /** AGENT_SPAWNING during the turn. */
  noteAgentStarted(): void {
    this.agents += 1;
  }

  /** A host-supplied numeric review score observed during the turn. */
  noteReviewScore(score: number): void {
    if (Number.isFinite(score)) this.score = score;
  }

  snapshot(): { toolCalls: number; filesChanged: number; agentsStarted: number; reviewScore: number | null } {
    return { toolCalls: this.toolCalls, filesChanged: this.changedFiles.size, agentsStarted: this.agents, reviewScore: this.score };
  }
}
