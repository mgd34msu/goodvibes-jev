import type { NativeHostedTurnRequest, NativeHostedTurnSnapshot } from '@goodvibes-jev/engine/sdk/platform/hosted-sessions/native-turn-client';
import type { NativeWorkExecutionIdentity, NativeWorkExecutionSnapshot } from '@goodvibes-jev/engine/sdk/platform/workflow/work-ledger/native-execution-client';
import { readNativeConversationTurnPermit, revalidateNativeConversationTurnPermit } from '@goodvibes-jev/engine/sdk/platform/workflow/work-ledger/native-intake-client';
import { dispatchNativeConversationTurn } from '../../runtime/native-conversation-ingress.ts';
import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { NativeConversationIntakeCaptureRequest, NativeConversationIntakeResult } from '@goodvibes-jev/engine/sdk/platform/workflow/work-ledger/native-intake-client';
import { CommandRegistry, type CommandContext } from '../../input/command-registry.ts';
import { createNativeWorkLedgerView } from '../../runtime/native-work-ledger-host.ts';
import { registerAgentWorkspaceRuntimeCommands } from '../../input/commands/agent-workspace-runtime.ts';

function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'native-intake-product-')); const journalPath = join(home, 'native-submissions.json');
  const requests: string[] = []; const captures: NativeConversationIntakeCaptureRequest[] = []; const states = new Map<string, NativeConversationIntakeResult>();
  const executionStarts: NativeWorkExecutionIdentity[] = []; const executions = new Map<string, NativeWorkExecutionSnapshot>(); let loseStart = false; let invalidStartRevision = false;
  const hostedTurns = new Map<string, NativeHostedTurnSnapshot>(); const hostedBodies: NativeHostedTurnRequest[] = [];
  let hostedFault: 'none' | 'lose-start' | 'drop-scope' | 'change-principal' | 'change-project' = 'none';
  let principalId = 'paired-principal'; let projectId = 'p'; let scopes = ['read:work-ledger', 'write:work-ledger', 'write:fleet', 'write:sessions'];
  let processing = true; let loseAdmit = false; let turnMode = false; let revoked = false;
  let heldHostedStart: Promise<void> | undefined; let releaseHostedStart = () => {}; let hostedStartArrived = () => {};
  let heldSnapshot: Promise<void> | undefined; let releaseSnapshot = () => {}; let snapshotArrived = () => {};
  let heldAdmit: Promise<void> | undefined; let releaseAdmit = () => {}; let admitArrived = () => {};
  const common = (command: NativeConversationIntakeCaptureRequest) => ({ projectId: 'p', requestId: command.requestId,
    sourceRef: { version: 1 as const, inputId: command.inputId, sourceId: 'host-source', sourceRevision: 'r1', sessionId: 'host-session', ...(command.continuation ? { continuation: { sessionId: command.continuation.sessionId, revision: 'a'.repeat(64) } } : {}) } });
  const terminal = (command: NativeConversationIntakeCaptureRequest): NativeConversationIntakeResult => {
    const c = common(command);
    if (turnMode) return { ...c, kind: 'turn', route: 'answer', text: command.text, ...(c.sourceRef.continuation ? { continuation: { ...c.sourceRef.continuation, messages: [{ role: 'assistant', content: 'Host-owned prior transcript' }] } } : {}) };
    if (command.unsupportedSources.length) return { ...c, kind: 'blocked', reason: 'unsupported-source', recovery: 'required' };
    return { ...c, kind: 'work', receipt: { projectId: 'p', requestId: command.requestId, inputId: command.inputId, ledgerRevision: 1, workId: 'native-recorded-work', attemptId: 'native-recorded-attempt', expectedRevision: { work: 1, criteria: 1, attempt: 1 }, source: { version: 2, sourceId: c.sourceRef.sourceId, sourceRevision: c.sourceRef.sourceRevision, sessionId: c.sourceRef.sessionId, offsetEncoding: 'utf16', proposalRevision: 'proposal-r1', spans: [{ partId: 'input', start: 0, end: command.text.length }], admissionDecisionId: 'admission', judgmentDecisionIds: ['judge'] }, goal: command.text, criteria: [command.text] } };
  };
  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch(request) {
    expect(request.headers.get('authorization')).toBe('Bearer synthetic-intake-token');
    const path = new URL(request.url).pathname; requests.push(path);
    if (revoked) return Response.json({ error: 'Revoked authority' }, { status: 403 });
    if (path === '/api/control-plane/auth') return Response.json({ authenticated: true, authMode: 'shared-token', tokenPresent: true, authorizationHeaderPresent: true, sessionCookiePresent: false, principalId, principalKind: 'token', admin: true, scopes, roles: [] });
    if (path === '/api/work-ledger/project') return Response.json({ projectId });
    if (path === '/api/work-ledger/snapshot') { if (heldSnapshot) { snapshotArrived(); await heldSnapshot; } return Response.json({ projectId: 'p', cursor: 0, revision: 0, works: [] }); }
    if (path === '/api/work-ledger/history') return Response.json({ projectId: 'p', afterSequence: 0, throughSequence: 0, cursor: 0, hasMore: false, events: [] });
    if (path === '/api/work-ledger/intake/capture') {
      const command = await request.json() as NativeConversationIntakeCaptureRequest; captures.push(command);
      const stored = JSON.parse(readFileSync(`${journalPath}.intake`, 'utf8')); expect(stored.records[0].command).toEqual(command);
      expect(Object.keys(stored.records[0].binding)).toEqual(['endpoint', 'projectId', 'workspace', 'principalId']);
      const result: NativeConversationIntakeResult = { ...common(command), kind: 'captured' }; states.set(command.inputId, result); return Response.json(result);
    }
    if (path === '/api/work-ledger/intake/get') {
      const { inputId } = await request.json() as { inputId: string }; return Response.json(states.get(inputId) ?? { kind: 'not-found' });
    }
    if (path === '/api/work-ledger/intake/admit' || path === '/api/work-ledger/intake/resume' || path === '/api/work-ledger/intake/cancel') {
      const body = await request.json() as { inputId: string; sourceRevision: string }; const command = captures.find(command => command.inputId === body.inputId)!;
      expect(body.sourceRevision).toBe('r1');
      const result: NativeConversationIntakeResult = path.endsWith('/cancel') ? { ...common(command), kind: 'cancelled' } : processing ? { ...common(command), kind: 'processing', stage: 'routing', recovery: 'required' } : terminal(command);
      states.set(command.inputId, result);
      if (heldAdmit && path.endsWith('/admit')) { admitArrived(); await heldAdmit; }
      if (loseAdmit && path.endsWith('/admit')) return Response.json({ error: 'Synthetic lost admission reply' }, { status: 503 });
      return Response.json(result);
    }
    if (path === '/api/work-ledger/turn/status' || path === '/api/work-ledger/turn/startAgent' || path === '/api/work-ledger/turn/cancel') {
      const target = await request.json() as NativeHostedTurnRequest; hostedBodies.push(target);
      expect(Object.keys(target).sort()).toEqual(['inputId', 'projectId', 'sourceRevision']);
      expect(target.projectId).toBe('p'); expect(target.sourceRevision).toBe('r1');
      const command = captures.find(command => command.inputId === target.inputId)!;
      if (path.endsWith('/status')) {
        if (hostedFault === 'drop-scope') scopes = scopes.filter(scope => scope !== 'write:sessions');
        if (hostedFault === 'change-principal') principalId = 'changed-paired-principal';
        if (hostedFault === 'change-project') projectId = 'changed-project';
        return Response.json(hostedTurns.get(target.inputId) ?? { kind: 'not-found' });
      }
      const previous = hostedTurns.get(target.inputId);
      const snapshot: NativeHostedTurnSnapshot = path.endsWith('/cancel')
        ? { ...target, requestId: command.requestId, state: 'cancelled', sessionId: previous?.sessionId ?? null, brokerInputId: previous?.brokerInputId ?? null, correlationId: previous?.correlationId ?? null }
        : { ...target, requestId: command.requestId, state: 'running', sessionId: command.continuation?.sessionId ?? 'hosted-native-session', brokerInputId: 'broker-input', correlationId: 'hosted-correlation' };
      const stored = JSON.parse(readFileSync(`${journalPath}.intake`, 'utf8'));
      expect(stored.records[0].delivery).toBe('hosted'); expect(stored.records[0].hostedSource.sourceRevision).toBe('r1'); expect(stored.records[0].dispatch).toBeUndefined();
      hostedTurns.set(target.inputId, snapshot);
      if (heldHostedStart && path.endsWith('/startAgent')) { const hold = heldHostedStart; heldHostedStart = undefined; hostedStartArrived(); await hold; }
      if (hostedFault === 'lose-start' && path.endsWith('/startAgent')) return Response.json({ error: 'Lost hosted start acknowledgement' }, { status: 503 });
      return Response.json(snapshot);
    }
    if (path === '/api/work-ledger/execution/status' || path === '/api/work-ledger/execution/start') {
      const body = await request.json() as NativeWorkExecutionIdentity & { projectId: string };
      const { projectId, ...target } = body; expect(projectId).toBe('p');
      if (path.endsWith('/status')) return executions.has(target.attemptId) ? Response.json(executions.get(target.attemptId)) : Response.json({ error: 'Not found', code: 'NATIVE_EXECUTION_NOT_FOUND' }, { status: 404 });
      executionStarts.push(target);
      const stored = JSON.parse(readFileSync(`${journalPath}.intake`, 'utf8'));
      expect(stored.records[0].execution).toEqual({ sourceRevision: 'r1', target });
      const snapshot: NativeWorkExecutionSnapshot = { kind: 'execution', projectId, ...target, currentRevision: target.expectedRevision, currentAttempt: true, stale: false, state: 'launch-claimed', recovery: 'available', receipt: { contractId: 'native-contract', ownerAgentId: 'native-owner' }, progress: null };
      if (invalidStartRevision) return Response.json({ ...snapshot, expectedRevision: { work: 2, criteria: 2, attempt: 2 } });
      executions.set(target.attemptId, snapshot);
      if (loseStart) return Response.json({ error: 'Lost native start acknowledgement' }, { status: 503 });
      return Response.json(snapshot);
    }
    return Response.json({ error: `Unexpected route ${path}` }, { status: 500 });
  } });
  const baseUrl = `http://127.0.0.1:${server.port}`;
  const view = createNativeWorkLedgerView(() => ({ baseUrl, token: 'synthetic-intake-token', workspace: home, journalPath }), () => {});
  const extraViews: ReturnType<typeof createNativeWorkLedgerView>[] = [];
  const intake = view.intake!; const close = () => { view.close(); for (const extra of extraViews) extra.close(); };
  const printed: string[] = []; let dispatches = 0; const registry = new CommandRegistry();
  registerAgentWorkspaceRuntimeCommands(registry);
  const context = { nativeConversationIntake: intake, dispatchNativeIntakeTurn: async () => { dispatches++; }, print: (line: string) => printed.push(line) } as unknown as CommandContext;
  return { view, intake, requests, captures, printed, executionStarts, executions, hostedTurns, hostedBodies,
    holdInitialSnapshots() {
      heldSnapshot = new Promise(resolve => { releaseSnapshot = resolve; });
      // Opening owns an explicit snapshot and the subscriber's initial poll.
      // Wait for both arrivals so neither can enter the later request window.
      let arrivals = 0;
      return { arrived: new Promise<void>(resolve => { snapshotArrived = () => { if (++arrivals === 2) resolve(); }; }), release: () => releaseSnapshot() };
    },
    newIntake() { const extra = createNativeWorkLedgerView(() => ({ baseUrl, token: 'synthetic-intake-token', workspace: home, journalPath }), () => {}); extraViews.push(extra); return extra.intake!; },
    holdHostedStart() { heldHostedStart = new Promise(resolve => { releaseHostedStart = resolve; }); return { arrived: new Promise<void>(resolve => { hostedStartArrived = resolve; }), release: () => releaseHostedStart() }; },
    setHostedFault(value: typeof hostedFault) { hostedFault = value; }, dispatches: () => dispatches,
    run: (action: string) => registry.execute('work', [action], context),
    journal: () => JSON.parse(readFileSync(`${journalPath}.intake`, 'utf8')),
    invalidStartRevision() { invalidStartRevision = true; },
    loseStart() { loseStart = true; },
    settle() { processing = false; }, loseAdmit() { loseAdmit = true; },
    turn() { processing = false; turnMode = true; }, revoke() { revoked = true; },
    holdAdmit() { heldAdmit = new Promise(resolve => { releaseAdmit = resolve; }); return { arrived: new Promise<void>(resolve => { admitArrived = resolve; }), release: () => releaseAdmit() }; },
    close() { releaseSnapshot(); releaseAdmit(); releaseHostedStart(); close(); server.stop(true); rmSync(home, { recursive: true, force: true }); } };
}
test('ordinary product transport persists exact source and explicitly recovered admission starts its native target', async () => {
  const f = fixture(); const text = '  Deliver the exact change\r\nkeep 😀 and spaces  ';
  try {
    expect((await f.intake.submit({ text, unsupportedSources: [] }))?.result?.kind).toBe('processing');
    expect(f.captures).toHaveLength(1); expect(f.captures[0]?.text).toBe(text);
    expect(Object.keys(f.captures[0]!).sort()).toEqual(['inputId', 'requestId', 'text', 'unsupportedSources']);
    const before = f.requests.length; await f.run('intake-retry');
    expect(f.requests.slice(before).filter(path => path.includes('/intake/'))).toEqual(['/api/work-ledger/intake/get']);
    f.settle(); await f.run('intake-resume');
    expect(f.printed.at(-1)).toContain('native-recorded-work'); expect(f.captures).toHaveLength(1); expect(f.dispatches()).toBe(0);
    expect(f.requests.some(path => path.includes('/planning/') || path.includes('/submissions'))).toBe(false);
    expect(f.executionStarts).toEqual([{ workId: 'native-recorded-work', attemptId: 'native-recorded-attempt', expectedRevision: { work: 1, criteria: 1, attempt: 1 } }]);
  } finally { f.close(); }
});
test('lost admission response recovers terminal work by get and does not re-admit', async () => {
  const f = fixture(); f.settle(); f.loseAdmit();
  try {
    expect((await f.intake.submit({ text: 'Build the source', unsupportedSources: [] }))?.status).toBe('unknown');
    const before = f.requests.length; await f.run('intake-retry');
    expect(f.requests.slice(before).filter(path => path.includes('/intake/'))).toEqual(['/api/work-ledger/intake/get']);
    expect(f.printed.at(-1)).toContain('native-recorded-attempt'); expect(f.captures).toHaveLength(1);
  } finally { f.close(); }
});
test('unsupported references remain blocked under all recovery commands', async () => {
  const f = fixture(); f.settle();
  try {
    expect((await f.intake.submit({ text: 'Use !@file', unsupportedSources: [{ kind: 'file', label: '!@file' }] }))?.result?.kind).toBe('blocked');
    const before = f.requests.length;
    for (const action of ['intake-status', 'intake-retry', 'intake-resume', 'intake-cancel']) await f.run(action);
    expect(f.requests.slice(before).filter(path => path.includes('/intake/'))).toEqual(Array(4).fill('/api/work-ledger/intake/get')); expect(f.dispatches()).toBe(0);
  } finally { f.close(); }
});

