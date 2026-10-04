import { expect, test } from 'bun:test';
import { NativeWorkLedgerModel } from '../../runtime/native-work-ledger.ts';
import { createNativeWorkLedgerView, type NativeLedgerHost } from '../../runtime/native-work-ledger-host.ts';
import { nativeWorkLedgerLines } from '../../renderer/native-work-ledger.ts';
import type { WorkLedgerReadClient, WorkLedgerReadSnapshot, WorkLedgerEvent } from '@goodvibes-jev/engine/sdk/platform/workflow/work-ledger';
const flush = async () => { for (let i = 0; i < 15; i++) await Promise.resolve(); };
const snapshot = (cursor = 0, projectId = 'p'): WorkLedgerReadSnapshot => ({ projectId, revision: cursor, cursor, works: [] });
const event = (sequence: number): Exclude<WorkLedgerEvent, { type: 'import_legacy' }> => ({ sequence, type: 'create', actorId: 'owner', requestId: `r${sequence}`, workId: 'work-stable', attemptId: null, at: 1, attempts: [], evidence: null, reason: null, work: { source: null, id: 'work-stable', title: 'Ship', goal: 'Working feature', criteria: ['Tests pass'], revision: sequence, criteriaRevision: 1, reportedState: 'complete', currentAttemptId: null, createdAt: 1, updatedAt: 1 } });
function fixture() {
  const calls: string[] = []; let listener: (s: WorkLedgerReadSnapshot) => void = () => {};
  let current = snapshot(); let history: readonly WorkLedgerEvent[] = [];
  const client: WorkLedgerReadClient = {
    projectId: 'p',
    async readSnapshot() { calls.push('snapshot'); return current; },
    async history(cursor) { calls.push(`history:${cursor}`); return history.filter(e => e.sequence > cursor); },
    subscribe(cb) { calls.push('subscribe'); listener = cb; return () => { calls.push('unsubscribe'); }; },
    dispose() { calls.push('dispose'); },
  };
  return { client, calls, emit(s: WorkLedgerReadSnapshot, events: readonly WorkLedgerEvent[]) { current = s; history = events; listener(s); } };
}
test('subscription precedes snapshot and owns contiguous history cursor across coalesced updates', async () => {
  const f = fixture(); const model = new NativeWorkLedgerModel(); model.open({ available: true, client: f.client }); await flush();
  expect(f.calls.slice(0, 2)).toEqual(['subscribe', 'snapshot']);
  f.emit(snapshot(2), [event(1), event(2)]); await flush(); f.emit(snapshot(2), [event(1), event(2)]); await flush();
  expect(model.state.status).toBe('ready');
  if (model.state.status === 'ready') expect(model.state.history.map(e => e.sequence)).toEqual([1, 2]);
  expect(f.calls).toContain('history:2'); model.close();
});
test('late snapshot/history cannot overwrite replacement or close; cleanup throws independently', async () => {
  const old = fixture(); let finish!: (s: WorkLedgerReadSnapshot) => void;
  old.client.readSnapshot = () => new Promise(resolve => { finish = resolve; });
  old.client.subscribe = () => () => { throw new Error('cleanup'); };
  const model = new NativeWorkLedgerModel(); model.open({ available: true, client: old.client });
  const fresh = fixture(); model.open({ available: true, client: fresh.client }); await flush(); finish(snapshot(99)); await flush();
  expect(model.state.status === 'ready' && model.state.snapshot.cursor).toBe(0); expect(old.calls).toContain('dispose');
  let historyDone!: (e: readonly WorkLedgerEvent[]) => void; fresh.client.history = () => new Promise(resolve => { historyDone = resolve; });
  fresh.emit(snapshot(1), [event(1)]); model.close(); historyDone([event(1)]); await flush(); expect(model.state.status).toBe('closed');
});
test('unavailable, empty, loading, closed and history gap remain distinct', async () => {
  const model = new NativeWorkLedgerModel(); expect(nativeWorkLedgerLines(model.state).join()).toContain('closed');
  model.open({ available: false, reason: 'Disconnected' }); expect(nativeWorkLedgerLines(model.state).join()).toContain('Disconnected');
  const f = fixture(); model.open({ available: true, client: f.client }); expect(model.state.status).toBe('loading'); await flush();
  expect(nativeWorkLedgerLines(model.state).join()).toContain('No native work');
  f.emit(snapshot(2), [event(2)]); await flush(); expect(model.state.status).toBe('unavailable'); expect(f.calls).toContain('dispose');
});
test('explicit host/project selection, replacement, stale onUnavailable and reopen', async () => {
  let host: NativeLedgerHost = { baseUrl: 'https://one.invalid', token: 'secret-one', workspace: 'workspace' };
  const errors: Array<(e: Error) => void> = []; const readers: ReturnType<typeof fixture>[] = [];
  const view = createNativeWorkLedgerView(() => host, () => {}, (_host, project, error) => { expect(project).toBe('p'); errors.push(error); const f = fixture(); readers.push(f); return { available: true, client: f.client }; }, async () => { throw new Error('No discovery scope'); });
  view.open(); expect(view.state.status).toBe('loading'); view.selectProject('p'); view.open(); await flush();
  view.close(); view.open(); await flush(); errors[0]!(new Error('old token revoked')); expect(view.state.status).toBe('ready');
  host = { baseUrl: 'https://two.invalid', token: 'secret-two', workspace: 'workspace' }; view.sync(); expect(view.state.status).toBe('unavailable');
  expect(nativeWorkLedgerLines(view.state).join()).not.toContain('secret');
  view.selectProject('p'); view.open(); await flush(); errors.at(-1)!(new Error('HTTP 403')); expect(view.state.status).toBe('unavailable');
  expect(readers.at(-1)!.calls).toContain('dispose'); view.close();
});
test('reported complete never implies verified; stable IDs and criterion revisions render', () => {
  const e = event(1); const s: WorkLedgerReadSnapshot = { ...snapshot(1), works: [{ work: e.work, attempt: null, verification: { state: 'unverified', reason: 'No evidence', evidence: null }, attention: [{ kind: 'verification', reason: 'Check it' }] }] };
  const text = nativeWorkLedgerLines({ status: 'ready', snapshot: s, history: [e], cursor: 1 }).join('\n');
  expect(text).toContain('Reported: complete · Verification: unverified'); expect(text).toContain('work-stable'); expect(text).toContain('Criteria revision 1'); expect(text).toContain('Attention (verification): Check it'); expect(text).toContain('Evidence: none');
});
test('passive discovery is discarded after explicit project selection, close or host replacement', async () => {
  let host: NativeLedgerHost = { baseUrl: 'https://one.invalid', token: 'token', workspace: 'one' };
  let finish!: (project: string) => void; const bound: string[] = [];
  const view = createNativeWorkLedgerView(() => host, () => {}, (_host, project) => { bound.push(project); return { available: true, client: fixture().client }; }, () => new Promise(resolve => { finish = resolve; }));
  view.open(); view.selectProject('p'); finish('stale-discovery'); await flush(); expect(bound).toEqual(['p']);
  view.close(); host = { baseUrl: 'https://two.invalid', token: 'token2', workspace: 'two' }; view.open(); const prior = finish; view.close(); prior('p'); await flush(); expect(view.state.status).toBe('closed');
  view.open(); host = { baseUrl: 'https://three.invalid', token: 'token3', workspace: 'three' }; finish('p'); await flush(); expect(view.state.status).toBe('unavailable'); expect(bound).toEqual(['p']); view.close();
});
test('synchronous subscription failure releases late cleanup and disposed client', async () => {
  const f = fixture(); const model = new NativeWorkLedgerModel();
  f.client.subscribe = listener => { listener(snapshot(0, 'wrong-project')); return () => { f.calls.push('late-cleanup'); }; };
  model.open({ available: true, client: f.client }); await flush(); expect(model.state.status).toBe('unavailable'); expect(f.calls).toEqual(['dispose', 'late-cleanup']);
});
test('initial stale snapshot cannot queue behind a newer coalesced notification while history is held', async () => {
  const f = fixture(); let finish!: (events: readonly WorkLedgerEvent[]) => void;
  f.client.subscribe = listener => { listener(snapshot(2)); return () => {}; };
  f.client.history = () => new Promise(resolve => { finish = resolve; });
  const model = new NativeWorkLedgerModel(); model.open({ available: true, client: f.client }); await flush();
  finish([event(1), event(2)]); await flush();
  expect(model.state.status).toBe('ready');
  expect(model.state.status === 'ready' && model.state.snapshot.cursor).toBe(2);
  model.close();
});
test('interactive native host wiring preserves executable entrypoint syntax', async () => {
  const source = await Bun.file(new URL('../../interactive.ts', import.meta.url)).text();
  expect(source.startsWith('#!/usr/bin/env bun\n')).toBe(true);
  expect(() => new Bun.Transpiler({ loader: 'ts' }).transformSync(source)).not.toThrow();
});

