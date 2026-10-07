/** Paired-owner acceptance/status only. No producer, evaluator, runner, or continuation exists here. */
import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, symlinkSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { createNativeQuestionHost } from '../sdk/src/platform/workflow/work-ledger/native-question.js';
import { parseNativeQuestionRecord } from '../sdk/src/platform/workflow/work-ledger/native-question-types.js';
import type { NativePairedExecutionAuthority } from '../sdk/src/platform/workflow/work-ledger/native-execution.js';
import { acquireCrossProcessLock } from '../sdk/src/platform/workspace/checkpoint/cross-process-lock.js';
import { questionHarness, readAuthorityRows } from './helpers/native-question.js';

const harness = questionHarness();
afterEach(() => harness.close());
const invoke = <T>(operation: () => T) => Promise.resolve().then(operation);

test('host status and acceptance expose only stored evidence and never acquire an execution capability', async () => {
  const f = await harness.fixture(), before = await readAuthorityRows(f.file);
  let executionAccesses = 0;
  const deps = { projectId: 'project', projectRoot: f.root, storage: f.storage, scopes: f.scopes,
    get runner() { executionAccesses++; throw new Error('runner must not be accessed'); },
    get producer() { executionAccesses++; throw new Error('producer must not be accessed'); },
    get consumer() { executionAccesses++; throw new Error('consumer must not be accessed'); },
  };
  const host = createNativeQuestionHost(deps);
  try {
    expect(Object.keys(host).sort()).toEqual(['accept', 'close', 'status']);
    const bytes = readFileSync(f.file);
    expect(host.status(f.identity, f.authority)).toEqual(f.question);
    expect(readFileSync(f.file)).toEqual(bytes);
    const accepted = await host.accept(f.reply, f.authority);
    expect(host.status(f.identity, f.authority)).toEqual(accepted);
    expect(await host.accept(f.reply, f.authority)).toEqual(accepted);
    expect(executionAccesses).toBe(0); expect(await readAuthorityRows(f.file)).toEqual(before);
  } finally { await host.close(); }
});

test('unknown question status or reply does not create a question or admission', async () => {
  const f = await harness.fixture({ seed: false }), bytes = readFileSync(f.file);
  expect(() => f.host.status(f.identity, f.authority)).toThrow('not-found');
  await expect(invoke(() => f.host.accept(f.reply, f.authority))).rejects.toMatchObject({ code: 'not-found' });
  expect(readFileSync(f.file)).toEqual(bytes); expect(f.storage.current(f.identity).question).toBeNull();
});

for (const change of ['project', 'work', 'attempt-revision', 'work-revision', 'criteria-revision', 'question-revision'] as const) {
  test(`${change} mismatch cannot answer the selected question`, async () => {
    const f = await harness.fixture(), bytes = readFileSync(f.file);
    const reply = structuredClone(f.reply);
    if (change === 'project') reply.projectId = 'foreign-project';
    if (change === 'work') reply.workId = 'foreign-work';
    if (change === 'attempt-revision') reply.expectedRevision.attempt++;
    if (change === 'work-revision') reply.expectedRevision.work++;
    if (change === 'criteria-revision') reply.expectedRevision.criteria++;
    if (change === 'question-revision') reply.questionRevision++;
    await expect(invoke(() => f.host.accept(reply, f.authority))).rejects.toThrow();
    expect(readFileSync(f.file)).toEqual(bytes); expect(f.storage.current(f.identity).question).toEqual(f.question);
  });
}

test('wrong paired principal, revoked token, replacement token and changed workspace cannot inspect or accept', async () => {
  const f = await harness.fixture(), bytes = readFileSync(f.file);
  const foreignSnapshot = { ...f.authority.current()!, tokenId: 'foreign-token', principalId: 'foreign-owner', authorityId: 'foreign-owner', authorityRevision: 'foreign-token' };
  const foreign: NativePairedExecutionAuthority = { current: () => foreignSnapshot, async withCurrent(_expected, callback) { return callback(() => foreignSnapshot); } };
  expect(() => f.host.status(f.identity, foreign)).toThrow('stale');
  await expect(invoke(() => f.host.accept(f.reply, foreign))).rejects.toMatchObject({ code: 'stale' });
  f.replaceOwner();
  expect(() => f.host.status(f.identity, f.authority)).toThrow('stale');
  await expect(invoke(() => f.host.accept(f.reply, f.authority))).rejects.toMatchObject({ code: 'stale' });
  f.revoke();
  expect(() => f.host.status(f.identity, f.authority)).toThrow('unsupported-authority');
  await expect(invoke(() => f.host.accept(f.reply, f.authority))).rejects.toMatchObject({ code: 'unsupported-authority' });
  const scoped = await harness.fixture(); scoped.changeScope();
  expect(() => scoped.host.status(scoped.identity, scoped.authority)).toThrow('stale');
  await expect(invoke(() => scoped.host.accept(scoped.reply, scoped.authority))).rejects.toMatchObject({ code: 'stale' });
  expect(readFileSync(f.file)).toEqual(bytes);
});