test('real turn permit outlives intake transport, preserves exact source and rechecks live authority', async () => {
  const f = fixture(); const snapshot = f.holdInitialSnapshots(); f.turn(); const text = '  Original ordinary turn\r\n😀  ';
  try {
    const state = await f.intake.submit({ text, unsupportedSources: [] });
    expect(state?.turnReady).toBe(true); expect(state?.turnPermit).toBeDefined();
    const permit = state!.turnPermit!;
    expect(readNativeConversationTurnPermit(permit).text).toBe(text);
    const delivered: unknown[] = [];
    await dispatchNativeConversationTurn(state!, {
      bindNativeConversationProject(projectId) { delivered.push(projectId); },
      async handleUserInput(text, content, options) { delivered.push({ text, content, options }); },
    });
    expect(delivered).toEqual(['p', { text, content: undefined, options: { nativeConversationTurnPermit: permit } }]);
    // Intake opens an independently polling ledger view. Close that owner while
    // its snapshots are pending so a late response cannot enter this window.
    await snapshot.arrived;
    f.view.close();
    expect(f.view.state.status).toBe('closed');
    const before = f.requests.length; snapshot.release(); await revalidateNativeConversationTurnPermit(permit);
    expect(f.requests.slice(before)).toEqual(['/api/work-ledger/intake/get']);
    expect(f.view.state.status).toBe('closed');
    f.revoke(); await expect(revalidateNativeConversationTurnPermit(permit)).rejects.toThrow();
  } finally { f.close(); }
});
test('lost settled turn reply requires explicit resume and a single durable dispatch claim', async () => {
  const f = fixture(); f.turn(); f.loseAdmit();
  try {
    expect((await f.intake.submit({ text: 'Explain the original', unsupportedSources: [] }))?.status).toBe('unknown');
    const before = f.requests.length; await f.run('intake-status'); expect(f.dispatches()).toBe(0);
    expect(f.requests.slice(before).filter(path => path.includes('/intake/'))).toEqual(['/api/work-ledger/intake/get']);
    const retry = f.requests.length; await f.run('intake-retry'); expect(f.dispatches()).toBe(1);
    expect(f.requests.slice(retry).filter(path => path.includes('/intake/'))).toEqual(['/api/work-ledger/intake/get', '/api/work-ledger/intake/resume']);
    await f.run('intake-retry'); await f.run('intake-resume'); expect(f.dispatches()).toBe(1);
    expect(f.captures).toHaveLength(1); expect(f.printed.at(-1)).toContain('Recovery required');
  } finally { f.close(); }
});

