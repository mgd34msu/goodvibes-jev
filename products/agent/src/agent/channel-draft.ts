/**
 * channel-draft.ts
 *
 * Outbox + draft model for channel messages.
 *
 * Provides:
 *   - `ChannelDraft`, a composed-but-not-yet-sent message
 *   - `saveDraft`   , persist a draft, offering it to the daemon first
 *   - `listDrafts`  , read the local mirror
 *   - `fetchDaemonDrafts` / `mergeDraftViews`, the cross-surface view
 *   - `getDraft`    , read one draft by id
 *   - `deleteDraft` , remove a draft, here and on the daemon
 *   - `queueDraftToSend`, promote a draft to a confirmed send input, consuming it
 *
 * A draft is composed on one surface and very often finished on another: the
 * phone writes it, the terminal sends it. So the store of record is the
 * daemon's, `channels.drafts.*`, and this file is a mirror, for the same
 * reason the routing table has one: a draft composed while the daemon was
 * unreachable is work the operator did, and losing it because a peer was busy
 * would be worse than holding it. A held draft says `pending` and carries the
 * daemon's own words.
 *
 * Sends always route through the EXISTING `deliverAgentChannelMessage` path
 * (which wraps `ChannelDeliveryRouter.deliver` via the agent_channel_send
 * confirm pattern). Adopting the daemon's draft STORE does not move where a
 * send happens.
 *
 * Persistence: JSON file at {agentRoot}/channels/drafts.json via ShellPathService.
 */

import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import type { ShellPathService } from '@/runtime/index.ts';
import { writeStoreJson } from '@/utils/store-file.ts';
import { GOODVIBES_AGENT_SURFACE_ROOT } from '../config/surface.ts';
import type { AgentChannelDeliveryInput } from './channel-delivery.ts';
import type { DaemonInvokeFailureKind, DaemonOperatorInvoke } from './daemon-operator-client.ts';

export const CHANNEL_DRAFTS_LIST_METHOD = 'channels.drafts.list';
export const CHANNEL_DRAFTS_SAVE_METHOD = 'channels.drafts.save';
export const CHANNEL_DRAFTS_DELETE_METHOD = 'channels.drafts.delete';

/** Where a draft stands with the daemon's store. */
export type ChannelDraftSyncState = 'synced' | 'pending';

/** The result of offering one draft to the daemon. */
export type ChannelDraftSyncOutcome =
  | { readonly synced: true }
  | { readonly synced: false; readonly kind: DaemonInvokeFailureKind | 'not_attempted'; readonly error: string };

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ChannelDraftStatus = 'draft' | 'queued' | 'sent' | 'failed';

export interface ChannelDraft {
  readonly version: 1;
  readonly id: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly status: ChannelDraftStatus;
  /** Human-readable subject / title. */
  readonly title?: string;
  /** Message body. */
  readonly message: string;
  /** Surface target shorthand: e.g. "slack:ops" */
  readonly channel?: string;
  /** Named route id. */
  readonly route?: string;
  /** Webhook URL (stored redacted-safe, callers must redact before persisting). */
  readonly webhook?: string;
  /** Link address. */
  readonly link?: string;
  /** Optional tags for grouping drafts. */
  readonly tags?: readonly string[];
  /** If the draft was sent, the delivery response id. */
  readonly sentResponseId?: string;
  /** If the draft failed to send, the error message. */
  readonly sendError?: string;
  /** Whether the daemon's store holds this draft, so other surfaces see it. */
  readonly daemonSyncState?: ChannelDraftSyncState;
  /** Why the daemon does not hold it, in the daemon's words. */
  readonly syncError?: string;
  /** Where this view of the draft came from. Never persisted. */
  readonly origin?: 'local' | 'daemon';
}

export interface ChannelDraftSnapshot {
  readonly path: string;
  readonly exists: boolean;
  readonly drafts: readonly ChannelDraft[];
  readonly parseError?: string;
}

export interface ChannelDraftSaveResult {
  readonly draft: ChannelDraft;
  readonly path: string;
  /** What the daemon said when this draft was offered to its store. */
  readonly daemon: ChannelDraftSyncOutcome;
}

