/** Owned loopback host for product command proofs. Only host responses are synthetic. */
import { strict as assert } from 'node:assert';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { JevDecision } from '@goodvibes-jev/judgment/decisions';
import { LegacyImportJournal, resolveLegacyImportJournalLocation, type LegacyImportCommand } from '@goodvibes-jev/engine/terminal-shell/legacy-work-ledger-import';
import { prepareLegacyWorkLedgerMigration, projectLegacyImportWorks, workLedgerCommandSchema } from '@goodvibes-jev/engine/sdk/platform/workflow/work-ledger';
import input from '../fixtures/legacy-ledger/preparation.json';

export const IMPORT_FIXTURE_TOKEN = 'synthetic-import-paired-token';
export const IMPORT_FIXTURE_PRINCIPAL = 'pairing:synthetic-paired-owner';
export type ImportHostReply = 'accepted' | 'lost-ack' | 'decision' | 'rejected' | 'uncommitted-act';
export const IMPORT_ROUTES = { auth: '/api/control-plane/auth', sources: '/api/knowledge/sources', prepare: '/api/work-ledger/legacy-import/prepare', submit: '/api/work-ledger/legacy-import' } as const;
export function importHostDecision(outcome: 'act' | 'reject' = 'reject', suffix = '1'): JevDecision {
  return { schemaVersion: 1, decisionId: `host-import-decision-${suffix}`, outcome, summary: 'Synthetic host semantic response', judgmentDecisionIds: [`synthetic-reading-${suffix}`],
    evidence: [{ id: 'legacy-source', revision: '1' }], binding: { sourceId: 'legacy-source', inputRevision: '1', actionId: 'legacy-import', actionRevision: '1', authorityId: IMPORT_FIXTURE_PRINCIPAL, authorityRevision: '1', scopeId: input.projectId, scopeRevision: '1' } };
}
export function createLegacyImportHostFixture() {
  const root = mkdtempSync(join(tmpdir(), 'product-legacy-import-'));
  const home = join(root, 'home'); const workspace = join(root, 'workspace');
  mkdirSync(home); mkdirSync(workspace);
  const original = structuredClone(input);
  // A tail beyond common prompt truncation limits must reach the immutable command.
  Object.assign(original.sources[0]!.source.metadata, { opaqueHistory: 'historical-context-'.repeat(400) + 'exact-source-tail' });
  const prepared = prepareLegacyWorkLedgerMigration(original);
  if (prepared.kind !== 'prepared') throw new Error(prepared.reason);
  const sourceFile = join(root, 'persisted-legacy-sources.json');
  const sourceBytes = JSON.stringify(original.sources); writeFileSync(sourceFile, sourceBytes);
  const requests: { method: string; path: string; query: string; body?: unknown }[] = [];
  const commands: LegacyImportCommand[] = []; const commandBytes: string[] = [];
  const unexpected: string[] = [];
  const receipts = new Map<string, ReturnType<typeof accepted>>();
  let reply: ImportHostReply = 'accepted'; let scopes = ['read:work-ledger', 'read:knowledge', 'write:work-ledger-import']; let admin = true;
  let duringRequest: ((path: string) => void) | undefined;
  let redirect: { path: string; destination: string } | undefined;
  let journalPath = '';
  function accepted(command: LegacyImportCommand, replayed = false) {
    return { kind: 'accepted' as const, replayed, event: { type: 'import_legacy' as const, sequence: 1, actorId: 'host:opaque-import-actor', requestId: command.requestId, at: 1,
      manifest: command.manifest, works: projectLegacyImportWorks(command.manifest, 1) } };
  }
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const url = new URL(request.url); const path = url.pathname;
    assert.equal(request.headers.get('authorization'), `Bearer ${IMPORT_FIXTURE_TOKEN}`);
    const record = { method: request.method, path, query: url.search, ...(request.method === 'POST' ? { body: await request.json() } : {}) }; requests.push(record);
    duringRequest?.(path);
    if (redirect?.path === path) return new Response(null, { status: 307, headers: { location: redirect.destination } });
    if (path === IMPORT_ROUTES.auth && request.method === 'GET') return Response.json({ authenticated: true, authMode: 'shared-token', tokenPresent: true, authorizationHeaderPresent: true, sessionCookiePresent: false,
      principalId: IMPORT_FIXTURE_PRINCIPAL, principalKind: 'token', admin, scopes, roles: ['admin'] });
    if (path === IMPORT_ROUTES.sources && request.method === 'GET') {
      assert.equal(url.searchParams.get('limit'), '100'); assert.equal(url.searchParams.get('includeAllSpaces'), 'true');
      const sources = original.sources.map(entry => entry.source);
      return Response.json(url.searchParams.has('cursor') ? { items: sources.slice(1), hasMore: false } : { items: sources.slice(0, 1), hasMore: true, nextCursor: 'remaining-legacy-sources' });
    }
    if (path === IMPORT_ROUTES.prepare && request.method === 'POST') {
      assert.deepEqual(record.body, { projectId: original.projectId, sourceIds: original.sources.map(entry => entry.source.id).sort() });
      return Response.json(prepared);
    }
    if (path === IMPORT_ROUTES.submit && request.method === 'POST') {
      const command = workLedgerCommandSchema.parse(record.body);
      assert.equal(command.type, 'import_legacy');
      if (command.type !== 'import_legacy') throw new Error('Expected import command');
      commands.push(command); commandBytes.push(JSON.stringify(record.body));
      assert.deepEqual(command.manifest, prepared.manifest);
      // The journal must already be durably reserved and unknown at the wire boundary.
      const journal = new LegacyImportJournal(journalPath);
      try { const saved = journal.read(binding()); assert.ok(saved); assert.equal(saved.state, 'unknown'); assert.deepEqual(saved.command, command); assert.equal(saved.attempts, commands.filter(prior => prior.requestId === command.requestId).length); } finally { journal.close(); }
      if (reply === 'decision' || reply === 'uncommitted-act') return Response.json({ kind: 'decision', decision: importHostDecision(reply === 'decision' ? 'reject' : 'act', String(commands.length)) });
      if (reply === 'rejected') return Response.json({ kind: 'rejected', code: 'stale_source', reason: 'Synthetic source changed before admission', revision: 0 });
      const prior = receipts.get(command.requestId); const result = prior ? { ...prior, replayed: true } : accepted(command);
      receipts.set(command.requestId, result);
      if (reply === 'lost-ack') return new Response('Synthetic response lost after host commit', { status: 503 });
      return Response.json(result);
    }
    unexpected.push(`${request.method} ${path}`);
    return new Response('Unexpected fixture route', { status: 500 });
  } });
  const baseUrl = server.url.origin;
  journalPath = resolveLegacyImportJournalLocation({ workspace, projectId: original.projectId, stateDirectory: join(home, '.goodvibes') }).journalPath;
  function binding() { return { endpoint: baseUrl, projectId: original.projectId, workspaceId: workspace, principalId: IMPORT_FIXTURE_PRINCIPAL, principalKind: 'token' }; }
  return { root, home, workspace, baseUrl, projectId: original.projectId, journalPath, prepared, original, requests, commands, commandBytes, unexpected,
    setReply(value: ImportHostReply) { reply = value; }, setScopes(value: string[]) { scopes = value; }, setAdmin(value: boolean) { admin = value; },
    onRequest(callback: (path: string) => void) { duringRequest = callback; },
    redirect(path: string, destination: string) { redirect = { path, destination }; },
    read() { const journal = new LegacyImportJournal(journalPath); try { return journal.read(binding()); } finally { journal.close(); } },
    assertPreserved() { assert.equal(readFileSync(sourceFile, 'utf8'), sourceBytes); assert.deepEqual(JSON.parse(sourceBytes), original.sources); assert.deepEqual(unexpected, []); },
    async stop() { await server.stop(true); rmSync(root, { recursive: true, force: true }); },
  };
}
export type LegacyImportHostFixture = ReturnType<typeof createLegacyImportHostFixture>;