test('intake-cancel crosses the pending preflight and interrupts an in-flight admission without stale dispatch', async () => {
  const f = fixture(); const held = f.holdAdmit();
  try {
    const pending = f.intake.submit({ text: 'Explain this pending input', unsupportedSources: [] });
    await held.arrived;
    await f.run('intake-cancel');
    expect(f.printed.at(-1)).toContain('cancelled'); expect(f.requests).toContain('/api/work-ledger/intake/cancel');
    held.release(); expect(await pending).toBeUndefined(); expect(f.dispatches()).toBe(0); expect(f.captures).toHaveLength(1);
  } finally { held.release(); f.close(); }
});

test('initial work admission automatically starts its durable native target and lost acknowledgement only reads status', async () => {
  const f = fixture(); f.settle(); f.loseStart();
  try {
    const state = await f.intake.submit({ text: 'Implement the requested native work', unsupportedSources: [] });
    expect(state?.execution?.snapshot?.kind).toBe('execution');
    expect(f.executionStarts).toHaveLength(1);
    expect(f.requests.filter(path => path.includes('/execution/'))).toEqual(['/api/work-ledger/execution/status', '/api/work-ledger/execution/start', '/api/work-ledger/execution/status']);
    const before = f.requests.length; await f.run('intake-status');
    expect(f.requests.slice(before).filter(path => path.includes('/execution/'))).toEqual(['/api/work-ledger/execution/status']);
    await f.run('intake-retry'); await f.run('intake-resume'); expect(f.executionStarts).toHaveLength(1);
    expect(f.captures).toHaveLength(1); expect(f.dispatches()).toBe(0);
  } finally { f.close(); }
});