export interface ChannelDraftDeleteResult {
  readonly deleted: boolean;
  /** What the daemon said when asked to drop its copy. */
  readonly daemon: ChannelDraftSyncOutcome;
}

export interface ChannelDraftQueueResult {
  /** The draft id that was promoted. */
  readonly draftId: string;
  /** The delivery input ready to pass to deliverAgentChannelMessage. */
  readonly deliveryInput: AgentChannelDeliveryInput;
  /** The updated draft (status: 'queued'). */
  readonly draft: ChannelDraft;
}

// ---------------------------------------------------------------------------
// Internal file model
// ---------------------------------------------------------------------------

interface ChannelDraftFile {
  readonly version: 1;
  readonly drafts: readonly ChannelDraft[];
}

type ShellPaths = Pick<ShellPathService, 'resolveUserPath'>;

const DRAFT_VERSION = 1 as const;
const DRAFT_FILE_VERSION = 1 as const;
const DRAFT_LIMIT = 200;

// ---------------------------------------------------------------------------
// Path
// ---------------------------------------------------------------------------

export function channelDraftFilePath(shellPaths: ShellPaths): string {
  return shellPaths.resolveUserPath(GOODVIBES_AGENT_SURFACE_ROOT, 'channels', 'drafts.json');
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function readOptString(value: unknown): string | undefined {
  const s = readString(value);
  return s || undefined;
}

function parseDraftStatus(value: unknown): ChannelDraftStatus {
  if (value === 'queued' || value === 'sent' || value === 'failed') return value;
  return 'draft';
}

function parseTags(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const tags = value.map(readString).filter(Boolean);
  return tags.length > 0 ? tags : undefined;
}

function parseDraft(value: unknown): ChannelDraft | null {
  if (!isRecord(value) || value.version !== DRAFT_VERSION) return null;
  const id = readString(value.id);
  const createdAt = readString(value.createdAt);
  const updatedAt = readString(value.updatedAt);
  const message = readString(value.message);
  if (!id || !createdAt || !updatedAt || !message) return null;
  if (Number.isNaN(Date.parse(createdAt)) || Number.isNaN(Date.parse(updatedAt))) return null;
  return {
    version: DRAFT_VERSION,
    id,
    createdAt,
    updatedAt,
    status: parseDraftStatus(value.status),
    message,
    ...( readOptString(value.title) ? { title: readOptString(value.title) } : {}),
    ...( readOptString(value.channel) ? { channel: readOptString(value.channel) } : {}),
    ...( readOptString(value.route) ? { route: readOptString(value.route) } : {}),
    ...( readOptString(value.webhook) ? { webhook: readOptString(value.webhook) } : {}),
    ...( readOptString(value.link) ? { link: readOptString(value.link) } : {}),
    ...(parseTags(value.tags) ? { tags: parseTags(value.tags) } : {}),
    ...( readOptString(value.sentResponseId) ? { sentResponseId: readOptString(value.sentResponseId) } : {}),
    ...( readOptString(value.sendError) ? { sendError: readOptString(value.sendError) } : {}),
    // Anything other than an explicit 'synced', including a record written
    // before the daemon held this store, is a draft the daemon has not been
    // told about, which is what pending means.
    daemonSyncState: value.daemonSyncState === 'synced' ? 'synced' : 'pending',
    ...( readOptString(value.syncError) ? { syncError: readOptString(value.syncError) } : {}),
  };
}

/** Strip the fields that describe a VIEW rather than the draft itself. */
function persistableDraft(draft: ChannelDraft): ChannelDraft {
  const { origin: _origin, ...rest } = draft;
  return rest;
}

function parseDraftFile(raw: unknown): ChannelDraftFile {
  if (!isRecord(raw)) return { version: DRAFT_FILE_VERSION, drafts: [] };
  const drafts = Array.isArray(raw.drafts)
    ? raw.drafts.map(parseDraft).filter((d): d is ChannelDraft => d !== null)
    : [];
  return { version: DRAFT_FILE_VERSION, drafts };
}

// ---------------------------------------------------------------------------
// Read / write helpers
// ---------------------------------------------------------------------------

export function readChannelDrafts(shellPaths: ShellPaths): ChannelDraftSnapshot {
  const path = channelDraftFilePath(shellPaths);
  if (!existsSync(path)) return { path, exists: false, drafts: [] };
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as unknown;
    return { path, exists: true, drafts: parseDraftFile(parsed).drafts };
  } catch (error) {
    return {
      path,
      exists: true,
      drafts: [],
      parseError: error instanceof Error ? error.message : String(error),
    };
  }
}

