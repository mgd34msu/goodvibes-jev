import { describe, expect, test } from 'bun:test';
import type { InputToken } from '@goodvibes-jev/engine/sdk/platform/core';
import { FleetSpawn, type AcpDiscoveredAgent, type AcpWorkspaceRegistration, type AcpSpawnGateway } from '../../views/fleet-spawn.ts';
import { AgentsModal } from '../../input/agents-modal.ts';
import { SurfaceModalHost } from '../../input/surface-modal-host.ts';
import { buildFleetSnapshot, createStaticFleetReadModel } from '../../views/fleet-read-model.ts';

const agent: AcpDiscoveredAgent = { id: 'synthetic-agent', title: 'Synthetic agent', binaryPath: '/synthetic/agent', args: [] };
const key = (logicalName: string): InputToken => ({ type: 'key', name: logicalName, logicalName, ctrl: false, meta: false, shift: false });
const flush = () => new Promise<void>(resolve => setImmediate(resolve));
function deferred<T>() {
 let resolve!: (value: T) => void; let reject!: (error: Error) => void;
 const promise = new Promise<T>((ok, fail) => { resolve = ok; reject = fail; });
 return { promise, resolve, reject };
}
function setup(overrides: Partial<AcpSpawnGateway> = {}) {
 const notes: string[] = []; let renders = 0; let creates = 0; let reads = 0;
 const gateway: AcpSpawnGateway = {
  listAgents: async () => [agent],
  listWorkspaces: async () => { reads++; return []; },
  createSession: async () => { creates++; throw new Error('Unexpected synthetic create'); },
  ...overrides,
 };
 const spawn = new FleetSpawn({ resolveGateway: () => ({ available: true, gateway }), currentDirectory: () => '/synthetic/current', notify: text => notes.push(text), markDirty: () => { renders++; } });
 const host = new SurfaceModalHost();
 const open = () => {
  const modal = new AgentsModal({
   readModel: createStaticFleetReadModel(buildFleetSnapshot([])), spawn,
   actions: { interrupt: () => false, resume: () => false, kill: () => [], getConversationSnapshot: () => [], resolveSessionLogPath: () => '', steer: () => ({ queued: false, reason: 'unused' }) },
   requestRender: () => { renders++; }, tickMs: 0,
  });
  host.push(modal); return modal;
 };
 open();
 return { spawn, host, open, notes, renders: () => renders, creates: () => creates, reads: () => reads };
}

describe('FleetSpawn pending read ownership through the actual modal host', () => {
 for (const settlement of ['resolve', 'reject'] as const) {
  test(`Escape during directory read prevents late ${settlement} reopening or repaint`, async () => {
   const pending = deferred<readonly AcpWorkspaceRegistration[]>();
   const f = setup({ listWorkspaces: () => pending.promise });
   f.host.handleToken({ type: 'text', value: 'n' }); await flush();
   f.host.handleToken(key('enter')); f.host.escape();
   expect(f.spawn.spawnModeActive()).toBe(false); expect(f.host.depth).toBe(1);
   const renders = f.renders();
   if (settlement === 'resolve') pending.resolve([{ root: '/synthetic/late', registeredAt: '2026-01-01' }]); else pending.reject(new Error('old directory error'));
   await flush();
   expect(f.spawn.spawnModeActive()).toBe(false); expect(f.renders()).toBe(renders);
   expect(f.notes).toEqual([]); expect(f.creates()).toBe(0); f.host.clear();
  });
  test(`closing the modal during discovery suppresses late ${settlement} and preserves a reopened flow`, async () => {
   const pending = deferred<readonly AcpDiscoveredAgent[]>(); let calls = 0;
   const f = setup({ listAgents: () => ++calls === 1 ? pending.promise : Promise.resolve([{ ...agent, title: 'Current choice' }]) });
   f.host.handleToken({ type: 'text', value: 'n' }); f.host.clear(); f.open();
   f.host.handleToken({ type: 'text', value: 'n' }); await flush();
   expect(f.spawn.spawnView()?.options[0]?.label).toBe('Current choice');
   const renders = f.renders();
   if (settlement === 'resolve') pending.resolve([agent]); else pending.reject(new Error('old discovery error'));
   await flush();
   expect(f.spawn.spawnView()?.options[0]?.label).toBe('Current choice');
   expect(f.renders()).toBe(renders); expect(f.notes).toEqual([]); f.host.clear();
  });
 }
 test('rapid Enter keys issue one directory read and cannot create before it completes', async () => {
  const pending = deferred<readonly AcpWorkspaceRegistration[]>(); let calls = 0;
  const f = setup({ listWorkspaces: () => { calls++; return pending.promise; } });
  f.host.handleToken({ type: 'text', value: 'n' }); await flush();
  for(let i = 0; i < 5; i++) f.host.handleToken(key('enter'));
  expect(calls).toBe(1); expect(f.creates()).toBe(0);
  pending.resolve([]); await flush();
  expect(f.spawn.spawnView()?.step).toBe('dir'); expect(f.creates()).toBe(0); f.host.clear();
 });
 test('old directory result cannot replace a newer cancelled-and-reopened picker', async () => {
  const pending = deferred<readonly AcpWorkspaceRegistration[]>(); let calls = 0;
  const f = setup({ listWorkspaces: () => ++calls === 1 ? pending.promise : Promise.resolve([]) });
  f.host.handleToken({ type: 'text', value: 'n' }); await flush();
  f.host.handleToken(key('enter')); f.host.escape();
  f.host.handleToken({ type: 'text', value: 'n' }); await flush();
  const current = f.spawn.spawnView(); const renders = f.renders();
  pending.resolve([{ root: '/synthetic/old', registeredAt: '2026-01-01' }]); await flush();
  expect(f.spawn.spawnView()).toEqual(current); expect(f.renders()).toBe(renders); expect(f.creates()).toBe(0); f.host.clear();
 });
});