test('real client status accepts recorded revisions for the same attempt without rewriting target or blocking a new input', async () => {
  const f = fixture(); f.settle();
  try {
    await f.intake.submit({ text: 'Original admitted source', unsupportedSources: [] });
    const original = f.executions.get('native-recorded-attempt')!;
    const savedTarget = structuredClone(f.journal().records[0].execution);
    f.executions.set(original.attemptId, { ...original, expectedRevision: { work: 2, criteria: 2, attempt: 2 }, currentRevision: { work: 2, criteria: 2, attempt: 2 } });
    const before = f.requests.length;
    const status = await f.intake.status();
    expect(status?.execution?.snapshot?.expectedRevision).toEqual({ work: 2, criteria: 2, attempt: 2 });
    expect(status?.execution?.message).toContain('saved work r1, criteria r1, attempt r1; recorded work r2, criteria r2, attempt r2');
    await f.run('intake-retry'); await f.run('intake-resume');
    expect(f.journal().records[0].execution).toEqual(savedTarget);
    expect(f.requests.slice(before).filter(path => path.includes('/execution/'))).toEqual(Array(3).fill('/api/work-ledger/execution/status'));
    expect(f.executionStarts).toHaveLength(1);
    f.turn();
    const next = await f.intake.submit({ text: 'A new ordinary input', unsupportedSources: [] });
    expect(next?.turnReady).toBe(true); expect(f.captures).toHaveLength(2);
    expect(f.captures[1]!.inputId).not.toBe(f.captures[0]!.inputId);
    expect(f.executionStarts).toHaveLength(1);
  } finally { f.close(); }
});
test('real client still rejects a start acknowledgement with revisions different from the immutable target', async () => {
  const f = fixture(); f.settle(); f.invalidStartRevision();
  try {
    const state = await f.intake.submit({ text: 'Original exact start target', unsupportedSources: [] });
    expect(state?.execution?.snapshot).toBeUndefined();
    expect(state?.execution?.message).toContain('outcome is unknown');
    expect(f.executionStarts).toHaveLength(1);
    expect(f.executionStarts[0]!.expectedRevision).toEqual({ work: 1, criteria: 1, attempt: 1 });
    expect(f.journal().records[0].execution.target.expectedRevision).toEqual({ work: 1, criteria: 1, attempt: 1 });
    expect(f.requests.filter(path => path.includes('/execution/'))).toEqual(['/api/work-ledger/execution/status', '/api/work-ledger/execution/start', '/api/work-ledger/execution/status']);
  } finally { f.close(); }
});


