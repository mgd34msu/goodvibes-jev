import { expect, test } from 'bun:test';
import { NativeWorkExecutionControls, nativeWorkExecutionLines, type NativeWorkExecutionAction } from '../../../runtime/native-work-execution.ts';
import type { WorkLedgerReadClient, WorkLedgerReadSnapshot } from '@goodvibes-jev/engine/sdk/platform/workflow/work-ledger';
import type { OperatorNativeWorkExecutionClient, NativeWorkExecutionIdentity, NativeWorkExecutionSnapshot } from '@goodvibes-jev/engine/sdk/platform/workflow/work-ledger/native-execution-client';

const tick = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const ledger = (): WorkLedgerReadSnapshot => ({ projectId: 'p', revision: 0, cursor: 0, works: [{
  work: { source: null, id: 'work-1', title: 'Ship', goal: 'Original goal', criteria: ['Original first', 'Original second'], revision: 3, criteriaRevision: 2, reportedState: 'in_progress', currentAttemptId: 'attempt-1', createdAt: 1, updatedAt: 1 },
  attempt: { id: 'attempt-1', workId: 'work-1', predecessorId: null, ownerId: 'paired-owner', revision: 4, state: 'active', report: null, blocker: null, createdAt: 1, updatedAt: 1 },
  verification: { state: 'unverified', reason: 'No evidence', evidence: null }, attention: [],
}] });
const result = (identity: NativeWorkExecutionIdentity): NativeWorkExecutionSnapshot => ({ kind: 'execution', projectId: 'p', ...identity, currentRevision: identity.expectedRevision, currentAttempt: true, stale: false, state: 'launch-claimed', recovery: 'required', receipt: { contractId: 'contract-1', ownerAgentId: 'owner-1' }, progress: null });
function fixture() {
  let value = ledger(); let valid = true; let disposed = 0; let reads = 0;
  const calls: { action: NativeWorkExecutionAction; identity: NativeWorkExecutionIdentity; signal?: AbortSignal }[] = [];
  const reader: WorkLedgerReadClient = { projectId: 'p', readSnapshot: async () => { reads++; return value; }, history: async () => [], subscribe: () => () => {}, dispose() {} };
  const invoke = (action: NativeWorkExecutionAction): OperatorNativeWorkExecutionClient['start'] => async (identity, options) => { calls.push({ action, identity, signal: options?.signal }); return result(identity); };
  const client: OperatorNativeWorkExecutionClient = { start: invoke('start'), status: invoke('status'), cancel: invoke('cancel'), resume: invoke('resume'), dispose() { disposed++; } };
  const controls = new NativeWorkExecutionControls(() => {}); controls.bind(client, reader, () => valid);
  return { controls, reader, client, calls, reads: () => reads, disposed: () => disposed, replace(v: WorkLedgerReadSnapshot) { value = v; }, invalidate() { valid = false; } };
}

test('explicit actions derive exact identity from live ledger, never rewrite criteria or auto-resume', async () => {
  const f = fixture(); expect(f.calls).toEqual([]);
  for (const action of ['start', 'status', 'cancel', 'resume'] as const) await f.controls.run(action, 'work-1');
  expect(f.calls.map(call => call.action)).toEqual(['start', 'status', 'cancel', 'status', 'resume']);
  for (const call of f.calls) expect(call.identity).toEqual({ workId: 'work-1', attemptId: 'attempt-1', expectedRevision: { work: 3, criteria: 2, attempt: 4 } });
  expect(f.reads()).toBe(4); expect(JSON.stringify(f.calls)).not.toContain('Original first');
  expect(nativeWorkExecutionLines(f.controls.state).join(' ')).toContain('recovery required');
  expect(nativeWorkExecutionLines(f.controls.state).join(' ')).toContain('contract-1');
  expect(nativeWorkExecutionLines(f.controls.state).join(' ')).not.toContain('verified success');
  f.controls.clear(); expect(f.disposed()).toBe(1); expect(f.calls).toHaveLength(5);
});

test('live revisions, not stale display revisions, are used when explicitly starting', async () => {
  const f = fixture(); const next = ledger();
  f.replace({ ...next, works: next.works.map(view => ({ ...view, work: { ...view.work, revision: 8, criteriaRevision: 7 }, attempt: { ...view.attempt!, revision: 6 } })) });
  await f.controls.run('start', 'work-1'); expect(f.calls[0]?.identity.expectedRevision).toEqual({ work: 8, criteria: 7, attempt: 6 });
  f.controls.clear();
});

