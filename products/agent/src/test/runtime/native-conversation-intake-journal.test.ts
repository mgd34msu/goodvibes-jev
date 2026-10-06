import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NativeConversationIntakeJournal } from '../../runtime/native-conversation-intake-journal.ts';
import { writeJsonFileAtomic } from '@goodvibes-jev/engine/sdk/platform/state/durable-file-io';
const binding = { endpoint: 'https://native.invalid', projectId: 'p', workspace: '/workspace', principalId: 'paired' };
const command = { requestId: 'request', inputId: 'input', text: '  Original\r\n😀  ', unsupportedSources: [{ kind: 'file' as const, label: '!@file.ts' }] };
async function fixture(run: (path: string, directory: string) => Promise<void>) {
  const directory = mkdtempSync(join(tmpdir(), 'native-intake-journal-'));
  try { await run(join(directory, 'journal.json'), directory); } finally { rmSync(directory, { recursive: true, force: true }); }
}
test('private durable journal preserves exact capture and host principal binding on restart', async () => fixture(async path => {
  await new NativeConversationIntakeJournal(path).save(binding, command, null);
  const restarted = new NativeConversationIntakeJournal(path); expect(await restarted.read(binding)).toEqual({ binding, command });
  expect(statSync(path).mode & 0o777).toBe(0o600); await restarted.confirm(binding, command);
  expect(await restarted.read({ ...binding, principalId: 'another' })).toBeUndefined();
  expect(Object.keys(JSON.parse(readFileSync(path, 'utf8')).records[0].binding)).toEqual(['endpoint', 'projectId', 'workspace', 'principalId']);
}));
test('a durable dispatch claim survives restart and never permits a second dispatch', async () => fixture(async path => {
  const journal = new NativeConversationIntakeJournal(path); await journal.save(binding, command, null);
  expect(await journal.claimTurn(binding, command, 'r1')).toBe(true);
  const restarted = new NativeConversationIntakeJournal(path); expect(await restarted.claimTurn(binding, command, 'r1')).toBe(false);
  await expect(restarted.claimTurn(binding, command, 'r2')).rejects.toThrow();
  await restarted.save(binding, command, command.requestId); expect((await restarted.read(binding))?.dispatch).toEqual({ sourceRevision: 'r1' });
}));
test('published ambiguous dispatch claim is preserved and cannot be reset by retry', async () => fixture(async path => {
  const journal = new NativeConversationIntakeJournal(path); await journal.save(binding, command, null);
  const failing = new NativeConversationIntakeJournal(path, { writeJsonFileAtomic: (target, value, options) => { writeJsonFileAtomic(target, value, options); throw new Error('published-indeterminate'); } });
  await expect(failing.claimTurn(binding, command, 'r1')).rejects.toThrow('published-indeterminate');
  expect(await journal.claimTurn(binding, command, 'r1')).toBe(false);
}));
test('same identity cannot change text, unsupported references or input identity', async () => fixture(async path => {
  const journal = new NativeConversationIntakeJournal(path); await journal.save(binding, command, null);
  for (const changed of [{ ...command, text: 'changed' }, { ...command, inputId: 'changed' }, { ...command, unsupportedSources: [] }]) await expect(journal.save(binding, changed, command.requestId)).rejects.toThrow();
  await expect(journal.save(binding, { ...command, requestId: 'new' }, null)).rejects.toThrow();
}));
test('credential-bearing endpoints, corrupt and symlink journals fail closed', async () => fixture(async (path, directory) => {
  const journal = new NativeConversationIntakeJournal(path);
  for (const endpoint of ['https://native.invalid?token=secret', 'https://u:secret@native.invalid', 'https://native.invalid#secret']) await expect(journal.save({ ...binding, endpoint }, command, null)).rejects.toThrow();
  writeFileSync(path, '{invalid'); await expect(journal.read(binding)).rejects.toThrow();
  const link = join(directory, 'link.json'); symlinkSync(path, link); await expect(new NativeConversationIntakeJournal(link).read(binding)).rejects.toThrow();
}));

