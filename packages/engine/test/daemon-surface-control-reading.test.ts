import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createSystemOnePort, PINNED_MODEL, SqliteDecisionLog, withDecisionLog, type JudgmentPort, type JudgmentRequest, type Questions } from '@goodvibes-jev/judgment';
import { fakePort, choiceAnswer } from '@goodvibes-jev/judgment/testing';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { DaemonSurfaceActionHelper } from '../sdk/src/platform/daemon/surface-actions.ts';
import { handleHomeAssistantSurfaceWebhook } from '../sdk/src/platform/adapters/homeassistant/index.ts';
import type { SurfaceAdapterContext } from '../sdk/src/platform/adapters/types.ts';
import type { ChannelPolicyDecision } from '../sdk/src/platform/channels/types.ts';

let previous: ReturnType<typeof installJudgmentPort>;
let requests: JudgmentRequest<Questions>[];
let route: string;
let selected: string;
let confidence: number;
let pause: ((request: JudgmentRequest<Questions>) => Promise<void>) | undefined;
let log: SqliteDecisionLog;
beforeEach(() => {
  requests = []; route = 'cancel'; selected = 'target_0'; confidence = 0.99; pause = undefined;
  log = new SqliteDecisionLog(':memory:');
  const fake = fakePort((name, question) => choiceAnswer(question, name === 'action' ? route : selected, confidence));
  const inner: JudgmentPort = { model: fake.port.model, async ask(request) {
    request.signal?.throwIfAborted();
    await request.beforeAsyncAttempt?.();
    request.beforeAttempt?.(); requests.push(request as JudgmentRequest<Questions>);
    await pause?.(request as JudgmentRequest<Questions>);
    request.beforeAttempt?.();
    return fake.port.ask(request);
  } };
  previous = installJudgmentPort(withDecisionLog(inner, log));
});
afterEach(() => { installJudgmentPort(previous); log[Symbol.dispose](); });
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
function harness(unregistered = false) {
  let policy = { surface: 'homeassistant', allowlistUserIds: ['owner'], groupPolicies: [], enabled: true };
  const runs = new Map<string, { id: string; status: string }>([['run-1', { id: 'run-1', status: 'running' }]]);
  const effects: string[] = [];
  const agent = { id: 'agent-1', status: 'running' };
  const session = { id: 'session-1', status: 'active', messageCount: 1 };
  const helper = new DaemonSurfaceActionHelper({
    channelPolicy: { getPolicy: () => unregistered ? { ...policy, updatedAt: Date.now() } : policy, listPolicies: () => unregistered ? [] : [policy] },
    automationManager: { getRun: (id: string) => runs.get(id), cancelRun: async (id: string) => { effects.push(`cancel:${id}`); return runs.get(id); },
      retryRun: async (id: string) => { effects.push(`retry:${id}`); return runs.get(id); } },
    agentManager: { getStatus: (id: string) => id === 'agent-1' ? agent : undefined },
    sessionBroker: { getSession: (id: string) => id === 'session-1' ? session : undefined },
  } as unknown as ConstructorParameters<typeof DaemonSurfaceActionHelper>[0]);
  helper.authorizeSurfaceIngress = async () => ({ allowed: true, reason: 'authorized', policy } as unknown as ChannelPolicyDecision);
  const context = helper.buildSurfaceAdapterContext();
  const authorize = (text: string) => context.authorizeSurfaceIngress({ surface: 'homeassistant', userId: 'owner', text });
  return { helper, context, authorize, effects, runs, revoke: () => { policy = { ...policy, enabled: false }; } };
}

