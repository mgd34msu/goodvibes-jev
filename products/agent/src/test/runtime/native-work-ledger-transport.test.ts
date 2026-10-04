import { expect, test } from 'bun:test';
import { createNativeWorkLedgerView } from '../../runtime/native-work-ledger-host.ts';
import { nativeWorkLedgerLines } from '../../renderer/native-work-ledger.ts';

const wait = async (check: () => boolean) => {
  const deadline = Date.now() + 4500;
  while (!check()) { if (Date.now() > deadline) throw new Error('View did not settle'); await Bun.sleep(10); }
};
/** Synthetic HTTP contract fixture; exercises production clients, never a provider. */
function serverFixture() {
  const requests: Request[] = []; let token = 'synthetic-owner-token'; let discovery = true;
  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch(request) {
    requests.push(request); const url = new URL(request.url);
    if (request.headers.get('authorization') !== `Bearer ${token}`) return Response.json({ error: 'Unauthorized' }, { status: 401 });
    if (url.pathname === '/api/work-ledger/project') {
      if (!discovery) return Response.json({ error: 'read:work-ledger required' }, { status: 403 });
      return Response.json({ projectId: 'daemon-project' });
    }
    if (url.searchParams.get('projectId') !== 'daemon-project') return Response.json({ error: 'Host project mismatch' }, { status: 403 });
    if (url.pathname === '/api/work-ledger/snapshot') return Response.json({ projectId: 'daemon-project', cursor: 0, revision: 0, works: [] });
    if (url.pathname === '/api/work-ledger/history') return Response.json({ projectId: 'daemon-project', cursor: 0, afterSequence: 0, throughSequence: 0, hasMore: false, events: [] });
    return new Response('Not found', { status: 404 });
  } });
  const host = { baseUrl: `http://127.0.0.1:${server.port}`, token, workspace: '/synthetic-project' };
  return { host, requests, revoke() { token = 'revoked'; }, denyDiscovery() { discovery = false; }, close() { server.stop(true); } };
}
test('production discovery and native reader authenticate and send only GET read methods', async () => {
  const fixture = serverFixture(); const view = createNativeWorkLedgerView(() => fixture.host, () => {});
  try {
    view.open(); await wait(() => view.state.status === 'ready');
    expect(nativeWorkLedgerLines(view.state).join('\n')).toContain('No native work recorded');
    expect(fixture.requests.some(request => new URL(request.url).pathname === '/api/work-ledger/history')).toBe(true);
    const discovery = fixture.requests.find(request => new URL(request.url).pathname === '/api/work-ledger/project')!;
    expect(new URL(discovery.url).search).toBe('');
    expect(fixture.requests.every(request => request.method === 'GET' && request.headers.get('authorization') === 'Bearer synthetic-owner-token')).toBe(true);
    fixture.revoke(); await wait(() => view.state.status === 'unavailable');
    expect(nativeWorkLedgerLines(view.state).join('\n')).not.toContain('No native work recorded');
  } finally { view.close(); fixture.close(); }
});
test('discovery403 explains explicit-project fallback without widening grants or treating denial as empty', async () => {
  const fixture = serverFixture(); fixture.denyDiscovery(); const view = createNativeWorkLedgerView(() => fixture.host, () => {});
  try {
    view.open(); await wait(() => view.state.status === 'unavailable');
    expect(nativeWorkLedgerLines(view.state).join('\n')).toContain('/work <project-id>');
    expect(fixture.requests.every(request => new URL(request.url).pathname === '/api/work-ledger/project')).toBe(true);
    view.selectProject('daemon-project'); view.open(); await wait(() => view.state.status === 'ready');
    view.selectProject('other-project'); view.open(); await wait(() => view.state.status === 'unavailable');
    expect(nativeWorkLedgerLines(view.state).join('\n')).not.toContain('No native work recorded');
  } finally { view.close(); fixture.close(); }
});