test('execution intent is immutable, durable and separate from an ordinary turn claim', async () => fixture(async path => {
  const journal = new NativeConversationIntakeJournal(path); await journal.save(binding, command, null);
  const intent = { sourceRevision: 'r1', target: { workId: 'work', attemptId: 'attempt', expectedRevision: { work: 1, criteria: 2, attempt: 3 } } };
  await journal.saveExecutionIntent(binding, command, intent);
  const restarted = new NativeConversationIntakeJournal(path); expect((await restarted.read(binding))?.execution).toEqual(intent);
  await restarted.saveExecutionIntent(binding, command, intent);
  await expect(restarted.saveExecutionIntent(binding, command, { ...intent, target: { ...intent.target, attemptId: 'different' } })).rejects.toThrow();
  await expect(restarted.claimTurn(binding, command, 'r1')).rejects.toThrow();
  await restarted.save(binding, command, command.requestId); expect((await restarted.read(binding))?.execution).toEqual(intent);
}));
test('published-indeterminate execution intent remains exact and is confirmed on explicit recovery', async () => fixture(async path => {
  const journal = new NativeConversationIntakeJournal(path); await journal.save(binding, command, null);
  const intent = { sourceRevision: 'r1', target: { workId: 'work', attemptId: 'attempt', expectedRevision: { work: 1, criteria: 1, attempt: 1 } } };
  const failing = new NativeConversationIntakeJournal(path, { writeJsonFileAtomic: (target, value, options) => { writeJsonFileAtomic(target, value, options); throw new Error('published-indeterminate'); } });
  await expect(failing.saveExecutionIntent(binding, command, intent)).rejects.toThrow();
  await journal.saveExecutionIntent(binding, command, intent); expect((await journal.read(binding))?.execution).toEqual(intent);
}));

test('hosted delivery and continuation identity are durable before capture and cannot change mode', async () => fixture(async path => {
  const journal = new NativeConversationIntakeJournal(path);
  const original = { ...command, continuation: { sessionId: 'native-session' } };
  await journal.save(binding, original, null, { delivery: 'hosted' });
  const source = { version: 1 as const, inputId: command.inputId, sourceId: 'source', sourceRevision: 'r1', sessionId: 'intake-session', continuation: { sessionId: 'native-session', revision: 'a'.repeat(64) } };
  await journal.saveHostedSource(binding, original, source);
  const restarted = new NativeConversationIntakeJournal(path);
  expect(await restarted.read(binding)).toEqual({ binding, command: original, delivery: 'hosted', hostedSource: source });
  await expect(restarted.save(binding, original, original.requestId)).rejects.toThrow();
  await expect(restarted.claimTurn(binding, original, 'r1')).rejects.toThrow();
  await expect(restarted.saveHostedSource(binding, original, { ...source, sourceRevision: 'r2' })).rejects.toThrow();
  await expect(restarted.saveHostedSource(binding, original, { ...source, continuation: { ...source.continuation, revision: 'b'.repeat(64) } })).rejects.toThrow();
  await restarted.save(binding, original, original.requestId, { delivery: 'hosted' });
  expect((await restarted.read(binding))?.hostedSource).toEqual(source);
  expect(Object.keys((await restarted.read(binding))!.command.continuation!)).toEqual(['sessionId']);
}));

test('hosted source publication failure preserves the immutable visible identity for recovery', async () => fixture(async path => {
  const journal = new NativeConversationIntakeJournal(path); await journal.save(binding, command, null, { delivery: 'hosted' });
  const source = { version: 1 as const, inputId: command.inputId, sourceId: 'source', sourceRevision: 'r1', sessionId: 'intake-session' };
  const failing = new NativeConversationIntakeJournal(path, { writeJsonFileAtomic: (target, value, options) => { writeJsonFileAtomic(target, value, options); throw new Error('published-indeterminate'); } });
  await expect(failing.saveHostedSource(binding, command, source)).rejects.toThrow('published-indeterminate');
  await journal.saveHostedSource(binding, command, source);
  expect((await journal.read(binding))?.hostedSource).toEqual(source);
}));

test('hosted journal rejects local dispatch, unsupported modes and transcript-bearing continuation', async () => fixture(async path => {
  const journal = new NativeConversationIntakeJournal(path);
  const source = { version: 1 as const, inputId: command.inputId, sourceId: 'source', sourceRevision: 'r1', sessionId: 'intake-session' };
  for (const record of [
    { binding, command, delivery: 'hosted', dispatch: { sourceRevision: 'r1' } },
    { binding, command, delivery: 'local' },
    { binding, command, hostedSource: source },
    { binding, command: { ...command, continuation: { sessionId: 's', messages: [] } }, delivery: 'hosted' },
    { binding, command, delivery: 'hosted', hostedSource: { ...source, inputId: 'different' } },
  ]) {
    writeFileSync(path, JSON.stringify({ version: 1, records: [record] }));
    await expect(journal.read(binding)).rejects.toThrow();
  }
}));

test('Agent recovery fails closed on a selected-diff continuation instead of dropping its evidence selector', async () => fixture(async path => {
  const journal = new NativeConversationIntakeJournal(path);
  const original = { ...command, continuation: { sessionId: 'native-session', selectedDiff: { kind: 'session' as const, revision: 'a'.repeat(64), fileIndex: 0, hunkIndex: 0 } } };
  await expect(journal.save(binding, original, null, { delivery: 'hosted' })).rejects.toThrow();
  writeFileSync(path, JSON.stringify({ version: 1, records: [{ binding, command: original, delivery: 'hosted' }] }));
  await expect(journal.read(binding)).rejects.toThrow();
  expect(JSON.parse(readFileSync(path, 'utf8')).records[0].command).toEqual(original);
}));