test('hosted product transport persists delivery and uses qualified identity-only routes without local claims', async () => {
  const f = fixture(); f.turn();
  try {
    const state = await f.intake.submit({ text: '  Exact hosted input\r\n界 😀  ', unsupportedSources: [] }, { delivery: 'hosted' });
    expect(state?.hostedTurn).toMatchObject({ state: 'running', sessionId: 'hosted-native-session' });
    expect(state?.turnReady).toBeUndefined(); expect(state?.turnPermit).toBeUndefined(); expect(f.dispatches()).toBe(0);
    expect(f.requests.filter(path => path.includes('/turn/'))).toEqual(['/api/work-ledger/turn/status', '/api/work-ledger/turn/startAgent']);
    expect(f.hostedBodies).toEqual(Array(2).fill({ projectId: 'p', inputId: f.captures[0]!.inputId, sourceRevision: 'r1' }));
    expect(f.journal().records[0].delivery).toBe('hosted'); expect(f.journal().records[0].dispatch).toBeUndefined();
    const startIndex = f.requests.indexOf('/api/work-ledger/turn/startAgent');
    expect(f.requests.slice(startIndex - 2, startIndex)).toEqual(['/api/control-plane/auth', '/api/work-ledger/project']);
  } finally { f.close(); }
});

test('hosted transport loses a start acknowledgement then reads status without replay or legacy delivery', async () => {
  const f = fixture(); f.turn(); f.setHostedFault('lose-start');
  try {
    const state = await f.intake.submit({ text: 'Original hosted input', unsupportedSources: [] }, { delivery: 'hosted' });
    expect(state?.status).toBe('unknown');
    const before = f.requests.length; const recovered = await f.intake.retry();
    expect(recovered?.hostedTurn).toMatchObject({ state: 'running' });
    expect(f.requests.slice(before).filter(path => path.includes('/turn/'))).toEqual(['/api/work-ledger/turn/status']);
    expect(f.requests.filter(path => path === '/api/work-ledger/turn/startAgent')).toHaveLength(1);
    expect(f.captures).toHaveLength(1); expect(f.dispatches()).toBe(0);
  } finally { f.close(); }
});

