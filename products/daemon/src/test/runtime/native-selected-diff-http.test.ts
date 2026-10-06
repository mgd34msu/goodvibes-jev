/** Real checkpoints + paired intake + production work and hosted-turn owners. */
import { expect, spyOn, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { WEBUI_METHOD_ROUTES } from '@goodvibes-jev/engine/contracts/generated/webui-facade';
import { nativeConversationIntakeLookupResultSchema, nativeSelectedDiffRevision, selectNativeDiffHunk, type NativeConversationIntakeCaptureRequest, type NativeSelectedDiffSelector } from '@goodvibes-jev/engine/sdk/platform/workflow/work-ledger/native-intake-client';
import { nativeHostedTurnLookupSchema } from '@goodvibes-jev/engine/sdk/platform/hosted-sessions/native-turn-client';
import { nativeWorkExecutionSnapshotSchema } from '@goodvibes-jev/engine/sdk/platform/workflow/work-ledger/native-execution-client';
import { createNativeIntakeExecutionHttpFixture } from '../helpers/native-intake-execution-http-fixture.js';
import { intakeBarrier } from '../helpers/native-intake-http-fixture.js';

const COMMENT = '  Explain this selected change. 🌻\nKeep the exact comment.\nKeep the exact comment.  ';
const WORK = '  Answer this request yourself without delegation. 🌻\nExplain the selected workspace change.\nExplain the selected workspace change.  ';
const QUEUED_DELIVERY = '  Explain this queued selected change after the running original. 🌻\nKeep this exact queued comment.  ';
const ACTIVE = 'Keep this original running while another selected comment is queued.';

test('selected native diff stays exact host evidence through capture, changed workspace, admission, execution, FIFO, cancellation and recovery', async () => {
  const f = await createNativeIntakeExecutionHttpFixture();
  await f.scopes.add(f.daemon.workingDirectory, { checkpointEligible: true });
  f.controls.route = 'converse';
  const activeBarrier = intakeBarrier();
  type ModelRequest = { messages: { role: string; content: unknown }[]; stream?: boolean };
  const requests: ModelRequest[] = [];
  const lastUser = (body: ModelRequest) => [...body.messages].reverse().find(message => message.role === 'user')?.content;
  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch(request) {
    if (new URL(request.url).pathname === '/v1/models') return Response.json({ data: [{ id: 'selected-diff-model' }] });
    const body = await request.json() as ModelRequest;
    requests.push(body);
    if (body.stream && lastUser(body) === ACTIVE) await activeBarrier.promise;
    const content = `Owned selected diff answer: ${String(lastUser(body))}`;
    if (body.stream) {
      const chunk = (delta: Record<string, unknown>, finish_reason: string | null) => `data: ${JSON.stringify({ id: 'owned-selected-diff', object: 'chat.completion.chunk', created: 1, model: 'selected-diff-model', choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
      return new Response(chunk({ role: 'assistant', content }, null) + chunk({}, 'stop') + 'data: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
    }
    return Response.json({ id: 'owned-selected-diff', object: 'chat.completion', created: 1, model: 'selected-diff-model', choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
  } });
  async function wire(methodId: string, input?: unknown, token: string | null = f.paired.token) {
    const rest = WEBUI_METHOD_ROUTES[methodId];
    const route = rest && !rest.path.includes('{') ? rest : { method: 'POST', path: `/api/control-plane/methods/${methodId}/invoke` };
    const requestJson = input === undefined ? undefined : JSON.stringify(route === rest ? input : { body: input });
    const response = await fetch(`${f.daemon.baseUrl}${route.path}`, { method: route.method,
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(requestJson === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(requestJson === undefined ? {} : { body: requestJson }) });
    return { methodId, method: route.method, path: route.path, ...(input === undefined ? {} : { requestBody: input, requestJson }), status: response.status, body: await response.text() };
  }
  type Wire = Awaited<ReturnType<typeof wire>>;
  const body = (value: Wire) => { expect(value.status, value.body).toBe(200); return JSON.parse(value.body); };
  const intake = (value: Wire) => nativeConversationIntakeLookupResultSchema.parse(body(value));
  const turn = (value: Wire) => { const parsed = nativeHostedTurnLookupSchema.parse(body(value)); if ('kind' in parsed) throw new Error(value.body); return parsed; };
  async function waitFor<T>(read: () => Promise<T>, ready: (value: T) => boolean) {
    const end = Date.now() + 20_000;
    for (;;) { const value = await read(); if (ready(value)) return value; if (Date.now() >= end) throw new Error(`Selected diff operation timed out: ${JSON.stringify(value)}`); await Bun.sleep(20); }
  }
  let sessionId: string = '';
  function command(name: string, text: string, selectedDiff?: NativeSelectedDiffSelector): NativeConversationIntakeCaptureRequest {
    return { requestId: `selected-diff-${name}-request`, inputId: `selected-diff-${name}-input`, text, unsupportedSources: [], ...(sessionId ? { continuation: { sessionId, ...(selectedDiff ? { selectedDiff } : {}) } } : {}) };
  }
  async function captureAndAdmit(input: NativeConversationIntakeCaptureRequest, previousCapture?: Wire) {
    const capture = previousCapture ?? await wire('workLedger.intake.capture', input);
    const captured = intake(capture); if (captured.kind !== 'captured') throw new Error(capture.body);
    const transition = { inputId: input.inputId, sourceRevision: captured.sourceRef.sourceRevision };
    const admit = await wire('workLedger.intake.admit', transition);
    if (admit.status !== 200) throw new Error(`Admission ${input.inputId}: ${admit.body}; stored: ${(await wire('workLedger.intake.get', { inputId: input.inputId })).body}; model: ${JSON.stringify(f.daemon.services.providerRegistry.getCurrentModel())}; provider requests: ${f.requests.length}`);
    const result = intake(admit);
    const get = await wire('workLedger.intake.get', { inputId: input.inputId }); expect(get.body).toBe(admit.body);
    const identity = { projectId: captured.projectId, ...transition };
    return { command: input, capture, admit, get, identity, result };
  }
  async function dispatch(value: Awaited<ReturnType<typeof captureAndAdmit>>) {
    const absent = await wire('workLedger.turn.status', value.identity); expect(body(absent)).toEqual({ kind: 'not-found' });
    const start = await wire('workLedger.turn.start', value.identity); expect(turn(start).sessionId).toBe(sessionId);
    const status = await waitFor(() => wire('workLedger.turn.status', value.identity), value => turn(value).state === 'completed');
    return { ...value, absent, start, status };
  }
  let restoreJudgment: (() => void) | undefined;
  let restarted: Awaited<ReturnType<typeof createNativeIntakeExecutionHttpFixture>> | undefined;
  try {
    f.daemon.services.providerRegistry.registerDiscoveredProviders([{ name: 'selected-diff-wire', host: '127.0.0.1', port: server.port!, baseURL: `http://127.0.0.1:${server.port}/v1`, models: ['selected-diff-model'], serverType: 'vllm' }]);
    f.daemon.services.configManager.set('provider.model', 'selected-diff-wire:selected-diff-model');
    const auth = await wire('control.auth.current'), project = await wire('workLedger.project');
    const first = await captureAndAdmit(command('initial', 'Remember this completed conversation before reviewing the changes.'));
    const initialStart = await wire('workLedger.turn.start', first.identity);
    sessionId = turn(initialStart).sessionId!;
    const initialStatus = await waitFor(() => wire('workLedger.turn.status', first.identity), value => turn(value).state === 'completed');
    const sessionList = await wire('sessions.list');
    const sessionRow = body(sessionList).sessions.find((row: { id: string }) => row.id === sessionId);
    expect(sessionRow).toMatchObject({ id: sessionId, kind: 'hosted', project: f.daemon.workingDirectory, status: 'active' });
    const sharedSession = await wire('sessions.get', { sessionId });
    // Heartbeats may advance timestamps between reads; identity and source kind remain exact.
    const sharedIdentity = { id: sessionRow.id, kind: sessionRow.kind, project: sessionRow.project, title: sessionRow.title, status: sessionRow.status };
    expect(body(sharedSession).session).toMatchObject(sharedIdentity);
    expect(f.daemon.services.sessionBroker.getSession(sessionId)).toMatchObject(sharedIdentity);
    const attachment = await wire('sessions.hosted.attach', { sessionId, clientId: 'selected-diff-proof' }); body(attachment);
    const discovery = await wire('workLedger.turn.session', { sessionId }); expect(body(discovery)).toMatchObject({ kind: 'native', sessionId });
    const legacy = await wire('workLedger.turn.session', { sessionId: 'selected-diff-legacy' }); expect(body(legacy)).toEqual({ kind: 'legacy' });
    const file = join(f.daemon.workingDirectory, 'selected-change.ts');
    writeFileSync(file, Array.from({ length: 160 }, (_, index) => `original line ${index}\n`).join(''));
    const baseline = body(await wire('checkpoints.create', { kind: 'manual', label: 'Selected diff baseline' })).checkpoint;
    expect(baseline.id).toBeString();
    writeFileSync(file, Array.from({ length: 160 }, (_, index) => index === 0 ? '++ header-looking hunk body\n' : index < 80 || index > 150 ? `session changed line ${index} 🌻\n` : `original line ${index}\n`).join(''));
    const stamped = body(await wire('checkpoints.create', { kind: 'manual', label: 'Session-stamped selected change', sessionId })).checkpoint;
    const sessionDiff = await wire('sessions.changes.get', { sessionId });
    const actualSession = body(sessionDiff);
    expect(actualSession.nativeRevision).toBe(await nativeSelectedDiffRevision(actualSession.unifiedDiff));
    const fileIndex = actualSession.unifiedDiff.split(/(?=^diff --git )/m).filter(Boolean).findIndex((part: string) => part.startsWith('diff --git a/selected-change.ts b/selected-change.ts\n'));
    expect(fileIndex).toBeGreaterThanOrEqual(0);
    const sessionSelector: NativeSelectedDiffSelector = { kind: 'session', revision: await nativeSelectedDiffRevision(actualSession.unifiedDiff), fileIndex, hunkIndex: 0 };
    const catalog = f.daemon.services.gatewayMethods, getScopes = catalog.getAllScopes.bind(catalog);
    const grant = spyOn(catalog, 'getAllScopes').mockImplementation(options => getScopes(options).filter(scope => scope !== 'read:sessions'));
    try { expect((await wire('workLedger.intake.capture', command('missing-session-read', COMMENT, sessionSelector))).status).toBe(403); }
    finally { grant.mockRestore(); }
    const exactSessionHunk = selectNativeDiffHunk(actualSession.unifiedDiff, fileIndex, 0);
    expect(exactSessionHunk.split('\n').length).toBeGreaterThan(40);
    const selected = await captureAndAdmit(command('session', COMMENT, sessionSelector));
    if (selected.result.kind !== 'turn') throw new Error(selected.admit.body);
    expect(selected.result.text).toBe(COMMENT);
    expect(selected.result.continuation?.selectedDiff).toEqual({ ...sessionSelector, unifiedDiff: exactSessionHunk,
      provenance: { kind: 'session', sessionId, baselineCheckpointId: actualSession.from, latestCheckpointId: stamped.id } });
    expect(selected.result.continuation?.messages).toEqual(body(attachment).history);
    expect(selected.result.sourceRef.continuation?.selectedDiff).toEqual(sessionSelector);
    const session = { ...await dispatch(selected), diff: sessionDiff };
    const modelRequest = requests.find(request => request.stream && lastUser(request) === COMMENT)!;
    expect(modelRequest).toBeDefined();
    expect(modelRequest.messages.some(message => typeof message.content === 'string' && message.content.includes(JSON.stringify(exactSessionHunk).slice(1, -1)))).toBe(true);
    expect(modelRequest.messages.filter(message => message.role === 'user' && message.content === COMMENT)).toHaveLength(1);
    expect(body(await wire('sessions.hosted.attach', { sessionId, clientId: 'selected-diff-proof' })).history.some((message: { content: string }) => message.content.includes(JSON.stringify(exactSessionHunk).slice(1, -1)))).toBe(false);
    const repeated = { ...await dispatch(await captureAndAdmit(command('repeated', COMMENT, sessionSelector))), diff: sessionDiff };
    expect(repeated.identity.inputId).not.toBe(session.identity.inputId);
    const badRevisionCommand = command('bad-revision', COMMENT, { ...sessionSelector, revision: '0'.repeat(64) });
    const badRevision = { command: badRevisionCommand, capture: await wire('workLedger.intake.capture', badRevisionCommand), diff: sessionDiff };
    expect(badRevision.capture.status).toBe(409); expect(badRevision.capture.body).toContain('NATIVE_SELECTED_DIFF_STALE');
    const foreign = f.daemon.services.pairingTokens.mint({ name: 'Foreign selected diff owner' });
    const discoveryDenied = await wire('workLedger.turn.session', { sessionId }, foreign.token); expect(discoveryDenied.status).toBe(403);
    for (const token of [null, f.daemon.token, foreign.token]) {
      const denied = await wire('workLedger.intake.capture', command('foreign', COMMENT, sessionSelector), token);
      expect([400, 401, 403, 409, 503]).toContain(denied.status); expect(denied.body).not.toContain(exactSessionHunk);
    }
    for (const fields of [{ unifiedDiff: exactSessionHunk }, { path: 'selected-change.ts' }, { principalId: `pairing:${f.paired.id}` }, { projectId: first.identity.projectId }]) {
      const forged = await wire('workLedger.intake.capture', { ...command('forged', COMMENT, sessionSelector), continuation: { sessionId, selectedDiff: { ...sessionSelector, ...fields } } });
      expect(forged.status).toBe(400);
    }
    const otherSession = await wire('workLedger.intake.capture', { ...command('session-mismatch', COMMENT, sessionSelector), continuation: { sessionId: 'unowned-session', selectedDiff: sessionSelector } });
    expect(otherSession.status).not.toBe(200);
    const missingHunk = await wire('workLedger.intake.capture', command('missing-hunk', COMMENT, { ...sessionSelector, hunkIndex: 100 }));
    expect(missingHunk.status).toBe(409); expect(missingHunk.body).toContain('NATIVE_SELECTED_DIFF_MISSING');
    writeFileSync(file, 'x'.repeat(70_000) + '\n');
    const large = body(await wire('checkpoints.diff', { a: stamped.id })).diff;
    const largeSelector: NativeSelectedDiffSelector = { kind: 'workspace', baselineId: stamped.id, revision: await nativeSelectedDiffRevision(large.unifiedDiff), fileIndex: 0, hunkIndex: 0 };
    const tooLarge = await wire('workLedger.intake.capture', command('oversize', COMMENT, largeSelector));
    expect(tooLarge.status).toBe(413); expect(tooLarge.body).toContain('NATIVE_SELECTED_DIFF_OVERSIZE');
    const absentBaseline = await wire('workLedger.intake.capture', command('missing-baseline', COMMENT, { ...largeSelector, baselineId: 'missing-checkpoint' }));
    expect(absentBaseline.status).toBe(409); expect(absentBaseline.body).toContain('NATIVE_SELECTED_DIFF_MISSING');
    writeFileSync(file, Buffer.from([0, 1, 2, 3]));
    const binary = body(await wire('checkpoints.diff', { a: stamped.id })).diff;
    const unsupported = await wire('workLedger.intake.capture', command('binary', COMMENT, { ...largeSelector, revision: await nativeSelectedDiffRevision(binary.unifiedDiff) }));
    expect(unsupported.status).toBe(400); expect(unsupported.body).toContain('NATIVE_SELECTED_DIFF_UNSUPPORTED');
    writeFileSync(file, Array.from({ length: 80 }, (_, index) => `workspace changed line ${index} 🌻\n`).join(''));
    const checkpoints = await wire('checkpoints.list', {}); const workspaceBaselineId = body(checkpoints).checkpoints[0].id;
    const workspaceDiff = await wire('checkpoints.diff', { a: workspaceBaselineId });
    const actualWorkspace = body(workspaceDiff).diff;
    expect(actualWorkspace.nativeRevision).toBe(await nativeSelectedDiffRevision(actualWorkspace.unifiedDiff));
    const workspaceIndex = actualWorkspace.unifiedDiff.split(/(?=^diff --git )/m).filter(Boolean).findIndex((part: string) => part.startsWith('diff --git a/selected-change.ts b/selected-change.ts\n'));
    const workspaceSelector: NativeSelectedDiffSelector = { kind: 'workspace', baselineId: workspaceBaselineId, revision: await nativeSelectedDiffRevision(actualWorkspace.unifiedDiff), fileIndex: workspaceIndex, hunkIndex: 0 };
    const workspaceGrant = spyOn(catalog, 'getAllScopes').mockImplementation(options => getScopes(options).filter(scope => scope !== 'read:checkpoints'));
    try { expect((await wire('workLedger.intake.capture', command('missing-workspace-read', WORK, workspaceSelector))).status).toBe(403); }
    finally { workspaceGrant.mockRestore(); }
    const workspaceCommand = command('workspace', WORK, workspaceSelector);
    const workspaceCapture = await wire('workLedger.intake.capture', workspaceCommand); intake(workspaceCapture);
    // A successful source capture freezes a snapshot; a later working-tree edit cannot rewrite it.
    writeFileSync(file, 'a later unrelated working-tree edit\n');
    expect((await wire('workLedger.intake.capture', workspaceCommand)).body).toBe(workspaceCapture.body);
    const changedSelector = await wire('workLedger.intake.capture', { ...workspaceCommand, continuation: { sessionId, selectedDiff: { ...workspaceSelector, hunkIndex: 1 } } });
    expect(changedSelector.status).toBe(409); expect(changedSelector.body).toContain('REQUEST_CONFLICT');
    const staleWorkspace = await wire('workLedger.intake.capture', command('stale-workspace', WORK, workspaceSelector));
    expect(staleWorkspace.status).toBe(409); expect(staleWorkspace.body).toContain('NATIVE_SELECTED_DIFF_STALE');
    // The hosted floor installs its own real semantic port. Select this proof's
    // owned recorded semantic endpoint for the subsequent real work graph.
    const hostedJudgment = installJudgmentPort(f.daemon.services.judgment.port);
    restoreJudgment = () => { installJudgmentPort(hostedJudgment); };
    f.controls.route = 'contract';
    f.daemon.services.configManager.set('provider.model', 'native-intake-execution-fixture:model');
    f.daemon.services.providerRegistry.setCurrentModel('native-intake-execution-fixture:model');
    const work = await captureAndAdmit(workspaceCommand, workspaceCapture);
    if (work.result.kind !== 'work') throw new Error(work.admit.body);
    expect(work.result.receipt.goal).toBe(WORK); expect(work.result.receipt.criteria).toEqual([WORK]);
    expect(work.result.receipt.source.spans).toEqual([{ partId: 'input', start: 0, end: WORK.length }]);
    const exactWorkspaceHunk = selectNativeDiffHunk(actualWorkspace.unifiedDiff, workspaceIndex, 0);
    expect(work.result.receipt.source.continuation?.selectedDiff).toEqual({ ...workspaceSelector, unifiedDiff: exactWorkspaceHunk,
      provenance: { kind: 'workspace', baselineId: workspaceBaselineId, to: 'WORKING' } });
    const workIdentity = { projectId: work.result.projectId, workId: work.result.receipt.workId, attemptId: work.result.receipt.attemptId, expectedRevision: work.result.receipt.expectedRevision };
    const workAbsent = await wire('workLedger.execution.status', workIdentity); expect(workAbsent.status).toBe(404);
    const workStart = await wire('workLedger.execution.start', workIdentity); body(workStart);
    const workStatus = await waitFor(() => wire('workLedger.execution.status', workIdentity), value => {
      const snapshot = nativeWorkExecutionSnapshotSchema.parse(body(value));
      if (snapshot.kind === 'execution' && ['failed', 'cancelled'].includes(snapshot.progress?.status ?? '')) throw new Error(`${value.body}; contracts: ${JSON.stringify(f.contracts().map(contract => ({ status: contract.status, error: contract.error, failureKind: contract.failureKind })))}; judgments: ${JSON.stringify(f.judgmentRequests.map(request => request.context?.site))}; judgmentErrors: ${JSON.stringify(f.judgmentErrors.map(error => error instanceof Error ? error.stack : error))}; requests: ${JSON.stringify(f.requests.map(request => ({ model: request.model, systemPrefix: request.systemPrompt?.slice(0, 100) })))}`);
      return snapshot.kind === 'execution' && snapshot.progress?.status === 'passed' && snapshot.settlement?.state === 'published';
    });
    expect(f.requests.filter(request => request.systemPrompt?.includes('Execute this existing native work unit yourself')).length).toBeGreaterThan(0);
    expect(f.requests.some(request => request.systemPrompt?.includes(JSON.stringify(exactWorkspaceHunk).slice(1, -1)))).toBe(true);
    const workspace = { ...work, identity: workIdentity, diff: workspaceDiff, absent: workAbsent, start: workStart, status: workStatus };
    const cancelCommand = command('cancel', 'Cancel this exact selected source before admission.', sessionSelector);
    const cancelCapture = await wire('workLedger.intake.capture', cancelCommand); const cancelSource = intake(cancelCapture); if (cancelSource.kind !== 'captured') throw new Error(cancelCapture.body);
    const cancelIdentity = { inputId: cancelCommand.inputId, sourceRevision: cancelSource.sourceRef.sourceRevision };
    const getCaptured = await wire('workLedger.intake.get', { inputId: cancelCommand.inputId }); expect(getCaptured.body).toBe(cancelCapture.body);
    const cancellation = await wire('workLedger.intake.cancel', cancelIdentity); expect(intake(cancellation).kind).toBe('cancelled');
    const cancel = { command: cancelCommand, capture: cancelCapture, getCaptured, cancel: cancellation, get: await wire('workLedger.intake.get', { inputId: cancelCommand.inputId }), diff: sessionDiff };
    f.controls.route = 'converse'; f.daemon.services.configManager.set('provider.model', 'selected-diff-wire:selected-diff-model');
    const active = await captureAndAdmit(command('active', ACTIVE));
    const activeStart = await wire('workLedger.turn.start', active.identity); turn(activeStart);
    await waitFor(async () => requests.some(request => request.stream && lastUser(request) === ACTIVE), Boolean);
    const busyDiscovery = await wire('workLedger.turn.session', { sessionId }); expect(body(busyDiscovery)).toMatchObject({ busy: true });
    const queued = await captureAndAdmit(command('queued-cancel', 'Cancel just this queued selected diff comment.', sessionSelector));
    if (queued.result.kind !== 'turn') throw new Error(queued.admit.body);
    expect(queued.result.continuation?.messages.some(message => message.content === ACTIVE)).toBe(false);
    const queuedDeliverySource = await captureAndAdmit(command('queued-delivery', QUEUED_DELIVERY, sessionSelector));
    if (queuedDeliverySource.result.kind !== 'turn') throw new Error(queuedDeliverySource.admit.body);
    expect(queuedDeliverySource.result.continuation).toEqual(queued.result.continuation);
    const queuedDeliveryAbsent = await wire('workLedger.turn.status', queuedDeliverySource.identity); expect(body(queuedDeliveryAbsent)).toEqual({ kind: 'not-found' });
    const queuedAbsent = await wire('workLedger.turn.status', queued.identity); expect(body(queuedAbsent)).toEqual({ kind: 'not-found' });
    const queuedStart = await wire('workLedger.turn.start', queued.identity); expect(turn(queuedStart).state).toBe('queued');
    const queuedDeliveryStart = await wire('workLedger.turn.start', queuedDeliverySource.identity); expect(turn(queuedDeliveryStart).state).toBe('queued');
    expect(requests.some(request => request.stream && lastUser(request) === QUEUED_DELIVERY)).toBe(false);
    const queuedCancellation = await wire('workLedger.turn.cancel', queued.identity); expect(turn(queuedCancellation).state).toBe('cancelled');
    expect(turn(await wire('workLedger.turn.status', active.identity)).state).toBe('running');
    const queuedStatus = await wire('workLedger.turn.status', queued.identity);
    expect((await wire('workLedger.turn.start', queued.identity)).body).toBe(queuedStatus.body);
    const queuedCancel = { ...queued, absent: queuedAbsent, start: queuedStart, cancel: queuedCancellation, status: queuedStatus, diff: sessionDiff };
    activeBarrier.resolve();
    const activeStatus = await waitFor(() => wire('workLedger.turn.status', active.identity), value => turn(value).state === 'completed');
    const queuedDeliveryStatus = await waitFor(() => wire('workLedger.turn.status', queuedDeliverySource.identity), value => turn(value).state === 'completed');
    const queuedDelivery = { ...queuedDeliverySource, diff: sessionDiff, absent: queuedDeliveryAbsent, start: queuedDeliveryStart, status: queuedDeliveryStatus };
    expect((await wire('workLedger.intake.get', { inputId: queuedDelivery.command.inputId })).body).toBe(queuedDelivery.get.body);
    const queuedModel = requests.find(request => request.stream && lastUser(request) === QUEUED_DELIVERY)!;
    expect(queuedModel).toBeDefined();
    expect(queuedModel.messages.some(message => typeof message.content === 'string' && message.content.includes(JSON.stringify(exactSessionHunk).slice(1, -1)))).toBe(true);
    expect(queuedModel.messages).toContainEqual({ role: 'user', content: ACTIVE });
    expect(queuedModel.messages.filter(message => message.role === 'user' && message.content === QUEUED_DELIVERY)).toHaveLength(1);
    expect(queuedDeliverySource.result.continuation?.messages.some(message => message.content === ACTIVE)).toBe(false);
    expect((await wire('workLedger.intake.get', { inputId: work.command.inputId })).body).toBe(work.get.body);
    writeFileSync(file, 'a newly completed session-stamped change\n');
    expect(body(await wire('checkpoints.create', { kind: 'manual', label: 'Later session-stamped changes', sessionId })).noop).toBe(false);
    const changedSessionDiff = await wire('sessions.changes.get', { sessionId }); body(changedSessionDiff);
    expect((await wire('workLedger.intake.capture', session.command)).body).toBe(session.get.body);
    const staleCommand = command('stale', COMMENT, sessionSelector);
    const stale = { command: staleCommand, capture: await wire('workLedger.intake.capture', staleCommand), diff: sessionDiff };
    expect(stale.capture.status).toBe(409); expect(stale.capture.body).toContain('NATIVE_SELECTED_DIFF_STALE');
    const directory = process.env.GOODVIBES_TEST_NATIVE_SELECTED_DIFF_FIXTURE_DIR;
    if (directory) {
      mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, 'lifecycle.json'), JSON.stringify({ source: 'Real paired DaemonServer, real WorkspaceCheckpointManager, actual native Orchestrator and work graph, owned loopback/synthetic models. All wire request/body strings unchanged.',
        projectId: first.identity.projectId, sessionId, auth, project, sessionList, sessionRow, sharedSession, discovery, discoveryDenied, busyDiscovery, checkpoints, legacy,
        changedSessionDiff, initial: { ...first, start: initialStart, status: initialStatus }, session, repeated, workspace, stale, cancel, queuedCancel, queuedDelivery,
        active: { ...active, start: activeStart, status: activeStatus },
        modelRequests: requests.filter(request => request.stream && [COMMENT, QUEUED_DELIVERY].includes(String(lastUser(request)))).map(request => ({ stream: request.stream, messages: request.messages.filter(message => message.role === 'user' || message.role === 'assistant' || (typeof message.content === 'string' && message.content.includes(JSON.stringify(exactSessionHunk).slice(1, -1)))) })),
      }, null, 2) + '\n');
    }
    restoreJudgment?.(); restoreJudgment = undefined;
    await f.stop();
    restarted = await createNativeIntakeExecutionHttpFixture({ root: f.root, paired: f.paired, resumedSourceText: WORK });
    const recovered = await restarted.wire('workLedger.intake.get', { inputId: workspace.command.inputId });
    expect(recovered.body).toBe(workspace.get.body);
    expect(restarted.requests).toHaveLength(0);
    const replay = await restarted.wire('workLedger.intake.capture', workspace.command);
    expect(replay.body).toBe(workspace.get.body); expect(restarted.requests).toHaveLength(0);
    const settled = await restarted.wire('workLedger.execution.status', workIdentity); expect(settled.status).toBe(200);
    expect(restarted.requests).toHaveLength(0);
  } finally { activeBarrier.resolve(); restoreJudgment?.(); await restarted?.stop(); await f.stop(); server.stop(true); }
}, 150_000);
