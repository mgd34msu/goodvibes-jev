/** Actual paired HTTP -> canonical broker -> real hosted runtime -> owned loopback model. */
import { expect, spyOn, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { WEBUI_METHOD_ROUTES } from '@goodvibes-jev/engine/contracts/generated/webui-facade';
import { nativeConversationIntakeLookupResultSchema } from '@goodvibes-jev/engine/sdk/platform/workflow/work-ledger/native-intake-client';
import { nativeHostedTurnLookupSchema } from '@goodvibes-jev/engine/sdk/platform/hosted-sessions/native-turn-client';
import { createNativeIntakeHttpFixture } from '../helpers/native-intake-http-fixture.js';
const TEXT = '  Explain café e\u0301 🌻\nKeep this original text.\nKeep this original text.  ';

test('paired native hosted HTTP preserves canonical identity, finishes a real turn and never replays on inspection', async () => {
  const f = await createNativeIntakeHttpFixture({ route: 'converse' });
  const requests: { messages: { role: string; content: unknown }[]; stream?: boolean }[] = [];
  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch(request) {
    if (new URL(request.url).pathname === '/v1/models') return Response.json({ data: [{ id: 'native-model' }] });
    const body = await request.json() as (typeof requests)[number]; requests.push(body);
    const content = 'Owned native hosted answer.';
    if (body.stream) {
      const chunk = (delta: Record<string, unknown>, finish_reason: string | null) => `data: ${JSON.stringify({ id: 'owned-native-hosted', object: 'chat.completion.chunk', created: 1, model: 'native-model', choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
      return new Response(chunk({ role: 'assistant', content }, null) + chunk({}, 'stop') + 'data: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
    }
    return Response.json({ id: 'owned-native-hosted', object: 'chat.completion', created: 1, model: 'native-model', choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
  } });
  async function wire(methodId: 'workLedger.turn.start' | 'workLedger.turn.status' | 'workLedger.turn.cancel', input: unknown, token = f.paired.token) {
    const route = WEBUI_METHOD_ROUTES[methodId], requestJson = JSON.stringify(input);
    const response = await fetch(`${f.daemon.baseUrl}${route.path}`, { method: route.method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: requestJson });
    return { methodId, method: route.method, path: route.path, requestBody: input, requestJson, status: response.status, body: await response.text() };
  }
  try {
    f.daemon.services.providerRegistry.registerDiscoveredProviders([{ name: 'native-hosted-wire', host: '127.0.0.1', port: server.port!, baseURL: `http://127.0.0.1:${server.port}/v1`, models: ['native-model'], serverType: 'vllm' }]);
    f.daemon.services.configManager.set('provider.model', 'native-hosted-wire:native-model');
    const input = { requestId: 'native-hosted-http-request', inputId: 'native-hosted-http-input', text: TEXT, unsupportedSources: [] };
    const auth = await f.wire('control.auth.current'), project = await f.wire('workLedger.project');
    const capture = await f.wire('workLedger.intake.capture', input);
    const captured = nativeConversationIntakeLookupResultSchema.parse(JSON.parse(capture.body));
    if (captured.kind !== 'captured') throw new Error(capture.body);
    const transition = { inputId: input.inputId, sourceRevision: captured.sourceRef.sourceRevision };
    const admit = await f.wire('workLedger.intake.admit', transition);
    const admitted = nativeConversationIntakeLookupResultSchema.parse(JSON.parse(admit.body));
    expect(admitted.kind).toBe('turn'); expect(requests).toHaveLength(0);
    const get = await f.wire('workLedger.intake.get', { inputId: input.inputId });
    expect(get.body).toBe(admit.body);
    const identity = { projectId: captured.projectId, ...transition };
    const absent = await wire('workLedger.turn.status', identity);
    expect(absent.status, absent.body).toBe(200);
    expect(nativeHostedTurnLookupSchema.parse(JSON.parse(absent.body))).toEqual({ kind: 'not-found' });
    const shared = await wire('workLedger.turn.start', identity, f.daemon.token);
    expect(shared.status).toBe(403); expect(requests).toHaveLength(0);
    const login = await fetch(`${f.daemon.baseUrl}/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'admin' }) });
    expect(login.status).toBe(200);
    const user = await login.json() as { token: string };
    for (const operation of ['start', 'status', 'cancel'] as const) {
      expect((await wire(`workLedger.turn.${operation}`, identity, user.token)).status).toBe(403);
    }
    const catalog = f.daemon.services.gatewayMethods, getScopes = catalog.getAllScopes.bind(catalog);
    for (const missing of ['read:work-ledger', 'write:work-ledger', 'write:sessions']) {
      const grant = spyOn(catalog, 'getAllScopes').mockImplementation(options => getScopes(options).filter(scope => scope !== missing));
      try {
        for (const operation of ['start', 'status', 'cancel'] as const) expect((await wire(`workLedger.turn.${operation}`, identity)).status).toBe(403);
      } finally { grant.mockRestore(); }
    }
    expect(requests).toHaveLength(0);
    const bad = await wire('workLedger.turn.start', { ...identity, text: 'replacement', permit: {} });
    expect(bad.status).toBe(400); expect(requests).toHaveLength(0);
    const start = await wire('workLedger.turn.start', identity);
    expect(start.status, start.body).toBe(200);
    const running = nativeHostedTurnLookupSchema.parse(JSON.parse(start.body));
    expect(running).toMatchObject({ state: 'running', inputId: input.inputId });
    if ('kind' in running || !running.sessionId || !running.brokerInputId) throw new Error(start.body);
    expect(running.sessionId).not.toBe(captured.sourceRef.sessionId);
    expect(running.correlationId).toBe(`session-input:${running.brokerInputId}`);
    const broker = f.daemon.services.sessionBroker.getInputsSince(running.sessionId).find(value => value.id === running.brokerInputId);
    expect(broker?.body).toBe(TEXT);
    const deadline = Date.now() + 10_000;
    let status = await wire('workLedger.turn.status', identity);
    for (;;) {
      const observed = nativeHostedTurnLookupSchema.parse(JSON.parse(status.body));
      if (!('kind' in observed) && observed.state === 'completed') break;
      if (Date.now() > deadline || (!('kind' in observed) && observed.state === 'recovery-required')) throw new Error(`Turn did not complete: ${status.body}; requests=${JSON.stringify(requests)}`);
      await new Promise(resolve => setTimeout(resolve, 20)); status = await wire('workLedger.turn.status', identity);
    }
    expect(requests.some(request => request.stream && request.messages.some(message => message.role === 'user' && message.content === TEXT))).toBe(true);
    const count = requests.length;
    const duplicate = await wire('workLedger.turn.start', identity);
    expect(duplicate.body).toBe(status.body); expect(requests).toHaveLength(count);
    const attachment = await f.daemon.invoke<{ history: { role: string; content: string }[] }>('sessions.hosted.attach', { sessionId: running.sessionId, clientId: 'owned-native-reader' });
    expect(attachment.history).toContainEqual({ role: 'user', content: TEXT });
    expect(attachment.history.some(message => message.role === 'assistant' && message.content.includes('Owned native hosted answer.'))).toBe(true);
    expect(f.daemon.services.contractRunner.list({ includeTerminal: true })).toHaveLength(0);
    expect(f.daemon.services.agentManager.list()).toHaveLength(0);
    const cancelledInput = { ...input, requestId: 'native-hosted-cancel-request', inputId: 'native-hosted-cancel-input' };
    const cancelledCapture = await f.wire('workLedger.intake.capture', cancelledInput);
    const cancelledSource = nativeConversationIntakeLookupResultSchema.parse(JSON.parse(cancelledCapture.body));
    if (cancelledSource.kind !== 'captured') throw new Error(cancelledCapture.body);
    const cancelledTransition = { inputId: cancelledInput.inputId, sourceRevision: cancelledSource.sourceRef.sourceRevision };
    const cancelledAdmit = await f.wire('workLedger.intake.admit', cancelledTransition);
    const cancelledGet = await f.wire('workLedger.intake.get', { inputId: cancelledInput.inputId });
    expect(cancelledGet.body).toBe(cancelledAdmit.body);
    const cancelledIdentity = { projectId: cancelledSource.projectId, ...cancelledTransition };
    const cancelledAbsent = await wire('workLedger.turn.status', cancelledIdentity);
    const cancellation = await wire('workLedger.turn.cancel', cancelledIdentity);
    expect(cancellation.status, cancellation.body).toBe(200);
    expect(JSON.parse(cancellation.body)).toMatchObject({ state: 'cancelled', sessionId: null, brokerInputId: null });
    const cancelledStatus = await wire('workLedger.turn.status', cancelledIdentity);
    expect(cancelledStatus.body).toBe(cancellation.body);
    const prevented = await wire('workLedger.turn.start', cancelledIdentity);
    expect(prevented.body).toBe(cancellation.body); expect(requests).toHaveLength(count);
    const directory = process.env.GOODVIBES_TEST_NATIVE_HOSTED_FIXTURE_DIR;
    if (directory) { mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, 'cancelled.json'), JSON.stringify({ source: 'owned loopback model; real paired DaemonServer cancellation-before-dispatch', input: cancelledInput, identity: cancelledIdentity, auth, project, capture: cancelledCapture, admit: cancelledAdmit, get: cancelledGet, absent: cancelledAbsent, cancel: cancellation, status: cancelledStatus, start: prevented }, null, 2) + '\n');
      writeFileSync(join(directory, 'completed.json'), JSON.stringify({ source: 'owned loopback model; real paired DaemonServer hosted delivery', input, identity, auth, project, capture, admit, get, absent, start, status, duplicate, attachment }, null, 2) + '\n'); }
  } finally { await f.stop(); server.stop(true); }
}, 40_000);
