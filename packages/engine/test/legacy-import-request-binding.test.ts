import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LegacyImportJournal, type LegacyImportCommand } from '../terminal-shell/src/legacy-work-ledger-import-journal.js';
import { prepareLegacyWorkLedgerMigration } from '../sdk/src/platform/workflow/work-ledger/legacy-import.js';
import fixture from '../../../products/agent/src/test/fixtures/legacy-ledger/preparation.json' with { type: 'json' };

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const rejection = { kind: 'rejected' as const, code: 'conflict' as const, reason: 'Synthetic rejection of request A', revision: 0 };

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'import-request-binding-')); roots.push(root);
  const prepared = prepareLegacyWorkLedgerMigration(fixture);
  if (prepared.kind !== 'prepared') throw new Error(prepared.reason);
  const binding = { endpoint: 'http://synthetic-host', projectId: fixture.projectId, workspaceId: root, principalKind: 'user', principalId: 'test-owner' };
  const first: LegacyImportCommand = { type: 'import_legacy', requestId: 'A', expectedRevision: prepared.manifest.expectedLedgerRevision, manifest: prepared.manifest };
  return { binding, first, second: { ...first, requestId: 'B' }, path: join(root, 'journal.sqlite') };
}

test('a delayed rejection for archived A cannot reject dispatched B', () => {
  const f = setup(); const firstClient = new LegacyImportJournal(f.path); const secondClient = new LegacyImportJournal(f.path);
  try {
    firstClient.reserve(f.binding, () => f.first); firstClient.dispatch(f.binding, f.first);
    firstClient.record(f.binding, f.first, rejection);
    secondClient.reserve(f.binding, () => f.second, f.first.requestId);
    secondClient.dispatch(f.binding, f.second);
    // A queued result can be redelivered after another process replaces the terminal slot.
    expect(() => firstClient.record(f.binding, f.first, rejection)).toThrow('Import command changed');
    expect(secondClient.read(f.binding)).toMatchObject({ state: 'unknown', command: { requestId: 'B' }, attempts: 1, result: null });
    expect(secondClient.record(f.binding, f.second, { ...rejection, reason: 'Synthetic rejection of B' })).toMatchObject({ state: 'rejected', command: { requestId: 'B' } });
  } finally { firstClient.close(); secondClient.close(); }
});

test('admission for A cannot dispatch its replacement B', () => {
  const f = setup(); const firstClient = new LegacyImportJournal(f.path); const secondClient = new LegacyImportJournal(f.path);
  try {
    const admittedA = firstClient.reserve(f.binding, () => f.first);
    secondClient.cancel(f.binding, f.first);
    secondClient.reserve(f.binding, () => f.second, f.first.requestId);
    expect(() => firstClient.dispatch(f.binding, admittedA.command)).toThrow('Import command changed');
    expect(admittedA.command.requestId).toBe('A');
    expect(secondClient.read(f.binding)).toMatchObject({ state: 'pending', command: { requestId: 'B' }, attempts: 0, result: null });
    expect(secondClient.dispatch(f.binding, f.second)).toMatchObject({ state: 'unknown', command: f.second, attempts: 1 });
  } finally { firstClient.close(); secondClient.close(); }
});

test('a stale cancellation for A cannot cancel pending B', () => {
  const f = setup(); const firstClient = new LegacyImportJournal(f.path); const secondClient = new LegacyImportJournal(f.path);
  try {
    firstClient.reserve(f.binding, () => f.first);
    secondClient.cancel(f.binding, f.first);
    secondClient.reserve(f.binding, () => f.second, f.first.requestId);
    expect(() => firstClient.cancel(f.binding, f.first)).toThrow('Import command changed');
    expect(secondClient.read(f.binding)).toMatchObject({ state: 'pending', command: f.second, attempts: 0 });
    expect(secondClient.cancel(f.binding, f.second)).toMatchObject({ state: 'cancelled', command: f.second, attempts: 0 });
  } finally { firstClient.close(); secondClient.close(); }
});

test('command comparison includes the complete manifest and revision, not only the request ID', () => {
  const f = setup(); const journal = new LegacyImportJournal(f.path);
  const changedFixture = structuredClone(fixture);
  Object.assign(changedFixture.sources[0]!.source.metadata, { requestBindingControl: 'different complete source' });
  const changed = prepareLegacyWorkLedgerMigration(changedFixture);
  if (changed.kind !== 'prepared') throw new Error(changed.reason);
  const staleCommands: LegacyImportCommand[] = [
    { ...f.first, expectedRevision: f.first.expectedRevision + 1 },
    { ...f.first, manifest: changed.manifest },
  ];
  try {
    journal.reserve(f.binding, () => f.first); journal.dispatch(f.binding, f.first);
    for (const stale of staleCommands) {
      expect(stale.requestId).toBe(f.first.requestId);
      expect(() => journal.dispatch(f.binding, stale)).toThrow('Import command changed');
      expect(() => journal.cancel(f.binding, stale)).toThrow('Import command changed');
      expect(() => journal.record(f.binding, stale, rejection)).toThrow('Import command changed');
      expect(journal.read(f.binding)).toMatchObject({ state: 'unknown', command: f.first, attempts: 1, result: null });
    }
    expect(journal.cancel(f.binding, f.first)?.state).toBe('unknown');
  } finally { journal.close(); }
});

test('a stale client after process restart cannot mutate a replacement', async () => {
  const f = setup(); const journal = new LegacyImportJournal(f.path);
  try {
    journal.reserve(f.binding, () => f.first); journal.cancel(f.binding, f.first);
    journal.reserve(f.binding, () => f.second, f.first.requestId);
  } finally { journal.close(); }
  const module = new URL('../terminal-shell/src/legacy-work-ledger-import-journal.ts', import.meta.url).pathname;
  const child = Bun.spawn([process.execPath, '-e', `
    import { LegacyImportJournal } from ${JSON.stringify(module)};
    const journal = new LegacyImportJournal(${JSON.stringify(f.path)});
    try {
      for (const action of ['cancel', 'dispatch', 'record']) {
        try { journal[action](${JSON.stringify(f.binding)}, ${JSON.stringify(f.first)}, ${JSON.stringify(rejection)}); process.exitCode = 1; }
        catch (error) { if (!(error instanceof Error) || error.message !== 'Import command changed') throw error; }
      }
    } finally { journal.close(); }
  `], { stdout: 'pipe', stderr: 'pipe' });
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect({ out, err, code }).toEqual({ out: '', err: '', code: 0 });
  const reopened = new LegacyImportJournal(f.path);
  try { expect(reopened.read(f.binding)).toMatchObject({ state: 'pending', command: f.second, attempts: 0, result: null }); }
  finally { reopened.close(); }
});

test('a stale dispatch snapshot cannot race recovery or replacement even with the same command', () => {
  const f = setup(); const first = new LegacyImportJournal(f.path); const second = new LegacyImportJournal(f.path);
  try {
    const pending = first.reserve(f.binding, () => f.first);
    const dispatched = second.dispatch(f.binding, f.first, pending);
    expect(() => first.dispatch(f.binding, f.first, pending)).toThrow('dispatch state changed');
    expect(first.read(f.binding)).toMatchObject({ state: 'unknown', attempts: 1 });
    expect(second.dispatch(f.binding, f.first, dispatched)).toMatchObject({ state: 'unknown', attempts: 2 });
  } finally { first.close(); second.close(); }
});
