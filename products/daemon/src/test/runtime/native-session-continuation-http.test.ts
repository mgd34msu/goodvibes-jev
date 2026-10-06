/** Paired HTTP → real native owner → canonical broker → real Orchestrator/model. */
import { expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { WEBUI_METHOD_ROUTES } from '@goodvibes-jev/engine/contracts/generated/webui-facade';
import { nativeConversationIntakeLookupResultSchema } from '@goodvibes-jev/engine/sdk/platform/workflow/work-ledger/native-intake-client';
import { nativeHostedSessionLookupSchema, nativeHostedTurnLookupSchema, type NativeHostedTurnRequest } from '@goodvibes-jev/engine/sdk/platform/hosted-sessions/native-turn-client';
import { createNativeIntakeHttpFixture, intakeBarrier } from '../helpers/native-intake-http-fixture.js';

const FIRST = '  Initial café e\u0301 🌻\nRemember the first original.  ';
const SECOND = '  Continue café e\u0301 🌻\nKeep this original text.\nKeep this original text.  ';
const ACTIVE = '  Start the active original and wait.  ';
const QUEUED_CANCEL = '  Cancel only this queued original.  ';
const QUEUED_COMPLETE = '  Deliver this queued original in order.  ';
const RUNNING_CANCEL = '  Cancel only this running original.  ';

test('native continuation HTTP reuses the real session, snapshots completed context, queues FIFO and cancels only exact originals', async () => {
  const f = await createNativeIntakeHttpFixture({ route: 'converse' });
  const activeBarrier = intakeBarrier(), cancelBarrier = intakeBarrier();
  type ModelRequest = { messages: { role: string; content: unknown }[]; stream?: boolean };
  const requests: ModelRequest[] = [];
  const lastUser = (body: ModelRequest) => [...body.messages].reverse().find(message => message.role === 'user')?.content;
  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch(request) {
    if (new URL(request.url).pathname === '/v1/models') return Response.json({ data: [{ id: 'continuation-model' }] });
    const body = await request.json() as ModelRequest;
    requests.push(body);
    const text = lastUser(body);
    if (body.stream && text === ACTIVE) await activeBarrier.promise;
    if (body.stream && text === RUNNING_CANCEL) await cancelBarrier.promise;
    const content = `Owned continuation answer: ${String(text)}`;
    if (body.stream) {
      const chunk = (delta: Record<string, unknown>, finish_reason: string | null) => `data: ${JSON.stringify({ id: 'owned-continuation', object: 'chat.completion.chunk', created: 1, model: 'continuation-model', choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
      return new Response(chunk({ role: 'assistant', content }, null) + chunk({}, 'stop') + 'data: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
    }
    return Response.json({ id: 'owned-continuation', object: 'chat.completion', created: 1, model: 'continuation-model', choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
  } });
  type TurnMethod = 'workLedger.turn.start' | 'workLedger.turn.status' | 'workLedger.turn.cancel' | 'workLedger.turn.session';
  async function wire(methodId: TurnMethod, input: unknown, token: string | null = f.paired.token) {
    const route = WEBUI_METHOD_ROUTES[methodId], requestJson = JSON.stringify(input);
    const response = await fetch(`${f.daemon.baseUrl}${route.path}`, { method: route.method,
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json' }, body: requestJson });
    return { methodId, method: route.method, path: route.path, requestBody: input, requestJson, status: response.status, body: await response.text() };
  }
  async function waitFor(check: () => boolean, message: string) {
    const deadline = Date.now() + 15_000;
    while (!check()) { if (Date.now() > deadline) throw new Error(message); await Bun.sleep(20); }
  }
  async function completed(identity: NativeHostedTurnRequest) {
    const deadline = Date.now() + 15_000;
    for (;;) {
      const status = await wire('workLedger.turn.status', identity);
      const result = nativeHostedTurnLookupSchema.parse(JSON.parse(status.body));
      if (!('kind' in result) && result.state === 'completed') return status;
      if (Date.now() > deadline || (!('kind' in result) && result.state === 'recovery-required')) throw new Error(`Native continuation did not complete: ${status.body}`);
      await Bun.sleep(20);
    }
  }
  async function admit(name: string, text: string, sessionId?: string) {
    const input = { requestId: `native-continuation-${name}-request`, inputId: `native-continuation-${name}-input`, text, unsupportedSources: [], ...(sessionId ? { continuation: { sessionId } } : {}) };
    const capture = await f.wire('workLedger.intake.capture', input);
    expect(capture.status, capture.body).toBe(200);
    const captured = nativeConversationIntakeLookupResultSchema.parse(JSON.parse(capture.body));
    if (captured.kind !== 'captured') throw new Error(capture.body);
    const transition = { inputId: input.inputId, sourceRevision: captured.sourceRef.sourceRevision };
    const admission = await f.wire('workLedger.intake.admit', transition);
    expect(admission.status, admission.body).toBe(200);
    const turn = nativeConversationIntakeLookupResultSchema.parse(JSON.parse(admission.body));
    if (turn.kind !== 'turn') throw new Error(admission.body);
    expect(turn.text).toBe(text);
    const identity = { projectId: captured.projectId, ...transition };
    const get = await f.wire('workLedger.intake.get', { inputId: input.inputId });
    expect(get.body).toBe(admission.body);
    const absent = await wire('workLedger.turn.status', identity);
    expect(JSON.parse(absent.body)).toEqual({ kind: 'not-found' });
    return { input, identity, capture, admit: admission, get, absent };
  }
  function snapshot(value: Awaited<ReturnType<typeof wire>>) {
    expect(value.status, value.body).toBe(200);
    const result = nativeHostedTurnLookupSchema.parse(JSON.parse(value.body));
    if ('kind' in result || !result.sessionId || !result.brokerInputId) throw new Error(value.body);
    expect(result.correlationId).toBe(`session-input:${result.brokerInputId}`);
    return result;
  }
  async function attachment(sessionId: string) {
    return f.daemon.invoke<{ session: Record<string, unknown>; history: { role: 'user' | 'assistant' | 'system' | 'tool'; content: string }[] }>('sessions.hosted.attach', { sessionId, clientId: 'owned-continuation-reader' });
  }
  try {
    f.daemon.services.providerRegistry.registerDiscoveredProviders([{ name: 'continuation-wire', host: '127.0.0.1', port: server.port!, baseURL: `http://127.0.0.1:${server.port}/v1`, models: ['continuation-model'], serverType: 'vllm' }]);
    f.daemon.services.configManager.set('provider.model', 'continuation-wire:continuation-model');
    const auth = await f.wire('control.auth.current'), project = await f.wire('workLedger.project');
    const initial = await admit('initial', FIRST);
    const initialStart = await wire('workLedger.turn.start', initial.identity);
    const sessionId = snapshot(initialStart).sessionId!;
    const initialStatus = await completed(initial.identity);
    const initialAttachment = await attachment(sessionId);
    expect(initialAttachment.history).toEqual([{ role: 'user', content: FIRST }, { role: 'assistant', content: `Owned continuation answer: ${FIRST}` }]);
    const discovery = await wire('workLedger.turn.session', { sessionId });
    expect(nativeHostedSessionLookupSchema.parse(JSON.parse(discovery.body))).toEqual({ kind: 'native', projectId: initial.identity.projectId, sessionId, busy: false });
    const legacy = await wire('workLedger.turn.session', { sessionId: 'not-a-native-session' });
    expect(JSON.parse(legacy.body)).toEqual({ kind: 'legacy' });
    const otherOwner = f.daemon.services.pairingTokens.mint({ name: 'Other continuation owner' });
    for (const token of [null, f.daemon.token, otherOwner.token]) {
      const denied = await wire('workLedger.turn.session', { sessionId }, token);
      expect([401, 403]).toContain(denied.status);
      expect(denied.body).not.toContain(initial.identity.projectId);
    }
    const forbiddenCapture = await f.wire('workLedger.intake.capture', { ...initial.input, inputId: 'foreign-continuation', requestId: 'foreign-request', continuation: { sessionId } }, otherOwner.token);
    expect([400, 403, 409, 503]).toContain(forbiddenCapture.status);
    expect(forbiddenCapture.body).not.toContain(FIRST);
    const second = await admit('second', SECOND, sessionId);
    const secondSource = nativeConversationIntakeLookupResultSchema.parse(JSON.parse(second.admit.body));
    if (secondSource.kind !== 'turn' || !secondSource.continuation) throw new Error(second.admit.body);
    expect(secondSource.continuation?.messages).toEqual(initialAttachment.history);
    expect(secondSource.sourceRef.continuation).toEqual({ sessionId, revision: secondSource.continuation.revision });
    const secondStart = await wire('workLedger.turn.start', second.identity);
    expect(snapshot(secondStart).sessionId).toBe(sessionId);
    expect(snapshot(secondStart).brokerInputId).not.toBe(snapshot(initialStart).brokerInputId);
    const secondStatus = await completed(second.identity);
    const secondAttachment = await attachment(sessionId);
    const secondRequest = requests.find(request => request.stream && lastUser(request) === SECOND);
    expect(secondRequest).toBeDefined();
    expect(secondRequest!.messages).toContainEqual({ role: 'user', content: FIRST });
    expect(secondRequest!.messages).toContainEqual({ role: 'assistant', content: `Owned continuation answer: ${FIRST}` });
    expect(secondRequest!.messages.filter(message => message.role === 'user' && message.content === SECOND)).toHaveLength(1);
    expect(secondAttachment.history).toEqual([...initialAttachment.history, { role: 'user', content: SECOND }, { role: 'assistant', content: `Owned continuation answer: ${SECOND}` }]);
    const count = requests.length;
    const secondDuplicate = await wire('workLedger.turn.start', second.identity);
    expect(secondDuplicate.body).toBe(secondStatus.body);
    expect(requests).toHaveLength(count);

    const active = await admit('active', ACTIVE, sessionId);
    const activeStart = await wire('workLedger.turn.start', active.identity);
    await waitFor(() => requests.some(request => request.stream && lastUser(request) === ACTIVE), 'Active original never entered the model');
    const busyDiscovery = await wire('workLedger.turn.session', { sessionId });
    expect(JSON.parse(busyDiscovery.body)).toMatchObject({ kind: 'native', sessionId, busy: true });
    const queuedCancel = await admit('queued-cancel', QUEUED_CANCEL, sessionId);
    const queuedDelivery = await admit('queued-delivery', QUEUED_COMPLETE, sessionId);
    for (const pending of [queuedCancel, queuedDelivery]) {
      const source = nativeConversationIntakeLookupResultSchema.parse(JSON.parse(pending.admit.body));
      if (source.kind !== 'turn') throw new Error(pending.admit.body);
      expect(source.continuation?.messages).toEqual(secondAttachment.history);
      expect(source.continuation?.messages.some(message => message.content.includes(ACTIVE))).toBe(false);
    }
    const queuedCancelStart = await wire('workLedger.turn.start', queuedCancel.identity);
    const queuedStart = await wire('workLedger.turn.start', queuedDelivery.identity);
    expect(snapshot(queuedCancelStart)).toMatchObject({ state: 'queued', sessionId });
    expect(snapshot(queuedStart)).toMatchObject({ state: 'queued', sessionId });
    expect(requests.some(request => lastUser(request) === QUEUED_COMPLETE || lastUser(request) === QUEUED_CANCEL)).toBe(false);
    const queuedCancellation = await wire('workLedger.turn.cancel', queuedCancel.identity);
    expect(snapshot(queuedCancellation)).toMatchObject({ state: 'cancelled', sessionId, brokerInputId: snapshot(queuedCancelStart).brokerInputId });
    expect(snapshot(await wire('workLedger.turn.status', active.identity)).state).toBe('running');
    expect(snapshot(await wire('workLedger.turn.status', queuedDelivery.identity)).state).toBe('queued');
    const queuedCancelledStatus = await wire('workLedger.turn.status', queuedCancel.identity);
    const queuedCancelledDuplicate = await wire('workLedger.turn.start', queuedCancel.identity);
    expect(queuedCancelledDuplicate.body).toBe(queuedCancelledStatus.body);
    activeBarrier.resolve();
    const activeStatus = await completed(active.identity);
    const queuedStatus = await completed(queuedDelivery.identity);
    const queuedAttachment = await attachment(sessionId);
    expect(queuedAttachment.history.some(message => message.content === QUEUED_CANCEL)).toBe(false);
    expect(queuedAttachment.history.filter(message => message.content === QUEUED_COMPLETE)).toHaveLength(1);
    const streamOrder = requests.filter(request => request.stream).map(lastUser);
    expect(streamOrder).toEqual([FIRST, SECOND, ACTIVE, QUEUED_COMPLETE]);
    const stillCaptured = await f.wire('workLedger.intake.get', { inputId: queuedDelivery.input.inputId });
    expect(stillCaptured.body).toBe(queuedDelivery.get.body);

    const runningCancel = await admit('running-cancel', RUNNING_CANCEL, sessionId);
    const runningStart = await wire('workLedger.turn.start', runningCancel.identity);
    await waitFor(() => requests.some(request => request.stream && lastUser(request) === RUNNING_CANCEL), 'Cancellable original never entered the model');
    const runningCancellation = await wire('workLedger.turn.cancel', runningCancel.identity);
    expect(snapshot(runningCancellation)).toMatchObject({ state: 'cancelled', sessionId, brokerInputId: snapshot(runningStart).brokerInputId });
    const runningCancelledStatus = await wire('workLedger.turn.status', runningCancel.identity);
    const runningCancelledDuplicate = await wire('workLedger.turn.start', runningCancel.identity);
    expect(runningCancelledDuplicate.body).toBe(runningCancelledStatus.body);
    expect(snapshot(await wire('workLedger.turn.status', queuedDelivery.identity)).state).toBe('completed');
    const brokerInputs = f.daemon.services.sessionBroker.getInputsSince(sessionId);
    expect(brokerInputs.find(input => input.id === snapshot(queuedCancelStart).brokerInputId)).toMatchObject({ body: QUEUED_CANCEL, state: 'cancelled' });
    expect(brokerInputs.find(input => input.id === snapshot(runningStart).brokerInputId)).toMatchObject({ body: RUNNING_CANCEL, state: 'cancelled' });
    expect(brokerInputs.find(input => input.id === snapshot(queuedStart).brokerInputId)).toMatchObject({ body: QUEUED_COMPLETE, state: 'completed' });
    expect(f.daemon.services.contractRunner.list({ includeTerminal: true })).toHaveLength(0);
    expect(f.daemon.services.agentManager.list()).toHaveLength(0);
    const other = await admit('other', 'A separate native conversation.');
    const otherStart = await wire('workLedger.turn.start', other.identity);
    const otherSessionId = snapshot(otherStart).sessionId!;
    expect(otherSessionId).not.toBe(sessionId);
    const otherStatus = await completed(other.identity);
    const otherAttachment = await attachment(otherSessionId);
    const otherDiscovery = await wire('workLedger.turn.session', { sessionId: otherSessionId });
    const directory = process.env.GOODVIBES_TEST_NATIVE_CONTINUATION_FIXTURE_DIR;
    if (directory) {
      mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, 'lifecycle.json'), JSON.stringify({ source: 'Real paired DaemonServer; actual native Orchestrator; owned loopback streaming model. Every wire body is unchanged Response.text().', auth, project, sessionId, discovery, busyDiscovery, legacy,
        initial: { ...initial, start: initialStart, status: initialStatus, attachment: initialAttachment },
        second: { ...second, start: secondStart, status: secondStatus, duplicate: secondDuplicate, attachment: secondAttachment },
        active: { ...active, start: activeStart, status: activeStatus },
        queuedCancel: { ...queuedCancel, start: queuedCancelStart, cancel: queuedCancellation, status: queuedCancelledStatus, duplicate: queuedCancelledDuplicate },
        queuedDelivery: { ...queuedDelivery, start: queuedStart, status: queuedStatus, attachment: queuedAttachment },
        runningCancel: { ...runningCancel, start: runningStart, cancel: runningCancellation, status: runningCancelledStatus, duplicate: runningCancelledDuplicate },
        other: { ...other, start: otherStart, status: otherStatus, attachment: otherAttachment, discovery: otherDiscovery },
        modelObservation: 'Original user/assistant message objects selected from the actual streamed second model request; unrelated system and tool definitions omitted.',
        modelRequests: requests.filter(request => request.stream && lastUser(request) === SECOND).map(request => ({ stream: request.stream, messages: request.messages.filter(message => message.role === 'user' || message.role === 'assistant') })),
      }, null, 2) + '\n');
    }
  } finally { activeBarrier.resolve(); cancelBarrier.resolve(); await f.stop(); server.stop(true); }
}, 90_000);
