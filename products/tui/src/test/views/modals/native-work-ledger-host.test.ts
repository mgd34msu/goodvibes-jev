import { test, expect } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, existsSync } from 'node:fs';
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
import { pairNativeTestHost, replaceNativeTestCredential } from '../../helpers/native-host-pairing.ts';
import { tuiHostPairingStorePath } from '../../../runtime/tui-host-credential-store.ts';
const tick = () => new Promise(resolve => setTimeout(resolve, 10));
async function setup(handler: (request: Request) => Response | Promise<Response>) {
  const home = mkdtempSync(join(tmpdir(), 'native-tui-host-'));
  const server = Bun.serve({ port: 0, fetch: handler });
  let url = `http://localhost:${server.port}`; let workspace = '/one';
  await pairNativeTestHost(home, url, 'fixture-auth-only');
  let selectedHome = home;
  const configManager = { get: (key: string) => key === 'daemon.enabled' ? true : key === 'controlPlane.publicBaseUrl' ? url : undefined } as unknown as ConfigManager;
  const host = createNativeWorkLedgerHost({ configManager, homeDirectory: () => selectedHome, daemonHomeDirectory: home, workspace: () => workspace });
  return { host, home, configManager, currentUrl: () => url, setHome: (value: string) => { selectedHome = value; }, workspace: (v: string) => { workspace = v; }, endpoint: (v: string) => { url = v; }, close: () => { server.stop(true); rmSync(home, { recursive: true, force: true }); } };
}
const status = () => Response.json({ projectId: 'daemon-owned-project' });
test('passive empty-input host discovery uses existing auth, then public ledger transport', async () => {
  const paths: string[] = [];
  const f = await setup(request => {
    expect(request.headers.get('authorization')).toBe('Bearer fixture-auth-only');
    const url = new URL(request.url); paths.push(url.pathname + url.search);
    if (url.pathname === '/api/work-ledger/project') { expect(url.search).toBe(''); return status(); }
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
  let calls = 0; const f = await setup(() => { calls++; return new Response('denied', { status: 403 }); });
  try {
    await f.host.discoverProject(); const missing = f.host.readSelection(); expect(missing.available).toBe(false);
    if (!missing.available) expect(missing.reason).toContain('not permitted');
    f.host.selectProject('explicit-id'); await f.host.discoverProject(); expect(calls).toBe(1); expect(f.host.readSelection().available).toBe(true);
  } finally { f.close(); }
});
test('late discovery cannot replace newer explicit project or changed workspace', async () => {
  let release!: () => void; let arrived!: () => void;
  const arrival = new Promise<void>(resolve => { arrived = resolve; });
  const f = await setup(async () => { arrived(); await new Promise<void>(resolve => { release = resolve; }); return status(); });
  try {
    const pending = f.host.discoverProject(); await arrival; f.host.selectProject('explicit-new'); release(); expect(await pending).toBe(false);
    const selected = f.host.readSelection(); expect(selected.available && selected.projectId).toBe('explicit-new');
    f.workspace('/two'); expect(f.host.readSelection().available).toBe(false);
  } finally { f.close(); }
});
test('token replacement fences identity, missing token never mints credentials, changed host clears project', async () => {
  const f = await setup(() => status());
  try {
    f.host.selectProject('selected'); const old = f.host.readSelection();
    replaceNativeTestCredential(f.home, 'replacement-fixture');
    expect(f.host.readSelection().identity).not.toBe(old.identity);
    rmSync(tuiHostPairingStorePath(f.home)); expect(f.host.readSelection().available).toBe(false);
    f.endpoint('http://localhost:1'); expect(f.host.readSelection().available).toBe(false);
  } finally { f.close(); }
});

test('authenticated public read transport renders both suffix-colliding work IDs after keyboard interaction', async () => {
  const works = ['work', 'work:states'].map((id, index) => ({
    work: { source: null, id, title: index ? 'AUTH_SECOND_TITLE' : 'AUTH_FIRST_TITLE', goal: 'Read safely', criteria: ['Distinct visible facts'], revision: 1, criteriaRevision: 1, reportedState: 'pending', currentAttemptId: null, createdAt: 1, updatedAt: 1 },
    attempt: null, verification: { state: 'unverified', reason: index ? 'AUTH_SECOND_STATE' : 'AUTH_FIRST_STATE', evidence: null }, attention: [],
  }));
  const events = works.map((view, index) => ({ sequence: index + 1, type: 'create', actorId: 'host', requestId: `create-${index}`, workId: view.work.id, attemptId: null, at: 1, work: view.work, attempts: [], evidence: null, reason: null }));
  let authenticatedReads = 0;
  const f = await setup(request => {
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

test('production native modal executes exact authenticated wire actions and renders safe refusal without auto-start', async () => {
  const operations: string[] = []; let missing = false;
  const work = { source: null, id: 'native-work', title: 'Execute original task', goal: 'Original intent', criteria: ['Original criterion'], revision: 2, criteriaRevision: 1, reportedState: 'in_progress', currentAttemptId: 'native-attempt', createdAt: 1, updatedAt: 1 };
  const attempt = { id: 'native-attempt', workId: work.id, predecessorId: null, ownerId: 'paired', revision: 3, state: 'active', report: null, blocker: null, createdAt: 1, updatedAt: 1 };
  const f = await setup(async request => {
    expect(request.headers.get('authorization')).toBe('Bearer fixture-auth-only');
    const path = new URL(request.url).pathname;
    if (path === '/api/work-ledger/project') return status();
    if (path.endsWith('/snapshot')) return Response.json({ projectId: 'daemon-owned-project', cursor: 0, revision: 0, works: [{ work, attempt, verification: { state: 'unverified', reason: 'No evidence', evidence: null }, attention: [] }] });
    if (path.endsWith('/history')) return Response.json({ projectId: 'daemon-owned-project', cursor: 0, afterSequence: 0, throughSequence: 0, hasMore: false, events: [] });
    const operation = path.split('/').at(-1)!; operations.push(operation);
    const body = await request.json() as { projectId: string; workId: string; attemptId: string; expectedRevision: { work: number; criteria: number; attempt: number } };
    expect(body).toEqual({ projectId: 'daemon-owned-project', workId: 'native-work', attemptId: 'native-attempt', expectedRevision: { work: 2, criteria: 1, attempt: 3 } });
    if (missing) return Response.json({ error: 'private transport detail', code: 'NATIVE_EXECUTION_NOT_FOUND' }, { status: 404 });
    return Response.json({ kind: 'execution', ...body, currentRevision: body.expectedRevision, currentAttempt: true, stale: false, state: 'launch-claimed', recovery: 'required', receipt: { contractId: 'native-contract', ownerAgentId: 'native-owner' }, progress: null });
  });
  const modal = new ConfigModal(); const surface = createNativeWorkLedgerModalSurface(f.host.readSelection);
  const wait = async (condition: () => boolean) => { const deadline = Date.now() + 4000; while (!condition()) { if (Date.now() > deadline) throw new Error('Native action did not settle'); await tick(); } };
  const text = () => surface.buildView().tabs[0]!.rows.map(row => row.label).join('\n');
  try {
    await f.host.discoverProject(); modal.open(surface); await wait(() => text().includes('Control native-work')); modal.moveDown();
    expect(operations).toEqual([]);
    for (const [key, action] of [['s', 'start'], ['i', 'status'], ['c', 'cancel'], ['r', 'resume']] as const) {
      expect(modal.fireAction(key, { print() {} })).toBe(true);
      await wait(() => operations.at(-1) === action && text().includes('recovery required'));
    }
    expect(operations).toEqual(['start', 'status', 'cancel', 'status', 'resume']);
    expect(text()).toContain('native-contract'); expect(text()).toContain('verificationState unverified');
    missing = true; expect(modal.fireAction('i', { print() {} })).toBe(true); await wait(() => text().includes('No admitted native execution'));
    expect(operations).toEqual(['start', 'status', 'cancel', 'status', 'resume', 'status']); expect(text()).not.toContain('private transport detail');
  } finally { modal.close(); f.close(); }
});

test('native readers, discovery and intake never borrow daemon, Agent or environment credentials', async () => {
  let requests = 0; const f = await setup(() => { requests++; return status(); });
  const oldEnvironment = process.env.GOODVIBES_HOST_TOKEN;
  try {
    rmSync(tuiHostPairingStorePath(f.home));
    mkdirSync(join(f.home, '.goodvibes', 'daemon'), { recursive: true });
    mkdirSync(join(f.home, '.goodvibes', 'agent'), { recursive: true });
    writeFileSync(join(f.home, 'operator-tokens.json'), JSON.stringify({ token: 'global-override-secret' }));
    writeFileSync(join(f.home, '.goodvibes', 'daemon', 'operator-tokens.json'), JSON.stringify({ token: 'daemon-secret' }));
    writeFileSync(join(f.home, '.goodvibes', 'agent', 'host-credentials.json'), JSON.stringify({ token: 'agent-secret' }));
    process.env.GOODVIBES_HOST_TOKEN = 'environment-secret';
    f.host.selectProject('selected');
    const selection = f.host.readSelection(); expect(selection.available).toBe(false);
    if (!selection.available) expect(selection.reason).toContain('goodvibes host pair');
    await f.host.discoverProject();
    f.workspace(f.home);
    expect((await f.host.submission.status())?.status).toBe('unavailable');
    expect((await f.host.intake.submit({ text: 'Do the work', unsupportedSources: [] }))?.status).toBe('unavailable');
    expect(requests).toBe(0); expect(existsSync(tuiHostPairingStorePath(f.home))).toBe(false);
  } finally {
    if (oldEnvironment === undefined) delete process.env.GOODVIBES_HOST_TOKEN; else process.env.GOODVIBES_HOST_TOKEN = oldEnvironment;
    f.close();
  }
});

for (const change of ['token', 'store', 'home', 'endpoint'] as const) test(`captured ledger reader and execution binding refuse ${change} changes before network IO`, async () => {
  let requests = 0; const f = await setup(() => { requests++; return status(); });
  let binding: ReturnType<Extract<ReturnType<typeof f.host.readSelection>, { available: true }>['bind']> | undefined;
  try {
    f.host.selectProject('selected'); const selected = f.host.readSelection();
    if (!selected.available) throw new Error('Fixture must be paired');
    binding = selected.bind(() => {});
    if (!binding.available) throw new Error('Fixture must be available');
    if (change === 'token') replaceNativeTestCredential(f.home, 'replacement-token');
    if (change === 'store') replaceNativeTestCredential(f.home);
    if (change === 'home') {
      const other = join(f.home, 'other'); mkdirSync(other);
      await pairNativeTestHost(other, f.currentUrl(), 'fixture-auth-only'); f.setHome(other);
    }
    if (change === 'endpoint') f.endpoint('http://localhost:1');
    await expect(binding.client.readSnapshot()).rejects.toThrow();
    await expect(binding.execution!.status({ workId: 'work', attemptId: 'attempt', expectedRevision: { work: 1, criteria: 1, attempt: 1 } })).rejects.toThrow();
    expect(selected.bind(() => {}).available).toBe(false); expect(requests).toBe(0);
  } finally { if (binding?.available) { binding.execution?.dispose(); binding.client.dispose(); } f.close(); }
});

test('host errors cannot reflect the selected bearer into the native ledger view', async () => {
  const f = await setup(() => Response.json({ error: 'Rejected bearer fixture-auth-only', code: 'FORBIDDEN' }, { status: 403 }));
  const model = new NativeWorkLedgerModel(f.host.readSelection);
  try {
    f.host.selectProject('project'); model.open(() => {});
    for (let i = 0; i < 100 && !model.reason.includes('[redacted]'); i++) await tick();
    expect(model.reason).toContain('[redacted]'); expect(model.reason).not.toContain('fixture-auth-only');
  } finally { model.close(); f.close(); }
});