test('observed old attempts remain inspectable/cancellable after a handoff; explicit resume uses live current identity', async () => {
  const f = fixture(); await f.controls.run('start', 'work-1'); const next = ledger();
  f.replace({ ...next, works: next.works.map(view => ({ ...view, work: { ...view.work, revision: 9, currentAttemptId: 'attempt-2' }, attempt: { ...view.attempt!, id: 'attempt-2', revision: 1 } })) });
  await f.controls.run('status', 'work-1'); await f.controls.run('cancel', 'work-1');
  expect(f.calls.slice(1).map(call => call.identity.attemptId)).toEqual(['attempt-1', 'attempt-1']);
  await f.controls.run('resume', 'work-1'); expect(f.calls[3]?.action).toBe('status'); expect(f.calls[4]?.identity.attemptId).toBe('attempt-2'); f.controls.clear();
});

test('clear aborts only local transport and discards late success without cancelling the host', async () => {
  const f = fixture(); let finish!: (s: NativeWorkExecutionSnapshot) => void; let signal: AbortSignal | undefined;
  f.client.start = (identity, options) => { signal = options?.signal; f.calls.push({ action: 'start', identity }); return new Promise(resolve => { finish = resolve; }); };
  const pending = f.controls.run('start', 'work-1'); await tick(); f.controls.clear();
  expect(signal?.aborted).toBe(true); finish(result(f.calls[0]!.identity)); await pending;
  expect(f.controls.state).toBeUndefined(); expect(f.calls.map(call => call.action)).toEqual(['start']);
});

test('changed host during fresh ledger read rejects identity and never dispatches', async () => {
  const f = fixture(); let finish!: (s: WorkLedgerReadSnapshot) => void;
  f.reader.readSnapshot = () => new Promise(resolve => { finish = resolve; });
  const pending = f.controls.run('start', 'work-1'); await tick(); f.invalidate(); finish(ledger()); await pending;
  expect(f.calls).toEqual([]); f.controls.clear();
});

test('explicit cancel interrupts a pending local start, preserves the original target and ignores its late result', async () => {
  const f = fixture(); let finish!: (s: NativeWorkExecutionSnapshot) => void; let signal: AbortSignal | undefined;
  f.client.start = (identity, options) => { signal = options?.signal; f.calls.push({ action: 'start', identity }); return new Promise(resolve => { finish = resolve; }); };
  const pending = f.controls.run('start', 'work-1'); await tick();
  await f.controls.run('start', 'work-1'); expect(f.calls).toHaveLength(1);
  await f.controls.run('cancel', 'work-1'); expect(signal?.aborted).toBe(true); expect(f.calls.map(call => call.action)).toEqual(['start', 'cancel']);
  finish(result(f.calls[0]!.identity)); await pending; expect(f.controls.state?.action).toBe('cancel'); f.controls.clear();
});

test('missing/inactive attempts never start; failures never disclose transport secrets or fabricate success', async () => {
  const f = fixture(); await f.controls.run('start', 'unknown'); expect(f.calls).toHaveLength(0);
  const next = ledger(); f.replace({ ...next, works: next.works.map(view => ({ ...view, attempt: { ...view.attempt!, state: 'complete' } })) });
  await f.controls.run('resume', 'work-1'); expect(f.calls.map(call => call.action)).toEqual(['status']);
  f.client.status = async () => { throw new Error('Bearer private-token'); }; await f.controls.run('status', 'work-1');
  expect(f.controls.state?.message).toContain('server outcome is unknown'); expect(f.controls.state?.snapshot).toBeUndefined();
  expect(nativeWorkExecutionLines(f.controls.state).join(' ')).not.toContain('private-token'); f.controls.clear();
});


test('typed missing/refused/stale failures are distinct and never trigger automatic execution', async () => {
  const f = fixture();
  for (const [code, expected] of [['NATIVE_EXECUTION_NOT_FOUND', 'No admitted'], ['NATIVE_EXECUTION_REFUSED', 'Jev refused'], ['NATIVE_EXECUTION_STALE', 'changed']] as const) {
    f.client.status = async () => { throw { code, message: 'secret transport detail' }; };
    await f.controls.run('status', 'work-1'); expect(f.controls.state?.message).toContain(expected); expect(f.controls.state?.message).not.toContain('secret');
  }
  expect(f.calls).toEqual([]); f.controls.clear();
});