test('an explicit command waiting on discovery cannot retarget a newly selected project', async () => {
  const calls: string[] = []; let finish!: (id: string) => void;
  const host = { baseUrl: 'https://one.invalid', token: 'synthetic', workspace: '/one' };
  const view = createNativeWorkLedgerView(() => host, () => {}, (_host, project) => ({ available: true,
    client: { ...fixture().client, projectId: project, readSnapshot: async () => snapshot(0, project) },
    execution: { start: async () => { calls.push('start'); throw new Error(); }, status: async () => { throw new Error(); }, cancel: async () => { throw new Error(); }, resume: async () => { throw new Error(); }, dispose() {} },
  }), () => new Promise(resolve => { finish = resolve; }));
  const pending = view.execute!('start', 'work-stable'); await flush();
  view.selectProject('new-project'); finish('old-project'); await pending; await flush();
  expect(calls).toEqual([]); expect(view.state.status === 'ready' && view.state.snapshot.projectId).toBe('new-project'); view.close();
});

for (const replacement of ['baseUrl', 'token', 'workspace'] as const) {
  test(`${replacement} replacement aborts pending native execution and discards the response`, async () => {
    let host = { baseUrl: 'https://one.invalid', token: 'synthetic', workspace: '/one' };
    let signal: AbortSignal | undefined; let finish!: (value: import('@goodvibes-jev/engine/sdk/platform/workflow/work-ledger/native-execution-client').NativeWorkExecutionSnapshot) => void;
    let identity!: import('@goodvibes-jev/engine/sdk/platform/workflow/work-ledger/native-execution-client').NativeWorkExecutionIdentity;
    const f = fixture(); const base = event(1).work;
    f.client.readSnapshot = async () => ({ ...snapshot(), works: [{ work: { ...base, reportedState: 'in_progress', currentAttemptId: 'attempt' }, attempt: { id: 'attempt', workId: base.id, predecessorId: null, ownerId: 'owner', revision: 1, state: 'active', report: null, blocker: null, createdAt: 1, updatedAt: 1 }, verification: { state: 'unverified', reason: 'No proof', evidence: null }, attention: [] }] });
    const view = createNativeWorkLedgerView(() => host, () => {}, () => ({ available: true, client: f.client, execution: {
      start: (input, options) => { identity = input; signal = options?.signal; return new Promise(resolve => { finish = resolve; }); },
      status: async () => { throw new Error(); }, cancel: async () => { throw new Error('Close must not cancel the server'); }, resume: async () => { throw new Error(); }, dispose() {},
    } }));
    view.selectProject('p'); view.open(); await flush(); const pending = view.execute!('start', base.id); await flush();
    host = { ...host, [replacement]: 'replacement' }; view.sync(); expect(signal?.aborted).toBe(true);
    finish({ kind: 'execution', projectId: 'p', ...identity, currentRevision: identity.expectedRevision, currentAttempt: true, stale: false, state: 'launch-claimed', recovery: 'required', receipt: null, progress: null }); await pending;
    expect(view.state.status).toBe('unavailable'); expect(nativeWorkLedgerLines(view.state).join(' ')).not.toContain('launch-claimed'); view.close();
  });
}

