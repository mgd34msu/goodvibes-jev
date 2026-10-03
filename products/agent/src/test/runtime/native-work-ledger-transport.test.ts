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
    if (url.pathname === '/api/projects/planning/status') {
      if (!discovery) return Response.json({ error: 'read:knowledge required' }, { status: 403 });
      return Response.json({ ok: true, projectId: 'daemon-project', knowledgeSpaceId: 'host', passiveOnly: true, counts: {}, capabilities: [] });
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
    const discovery = fixture.requests.find(request => new URL(request.url).pathname === '/api/projects/planning/status')!;
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
    expect(fixture.requests.every(request => new URL(request.url).pathname === '/api/projects/planning/status')).toBe(true);
    view.selectProject('daemon-project'); view.open(); await wait(() => view.state.status === 'ready');
    view.selectProject('other-project'); view.open(); await wait(() => view.state.status === 'unavailable');
    expect(nativeWorkLedgerLines(view.state).join('\n')).not.toContain('No native work recorded');
  } finally { view.close(); fixture.close(); }
});
