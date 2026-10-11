/** Provider mutations are explicit, exact-mirror, one-operation admitted effects. */
import { createHash, randomUUID } from 'node:crypto';
import type { JudgmentPort } from '@goodvibes-jev/judgment';
import type { PermissionManager } from '../../permissions/manager.js';
import type { AutonomousToolSource } from '../../permissions/autonomous.js';
import { ToolRegistry, assertCurrentToolExecution } from '../../tools/registry.js';
import type { OwnedInboxSource } from '../registration.js';
import type { InboundChannelItem } from '../provider-adapter.js';
import { captureTagNames } from './tagger/meaning.js';
import type { TriageTagger } from './tagger/index.js';
export interface OwnedInboxTaggingOptions {
  readonly source: OwnedInboxSource;
  readonly tagger: TriageTagger;
  readonly permissionManager: PermissionManager;
  readonly port: JudgmentPort;
  readonly signal: AbortSignal;
  readonly assertCurrent: () => void;
  readonly onInvalidate: (listener: () => void) => () => void;
}
export interface OwnedInboxTagOperation {
  readonly sourceOf: () => AutonomousToolSource;
  readonly signal?: AbortSignal;
  readonly assertCurrent: () => void;
}
export interface OwnedInboxTagging {
  applyTags(itemId: string, tags: readonly string[], operation: OwnedInboxTagOperation): Promise<void>;
  close(): Promise<void>;
}
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
/** Fresh local reference, unrelated to provider bytes. Colon-delimited UUID
 * groups are protocol identity; no group can resemble a 13-19 digit PAN. */
const reference = () => randomUUID().replaceAll('-', ':');
export function createOwnedInboxTagging(input: OwnedInboxTaggingOptions): OwnedInboxTagging {
  const options = Object.freeze({ ...input });
  const acquireRead = options.source.acquireRead.bind(options.source);
  const prepare = options.tagger.prepareTags.bind(options.tagger);
  const provider = options.tagger.provider, account = options.tagger.accountScopeId;
  const accountRef = reference();
  const lifetime = new AbortController();
  const active = new Set<Promise<void>>();
  let closing: Promise<void> | undefined;
  return {
    applyTags(itemId, inputTags, operation) {
      const tags = captureTagNames(inputTags);
      const sourceOf = operation.sourceOf, operationCurrent = operation.assertCurrent;
      const invalidation = new AbortController();
      const unsubscribe = options.onInvalidate(() => invalidation.abort());
      const signal = AbortSignal.any([lifetime.signal, options.signal, invalidation.signal, ...(operation.signal ? [operation.signal] : [])]);
      const baseCurrent = () => { signal.throwIfAborted(); options.assertCurrent(); operationCurrent(); };
      const work = Promise.resolve().then(async () => {
        baseCurrent();
        if (!options.port.recorder) throw new Error('Triage tagging requires recorded judgment');
        const read = await acquireRead(true);
        const release = read.release.bind(read), validate = read.validate.bind(read), readCurrent = read.assertCurrent.bind(read);
        const list = read.sources.store.listItems.bind(read.sources.store);
        // Cursor traversal selects actual owned rows, never caller-supplied previews/targets.
        const find = (): InboundChannelItem | undefined => {
          let after: { id: string; receivedAt: number } | undefined;
          for (;;) {
            const rows = list({ providers: [provider], limit: 500, ...(after ? { after } : {}) });
            const row = rows.find(value => value.id === itemId);
            if (row) return row;
            const last = rows.at(-1); if (rows.length < 500 || !last) return undefined;
            if (after && last.id === after.id && last.receivedAt === after.receivedAt) throw new Error('Inbox selection did not progress');
            after = { id: last.id, receivedAt: last.receivedAt };
          }
        };
        try {
          baseCurrent(); readCurrent();
          const row = find(); if (!row || row.provider !== provider) throw new Error('Owned triage item unavailable');
          const revision = hash({ account, row });
          const assertRow = () => { baseCurrent(); readCurrent(); const latest = find(); if (!latest || hash({ account, row: latest }) !== revision) throw new Error('Owned triage item changed'); };
          assertRow();
          const mutation = await prepare(itemId, tags, { signal, assertCurrent: assertRow });
          const assertCurrent = () => { assertRow(); mutation.assertCurrent(); };
          assertCurrent();
          const registry = new ToolRegistry(options.permissionManager);
          const name = 'inbox_triage_apply_tags';
          // Account IDs, provider snowflakes/UIDs and content-revision digests
          // are local transport identity, not semantic action text. This fresh
          // reference is bound only here, after selecting the real owned row and
          // preparing its exact mutation. It cannot select another row, account
          // or effect, and no caller can provide or resolve it. Keep provider,
          // account distinction, conversation kind and exact label effects in
          // the reading; semantic task text still faces the ordinary privacy floor.
          const args = { provider, accountRef, targetRef: reference(), kind: row.kind, tags, effects: mutation.effects };
          const exactArgs = JSON.stringify(args);
          registry.register({ definition: { name, description: 'Apply these exact prepared triage effects to the current item in the referenced owned provider account. Custom reaction meaning is already recorded; neither names, interpreted reactions nor configured forum bindings may change. References identify the exact account and item already selected by the host.', sideEffects: ['network'], parameters: { type: 'object', properties: { provider: { type: 'string' }, accountRef: { type: 'string' }, targetRef: { type: 'string' }, kind: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } }, effects: { type: 'array', items: { type: 'object', properties: { tag: { type: 'string' }, mode: { type: 'string' }, keyword: { type: 'string' }, reaction: { type: 'string' }, forumTagRef: { type: 'string' } }, required: ['tag', 'mode'], additionalProperties: false } } }, required: ['provider', 'accountRef', 'targetRef', 'kind', 'tags', 'effects'], additionalProperties: false } }, async execute(actual, execution) {
            const guard = () => { assertCurrent(); if (!assertCurrentToolExecution(actual, execution) || JSON.stringify(actual) !== exactArgs) throw new Error('Triage mutation lacks exact authentic admission'); };
            guard(); await mutation.applyTags({ signal, assertCurrent: guard }); guard();
            return { callId: '', success: true };
          } });
          const call = await registry.prepareCall(randomUUID(), name, args, { signal, assertCurrent, port: options.port });
          const admission = await options.permissionManager.admitAutonomous(randomUUID(), name, call.args, { sourceOf, signal, schemaRevision: call.schemaRevision, preparationDecisionIds: [...mutation.judgmentDecisionIds, ...call.judgmentDecisionIds], preparedCall: { registry, call }, assertPrepared: assertCurrent, decoratePort: () => options.port });
          assertCurrent();
          if (!admission.result.approved) throw new Error('Triage provider mutation was not admitted');
          const result = await registry.executePrepared(call, admission, { signal });
          if (!result.success) throw new Error('Triage provider mutation failed');
          await validate(); assertCurrent();
        } finally { release(); }
      }).finally(unsubscribe);
      active.add(work); void work.then(() => active.delete(work), () => active.delete(work)); return work;
    },
    close() {
      if (closing) return closing;
      let done!: () => void; closing = new Promise<void>(resolve => { done = resolve; });
      lifetime.abort(); void Promise.allSettled([...active]).then(() => done()); return closing;
    },
  };
}
