import { afterEach, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KnowledgeStore } from '../sdk/src/platform/knowledge/store.js';
import { createWorkLedger } from '../sdk/src/platform/workflow/work-ledger/service.js';
import { prepareLegacyWorkLedgerMigration } from '../sdk/src/platform/workflow/work-ledger/legacy-import.js';
import { acquireCrossProcessLock } from '../sdk/src/platform/workspace/checkpoint/cross-process-lock.js';
import type { SQLitePublicationIO } from '../sdk/src/platform/state/sqlite-store-persistence.js';
const roots: string[] = []; const stores: KnowledgeStore[] = [];
afterEach(async () => { await Promise.all(stores.splice(0).map(store => store.close())); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
async function fixture(file?: string, hostId = 'host') {
  if (!file) { const root = fs.mkdtempSync(join(tmpdir(), 'ledger-import-')); roots.push(root); file = join(root, 'knowledge.sqlite'); }
  const store = new KnowledgeStore({ dbPath: file }); stores.push(store);
  const storage = await store.openWorkLedgerStorage('project');
  const ledger = createWorkLedger({ projectId: 'project', importHostId: hostId, storage, clock: { now: () => 100, newId: kind => `${kind}:synthetic` } });
  const actor = ledger.authority.issueActor({ actorId: 'owner', projectId: 'project', role: 'coordinator' });
  return { file, store, storage, actor, ...ledger };
}
async function seed(host: Awaited<ReturnType<typeof fixture>>, ids = ['constructor', '__proto__', 'prototype', 'work:decision|x', '雪']) {
  await host.store.upsertSource({ id: 'source', connectorId: 'goodvibes-project-planning', sourceType: 'dataset', status: 'indexed', metadata: {
    projectPlanning: true, projectId: 'project', knowledgeSpaceId: 'space', planningArtifactKind: 'state', planningArtifactId: 'plan', value: {
      id: 'plan', projectId: 'project', knowledgeSpaceId: 'space', openQuestions: [{ id: '__proto__', prompt: 'Historical?' }], answeredQuestions: [],
      decisions: [{ id: 'constructor', text: 'History only' }], dependencies: [],
      tasks: ids.map(id => ({ id, title: `Legacy ${id}`, status: 'completed', executionApproved: true, verified: true, verification: ['Historical criterion'] })),
    },
  } });
  return command(host);
}
async function command(host: Awaited<ReturnType<typeof fixture>>, requestId = 'import-request') {
  const capture = host.store.getSourceSnapshot({ id: 'source' });
  const snapshot = await host.service.readSnapshot(host.actor);
  const result = prepareLegacyWorkLedgerMigration({ hostId: 'host', projectId: 'project', expectedLedgerRevision: snapshot.revision,
    pendingLocalChanges: false, sources: [{ source: capture.source, generation: capture.generation! }], occupiedWorkIds: [] });
  if (result.kind !== 'prepared') throw new Error(result.reason);
  return { type: 'import_legacy' as const, requestId, expectedRevision: snapshot.revision, manifest: result.manifest };
}
test('imports hostile valid IDs and full provenance atomically, preserving only historical claims; restart replay', async () => {
  const host = await fixture(); const request = await seed(host); const before = host.store.getSourceSnapshot({ id: 'source' });
  const result = await host.service.execute(request, host.actor);
  expect(result).toMatchObject({ kind: 'accepted', replayed: false, event: { type: 'import_legacy', sequence: 1 } });
  if (result.kind !== 'accepted') throw new Error('Expected import');
  const snapshot = await host.service.readSnapshot(host.actor);
  expect(snapshot.works.map(item => item.work.id)).toEqual(['constructor', '__proto__', 'prototype', 'work:decision|x', '雪']);
  expect(snapshot.works.every(item => item.verification.state === 'unverified' && item.attempt === null && item.work.reportedState === 'complete')).toBe(true);
  expect(host.store.getSourceSnapshot({ id: 'source' })).toEqual(before);
  expect(({} as Record<string, unknown>).executionApproved).toBeUndefined();
  expect((await host.service.history(0, host.actor))[0]).toMatchObject({ manifest: request.manifest });
  await host.service.close(); await host.store.close();
  const restarted = await fixture(host.file, 'new-host-instance'); const bytes = fs.readFileSync(host.file);
  expect(await restarted.service.execute(request, restarted.actor)).toEqual({ ...result, replayed: true });
  expect(fs.readFileSync(host.file)).toEqual(bytes);
  expect(await restarted.service.execute({ ...request, expectedRevision: 1 }, restarted.actor)).toMatchObject({ kind: 'rejected', code: 'request_conflict' });
});
test('stale source, target, host, identity collision and forged actor cannot partially commit', async () => {
  const host = await fixture(); const request = await seed(host, ['work:synthetic']);
  const forged = {} as typeof host.actor;
  expect(await host.service.execute(request, forged)).toMatchObject({ kind: 'rejected', code: 'forbidden' });
  const worker = host.authority.issueActor({ actorId: 'worker', projectId: 'project', role: 'worker' });
  expect(await host.service.execute(request, worker)).toMatchObject({ kind: 'rejected', code: 'forbidden' });
  const source = host.store.getSource('source')!;
  await host.store.upsertSource({ ...source, metadata: { ...source.metadata, changed: true } });
  const bytes = fs.readFileSync(host.file);
  expect(await host.service.execute(request, host.actor)).toMatchObject({ kind: 'rejected', code: 'stale_source' });
  expect(fs.readFileSync(host.file)).toEqual(bytes);
  const fresh = await command(host);
  expect(await host.service.execute({ type: 'create', requestId: 'native', expectedRevision: 0, title: 'Native', goal: 'Native', criteria: ['Native'] }, host.actor)).toMatchObject({ kind: 'accepted' });
  expect(await host.service.execute(fresh, host.actor)).toMatchObject({ kind: 'rejected', code: 'conflict' });
  const collision = await command(host); const collisionBytes = fs.readFileSync(host.file);
  expect(await host.service.execute(collision, host.actor)).toMatchObject({ kind: 'rejected', code: 'conflict' });
  expect(fs.readFileSync(host.file)).toEqual(collisionBytes);
});
test('lock-wait cancellation and live auth revocation leave no import; known receipt wins later abort', async () => {
  const host = await fixture(); const request = await seed(host); const bytes = fs.readFileSync(host.file);
  const release = await acquireCrossProcessLock(`${host.file}.knowledge-lock`, { strictOwnership: true });
  const abort = new AbortController(); const waiting = host.service.execute(request, host.actor, { signal: abort.signal });
  abort.abort(); await release();
  expect(await waiting).toMatchObject({ kind: 'rejected', code: 'cancelled' }); expect(fs.readFileSync(host.file)).toEqual(bytes);
  let allowed = true;
  const release2 = await acquireCrossProcessLock(`${host.file}.knowledge-lock`, { strictOwnership: true });
  const revoked = host.service.execute(request, host.actor, { isAuthorized: () => allowed }); allowed = false; await release2();
  expect(await revoked).toMatchObject({ kind: 'rejected', code: 'forbidden' }); expect(fs.readFileSync(host.file)).toEqual(bytes);
  expect(await host.service.execute(request, host.actor)).toMatchObject({ kind: 'accepted', replayed: false });
  expect(await host.service.execute(request, host.actor, { signal: abort.signal })).toMatchObject({ kind: 'accepted', replayed: true });
});
test('postrename durability ambiguity reconciles same request once, including aborted retry', async () => {
  const host = await fixture(); const request = await seed(host);
  const persistence = (host.store as unknown as { sqlite: { persistence: { io: SQLitePublicationIO } } }).sqlite.persistence;
  let fail = true;
  persistence.io = { ...fs, fsyncSync(fd) { if (fs.fstatSync(fd).isDirectory() && fail) { fail = false; throw new Error('owned fault'); } fs.fsyncSync(fd); } };
  expect(await host.service.execute(request, host.actor)).toMatchObject({ kind: 'indeterminate', requestId: request.requestId });
  const bytes = fs.readFileSync(host.file); const abort = new AbortController(); abort.abort();
  expect(await host.service.execute(request, host.actor, { signal: abort.signal })).toMatchObject({ kind: 'accepted', replayed: true });
  expect(fs.readFileSync(host.file)).toEqual(bytes); expect((await host.service.history(0, host.actor))).toHaveLength(1);
  expect((await host.service.readSnapshot(host.actor)).works).toHaveLength(5);
});
test('simultaneous requests serialize; malformed manifest, authority fields and envelope limits refuse unchanged', async () => {
  const host = await fixture(); const request = await seed(host);
  for (const bad of [{ ...request, actorId: 'owner' }, { ...request, manifest: { ...request.manifest, executionAuthority: 'approved' } },
    { ...request, manifest: { ...request.manifest, entities: [] } }, { ...request, requestId: 'x'.repeat(262145) }]) {
    expect(await host.service.execute(bad, host.actor)).toMatchObject({ kind: 'rejected', code: 'invalid_command' });
  }
  const results = await Promise.all([host.service.execute(request, host.actor), host.service.execute({ ...request, requestId: 'other' }, host.actor)]);
  expect(results.map(result => result.kind).sort()).toEqual(['accepted', 'rejected']);
  expect((await host.service.readSnapshot(host.actor)).revision).toBe(1);
});

test('forged complete source bytes with genuine generation and recomputed client digest are refused inside transaction', async () => {
  const host = await fixture(); await seed(host); const real = host.store.getSourceSnapshot({ id: 'source' });
  const forged = structuredClone(real.source!);
  const metadata = forged.metadata as { value: { tasks: { title: string }[] } };
  metadata.value.tasks[0]!.title = 'Caller-forged authority';
  const prepared = prepareLegacyWorkLedgerMigration({ hostId: 'host', projectId: 'project', expectedLedgerRevision: 0,
    pendingLocalChanges: false, sources: [{ source: forged, generation: real.generation! }], occupiedWorkIds: [] });
  if (prepared.kind !== 'prepared') throw new Error(prepared.reason);
  const bytes = fs.readFileSync(host.file);
  expect(await host.service.execute({ type: 'import_legacy', requestId: 'forged', expectedRevision: 0, manifest: prepared.manifest }, host.actor))
    .toMatchObject({ kind: 'rejected', code: 'stale_source' });
  expect(fs.readFileSync(host.file)).toEqual(bytes);
  expect((await host.service.readSnapshot(host.actor)).works).toHaveLength(0);
});

test('changed host preparation and unsaved local edits cannot import; exact request recovers after clean admission', async () => {
  const host = await fixture(); const request = await seed(host);
  const snapshot = host.store.getSourceSnapshot({ id: 'source' });
  const otherHost = prepareLegacyWorkLedgerMigration({ hostId: 'different-host', projectId: 'project', expectedLedgerRevision: 0, pendingLocalChanges: false,
    sources: [{ source: snapshot.source, generation: snapshot.generation! }], occupiedWorkIds: [] });
  if (otherHost.kind !== 'prepared') throw new Error(otherHost.reason);
  expect(await host.service.execute({ ...request, manifest: otherHost.manifest }, host.actor)).toMatchObject({ kind: 'rejected', code: 'conflict' });
  await host.store.batch(async () => {
    await host.store.upsertSource({ id: 'unrelated', connectorId: 'fixture', sourceType: 'manual', status: 'indexed' });
    expect(await host.service.execute(request, host.actor)).toMatchObject({ kind: 'indeterminate' });
  });
  expect((await host.service.readSnapshot(host.actor)).works).toHaveLength(0);
  expect(await host.service.execute(request, host.actor)).toMatchObject({ kind: 'accepted', replayed: false });
  expect(host.store.getSource('unrelated')).not.toBeNull();
});

test('live-auth revocation from the final signal accessor prevents commit', async () => {
  const host = await fixture(); const request = await seed(host); const bytes = fs.readFileSync(host.file);
  let allowed = true; let reads = 0;
  const signal = { get aborted() { if (++reads === 2) allowed = false; return false; } } as AbortSignal;
  expect(await host.service.execute(request, host.actor, { signal, isAuthorized: () => allowed })).toMatchObject({ kind: 'rejected', code: 'forbidden' });
  expect(fs.readFileSync(host.file)).toEqual(bytes);
});

test('local read capability preserves import cursor but protects provenance unless host explicitly grants knowledge access', async () => {
  const host = await fixture(); const request = await seed(host); await host.service.execute(request, host.actor);
  const { createLocalWorkLedgerReadBinding } = await import('../sdk/src/platform/workflow/work-ledger/read-client.js');
  const limited = createLocalWorkLedgerReadBinding({ available: true, projectId: 'project', actorId: 'limited-reader', service: host.service, authority: host.authority });
  const full = createLocalWorkLedgerReadBinding({ available: true, projectId: 'project', actorId: 'knowledge-reader', allowLegacyProvenance: true, service: host.service, authority: host.authority });
  if (!limited.available || !full.available) throw new Error('Expected bindings');
  const history = await limited.client.history(0);
  expect(history[0]).toMatchObject({ sequence: 1, manifest: null, provenance: 'requires_read_knowledge' });
  expect(JSON.stringify(history)).not.toContain('executionApproved');
  expect(JSON.stringify(history)).not.toContain('goodvibes-project-planning');
  expect((await limited.client.readSnapshot()).cursor).toBe(1);
  expect((await full.client.history(0))[0]).toMatchObject({ manifest: request.manifest });
  limited.client.dispose(); full.client.dispose();
});

test('full serialized envelope bound includes escaping in otherwise-valid request IDs', async () => {
  const host = await fixture(); await seed(host); const capture = host.store.getSourceSnapshot({ id: 'source' });
  let low = 0; let high = 262144; let manifest: ReturnType<typeof prepareLegacyWorkLedgerMigration> | undefined;
  while (low <= high) {
    const size = Math.floor((low + high) / 2);
    const source = { ...capture.source!, metadata: { ...capture.source!.metadata, boundedFixturePadding: 'x'.repeat(size) } };
    const next = prepareLegacyWorkLedgerMigration({ hostId: 'host', projectId: 'project', expectedLedgerRevision: 0,
      pendingLocalChanges: false, sources: [{ source, generation: capture.generation! }], occupiedWorkIds: [] });
    if (next.kind === 'prepared') { manifest = next; low = size + 1; } else high = size - 1;
  }
  if (manifest?.kind !== 'prepared') throw new Error('Expected bounded manifest');
  const normal = { type: 'import_legacy', requestId: 'bounded', expectedRevision: 0, manifest: manifest.manifest };
  const oversized = { ...normal, requestId: '\u0000'.repeat(200) };
  const { workLedgerCommandSchema } = await import('../sdk/src/platform/workflow/work-ledger/types.js');
  expect(workLedgerCommandSchema.safeParse(normal).success).toBe(true);
  expect(Buffer.byteLength(JSON.stringify(oversized))).toBeGreaterThan(262144);
  const bytes = fs.readFileSync(host.file);
  expect(await host.service.execute(oversized, host.actor)).toMatchObject({ kind: 'rejected', code: 'invalid_command' });
  expect(fs.readFileSync(host.file)).toEqual(bytes);
});
