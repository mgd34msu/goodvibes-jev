import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  acquireCrossProcessLock,
  AtomicWriteDurabilityError,
  confirmFileDurable,
  writeJsonFileAtomic,
} from '@goodvibes-jev/engine/sdk/platform/state/durable-file-io';
import {
  NATIVE_SUBMISSION_JOURNAL_MAX_BYTES,
  NativeWorkSubmissionJournal,
  type NativeSubmissionJournalBinding,
} from '../../runtime/native-work-submission-journal.ts';
import type { NativeWorkSubmissionRequest } from '@goodvibes-jev/engine/sdk/platform/workflow/work-ledger/native-submission-client';

const binding: NativeSubmissionJournalBinding = {
  endpoint: 'http://127.0.0.1:7777', projectId: 'fixture-project', workspace: '/fixture-workspace', principalId: 'fixture-principal',
};
const command: NativeWorkSubmissionRequest = {
  requestId: 'request-1', inputId: 'input-1', expectedRevision: 17,
  goal: '  Exact goal\r\n界 e\u0301  ', criteria: [' first\nline ', 'duplicate', 'duplicate', ' 最後 '],
};
const changed = (id: string): NativeWorkSubmissionRequest => ({ ...command, requestId: id, inputId: `input-${id}` });
async function fixture(run: (path: string, directory: string) => Promise<void>): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), 'native-submission-journal-'));
  try { await run(join(directory, 'journal.json'), directory); }
  finally { rmSync(directory, { recursive: true, force: true }); }
}

test('journal writes strict durable private data and restart preserves exact original source and revision', async () => fixture(async path => {
  const calls: string[] = [];
  const journal = new NativeWorkSubmissionJournal(path, {
    acquireCrossProcessLock: async (target, options) => {
      expect(options?.strictOwnership).toBe(true); calls.push('lock');
      const release = await acquireCrossProcessLock(target, options);
      return () => { calls.push('release'); release(); };
    },
    writeJsonFileAtomic: (target, value, options) => {
      expect(options).toEqual({ durable: true, mode: 0o600, indent: null, trailingNewline: false });
      calls.push('write'); writeJsonFileAtomic(target, value, options);
    },
  });
  expect(await journal.read(binding)).toBeUndefined();
  await journal.save(binding, command, null);
  expect(calls).toEqual(['lock', 'release', 'lock', 'write', 'release']);
  expect(statSync(path).mode & 0o777).toBe(0o600);
  const restarted = new NativeWorkSubmissionJournal(path);
  expect(await restarted.read(binding)).toEqual({ binding, command });
  await restarted.confirm(binding, command);
  const stored = JSON.parse(readFileSync(path, 'utf8'));
  expect(Object.keys(stored)).toEqual(['version', 'records']);
  expect(Object.keys(stored.records[0].binding)).toEqual(['endpoint', 'projectId', 'workspace', 'principalId']);
  expect(Object.keys(stored.records[0].command)).toEqual(['requestId', 'inputId', 'expectedRevision', 'goal', 'criteria']);
}));

test('a separate process recovers the identical retained request', async () => fixture(async path => {
  await new NativeWorkSubmissionJournal(path).save(binding, command, null);
  const module = new URL('../../runtime/native-work-submission-journal.ts', import.meta.url).href;
  const result = Bun.spawnSync([process.execPath, '--eval', `
    import { NativeWorkSubmissionJournal } from ${JSON.stringify(module)};
    console.log(JSON.stringify(await new NativeWorkSubmissionJournal(${JSON.stringify(path)}).read(${JSON.stringify(binding)})));
  `], { stdout: 'pipe', stderr: 'pipe' });
  expect(result.exitCode).toBe(0);
  expect(JSON.parse(result.stdout.toString())).toEqual({ binding, command });
}));

test('each binding component is exact and another principal cannot confirm or replace a retained request', async () => fixture(async path => {
  const journal = new NativeWorkSubmissionJournal(path);
  await journal.save(binding, command, null);
  for (const selected of [
    { ...binding, endpoint: `${binding.endpoint}/` }, { ...binding, projectId: 'other-project' },
    { ...binding, workspace: '/other-workspace' }, { ...binding, principalId: 'other-principal' },
  ]) {
    expect(await journal.read(selected)).toBeUndefined();
    await expect(journal.confirm(selected, command)).rejects.toThrow('conflict');
    await expect(journal.save(selected, changed('other'), command.requestId)).rejects.toThrow('conflict');
  }
  expect(await journal.read(binding)).toEqual({ binding, command });
}));

