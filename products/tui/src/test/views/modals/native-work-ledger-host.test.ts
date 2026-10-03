import { test, expect } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ConfigManager } from '@goodvibes-jev/engine/sdk/platform/config';
import { createNativeWorkLedgerHost } from '../../../runtime/native-work-ledger-host.ts';
import { NativeWorkLedgerModel } from '../../../runtime/native-work-ledger.ts';
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
