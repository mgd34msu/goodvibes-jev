import { test, expect } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ConfigManager } from '@goodvibes-jev/engine/sdk/platform/config';
import { createNativeWorkLedgerHost } from '../../../runtime/native-work-ledger-host.ts';
import { NativeWorkLedgerModel } from '../../../runtime/native-work-ledger.ts';
import { createNativeWorkLedgerModalSurface } from '../../../views/modals/native-work-ledger-modal.ts';
import { ConfigModal } from '../../../input/config-modal.ts';
import { handleConfigModalToken } from '../../../input/handler-modal-routes.ts';
import { renderConfigModal } from '../../../renderer/config-modal.ts';
import { frameFromLayer } from '../../helpers/surface-frame.ts';
const tick = () => new Promise(resolve => setTimeout(resolve, 10));
function setup(handler: (request: Request) => Response | Promise<Response>) {
  const home = mkdtempSync(join(tmpdir(), 'native-tui-host-'));
  writeFileSync(join(home, 'operator-tokens.json'), JSON.stringify({ token: 'fixture-auth-only' }));
  const server = Bun.serve({ port: 0, fetch: handler });
  let url = `http://localhost:${server.port}`; let workspace = '/one';
  const configManager = { get: (key: string) => key === 'daemon.enabled' ? true : key === 'controlPlane.publicBaseUrl' ? url : undefined } as unknown as ConfigManager;
  const host = createNativeWorkLedgerHost({ configManager, homeDirectory: home, daemonHomeDirectory: home, workspace: () => workspace });
  return { host, home, workspace: (v: string) => { workspace = v; }, endpoint: (v: string) => { url = v; }, close: () => { server.stop(true); rmSync(home, { recursive: true, force: true }); } };
}
const status = () => Response.json({ ok: true, projectId: 'daemon-owned-project', knowledgeSpaceId: 'host-space', passiveOnly: true, counts: {}, capabilities: [] });
test('passive empty-input host discovery uses existing auth, then public ledger transport', async () => {
  const paths: string[] = [];
  const f = setup(request => {
    expect(request.headers.get('authorization')).toBe('Bearer fixture-auth-only');
    const url = new URL(request.url); paths.push(url.pathname + url.search);
    if (url.pathname === '/api/projects/planning/status') { expect(url.search).toBe(''); return status(); }
    if (url.pathname.endsWith('/snapshot')) return Response.json({ projectId: 'daemon-owned-project', revision: 0, cursor: 0, works: [] });
    if (url.pathname.endsWith('/history')) return Response.json({ projectId: 'daemon-owned-project', afterSequence: 0, cursor: 0, throughSequence: 0, hasMore: false, events: [] });
    return new Response('missing', { status: 404 });
  });
  try {
    expect(await f.host.discoverProject()).toBe(true); const selection = f.host.readSelection(); expect(selection.available).toBe(true);
    const model = new NativeWorkLedgerModel(f.host.readSelection); model.open(() => {}); await tick(); await tick();
    expect(model.snapshot?.projectId).toBe('daemon-owned-project'); model.close(); expect(paths.some(p => p.includes('/history'))).toBe(true);
  } finally { f.close(); }
});
test('discovery scope denial stays unavailable; explicit project override needs no discovery', async () => {
  let calls = 0; const f = setup(() => { calls++; return new Response('denied', { status: 403 }); });
  try {
    await f.host.discoverProject(); const missing = f.host.readSelection(); expect(missing.available).toBe(false);
    if (!missing.available) expect(missing.reason).toContain('not permitted');
    f.host.selectProject('explicit-id'); await f.host.discoverProject(); expect(calls).toBe(1); expect(f.host.readSelection().available).toBe(true);
  } finally { f.close(); }
});
test('late discovery cannot replace newer explicit project or changed workspace', async () => {
  let release!: () => void; let arrived!: () => void;
  const arrival = new Promise<void>(resolve => { arrived = resolve; });
  const f = setup(async () => { arrived(); await new Promise<void>(resolve => { release = resolve; }); return status(); });
  try {
    const pending = f.host.discoverProject(); await arrival; f.host.selectProject('explicit-new'); release(); expect(await pending).toBe(false);
    const selected = f.host.readSelection(); expect(selected.available && selected.projectId).toBe('explicit-new');
    f.workspace('/two'); expect(f.host.readSelection().available).toBe(false);
  } finally { f.close(); }
});
test('token replacement fences identity, missing token never mints credentials, changed host clears project', () => {
  const f = setup(() => status());
  try {
    f.host.selectProject('selected'); const old = f.host.readSelection();
    writeFileSync(join(f.home, 'operator-tokens.json'), JSON.stringify({ token: 'replacement-fixture' }));
    expect(f.host.readSelection().identity).not.toBe(old.identity);
    rmSync(join(f.home, 'operator-tokens.json')); expect(f.host.readSelection().available).toBe(false);
    f.endpoint('http://localhost:1'); expect(f.host.readSelection().available).toBe(false);
  } finally { f.close(); }
});

