import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openLegacyImportOperator } from '../terminal-shell/src/legacy-work-ledger-import-operator.js';
import { LegacyImportJournal, type LegacyImportCommand } from '../terminal-shell/src/legacy-work-ledger-import-journal.js';
import { prepareLegacyWorkLedgerMigration, projectLegacyImportWorks } from '../sdk/src/platform/workflow/work-ledger/legacy-import.js';
import type { JevDecision } from '@goodvibes-jev/judgment/decisions';
import fixture from '../../../products/agent/src/test/fixtures/legacy-ledger/preparation.json' with { type: 'json' };
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function harness() {
  const root = mkdtempSync(join(tmpdir(), 'import-workflow-')); roots.push(root);
  const path = join(root, 'journal.sqlite');
  const prepared = prepareLegacyWorkLedgerMigration(fixture); if (prepared.kind !== 'prepared') throw new Error(prepared.reason);
  const selected = { baseUrl: 'http://synthetic-host', token: 'synthetic-secret', workspace: root };
  const auth = { authenticated: true, admin: true, principalId: 'paired', principalKind: 'token', scopes: ['read:work-ledger', 'read:knowledge', 'write:work-ledger-import'] };
  const calls: string[] = []; const commands: LegacyImportCommand[] = [];
  const accepted = (command: LegacyImportCommand, replayed = false) => ({ kind: 'accepted', replayed, event: { type: 'import_legacy', requestId: command.requestId, actorId: 'host-actor', sequence: 1, at: 1, manifest: command.manifest, works: projectLegacyImportWorks(command.manifest, 1) } });
  let respond: (command: LegacyImportCommand, signal?: AbortSignal) => Promise<unknown> = async command => accepted(command);
  const open = () => openLegacyImportOperator({ projectId: fixture.projectId, journalPath: path, resolve: () => selected,
    createClient: () => ({ currentAuth: async () => auth, dispose() {}, invoke: async (method, input, signal) => {
      calls.push(method);
      if (method === 'knowledge.sources.list') return { items: fixture.sources.map(value => value.source), hasMore: false };
      if (method === 'workLedger.prepareLegacyImport') return prepared;
      if (method !== 'workLedger.importLegacy') throw new Error('Unexpected method');
      const command = input as LegacyImportCommand; commands.push(structuredClone(command));
      const journal = new LegacyImportJournal(path); try { expect(journal.read({ endpoint: selected.baseUrl, workspaceId: root, projectId: fixture.projectId, principalId: auth.principalId, principalKind: auth.principalKind })).toMatchObject({ state: 'unknown', command }); } finally { journal.close(); }
      return respond(command, signal);
    } }) });
  return { open, root, path, calls, commands, auth, selected, prepared, accepted, respond(fn: typeof respond) { respond = fn; } };
}
const refusal = (id: string): JevDecision => ({ schemaVersion: 1, decisionId: id, outcome: 'reject', summary: 'Synthetic host refusal', judgmentDecisionIds: ['recorded-fixture'], evidence: [{ id: 'source', revision: '1' }], binding: { sourceId: 'source', inputRevision: '1', actionId: 'action', actionRevision: '1', authorityId: 'paired', authorityRevision: '1', scopeId: 'project', scopeRevision: '1' } });

test('submit durably captures complete command before dispatch and repeated submit/status never dispatch again', async () => {
  const f = harness(); const session = await f.open();
  try {
    const saved = await session.submit(); expect(saved.state).toBe('accepted'); expect(saved.command.manifest).toEqual(f.prepared.manifest);
    expect(await session.submit()).toEqual(saved); expect(await session.status()).toEqual(saved);
    await expect(session.recover(saved.command.requestId)).rejects.toThrow('must be unknown');
    await expect(session.restart(saved.command.requestId)).rejects.toThrow('Only the selected');
    expect(f.commands).toHaveLength(1); expect(f.commands[0]!.requestId.length).toBeGreaterThan(0);
  } finally { session.dispose(); }
});

test('lost acknowledgement survives reopen and explicit recovery retains source, revision and request identity', async () => {
  const f = harness(); f.respond(async () => { throw new Error('lost acknowledgement'); });
  let session = await f.open();
  await expect(session.submit()).rejects.toThrow('lost acknowledgement'); const unknown = await session.status(); session.dispose();
  expect(unknown).toMatchObject({ state: 'unknown', attempts: 1 });
  session = await f.open();
  try {
    expect(await session.submit()).toEqual(unknown!); await expect(session.prepare()).rejects.toThrow('saved import');
    await expect(session.recover('wrong-request')).rejects.toThrow('does not match');
    expect((await session.cancel(unknown!.command.requestId)).state).toBe('unknown');
    f.respond(async command => f.accepted(command, true));
    const recovered = await session.recover(unknown!.command.requestId);
    expect(recovered).toMatchObject({ state: 'accepted', attempts: 2, result: { replayed: true } });
    expect(f.commands[1]).toEqual(f.commands[0]); expect(f.calls.filter(value => value === 'workLedger.prepareLegacyImport')).toHaveLength(1);
  } finally { session.dispose(); }
});