test('synchronous host binding revocation cannot resurrect read or execution clients', async () => {
  let executionsDisposed = 0; const f = fixture();
  const view = createNativeWorkLedgerView(() => ({ baseUrl: 'https://one.invalid', token: 'synthetic', workspace: '/one' }), () => {}, (_host, _project, unavailable) => {
    unavailable(new Error('Revoked during binding'));
    return { available: true, client: f.client, execution: { start: async () => { throw new Error(); }, status: async () => { throw new Error(); }, cancel: async () => { throw new Error(); }, resume: async () => { throw new Error(); }, dispose() { executionsDisposed++; } } };
  });
  view.selectProject('p'); view.open(); await flush();
  expect(view.state.status).toBe('unavailable'); expect(f.calls).toEqual(['dispose']); expect(executionsDisposed).toBe(1); view.close();
});

test('reentrant reader cleanup keeps the newer Agent lifecycle and drops the outer binding', async () => {
  const old = fixture(); const fresh = fixture(); const discarded = fixture(); const model = new NativeWorkLedgerModel();
  old.client.subscribe = () => () => { model.open({ available: true, client: fresh.client }); };
  model.open({ available: true, client: old.client }); await flush(); model.open({ available: true, client: discarded.client }); await flush();
  expect(model.state.status).toBe('ready'); expect(fresh.calls).toContain('snapshot'); expect(discarded.calls).toEqual(['dispose']); model.close();
});

