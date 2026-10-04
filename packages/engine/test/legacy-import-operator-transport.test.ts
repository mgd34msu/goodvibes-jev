import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createOperatorSdk } from '../operator-sdk/src/client.js';
import { openLegacyImportOperator } from '../terminal-shell/src/legacy-work-ledger-import-operator.js';
import { prepareLegacyWorkLedgerMigration } from '../sdk/src/platform/workflow/work-ledger/legacy-import.js';
import fixture from '../../../products/agent/src/test/fixtures/legacy-ledger/preparation.json' with { type: 'json' };

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function host() {
  const root = mkdtempSync(join(tmpdir(), 'import-operator-transport-')); roots.push(root);
  const prepared = prepareLegacyWorkLedgerMigration(fixture);
  if (prepared.kind !== 'prepared') throw new Error(prepared.reason);
  const sources = fixture.sources.map(entry => entry.source);
  const calls: string[] = [];
  let revoked = false; let revokeDuringDiscovery = false; let malformed = false;
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    if (request.headers.get('authorization') !== 'Bearer synthetic-read-token') return new Response(null, { status: 401 });
    const url = new URL(request.url); calls.push(url.pathname + url.search);
    if (url.pathname === '/api/control-plane/auth') return Response.json({
      authenticated: true, admin: true, principalId: 'synthetic-principal', principalKind: 'user',
      scopes: revoked ? ['read:work-ledger'] : ['read:work-ledger', 'read:knowledge'], roles: ['admin'],
      authMode: 'session', tokenPresent: true, authorizationHeaderPresent: true, sessionCookiePresent: false,
    });
    if (url.pathname === '/api/knowledge/sources') {
      if (!url.searchParams.has('limit')) return Response.json({ sources });
      if (malformed) return Response.json({ items: sources, hasMore: 'false' });
      if (revokeDuringDiscovery) revoked = true;
      return Response.json(url.searchParams.has('cursor')
        ? { items: sources.slice(1), hasMore: false }
        : { items: sources.slice(0, 1), hasMore: true, nextCursor: 'second-page' });
    }
    if (url.pathname === '/api/work-ledger/legacy-import/prepare') {
      expect(await request.json()).toEqual({ projectId: fixture.projectId, sourceIds: sources.map(source => source.id).sort() });
      return Response.json(prepared);
    }
    throw new Error(`Unexpected mutation or route: ${request.method} ${url.pathname}`);
  } });
  const baseUrl = `http://127.0.0.1:${server.port}`;
  return { calls, prepared, sources, baseUrl, close: () => server.stop(true),
    revokeDuringDiscovery() { revokeDuringDiscovery = true; }, malformed() { malformed = true; },
    open: () => openLegacyImportOperator({ projectId: fixture.projectId, journalPath: join(root, 'journal.sqlite'),
      resolve: () => ({ baseUrl, token: 'synthetic-read-token', workspace: root }) }),
  };
}

test('real operator SDK validates both legacy and paginated source responses before complete import preparation', async () => {
  const f = host(); const client = createOperatorSdk({ baseUrl: f.baseUrl, authToken: 'synthetic-read-token' });
  try {
    const legacy: unknown = await client.invoke('knowledge.sources.list');
    expect(legacy).toEqual({ sources: f.sources });
    const session = await f.open();
    try { expect(await session.prepare()).toEqual(f.prepared); } finally { session.dispose(); }
    expect(f.calls.filter(path => path.startsWith('/api/knowledge/sources'))).toEqual([
      '/api/knowledge/sources', '/api/knowledge/sources?limit=100&includeAllSpaces=true',
      '/api/knowledge/sources?limit=100&includeAllSpaces=true&cursor=second-page',
    ]);
    expect(f.calls.filter(path => path.startsWith('/api/work-ledger'))).toEqual(['/api/work-ledger/legacy-import/prepare']);
  } finally { client.dispose(); f.close(); }
});

test('real operator SDK retains response validation and post-page revocation fencing', async () => {
  const f = host();
  try {
    f.revokeDuringDiscovery(); const session = await f.open();
    try { await expect(session.prepare()).rejects.toThrow('read:knowledge'); } finally { session.dispose(); }
    expect(f.calls.filter(path => path.startsWith('/api/knowledge/sources'))).toHaveLength(1);
    expect(f.calls.some(path => path.startsWith('/api/work-ledger'))).toBe(false);
  } finally { f.close(); }
  const invalid = host();
  try {
    invalid.malformed(); const session = await invalid.open();
    try { await expect(session.prepare()).rejects.toThrow('Response validation failed'); } finally { session.dispose(); }
    expect(invalid.calls.some(path => path.startsWith('/api/work-ledger'))).toBe(false);
  } finally { invalid.close(); }
});
