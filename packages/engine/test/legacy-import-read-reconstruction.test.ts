import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openLegacyImportOperator } from '../terminal-shell/src/legacy-work-ledger-import-operator.js';
import { prepareLegacyWorkLedgerMigration } from '../sdk/src/platform/workflow/work-ledger/legacy-import.js';
import fixture from '../../../products/agent/src/test/fixtures/legacy-ledger/preparation.json' with { type: 'json' };
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'import-read-')); roots.push(root);
  const prepared = prepareLegacyWorkLedgerMigration(fixture); if (prepared.kind !== 'prepared') throw new Error(prepared.reason);
  let auth = { authenticated: true, admin: true, principalId: 'actual-principal', principalKind: 'user', scopes: ['read:work-ledger', 'read:knowledge'] };
  const calls: string[] = [];
  let pages: (input: Record<string, unknown>) => unknown = input => input.cursor ? { items: fixture.sources.slice(1).map(item => item.source), hasMore: false } : { items: [fixture.sources[0]!.source], hasMore: true, nextCursor: 'next' };
  const open = () => openLegacyImportOperator({ projectId: fixture.projectId, journalPath: join(root, 'journal.sqlite'), resolve: () => ({ baseUrl: 'http://host', token: 'synthetic-secret', workspace: root }),
    createClient: () => ({ currentAuth: async () => auth, dispose() {}, invoke: async (method, input) => { calls.push(method); if (method === 'knowledge.sources.list') return pages(input); if (method === 'workLedger.prepareLegacyImport') return prepared; throw new Error('Unexpected mutation'); } }) });
  return { open, calls, auth: () => auth, setAuth: (next: typeof auth) => { auth = next; }, setPages: (next: typeof pages) => { pages = next; } };
}
test('read-only existing credentials enumerate all pages but cannot submit imports', async () => {
  const f = setup(); const session = await f.open();
  try {
    expect(await session.status()).toBeNull(); expect((await session.prepare()).kind).toBe('prepared');
    expect(f.calls).toEqual(['knowledge.sources.list', 'knowledge.sources.list', 'workLedger.prepareLegacyImport']);
    expect(session).not.toHaveProperty('confirm');
    await expect(session.submit()).rejects.toThrow('write:work-ledger-import');
    expect(f.calls).toEqual(['knowledge.sources.list', 'knowledge.sources.list', 'workLedger.prepareLegacyImport']);
  } finally { session.dispose(); }
});
test('revocation and incomplete pagination cannot expose a prepared source manifest', async () => {
  const f = setup(); const session = await f.open();
  f.setPages(() => { f.setAuth({ ...f.auth(), scopes: ['read:work-ledger'] }); return { items: fixture.sources.map(item => item.source), hasMore: false }; });
  await expect(session.prepare()).rejects.toThrow('read:knowledge'); expect(f.calls).toEqual(['knowledge.sources.list']); session.dispose();
  const g = setup(); const other = await g.open(); g.setPages(() => ({ items: fixture.sources.map(item => item.source), hasMore: true }));
  await expect(other.prepare()).rejects.toThrow('cursor'); expect(g.calls).toEqual(['knowledge.sources.list']); other.dispose();
});