describe('the real daemon surface control caller', () => {
  for (const action of ['status', 'cancel', 'retry'] as const) test(`reads paraphrased ${action} and executes the exact existing ID`, async () => {
    const h = harness(); route = action;
    const text = action === 'status' ? 'How is run-1 progressing?' : action === 'cancel' ? 'Please stop run-1 now' : 'Give run-1 another try';
    await h.authorize(text);
    const command = await h.context.parseSurfaceControlCommand(text);
    expect(command).toEqual({ action, id: 'run-1' });
    const response = await h.context.performSurfaceControlCommand(command!);
    expect(response).toContain('run-1');
    expect(requests).toHaveLength(1);
    expect(requests[0]!.context?.battery).toBe('engine.daemon.surface-control');
    expect(JSON.stringify(requests[0]!.state)).toContain(text);
    expect(() => h.context.performSurfaceControlCommand(command!)).toThrow('no current source reading');
  });
  test('a default unregistered policy does not expire just because its generated timestamp changes', async () => {
    const h = harness(true); const text = 'Stop run-1'; await h.authorize(text);
    pause = async () => { await new Promise(resolve => setTimeout(resolve, 2)); };
    const command = await h.context.parseSurfaceControlCommand(text);
    expect(command).toEqual({ action: 'cancel', id: 'run-1' });
    await h.context.performSurfaceControlCommand(command!); expect(h.effects).toEqual(['cancel:run-1']);
  });
  test('multiple existing IDs are offered intact and only the read target is executed', async () => {
    const h = harness(); h.runs.set('run-2', { id: 'run-2', status: 'running' }); selected = 'target_1';
    const text = 'Leave run-1 alone; stop run-2'; await h.authorize(text);
    const command = await h.context.parseSurfaceControlCommand(text);
    expect(command).toEqual({ action: 'cancel', id: 'run-2' });
    expect(requests[0]!.state).toMatchObject({ targets: [{ id: 'run-1', kind: 'run' }, { id: 'run-2', kind: 'run' }] });
    await h.context.performSurfaceControlCommand(command!); expect(h.effects).toEqual(['cancel:run-2']);
  });
  for (const id of ['agent-1', 'session-1']) test(`status supports the exact existing ${id}`, async () => {
    const h = harness(); route = 'status'; const text = `How is ${id}?`; await h.authorize(text);
    const command = await h.context.parseSurfaceControlCommand(text); expect(command).toEqual({ action: 'status', id });
    expect(await h.context.performSurfaceControlCommand(command!)).toContain(id);
  });
  test('a returned control cannot be mutated into an unjudged action or ID', async () => {
    const h = harness(); const text = 'Stop run-1'; await h.authorize(text);
    const command = await h.context.parseSurfaceControlCommand(text);
    expect(Object.isFrozen(command)).toBe(true); expect(Reflect.set(command!, 'id', 'run-2')).toBe(false);
    expect(Reflect.set(command!, 'action', 'retry')).toBe(false);
    await h.context.performSurfaceControlCommand(command!); expect(h.effects).toEqual(['cancel:run-1']);
  });
  test('restart cannot revive an adapter context from the previous daemon lifetime', async () => {
    const h = harness(); const text = 'Stop run-1'; await h.authorize(text);
    h.helper.closeDelegatedTelegram(); h.helper.startDelegatedTelegram();
    await expect(h.context.parseSurfaceControlCommand(text)).rejects.toBeDefined(); expect(requests).toEqual([]);
  });
  test('an async current-source guard fails closed without being hidden by wrapper composition', async () => {
    const h = harness(); const text = 'Stop run-1'; await h.authorize(text);
    await expect(h.context.parseSurfaceControlCommand(text, { beforeAttempt: async () => { throw new Error('synthetic guard refusal'); } })).rejects.toThrow('must be synchronous');
    expect(requests).toEqual([]); expect(h.effects).toEqual([]);
  });
  test('ordinary leading verbs without an existing ID remain assistant messages without a reading', async () => {
    const h = harness();
    for (const text of ['Cancel my dentist appointment', 'Status update for my report', 'Retry the upload', 'Cancel run-999']) {
      await h.authorize(text);
      expect(await h.context.parseSurfaceControlCommand(text)).toBeNull();
    }
    expect(requests).toEqual([]); expect(h.effects).toEqual([]);
  });
  for (const text of ['Do not cancel run-1', 'Explain "cancel run-1"', 'Status update: run-1 is done']) test(`ordinary context is not swallowed: ${text}`, async () => {
    const h = harness(); route = 'message'; await h.authorize(text);
    expect(await h.context.parseSurfaceControlCommand(text)).toBeNull();
    expect(requests).toHaveLength(1); expect(h.effects).toEqual([]);
  });
  test('uncertain or missing-target readings have no control effect', async () => {
    const h = harness(); const text = 'Stop run-1'; await h.authorize(text);
    confidence = 0.5; expect(await h.context.parseSurfaceControlCommand(text)).toBeNull();
    confidence = 0.99; selected = 'none'; expect(await h.context.parseSurfaceControlCommand(text)).toBeNull();
    expect(h.effects).toEqual([]);
  });
  test('sessions support status only; model cannot turn a session into a cancel target', async () => {
    const h = harness(); const text = 'Cancel session-1'; await h.authorize(text);
    expect(await h.context.parseSurfaceControlCommand(text)).toBeNull(); expect(h.effects).toEqual([]);
  });
  test('invalid response remains an operational error with no regex fallback', async () => {
    const h = harness(); const text = 'cancel run-1'; await h.authorize(text); selected = 'invented';
    await expect(h.context.parseSurfaceControlCommand(text)).rejects.toBeDefined(); expect(h.effects).toEqual([]);
  });
  test('source must be authorized and exactly the accepted input before any reading', async () => {
    const h = harness();
    await expect(h.context.parseSurfaceControlCommand('cancel run-1')).rejects.toThrow('no longer authorized');
    await h.authorize('status run-1');
    await expect(h.context.parseSurfaceControlCommand('cancel run-1')).rejects.toThrow('no longer authorized');
    expect(requests).toEqual([]);
  });
  test('protected text is refused before the model even when a command-looking prefix exists', async () => {
    const h = harness(); const text = 'cancel run-1 Authorization: Bearer synthetic-secret'; await h.authorize(text);
    await expect(h.context.parseSurfaceControlCommand(text)).rejects.toThrow('Refused before judgment'); expect(requests).toEqual([]);
  });
  for (const invalidate of ['policy', 'target', 'supersession']) test(`${invalidate} changes while pending prevent a late control and retention`, async () => {
    const h = harness(); const text = 'Stop run-1'; await h.authorize(text);
    const started = deferred(); const resume = deferred(); pause = async () => { started.resolve(); await resume.promise; };
    const result = h.context.parseSurfaceControlCommand(text); await started.promise;
    if (invalidate === 'policy') h.revoke();
    else if (invalidate === 'target') h.runs.delete('run-1');
    else await h.authorize('status run-1');
    resume.resolve();
    await expect(result).rejects.toBeDefined(); expect(h.effects).toEqual([]);
    expect(log.query({})).toHaveLength(0);
  });
  test('shared transport recovers from an outage without premature effects or a caller retry loop', async () => {
    const h = harness(); const text = 'Stop run-1'; await h.authorize(text);
    let wires = 0; let retries = 0;
    installJudgmentPort(withDecisionLog(createSystemOnePort({
      endpoint: { kind: 'local', baseURL: 'http://127.0.0.1:1', apiKey: 'synthetic-key' },
      model: PINNED_MODEL, timeoutMs: 100, retry: { backoffInitialMs: 1, backoffMaxMs: 1, backoffJitter: 0 },
      fetch: async (_url, init) => {
        wires++; expect(h.effects).toEqual([]);
        if (wires <= 2) return Response.json({}, { status: 503 });
        const body = JSON.parse(String(init?.body)) as { questions: Questions };
        return Response.json({ model: PINNED_MODEL, answers: Object.fromEntries(Object.entries(body.questions).map(([name, question]) =>
          [name, choiceAnswer(question, name === 'action' ? 'cancel' : 'target_0', 0.99)])), usage: { input_tokens: 1, output_tokens: 1 } });
      },
    }), log));
    const command = await h.context.parseSurfaceControlCommand(text, { onRetry: () => { retries++; expect(h.effects).toEqual([]); } });
    expect(wires).toBe(3); expect(retries).toBe(2); expect(log.query({})).toHaveLength(1);
    await h.context.performSurfaceControlCommand(command!); expect(h.effects).toEqual(['cancel:run-1']);
  });
  for (const invalidation of ['policy', 'cancel']) test(`shared retry backoff obeys ${invalidation} without another wire attempt`, async () => {
    const h = harness(); const text = 'Stop run-1'; await h.authorize(text); const abort = new AbortController(); let wires = 0;
    installJudgmentPort(withDecisionLog(createSystemOnePort({
      endpoint: { kind: 'local', baseURL: 'http://127.0.0.1:1', apiKey: 'synthetic-key' },
      model: PINNED_MODEL, timeoutMs: 100, retry: { backoffInitialMs: 1, backoffMaxMs: 1, backoffJitter: 0 },
      fetch: async () => { wires++; return Response.json({}, { status: 503 }); },
    }), log));
    await expect(h.context.parseSurfaceControlCommand(text, { signal: abort.signal,
      onRetry: () => { if (invalidation === 'policy') h.revoke(); else abort.abort(); },
    })).rejects.toBeDefined();
    expect(wires).toBe(1); expect(h.effects).toEqual([]); expect(log.query({})).toHaveLength(0);
  });
  test('replacement of a target after reading cannot execute a stale command', async () => {
    const h = harness(); const text = 'Stop run-1'; await h.authorize(text);
    const command = await h.context.parseSurfaceControlCommand(text);
    h.runs.set('run-1', { id: 'run-1', status: 'running' });
    expect(() => h.context.performSurfaceControlCommand(command!)).toThrow('no longer available'); expect(h.effects).toEqual([]);
  });
  test('revocation after a ready result is checked again at consumption', async () => {
    const h = harness(); const text = 'Stop run-1'; await h.authorize(text);
    const command = await h.context.parseSurfaceControlCommand(text); h.revoke();
    expect(() => h.context.performSurfaceControlCommand(command!)).toThrow('no longer authorized'); expect(h.effects).toEqual([]);
  });
  for (const stop of ['caller', 'shutdown']) test(`${stop} interrupts a provider that ignores cancellation`, async () => {
    const h = harness(); const text = 'Stop run-1'; await h.authorize(text);
    const started = deferred(); const resume = deferred(); const abort = new AbortController();
    pause = async () => { started.resolve(); await resume.promise; };
    const result = h.context.parseSurfaceControlCommand(text, { signal: abort.signal }); await started.promise;
    if (stop === 'caller') abort.abort(); else h.helper.closeDelegatedTelegram();
    await expect(result).rejects.toBeDefined(); expect(h.effects).toEqual([]);
    resume.resolve(); await new Promise(resolve => setTimeout(resolve, 0)); expect(log.query({})).toHaveLength(0);
  });
});

