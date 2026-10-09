import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, readlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { sessionEventDecoder, syntheticSystemOneAnswers } from './hosted-session-protocol.mjs';

const pause = () => new Promise(resolve => setTimeout(resolve, 20));
async function until(check, label, milliseconds = 20_000) {
  const deadline = Date.now() + milliseconds;
  for (;;) { const result = await check(); if (result) return result;
    assert(Date.now() < deadline, `${label}: deadline exceeded`); await pause(); }
}
const writeJson = (path, value) => writeFileSync(path, JSON.stringify(value));
async function listen(server) {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return server.address().port;
}
async function close(server) {
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
}

/** Consumer of the unchanged production artifact, not a fixture launcher.
 * All providers below are owned synthetic HTTP peers. This is transport and
 * lifecycle evidence, never evidence of live Jev semantic calibration.
 */
export async function runHostedSessionProof({ binary, boundary, env, root }) {
  const startedAt = Date.now();
  const owned = join(root, 'hosted-proof');
  const home = join(owned, 'home'), tree = join(owned, 'tree'), daemon = join(owned, 'daemon'), work = join(owned, 'work');
  for (const directory of [home, tree, daemon, work, join(tree, '.goodvibes/tui')]) mkdirSync(directory, { recursive: true });
  const token = `synthetic-hosted-${randomUUID()}`;
  const marker = `owned-native-answer-${randomUUID()}`;
  const original = `Original café e\u0301 🌻\n${randomUUID()}\n  Preserve this indentation.\nPreserve this line.`;
  const modelRequests = [], judgmentRequests = [], events = [];
  const held = new Set();
  let peerError;
  const peer = handle => createServer((request, response) => {
    void handle(request, response).catch(error => {
      peerError = error;
      if (!response.headersSent) response.writeHead(500);
      response.end('owned synthetic peer failed');
    });
  });
  async function readBody(request) {
    let text = '';
    for await (const chunk of request) {
      text += chunk;
      assert(text.length < 1_048_576, 'Synthetic HTTP request exceeded its bound');
    }
    return JSON.parse(text);
  }
  const model = peer(async (request, response) => {
    if (request.url === '/v1/models') { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ data: [{ id: 'owned-model' }] })); return; }
    const body = await readBody(request);
    assert(modelRequests.length < 20, 'Unexpected model replay/request loop');
    modelRequests.push(body);
    if (request.url !== '/v1/chat/completions') { response.writeHead(404); response.end(); return; }
    const lastUser = body.messages.filter(message => message.role === 'user').at(-1)?.content;
    if (lastUser === 'owned-failure') { response.writeHead(400, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ error: { message: 'owned synthetic terminal failure', type: 'invalid_request_error' } })); return; }
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const chunk = (content, finish_reason = null) => `data: ${JSON.stringify({ id: 'owned-stream', object: 'chat.completion.chunk', created: 1, model: 'owned-model', choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason }] })}\n\n`;
    response.write(chunk(lastUser === 'owned-cancel' || lastUser === 'owned-shutdown' ? 'owned partial' : marker.slice(0, 12)));
    if (lastUser === 'owned-cancel' || lastUser === 'owned-shutdown') {
      held.add(response); response.once('close', () => held.delete(response)); return;
    }
    // Separate writes prove streamed transport rather than a JSON completion.
    setTimeout(() => { if (!response.destroyed) response.end(chunk(marker.slice(12)) + chunk('', 'stop') + 'data: [DONE]\n\n'); }, 40);
  });
  const judgment = peer(async (request, response) => {
    const body = await readBody(request);
    assert(judgmentRequests.length < 5_000, 'Unexpected SystemOne request loop');
    judgmentRequests.push({ path: request.url, authorization: request.headers.authorization, body });
    const answers = syntheticSystemOneAnswers(body.questions);
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ model: body.model, answers, usage: { input_tokens: 1, output_tokens: 1 } }));
  });
  let host, stopped, childPid, exited = true, output = '', errors = '';
  const streams = [];
  const readers = [];
  let streamError;
  try {
    const modelPort = await listen(model), judgmentPort = await listen(judgment);
    writeJson(join(tree, '.goodvibes/tui/discovered-providers.json'), [{ name: 'owned-native', host: '127.0.0.1', port: modelPort, baseURL: `http://127.0.0.1:${modelPort}/v1`, models: ['owned-model'], serverType: 'vllm' }]);
    writeJson(join(daemon, 'settings.json'), { cluster: { enabled: false }, relay: { enabled: false }, provider: { model: 'owned-native:owned-model' } });
    const lease = createServer(); const port = await listen(lease); await close(lease);
    const base = `http://127.0.0.1:${port}`;
    async function request(path, body, credential = token) {
      assert.ifError(peerError);
      const response = await fetch(base + path, { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${credential}`, 'Content-Type': 'application/json', Connection: 'close' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10_000) });
      const text = await response.text(); return { status: response.status, value: text ? JSON.parse(text) : null };
    }
    async function invoke(method, body) {
      const result = await request(`/api/control-plane/methods/${method}/invoke`, { body });
      assert.equal(result.status, 200, `${method}: ${JSON.stringify(result.value)}`); return result.value;
    }
    async function start() {
      output = ''; errors = ''; childPid = undefined; exited = false;
      host = spawn('bwrap', [...boundary.slice(0, -1), '--as-pid-1', '--json-status-fd', '3', '--', binary, 'serve', '--hostname', '127.0.0.1', '--port', String(port)], {
        env: { ...env, HOME: home, GOODVIBES_HOME: tree, GOODVIBES_DAEMON_HOME: daemon, GOODVIBES_WORKING_DIR: work, GOODVIBES_DAEMON_TOKEN: token,
          TYPESAFE_BASE_URL: `http://127.0.0.1:${judgmentPort}`, TYPESAFE_API_KEY: 'synthetic-system-one-key', TYPESAFE_DEFAULT_MODEL: 'jev-1.13.0' },
        stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
      });
      let statusBuffer = '';
      host.stdio[3].on('data', data => {
        try {
          statusBuffer += data;
          assert(statusBuffer.length < 65_536, 'Namespace status buffer exceeded its bound');
          let end;
          while ((end = statusBuffer.indexOf('\n')) !== -1) {
            const status = JSON.parse(statusBuffer.slice(0, end));
            statusBuffer = statusBuffer.slice(end + 1);
            if (Number.isSafeInteger(status['child-pid']) && status['child-pid'] > 0) childPid = status['child-pid'];
          }
        } catch (error) { peerError = error; host.kill('SIGKILL'); }
      });
      // Keep bounded diagnostic tails, never unbounded daemon output.
      host.stdout.on('data', data => { output = (output + data).slice(-65_536); });
      host.stderr.on('data', data => { errors = (errors + data).slice(-65_536); });
      stopped = new Promise((resolve, reject) => { host.once('error', reject); host.once('close', (code, signal) => { exited = true; resolve({ code, signal }); }); });
      void stopped.catch(() => {});
      await until(() => { assert(!exited, `host exited: ${output} ${errors}`); return output.includes('host started') && childPid; }, 'host startup');
    }
    async function shutdown() {
      assert.equal(readlinkSync(`/proc/${childPid}/exe`), binary);
      process.kill(childPid, 'SIGTERM'); await until(() => exited, 'host graceful shutdown', 15_000);
      assert.deepEqual(await stopped, { code: 0, signal: null }, errors);
      await assert.rejects(fetch(`${base}/api/channels/inbox`, { signal: AbortSignal.timeout(1_000) }));
      host.stdout.destroy(); host.stderr.destroy(); host.stdio[3].destroy();
    }
    async function attach(sessionId, clientId = 'owned-reader') { return invoke('sessions.hosted.attach', { sessionId, clientId }); }
    async function watch(sessionId) {
      const controller = new AbortController(); streams.push(controller);
      const headerDeadline = setTimeout(() => controller.abort(new Error('Session event headers deadline exceeded')), 5_000);
      let response;
      try {
        response = await fetch(`${base}/api/sessions/${sessionId}/events`, { headers: { Authorization: `Bearer ${token}` }, signal: controller.signal });
        assert.equal(response.status, 200);
      } finally { clearTimeout(headerDeadline); }
      const decode = sessionEventDecoder(value => {
        assert(events.length < 10_000, 'Session event count exceeded its bound');
        events.push({ sessionId, value });
      });
      const reading = (async () => { for await (const bytes of response.body) decode(bytes); })();
      readers.push(reading.catch(error => { if (!controller.signal.aborted) streamError = error; }));
      return controller;
    }
    await start();
    const wrong = await request('/api/control-plane/methods/sessions.hosted.create/invoke', { body: { workspaceRoot: work } }, 'wrong-owned-token');
    assert.equal(wrong.status, 401); assert.equal(modelRequests.length, 0);
    for (const [path, body] of [
      ['/api/control-plane/methods/sessions.hosted.attach/invoke', { body: { sessionId: 'not-an-owned-session', clientId: 'wrong-reader' } }],
      ['/api/sessions/not-an-owned-session/follow-up', { body: 'must not dispatch' }],
      ['/api/sessions/not-an-owned-session/turns/cancel', { expectedTurnId: 'must-not-cancel' }],
    ]) assert.equal((await request(path, body, 'wrong-owned-token')).status, 401);
    const killPolicy = await invoke('sessions.hosted.create', { workspaceRoot: work, clientId: 'kill-reader', modelId: 'owned-native:owned-model', detachPolicy: 'kill' });
    const killed = await invoke('sessions.hosted.detach', { sessionId: killPolicy.session.id, clientId: 'kill-reader' });
    assert.equal(killed.session.status, 'terminated'); assert.equal(killed.session.terminatedReason, 'detached');
    assert.equal(modelRequests.length, 0, 'lifecycle-only create/attach/detach must not dispatch a model');
    const created = await invoke('sessions.hosted.create', { workspaceRoot: work, clientId: 'owned-reader', modelId: 'owned-native:owned-model', detachPolicy: 'survive' });
    const sessionId = created.session.id;
    assert.equal((await attach(sessionId)).session.id, sessionId);
    await watch(sessionId);
    const sent = await request(`/api/sessions/${sessionId}/follow-up`, { body: original });
    assert.equal(sent.status, 202, JSON.stringify(sent));
    await until(async () => { const value = await attach(sessionId); return value.session.status === 'idle' && value.history.some(message => message.role === 'assistant' && message.content.includes(marker)) && value; }, 'completed assistant history');
    assert(modelRequests.some(value => value.stream === true && value.messages.some(message => message.role === 'user' && message.content === original)), 'original user text must reach real streaming model HTTP');
    const detached = await invoke('sessions.hosted.detach', { sessionId, clientId: 'owned-reader' });
    assert.equal(detached.session.status, 'idle'); assert.deepEqual(detached.session.attachedClients, []);
    const attached = await attach(sessionId); assert(attached.history.some(message => message.role === 'user' && message.content === original));
    assert(attached.history.some(message => message.role === 'assistant' && message.content.includes(marker)));
    const turnEvents = () => { if (streamError) throw streamError; return events.filter(event => event.value.sessionId === sessionId && event.value.payload).map(event => event.value.payload); };
    const complete = await until(() => turnEvents().find(event => event.type === 'TURN_COMPLETED'), 'successful terminal event');
    const deltas = turnEvents().filter(event => event.type === 'STREAM_DELTA' && event.turnId === complete.turnId);
    assert(deltas.length >= 2); assert.equal(deltas.map(event => event.content).join(''), marker);
    assert(judgmentRequests.length > 0, 'production SystemOne configuration must reach the synthetic peer');
    assert(judgmentRequests.every(request => request.path === '/v1/systemone' && request.authorization === 'Bearer synthetic-system-one-key' && request.body.model === 'jev-1.13.0'));
    async function send(text) {
      const response = await request(`/api/sessions/${sessionId}/follow-up`, { body: text });
      assert.equal(response.status, 202, JSON.stringify(response));
      return until(() => turnEvents().find(event => event.type === 'TURN_SUBMITTED' && event.prompt === text), `turn submitted: ${text}`);
    }
    const cancelled = await send('owned-cancel');
    await until(() => held.size === 1, 'cancel model stream entered');
    const cancellation = await request(`/api/sessions/${sessionId}/turns/cancel`, { expectedTurnId: cancelled.turnId });
    assert.equal(cancellation.status, 200, JSON.stringify(cancellation));
    assert.equal(cancellation.value.status, 'cancellation-requested');
    await until(() => turnEvents().find(event => event.type === 'TURN_CANCEL' && event.turnId === cancelled.turnId), 'cancel terminal event');
    await until(() => held.size === 0, 'cancelled provider socket closes');
    const failed = await send('owned-failure');
    await until(() => turnEvents().find(event => event.type === 'TURN_ERROR' && event.turnId === failed.turnId), 'failed turn terminal event');
    await until(async () => (await attach(sessionId)).session.status === 'idle', 'failed session remains attachable');
    assert(!turnEvents().some(event => event.type === 'TURN_COMPLETED' && [failed.turnId, cancelled.turnId].includes(event.turnId)), 'failure/cancel must not claim success');

    for (const controller of streams) controller.abort();
    const beforeRestart = modelRequests.length;
    await shutdown(); await start();
    const restoredList = await invoke('sessions.hosted.list', {});
    assert(restoredList.sessions.find(session => session.id === sessionId)?.restoredFromDisk);
    const restored = await attach(sessionId);
    assert.equal(restored.session.id, sessionId); assert(restored.history.some(message => message.role === 'user' && message.content === original));
    assert(restored.history.some(message => message.role === 'assistant' && message.content.includes(marker)));
    assert.equal(modelRequests.length, beforeRestart, 'reattachment must not replay a completed turn');
    await watch(sessionId);
    await send('owned-shutdown');
    await until(() => held.size === 1, 'shutdown model stream entered');
    for (const controller of streams) controller.abort();
    await shutdown();
    await until(() => held.size === 0, 'shutdown cancels owned provider socket');
    assert.equal(modelRequests.length, 4, 'one model request per success, cancel, failure, and shutdown turn');
    await Promise.all(readers);
    assert.ifError(peerError); assert.ifError(streamError);
    assert(judgmentRequests.every(request => request.path === '/v1/systemone' && request.authorization === 'Bearer synthetic-system-one-key' && request.body.model === 'jev-1.13.0'));
    const identities = new Map();
    const questionGroups = new Map();
    for (const request of judgmentRequests) {
      const identity = createHash('sha256').update(JSON.stringify(request.body)).digest('hex');
      identities.set(identity, (identities.get(identity) ?? 0) + 1);
      const group = [request.body.state?.provider && request.body.state?.model_id ? 'provider-catalog' : 'turn', ...Object.keys(request.body.questions).sort()].join(':');
      questionGroups.set(group, (questionGroups.get(group) ?? 0) + 1);
    }
    assert([...identities.values()].every(count => count <= 2), 'No SystemOne request identity may exceed the two daemon boots');
    const identityCounts = {};
    for (const count of identities.values()) identityCounts[count] = (identityCounts[count] ?? 0) + 1;
    return { elapsedMs: Date.now() - startedAt, judgmentQuestionGroups: Object.fromEntries(questionGroups), judgmentUniqueIdentities: identities.size, judgmentRequestsPerIdentity: identityCounts,
      evidence: 'synthetic-http-protocol-only; not live Jev calibration', modelRequests: modelRequests.length, judgmentRequests: judgmentRequests.length, streamedDeltas: deltas.length, restartHistoryPreserved: true, cancellationSettled: true, failureObserved: true, shutdownDuringStream: true };
  } catch (error) {
    console.error('HOSTED FAILURE DETAILS', JSON.stringify({ output, errors, modelRequests: modelRequests.length, judgmentRequests: judgmentRequests.length, events: events.filter(event => event.value.type).map(event => event.value) })); throw error;
  } finally {
    for (const controller of streams) controller.abort();
    if (!exited) host.kill('SIGKILL');
    if (stopped) {
      try { await stopped; }
      finally { host.stdout.destroy(); host.stderr.destroy(); host.stdio[3].destroy(); }
    }
    await Promise.all(readers);
    for (const response of held) response.destroy();
    await close(model); await close(judgment);
  }
}