test('a non-act host decision is provenance and reconsideration is explicit with the same immutable command', async () => {
  const f = harness(); f.respond(async () => ({ kind: 'decision', decision: refusal('one') })); const session = await f.open();
  try {
    const held = await session.submit(); expect(held).toMatchObject({ state: 'pending', attempts: 1, decisions: [{ outcome: 'reject' }] });
    expect(await session.submit()).toEqual(held); expect(f.commands).toHaveLength(1);
    f.respond(async () => ({ kind: 'decision', decision: refusal('two') }));
    const again = await session.reconsider(held.command.requestId); expect(again).toMatchObject({ state: 'pending', attempts: 2 });
    expect(again.decisions).toHaveLength(2);
    f.respond(async command => f.accepted(command));
    expect((await session.reconsider(held.command.requestId)).state).toBe('accepted');
    expect(f.commands).toHaveLength(3); expect(f.commands.every(command => JSON.stringify(command) === JSON.stringify(held.command))).toBe(true);
  } finally { session.dispose(); }
});

test('only selected known terminal state permits new capture; stale request cannot cancel replacement', async () => {
  const f = harness(); f.respond(async () => ({ kind: 'decision', decision: refusal('one') })); const session = await f.open();
  try {
    const held = await session.submit(); expect((await session.cancel(held.command.requestId)).state).toBe('cancelled');
    f.respond(async command => f.accepted(command)); const fresh = await session.restart(held.command.requestId);
    expect(fresh.state).toBe('accepted'); expect(fresh.command.requestId).not.toBe(held.command.requestId);
    await expect(session.cancel(held.command.requestId)).rejects.toThrow('does not match');
    expect((await session.status())!.state).toBe('accepted');
  } finally { session.dispose(); }
});

test('read-only auth cannot reserve or dispatch; post-dispatch revocation cannot release unknown', async () => {
  const f = harness(); const session = await f.open();
  try {
    f.auth.scopes.pop(); await expect(session.submit()).rejects.toThrow('write:work-ledger-import'); expect(await session.status()).toBeNull(); expect(f.commands).toHaveLength(0);
    f.auth.scopes.push('write:work-ledger-import');
    f.respond(async command => { f.auth.scopes.pop(); return f.accepted(command); });
    await expect(session.submit()).rejects.toThrow('write:work-ledger-import'); expect((await session.status())!.state).toBe('unknown');
  } finally { session.dispose(); }
});

test('disposal aborts the owned transport and leaves dispatched work unknown across reopen', async () => {
  const f = harness(); let dispatched!: () => void; const started = new Promise<void>(resolve => { dispatched = resolve; });
  f.respond(async (_command, signal) => new Promise((_resolve, reject) => { dispatched(); signal!.addEventListener('abort', () => reject(new Error('interrupted')), { once: true }); }));
  const session = await f.open(); const pending = session.submit(); await started; session.dispose(); await expect(pending).rejects.toThrow('interrupted');
  const replacement = await f.open(); try { expect((await replacement.status())!.state).toBe('unknown'); } finally { replacement.dispose(); }
});

test('recovery refusal and forged act receipt never prove an earlier dispatch did not commit', async () => {
  const f = harness(); f.respond(async () => { throw new Error('lost'); }); const session = await f.open();
  try {
    await expect(session.submit()).rejects.toThrow('lost'); const command = (await session.status())!.command;
    f.respond(async () => ({ kind: 'decision', decision: refusal('recovery') }));
    expect((await session.recover(command.requestId)).state).toBe('unknown');
    f.respond(async () => ({ kind: 'decision', decision: { ...refusal('forged'), outcome: 'act' } }));
    await expect(session.recover(command.requestId)).rejects.toThrow('uncommitted act');
    expect((await session.status())!.state).toBe('unknown');
  } finally { session.dispose(); }
});


test('first known stale-source rejection permits only explicit selected restart with a fresh capture', async () => {
  const f = harness(); f.respond(async () => ({ kind: 'rejected', code: 'stale_source', reason: 'Complete persisted import sources changed.', revision: 0 }));
  const session = await f.open();
  try {
    const stale = await session.submit(); expect(stale).toMatchObject({ state: 'rejected', attempts: 1, result: { code: 'stale_source' } });
    expect(await session.submit()).toEqual(stale); expect(f.commands).toHaveLength(1);
    await expect(session.restart('wrong-request')).rejects.toThrow('Only the selected');
    f.respond(async command => f.accepted(command));
    const fresh = await session.restart(stale.command.requestId);
    expect(fresh.state).toBe('accepted'); expect(fresh.command.requestId).not.toBe(stale.command.requestId);
    expect(f.calls.filter(value => value === 'workLedger.prepareLegacyImport')).toHaveLength(2);
  } finally { session.dispose(); }
});

test('known stale-source recovery cannot release an earlier ambiguous dispatch or mint a replacement', async () => {
  const f = harness(); f.respond(async () => { throw new Error('lost prior response'); }); const session = await f.open();
  try {
    await expect(session.submit()).rejects.toThrow('lost prior response'); const command = (await session.status())!.command;
    f.respond(async () => ({ kind: 'rejected', code: 'stale_source', reason: 'Complete persisted import sources changed.', revision: 0 }));
    const recovered = await session.recover(command.requestId); expect(recovered).toMatchObject({ state: 'unknown', attempts: 2 });
    await expect(session.restart(command.requestId)).rejects.toThrow('Only the selected');
    expect(f.commands[1]).toEqual(command); expect(f.commands).toHaveLength(2);
  } finally { session.dispose(); }
});