describe('Home Assistant ingress orders source authorization before semantic control reading', () => {
  function ingress(allowed: boolean) {
    const calls: string[] = [];
    const settings: Record<string, unknown> = { 'surfaces.homeassistant.enabled': true, 'surfaces.homeassistant.webhookSecret': 'synthetic-shared-secret' };
    const context = { configManager: { get: (key: string) => settings[key] }, serviceRegistry: { resolveSecret: async () => null },
      authorizeSurfaceIngress: async () => { calls.push('authorize'); return { allowed, reason: 'test-policy' }; },
      parseSurfaceControlCommand: async (_text: string, options?: { beforeAsyncAttempt?: () => Promise<void> }) => {
        calls.push('read'); await options?.beforeAsyncAttempt?.(); return { action: 'cancel', id: 'run-1' };
      },
      performSurfaceControlCommand: async () => { calls.push('execute'); return 'cancelled'; },
    } as unknown as SurfaceAdapterContext;
    const request = (secret = 'synthetic-shared-secret') => new Request('http://daemon.test/webhook/homeassistant', { method: 'POST', headers: { 'content-type': 'application/json', 'x-goodvibes-homeassistant-secret': secret }, body: JSON.stringify({ text: 'Stop run-1' }) });
    return { calls, context, request, settings };
  }
  test('unauthenticated source never reaches policy or reader', async () => {
    const h = ingress(true); expect((await handleHomeAssistantSurfaceWebhook(h.request('wrong'), h.context)).status).toBe(401); expect(h.calls).toEqual([]);
  });
  test('blocked channel never reaches reader or execution', async () => {
    const h = ingress(false); expect((await handleHomeAssistantSurfaceWebhook(h.request(), h.context)).status).toBe(403); expect(h.calls).toEqual(['authorize']);
  });
  test('allowed source awaits control reading after policy', async () => {
    const h = ingress(true); expect((await handleHomeAssistantSurfaceWebhook(h.request(), h.context)).status).toBe(200); expect(h.calls).toEqual(['authorize', 'read', 'execute']);
  });
  test('credential-store changes cancel an active reading and always release its listener', async () => {
    const h = ingress(true); let changed: (() => void) | undefined; let released = 0;
    Object.assign(h.context, { secretsManager: { get: async () => null, getGlobalHome: () => '/synthetic',
      onDidChange: (listener: () => void) => { changed = listener; return () => { released++; changed = undefined; }; },
    }, parseSurfaceControlCommand: async (_text: string, options: { signal: AbortSignal }) => {
      h.calls.push('read'); changed?.(); options.signal.throwIfAborted(); return null;
    } });
    await expect(handleHomeAssistantSurfaceWebhook(h.request(), h.context)).rejects.toBeDefined();
    expect(h.calls).toEqual(['authorize', 'read']); expect(released).toBe(1); expect(changed).toBeUndefined();
  });
  test('secret revocation during reading cannot execute a late result', async () => {
    const h = ingress(true);
    Object.assign(h.context, { parseSurfaceControlCommand: async () => { h.calls.push('read'); h.settings['surfaces.homeassistant.webhookSecret'] = 'replacement'; return { action: 'cancel', id: 'run-1' }; } });
    await expect(handleHomeAssistantSurfaceWebhook(h.request(), h.context)).rejects.toThrow('authorization changed'); expect(h.calls).toEqual(['authorize', 'read']);
  });
});
