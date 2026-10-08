/** Explicit account-owned email intake over canonical mail and source screening. */
import { createHash } from 'node:crypto';
import { types } from 'node:util';
import { EmailCredentialUnavailableError } from '../../email/email-config.js';
import type { EmailService } from '../../email/email-service.js';
import type { EmailMailboxObservation } from '../../email/reply-subject-source.js';
import { createProtectedSourceOwner } from '../../security/source-screening/owner.js';
import type { ProtectedSourceOwnerOptions, ProtectedSource } from '../../security/source-screening/types.js';
import { digestSender, normalizeWhitespace, stripMarkup } from '../text-normalization.js';
import { POLL_CADENCE_MS, type ImapUidCheckpoint, type InboundChannelItem, type InboundProviderAdapter, type ProviderPollOptions, type ProviderPollResult } from '../provider-adapter.js';

export interface EmailInboxAccount {
  readonly host: string;
  readonly port: number;
  readonly username: string;
  readonly mailbox: string;
  readonly security: 'tls';
}
export interface EmailInboxOwnerOptions {
  readonly account: EmailInboxAccount;
  /** Real canonical service with synchronous account/config/secret lifecycle. */
  readonly service: EmailService;
  readonly screening: ProtectedSourceOwnerOptions;
  readonly assertCurrent: () => void;
  /** Read-only view of the actual durable inbox checkpoint, supplied by its registrar. */
  readonly getCheckpoint: () => ImapUidCheckpoint | null;
  readonly signal?: AbortSignal;
}
export interface EmailInboxOwner {
  readonly account: EmailInboxAccount;
  readonly scopeId: string;
  readonly adapter: InboundProviderAdapter;
  assertReadCurrent(): Promise<void>;
  acquireReadLease(): Promise<() => Promise<void>>;
  close(): Promise<void>;
}

function captureAccount(input: EmailInboxAccount): EmailInboxAccount {
  if (!input || typeof input !== 'object' || types.isProxy(input)) throw new Error('Email inbox account is invalid');
  const fields = Object.getOwnPropertyDescriptors(input);
  if (Reflect.ownKeys(fields).length !== 5 || Object.values(fields).some(field => !('value' in field))) throw new Error('Email inbox account is invalid');
  const { host, username, mailbox, port, security } = input;
  if (![host, username, mailbox].every(value => typeof value === 'string' && value.length > 0 && value.length <= 320 && value.trim() === value)
    || !Number.isInteger(port) || port < 1 || port > 65535 || security !== 'tls') throw new Error('Email inbox account is invalid');
  return Object.freeze({ host, username, mailbox, port, security });
}
function prefix(text: string, length: number): string {
  let end = Math.min(length, text.length);
  if (end < text.length && text.charCodeAt(end - 1) >= 0xd800 && text.charCodeAt(end - 1) <= 0xdbff
    && text.charCodeAt(end) >= 0xdc00 && text.charCodeAt(end) <= 0xdfff) end--;
  return text.slice(0, end);
}
function sync(assert: () => void): void {
  const result: unknown = assert();
  if (result !== undefined) {
    if (types.isPromise(result)) void result.catch(() => {});
    throw new Error('Email inbox requires synchronous currentness');
  }
}
function unavailable(configured?: boolean): ProviderPollResult {
  return { items: [], state: 'unavailable', error: 'Email inbox account or complete source is unavailable',
    ...(configured === undefined ? {} : { configured }) };
}

