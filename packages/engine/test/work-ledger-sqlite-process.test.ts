import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WorkLedgerCommand, WorkLedgerState } from '../sdk/src/platform/workflow/work-ledger/types.js';
import type { WorkLedgerProcessInput, WorkLedgerProcessOutput } from './helpers/work-ledger-process.js';

const fixture = new URL('./helpers/work-ledger-process.ts', import.meta.url).pathname;
const networkGuard = new URL('../scripts/test-network-preload.ts', import.meta.url).pathname;
const roots: string[] = [];
interface ChildFixture {
  readonly process: Bun.Subprocess<'ignore', 'pipe', 'pipe'>;
  readonly input: WorkLedgerProcessInput;
  readonly finished: Promise<[number, string, string]>;
}
const children: ChildFixture[] = [];
let serial = 0;

afterEach(async () => {
  for (const child of children) {
    if (child.process.exitCode === null) child.process.kill('SIGKILL');
  }
  await Promise.all(children.splice(0).map(child => child.finished));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function location() {
  const root = mkdtempSync(join(tmpdir(), 'work-ledger-process-'));
  roots.push(root);
  return { root, dbPath: join(root, 'knowledge.sqlite') };
}

function create(requestId: string, expectedRevision = 0): Extract<WorkLedgerCommand, { type: 'create' }> {
  return { type: 'create', requestId, expectedRevision, title: requestId, goal: 'Persist across real processes', criteria: ['One atomic event and receipt'] };
}

function start(root: string, options: Omit<WorkLedgerProcessInput, 'label' | 'readyPath' | 'resultPath'> & { readonly label?: string }): ChildFixture {
  const label = options.label ?? `child-${++serial}`;
  const input: WorkLedgerProcessInput = { ...options, label, readyPath: join(root, `${label}.ready`), resultPath: join(root, `${label}.result`) };
  const child = Bun.spawn([process.execPath, '--no-env-file', '--preload', networkGuard, fixture, JSON.stringify(input)], {
    stdout: 'pipe', stderr: 'pipe', env: { ...process.env },
  });
  const finished = Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  const handle = { process: child, input, finished };
  children.push(handle);
  return handle;
}

async function waitForFile(child: ChildFixture, path: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (!existsSync(path)) {
    if (child.process.exitCode !== null) {
      throw new Error(`Fixture exited before ${path}: ${JSON.stringify(await child.finished)}`);
    }
    if (Date.now() > deadline) throw new Error(`Fixture did not reach ${path}`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

async function ready(child: ChildFixture): Promise<{ pid: number; revision: number }> {
  await waitForFile(child, child.input.readyPath);
  return JSON.parse(readFileSync(child.input.readyPath, 'utf8')) as { pid: number; revision: number };
}

async function completed(child: ChildFixture): Promise<WorkLedgerProcessOutput> {
  const [exit, stdout, stderr] = await child.finished;
  expect({ exit, stdout, stderr }).toEqual({ exit: 0, stdout: '', stderr: '' });
  return JSON.parse(readFileSync(child.input.resultPath, 'utf8')) as WorkLedgerProcessOutput;
}

function assertSingleCommit(state: WorkLedgerState, requestId: string): void {
  expect(state.revision).toBe(1);
  expect(state.works).toHaveLength(1);
  expect(state.history).toHaveLength(1);
  expect(state.receipts).toHaveLength(1);
  expect(state.history[0]?.requestId).toBe(requestId);
  expect(state.receipts[0]?.event).toEqual(state.history[0]);
  expect(state.receipts[0]?.requestId).toBe(requestId);
}

test('two real owners at the same revision commit exactly one event and receipt', async () => {
  const { root, dbPath } = location();
  const gatePath = join(root, 'submit');
  const first = start(root, { dbPath, projectId: 'shared', gatePath, command: create('first') });
  const second = start(root, { dbPath, projectId: 'shared', gatePath, command: create('second') });
  const initial = await Promise.all([ready(first), ready(second)]);
  expect(initial.map(item => item.revision)).toEqual([0, 0]);
  expect(new Set(initial.map(item => item.pid)).size).toBe(2);
  expect(initial.every(item => item.pid !== process.pid)).toBe(true);
  writeFileSync(gatePath, 'go');
  const results = await Promise.all([completed(first), completed(second)]);
  expect(results.map(item => item.result?.kind).sort()).toEqual(['accepted', 'rejected']);
  expect(results.find(item => item.result?.kind === 'rejected')?.result).toMatchObject({ kind: 'rejected', code: 'conflict', revision: 1 });
  const accepted = results.find(item => item.result?.kind === 'accepted')!.result!;
  if (accepted.kind !== 'accepted') throw new Error('Missing accepted result');
  const reopened = await completed(start(root, { dbPath, projectId: 'shared' }));
  assertSingleCommit(reopened.state, accepted.event.requestId);
  expect(reopened.history).toEqual([accepted.event]);
  expect(reopened.snapshot.revision).toBe(1);
});

test('simultaneous real owners preserve both project rows in one database', async () => {
  const { root, dbPath } = location();
  const gatePath = join(root, 'submit');
  const first = start(root, { dbPath, projectId: 'alpha', gatePath, command: create('alpha-request') });
  const second = start(root, { dbPath, projectId: 'beta', gatePath, command: create('beta-request') });
  expect((await Promise.all([ready(first), ready(second)])).map(item => item.revision)).toEqual([0, 0]);
  writeFileSync(gatePath, 'go');
  const writes = await Promise.all([completed(first), completed(second)]);
  expect(writes.map(item => item.result?.kind)).toEqual(['accepted', 'accepted']);
  for (const projectId of ['alpha', 'beta']) {
    const reopened = await completed(start(root, { dbPath, projectId }));
    assertSingleCommit(reopened.state, `${projectId}-request`);
    expect(reopened.state.projectId).toBe(projectId);
  }
});

test('a new process replays the exact persisted receipt without allocating new identities', async () => {
  const { root, dbPath } = location();
  const command = create('stable-request');
  const first = await completed(start(root, { dbPath, projectId: 'restart', command, label: 'original', now: 100 }));
  expect(first.result).toMatchObject({ kind: 'accepted', replayed: false });
  if (first.result?.kind !== 'accepted') throw new Error('Missing initial accepted result');
  const bytes = readFileSync(dbPath);
  const retry = await completed(start(root, { dbPath, projectId: 'restart', command, label: 'restarted', now: 900 }));
  expect(retry.pid).not.toBe(first.pid);
  expect(retry.result).toEqual({ ...first.result, replayed: true });
  expect(retry.state).toEqual(first.state);
  expect(retry.history).toEqual(first.history);
  expect(readFileSync(dbPath)).toEqual(bytes);
  const conflicting = await completed(start(root, { dbPath, projectId: 'restart', command: { ...command, title: 'Changed request body' } }));
  expect(conflicting.result).toMatchObject({ kind: 'rejected', code: 'request_conflict' });
  expect(conflicting.state).toEqual(first.state);
});

for (const phase of ['before-rename', 'after-rename', 'after-directory-sync'] as const) {
  test(`SIGKILL ${phase} leaves a whole image and exact retry reconciles it`, async () => {
    const { root, dbPath } = location();
    const projectId = 'crash';
    const seed = await completed(start(root, { dbPath, projectId, command: create('seed') }));
    const originalBytes = readFileSync(dbPath);
    const markerPath = join(root, 'publication-held');
    const command = create('interrupted', 1);
    const interrupted = start(root, { dbPath, projectId, command, label: 'interrupted-owner', now: 200, hold: { phase, markerPath } });
    await waitForFile(interrupted, markerPath);
    expect(JSON.parse(readFileSync(markerPath, 'utf8'))).toMatchObject({ pid: interrupted.process.pid, phase, to: dbPath });
    expect(JSON.parse(readFileSync(`${dbPath}.knowledge-lock`, 'utf8')).pid).toBe(interrupted.process.pid);
    expect(existsSync(interrupted.input.resultPath)).toBe(false);
    interrupted.process.kill('SIGKILL');
    await interrupted.finished;
    expect(interrupted.process.signalCode).toBe('SIGKILL');
    // Do not remove the dead owner's lock: reopening must recover it itself.
    const recovered = await completed(start(root, { dbPath, projectId }));
    if (phase === 'before-rename') {
      expect(readFileSync(dbPath)).toEqual(originalBytes);
      expect(recovered.state).toEqual(seed.state);
    } else {
      expect(readFileSync(dbPath)).not.toEqual(originalBytes);
      expect(recovered.state.revision).toBe(2);
      expect(recovered.state.history[1]).toMatchObject({ workId: 'interrupted-owner-work-1' });
      expect(recovered.state.receipts[1]?.event).toEqual(recovered.state.history[1]);
    }
    const retry = await completed(start(root, { dbPath, projectId, command, label: 'retry-owner', now: 300 }));
    expect(retry.result).toMatchObject({ kind: 'accepted', replayed: phase !== 'before-rename' });
    expect(retry.state.revision).toBe(2);
    expect(retry.state.works).toHaveLength(2);
    expect(retry.state.history).toHaveLength(2);
    expect(retry.state.receipts).toHaveLength(2);
    expect(retry.state.receipts.map(receipt => receipt.event)).toEqual(retry.state.history);
    expect(retry.state.history[0]).toEqual(seed.state.history[0]);
    if (phase !== 'before-rename') {
      expect(retry.result).toEqual({ kind: 'accepted', replayed: true, event: recovered.state.history[1]! });
      expect(retry.state).toEqual(recovered.state);
    }
  });
}
