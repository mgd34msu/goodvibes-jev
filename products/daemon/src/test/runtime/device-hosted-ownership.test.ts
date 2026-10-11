/** Reconstructed canonical caller proof; no external-operation scope is created by this suite. */
import { expect, spyOn, test } from 'bun:test';
import { withDecisionLog, type JudgmentRequest, type Questions } from '@goodvibes-jev/judgment';
import { choiceAnswer, fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { createHostedSessionRuntime } from '@goodvibes-jev/engine/sdk/platform/hosted-sessions';
import { DEVICE_CAPABILITY_IDS, DEVICE_NODE_ANNOUNCEMENT_KEY } from '@goodvibes-jev/engine/sdk/platform/devices';
import { executeToolCalls, type ToolExecutionDeps } from '@goodvibes-jev/engine/sdk/platform/core';
import { gateReadingsPort } from '../helpers/synthetic-gate-readings.js';
import { createHostedSessionOptions } from '../../runtime/hosted-session-composition.js';
import { useGatewayFixture } from '../helpers/gateway-fixture.js';

const fixture = useGatewayFixture({ hostSessions: false });
function barrier() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
async function until(check: () => boolean) { const deadline = Date.now() + 5000; while (!check()) { if (Date.now() > deadline) throw new Error('Device work was not queued'); await new Promise(done => setTimeout(done, 5)); } }

async function hosted() {
  const daemon = fixture(); const services = daemon.services;
  const floor = await createHostedSessionOptions(services).floorFactory!({ workspaceRoot: daemon.workingDirectory });
  expect(floor.devicePosture).toBe(services.devicePosture);
  const runtime = createHostedSessionRuntime({ floor, sessionId: 'device-canonical', workspaceRoot: daemon.workingDirectory, systemPrompt: 'Synthetic paired-device proof' });
  const readings: JudgmentRequest<Questions>[] = [];
  let hook: ((request: JudgmentRequest<Questions>) => void | Promise<void>) | undefined;
  const gate = gateReadingsPort([['', { outward: true, capability: 'write_fs', names_path: false, names_host: false }]]);
  const semantic = fakePort((_name, question) => question.type === 'noul' ? noulAnswer(0.99) : choiceAnswer(question, 'act', 0.99));
  const record = (log: typeof services.judgment.decisionLog) => withDecisionLog({ model: 'jev-1.13.0', async ask(request) {
    readings.push(request as JudgmentRequest<Questions>); request.beforeAttempt?.(); await hook?.(request as JudgmentRequest<Questions>);
    request.signal?.throwIfAborted(); request.beforeAttempt?.();
    return 'disposition' in request.questions || 'refuse' in request.questions ? semantic.port.ask(request) : gate.port.ask(request);
  } }, log);
  const rootPort = record(services.judgment.decisionLog); const floorPort = record(floor.services.judgment.decisionLog);
  const rootSpy = spyOn(services.judgment.port, 'ask').mockImplementation(request => rootPort.ask(request));
  const floorSpy = spyOn(floor.services.judgment.port, 'ask').mockImplementation(request => floorPort.ask(request));
  const human = spyOn(services.approvalBroker, 'requestApproval').mockImplementation(async () => { throw new Error('No human device fallback'); });
  const manager = services.distributedRuntime;
  const pair = await manager.requestPairing({ peerKind: 'device', label: 'Canonical synthetic phone', capabilities: DEVICE_CAPABILITY_IDS,
    metadata: { [DEVICE_NODE_ANNOUNCEMENT_KEY]: { nodeKind: 'web-pwa', contractVersion: 1, capabilities: DEVICE_CAPABILITY_IDS, secureContext: true } } });
  await manager.approvePairRequest(pair.request.id); const verified = await manager.verifyPairRequest(pair.request.id, pair.challenge);
  expect(verified).not.toBeNull(); const auth = { peer: verified!.peer, token: verified!.token };
  const turn = new AbortController();
  const deps: ToolExecutionDeps = { autonomousSource: () => ({ goal: 'Take the requested synthetic phone screenshot', criteria: ['Only this paired phone, retain exact returned bytes'] }),
    turnSignal: turn.signal, permissionManager: floor.services.permissionManager, toolRegistry: runtime.toolRegistry,
    hookDispatcher: null, runtimeBus: services.runtimeBus, sessionId: runtime.sessionId,
    emitterContext: () => ({ sessionId: runtime.sessionId, traceId: 'device-fixture', source: 'orchestrator' }),
  };
  return { manager, auth, runtime, readings, human, turn, onReading(next: typeof hook) { hook = next; },
    run() { return executeToolCalls(deps, crypto.randomUUID(), [{ id: crypto.randomUUID(), name: 'phone', arguments: { action: 'screenshot', nodeId: auth.peer.id, reason: 'Original screenshot request' } }]); },
    async close() { turn.abort(); rootSpy.mockRestore(); floorSpy.mockRestore(); human.mockRestore(); runtime.dispose(); await floor.dispose(); await manager.writes.drain(); },
  };
}

test('actual hosted phone registry carries original source through canonical execution and real paired queue', async () => {
  const h = await hosted();
  try {
    expect(h.runtime.toolRegistry.has('phone')).toBe(true);
    const pending = h.run(); await until(() => h.manager.listWork().some(work => work.peerId === h.auth.peer.id && work.status === 'queued'));
    const [work] = await h.manager.claimWork(h.auth); expect(work?.command).toBe('device.screen.capture');
    await h.manager.completeWork(h.auth, work!.id, { result: { contractVersion: 1, capabilityId: 'device.screen.capture', ok: true, mediaBase64: Buffer.from('owned synthetic pixels').toString('base64'), mediaType: 'image/png' } });
    const result = await pending; expect(result[0]?.success).toBe(true); expect(h.human).not.toHaveBeenCalled();
    expect(h.readings.some(request => request.context?.site === 'engine.device.autonomous')).toBe(true);
    expect(JSON.stringify(h.readings.filter(request => request.context?.site === 'engine.device.autonomous'))).toContain('Take the requested synthetic phone screenshot');
    expect(await fixture().services.devicePosture.artifacts.list(h.auth.peer.id)).toHaveLength(1);
  } finally { await h.close(); }
});

test('canonical turn cancellation while device judgment is held reaches no peer queue', async () => {
  const h = await hosted(); const entered = barrier(); const release = barrier();
  try {
    h.onReading(async request => { if (request.context?.site === 'engine.device.autonomous') { entered.resolve(); await release.promise; } });
    const pending = h.run(); const settled = pending.then(value => ({ value }), error => ({ error })); await entered.promise;
    h.turn.abort(); release.resolve(); const result = await settled;
    expect('error' in result ? result.error.name : '').toBe('AbortError');
    expect(h.manager.listWork().filter(work => work.peerId === h.auth.peer.id)).toEqual([]); expect(h.human).not.toHaveBeenCalled();
  } finally { release.resolve(); await h.close(); }
});

test('actual peer disconnect and reconnect ABA while Jev is held invalidates the operation', async () => {
  const h = await hosted(); const entered = barrier(); const release = barrier();
  try {
    h.onReading(async request => { if (request.context?.site === 'engine.device.autonomous') { entered.resolve(); await release.promise; } });
    const pending = h.run(); await entered.promise;
    const before = h.manager.peers.get(h.auth.peer.id)!;
    await h.manager.disconnectPeer(h.auth.peer.id);
    h.manager.peers.set(h.auth.peer.id, before);
    release.resolve(); expect((await pending)[0]?.success).toBe(false);
    expect(h.manager.listWork().filter(work => work.peerId === h.auth.peer.id)).toEqual([]);
  } finally { release.resolve(); await h.close(); }
});

test('raw hosted registry invocation has no original source and refuses', async () => {
  const h = await hosted();
  try {
    const result = await h.runtime.toolRegistry.execute('raw-phone', 'phone', { action: 'screenshot', nodeId: h.auth.peer.id, reason: 'Prose is not authority' });
    expect(result.success).toBe(false); expect(h.manager.listWork().filter(work => work.peerId === h.auth.peer.id)).toEqual([]);
    expect(h.readings).toEqual([]); expect(h.human).not.toHaveBeenCalled();
  } finally { await h.close(); }
});