test('current agent and directory choices render through the real modal at ordinary and compact sizes', async () => {
 const f = setup();
 f.host.handleToken({ type: 'text', value: 'n' }); await flush();
 for (const [width, height] of [[100, 30], [50, 14]] as const) {
  const layer = f.host.render(width, height)[0]!;
  expect(layer.lines.length).toBeLessThanOrEqual(height);
  expect(layer.lines.every(line => line.length <= width)).toBe(true);
  expect(layer.lines.flat().map(cell => cell.char).join('')).toContain('Synthetic agent');
 }
 f.host.handleToken(key('enter')); await flush();
 for (const [width, height] of [[100, 30], [50, 14]] as const) {
  const layer = f.host.render(width, height)[0]!;
  expect(layer.lines.length).toBeLessThanOrEqual(height);
  expect(layer.lines.every(line => line.length <= width)).toBe(true);
  expect(layer.lines.flat().map(cell => cell.char).join('')).toContain('current directory');
 }
 f.host.clear();
});

test('closing during directory lookup invalidates it even when the same controller is reopened', async () => {
 const pending = deferred<readonly AcpWorkspaceRegistration[]>();
 const f = setup({ listWorkspaces: () => pending.promise });
 f.host.handleToken({ type: 'text', value: 'n' }); await flush();
 f.host.handleToken(key('enter')); f.host.clear(); f.open();
 const renders = f.renders(); pending.resolve([]); await flush();
 expect(f.spawn.spawnModeActive()).toBe(false); expect(f.renders()).toBe(renders);
 expect(f.host.depth).toBe(1); expect(f.creates()).toBe(0); f.host.clear();
});

test('rapid discovery keys share one read; current discovery errors stay visible', async () => {
 const pending = deferred<readonly AcpDiscoveredAgent[]>(); let calls = 0;
 const f = setup({ listAgents: () => { calls++; return pending.promise; } });
 for (let i = 0; i < 5; i++) f.host.handleToken({ type: 'text', value: 'n' });
 expect(calls).toBe(1); pending.reject(new Error('current discovery failed')); await flush();
 expect(f.notes).toEqual(['Could not list ACP agents: current discovery failed']);
 expect(f.spawn.spawnModeActive()).toBe(false); f.host.clear();
});

for (const settlement of ['resolve', 'reject'] as const) {
 test(`filtered list Escape invalidates pending discovery ${settlement} while clearing query`, async () => {
  const pending = deferred<readonly AcpDiscoveredAgent[]>();
  const f = setup({ listAgents: () => pending.promise });
  f.host.handleToken({ type: 'text', value: '/' }); f.host.handleToken({ type: 'text', value: 'review' }); f.host.handleToken(key('enter'));
  f.host.handleToken({ type: 'text', value: 'n' }); f.host.escape();
  expect(f.host.depth).toBe(1); const renders = f.renders();
  if (settlement === 'resolve') pending.resolve([agent]); else pending.reject(new Error('obsolete discovery'));
  await flush(); expect(f.spawn.spawnModeActive()).toBe(false); expect(f.notes).toEqual([]); expect(f.renders()).toBe(renders); f.host.clear();
 });
 test(`Escape dismisses an admitted create UI but retains its honest ${settlement} receipt`, async () => {
  const pending = deferred<Awaited<ReturnType<AcpSpawnGateway['createSession']>>>(); let creates = 0;
  const f = setup({ createSession: () => { creates++; return pending.promise; } });
  f.host.handleToken({ type: 'text', value: 'n' }); await flush(); f.host.handleToken(key('enter')); await flush(); f.host.handleToken(key('enter'));
  expect(creates).toBe(1); f.host.escape(); expect(f.spawn.spawnModeActive()).toBe(false);
  const renders = f.renders();
  if (settlement === 'resolve') pending.resolve({ hosted: { id: 'synthetic-created', agentId: agent.id, title: agent.title, binaryPath: agent.binaryPath, cwd: '/synthetic/current', state: 'starting', startedAt: 1, promptCount: 0 }, started: true });
  else pending.reject(new Error('admitted create failed'));
  await flush(); expect(f.spawn.spawnModeActive()).toBe(false); expect(f.renders()).toBe(renders);
  expect(f.notes).toHaveLength(1); expect(f.notes[0]).toContain(settlement === 'resolve' ? 'Hosting Synthetic agent' : 'admitted create failed');
  expect(creates).toBe(1); f.host.clear();
 });
}
