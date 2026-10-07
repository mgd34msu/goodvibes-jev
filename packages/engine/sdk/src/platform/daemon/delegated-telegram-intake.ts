/** Daemon-local, explicitly selected third-party intake. Never an owner-text capture. */
import { createHash, randomUUID } from 'node:crypto';
import type { NativeExecutionAuthority, NativePairedSnapshot } from '../security/http-auth.js';
import type { ApprovalBroker } from '../control-plane/approval-broker.js';
import type { SharedSessionBroker } from '../control-plane/session-broker.js';
import type { AutomationRouteBinding } from '../automation/routes.js';
import type { RouteBindingManager } from '../channels/route-manager.js';
import { createNativeInboundSourceOwner, sameNativeInboundSourceRef, type NativeInboundSourceRef } from '../control-plane/native-inbound-source.js';
import { createNativeInboundHandoff } from '../control-plane/native-inbound-handoff.js';
import { DelegatedInboundReviewReceiver, type DelegatedReviewGrant } from '../control-plane/delegated-inbound-receiver.js';
import { delegatedTelegramDecisionSchema, type DelegatedTelegramConfiguration, type DelegatedTelegramDecision } from '../control-plane/delegated-inbound-wire.js';
import { PersistentStore } from '../state/persistent-store.js';
import { StoreWriteQueue } from '../state/store-write-queue.js';
// Isolate the provider reader from the long-lived coordinator closure context.
const sourceReader = (read: () => string) => () => ({ text: read(), unsupportedSources: [] });
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const routeKey = (chatId: string, threadId?: string) => JSON.stringify([chatId, threadId ?? null]);
const routeRevision = (route: AutomationRouteBinding) => digest([route.id, route.surfaceKind, route.surfaceId, route.channelId, route.threadId, route.externalId, route.createdAt, route.kind, route.sessionPolicy, route.threadPolicy]);
const ownerRevision = (owner: NativePairedSnapshot) => digest([owner.principalId, owner.tokenId, [...owner.scopes].sort()]);
interface Selection { readonly chatId: string; readonly threadId?: string; }
interface SelectionStore extends Record<string, unknown> { readonly selected: readonly Selection[]; }
interface Configuration {
  readonly id: string; readonly choice: DelegatedTelegramConfiguration; readonly owner: NativeExecutionAuthority;
  readonly expected: NativePairedSnapshot; readonly revision: string; readonly controller: AbortController;
  readonly expiresAt: number; readonly timer: ReturnType<typeof setTimeout>;
}
export interface DelegatedTelegramIngress {
  readonly binding: AutomationRouteBinding; readonly chatId: string; readonly threadId?: string | undefined;
  readonly senderId?: string | undefined; readonly edited?: boolean | undefined; readonly providerMessageId: string;
  readonly readOriginal: () => string;
}
export interface DelegatedTelegramAdapter {
  selects(chatId: string, threadId?: string): Promise<boolean>;
  accept(input: DelegatedTelegramIngress): Promise<Record<string, unknown>>;
}
type RaisedOwnerApproval = Awaited<ReturnType<ApprovalBroker['raiseOwnerApproval']>>;
interface Pending {
  readonly ref: NativeInboundSourceRef; readonly configuration: Configuration;
  readonly sourceController: AbortController; readonly assertCurrent: () => void;
  readonly sourceExpiresAt: { value: number }; readonly timers: Set<ReturnType<typeof setTimeout>>;
  readonly approval: RaisedOwnerApproval;
  readonly run: () => Promise<Record<string, unknown>>;
  grant?: DelegatedReviewGrant;
  state: string;
}
export class DelegatedTelegramIntake implements DelegatedTelegramAdapter {
  private readonly configurations = new Map<string, Configuration>();
  private readonly selected = new Map<string, Selection>();
  private readonly ingresses = new Map<string, Promise<Record<string, unknown>>>();
  private readonly pending = new Map<string, Pending>();
  private readonly selectionStore: PersistentStore<SelectionStore>;
  private readonly selectionWrites = new StoreWriteQueue();
  private readonly receiver: DelegatedInboundReviewReceiver;
  private loading?: Promise<void>;
  private readonly workspaceRevision: string;
  private closed = false;
  private lifecycleGeneration = 0;
  constructor(private readonly deps: {
    readonly broker: SharedSessionBroker; readonly approvals: ApprovalBroker; readonly routes: Pick<RouteBindingManager, 'getBinding' | 'getBindingIncarnation'>;
    readonly accountId: () => string; readonly workspaceRoot: string;
    readonly selectionPath: string; readonly receiptPath: string;
  }) {
    this.selectionStore = new PersistentStore(deps.selectionPath);
    this.receiver = new DelegatedInboundReviewReceiver(deps.receiptPath);
    this.workspaceRevision = digest([deps.workspaceRoot, randomUUID()]);
  }
  private start(): Promise<void> {
    return this.loading ??= (async () => {
      const saved = await this.selectionStore.load();
      for (const selection of saved?.selected ?? []) this.selected.set(routeKey(selection.chatId, selection.threadId), selection);
    })();
  }
  async selects(chatId: string, threadId?: string): Promise<boolean> { await this.start(); return this.selected.has(routeKey(chatId, threadId)); }
  private assertConfiguration(config: Configuration): void {
    const current = config.owner.current();
    if (this.closed || config.controller.signal.aborted || Date.now() >= config.expiresAt
      || !current || ownerRevision(current) !== config.revision || this.deps.accountId() !== config.choice.accountId
      || this.configurations.get(routeKey(config.choice.chatId, config.choice.threadId)) !== config) {
      config.controller.abort(); throw new Error('Delegated Telegram configuration is no longer current');
    }
  }
  async configure(choice: DelegatedTelegramConfiguration, owner: NativeExecutionAuthority): Promise<Record<string, unknown>> {
    const generation = this.lifecycleGeneration;
    await this.start(); if (this.closed || generation !== this.lifecycleGeneration) throw new Error('Delegated intake lifecycle changed');
    const expected = owner.current(); if (!expected || this.deps.accountId() !== choice.accountId) throw new Error('Configured Telegram account does not match this host');
    const assertOwner = () => { if (generation !== this.lifecycleGeneration) throw new Error('Delegated intake lifecycle changed'); if (ownerRevision(owner.current() ?? expected) !== ownerRevision(expected) || !owner.current()) throw new Error('Owner no longer current'); };
    {
      assertOwner(); const key = routeKey(choice.chatId, choice.threadId); this.configurations.get(key)?.controller.abort();
      const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), choice.configurationLifetimeMs); timer.unref();
      const config: Configuration = { id: `telegram-config-${randomUUID()}`, choice: Object.freeze({ ...choice }), owner, expected,
        revision: ownerRevision(expected), controller, timer, expiresAt: Date.now() + choice.configurationLifetimeMs };
      this.configurations.set(key, config); this.selected.set(key, { chatId: choice.chatId, ...(choice.threadId ? { threadId: choice.threadId } : {}) });
      const snapshot = { selected: [...this.selected.values()] };
      await this.selectionWrites.run(() => this.selectionStore.persist(snapshot, { durable: true })); assertOwner(); this.assertConfiguration(config);
      return { configurationId: config.id, expiresAt: config.expiresAt, pendingRetentionMs: choice.pendingRetentionMs,
        processing: 'requires-per-message-approval', restart: 'selected-route-held-without-original-or-grant' };
    }
  }
  async accept(input: DelegatedTelegramIngress): Promise<Record<string, unknown>> {
    if (!input.providerMessageId) return { outcome: 'held', reason: 'Provider message identity is missing; no original captured.' };
    const key = JSON.stringify([input.binding.id, input.providerMessageId]);
    const previous = this.ingresses.get(key);
    if (input.edited) {
      if (!previous && this.ingresses.size >= 500) return { outcome: 'held', reason: 'Delegated intake capacity reached; no original captured.' };
      const held = { outcome: 'held', reason: 'Edited provider message requires a fresh original and explicit owner decision.' };
      this.ingresses.set(key, Promise.resolve(held));
      if (previous) { const found = await previous; const entry = [...this.pending.values()].find(value => value.ref === found.ref); entry?.sourceController.abort(); }
      return held;
    }
    if (previous) return previous;
    if (this.ingresses.size >= 500) return { outcome: 'held', reason: 'Delegated intake capacity reached; no original captured.' };
    const result = this.acceptOnce(input); this.ingresses.set(key, result); return result;
  }
  private async acceptOnce(input: DelegatedTelegramIngress): Promise<Record<string, unknown>> {
    const generation = this.lifecycleGeneration;
    await this.start();
    if (this.closed || generation !== this.lifecycleGeneration) return { outcome: 'held', reason: 'Ingress lifecycle changed; no original captured.' };
    const config = this.configurations.get(routeKey(input.chatId, input.threadId));
    if (!config) return { outcome: 'held', reason: 'An explicit current pending-memory lifetime is required; original was not captured.' };
    try { this.assertConfiguration(config); } catch { return { outcome: 'held', reason: 'Selected route has no current owner configuration.' }; }
    const sourceController = new AbortController(); const sourceExpiresAt = { value: Date.now() + config.choice.pendingRetentionMs };
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const expire = (at: number) => { const timer = setTimeout(() => sourceController.abort(), Math.max(1, at - Date.now())); timer.unref(); timers.add(timer); };
    expire(sourceExpiresAt.value);
    const expectedRoute = routeRevision(input.binding);
    const bindingId = input.binding.id;
    const incarnation = this.deps.routes.getBindingIncarnation(bindingId);
    let boundSessionId: string | undefined;
    const assertCurrent = () => {
      this.assertConfiguration(config); sourceController.signal.throwIfAborted();
      const route = this.deps.routes.getBinding(bindingId);
      if (Date.now() >= sourceExpiresAt.value || !route || !incarnation || this.deps.routes.getBindingIncarnation(bindingId) !== incarnation || routeRevision(route) !== expectedRoute || (boundSessionId !== undefined && route.sessionId !== boundSessionId)) { sourceController.abort(); throw new Error('Original source expired or route changed'); }
    };
    const lifetime = AbortSignal.any([sourceController.signal, config.controller.signal]);
    const sources = createNativeInboundSourceOwner({ origin: { kind: 'external-original', accountId: config.choice.accountId,
      accountRevision: config.id, routeId: input.binding.id, routeRevision: expectedRoute }, lifetime, assertCurrent,
      readBrokerInput: target => this.deps.broker.getInputs(target.sessionId, 500).find(row => row.id === target.inputId) ?? null });
    lifetime.addEventListener('abort', () => { for (const timer of timers) clearTimeout(timer); sources.close(); }, { once: true });
    try {
      const handle = sources.producer.capture(sourceReader(input.readOriginal), lifetime);
      let ref!: NativeInboundSourceRef;
      const submitted = await this.deps.broker.submitDelegatedMessage({ routeId: input.binding.id, surfaceKind: 'telegram', surfaceId: input.binding.surfaceId,
        externalId: input.binding.externalId, threadId: input.threadId ?? input.chatId, userId: input.senderId,
        body: '[External Telegram message held for explicit owner review]', title: 'External Telegram intake',
        metadata: { providerMessageId: input.providerMessageId } }, row => {
          boundSessionId = row.sessionId;
          ref = sources.producer.bind(handle, { sessionId: row.sessionId, inputId: row.id }); return { ref, assertCurrent };
        });
      const approval = await this.deps.approvals.raiseOwnerApproval({ sessionId: ref.sessionId, signal: lifetime,
        timeoutMs: Math.max(1, sourceExpiresAt.value - Date.now()),
        request: { callId: ref.requestId, tool: 'inbound.telegram.review', category: 'delegate', args: { ref, origin: { kind: 'external-original', accountId: config.choice.accountId, routeId: input.binding.id },
          configurationId: config.id, providerMessageId: input.providerMessageId, chatId: input.chatId, ...(input.threadId ? { threadId: input.threadId } : {}), externalAuthorId: input.senderId ?? 'unknown-external-author', pendingSourceExpiresAt: sourceExpiresAt.value, requiredChoices: 'processingPurpose, sourceRetentionMs, derivedRecordRetentionMs, ownerMayReadOriginal=true, execution=none', decisionCommand: 'inbound.telegram.decide' },
          analysis: { classification: 'external-message-review', riskLevel: 'high', summary: 'Approve one external Telegram message for owner review only. Choose a bounded original-memory lifetime and a metadata-only review-record lifetime. No work execution.',
            reasons: ['Original content is not copied into this approval. Use the provider message identity to review the source.', 'Only the paired owner decision command can approve. Generic approve, remembered rules, and channel replies cannot.', 'Raw source is released at the chosen deadline or review cancellation. Persisted metadata expires while running, or is pruned at next startup.'] }, rememberOptions: [] },
        requireOwnerDecision: { assertCurrent, validateDecision: decision => {
          if (!decision.approved) return;
          const parsed = delegatedTelegramDecisionSchema.parse(decision.modifiedArgs);
          if (!parsed.approved || parsed.approvalId !== approval.approval.id || !sameNativeInboundSourceRef(parsed.ref, ref)) throw new Error('Decision does not bind this exact source');
        } },
      });
      const pending: Pending = { ref, configuration: config, sourceController, sourceExpiresAt, timers, assertCurrent, approval, state: 'awaiting-owner', run: async () => ({ outcome: 'held' }) };
      const handoff = createNativeInboundHandoff({ sources: sources.resolver, lifetime,
        owner: { withCurrent: async (_source, use) => { assertCurrent(); if (!pending.grant) throw new Error('No exact owner approval');
          return use(assertCurrent, `${config.revision}:${config.id}:${approval.approval.id}`, lifetime); } },
        receiver: { accept: (source, options) => { if (!pending.grant) throw new Error('No exact grant'); return this.receiver.receiver(pending.grant).accept(source, options); },
          inspect: async reference => pending.grant ? this.receiver.receiver(pending.grant).inspect(reference) : null,
          cancel: reference => this.receiver.cancel(reference) },
      });
      const run = async () => {
        const result = await handoff.run({ sessionId: ref.sessionId, input: submitted.submission.input, task: '' });
        pending.state = result.disposition ?? 'held';
        if (result.disposition === 'transferred') await submitted.complete({ disposition: 'transferred', ref, requestId: ref.requestId });
        return { outcome: result.disposition ?? 'held', ref, execution: 'not-started' };
      };
      Object.assign(pending, { run }); this.pending.set(ref.requestId, pending);
      // Await the real broker outcome without holding the provider invocation open.
      void approval.decision.then(async decision => { if (!decision.approved) { pending.state = 'held'; sourceController.abort(); } }).catch(() => { sourceController.abort(); });
      return { outcome: 'held', reason: 'awaiting-exact-owner-decision', approvalId: approval.approval.id, ref, sourceExpiresAt: sourceExpiresAt.value };
    } catch { sourceController.abort(); return { outcome: 'held', reason: 'Original source or canonical binding is unavailable; no legacy fallback.' }; }
  }
  async decide(input: DelegatedTelegramDecision, authority: NativeExecutionAuthority): Promise<Record<string, unknown>> {
    const pending = this.pending.get(input.ref.requestId);
    if (!pending || !sameNativeInboundSourceRef(pending.ref, input.ref) || pending.approval.approval.id !== input.approvalId) throw new Error('Exact pending source is unavailable');
    const current = authority.current(); if (!current || ownerRevision(current) !== pending.configuration.revision) throw new Error('Only the configured paired owner may decide');
    const assertOwner = () => { if (!authority.current() || ownerRevision(authority.current()!) !== ownerRevision(current)) throw new Error('Owner no longer current'); };
    {
      const assert = () => { assertOwner(); pending.assertCurrent(); };
      assert(); if (pending.state !== 'awaiting-owner') throw new Error('Decision already attempted; inspect exact status');
      if (input.approved && input.choices) {
        const expiresAt = Date.now() + input.choices.sourceRetentionMs;
        if (expiresAt > pending.configuration.expiresAt) throw new Error('Source lifetime must fit within the explicitly configured owner lifetime');
        pending.grant = { configurationId: pending.configuration.id, ownerRevision: pending.configuration.revision, workspaceRevision: this.workspaceRevision,
          approvalId: input.approvalId, choices: Object.freeze({ ...input.choices }), sourceExpiresAt: expiresAt };
      }
      pending.state = 'deciding';
      const settled = await pending.approval.resolveOwnerDecision({ decision: { approved: input.approved, ...(input.approved ? { modifiedArgs: input } : {}) }, actor: current.principalId, actorSurface: 'paired-owner-command', assertCurrent: assert });
      assertOwner();
      if (input.approved && (settled?.status !== 'approved' || settled.decision?.disposition !== 'approved' || JSON.stringify(settled.decision.modifiedArgs) !== JSON.stringify(input))) { pending.sourceController.abort(); throw new Error('Exact approval was not durably resolved'); }
      if (!input.approved) { pending.sourceController.abort(); return { outcome: 'held', reason: 'owner-denied' }; }
      assert();
      for (const timer of pending.timers) clearTimeout(timer); pending.timers.clear();
      pending.sourceExpiresAt.value = pending.grant!.sourceExpiresAt;
      const timer = setTimeout(() => pending.sourceController.abort(), Math.max(1, pending.sourceExpiresAt.value - Date.now())); timer.unref(); pending.timers.add(timer);
      pending.state = 'approved'; return pending.run();
    }
  }
  private checkRecordOwner(record: { ownerRevision: string }, authority: NativeExecutionAuthority): void {
    const current = authority.current(); if (!current || ownerRevision(current) !== record.ownerRevision) throw new Error('Review receipt belongs to another paired owner');
  }
  async status(ref: NativeInboundSourceRef, authority: NativeExecutionAuthority, read = false): Promise<Record<string, unknown>> {
    const pending = this.pending.get(ref.requestId);
    const record = await this.receiver.get(ref);
    if (record) {
      this.checkRecordOwner(record, authority); const original = await this.receiver.read(ref);
      return { record, source: original ? 'available-in-memory' : 'expired-or-lost', recovery: original ? 'owner-review-available' : 'new-original-required', ...(read && original ? { original } : {}) };
    }
    if (!pending || !sameNativeInboundSourceRef(pending.ref, ref)) return { outcome: 'held', reason: 'missing-source-proof' };
    this.checkRecordOwner({ ownerRevision: pending.configuration.revision }, authority);
    let available = true; try { pending.assertCurrent(); } catch { available = false; }
    return { ref, outcome: available ? pending.state : 'held', source: available ? 'awaiting-owner' : 'expired-or-lost', approvalId: pending.approval.approval.id };
  }
  async list(authority: NativeExecutionAuthority): Promise<Record<string, unknown>> {
    const current = authority.current(); if (!current) throw new Error('Owner unavailable');
    return { records: (await this.receiver.list()).filter(record => record.ownerRevision === ownerRevision(current)).map(record => ({ ...record, execution: 'not-started' })),
      pending: [...this.pending.values()].filter(entry => entry.configuration.revision === ownerRevision(current)).map(entry => ({ ref: entry.ref, approvalId: entry.approval.approval.id, sourceExpiresAt: entry.sourceExpiresAt.value, outcome: entry.sourceController.signal.aborted ? 'held' : entry.state })) };
  }
  async cancel(ref: NativeInboundSourceRef, authority: NativeExecutionAuthority): Promise<Record<string, unknown>> {
    const pending = this.pending.get(ref.requestId); const record = await this.receiver.get(ref);
    if (record) this.checkRecordOwner(record, authority);
    else if (pending && sameNativeInboundSourceRef(pending.ref, ref)) this.checkRecordOwner({ ownerRevision: pending.configuration.revision }, authority);
    else return { outcome: 'held', reason: 'missing-source-proof' };
    if (pending) { pending.sourceController.abort(); pending.state = 'cancelled'; await this.deps.approvals.cancelApproval(pending.approval.approval.id, authority.current()!.principalId, 'paired-owner-command'); }
    await this.receiver.cancel(ref); return { outcome: 'cancelled', execution: 'not-started' };
  }
  revoke(configurationId: string, authority: NativeExecutionAuthority): Record<string, unknown> {
    const config = [...this.configurations.values()].find(value => value.id === configurationId);
    if (!config) return { outcome: 'held', reason: 'configuration-unavailable' };
    this.checkRecordOwner({ ownerRevision: config.revision }, authority); config.controller.abort(); clearTimeout(config.timer);
    return { outcome: 'revoked', route: 'remains-selected-and-held' };
  }
  /** A new daemon lifecycle restores commands, never previous source/grant lifetimes. */
  startLifecycle(): void { this.closed = false; this.receiver.reopen(); }
  close(): void { this.lifecycleGeneration++; this.closed = true; for (const config of this.configurations.values()) { config.controller.abort(); clearTimeout(config.timer); } this.receiver.close(); }
}
