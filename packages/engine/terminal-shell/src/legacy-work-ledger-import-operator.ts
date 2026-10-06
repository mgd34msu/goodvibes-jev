import { randomUUID } from 'node:crypto';
import { parseJevDecision } from '@goodvibes-jev/judgment/decisions';
import { createOperatorSdk } from '@goodvibes-jev/engine/operator-sdk';
import { array, boolean, enum as enumSchema, literal, object, record, strictObject, string, union, unknown } from 'zod/v4';
import { validateLegacyWorkLedgerManifest, type LegacyMigrationPreparation } from '@goodvibes-jev/engine/sdk/platform/workflow/work-ledger';
import { bindingKey, LegacyImportJournal, type LegacyImportBinding, type LegacyImportEntry, type LegacyImportCommand, legacyImportResultSchema } from './legacy-work-ledger-import-journal.js';

export interface LegacyImportHost { readonly baseUrl: string; readonly token: string; readonly workspace: string; readonly selectionIdentity?: string }
export interface LegacyImportOperatorClient { currentAuth(signal?: AbortSignal): Promise<unknown>; invoke(method: string, input: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>; dispose(): void }
export interface LegacyImportOperatorOptions {
  readonly resolve: () => LegacyImportHost | { readonly reason: string };
  readonly projectId: string; readonly journalPath: string;
  readonly createClient?: (host: LegacyImportHost) => LegacyImportOperatorClient;
}
const authSchema = object({ authenticated: boolean(), admin: boolean(), principalId: string().min(1).nullable(), principalKind: enumSchema(['bot', 'service', 'token', 'user']).nullable(), scopes: array(string()) });
const pageSchema = object({ items: array(object({ id: string().min(1), connectorId: string(), metadata: record(string(), unknown()) })).max(1000), hasMore: boolean(), nextCursor: string().nullable().optional() });
const preparationSchema = union([
  strictObject({ kind: literal('prepared'), manifest: unknown().transform(validateLegacyWorkLedgerManifest) }),
  strictObject({ kind: literal('blocked'), code: enumSchema(['cancelled', 'pending-local-changes', 'invalid-source', 'limit', 'identity-conflict', 'target-conflict', 'stale-preparation']), reason: string() }),
]);
function clientFor(host: LegacyImportHost, current: () => void): LegacyImportOperatorClient {
  const client = createOperatorSdk({ baseUrl: host.baseUrl, authToken: host.token, fetchImpl: async (input, init) => {
    current(); const response = await fetch(input, { ...init, redirect: 'error' }); current(); return response;
  } });
  return { currentAuth: signal => client.control.auth.current({}, { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000) }),
    invoke: (method, input, signal) => client.invoke(method, input, { signal }), dispose: () => client.dispose() };
}
/** Read paths do not grant mutation. Every explicit dispatch uses the selected host's autonomous gate. */
export interface LegacyImportOperatorSession {
  readonly binding: LegacyImportBinding;
  prepare(): Promise<LegacyMigrationPreparation>;
  status(): Promise<LegacyImportEntry | null>;
  submit(): Promise<LegacyImportEntry>;
  reconsider(requestId: string): Promise<LegacyImportEntry>;
  recover(requestId: string): Promise<LegacyImportEntry>;
  cancel(requestId: string): Promise<LegacyImportEntry>;
  restart(requestId: string): Promise<LegacyImportEntry>;
  dispose(): void;
}
export async function openLegacyImportOperator(options: LegacyImportOperatorOptions): Promise<LegacyImportOperatorSession> {
  const selected = options.resolve(); if ('reason' in selected) throw new Error(selected.reason);
  const host = { ...selected };
  bindingKey({ endpoint: host.baseUrl, projectId: options.projectId, workspaceId: host.workspace, principalId: 'unresolved', principalKind: 'unresolved' });
  if (!host.token.trim()) throw new Error('An existing authenticated host credential is required');
  const lifetime = new AbortController();
  let closed = false; let binding: LegacyImportBinding | undefined;
  const selection = () => {
    const current = options.resolve();
    if (closed || 'reason' in current || current.baseUrl !== host.baseUrl || current.token !== host.token || current.workspace !== host.workspace || current.selectionIdentity !== host.selectionIdentity) throw new Error('Selected host, credentials or workspace changed');
  };
  const client = options.createClient ? options.createClient(host) : clientFor(host, selection);
  const authenticate = async (write = false) => {
    selection(); const auth = authSchema.parse(await client.currentAuth(lifetime.signal)); selection();
    if (!auth.authenticated || !auth.admin || !auth.principalId || !auth.principalKind || !['read:work-ledger', 'read:knowledge'].every(scope => auth.scopes.includes('*') || auth.scopes.includes(scope))) throw new Error('Current admin, read:work-ledger and read:knowledge required');
    if (write && !auth.scopes.some(scope => scope === '*' || scope === 'write:work-ledger-import')) throw new Error('Current write:work-ledger-import required');
    const current = { endpoint: host.baseUrl, workspaceId: host.workspace, projectId: options.projectId, principalId: auth.principalId, principalKind: auth.principalKind };
    if (binding && bindingKey(binding) !== bindingKey(current)) throw new Error('Authenticated principal changed');
    binding = current;
  };
  const safe = async <T>(operation: () => Promise<T>): Promise<T> => {
    try { return await operation(); } catch (error) { throw new Error((error instanceof Error ? error.message : String(error)).split(host.token).join('[redacted]')); }
  };
  const journal = <T>(operation: (store: LegacyImportJournal) => T): T => {
    selection(); const store = new LegacyImportJournal(options.journalPath);
    try { return operation(store); } finally { store.close(); }
  };
  const status = async () => { await authenticate(); return journal(store => store.read(binding!)); };
  const selectedEntry = (requestId: string): LegacyImportEntry => journal(store => {
    const entry = store.read(binding!);
    if (!entry || entry.command.requestId !== requestId) throw new Error('Selected import request does not match the saved command');
    return entry;
  });
  const prepareSources = async (): Promise<LegacyMigrationPreparation> => {
      const sourceIds: string[] = []; const seen = new Set<string>(); const cursors = new Set<string>(); let cursor: string | undefined;
      do {
        await authenticate();
        const raw = await client.invoke('knowledge.sources.list', { limit: 100, includeAllSpaces: true, ...(cursor ? { cursor } : {}) }, lifetime.signal);
        await authenticate(); const page = pageSchema.parse(raw);
        if ((page.hasMore && (!page.nextCursor || !page.items.length)) || (!page.hasMore && page.nextCursor != null)) throw new Error('Incomplete source discovery: inconsistent cursor');
        for (const source of page.items) {
          if (seen.has(source.id)) throw new Error('Source discovery repeated an identity'); seen.add(source.id);
          if (source.connectorId === 'goodvibes-project-planning' && source.metadata.projectPlanning === true && source.metadata.projectId === options.projectId) sourceIds.push(source.id);
        }
        if (seen.size >= 5000 || sourceIds.length > 500) throw new Error('Source discovery limit prevents proving completeness');
        cursor = page.hasMore ? page.nextCursor! : undefined;
        if (cursor) { if (cursors.has(cursor)) throw new Error('Source cursor repeated'); cursors.add(cursor); }
      } while (cursor);
      if (!sourceIds.length) throw new Error('No complete persisted legacy sources found');
      await authenticate(); const result = await client.invoke('workLedger.prepareLegacyImport', { projectId: options.projectId, sourceIds: sourceIds.sort() }, lifetime.signal); await authenticate();
      const prepared = preparationSchema.parse(result);
      if (prepared.kind === 'blocked') return prepared;
      const manifest = prepared.manifest;
      if (manifest.projectId !== options.projectId || JSON.stringify(manifest.sources.map(item => String(item.source.id)).sort()) !== JSON.stringify(sourceIds)) throw new Error('Prepared source selection changed');
      return { kind: 'prepared', manifest };
  };
  const dispatch = async (entry: LegacyImportEntry): Promise<LegacyImportEntry> => {
    await authenticate(true);
    const dispatched = journal(store => store.dispatch(binding!, entry.command, entry));
    // Durably unknown BEFORE transmission. A lost response, disposal or revoked
    // read permission cannot claim rollback or generate another request identity.
    const raw = await client.invoke('workLedger.importLegacy', entry.command, lifetime.signal);
    await authenticate(true);
    if (raw && typeof raw === 'object' && 'kind' in raw && raw.kind === 'decision') {
      const semantic = strictObject({ kind: literal('decision'), decision: unknown().transform(parseJevDecision) }).parse(raw);
      if (semantic.decision.outcome === 'act') throw new Error('Host returned an uncommitted act decision');
      return journal(store => store.recordDecision(binding!, entry.command, semantic.decision,
        entry.state === 'pending' ? dispatched.attempts : undefined));
    }
    const result = legacyImportResultSchema.parse(raw);
    return journal(store => store.record(binding!, entry.command, result, entry.state === 'pending' ? dispatched.attempts : undefined));
  };
  const create = async (replaceRequestId?: string): Promise<LegacyImportEntry> => {
    await authenticate(true);
    const prior = journal(store => store.read(binding!));
    if (prior && !replaceRequestId) return prior;
    if (replaceRequestId && (!prior || prior.command.requestId !== replaceRequestId || !['rejected', 'cancelled'].includes(prior.state))) throw new Error('Only the selected rejected or undispatched cancelled import can be replaced');
    const prepared = await prepareSources();
    if (prepared.kind === 'blocked') throw new Error(`Preparation blocked: ${prepared.code}: ${prepared.reason}`);
    await authenticate(true);
    const command: LegacyImportCommand = { type: 'import_legacy', requestId: randomUUID(), expectedRevision: prepared.manifest.expectedLedgerRevision, manifest: prepared.manifest };
    const reserved = journal(store => store.reserve(binding!, () => command, replaceRequestId));
    if (reserved.command.requestId !== command.requestId) return reserved;
    return dispatch(reserved);
  };
  const resume = async (requestId: string, state: 'pending' | 'unknown'): Promise<LegacyImportEntry> => {
    await authenticate(true); const entry = selectedEntry(requestId);
    if (entry.state !== state) throw new Error(`Selected import must be ${state}; inspect status before choosing recovery`);
    return dispatch(entry);
  };
  try { await safe(authenticate); } catch (error) { client.dispose(); throw error; }
  return {
    get binding() { return { ...binding! }; },
    status: () => safe(status),
    prepare: () => safe(async () => {
      if (await status()) throw new Error('A saved import exists; retain its exact command and reconcile it instead of preparing another');
      return prepareSources();
    }),
    submit: () => safe(() => create()),
    restart: requestId => safe(() => create(requestId)),
    reconsider: requestId => safe(() => resume(requestId, 'pending')),
    recover: requestId => safe(() => resume(requestId, 'unknown')),
    cancel: requestId => safe(async () => { await authenticate(); const entry = selectedEntry(requestId); return journal(store => store.cancel(binding!, entry.command))!; }),
    dispose() { if (!closed) { closed = true; lifetime.abort(); client.dispose(); } },
  };
}