test('credentials and unknown fields cannot enter the binding or request schema', async () => fixture(async path => {
  const journal = new NativeWorkSubmissionJournal(path);
  for (const invalid of [
    { ...binding, token: 'do-not-store' }, { ...binding, hash: 'do-not-store' }, { ...binding, authMode: 'token' },
    { ...binding, endpoint: 'http://user:password@localhost' }, { ...binding, endpoint: 'http://localhost/?token=secret' },
    { ...binding, endpoint: 'http://localhost/#secret' }, { ...binding, endpoint: 'file:///tmp/fixture' }, { ...binding, principalId: '' },
  ]) await expect(journal.save(invalid, command, null)).rejects.toThrow('invalid_binding');
  for (const invalid of [{ ...command, token: 'do-not-store' }, { ...command, expectedRevision: -1 }, { ...command, criteria: [' '] }]) {
    await expect(journal.save(binding, invalid, null)).rejects.toThrow('invalid_command');
  }
  expect(existsSync(path)).toBe(false);
}));

test('failed durable publication prevents success and preserves the previous record', async () => fixture(async path => {
  await new NativeWorkSubmissionJournal(path).save(binding, command, null);
  const original = readFileSync(path);
  const failure = new AtomicWriteDurabilityError(path, 'before-publication', new Error('fixture sync failure'));
  const journal = new NativeWorkSubmissionJournal(path, { writeJsonFileAtomic() { throw failure; } });
  let caught: unknown;
  try { await journal.save(binding, changed('request-2'), command.requestId); } catch (error) { caught = error; }
  expect(caught).toBe(failure);
  expect(readFileSync(path)).toEqual(original);
  expect(await new NativeWorkSubmissionJournal(path).read(binding)).toEqual({ binding, command });
}));

test('published-indeterminate bytes remain visible and require exact explicit durable confirmation', async () => fixture(async path => {
  const failure = new AtomicWriteDurabilityError(path, 'published-indeterminate', new Error('fixture ancestry sync failure'));
  const journal = new NativeWorkSubmissionJournal(path, {
    writeJsonFileAtomic(target, value, options) { writeJsonFileAtomic(target, value, options); throw failure; },
  });
  let caught: unknown;
  try { await journal.save(binding, command, null); } catch (error) { caught = error; }
  expect(caught).toBe(failure);
  const visible = readFileSync(path);
  expect(await new NativeWorkSubmissionJournal(path).read(binding)).toEqual({ binding, command });
  let confirmations = 0;
  const recovering = new NativeWorkSubmissionJournal(path, { confirmFileDurable(target) { confirmations++; confirmFileDurable(target); } });
  await expect(recovering.confirm(binding, { ...command, goal: command.goal.trim() })).rejects.toThrow('conflict');
  await expect(recovering.confirm(binding, { ...command, criteria: [...command.criteria].reverse() })).rejects.toThrow('conflict');
  expect(confirmations).toBe(0);
  const stillFailing = new NativeWorkSubmissionJournal(path, { confirmFileDurable() { throw failure; } });
  await expect(stillFailing.confirm(binding, command)).rejects.toBe(failure);
  expect(readFileSync(path)).toEqual(visible);
  await recovering.confirm(binding, command);
  expect(confirmations).toBe(1);
  expect(readFileSync(path)).toEqual(visible);
}));

test('concurrent instances use compare-and-swap and cannot overwrite a winning identity', async () => fixture(async path => {
  const first = new NativeWorkSubmissionJournal(path); const second = new NativeWorkSubmissionJournal(path);
  const results = await Promise.allSettled([first.save(binding, command, null), second.save(binding, changed('request-2'), null)]);
  expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
  const loser = results.find(result => result.status === 'rejected');
  expect(loser?.status === 'rejected' && loser.reason.code).toBe('conflict');
  const retained = (await first.read(binding))!;
  await expect(second.save(binding, changed('request-3'), 'stale-id')).rejects.toThrow('conflict');
  await expect(second.save(binding, { ...retained.command, goal: 'changed source under identical ID' }, retained.command.requestId)).rejects.toThrow('conflict');
  await second.save(binding, changed('request-3'), retained.command.requestId);
  expect((await first.read(binding))?.command.requestId).toBe('request-3');
  await expect(first.confirm(binding, retained.command)).rejects.toThrow('conflict');
}));

test('concurrent independent bindings merge without dropping either retained identity', async () => fixture(async path => {
  const other = { ...binding, principalId: 'other-principal' };
  await Promise.all([
    new NativeWorkSubmissionJournal(path).save(binding, command, null),
    new NativeWorkSubmissionJournal(path).save(other, changed('other'), null),
  ]);
  const journal = new NativeWorkSubmissionJournal(path);
  expect(await journal.read(binding)).toEqual({ binding, command });
  expect(await journal.read(other)).toEqual({ binding: other, command: changed('other') });
}));