test('hosted mutation refreshes paired scopes, principal and project after its status read', async () => {
  for (const fault of ['drop-scope', 'change-principal', 'change-project'] as const) {
    const f = fixture(); f.turn(); f.setHostedFault(fault);
    try {
      const state = await f.intake.submit({ text: 'Original hosted input', unsupportedSources: [] }, { delivery: 'hosted' });
      expect(state?.status).toBe('unknown');
      expect(f.requests).toContain('/api/work-ledger/turn/status'); expect(f.requests).not.toContain('/api/work-ledger/turn/startAgent');
      expect(f.dispatches()).toBe(0); expect(f.journal().records[0].delivery).toBe('hosted');
    } finally { f.close(); }
  }
});

test('hosted continuation forwards only session identity and cancels only its retained source', async () => {
  const f = fixture(); f.turn();
  try {
    const state = await f.intake.submit({ text: 'Follow-up exact original', unsupportedSources: [] }, { delivery: 'hosted', continuationSessionId: 'native-session' });
    expect(state?.hostedTurn).toMatchObject({ state: 'running', sessionId: 'native-session' });
    expect(f.captures[0]?.continuation).toEqual({ sessionId: 'native-session' });
    expect(f.journal().records[0].command.continuation).toEqual({ sessionId: 'native-session' });
    const cancelled = await f.intake.cancel(state!.request!);
    expect(cancelled?.hostedTurn).toMatchObject({ state: 'cancelled', sessionId: 'native-session' });
    expect(f.requests.filter(path => path.endsWith('/cancel'))).toEqual(['/api/work-ledger/turn/cancel']);
    expect(f.hostedBodies.at(-1)).toEqual({ projectId: 'p', inputId: state!.request!.inputId, sourceRevision: 'r1' });
    expect(f.dispatches()).toBe(0);
  } finally { f.close(); }
});

