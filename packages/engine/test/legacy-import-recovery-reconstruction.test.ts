import { afterEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { LegacyImportJournal, bindingKey } from '../terminal-shell/src/legacy-work-ledger-import-journal.js';
import { resolveLegacyImportJournalLocation } from '../terminal-shell/src/legacy-work-ledger-import-path.js';
import { captureLegacyImportAction } from '../sdk/src/platform/workflow/work-ledger/import-action-binding.js';
import { prepareLegacyWorkLedgerMigration, projectLegacyImportWorks } from '../sdk/src/platform/workflow/work-ledger/legacy-import.js';
import type { JevDecision } from '@goodvibes-jev/judgment/decisions';
import fixture from '../../../products/agent/src/test/fixtures/legacy-ledger/preparation.json';
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'reconstructed-import-')); roots.push(root);
  const prepared = prepareLegacyWorkLedgerMigration(fixture); if (prepared.kind !== 'prepared') throw new Error(prepared.reason);
  const binding = { endpoint: 'http://host', projectId: fixture.projectId, workspaceId: root, principalKind: 'user', principalId: 'principal' };
  const command = { type: 'import_legacy' as const, requestId: 'retained', expectedRevision: prepared.manifest.expectedLedgerRevision, manifest: prepared.manifest };
  const path = join(root, 'journal.sqlite');
  return { root, binding, command, path };
}
test('lost postcommit response survives reopen and exact receipt wins over later rejection', () => {
  const f = setup(); let journal = new LegacyImportJournal(f.path);
  try {
    journal.reserve(f.binding, () => f.command); journal.dispatch(f.binding); journal.close(); journal = new LegacyImportJournal(f.path);
    expect(journal.read(f.binding)).toMatchObject({ state: 'unknown', attempts: 1, command: f.command });
    expect(journal.reserve(f.binding, () => { throw new Error('Must not regenerate request'); }).command).toEqual(f.command);
    journal.dispatch(f.binding);
    const result = { kind: 'accepted' as const, replayed: true, event: { type: 'import_legacy' as const, sequence: 1, actorId: 'opaque-host-actor', requestId: f.command.requestId, at: 1, manifest: f.command.manifest, works: projectLegacyImportWorks(f.command.manifest, 1) } };
    expect(journal.record(f.binding, result).state).toBe('accepted');
    expect(journal.record(f.binding, { kind: 'rejected', code: 'forbidden', reason: 'revoked', revision: null }).state).toBe('accepted');
    expect(statSync(f.path).mode & 0o777).toBe(0o600);
  } finally { journal.close(); }
});
test('malformed receipts cannot release uncertainty and cancellation cannot claim post-dispatch rollback', () => {
  const f = setup(); const journal = new LegacyImportJournal(f.path);
  try {
    journal.reserve(f.binding, () => f.command); journal.dispatch(f.binding);
    expect(() => journal.record(f.binding, { kind: 'rejected' } as never)).toThrow();
    expect(journal.cancel(f.binding)?.state).toBe('unknown');
    expect(() => journal.reserve(f.binding, () => f.command, f.command.requestId)).toThrow('Unresolved');
    expect(() => journal.read({ ...f.binding, principalId: 'changed' })).toThrow('another');
    expect(() => journal.read({ ...f.binding, endpoint: 'http://other' })).toThrow('another');
  } finally { journal.close(); }
});
test('shared parser preserves immutable provenance without treating act as permission', () => {
  const f = setup(); const journal = new LegacyImportJournal(f.path);
  const decision: JevDecision = { schemaVersion: 1, decisionId: 'synthetic-storage-only', outcome: 'act', summary: 'Synthetic provenance; no evaluator or execution', judgmentDecisionIds: ['synthetic-record'], evidence: [{ id: 'source', revision: '1' }], binding: { sourceId: 'source', inputRevision: '1', actionId: 'action', actionRevision: '1', authorityId: 'principal', authorityRevision: '1', scopeId: 'project', scopeRevision: '1' } };
  try {
    journal.reserve(f.binding, () => f.command);
    const saved = journal.recordDecision(f.binding, f.command, decision);
    expect(saved).toMatchObject({ state: 'pending', attempts: 0, decisions: [decision] });
    expect(journal.recordDecision(f.binding, f.command, decision).decisions).toHaveLength(1);
    expect(() => journal.recordDecision(f.binding, f.command, { ...decision, outcome: 'reject' })).toThrow('identity changed');
    expect(() => journal.recordDecision(f.binding, f.command, { ...decision, approved: true })).toThrow();
  } finally { journal.close(); }
});
test('old journal upgrades preserve unresolved command and empty decision provenance', () => {
  const f = setup(); writeFileSync(f.path, '', { mode: 0o600 }); const old = new Database(f.path);
  old.exec('CREATE TABLE legacy_import(slot INTEGER PRIMARY KEY, binding TEXT, command TEXT, state TEXT, attempts INTEGER, result TEXT, actor TEXT)');
  old.query('INSERT INTO legacy_import VALUES(1,?,?,?,1,NULL,NULL)').run(bindingKey(f.binding), JSON.stringify(f.command), 'unknown'); old.close();
  const journal = new LegacyImportJournal(f.path);
  try { expect(journal.read(f.binding)).toMatchObject({ state: 'unknown', command: f.command, decisions: [] }); } finally { journal.close(); }
});
test('canonical shared journal aliases converge and old journals or fsync failures fail closed', () => {
  const f = setup(); const alias = join(f.root, 'alias'); const workspace = join(f.root, 'workspace'); mkdirSync(workspace); symlinkSync(workspace, alias);
  const a = resolveLegacyImportJournalLocation({ workspace, projectId: 'p', stateDirectory: f.root });
  expect(resolveLegacyImportJournalLocation({ workspace: alias, projectId: 'p', stateDirectory: f.root })).toEqual(a);
  expect(() => new LegacyImportJournal(f.path, () => { throw new Error('fsync failed'); })).toThrow('fsync failed');
  const old = a.journalPath.replace('/shared/', '/agent/'); mkdirSync(join(f.root, 'agent', 'legacy-import'), { recursive: true }); symlinkSync('/missing-file', old);
  expect(() => resolveLegacyImportJournalLocation({ workspace, projectId: 'p', stateDirectory: f.root })).toThrow('earlier Agent');
});
test('independent processes retain the winning exact command after the first process is killed', async () => {
  const f = setup(); const module = new URL('../terminal-shell/src/legacy-work-ledger-import-journal.ts', import.meta.url).pathname;
  const run = (id: string, hold: boolean) => Bun.spawn([process.execPath, '-e', `import {LegacyImportJournal} from ${JSON.stringify(module)};const j=new LegacyImportJournal(${JSON.stringify(f.path)});const e=j.reserve(${JSON.stringify(f.binding)},()=>({...${JSON.stringify(f.command)},requestId:${JSON.stringify(id)}}));console.log(e.command.requestId);${hold ? 'setInterval(()=>{},1000)' : 'j.close()'}`], { stdout: 'pipe', stderr: 'pipe' });
  const first = run('crash-before-send', true); const reader = first.stdout.getReader();
  try { const result = await reader.read(); expect(new TextDecoder().decode(result.value)).toContain('crash-before-send'); } finally { reader.releaseLock(); first.kill('SIGKILL'); await first.exited; }
  const competitors = [run('agent', false), run('tui', false)];
  for (const child of competitors) { expect((await new Response(child.stdout).text()).trim()).toBe('crash-before-send'); expect(await child.exited).toBe(0); }
});
test('complete action identity covers tails, selected store and actual principal', () => {
  const f = setup(); const facts = { storeId: '/store', projectId: f.binding.projectId, principalKind: 'user', principalId: 'principal', command: f.command };
  const original = captureLegacyImportAction(facts);
  expect(captureLegacyImportAction({ ...facts, storeId: '/other' }).actionId).not.toBe(original.actionId);
  expect(captureLegacyImportAction({ ...facts, principalId: 'other' }).requestKey).not.toBe(original.requestKey);
  const altered = structuredClone(fixture); Object.assign(altered.sources[0]!.source.metadata, { longEvidence: 'x'.repeat(6000) + 'different-tail' });
  const prepared = prepareLegacyWorkLedgerMigration(altered); if (prepared.kind !== 'prepared') throw new Error(prepared.reason);
  const changed = captureLegacyImportAction({ ...facts, command: { ...f.command, manifest: prepared.manifest } });
  expect(changed.requestKey).toBe(original.requestKey); expect(changed.actionId).not.toBe(original.actionId);
  expect(changed.commandJson).toContain('different-tail');
  expect(() => captureLegacyImportAction({ ...facts, command: { ...f.command, approved: true } })).toThrow();
});
