import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { NativeWorkSubmissionControls, nativeWorkSubmissionLines, type NativeWorkSubmissionSelection } from '../../../runtime/native-work-submission.ts';
import { parseNativeWorkSourceJson, readNativeWorkSourceFile } from '../../../runtime/native-work-submission-source.ts';
import type { NativeSubmissionJournalBinding, NativeSubmissionJournalRecord } from '../../../runtime/native-work-submission-journal.ts';
import type { NativeWorkSubmissionRequest, NativeWorkSubmissionReceipt, OperatorNativeWorkSubmissionClient } from '@goodvibes-jev/engine/sdk/platform/workflow/work-ledger/native-submission-client';
const tick = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const source = { goal: '  Original goal\nkeep spaces  ', criteria: ['  first  ', 'second\nline', '  first  '] };
const receipt = (command: NativeWorkSubmissionRequest): NativeWorkSubmissionReceipt => ({
  projectId: 'p', requestId: command.requestId, inputId: command.inputId, ledgerRevision: command.expectedRevision + 1,
  workId: 'native-work', attemptId: 'native-attempt', expectedRevision: { work: 1, criteria: 1, attempt: 1 },
  source: { version: 1, sourceId: 'source-1', sourceRevision: 'source-r1', sessionId: 'session-1' },
  goal: command.goal, criteria: [...command.criteria],
});
function fixture() {
  let identity = 'host-token-workspace'; let revision = 7; let ids = 0; let disposed = 0;
  const calls: string[] = []; const commands: NativeWorkSubmissionRequest[] = []; const lookups: string[] = [];
  const client: OperatorNativeWorkSubmissionClient = {
    async submit(command) { calls.push('submit'); commands.push(structuredClone(command)); return { kind: 'submitted', replayed: false, receipt: receipt(command) }; },
    async get({ requestId }) { calls.push('get'); lookups.push(requestId); return { kind: 'not-found' }; }, dispose() {},
  };
  const records = new Map<string, NativeSubmissionJournalRecord>();
  const key = (binding: NativeSubmissionJournalBinding) => JSON.stringify(binding);
  const journal = {
    async read(binding: NativeSubmissionJournalBinding) { const record = records.get(key(binding)); return record ? structuredClone(record) : undefined; },
    async save(binding: NativeSubmissionJournalBinding, command: NativeWorkSubmissionRequest, expected: string | null) {
      if ((records.get(key(binding))?.command.requestId ?? null) !== expected) throw { code: 'conflict' };
      records.set(key(binding), structuredClone({ binding, command }));
    },
    async confirm(binding: NativeSubmissionJournalBinding, command: NativeWorkSubmissionRequest) {
      if (JSON.stringify(records.get(key(binding))?.command) !== JSON.stringify(command)) throw { code: 'conflict' };
    },
  };
  const selection = (): NativeWorkSubmissionSelection => ({ available: true, identity, endpoint: identity === 'replacement-host' ? 'https://replacement.invalid' : 'https://fixture.invalid', projectId: 'p', workspace: identity === 'replacement-workspace' ? '/other' : '/fixture', journal, bind: () => ({
    client, readPrincipal: async () => identity === 'replacement-token' ? 'principal-two' : 'principal-one', readSnapshot: async () => { calls.push('snapshot'); return { projectId: 'p', revision, cursor: revision, works: [] }; }, dispose() { disposed++; },
  }) });
  const controls = new NativeWorkSubmissionControls(selection, () => `identity-${++ids}`);
  return { controls, client, calls, commands, lookups, journal, records, restart: () => new NativeWorkSubmissionControls(selection, () => `identity-${++ids}`), ids: () => ids, disposed: () => disposed,
    replaceBinding(value: string) { identity = value; }, setRevision(value: number) { revision = value; } };
}

test('source JSON preserves exact strings, criterion order and duplicates while refusing incomplete input', () => {
  expect(parseNativeWorkSourceJson(JSON.stringify(source))).toEqual(source);
  for (const value of [{ goal: '', criteria: ['x'] }, { goal: '  \n', criteria: ['x'] }, { goal: 'g' }, { goal: 'g', criteria: [] }, { goal: 'g', criteria: [' '] }, { goal: 'g', criteria: [1] }, { ...source, expectedRevision: 7 }, { ...source, goal: 'x'.repeat(20_001) }, { goal: 'g', criteria: Array(101).fill('x') }]) {
    expect(() => parseNativeWorkSourceJson(JSON.stringify(value))).toThrow();
  }
  expect(() => parseNativeWorkSourceJson('{bad')).toThrow();
  expect(() => parseNativeWorkSourceJson(JSON.stringify({ goal: '界'.repeat(20_000), criteria: Array(4).fill('界'.repeat(20_000)) }))).toThrow();
});