test('authenticated public read transport renders both suffix-colliding work IDs after keyboard interaction', async () => {
  const works = ['work', 'work:states'].map((id, index) => ({
    work: { id, title: index ? 'AUTH_SECOND_TITLE' : 'AUTH_FIRST_TITLE', goal: 'Read safely', criteria: ['Distinct visible facts'], revision: 1, criteriaRevision: 1, reportedState: 'pending', currentAttemptId: null, createdAt: 1, updatedAt: 1 },
    attempt: null, verification: { state: 'unverified', reason: index ? 'AUTH_SECOND_STATE' : 'AUTH_FIRST_STATE', evidence: null }, attention: [],
  }));
  const events = works.map((view, index) => ({ sequence: index + 1, type: 'create', actorId: 'host', requestId: `create-${index}`, workId: view.work.id, attemptId: null, at: 1, work: view.work, attempts: [], evidence: null, reason: null }));
  let authenticatedReads = 0;
  const f = setup(request => {
    if (request.headers.get('authorization') !== 'Bearer fixture-auth-only') return new Response('denied', { status: 403 });
    authenticatedReads++;
    const url = new URL(request.url);
    if (url.pathname.endsWith('/snapshot')) return Response.json({ projectId: 'daemon-owned-project', revision: 2, cursor: 2, works });
    if (url.pathname.endsWith('/history')) {
      const afterSequence = Number(url.searchParams.get('afterSequence') ?? 0);
      return Response.json({ projectId: 'daemon-owned-project', afterSequence, cursor: 2, throughSequence: 2, hasMore: false, events: events.filter(event => event.sequence > afterSequence) });
    }
    return new Response('missing', { status: 404 });
  });
  const modal = new ConfigModal();
  try {
    f.host.selectProject('daemon-owned-project');
    const surface = createNativeWorkLedgerModalSurface(f.host.readSelection); modal.open(surface);
    for (let i = 0; i < 100 && surface.buildView().degraded; i++) await tick();
    expect(surface.buildView().degraded).toBeUndefined(); expect(authenticatedReads).toBeGreaterThanOrEqual(2);
    handleConfigModalToken({ configModal: modal, requestRender: () => {}, handleEscape: () => modal.close() }, { type: 'key', logicalName: 'down' } as never);
    const text = frameFromLayer(renderConfigModal(modal, 180, 45), 180, 45).map(line => line.map(cell => cell.char).join('')).join('\n');
    expect(text).toContain('AUTH_FIRST_TITLE'); expect(text).toContain('AUTH_SECOND_TITLE');
    expect(text.split('AUTH_FIRST_STATE')).toHaveLength(2); expect(text.split('AUTH_SECOND_STATE')).toHaveLength(2);
  } finally { modal.close(); f.close(); }
});