for (const changed of ['owner', 'scope'] as const) test(`${changed} revocation during file-lock wait is rechecked before acceptance`, async () => {
  const f = await harness.fixture(), bytes = readFileSync(f.file);
  const release = await acquireCrossProcessLock(`${f.file}.knowledge-lock`);
  const result = f.host.accept(f.reply, f.authority).then(value => ({ value }), error => ({ error }));
  await Promise.resolve();
  if (changed === 'owner') f.revoke(); else f.changeScope();
  release(); expect(await result).toHaveProperty('error');
  expect(readFileSync(f.file)).toEqual(bytes); expect(f.storage.current(f.identity).question).toEqual(f.question);
});

test('first answer is refused after a legitimate work revision, while historical status remains observable', async () => {
  const f = await harness.fixture();
  const revised = await f.ledger.service.execute({ type: 'revise', requestId: 'revise-before-answer', expectedRevision: 2, workId: f.work.id, title: f.work.title, goal: f.work.goal, criteria: [...f.work.criteria].reverse() }, f.actor);
  expect(revised.kind).toBe('accepted'); const bytes = readFileSync(f.file);
  expect(f.host.status(f.identity, f.authority)).toEqual(f.question);
  await expect(f.host.accept(f.reply, f.authority)).rejects.toMatchObject({ code: 'stale' });
  expect(readFileSync(f.file)).toEqual(bytes);
});

test('an exact accepted receipt replays after work advances and after reopen without re-authorizing execution', async () => {
  const f = await harness.fixture(), accepted = await f.host.accept(f.reply, f.authority);
  expect((await f.ledger.service.execute({ type: 'revise', requestId: 'revise-after-answer', expectedRevision: 2, workId: f.work.id, title: f.work.title, goal: f.work.goal, criteria: [...f.work.criteria].reverse() }, f.actor)).kind).toBe('accepted');
  const bytes = readFileSync(f.file), authorities = await readAuthorityRows(f.file);
  expect(await f.host.accept(f.reply, f.authority)).toEqual(accepted);
  const reopened = await harness.open(f.file), host = createNativeQuestionHost({ projectId: 'project', projectRoot: f.root, storage: reopened.storage, scopes: f.scopes });
  try { expect(host.status(f.identity, f.authority)).toEqual(accepted); expect(await host.accept(f.reply, f.authority)).toEqual(accepted); }
  finally { await host.close(); }
  expect(readFileSync(f.file)).toEqual(bytes); expect(await readAuthorityRows(f.file)).toEqual(authorities);
});

test('execution cancellation blocks a first answer and cannot erase an already accepted receipt', async () => {
  for (const answerFirst of [false, true]) {
    const f = await harness.fixture();
    const accepted = answerFirst ? await f.host.accept(f.reply, f.authority) : null;
    await f.executionStorage.transaction(f.key, current => ({ next: { ...current.record!, state: 'cancelled' }, nextIntent: { ...current.intent!, state: 'cancelled' }, value: undefined }));
    const bytes = readFileSync(f.file);
    if (accepted) expect(await f.host.accept(f.reply, f.authority)).toEqual(accepted);
    else await expect(f.host.accept(f.reply, f.authority)).rejects.toMatchObject({ code: 'stale' });
    expect(readFileSync(f.file)).toEqual(bytes); expect(f.host.status(f.identity, f.authority)).toEqual(accepted ?? f.question);
  }
});