test('file input keeps UTF-8/JSON text intact and supports encoded-space file URLs', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'native-source-file-'));
  try {
    const path = join(directory, 'original source.json'); writeFileSync(path, JSON.stringify(source));
    expect(await readNativeWorkSourceFile(pathToFileURL(path).href, directory)).toEqual(source);
    await expect(readNativeWorkSourceFile(directory, directory)).rejects.toThrow();
    writeFileSync(path, new Uint8Array([0xff, 0xfe, 0x00])); await expect(readNativeWorkSourceFile(path, directory)).rejects.toThrow();
    writeFileSync(path, 'x'.repeat(262_145)); await expect(readNativeWorkSourceFile(path, directory)).rejects.toThrow();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('initial submission captures live ledger revision and exact source once, without execution authority fields', async () => {
  const f = fixture(); const result = await f.controls.submitSource(source);
  expect(f.calls).toEqual(['snapshot', 'submit']); expect(f.ids()).toBe(2);
  expect(f.commands[0]).toEqual({ requestId: 'identity-1', inputId: 'identity-2', expectedRevision: 7, ...source });
  expect(result?.status).toBe('submitted'); expect(result?.receipt?.workId).toBe('native-work');
  expect(nativeWorkSubmissionLines(result).join(' ')).toContain('No execution was started');
  expect(Object.keys(result!.request!)).toEqual(['requestId', 'inputId', 'expectedRevision']);
  expect(f.disposed()).toBe(1); f.controls.close();
});

test('invalid source is refused locally before opening any native binding or creating identities', async () => {
  const f = fixture(); const result = await f.controls.submitSource({ goal: 'g', criteria: [] });
  expect(result?.status).toBe('invalid'); expect(f.calls).toEqual([]); expect(f.ids()).toBe(0); f.controls.close();
});

test('lost response keeps IDs, source and expected revision; retry performs lookup before identical replay', async () => {
  const f = fixture(); let attempts = 0;
  f.client.submit = async command => { f.calls.push('submit'); f.commands.push(structuredClone(command)); if (!attempts++) throw new Error('lost response with secret token'); return { kind: 'submitted', replayed: true, receipt: receipt(command) }; };
  const result = await f.controls.submitSource(source); expect(result?.status).toBe('unknown');
  f.setRevision(99);
  const refusedNew = await f.controls.submitSource({ goal: 'Changed source', criteria: ['Changed'] }); expect(refusedNew?.status).toBe('unknown'); expect(f.ids()).toBe(2);
  const recovered = await f.controls.retry();
  expect(f.calls).toEqual(['snapshot', 'submit', 'get', 'submit']); expect(f.commands[1]).toEqual(f.commands[0]);
  expect(f.lookups).toEqual(['identity-1']); expect(f.ids()).toBe(2); expect(recovered?.replayed).toBe(true);
  expect(nativeWorkSubmissionLines(result).join(' ')).not.toContain('secret token'); f.controls.close();
});

test('found lookup recovers original receipt without sending another submission', async () => {
  const f = fixture(); f.client.submit = async command => { f.calls.push('submit'); f.commands.push(structuredClone(command)); throw new Error('lost'); };
  await f.controls.submitSource(source);
  f.client.get = async ({ requestId }) => { f.calls.push('get'); expect(requestId).toBe('identity-1'); return { kind: 'found', receipt: receipt(f.commands[0]!) }; };
  const recovered = await f.controls.retry(); expect(recovered?.status).toBe('submitted'); expect(f.calls).toEqual(['snapshot', 'submit', 'get']); f.controls.close();
});

test('lookup failures and not-found inspection never resubmit or change original IDs', async () => {
  const f = fixture(); f.client.submit = async command => { f.calls.push('submit'); f.commands.push(structuredClone(command)); throw new Error('lost'); };
  await f.controls.submitSource(source); const missing = await f.controls.status(); expect(missing?.status).toBe('not-found');
  f.client.get = async () => { f.calls.push('get'); throw new Error('lookup failed'); };
  expect((await f.controls.retry())?.status).toBe('unknown'); expect(f.calls).toEqual(['snapshot', 'submit', 'get', 'get']); expect(f.ids()).toBe(2); f.controls.close();
});

test('definite stale-ledger conflict needs an explicitly new source submission for fresh revision and IDs', async () => {
  const f = fixture(); f.client.submit = async command => { f.calls.push('submit'); f.commands.push(structuredClone(command)); throw { code: 'NATIVE_SUBMISSION_CONFLICT' }; };
  expect((await f.controls.submitSource(source))?.status).toBe('conflict'); f.setRevision(10);
  expect((await f.controls.retry())?.status).toBe('not-found'); expect(f.calls).toEqual(['snapshot', 'submit', 'get']); expect(f.ids()).toBe(2);
  await f.controls.submitSource(source); expect(f.commands[1]?.expectedRevision).toBe(10); expect(f.commands[1]?.requestId).toBe('identity-3'); f.controls.close();
});

test('duplicate actions cannot queue another submit while a request is pending; close only detaches transport', async () => {
  const f = fixture(); let finish!: (value: Awaited<ReturnType<OperatorNativeWorkSubmissionClient['submit']>>) => void; let signal: AbortSignal | undefined;
  f.client.submit = (command, options) => { f.calls.push('submit'); f.commands.push(structuredClone(command)); signal = options?.signal; return new Promise(resolve => { finish = resolve; }); };
  const pending = f.controls.submitSource(source); await tick(); await f.controls.submitSource(source); await f.controls.retry(); expect(f.calls).toEqual(['snapshot', 'submit']);
  f.controls.close(); expect(signal?.aborted).toBe(true); finish({ kind: 'submitted', replayed: false, receipt: receipt(f.commands[0]!) }); expect(await pending).toBeUndefined(); expect(f.controls.state).toBeUndefined();
  f.client.get = async () => { f.calls.push('get'); return { kind: 'found', receipt: receipt(f.commands[0]!) }; };
  expect((await f.controls.retry())?.status).toBe('submitted'); expect(f.ids()).toBe(2); f.controls.close();
});

for (const changed of ['host', 'token', 'workspace']) {
  test(`${changed} replacement aborts/drops stale submission and preserves original identity for its binding`, async () => {
    const f = fixture(); let finish!: (value: Awaited<ReturnType<OperatorNativeWorkSubmissionClient['submit']>>) => void; let signal: AbortSignal | undefined;
    f.client.submit = (command, options) => { f.calls.push('submit'); f.commands.push(structuredClone(command)); signal = options?.signal; return new Promise(resolve => { finish = resolve; }); };
    const pending = f.controls.submitSource(source); await tick(); f.replaceBinding(`replacement-${changed}`); await f.controls.status();
    expect(signal?.aborted).toBe(true); finish({ kind: 'submitted', replayed: false, receipt: receipt(f.commands[0]!) }); expect(await pending).toBeUndefined(); expect(f.controls.state).toBeUndefined();
    expect((await f.controls.retry())?.status).toBe('unavailable'); expect(f.ids()).toBe(2);
    f.replaceBinding('host-token-workspace'); f.client.get = async () => ({ kind: 'found', receipt: receipt(f.commands[0]!) });
    expect((await f.controls.retry())?.receipt?.requestId).toBe('identity-1'); f.controls.close();
  });
}

test('source and input identity in a looked-up receipt must match before it can become a submission receipt', async () => {
  const f = fixture(); f.client.submit = async command => { f.commands.push(structuredClone(command)); throw new Error('lost'); }; await f.controls.submitSource(source);
  f.client.get = async () => ({ kind: 'found', receipt: { ...receipt(f.commands[0]!), goal: 'Different source' } });
  const result = await f.controls.status(); expect(result?.status).toBe('unknown'); expect(result?.receipt).toBeUndefined(); expect(f.ids()).toBe(2); f.controls.close();
});

test('unsupported authority stays visible and does not request new scopes or expose server error text', async () => {
  const f = fixture(); f.client.submit = async () => { throw { code: 'NATIVE_SUBMISSION_UNSUPPORTED_AUTHORITY', message: 'private token' }; };
  const result = await f.controls.submitSource(source); expect(result?.status).toBe('unavailable'); expect(result?.message).toContain('existing live paired operator'); expect(result?.message).not.toContain('private token'); f.controls.close();
});


test('restart loads durable identity and looks up before any replay, without rereading or regenerating source', async () => {
  const f = fixture(); f.client.submit = async command => { f.calls.push('submit'); f.commands.push(structuredClone(command)); throw new Error('lost acknowledgement'); };
  await f.controls.submitSource(source); f.controls.close();
  const restarted = f.restart(); f.client.get = async ({ requestId }) => { f.calls.push('get'); expect(requestId).toBe('identity-1'); return { kind: 'found', receipt: receipt(f.commands[0]!) }; };
  const recovered = await restarted.retry(); expect(recovered?.receipt?.criteria).toEqual(source.criteria);
  expect(f.calls).toEqual(['snapshot', 'submit', 'get']); expect(f.ids()).toBe(2); restarted.close();
});

test('journal write and confirmation failures prevent every submission POST', async () => {
  const f = fixture(); f.journal.save = async () => { throw new Error('file sync failed'); };
  const failed = await f.controls.submitSource(source); expect(failed?.status).toBe('unavailable'); expect(f.calls).toEqual(['snapshot']); expect(failed?.message).toContain('No submission was sent'); f.controls.close();
  const g = fixture(); g.journal.confirm = async () => { throw new Error('directory sync failed'); };
  const unconfirmed = await g.controls.submitSource(source); expect(unconfirmed?.status).toBe('unavailable'); expect(g.calls).toEqual(['snapshot']); g.controls.close();
});

test('restored journal plus not-found lookup replays the exact command and original revision', async () => {
  const f = fixture(); f.client.submit = async command => { f.calls.push('submit'); f.commands.push(structuredClone(command)); throw new Error('lost'); };
  await f.controls.submitSource(source); f.controls.close(); f.setRevision(500);
  const restarted = f.restart(); f.client.submit = async command => { f.calls.push('submit'); f.commands.push(structuredClone(command)); return { kind: 'submitted', replayed: true, receipt: receipt(command) }; };
  expect((await restarted.retry())?.status).toBe('submitted'); expect(f.calls).toEqual(['snapshot', 'submit', 'get', 'submit']);
  expect(f.commands[1]).toEqual(f.commands[0]); expect(f.ids()).toBe(2); restarted.close();
});