function writeDrafts(path: string, drafts: readonly ChannelDraft[]): void {
  const file: ChannelDraftFile = {
    version: DRAFT_FILE_VERSION,
    drafts: drafts.slice(0, DRAFT_LIMIT).map(persistableDraft),
  };
  writeStoreJson(path, file);
}

function generateDraftId(): string {
  const ts = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);
  return `draft-${ts}-${randomUUID().slice(0, 8)}`;
}

function draftDigest(message: string): string {
  return createHash('sha256').update(message).digest('hex').slice(0, 12);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

const NOT_ATTEMPTED: ChannelDraftSyncOutcome = {
  synced: false,
  kind: 'not_attempted',
  error: 'no connected-host transport was supplied, so the daemon was not offered this draft',
};

/**
 * Offer a draft to the daemon's store, so other surfaces can see it.
 *
 * `confirm: true` plus the explicit-user-request claim is the daemon's
 * confirmation gate. Honest here: a draft only reaches this path through the
 * harness's confirmed-action gate, where the operator asked for the save.
 */
async function offerDraftToDaemon(
  invoke: DaemonOperatorInvoke | undefined,
  draft: ChannelDraft,
): Promise<ChannelDraftSyncOutcome> {
  if (!invoke) return NOT_ATTEMPTED;
  const { daemonSyncState: _state, syncError: _error, origin: _origin, ...wire } = draft;
  const result = await invoke(
    CHANNEL_DRAFTS_SAVE_METHOD,
    { ...wire, confirm: true },
    { explicitUserRequest: true },
  );
  return result.ok ? { synced: true } : { synced: false, kind: result.kind, error: result.error };
}

function withDraftSyncOutcome(draft: ChannelDraft, outcome: ChannelDraftSyncOutcome): ChannelDraft {
  if (outcome.synced) {
    const { syncError: _dropped, ...rest } = draft;
    return { ...rest, daemonSyncState: 'synced' };
  }
  return { ...draft, daemonSyncState: 'pending', syncError: outcome.error };
}

/**
 * Save a new draft or overwrite an existing draft by id.
 *
 * If `id` is provided in `input` and a draft with that id exists, it is
 * updated in-place (updatedAt refreshed). Otherwise a new draft is created.
 *
 * The daemon is offered the draft first, because a draft only reaches the
 * surface that finishes it if the daemon holds it. The local write happens
 * either way, the composition is the operator's work, and a daemon that could
 * not be reached is a reason to hold it, not to lose it.
 */
export async function saveDraft(
  shellPaths: ShellPaths,
  input: {
    readonly id?: string;
    readonly title?: string;
    readonly message: string;
    readonly channel?: string;
    readonly route?: string;
    readonly webhook?: string;
    readonly link?: string;
    readonly tags?: readonly string[];
    readonly status?: ChannelDraftStatus;
  },
  options: { readonly invoke?: DaemonOperatorInvoke } = {},
): Promise<ChannelDraftSaveResult> {
  const message = input.message.trim();
  if (!message) throw new Error('Draft message is required.');

  const snapshot = readChannelDrafts(shellPaths);
  const path = channelDraftFilePath(shellPaths);
  const now = new Date().toISOString();

  const existingIndex = input.id ? snapshot.drafts.findIndex((d) => d.id === input.id) : -1;
  const existing = existingIndex >= 0 ? snapshot.drafts[existingIndex] : null;

  const drafted: ChannelDraft = {
    version: DRAFT_VERSION,
    id: existing?.id ?? generateDraftId(),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    status: input.status ?? existing?.status ?? 'draft',
    message,
    ...(input.title?.trim() ? { title: input.title.trim() } : {}),
    ...(input.channel?.trim() ? { channel: input.channel.trim() } : {}),
    ...(input.route?.trim() ? { route: input.route.trim() } : {}),
    ...(input.webhook?.trim() ? { webhook: input.webhook.trim() } : {}),
    ...(input.link?.trim() ? { link: input.link.trim() } : {}),
    ...(input.tags && input.tags.length > 0 ? { tags: input.tags } : {}),
  };

  const daemon = await offerDraftToDaemon(options.invoke, drafted);
  const draft = withDraftSyncOutcome(drafted, daemon);

  let updatedDrafts: readonly ChannelDraft[];
  if (existingIndex >= 0) {
    updatedDrafts = snapshot.drafts.map((d, i) => (i === existingIndex ? draft : d));
  } else {
    // Prepend new draft (most recent first)
    updatedDrafts = [draft, ...snapshot.drafts];
  }

  writeDrafts(path, updatedDrafts);
  return { draft, path, daemon };
}

/**
 * The daemon's drafts, when it will serve them.
 *
 * Returns null rather than an empty list when the daemon does not answer: an
 * empty list would read as "no drafts anywhere" and hide the ones the local
 * mirror is holding.
 */
export async function fetchDaemonDrafts(
  invoke: DaemonOperatorInvoke,
  options: { readonly status?: ChannelDraftStatus; readonly limit?: number } = {},
): Promise<{ readonly drafts: readonly ChannelDraft[] } | { readonly error: string; readonly kind: DaemonInvokeFailureKind }> {
  const result = await invoke(CHANNEL_DRAFTS_LIST_METHOD, {
    ...(options.status ? { status: options.status } : {}),
    ...(typeof options.limit === 'number' ? { limit: options.limit } : {}),
  });
  if (!result.ok) return { error: result.error, kind: result.kind };
  if (!isRecord(result.body) || !Array.isArray(result.body.drafts)) {
    return { error: `${CHANNEL_DRAFTS_LIST_METHOD} answered without a drafts array`, kind: 'connected_host_error' };
  }
  const drafts = (result.body.drafts as unknown[])
    .map(parseDraft)
    .filter((d): d is ChannelDraft => d !== null)
    .map((d) => ({ ...d, daemonSyncState: 'synced' as const, origin: 'daemon' as const }));
  return { drafts };
}

/**
 * One list from two stores.
 *
 * The daemon's copy wins for an id both hold, it is the store of record, and
 * it is what the other surfaces are looking at. A draft only the local mirror
 * has is kept and shown as pending, because that is exactly the draft an
 * operator would otherwise think they had lost.
 */
export function mergeDraftViews(
  daemonDrafts: readonly ChannelDraft[],
  localDrafts: readonly ChannelDraft[],
): readonly ChannelDraft[] {
  const byId = new Map<string, ChannelDraft>();
  for (const draft of localDrafts) byId.set(draft.id, { ...draft, origin: 'local' });
  for (const draft of daemonDrafts) byId.set(draft.id, draft);
  return [...byId.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** List all drafts, optionally filtered by status. */
export function listDrafts(
  shellPaths: ShellPaths,
  options: { readonly status?: ChannelDraftStatus; readonly limit?: number } = {},
): ChannelDraftSnapshot {
  const snapshot = readChannelDrafts(shellPaths);
  let drafts = snapshot.drafts;
  if (options.status) {
    drafts = drafts.filter((d) => d.status === options.status);
  }
  if (typeof options.limit === 'number' && options.limit > 0) {
    drafts = drafts.slice(0, options.limit);
  }
  return { ...snapshot, drafts };
}

/** Get a single draft by id. Returns null if not found. */
export function getDraft(shellPaths: ShellPaths, draftId: string): ChannelDraft | null {
  const snapshot = readChannelDrafts(shellPaths);
  return snapshot.drafts.find((d) => d.id === draftId) ?? null;
}

/**
 * Delete a draft by id, here and in the daemon's store.
 *
 * The local copy goes even when the daemon refuses. A delete the operator asked
 * for that half-happens is confusing in one direction only: the draft
 * reappearing on this surface after they deleted it is worse than it lingering
 * on another until the next sync. The daemon's answer is reported either way,
 * so a caller can say which happened.
 */
export async function deleteDraft(
  shellPaths: ShellPaths,
  draftId: string,
  options: { readonly invoke?: DaemonOperatorInvoke } = {},
): Promise<ChannelDraftDeleteResult> {
  const daemon: ChannelDraftSyncOutcome = options.invoke
    ? await (async () => {
        const result = await options.invoke!(
          CHANNEL_DRAFTS_DELETE_METHOD,
          { draftId, confirm: true },
          { explicitUserRequest: true },
        );
        return result.ok
          ? { synced: true as const }
          : { synced: false as const, kind: result.kind, error: result.error };
      })()
    : NOT_ATTEMPTED;

  const snapshot = readChannelDrafts(shellPaths);
  const before = snapshot.drafts.length;
  const updated = snapshot.drafts.filter((d) => d.id !== draftId);
  if (updated.length === before) return { deleted: false, daemon };
  writeDrafts(channelDraftFilePath(shellPaths), updated);
  return { deleted: true, daemon };
}

export interface ChannelDraftSyncReport {
  readonly attempted: number;
  readonly synced: number;
  readonly refused: number;
}

/**
 * Offer every draft the daemon does not hold.
 *
 * The retry for drafts composed while the daemon was unreachable, and the
 * migration for drafts written before the daemon held this store, the same
 * operation either way: a draft the daemon does not have, offered to it.
 */
export async function syncChannelDrafts(
  shellPaths: ShellPaths,
  invoke: DaemonOperatorInvoke,
): Promise<ChannelDraftSyncReport> {
  const snapshot = readChannelDrafts(shellPaths);
  const pending = snapshot.drafts.filter((draft) => draft.daemonSyncState !== 'synced');
  if (pending.length === 0) return { attempted: 0, synced: 0, refused: 0 };

  const updatedById = new Map<string, ChannelDraft>();
  let synced = 0;
  let refused = 0;
  for (const draft of pending) {
    const outcome = await offerDraftToDaemon(invoke, draft);
    updatedById.set(draft.id, withDraftSyncOutcome(draft, outcome));
    if (outcome.synced) synced += 1;
    else refused += 1;
  }
  writeDrafts(
    channelDraftFilePath(shellPaths),
    snapshot.drafts.map((draft) => updatedById.get(draft.id) ?? draft),
  );
  return { attempted: pending.length, synced, refused };
}

/**
 * Promote a draft to 'queued' status and return an AgentChannelDeliveryInput
 * ready to pass to `deliverAgentChannelMessage`.
 *
 * The draft is updated to status 'queued'. The caller is responsible for
 * calling `deliverAgentChannelMessage` and then `markDraftSent` or
 * `markDraftFailed` to record the outcome.
 *
 * This routes through the EXISTING confirmed send path, no new SDK contract.
 */
export async function queueDraftToSend(
  shellPaths: ShellPaths,
  draftId: string,
  options: { readonly invoke?: DaemonOperatorInvoke } = {},
): Promise<ChannelDraftQueueResult> {
  const draft = getDraft(shellPaths, draftId);
  if (!draft) throw new Error(`Draft not found: ${draftId}`);
  if (draft.status === 'sent') throw new Error(`Draft ${draftId} is already sent.`);

  const deliveryInput: AgentChannelDeliveryInput = {
    message: draft.message,
    ...(draft.title ? { title: draft.title } : {}),
    ...(draft.channel ? { channel: draft.channel } : {}),
    ...(draft.route ? { route: draft.route } : {}),
    ...(draft.webhook ? { webhook: draft.webhook } : {}),
    ...(draft.link ? { link: draft.link } : {}),
  };

  const queuedDraft = (await saveDraft(
    shellPaths,
    {
      id: draft.id,
      ...deliveryInput,
      ...(draft.title ? { title: draft.title } : {}),
      ...(draft.tags ? { tags: draft.tags } : {}),
      status: 'queued',
    },
    options,
  )).draft;

  return { draftId, deliveryInput, draft: queuedDraft };
}

/**
 * Mark a draft as successfully sent. Records the response id from the delivery.
 */
export function markDraftSent(
  shellPaths: ShellPaths,
  draftId: string,
  responseId?: string,
): ChannelDraft {
  const snapshot = readChannelDrafts(shellPaths);
  const existing = snapshot.drafts.find((d) => d.id === draftId);
  if (!existing) throw new Error(`Draft not found: ${draftId}`);
  const now = new Date().toISOString();
  const patched: ChannelDraft = {
    ...existing,
    updatedAt: now,
    status: 'sent',
    ...(responseId ? { sentResponseId: responseId } : {}),
  };
  const updatedDrafts = snapshot.drafts.map((d) => (d.id === draftId ? patched : d));
  writeDrafts(channelDraftFilePath(shellPaths), updatedDrafts);
  return patched;
}

/**
 * Mark a draft as failed to send. Records the error message.
 */
export function markDraftFailed(
  shellPaths: ShellPaths,
  draftId: string,
  error: string,
): ChannelDraft {
  const snapshot = readChannelDrafts(shellPaths);
  const existing = snapshot.drafts.find((d) => d.id === draftId);
  if (!existing) throw new Error(`Draft not found: ${draftId}`);
  const now = new Date().toISOString();
  const patched: ChannelDraft = {
    ...existing,
    updatedAt: now,
    status: 'failed',
    sendError: error,
  };
  const updatedDrafts = snapshot.drafts.map((d) => (d.id === draftId ? patched : d));
  writeDrafts(channelDraftFilePath(shellPaths), updatedDrafts);
  return patched;
}

/** Format a single draft for human-readable display. */
export function formatChannelDraft(draft: ChannelDraft): string {
  const targetPart = draft.channel
    ? `channel=${draft.channel}`
    : draft.route
      ? `route=${draft.route}`
      : draft.webhook
        ? 'webhook=[redacted]'
        : draft.link
          ? `link=${draft.link}`
          : 'no-target';
  const digest = draftDigest(draft.message);
  const lines = [
    `draft ${draft.id}`,
    `  status: ${draft.status}`,
    `  target: ${targetPart}`,
    ...(draft.title ? [`  title: ${draft.title}`] : []),
    `  message: ${draft.message.length} chars sha256:${digest}`,
    `  created: ${draft.createdAt}  updated: ${draft.updatedAt}`,
    ...(draft.tags && draft.tags.length > 0 ? [`  tags: ${draft.tags.join(', ')}`] : []),
    ...(draft.sentResponseId ? [`  sent response: ${draft.sentResponseId}`] : []),
    ...(draft.sendError ? [`  error: ${draft.sendError}`] : []),
  ];
  return lines.join('\n');
}

/** Format the draft list summary. */
export function formatChannelDraftList(snapshot: ChannelDraftSnapshot): string {
  const lines = [
    'Channel Drafts',
    `  path: ${snapshot.path}`,
    `  total: ${snapshot.drafts.length}`,
    `  status: ${snapshot.parseError ? 'attention' : snapshot.exists ? 'ready' : 'empty'}`,
    ...(snapshot.parseError ? [`  parse error: ${snapshot.parseError}`] : []),
    '  policy: drafts are agent-local; sends require queueDraftToSend + deliverAgentChannelMessage with explicit user confirmation',
    '',
  ];
  if (snapshot.drafts.length === 0) {
    lines.push('  no drafts');
  } else {
    for (const draft of snapshot.drafts) {
      const targetPart = draft.channel ?? draft.route ?? (draft.webhook ? 'webhook=[redacted]' : null) ?? draft.link ?? 'no-target';
      lines.push(`  [${draft.status}] ${draft.id}  target=${targetPart}  ${draft.message.slice(0, 60)}${draft.message.length > 60 ? '...' : ''}`);
    }
  }
  return lines.join('\n');
}
