import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  NativeHostedTurnJournal,
  NATIVE_HOSTED_TURN_JOURNAL_MAX_BYTES,
  NATIVE_HOSTED_TURN_JOURNAL_MAX_RECORDS,
  type NativeHostedTurnDispatch,
  type NativeHostedTurnIdentity,
} from '../sdk/src/platform/hosted-sessions/native-turn-journal.ts';
import { AtomicWriteDurabilityError, confirmFileDurable, writeJsonFileAtomic } from '../sdk/src/platform/state/durable-file-io.ts';

const identity: NativeHostedTurnIdentity = {
  projectId: 'project', principalId: 'paired-owner', requestId: 'request', inputId: 'input',
  sourceId: 'source', sourceRevision: 'revision', sourceSessionId: 'native-work:project',
};
const unbound = { sessionId: null, brokerInputId: null, correlationId: null };
const bound = { sessionId: 'hosted-session', brokerInputId: 'sin-input', correlationId: 'hosted-dispatch:input' };
const preparing = (value = identity): NativeHostedTurnDispatch => ({ identity: value, state: 'preparing', ...unbound });
async function fixture(run: (path: string, directory: string) => Promise<void>): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), 'hosted-native-turn-journal-'));
  try { await run(join(directory, 'journal.json'), directory); }
  finally { rmSync(directory, { recursive: true, force: true }); }
}
const savedFile = (records: unknown[]) => JSON.stringify({ version: 1, records });

test('read never claims and a strict owner-only claim survives restart', async () => fixture(async path => {
  const journal = new NativeHostedTurnJournal(path);
  expect(await journal.read(identity)).toBeNull();
  expect(existsSync(path)).toBe(false);
  expect(await journal.claim(identity)).toBe(true);
  expect(statSync(path).mode & 0o777).toBe(0o600);
  const restarted = new NativeHostedTurnJournal(path);
  expect(await restarted.read(identity)).toEqual(preparing());
  expect(await restarted.claim(identity)).toBe(false);
  expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ version: 1, records: [preparing()] });
}));

test('concurrent instances have one winning claim and retain unrelated identities', async () => fixture(async path => {
  const journals = Array.from({ length: 12 }, () => new NativeHostedTurnJournal(path));
  expect((await Promise.all(journals.map(journal => journal.claim(identity)))).filter(Boolean)).toHaveLength(1);
  const identities = journals.map((_journal, index) => ({ ...identity, inputId: `input-${index}`, requestId: `request-${index}` }));
  expect(await Promise.all(journals.map((journal, index) => journal.claim(identities[index]!)))).toEqual(identities.map(() => true));
  for (const value of identities) expect(await journals[0]!.read(value)).toEqual(preparing(value));
}));

test('separate processes contend on the same durable claim', async () => fixture(async path => {
  const modulePath = fileURLToPath(new URL('../sdk/src/platform/hosted-sessions/native-turn-journal.ts', import.meta.url));
  const script = `import { NativeHostedTurnJournal } from ${JSON.stringify(modulePath)};
    process.stdout.write(JSON.stringify(await new NativeHostedTurnJournal(${JSON.stringify(path)}).claim(${JSON.stringify(identity)})));`;
  const children = Array.from({ length: 4 }, () => Bun.spawn([process.execPath, '-e', script], { stdout: 'pipe', stderr: 'pipe' }));
  const results = await Promise.all(children.map(async child => {
    const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: '' });
    return JSON.parse(stdout) as boolean;
  }));
  expect(results.filter(Boolean)).toHaveLength(1);
  expect(await new NativeHostedTurnJournal(path).claim(identity)).toBe(false);
}));

test('states advance monotonically and a bound destination never changes', async () => fixture(async path => {
  const journal = new NativeHostedTurnJournal(path);
  await expect(journal.transition(identity, 'preparing', { state: 'dispatching', ...bound })).rejects.toThrow('conflict');
  await journal.claim(identity);
  await expect(journal.transition(identity, 'preparing', { state: 'completed', ...bound })).rejects.toThrow('conflict');
  expect(await journal.transition(identity, 'preparing', { state: 'dispatching', ...bound })).toEqual({ identity, state: 'dispatching', ...bound });
  for (const key of ['sessionId', 'brokerInputId', 'correlationId'] as const) {
    await expect(journal.transition(identity, 'dispatching', { state: 'completed', ...bound, [key]: 'different' })).rejects.toThrow('conflict');
  }
  await expect(journal.transition(identity, 'dispatching', { state: 'recovery-required', ...unbound })).rejects.toThrow('conflict');
  await expect(journal.transition(identity, 'preparing', { state: 'cancelled', ...bound })).rejects.toThrow('conflict');
  await journal.transition(identity, 'dispatching', { state: 'completed', ...bound });
  await expect(journal.transition(identity, 'completed', { state: 'cancelled', ...bound })).rejects.toThrow('conflict');
  expect(await new NativeHostedTurnJournal(path).read(identity)).toEqual({ identity, state: 'completed', ...bound });
}));