const intentResult = (identity: NativeWorkExecutionIdentity, state: 'admitting' | 'refused' = 'admitting'): Extract<NativeWorkExecutionSnapshot, { kind: 'pending-intent' }> => ({
  kind: 'pending-intent', projectId: 'p', ...identity, currentRevision: identity.expectedRevision,
  currentAttempt: true, stale: false, state, recovery: state === 'admitting' ? 'pending' : 'required',
});
const preventedResult = (identity: NativeWorkExecutionIdentity): Extract<NativeWorkExecutionSnapshot, { kind: 'prevented-before-admission' }> => ({
  kind: 'prevented-before-admission', projectId: 'p', ...identity, currentRevision: identity.expectedRevision,
  currentAttempt: true, stale: false, state: 'cancelled', recovery: 'cancelled',
});

test('pending, refused and prevented admission remain distinct from an execution receipt', async () => {
  const f = fixture();
  f.client.start = async identity => { f.calls.push({ action: 'start', identity }); return intentResult(identity); };
  f.client.status = async identity => { f.calls.push({ action: 'status', identity }); return intentResult(identity, 'refused'); };
  f.client.cancel = async identity => { f.calls.push({ action: 'cancel', identity }); return preventedResult(identity); };
  for (const [action, label] of [['start', 'Admission pending'], ['status', 'Admission refused'], ['cancel', 'Cancelled before admission']] as const) {
    const value = await f.controls.run(action, 'work-1');
    const text = nativeWorkExecutionLines(value).join('\n');
    expect(text).toContain(label); expect(text).toContain('Requested revisions');
    expect(text).not.toContain('Admitted revisions'); expect(text).not.toContain('Receipt:'); expect(text).not.toContain('Progress:');
    expect(Object.hasOwn(value!.snapshot!, 'receipt')).toBe(false); expect(Object.hasOwn(value!.snapshot!, 'progress')).toBe(false);
    expect(value?.busy).toBe(false);
  }
  expect(f.calls.map(call => call.action)).toEqual(['start', 'status', 'cancel']);
  expect(f.controls.state?.message).toContain('new native attempt'); f.controls.clear();
});

test('a refused intent resumes only after the explicit resume action and then shows genuine execution fields', async () => {
  const f = fixture();
  f.client.status = async identity => { f.calls.push({ action: 'status', identity }); return intentResult(identity, 'refused'); };
  await f.controls.run('status', 'work-1'); await tick();
  expect(f.calls.map(call => call.action)).toEqual(['status']);
  const value = await f.controls.run('resume', 'work-1');
  expect(f.calls.map(call => call.action)).toEqual(['status', 'status', 'resume']);
  const text = nativeWorkExecutionLines(value).join('\n');
  expect(text).toContain('Admitted revisions'); expect(text).toContain('Receipt: contract contract-1'); f.controls.clear();
});

test('late pending-intent responses are discarded after the local lifecycle is cleared', async () => {
  const f = fixture(); let finish!: (value: NativeWorkExecutionSnapshot) => void;
  f.client.start = identity => { f.calls.push({ action: 'start', identity }); return new Promise(resolve => { finish = resolve; }); };
  const request = f.controls.run('start', 'work-1'); await tick(); f.controls.clear();
  finish(intentResult(f.calls[0]!.identity)); expect(await request).toBeUndefined(); expect(f.controls.state).toBeUndefined();
  expect(f.calls.map(call => call.action)).toEqual(['start']);
});


test('interrupted admitting intents require explicit recovery without converting requested revisions to admission', async () => {
  const f = fixture(); f.client.status = async identity => ({ ...intentResult(identity), recovery: 'required' });
  const value = await f.controls.run('status', 'work-1'); await tick();
  expect(value?.message).toContain('explicit resume'); expect(nativeWorkExecutionLines(value).join(' ')).toContain('Requested revisions');
  expect(f.calls).toEqual([]); f.controls.clear();
});


test('intent rendering ignores unexpected receipt/progress properties instead of presenting them as execution', () => {
  const identity = { workId: 'work-1', attemptId: 'attempt-1', expectedRevision: { work: 3, criteria: 2, attempt: 4 } };
  const unexpected = { ...intentResult(identity), receipt: { contractId: 'invented-receipt', ownerAgentId: 'invented-owner' }, progress: null };
  const text = nativeWorkExecutionLines({ workId: 'work-1', action: 'status', busy: false, message: 'Admission pending', snapshot: unexpected }).join(' ');
  expect(text).not.toContain('invented-receipt'); expect(text).not.toContain('Receipt:'); expect(text).not.toContain('Progress:'); expect(text).toContain('Requested revisions');
});