/** No credentials or provider calls happen during construction. */
export function createEmailInboxOwner(options: EmailInboxOwnerOptions): EmailInboxOwner {
  const account = captureAccount(options.account);
  const service = options.service;
  const assertScope = options.assertCurrent;
  const getCheckpoint = options.getCheckpoint;
  const scopeId = createHash('sha256').update(JSON.stringify(['email-inbox', 1, account])).digest('hex');
  const lifetime = new AbortController();
  const signal = AbortSignal.any([lifetime.signal, options.screening.authority.signal, ...(options.signal ? [options.signal] : [])]);
  const active = new Set<Promise<unknown>>();
  let closed = false, closing: Promise<void> | undefined;
  let screeningObservation: EmailMailboxObservation | undefined;
  let commitObservation: EmailMailboxObservation | undefined;
  let pollSignal: AbortSignal | undefined;
  let polling: Promise<ProviderPollResult> | undefined;
  const current = (): void => {
    if (closed || signal.aborted) throw new Error('Email inbox scope is unavailable');
    sync(assertScope);
    const config = service.getInboxReadStatus().config;
    if (!config.enabled || config.imapHost !== account.host || config.imapPort !== account.port
      || config.username !== account.username || (config.mailbox.trim() || 'INBOX') !== account.mailbox
      || (config.imapSecurity ?? 'tls') !== account.security) throw new Error('Email inbox account scope changed');
    if (closed || signal.aborted) throw new Error('Email inbox scope is unavailable');
  };
  current();
  const authority = options.screening.authority;
  const assertAuthority = authority.assertCurrent;
  const screening = createProtectedSourceOwner({ ...options.screening, authority: { ...authority, signal,
    assertCurrent() { current(); sync(() => assertAuthority.call(authority)); screeningObservation?.assertCurrent(); },
  } });
  const own = <T>(action: () => Promise<T>): Promise<T> => {
    const work = Promise.resolve().then(() => { current(); return action(); });
    active.add(work); void work.then(() => active.delete(work), () => active.delete(work)); return work;
  };
  const adapter: InboundProviderAdapter = {
    id: 'email', pollIntervalMs: POLL_CADENCE_MS.email, checkpointKind: 'imap-uid',
    assertCurrent() {
      current(); sync(() => assertAuthority.call(authority));
      if (!commitObservation || pollSignal?.aborted) throw new Error('Email inbox poll source is unavailable');
      commitObservation.assertCurrent();
    },
    poll(input: ProviderPollOptions): Promise<ProviderPollResult> {
      if (polling) return polling;
      const operationSignal = AbortSignal.any([signal, ...(input.signal ? [input.signal] : [])]);
      commitObservation = undefined; pollSignal = operationSignal;
      const work = own(async (): Promise<ProviderPollResult> => {
        if (!service.getInboxReadStatus().ready) return unavailable(false);
        const result = await service.readInboxPage({ checkpoint: input.checkpoint, limit: input.limit, signal: operationSignal });
        current(); if (operationSignal.aborted) return unavailable(true);
        if (result.outcome === 'incomplete') return unavailable(true);
        const observation = service.getInboxMailboxObservation(result);
        if (!observation || observation.mailbox !== account.mailbox) return unavailable(true);
        observation.assertCurrent();
        if (result.outcome === 'checkpoint-required') {
          commitObservation = observation;
          return { items: [], state: result.pending > 0 ? 'pending' : 'empty', configured: true, pendingMessages: result.pending,
            checkpointAdvance: { kind: 'imap-uid', transition: result.transition, previous: result.previous,
              next: result.next, coveredUids: [], terminal: [] } };
        }
        const items: InboundChannelItem[] = [];
        for (const message of result.messages) {
          current(); observation.assertCurrent(); if (operationSignal.aborted) return unavailable(true);
          screeningObservation = observation;
          const source = message.source;
          const body = source.detail.bodyText || source.detail.bodyHtml;
          let captured: ProtectedSource | undefined;
          let release: Promise<void> | undefined;
          const retire = (): Promise<void> => release ??= captured ? screening.release(captured) : Promise.resolve();
          const abort = (): void => { void retire().catch(() => {}); };
          try {
            captured = screening.capture([source.rawHeaders, source.rawBodyStructure,
              source.textSections.map(section => section.text).join('\n'),
              normalizeWhitespace(stripMarkup(source.detail.subject)), normalizeWhitespace(stripMarkup(body))]);
            operationSignal.addEventListener('abort', abort, { once: true });
            observation.signal.addEventListener('abort', abort, { once: true });
            if (operationSignal.aborted || observation.signal.aborted) abort();
            const judged = await screening.screen(captured);
            current(); observation.assertCurrent();
            if (operationSignal.aborted || judged.status !== 'settled') return unavailable(true);
            const projected = screening.project(judged.receipt);
            const uid = source.detail.uid;
            items.push({ id: `email:${scopeId}:${String(observation.uidValidity).padStart(10, '0')}:${String(uid).padStart(10, '0')}`,
              provider: 'email', kind: 'dm' as const, fromDigest: digestSender(`email:${source.detail.from.trim().toLowerCase()}`),
              subjectPreview: prefix(projected[3]!, 200), bodyPreview: prefix(projected[4]!, 500),
              receivedAt: Date.now(), unread: message.unread });
          } finally {
            operationSignal.removeEventListener('abort', abort); observation.signal.removeEventListener('abort', abort);
            await retire(); screeningObservation = undefined;
          }
        }
        current(); observation.assertCurrent(); if (operationSignal.aborted) return unavailable(true);
        commitObservation = observation;
        const finalUid = result.coveredUids.at(-1) ?? result.checkpoint.lastTerminalUid;
        return { items, state: items.length > 0 ? 'ready' : 'empty', configured: true, pendingMessages: result.pending - result.messages.length,
          checkpointAdvance: { kind: 'imap-uid', transition: 'advance', previous: result.checkpoint,
            next: { ...result.checkpoint, lastTerminalUid: finalUid }, coveredUids: result.coveredUids,
            terminal: result.coveredUids.map((uid, index) => ({ uid, disposition: 'published' as const, itemId: items[index]!.id })) } };
      }).catch((error: unknown) => unavailable(error instanceof EmailCredentialUnavailableError ? false : undefined));
      polling = work;
      void work.then(() => { if (polling === work) polling = undefined; });
      return work;
    },
  };
  const verifyRead = (): Promise<EmailMailboxObservation> => own(async () => {
    const result = await service.readInboxPage({ limit: 1, signal });
    current();
    if (result.outcome === 'incomplete') throw new Error('Email inbox account scope is unavailable');
    const observation = service.getInboxMailboxObservation(result);
    if (!observation) throw new Error('Email inbox account scope is unavailable');
    observation.assertCurrent(); sync(() => assertAuthority.call(authority));
    const checkpoint = getCheckpoint();
    if (!checkpoint || checkpoint.uidValidity !== observation.uidValidity) throw new Error('Email inbox generation has not been committed');
    return observation;
  });
  return {
    account, scopeId, adapter,
    async assertReadCurrent() { await verifyRead(); },
    async acquireReadLease() {
      const original = await verifyRead();
      return async () => {
        const latest = await verifyRead();
        current(); original.assertCurrent();
        if (latest.accountRevision !== original.accountRevision || latest.uidValidity !== original.uidValidity) {
          throw new Error('Email inbox read generation changed');
        }
      };
    },
    close() {
      if (!closing) {
        closed = true;
        let resolve!: () => void, reject!: (reason: unknown) => void;
        closing = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
        lifetime.abort();
        const retiring = screening.close();
        void Promise.allSettled([...active]).then(() => retiring).then(resolve,
          () => reject(new Error('Email inbox owner did not close cleanly')));
        void retiring.catch(() => {});
      }
      return closing;
    },
  };
}
