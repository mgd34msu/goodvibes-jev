import type { HostedSessionFeed } from '../../views/hosted-session-feed.ts';
import type { HostedSessionAttachment, HostedSessionRecord, HostedSessionsClient } from './hosted-sessions.ts';

interface Ownership {
  tail: Promise<void>;
  closing: boolean;
  generation: number;
  pendingReplacements: number;
  closeResult?: Promise<boolean>;
  streamAbort: AbortController | null;
  readonly sessions: Map<string, HostedSessionsClient>;
}
const owners = new WeakMap<HostedSessionFeed, Ownership>();
function owner(feed: HostedSessionFeed, client: HostedSessionsClient): Ownership {
  let state = owners.get(feed);
  if (!state) {
    state = { tail: Promise.resolve(), closing: false, generation: 0, pendingReplacements: 0, streamAbort: null, sessions: new Map() };
    owners.set(feed, state);
    const current = feed.getState().record;
    if (current && current.status !== 'terminated') state.sessions.set(current.id, client);
  }
  return state;
}
function enqueue<T>(state: Ownership, operation: () => Promise<T>): Promise<T> {
  const result = state.tail.then(operation);
  state.tail = result.then(() => {}, () => {});
  return result;
}
const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error);
async function release(state: Ownership, id: string): Promise<HostedSessionRecord> {
  const client = state.sessions.get(id);
  if (!client) throw new Error(`No owned hosted attachment for ${id}`);
  const record = await client.detach(id);
  state.sessions.delete(id);
  return record;
}

/** One remote attachment owner per feed; failed cleanup stays tracked for retry/exit. */
export function replaceHostedAttachment(
  feed: HostedSessionFeed,
  client: HostedSessionsClient,
  target: string | (() => Promise<HostedSessionRecord>),
  openStream: (attachment: HostedSessionAttachment, signal: AbortSignal) => Promise<void>,
): Promise<HostedSessionAttachment> {
  const state = owner(feed, client);
  const generation = state.generation;
  state.pendingReplacements++;
  return enqueue(state, async () => {
    if (state.closing || generation !== state.generation) throw new Error('Hosted attachment is closing');
    const previousId = feed.getState().record?.id ?? null;
    const pending = [...state.sessions.keys()].filter(id => id !== previousId);
    if (pending.length && (typeof target !== 'string' || !pending.includes(target))) {
      throw new Error(`Hosted attachment ${pending.join(', ')} still needs cleanup; retry that attachment or detach before opening another`);
    }
    let targetId = typeof target === 'string' ? target : null;
    try {
      if (typeof target === 'function') {
        const created = await target();
        targetId = created.id;
        state.sessions.set(targetId, client); // create already attaches this client
      }
      if (state.closing || generation !== state.generation) throw new Error('Hosted attachment closed while creating the session');
      const attachment = await client.attach(targetId!);
      state.sessions.set(attachment.session.id, client);
      targetId = attachment.session.id;
      if (state.closing || generation !== state.generation) throw new Error('Hosted attachment closed while attaching');
      if (previousId && previousId !== targetId && state.sessions.has(previousId)) await release(state, previousId);
      if (state.closing || generation !== state.generation) throw new Error('Hosted attachment closed while switching');
      state.streamAbort?.abort();
      let streamCloseFailure: unknown;
      try { feed.closeStream(); } catch (error) { streamCloseFailure = error; }
      feed.attach(attachment.session, attachment.history);
      const abort = new AbortController();
      state.streamAbort = abort;
      await openStream(attachment, abort.signal);
      if (state.closing || generation !== state.generation) throw new Error('Hosted attachment closed while opening its stream');
      if (streamCloseFailure) throw new Error(`Attached ${targetId}, but the previous stream cleanup failed: ${errorText(streamCloseFailure)}`);
      return attachment;
    } catch (error) {
      // A failed transfer must not kill the new session by implicitly applying
      // kill-on-last-detach. Keep at most one pending receipt, visible in the
      // refusal, for explicit retry/detach or final shutdown.
      if (!state.closing && targetId && state.sessions.has(targetId) && feed.getState().record?.id !== targetId) {
        throw new Error(`${errorText(error)}; attachment ${targetId} remains owned pending cleanup. Retry attach ${targetId} or detach to release it`);
      }
      throw error;
    }
  }).finally(() => { state.pendingReplacements--; });
}

export function hasHostedAttachments(feed: HostedSessionFeed): boolean {
  const state = owners.get(feed);
  return Boolean(feed.getState().record || (state && (state.sessions.size || state.pendingReplacements)));
}

async function releaseAll(feed: HostedSessionFeed, state: Ownership): Promise<HostedSessionRecord | null> {
  let currentResult: HostedSessionRecord | null = null;
  const current = feed.getState().record;
  const currentId = current?.id;
  if (current?.status === 'terminated') state.sessions.delete(current.id);
  const errors: string[] = [];
  for (const id of [...state.sessions.keys()]) {
    try { const record = await release(state, id); if (id === currentId || currentResult === null) currentResult = record; }
    catch (error) { errors.push(`${id}: ${errorText(error)}`); }
  }
  if (!currentId || !state.sessions.has(currentId)) feed.clear();
  if (errors.length) throw new Error(`Hosted detach failed: ${errors.join('; ')}`);
  return currentResult;
}

export function detachHostedAttachments(feed: HostedSessionFeed, client: HostedSessionsClient): Promise<HostedSessionRecord | null> {
  const state = owner(feed, client);
  state.generation++;
  state.streamAbort?.abort();
  return enqueue(state, async () => {
    if (state.closing) throw new Error('Hosted attachment is closing');
    return releaseAll(feed, state);
  });
}

/** Stops admission synchronously, then drains remote receipts, without killing sessions. */
export function closeHostedAttachments(feed: HostedSessionFeed, client: HostedSessionsClient): Promise<boolean> {
  const state = owner(feed, client);
  if (state.closeResult) return state.closeResult;
  state.closing = true;
  state.generation++;
  state.streamAbort?.abort();
  let streamError: unknown;
  try { feed.closeStream(); } catch (error) { streamError = error; }
  state.closeResult = enqueue(state, async () => {
    const detached = await releaseAll(feed, state);
    if (streamError) throw streamError;
    return detached !== null;
  });
  return state.closeResult;
}

export function forgetHostedAttachment(feed: HostedSessionFeed, sessionId: string): void {
  owners.get(feed)?.sessions.delete(sessionId);
}