test('real Agent command routes native start/status/cancel/explicit resume over authenticated transport without legacy lookup', async () => {
  const { CommandRegistry } = await import('../../input/command-registry.ts');
  const { registerAgentWorkspaceRuntimeCommands } = await import('../../input/commands/agent-workspace-runtime.ts');
  const operations: { method: string; body: unknown }[] = [];
  const work = { source: null, id: 'native-work', title: 'Ship exact work', goal: 'Preserve the original goal', criteria: ['Original criterion'], revision: 3, criteriaRevision: 2, reportedState: 'in_progress', currentAttemptId: 'native-attempt', createdAt: 1, updatedAt: 1 };
  const attempt = { id: 'native-attempt', workId: work.id, predecessorId: null, ownerId: 'paired', revision: 4, state: 'active', report: null, blocker: null, createdAt: 1, updatedAt: 1 };
  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch(request) {
    expect(request.headers.get('authorization')).toBe('Bearer synthetic-control-token');
    const path = new URL(request.url).pathname;
    if (path === '/api/work-ledger/project') return Response.json({ projectId: 'p' });
    if (path === '/api/work-ledger/snapshot') return Response.json({ projectId: 'p', cursor: 0, revision: 0, works: [{ work, attempt, verification: { state: 'unverified', reason: 'No evidence', evidence: null }, attention: [] }] });
    if (path === '/api/work-ledger/history') return Response.json({ projectId: 'p', cursor: 0, afterSequence: 0, throughSequence: 0, hasMore: false, events: [] });
    if (path.startsWith('/api/work-ledger/execution/')) {
      const body = await request.json() as { projectId: string; workId: string; attemptId: string; expectedRevision: { work: number; criteria: number; attempt: number } };
      operations.push({ method: path.split('/').at(-1)!, body });
      return Response.json({ kind: 'execution', ...body, currentRevision: body.expectedRevision, currentAttempt: true, stale: false, state: path.endsWith('/cancel') ? 'cancelled' : 'launch-claimed', recovery: path.endsWith('/cancel') ? 'cancelled' : 'required', receipt: { contractId: 'receipt-contract', ownerAgentId: 'receipt-owner' }, progress: { status: 'running', sessionMode: true, semanticState: 'deferred', stage: 'checking', retrying: true, units: { total: 2, passed: 1, failed: 0 }, criteria: { total: 1, met: 0, unmet: 0, unshown: 1 } } });
    }
    throw new Error(`Unexpected path: ${path}`);
  } });
  const view = createNativeWorkLedgerView(() => ({ baseUrl: `http://127.0.0.1:${server.port}`, token: 'synthetic-control-token', workspace: '/synthetic' }), () => {});
  const printed: string[] = [];
  const context = { nativeWorkLedger: view, print: (text: string) => printed.push(text) } as unknown as import('../../input/command-registry.ts').CommandContext;
  const registry = new CommandRegistry(); registerAgentWorkspaceRuntimeCommands(registry);
  try {
    for (const action of ['start', 'status', 'cancel', 'resume']) await registry.execute('work', [action, 'native-work'], context);
    expect(operations.map(operation => operation.method)).toEqual(['start', 'status', 'cancel', 'status', 'resume']);
    for (const operation of operations) expect(operation.body).toEqual({ projectId: 'p', workId: 'native-work', attemptId: 'native-attempt', expectedRevision: { work: 3, criteria: 2, attempt: 4 } });
    await wait(() => view.state.status === 'ready');
    const rendered = nativeWorkLedgerLines(view.state).join('\n');
    expect(rendered).toContain('Original criterion'); expect(rendered).toContain('receipt-contract'); expect(rendered).toContain('semantic deferred'); expect(rendered).toContain('Verification: unverified');
    expect(printed.join(' ')).not.toContain('approval');
  } finally { view.close(); server.stop(true); }
});

test('native command distinguishes intent wire variants without manufacturing admission or receipts', async () => {
  const { CommandRegistry } = await import('../../input/command-registry.ts');
  const { registerAgentWorkspaceRuntimeCommands } = await import('../../input/commands/agent-workspace-runtime.ts');
  let intentState: 'admitting' | 'refused' | 'cancelled' = 'admitting'; const operations: string[] = [];
  const work = { source: null, id: 'intent-work', title: 'Original task', goal: 'Original intent', criteria: ['Original criterion'], revision: 3, criteriaRevision: 2, reportedState: 'in_progress', currentAttemptId: 'intent-attempt', createdAt: 1, updatedAt: 1 };
  const attempt = { id: 'intent-attempt', workId: work.id, predecessorId: null, ownerId: 'paired', revision: 4, state: 'active', report: null, blocker: null, createdAt: 1, updatedAt: 1 };
  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch(request) {
    expect(request.headers.get('authorization')).toBe('Bearer synthetic-intent-token'); const path = new URL(request.url).pathname;
    if (path === '/api/work-ledger/project') return Response.json({ projectId: 'p' });
    if (path.endsWith('/snapshot')) return Response.json({ projectId: 'p', cursor: 0, revision: 0, works: [{ work, attempt, verification: { state: 'unverified', reason: 'No evidence', evidence: null }, attention: [] }] });
    if (path.endsWith('/history')) return Response.json({ projectId: 'p', cursor: 0, afterSequence: 0, throughSequence: 0, hasMore: false, events: [] });
    operations.push(path.split('/').at(-1)!);
    const body = await request.json() as { projectId: string; workId: string; attemptId: string; expectedRevision: { work: number; criteria: number; attempt: number } };
    expect(body).toEqual({ projectId: 'p', workId: work.id, attemptId: attempt.id, expectedRevision: { work: 3, criteria: 2, attempt: 4 } });
    const common = { ...body, currentRevision: body.expectedRevision, currentAttempt: true, stale: false };
    return Response.json(intentState === 'cancelled'
      ? { ...common, kind: 'prevented-before-admission', state: 'cancelled', recovery: 'cancelled' }
      : { ...common, kind: 'pending-intent', state: intentState, recovery: intentState === 'admitting' ? 'pending' : 'required' });
  } });
  const view = createNativeWorkLedgerView(() => ({ baseUrl: `http://127.0.0.1:${server.port}`, token: 'synthetic-intent-token', workspace: '/synthetic' }), () => {});
  const printed: string[] = []; const registry = new CommandRegistry(); registerAgentWorkspaceRuntimeCommands(registry);
  const context = { nativeWorkLedger: view, print: (text: string) => printed.push(text) } as unknown as import('../../input/command-registry.ts').CommandContext;
  try {
    for (const [state, label] of [['admitting', 'Admission pending'], ['refused', 'Admission refused'], ['cancelled', 'Cancelled before admission']] as const) {
      intentState = state; await registry.execute('work', ['status', work.id], context);
      const text = printed.at(-1)!; expect(text).toContain(label); expect(text).toContain('Requested revisions');
      expect(text).not.toContain('Admitted revisions'); expect(text).not.toContain('Receipt:'); expect(text).not.toContain('Progress:');
    }
    expect(operations).toEqual(['status', 'status', 'status']);
  } finally { view.close(); server.stop(true); }
});
