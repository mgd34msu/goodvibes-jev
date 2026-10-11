import { createHash, randomUUID } from 'node:crypto';
import type { JudgmentPort } from '@goodvibes-jev/judgment';
import type { IntakeCredentialStore } from '../../context.js';
import { applySlackReactions } from './slack.js';
import { applyDiscordTagEffects, observeDiscordForumTags } from './discord.js';
import { makeRetryingImapStoreFlag, imapStoreFlagOverTls, type ImapStoreFlag } from './imap.js';
import { TAGS, current, type TaggerGuard, type TaggerHttp, type TriageProviderTag } from './shared.js';
import { captureTriageData } from '../evidence.js';
import { captureTagNames, readCustomTagMeaning, TriageTagMeaningHeld } from './meaning.js';
export type { TriageProviderTag, TaggerGuard } from './shared.js';
export type { ImapStoreArgs, ImapStoreFlag, ImapRetryOptions } from './imap.js';
export interface TriageTaggerOptions {
  readonly provider: 'slack' | 'discord' | 'email';
  readonly accountScopeId: string;
  readonly credentials: IntakeCredentialStore;
  readonly credentialKey: string;
  /** Synchronous exact credential/config generation guard, including aliases and ABA. */
  readonly captureCredential: () => { readonly value: string; assertCurrent(): void };
  readonly signal: AbortSignal;
  readonly assertCurrent: () => void;
  readonly imap?: { readonly host: string; readonly port: number; readonly user: string; readonly mailbox: string };
  readonly forumTagIds?: Readonly<Record<string, string>>;
  /** Constructor-owned recorded port; required only for noncanonical reaction meaning. */
  readonly port?: JudgmentPort;
  readonly http?: TaggerHttp;
  readonly imapStoreFlag?: ImapStoreFlag;
}
export interface TriageTagEffect {
  readonly tag: string;
  readonly mode: 'imap-keyword' | 'slack-reaction' | 'discord-forum-or-reaction' | 'discord-forum-tag' | 'discord-reaction' | 'discord-unmapped-noop';
  readonly keyword?: string;
  readonly reaction?: string;
  /** Opaque binding to an exact configured forum ID; actual snowflake remains local. */
  readonly forumTagRef?: string;
}
export interface PreparedTriageTags {
  readonly effects: readonly TriageTagEffect[];
  readonly judgmentDecisionIds: readonly string[];
  assertCurrent(): void; applyTags(guard: TaggerGuard): Promise<void>;
}
export interface TriageTagger {
  readonly provider: TriageTaggerOptions['provider'];
  readonly accountScopeId: string;
  prepareTags(itemId: string, tags: readonly string[], guard: TaggerGuard): Promise<PreparedTriageTags>;
  applyTags(itemId: string, tags: readonly string[], guard: TaggerGuard): Promise<void>;
  close(): Promise<void>;
}
/** Constructor-only capability: the owned caller supplies authentic admission guards. */
export function createTriageTagger(input: TriageTaggerOptions): TriageTagger {
  if (!['slack', 'discord', 'email'].includes(input.provider) || typeof input.accountScopeId !== 'string' || !input.accountScopeId) throw new TypeError('Triage tagger requires one supported provider and account scope');
  const forumTagIds = captureTriageData(input.forumTagIds ?? {}) as Readonly<Record<string, string>>;
  if (!forumTagIds || typeof forumTagIds !== 'object' || Array.isArray(forumTagIds)
    || Object.keys(forumTagIds).length > 256 || Object.entries(forumTagIds).some(([name, id]) => !name || name.length > 256 || typeof id !== 'string' || !/^[0-9]+$/.test(id))) throw new TypeError('Invalid triage forum mapping');
  const options = Object.freeze({ ...input, forumTagIds, ...(input.imap ? { imap: Object.freeze({ ...input.imap }) } : {}) });
  const resolve = options.credentials.resolveConfigSecret.bind(options.credentials);
  const capture = options.captureCredential;
  const lifetime = new AbortController();
  const active = new Set<Promise<unknown>>();
  // An unsettled identical custom name cannot be resampled into a lucky answer.
  // Only bounded digests remain; scope ends with this account tagger's lifetime.
  const heldMeanings = new Set<string>();
  const pendingMeanings = new Set<string>();
  let closing: Promise<void> | undefined;
  const store = makeRetryingImapStoreFlag(options.imapStoreFlag ?? imapStoreFlagOverTls);
  const owner: TriageTagger = {
    provider: options.provider, accountScopeId: options.accountScopeId,
    async applyTags(itemId, rawTags, operation) { const prepared = await owner.prepareTags(itemId, rawTags, operation); return prepared.applyTags(operation); },
    prepareTags(itemId, rawTags, operation) {
      const tags = captureTagNames(rawTags);
      const proof = operation.assertCurrent.bind(operation);
      const signal = AbortSignal.any([lifetime.signal, options.signal, operation.signal, AbortSignal.timeout(20_000)]);
      const guard = { signal, assertCurrent() { current({ signal, assertCurrent: options.assertCurrent }); proof(); } };
      const preparation = Promise.resolve().then(async (): Promise<PreparedTriageTags> => {
        current(guard);
        // Targets are protocol data. Reject malformed/foreign targets before
        // credential resolution or any custom-name reading, not after admission.
        if (options.provider === 'slack' && !/^slack:([A-Z0-9]+):([0-9]+\.[0-9]+)$/.test(itemId)) throw new Error('Slack triage target unavailable');
        if (options.provider === 'discord' && !/^discord:([0-9]+):([0-9]+)$/.test(itemId)) throw new Error('Discord triage target unavailable');
        if (options.provider === 'email') {
          const parts = itemId.split(':');
          if (parts.length !== 4 || parts[0] !== 'email' || parts[1] !== options.accountScopeId || !options.imap
            || !/^\d+$/.test(parts[2]!) || !/^\d+$/.test(parts[3]!)
            || !Number.isSafeInteger(Number(parts[2])) || Number(parts[2]) < 1
            || !Number.isSafeInteger(Number(parts[3])) || Number(parts[3]) < 1) throw new Error('Email triage target unavailable');
        }
        const credential = capture();
        const checkCredential = credential.assertCurrent.bind(credential);
        const token = credential.value;
        const guarded = { signal, assertCurrent() { current(guard); checkCredential(); } };
        if (!token || await resolve(options.credentialKey) !== token) throw new Error('Triage credential unavailable');
        current(guarded);
        let discordForumOnly = false, discordReactionOnly = false;
        // Exact configured forum IDs are code, not label meaning. Only inspect
        // before semantic preparation when a custom name might take this path.
        if (options.provider === 'discord' && tags.some(tag => !Object.hasOwn(TAGS, tag))
          && tags.some(tag => Object.hasOwn(options.forumTagIds, tag))) {
          const [, channel, message] = itemId.split(':');
          const existing = await observeDiscordForumTags({ channel: channel!, message: message! }, token, guarded, options.http);
          current(guarded);
          discordForumOnly = existing !== null; discordReactionOnly = existing === null;
        }
        const meanings = new Map<string, TriageProviderTag>();
        const decisions: string[] = [];
        if (options.provider !== 'email' && !discordForumOnly) for (const tag of tags) {
          if (Object.hasOwn(TAGS, tag)) { meanings.set(tag, tag as TriageProviderTag); continue; }
          const identity = createHash('sha256').update(tag).digest('hex');
          if (heldMeanings.has(identity) || heldMeanings.size + pendingMeanings.size >= 1024) throw new TriageTagMeaningHeld();
          if (pendingMeanings.has(identity)) throw new Error('Triage tag interpretation is already pending');
          pendingMeanings.add(identity);
          try {
            const result = await readCustomTagMeaning(tag, options.port, guarded);
            current(guarded); meanings.set(tag, result.canonical); decisions.push(result.decisionId);
          } catch (error) {
            if (error instanceof TriageTagMeaningHeld) heldMeanings.add(identity);
            throw error;
          } finally { pendingMeanings.delete(identity); }
        }
        const keyword = (tag: string) => tag.replace(/[^A-Za-z0-9_]+/g, '_');
        const effects: readonly TriageTagEffect[] = Object.freeze(tags.map(tag => Object.freeze(options.provider === 'email'
          ? { tag, mode: 'imap-keyword' as const, keyword: keyword(tag) }
          : options.provider === 'slack' ? { tag, mode: 'slack-reaction' as const, reaction: TAGS[meanings.get(tag)!].slack }
          : discordForumOnly ? { tag, mode: Object.hasOwn(options.forumTagIds, tag) ? 'discord-forum-tag' as const : 'discord-unmapped-noop' as const,
            ...(Object.hasOwn(options.forumTagIds, tag) ? { forumTagRef: randomUUID().replaceAll('-', ':') } : {}) }
          : { tag, mode: discordReactionOnly ? 'discord-reaction' as const : 'discord-forum-or-reaction' as const, reaction: TAGS[meanings.get(tag)!].discord,
            ...(!discordReactionOnly && Object.hasOwn(options.forumTagIds, tag) ? { forumTagRef: randomUUID().replaceAll('-', ':') } : {}) })));
        const judgmentDecisionIds = Object.freeze(decisions);
        let used = false;
        return Object.freeze({ effects, judgmentDecisionIds, assertCurrent: guarded.assertCurrent, applyTags(admission: TaggerGuard) {
          if (used) return Promise.reject(new Error('Triage preparation already consumed'));
          used = true;
          const admissionCurrent = admission.assertCurrent.bind(admission);
          const finalGuard = { signal: AbortSignal.any([signal, admission.signal]), assertCurrent() { current(guarded); admissionCurrent(); } };
          const work = Promise.resolve().then(async () => {
        current(finalGuard);
        if (options.provider === 'slack') {
          const match = /^slack:([A-Z0-9]+):([0-9]+\.[0-9]+)$/.exec(itemId);
          if (!match) throw new Error('Slack triage target unavailable');
          await applySlackReactions({ channel: match[1]!, timestamp: match[2]! }, effects.map(effect => effect.reaction!), token, finalGuard, options.http);
        } else if (options.provider === 'discord') {
          const match = /^discord:([0-9]+):([0-9]+)$/.exec(itemId);
          if (!match) throw new Error('Discord triage target unavailable');
          await applyDiscordTagEffects({ channel: match[1]!, message: match[2]! }, effects.map(effect => ({ name: effect.tag, ...(effect.reaction === undefined ? {} : { reaction: effect.reaction }) })), token, finalGuard, discordReactionOnly ? {} : options.forumTagIds, options.http, discordForumOnly);
        } else {
          const parts = itemId.split(':');
          if (parts.length !== 4 || parts[0] !== 'email' || parts[1] !== options.accountScopeId || !/^\d+$/.test(parts[2]!) || !/^\d+$/.test(parts[3]!) || !options.imap) throw new Error('Email triage target unavailable');
          const uidValidity = Number(parts[2]), uid = Number(parts[3]);
          if (!Number.isSafeInteger(uid) || uid < 1) throw new Error('Email triage UID unavailable');
          for (const effect of effects) await store({ ...options.imap, password: token, uid: String(uid), uidValidity, flag: effect.keyword!, ...finalGuard });
        }
        current(finalGuard);
      });
      active.add(work); void work.then(() => active.delete(work), () => active.delete(work)); return work;
        } });
      });
      active.add(preparation); void preparation.then(() => active.delete(preparation), () => active.delete(preparation)); return preparation;
    },
    close() {
      if (closing) return closing;
      let done!: () => void;
      closing = new Promise<void>(resolveClose => { done = resolveClose; });
      lifetime.abort();
      void Promise.allSettled([...active]).then(() => { heldMeanings.clear(); done(); });
      return closing;
    },
  };
  return owner;
}