test('record and aggregate byte limits fail closed without evicting retained requests', async () => fixture(async path => {
  const journal = new NativeWorkSubmissionJournal(path);
  for (let index = 0; index < 16; index++) await journal.save({ ...binding, principalId: `principal-${index}` }, changed(`request-${index}`), null);
  const original = readFileSync(path);
  await expect(journal.save(binding, command, null)).rejects.toThrow('journal_limit');
  expect(readFileSync(path)).toEqual(original);
  const largePath = `${path}.large`;
  const large = new NativeWorkSubmissionJournal(largePath);
  const largeCommand = { ...command, goal: '界'.repeat(20_000), criteria: Array(3).fill('界'.repeat(20_000)) };
  for (let index = 0; index < 8; index++) await large.save({ ...binding, principalId: `principal-${index}` }, largeCommand, null);
  const before = readFileSync(largePath);
  await expect(large.save(binding, largeCommand, null)).rejects.toThrow('journal_limit');
  expect(readFileSync(largePath)).toEqual(before);
  expect(before.byteLength).toBeLessThanOrEqual(NATIVE_SUBMISSION_JOURNAL_MAX_BYTES);
}));

test('corrupt, oversize, invalid UTF-8 and duplicate-binding files are never quarantined into empty state', async () => fixture(async path => {
  const journal = new NativeWorkSubmissionJournal(path);
  const record = { binding, command };
  const examples = [
    '{broken', new Uint8Array([0xff, 0xfe]), 'x'.repeat(NATIVE_SUBMISSION_JOURNAL_MAX_BYTES + 1),
    JSON.stringify({ version: 2, records: [] }), JSON.stringify({ version: 1, records: [], token: 'extra' }),
    JSON.stringify({ version: 1, records: [record, record] }),
    JSON.stringify({ version: 1, records: [{ binding, command: { ...command, expectedRevision: -1 } }] }),
    JSON.stringify({ version: 1, records: Array.from({ length: 17 }, (_, i) => ({ binding: { ...binding, principalId: `${i}` }, command })) }),
  ];
  for (const bytes of examples) {
    writeFileSync(path, bytes, { mode: 0o600 });
    const before = readFileSync(path);
    await expect(journal.read(binding)).rejects.toThrow();
    await expect(journal.save(binding, command, null)).rejects.toThrow();
    await expect(journal.confirm(binding, command)).rejects.toThrow();
    expect(readFileSync(path)).toEqual(before);
  }
}));

test('symlink files and ancestors fail closed, including dangling links', async () => fixture(async (path, directory) => {
  const target = join(directory, 'real.json');
  await new NativeWorkSubmissionJournal(target).save(binding, command, null);
  symlinkSync(target, path);
  const journal = new NativeWorkSubmissionJournal(path);
  await expect(journal.read(binding)).rejects.toThrow();
  await expect(journal.save(binding, command, null)).rejects.toThrow();
  await expect(journal.confirm(binding, command)).rejects.toThrow();
  rmSync(path); symlinkSync(join(directory, 'missing.json'), path);
  await expect(journal.read(binding)).rejects.toThrow();
  await expect(journal.save(binding, command, null)).rejects.toThrow();
  const actual = join(directory, 'actual'); mkdirSync(actual);
  const link = join(directory, 'linked'); symlinkSync(actual, link);
  await expect(new NativeWorkSubmissionJournal(join(link, 'state.json')).save(binding, command, null)).rejects.toThrow();
  expect(await new NativeWorkSubmissionJournal(target).read(binding)).toEqual({ binding, command });
}));

test('strict lock acquisition failure prevents reading or writing state', async () => fixture(async path => {
  let writes = 0;
  const journal = new NativeWorkSubmissionJournal(path, {
    acquireCrossProcessLock: async (_target, options) => { expect(options?.strictOwnership).toBe(true); throw new Error('fixture lock refusal'); },
    writeJsonFileAtomic() { writes++; },
  });
  await expect(journal.read(binding)).rejects.toThrow('fixture lock refusal');
  await expect(journal.save(binding, command, null)).rejects.toThrow('fixture lock refusal');
  expect(writes).toBe(0); expect(existsSync(path)).toBe(false);
}));

test('strict dead-owner lock recovery after a process crash retains the original request', async () => fixture(async path => {
  await new NativeWorkSubmissionJournal(path).save(binding, command, null);
  const durableModule = import.meta.resolve('@goodvibes-jev/engine/sdk/platform/state/durable-file-io');
  const child = Bun.spawnSync([process.execPath, '--eval', `
    import { writeSync } from 'node:fs';
    import { acquireCrossProcessLock } from ${JSON.stringify(durableModule.startsWith('file:') ? durableModule : pathToFileURL(durableModule).href)};
    await acquireCrossProcessLock(${JSON.stringify(`${path}.lock`)}, { strictOwnership: true });
    writeSync(1, 'owned');
    process.kill(process.pid, 'SIGKILL');
  `], { stdout: 'pipe', stderr: 'pipe' });
  expect(child.stdout.toString()).toBe('owned');
  expect(child.success).toBe(false);
  const restarted = new NativeWorkSubmissionJournal(path, {
    acquireCrossProcessLock: (target, options) => acquireCrossProcessLock(target, {
      ...options, staleMs: 1, initialBackoffMs: 1, maxBackoffMs: 5, totalTimeoutMs: 1_000,
    }),
  });
  expect(await restarted.read(binding)).toEqual({ binding, command });
  await restarted.confirm(binding, command);
}));