test('unbound failure may be cancelled, while recovery never reopens execution', async () => fixture(async path => {
  const journal = new NativeHostedTurnJournal(path);
  await journal.claim(identity);
  await journal.transition(identity, 'preparing', { state: 'recovery-required', ...unbound });
  await expect(journal.transition(identity, 'recovery-required', { state: 'dispatching', ...bound })).rejects.toThrow('conflict');
  await expect(journal.transition(identity, 'recovery-required', { state: 'cancelled', ...bound })).rejects.toThrow('conflict');
  await journal.transition(identity, 'recovery-required', { state: 'cancelled', ...unbound });
  expect(await journal.claim(identity)).toBe(false);
  await expect(journal.transition(identity, 'cancelled', { state: 'preparing', ...unbound })).rejects.toThrow('conflict');
  expect(await journal.read(identity)).toEqual({ identity, state: 'cancelled', ...unbound });
}));

test('failed binding and cancellation preserve all destination IDs once assigned', async () => fixture(async path => {
  const journal = new NativeHostedTurnJournal(path);
  await journal.claim(identity);
  await journal.transition(identity, 'preparing', { state: 'recovery-required', ...bound });
  await journal.transition(identity, 'recovery-required', { state: 'cancelled', ...bound });
  expect(await journal.read(identity)).toEqual({ identity, state: 'cancelled', ...bound });
  const other = { ...identity, inputId: 'cancel-directly' };
  await journal.claim(other);
  await journal.transition(other, 'preparing', { state: 'cancelled', ...unbound });
  expect(await journal.read(other)).toEqual({ identity: other, state: 'cancelled', ...unbound });
}));

test('competing transitions use compare-and-swap rather than last-writer-wins', async () => fixture(async path => {
  const first = new NativeHostedTurnJournal(path), second = new NativeHostedTurnJournal(path);
  await first.claim(identity);
  await first.transition(identity, 'preparing', { state: 'dispatching', ...bound });
  const attempts = await Promise.allSettled([
    first.transition(identity, 'dispatching', { state: 'completed', ...bound }),
    second.transition(identity, 'dispatching', { state: 'recovery-required', ...bound }),
  ]);
  expect(attempts.filter(result => result.status === 'fulfilled')).toHaveLength(1);
  expect(attempts.filter(result => result.status === 'rejected')).toHaveLength(1);
}));

test('same project/principal/input cannot acquire a different source identity', async () => fixture(async path => {
  const journal = new NativeHostedTurnJournal(path);
  await journal.claim(identity);
  for (const key of ['requestId', 'sourceId', 'sourceRevision', 'sourceSessionId'] as const) {
    const changed = { ...identity, [key]: 'different' };
    await expect(journal.read(changed)).rejects.toThrow('conflict');
    await expect(journal.claim(changed)).rejects.toThrow('conflict');
    await expect(journal.transition(changed, 'preparing', { state: 'dispatching', ...bound })).rejects.toThrow('conflict');
  }
  expect(await journal.read({ ...identity, principalId: 'another-owner' })).toBeNull();
  expect(await journal.claim({ ...identity, principalId: 'another-owner' })).toBe(true);
  expect(await journal.claim({ ...identity, projectId: 'another-project' })).toBe(true);
}));

test('input snapshots are detached before lock waits and returned values cannot mutate storage', async () => fixture(async path => {
  const journal = new NativeHostedTurnJournal(path);
  const mutable = { ...identity };
  const pending = journal.claim(mutable);
  mutable.sourceId = 'changed';
  await pending;
  const read = await journal.read(identity);
  (read!.identity as { sourceId: string }).sourceId = 'changed-again';
  expect(await journal.read(identity)).toEqual(preparing());
}));

