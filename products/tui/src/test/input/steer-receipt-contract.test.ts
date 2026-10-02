import { afterEach, expect, test } from 'bun:test';
import { createProcessRegistry, STEER_TTL_MS, type ProcessRegistryDeps } from '@goodvibes-jev/engine/sdk/platform/runtime/fleet';
import { RuntimeEventBus } from '@goodvibes-jev/engine/sdk/platform/runtime/state';
import { emitCommunicationConsumed } from '@goodvibes-jev/engine/sdk/platform/runtime/emitters';
import { AgentsModal } from '../../input/agents-modal.ts';
import { SurfaceModalHost } from '../../input/surface-modal-host.ts';
import { createFleetReadModel } from '../../views/fleet-read-model.ts';
import { reconcileSteerBadges } from '../../views/fleet-steer.ts';

type AgentRecord = ReturnType<ProcessRegistryDeps['agentManager']['list']>[number];
const cleanups: Array<() => void> = [];
afterEach(() => { for(const cleanup of cleanups.splice(0)) cleanup(); });
const flush = () => new Promise<void>(resolve => setImmediate(resolve));
function fixture(kind: 'acp' | 'native', rejected = false, title = 'Hosted synthetic') {
 const record: AgentRecord = { id: 'a1', task: 'Synthetic task', template: 'engineer', tools: [], status: 'running', startedAt: Date.now(), toolCallCount: 0, orchestrationDepth: 0, executionProtocol: 'direct', reviewMode: 'none', communicationLane: 'parent-only' };
 const bus = new RuntimeEventBus();
 const sends: unknown[] = []; const prompts: unknown[] = []; const wakes: unknown[] = [];
 const registry = createProcessRegistry({
  agentManager: { list: () => kind === 'native' ? [record] : [], cancel: () => false, wakeWithSteer: (id, text) => { wakes.push({ id, text }); return { woke: true, reason: 'Synthetic wake accepted' }; } },
  contractRunner: { list: () => [], cancel: () => false },
  processManager: { list: () => [], stop: () => false, getStatus: () => undefined },
  watcherRegistry: { list: () => [], stopWatcher: () => null },
  workflow: { workflowManager: { list: () => [], cancel: () => false }, triggerManager: { list: () => [], remove: () => false, disable: () => false, enable: () => false }, scheduleManager: { list: () => [], remove: () => false, disable: () => false, enable: () => false } },
  messageBus: { send: (from, to, text, options) => { sends.push({ from, to, text, options }); return !rejected; } },
  acpHost: { list: () => kind === 'acp' ? [{ id: 'h1', agentId: 'synthetic', title, binaryPath: '/synthetic/agent', cwd: '/synthetic/project', state: 'idle', startedAt: 1, promptCount: 0 }] : [], prompt: (id, text) => { prompts.push({ id, text }); return rejected ? { queued: false, reason: 'Synthetic host refusal' } : { queued: true }; }, stop: async () => false },
 });
 const host = new SurfaceModalHost(); let duringSteer: (() => void) | undefined; let renders = 0;
 const modal = new AgentsModal({ readModel: createFleetReadModel(registry, bus), actions: { interrupt: id => registry.interrupt(id), resume: id => registry.resume(id), kill: id => registry.kill(id), getConversationSnapshot: () => [], resolveSessionLogPath: () => '', steer: (id, text) => { const result = registry.steer(id, text); duringSteer?.(); return result; } }, tickMs: 0, requestRender: () => { renders++; } });
 host.push(modal); cleanups.push(() => { host.clear(); registry.dispose(); });
 const id = kind === 'acp' ? 'acp:h1' : 'a1'; modal.reveal({ id });
 const start = () => { host.handleToken({ type: 'text', value: 's' }); host.handleToken({ type: 'text', value: 'Preserved synthetic draft' }); };
 const submit = () => host.handleToken({ type: 'key', name: 'enter', logicalName: 'enter', ctrl: false, meta: false, shift: false });
 const badge = () => modal.tabs.tabs.find(t => t.nodeId === id)?.steerBadge;
 const rendered = () => modal.render(120, 35).lines.map(line => line.map(cell => cell.char).join('')).join('\n');
 return { record, registry, host, modal, bus, sends, prompts, wakes, id, start, submit, badge, rendered, renders: () => renders, during: (callback: () => void) => { duringSteer = callback; } };
}