test('native command prints its admitted result even while ledger history is still loading', async () => {
  const { CommandRegistry } = await import('../../input/command-registry.ts');
  const { registerAgentWorkspaceRuntimeCommands } = await import('../../input/commands/agent-workspace-runtime.ts');
  const f = fixture(); const base = event(1).work; let finish!: (events: readonly WorkLedgerEvent[]) => void;
  f.client.readSnapshot = async () => ({ ...snapshot(), works: [{ work: { ...base, reportedState: 'in_progress', currentAttemptId: 'attempt' }, attempt: { id: 'attempt', workId: base.id, predecessorId: null, ownerId: 'owner', revision: 1, state: 'active', report: null, blocker: null, createdAt: 1, updatedAt: 1 }, verification: { state: 'unverified', reason: 'No proof', evidence: null }, attention: [] }] });
  f.client.history = () => new Promise(resolve => { finish = resolve; });
  const view = createNativeWorkLedgerView(() => ({ baseUrl: 'https://one.invalid', token: 'synthetic', workspace: '/one' }), () => {}, () => ({ available: true, client: f.client, execution: {
    start: async identity => ({ kind: 'execution', projectId: 'p', ...identity, currentRevision: identity.expectedRevision, currentAttempt: true, stale: false, state: 'launch-claimed', recovery: 'required', receipt: { contractId: 'receipt-despite-history', ownerAgentId: 'owner' }, progress: null }),
    status: async () => { throw new Error(); }, cancel: async () => { throw new Error(); }, resume: async () => { throw new Error(); }, dispose() {},
  } }));
  view.selectProject('p'); view.open(); await flush();
  const printed: string[] = []; const registry = new CommandRegistry(); registerAgentWorkspaceRuntimeCommands(registry);
  await registry.execute('work', ['start', base.id], { nativeWorkLedger: view, print: (text: string) => printed.push(text) } as unknown as import('../../input/command-registry.ts').CommandContext);
  expect(view.state.status).toBe('loading'); expect(printed.join(' ')).toContain('receipt-despite-history'); expect(printed.join(' ')).toContain('recovery required');
  finish([]); await flush(); view.close();
});