test('strict identity and dispatch shapes reject extra fields, accessors and partial bindings', async () => fixture(async path => {
  const journal = new NativeHostedTurnJournal(path);
  for (const bad of [null, { ...identity, token: 'secret' }, { ...identity, sourceId: '' }, { ...identity, sourceId: ' ' },
    { ...identity, sourceId: 'a'.repeat(201) }, Object.assign(Object.create({}), identity)]) {
    await expect(journal.claim(bad as NativeHostedTurnIdentity)).rejects.toThrow('invalid-identity');
  }
  const accessor = Object.defineProperty({ ...identity }, 'sourceId', { get() { throw new Error('accessor ran'); }, enumerable: true });
  await expect(journal.claim(accessor)).rejects.toThrow('invalid-identity');
  await journal.claim(identity);
  for (const bad of [
    { state: 'dispatching', ...unbound }, { state: 'completed', ...unbound },
    { state: 'dispatching', ...bound, brokerInputId: null }, { state: 'preparing', ...bound },
    { state: 'cancelled', ...unbound, identity }, { state: 'unknown', ...unbound },
  ]) await expect(journal.transition(identity, 'preparing', bad as Omit<NativeHostedTurnDispatch, 'identity'>)).rejects.toThrow('invalid-dispatch');
  expect(await journal.read(identity)).toEqual(preparing());
}));

test('corruption and duplicate identities fail closed without modifying the journal', async () => fixture(async path => {
  const journal = new NativeHostedTurnJournal(path);
  const corrupt = [
    '{invalid', '', JSON.stringify([]), JSON.stringify({ version: 2, records: [] }),
    JSON.stringify({ version: 1, records: [], token: 'secret' }),
    savedFile([preparing(), preparing()]), savedFile([{ ...preparing(), extra: true }]),
    savedFile([{ ...preparing(), state: 'completed' }]), savedFile([{ ...preparing(), identity: { ...identity, extra: true } }]),
  ];
  for (const raw of corrupt) {
    writeFileSync(path, raw);
    await expect(journal.read(identity)).rejects.toThrow('invalid-journal');
    await expect(journal.claim(identity)).rejects.toThrow('invalid-journal');
    expect(readFileSync(path, 'utf8')).toBe(raw);
  }
  // Invalid UTF-8 cannot be repaired by replacement-character decoding.
  const invalidUtf8 = Buffer.concat([Buffer.from('{"version":1,"records":[],"'), Buffer.from([0xc3, 0x28]), Buffer.from('":0}')]);
  writeFileSync(path, invalidUtf8);
  await expect(journal.read(identity)).rejects.toThrow('invalid-journal');
  expect(readFileSync(path)).toEqual(invalidUtf8);
}));

test('the record cap never evicts a previous claim, including completed rows', async () => fixture(async path => {
  const records = Array.from({ length: NATIVE_HOSTED_TURN_JOURNAL_MAX_RECORDS }, (_unused, index) => ({
    identity: { ...identity, inputId: `input-${index}` }, state: 'completed', ...bound,
  }));
  const raw = savedFile(records); writeFileSync(path, raw);
  const journal = new NativeHostedTurnJournal(path);
  expect(await journal.claim(records[0]!.identity)).toBe(false);
  await expect(journal.claim(identity)).rejects.toThrow('journal-limit');
  expect(readFileSync(path, 'utf8')).toBe(raw);
  writeFileSync(path, savedFile([...records, preparing()]));
  await expect(journal.read(identity)).rejects.toThrow('journal-limit');
}));

test('the UTF-8 byte cap applies to reads and publication, not JavaScript string length', async () => fixture(async path => {
  const journal = new NativeHostedTurnJournal(path);
  writeFileSync(path, ' '.repeat(NATIVE_HOSTED_TURN_JOURNAL_MAX_BYTES + 1));
  await expect(journal.read(identity)).rejects.toThrow('journal-limit');
  const long = Object.fromEntries(Object.keys(identity).map(key => [key, '界'.repeat(200)])) as unknown as NativeHostedTurnIdentity;
  const records: NativeHostedTurnDispatch[] = [];
  for (let index = 0; ; index++) {
    const next = preparing({ ...long, inputId: String(index) + '界'.repeat(190) });
    if (Buffer.byteLength(savedFile([...records, next]), 'utf8') > NATIVE_HOSTED_TURN_JOURNAL_MAX_BYTES) break;
    records.push(next);
  }
  const raw = savedFile(records); writeFileSync(path, raw);
  expect(records.length).toBeLessThan(NATIVE_HOSTED_TURN_JOURNAL_MAX_RECORDS);
  expect(raw.length).toBeLessThan(NATIVE_HOSTED_TURN_JOURNAL_MAX_BYTES);
  await expect(journal.claim({ ...long, inputId: 'another' + '界'.repeat(190) })).rejects.toThrow('journal-limit');
  expect(readFileSync(path, 'utf8')).toBe(raw);
}));