test('ACP actual host receipt is acceptance, never message-bus delivery or expiration', async () => {
 const f = fixture('acp'); f.start(); f.submit();
 expect(f.prompts).toEqual([{ id: 'h1', text: 'Preserved synthetic draft' }]); expect(f.sends).toEqual([]);
 expect(f.badge()?.status).toBe('accepted');
 expect(f.rendered()).toContain('ACP host accepted'); expect(f.rendered()).toContain('delivery unknown');
 const original = f.badge();
 reconcileSteerBadges(f.modal.tabs.tabs, id => f.registry.getNode(id), Date.now() + STEER_TTL_MS + 1);
 expect(f.badge()).toEqual(original);
 emitCommunicationConsumed(f.bus, { sessionId: 'synthetic', traceId: 'synthetic', source: 'test' }, { messageId: original!.messageId, agentId: 'h1', turn: 1 }); await flush();
 expect(f.badge()?.status).toBe('accepted');
 reconcileSteerBadges(f.modal.tabs.tabs, () => null, Date.now() + STEER_TTL_MS + 2);
 expect(f.badge()?.status).toBe('accepted'); expect(f.rendered()).not.toContain('expired undelivered');
});

test('native bus receipt retains queued, exact consumption and unrelated-event controls', async () => {
 const f = fixture('native'); f.start(); f.submit();
 expect(f.badge()?.status).toBe('queued'); expect(f.sends).toHaveLength(1); expect(f.prompts).toEqual([]);
 expect(f.sends[0]).toMatchObject({ from: 'operator', to: 'a1', options: { kind: 'steer', ttlMs: STEER_TTL_MS, id: f.badge()!.messageId } });
 emitCommunicationConsumed(f.bus, { sessionId: 'synthetic', traceId: 'synthetic', source: 'test' }, { messageId: 'other', agentId: 'a1', turn: 1 }); await flush(); expect(f.badge()?.status).toBe('queued');
 emitCommunicationConsumed(f.bus, { sessionId: 'synthetic', traceId: 'synthetic', source: 'test' }, { messageId: f.badge()!.messageId, agentId: 'a1', turn: 2 }); await flush(); expect(f.badge()?.status).toBe('consumed');
});

test('native bus expiry remains bounded by its actual stamped TTL', () => {
 const f = fixture('native'); f.start(); f.submit();
 reconcileSteerBadges(f.modal.tabs.tabs, id => f.registry.getNode(id), Date.now() + STEER_TTL_MS + 1);
 expect(f.badge()?.status).toBe('dropped'); expect(f.badge()?.note).toBe('expired undelivered');
});

test('a target failing after composition returns a real wake acceptance without bus TTL', () => {
 const f = fixture('native'); f.start(); f.record.status = 'failed'; f.submit();
 expect(f.wakes).toEqual([{ id: 'a1', text: 'Preserved synthetic draft' }]); expect(f.sends).toEqual([]);
 expect(f.badge()?.status).toBe('accepted'); expect(f.rendered()).toContain('Wake accepted'); expect(f.rendered()).toContain('delivery unknown');
 const original = f.badge(); reconcileSteerBadges(f.modal.tabs.tabs, id => f.registry.getNode(id), Date.now() + STEER_TTL_MS + 1);
 expect(f.badge()).toEqual(original);
});

test('host refusal preserves the draft and exposes its bounded error', () => {
 const f = fixture('acp', true); f.start(); f.submit();
 expect(f.modal.steer?.draft).toBe('Preserved synthetic draft'); expect(f.modal.status?.text).toContain('Synthetic host refusal'); expect(f.badge()).toBeUndefined();
});

test('reentrant close cannot install a stale receipt or repaint the dismissed modal', () => {
 const f = fixture('acp'); f.start(); let atClose = 0;
 f.during(() => { f.host.clear(); atClose = f.renders(); }); f.submit();
 expect(f.prompts).toHaveLength(1); expect(f.modal.tabs.tabs).toEqual([]); expect(f.modal.status).toBeNull(); expect(f.renders()).toBe(atClose);
});

test('reentrant target-composer replacement is not cleared by an older accepted receipt', () => {
 const f = fixture('acp'); f.start(); const newer = { id: 'another-target', draft: 'Keep newer draft' };
 f.during(() => { f.modal.steer = newer; }); f.submit();
 expect(f.modal.steer).toBe(newer); expect(f.modal.tabs.tabs).toEqual([]); expect(f.modal.status).toBeNull();
});


test('rapid Enter after accepted host receipt never submits a duplicate steer', () => {
 const f = fixture('acp'); f.start(); f.submit(); f.submit(); f.submit();
 expect(f.prompts).toEqual([{ id: 'h1', text: 'Preserved synthetic draft' }]);
 expect(f.badge()?.status).toBe('accepted'); expect(f.modal.steer).toBeNull();
});


test('compact rendered acceptance keeps delivery uncertainty before a long target label', () => {
 const f = fixture('acp', false, 'Very long synthetic hosted target '.repeat(6)); f.start(); f.submit();
 const text = f.modal.render(80, 24).lines.map(line => line.map(cell => cell.char).join('')).join('\n');
 expect(text).toContain('ACP host accepted'); expect(text).toContain('delivery unknown');
 expect(f.badge()?.status).toBe('accepted');
});