test('settlement observations display publication honestly without fabricating verification or dispatching', async () => {
  const f = fixture();
  for (const state of ['pending', 'failed', 'required', 'published'] as const) {
    f.client.status = async identity => ({ ...result(identity), kind: 'execution', state: 'launch-claimed', recovery: 'terminal', receipt: null, progress: null, settlement: { state, ...(state === 'published' ? { evidenceId: 'evidence-1', reportSequence: 9, evidenceSequence: 10 } : {}) } });
    await f.controls.run('status', 'work-1');
    expect(nativeWorkExecutionLines(f.controls.state).join(' ')).toContain(`Verification publication: ${state}`);
    expect(nativeWorkExecutionLines(f.controls.state).join(' ')).not.toContain('verified success');
  }
  expect(f.calls).toHaveLength(0); f.controls.clear();
});

test('explicit resume verifies passed work and reconciles a completed receipt with its admitted identity', async () => {
  const f = fixture();
  const admitted = { workId: 'work-1', attemptId: 'attempt-1', expectedRevision: { work: 3, criteria: 2, attempt: 4 } };
  const complete = { work: 4, criteria: 2, attempt: 5 };
  let published = false;
  const status = (): NativeWorkExecutionSnapshot => ({ ...result(admitted), kind: 'execution', state: 'launch-claimed', recovery: 'terminal',
    receipt: { contractId: 'contract-1', ownerAgentId: 'owner-1' }, currentRevision: published ? complete : admitted.expectedRevision,
    currentAttempt: !published, stale: published, settlement: published ? { state: 'published', evidenceId: 'proof-1', reportSequence: 9, evidenceSequence: 10 } : { state: 'required' },
    progress: { status: 'passed', sessionMode: true, semanticState: null, stage: null, retrying: false,
      units: { total: 1, passed: 1, failed: 0 }, criteria: { total: 2, met: 2, unmet: 0, unshown: 0 } } });
  f.client.status = async (identity, options) => { f.calls.push({ action: 'status', identity, signal: options?.signal }); return status(); };
  f.client.resume = async identity => {
    f.calls.push({ action: 'resume', identity }); expect(identity).toEqual(admitted); published = true; return status();
  };
  await f.controls.run('status', 'work-1');
  expect(f.calls.map(call => call.action)).toEqual(['status']); expect(f.controls.state?.message).toContain('without restarting execution');
  await f.controls.run('resume', 'work-1');
  const next = ledger(); f.replace({ ...next, works: next.works.map(view => ({ ...view,
    work: { ...view.work, revision: complete.work, reportedState: 'complete' }, attempt: { ...view.attempt!, revision: complete.attempt, state: 'complete' } })) });
  await f.controls.run('resume', 'work-1');
  expect(f.calls.map(call => call.action)).toEqual(['status', 'status', 'resume', 'status', 'resume']);
  expect(f.calls[3]?.identity.expectedRevision).toEqual(complete);
  expect(f.calls[4]?.identity.expectedRevision).toEqual(admitted.expectedRevision);
  expect(f.controls.state?.snapshot).toMatchObject({ settlement: { state: 'published', evidenceId: 'proof-1' }, stale: true, currentAttempt: false });
  expect(f.controls.state?.message).toContain('reconciles this receipt'); f.controls.clear();
});

test('resume preflight never retries failed or cancelled execution and cancellation wins over an old passed checkpoint', async () => {
  for (const cancelled of [false, true]) {
    const f = fixture();
    f.client.status = async identity => {
      f.calls.push({ action: 'status', identity });
      return { ...result(identity), kind: 'execution', state: cancelled ? 'cancelled' : 'launch-claimed', recovery: cancelled ? 'cancelled' : 'terminal', receipt: null,
        settlement: { state: 'required' }, progress: { status: cancelled ? 'passed' : 'failed', sessionMode: true, semanticState: null, stage: null, retrying: false,
          units: { total: 1, passed: 0, failed: 1 }, criteria: { total: 2, met: 0, unmet: 2, unshown: 0 } } };
    };
    await f.controls.run('resume', 'work-1'); expect(f.calls.map(call => call.action)).toEqual(['status']);
    expect(f.controls.state?.message).toContain('cannot resume execution'); f.controls.clear();
  }
});

test('clearing a resume status preflight fences the later mutation even if transport ignores abort', async () => {
  const f = fixture(); let finish!: (value: NativeWorkExecutionSnapshot) => void;
  f.client.status = (identity, options) => {
    f.calls.push({ action: 'status', identity, signal: options?.signal }); return new Promise(resolve => { finish = resolve; });
  };
  const pending = f.controls.run('resume', 'work-1'); await tick(); f.controls.clear();
  expect(f.calls[0]?.signal?.aborted).toBe(true); finish(result(f.calls[0]!.identity)); await pending;
  expect(f.calls.map(call => call.action)).toEqual(['status']); expect(f.controls.state).toBeUndefined();
});