test('symlink files, symlink ancestors, nonregular files and redirected locks are refused', async () => fixture(async (path, directory) => {
  const target = join(directory, 'target.json'); writeFileSync(target, savedFile([]));
  symlinkSync(target, path);
  await expect(new NativeHostedTurnJournal(path).claim(identity)).rejects.toThrow('invalid-journal');
  expect(readFileSync(target, 'utf8')).toBe(savedFile([]));
  rmSync(path); mkdirSync(path);
  await expect(new NativeHostedTurnJournal(path).read(identity)).rejects.toThrow('invalid-journal');
  const child = join(directory, 'real'); mkdirSync(child);
  const alias = join(directory, 'alias'); symlinkSync(child, alias);
  await expect(new NativeHostedTurnJournal(join(alias, 'journal.json')).claim(identity)).rejects.toThrow('invalid-journal');
  const lockJournal = join(directory, 'lock-journal.json'); symlinkSync(target, `${lockJournal}.lock`);
  await expect(new NativeHostedTurnJournal(lockJournal).claim(identity)).rejects.toThrow('invalid-journal');
}));

test('published-indeterminate claims and transitions are preserved across restart', async () => fixture(async path => {
  const failure = new AtomicWriteDurabilityError(path, 'published-indeterminate', new Error('injected directory sync failure'));
  const failing = new NativeHostedTurnJournal(path, { writeJsonFileAtomic(target, value, options) {
    expect(options).toEqual({ durable: true, mode: 0o600, indent: null, trailingNewline: false });
    writeJsonFileAtomic(target, value, options); throw failure;
  } });
  await expect(failing.claim(identity)).rejects.toBe(failure);
  const restarted = new NativeHostedTurnJournal(path);
  expect(await restarted.claim(identity)).toBe(false);
  expect(await restarted.read(identity)).toEqual(preparing());
  await expect(failing.transition(identity, 'preparing', { state: 'dispatching', ...bound })).rejects.toBe(failure);
  expect(await restarted.read(identity)).toEqual({ identity, state: 'dispatching', ...bound });
  await expect(restarted.transition(identity, 'preparing', { state: 'dispatching', ...bound })).rejects.toThrow('conflict');
  expect(await restarted.claim(identity)).toBe(false);
}));

test('exact same-state confirmation requires durability and cannot change a terminal record', async () => fixture(async path => {
  const journal = new NativeHostedTurnJournal(path);
  await journal.claim(identity);
  await journal.transition(identity, 'preparing', { state: 'dispatching', ...bound });
  await journal.transition(identity, 'dispatching', { state: 'completed', ...bound });
  let confirmations = 0;
  const confirming = new NativeHostedTurnJournal(path, { confirmFileDurable(target) { confirmations++; confirmFileDurable(target); } });
  expect(await confirming.transition(identity, 'completed', { state: 'completed', ...bound })).toEqual({ identity, state: 'completed', ...bound });
  expect(confirmations).toBe(1);
  const failedConfirmation = new NativeHostedTurnJournal(path, { confirmFileDurable() { throw new Error('confirmation failed'); } });
  await expect(failedConfirmation.transition(identity, 'completed', { state: 'completed', ...bound })).rejects.toThrow('confirmation failed');
  await expect(journal.transition(identity, 'completed', { state: 'completed', ...bound, sessionId: 'changed' })).rejects.toThrow('conflict');
}));

test('lock failures prevent read, claim and transition and strict ownership is requested', async () => fixture(async path => {
  const journal = new NativeHostedTurnJournal(path); await journal.claim(identity);
  const raw = readFileSync(path, 'utf8');
  const failing = new NativeHostedTurnJournal(path, { async acquireCrossProcessLock(target, options) {
    expect(target).toBe(`${path}.lock`); expect(options).toEqual({ strictOwnership: true });
    throw new Error('lock unavailable');
  } });
  await expect(failing.read(identity)).rejects.toThrow('lock unavailable');
  await expect(failing.claim(identity)).rejects.toThrow('lock unavailable');
  await expect(failing.transition(identity, 'preparing', { state: 'dispatching', ...bound })).rejects.toThrow('lock unavailable');
  expect(readFileSync(path, 'utf8')).toBe(raw);
}));
