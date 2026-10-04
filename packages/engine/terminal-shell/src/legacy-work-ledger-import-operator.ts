import { createOperatorSdk } from '@goodvibes-jev/engine/operator-sdk';
import { array, boolean, enum as enumSchema, literal, object, record, strictObject, string, union, unknown } from 'zod/v4';
import { validateLegacyWorkLedgerManifest, type LegacyMigrationPreparation } from '@goodvibes-jev/engine/sdk/platform/workflow/work-ledger';
import { bindingKey, LegacyImportJournal, type LegacyImportBinding, type LegacyImportEntry } from './legacy-work-ledger-import-journal.js';

export interface LegacyImportHost { readonly baseUrl: string; readonly token: string; readonly workspace: string }
export interface LegacyImportOperatorClient { currentAuth(): Promise<unknown>; invoke(method: string, input: Record<string, unknown>): Promise<unknown>; dispose(): void }
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
function clientFor(host: LegacyImportHost): LegacyImportOperatorClient {
  const client = createOperatorSdk({ baseUrl: host.baseUrl, authToken: host.token });
  return { currentAuth: () => client.control.auth.current({}, { signal: AbortSignal.timeout(10_000) }), invoke: (method, input) => client.invoke(method, input, { signal: AbortSignal.timeout(30_000) }), dispose: () => client.dispose() };
}
/** Read paths are available independently of semantic mutation admission.
 * There is intentionally no execution method until the actual shared gate is composed. */
export interface LegacyImportOperatorSession {
  readonly binding: LegacyImportBinding;
  prepare(): Promise<LegacyMigrationPreparation>;
  status(): Promise<LegacyImportEntry | null>;
  dispose(): void;
}
export async function openLegacyImportOperator(options: LegacyImportOperatorOptions): Promise<LegacyImportOperatorSession> {
  const selected = options.resolve(); if ('reason' in selected) throw new Error(selected.reason);
  const host = { ...selected };
  bindingKey({ endpoint: host.baseUrl, projectId: options.projectId, workspaceId: host.workspace, principalId: 'unresolved', principalKind: 'unresolved' });
  if (!host.token.trim()) throw new Error('An existing authenticated host credential is required');
  const client = (options.createClient ?? clientFor)(host);
  let closed = false; let binding: LegacyImportBinding | undefined;
  const selection = () => {
    const current = options.resolve();
    if (closed || 'reason' in current || current.baseUrl !== host.baseUrl || current.token !== host.token || current.workspace !== host.workspace) throw new Error('Selected host, credentials or workspace changed');
  };
  const authenticate = async () => {
    selection(); const auth = authSchema.parse(await client.currentAuth()); selection();
    if (!auth.authenticated || !auth.admin || !auth.principalId || !auth.principalKind || !['read:work-ledger', 'read:knowledge'].every(scope => auth.scopes.includes('*') || auth.scopes.includes(scope))) throw new Error('Current admin, read:work-ledger and read:knowledge required');
    const current = { endpoint: host.baseUrl, workspaceId: host.workspace, projectId: options.projectId, principalId: auth.principalId, principalKind: auth.principalKind };
    if (binding && bindingKey(binding) !== bindingKey(current)) throw new Error('Authenticated principal changed');
    binding = current;
  };
  const safe = async <T>(operation: () => Promise<T>): Promise<T> => {
    try { return await operation(); } catch (error) { throw new Error((error instanceof Error ? error.message : String(error)).split(host.token).join('[redacted]')); }
  };
  const status = async () => { await authenticate(); const journal = new LegacyImportJournal(options.journalPath); try { return journal.read(binding!); } finally { journal.close(); } };
  try { await safe(authenticate); } catch (error) { client.dispose(); throw error; }
  return {
    get binding() { return { ...binding! }; },
    status: () => safe(status),
    prepare: () => safe(async () => {
      if (await status()) throw new Error('A saved import exists; retain its exact command and reconcile it instead of preparing another');
      const sourceIds: string[] = []; const seen = new Set<string>(); const cursors = new Set<string>(); let cursor: string | undefined;
      do {
        await authenticate();
        const raw = await client.invoke('knowledge.sources.list', { limit: 100, includeAllSpaces: true, ...(cursor ? { cursor } : {}) });
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
      await authenticate(); const result = await client.invoke('workLedger.prepareLegacyImport', { projectId: options.projectId, sourceIds: sourceIds.sort() }); await authenticate();
      const prepared = preparationSchema.parse(result);
      if (prepared.kind === 'blocked') return prepared;
      const manifest = prepared.manifest;
      if (manifest.projectId !== options.projectId || JSON.stringify(manifest.sources.map(item => String(item.source.id)).sort()) !== JSON.stringify(sourceIds)) throw new Error('Prepared source selection changed');
      return { kind: 'prepared', manifest };
    }),
    dispose() { if (!closed) { closed = true; client.dispose(); } },
  };
}