test('a stale hosted observer cannot detach another product submission during admission', async () => {
  const f = fixture(); f.turn();
  try {
    const first = await f.intake.submit({ text: 'First input', unsupportedSources: [] }, { delivery: 'hosted' });
    expect(first?.hostedTurn).toMatchObject({ state: 'running' });
    const firstId = first!.request!.inputId;
    f.hostedTurns.set(firstId, { ...f.hostedTurns.get(firstId)!, state: 'completed' });
    const held = f.holdAdmit();
    const pending = f.intake.submit({ text: 'Second input', unsupportedSources: [] }, { delivery: 'hosted' }); await held.arrived;
    expect((await f.intake.cancel(first!.request!))?.status).toBe('pending');
    held.release(); expect((await pending)?.hostedTurn).toMatchObject({ state: 'running' });
    expect(f.requests).not.toContain('/api/work-ledger/turn/cancel');
  } finally { f.close(); }
});


test('product Stop before hosted ACK pins its own durable identity across another process replacing the journal', async () => {
  const f = fixture(); f.turn(); const held = f.holdHostedStart();
  try {
    const pending = f.intake.submit({ text: 'First process original', unsupportedSources: [] }, { delivery: 'hosted' }); await held.arrived;
    const firstId = f.captures[0]!.inputId;
    f.hostedTurns.set(firstId, { ...f.hostedTurns.get(firstId)!, state: 'completed' });
    const other = f.newIntake();
    const second = await other.submit({ text: 'Second process original', unsupportedSources: [] }, { delivery: 'hosted' });
    expect(second?.hostedTurn).toMatchObject({ state: 'running' }); expect(second?.request?.inputId).not.toBe(firstId);
    expect(f.journal().records[0].command.inputId).toBe(second!.request!.inputId);
    const stopped = await f.intake.stop!();
    expect(stopped?.status).toBe('invalid'); expect(stopped?.message).toContain('newer input was not cancelled');
    expect(f.requests.filter(path => path.endsWith('/cancel'))).toEqual([]);
    expect(f.hostedTurns.get(second!.request!.inputId)?.state).toBe('running');
    held.release(); expect(await pending).toBeUndefined();
  } finally { held.release(); f.close(); }
});

test('product Stop before hosted ACK cancels the pinned original when its journal identity still matches', async () => {
  const f = fixture(); f.turn(); const held = f.holdHostedStart();
  try {
    const pending = f.intake.submit({ text: 'Stop this exact original', unsupportedSources: [] }, { delivery: 'hosted' }); await held.arrived;
    const original = f.captures[0]!;
    const stopped = await f.intake.stop!();
    expect(stopped?.hostedTurn).toMatchObject({ requestId: original.requestId, inputId: original.inputId, state: 'cancelled' });
    expect(f.requests.filter(path => path.endsWith('/cancel'))).toEqual(['/api/work-ledger/turn/cancel']);
    expect(f.hostedBodies.at(-1)).toEqual({ projectId: 'p', inputId: original.inputId, sourceRevision: 'r1' });
    held.release(); expect(await pending).toBeUndefined();
  } finally { held.release(); f.close(); }
});