for (const state of ['cancelled', 'superseded'] as const) test(`${state} question tombstones survive restart and reject late reply or revival`, async () => {
  const f = await harness.fixture(), terminal = parseNativeQuestionRecord({ ...f.question, state });
  await f.storage.transaction(f.identity, () => ({ next: terminal, value: terminal }), () => {});
  const bytes = readFileSync(f.file);
  await expect(f.host.accept(f.reply, f.authority)).rejects.toMatchObject({ code: 'stale' });
  await expect(f.storage.transaction(f.identity, () => ({ next: f.question, value: f.question }), () => {})).rejects.toMatchObject({ code: 'conflict' });
  expect((await harness.open(f.file)).storage.current(f.identity).question).toEqual(terminal);
  expect(readFileSync(f.file)).toEqual(bytes);
});

test('cancellation queued before an answer wins atomically and publishes no receipt', async () => {
  const f = await harness.fixture(), release = await acquireCrossProcessLock(`${f.file}.knowledge-lock`);
  const terminal = parseNativeQuestionRecord({ ...f.question, state: 'cancelled' });
  const cancellation = f.storage.transaction(f.identity, () => ({ next: terminal, value: terminal }), () => {});
  const answer = f.host.accept(f.reply, f.authority).then(value => ({ value }), error => ({ error }));
  release(); await cancellation;
  expect(await answer).toHaveProperty('error'); expect(f.storage.current(f.identity).question).toEqual(terminal);
  expect((await harness.open(f.file)).storage.current(f.identity).question?.answer).toBeNull();
});

test('host close fences an admitted answer waiting on persistence and waits for its refusal', async () => {
  const f = await harness.fixture(), bytes = readFileSync(f.file), release = await acquireCrossProcessLock(`${f.file}.knowledge-lock`);
  const answer = f.host.accept(f.reply, f.authority).then(value => ({ value }), error => ({ error }));
  let closed = false; const closing = f.host.close().then(() => { closed = true; });
  await Promise.resolve(); expect(closed).toBe(false);
  release(); expect(await answer).toHaveProperty('error'); await closing;
  expect(() => f.host.status(f.identity, f.authority)).toThrow('closed');
  await expect(invoke(() => f.host.accept(f.reply, f.authority))).rejects.toMatchObject({ code: 'closed' });
  expect(readFileSync(f.file)).toEqual(bytes);
});

test('answered receipt remains owner-protected even when an exact retry needs no mutation', async () => {
  const f = await harness.fixture(); await f.host.accept(f.reply, f.authority);
  const bytes = readFileSync(f.file); f.replaceOwner();
  await expect(invoke(() => f.host.accept(f.reply, f.authority))).rejects.toMatchObject({ code: 'stale' });
  expect(readFileSync(f.file)).toEqual(bytes);
});

test('retargeting the original project-root symlink refuses status and acceptance even while its old root exists', async () => {
  const f = await harness.fixture(), alias = join(f.root, 'project-alias'), other = join(f.root, 'replacement-root');
  symlinkSync(f.root, alias, 'dir'); mkdirSync(other);
  const host = createNativeQuestionHost({ projectId: 'project', projectRoot: alias, storage: f.storage, scopes: f.scopes });
  try {
    expect(host.status(f.identity, f.authority)).toEqual(f.question);
    const bytes = readFileSync(f.file);
    unlinkSync(alias); symlinkSync(other, alias, 'dir');
    expect(existsSync(f.root)).toBe(true);
    expect(() => host.status(f.identity, f.authority)).toThrow('stale');
    await expect(invoke(() => host.accept(f.reply, f.authority))).rejects.toMatchObject({ code: 'stale' });
    expect(readFileSync(f.file)).toEqual(bytes);
  } finally { await host.close(); }
});

test('status rechecks paired authority after a persisted read that revokes its original owner', async () => {
  const f = await harness.fixture(), bytes = readFileSync(f.file); let reads = 0;
  const storage = { ...f.storage, current(input: typeof f.identity) {
    reads++; const current = f.storage.current(input); f.revoke(); return current;
  } };
  const host = createNativeQuestionHost({ projectId: 'project', projectRoot: f.root, storage, scopes: f.scopes });
  try {
    expect(() => host.status(f.identity, f.authority)).toThrow('unsupported-authority');
    expect(reads).toBe(1);
    expect(() => host.status(f.identity, f.authority)).toThrow('unsupported-authority');
    expect(reads).toBe(1); expect(readFileSync(f.file)).toEqual(bytes);
  } finally { await host.close(); }
});
