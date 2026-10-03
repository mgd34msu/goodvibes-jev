import { afterEach, describe, expect, test } from 'bun:test';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import type { JudgmentPort, JudgmentRequest, JudgmentResult, Questions } from '@goodvibes-jev/judgment/decisions';
import { createSystemOnePort, PINNED_MODEL } from '@goodvibes-jev/judgment';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { AgentWorkspace } from '../../input/agent-workspace.ts';
import type { AgentWorkspaceLocalEditor } from '../../input/agent-workspace-types.ts';
import type { CommandContext } from '../../input/command-registry.ts';
import { renderAgentWorkspace } from '../../renderer/agent-workspace.ts';
import { WORKSPACE_PALETTE } from '../../renderer/fullscreen-workspace.ts';

const previous = installJudgmentPort(undefined);
afterEach(() => { installJudgmentPort(previous); });
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const editor = (message: string): AgentWorkspaceLocalEditor => ({ kind: 'note', mode: 'create', title: 'New note', selectedFieldIndex: 0, message,
  fields: [{ id: 'title', label: 'Name', value: '', required: true, multiline: false, hint: '' }] });
function workspace() {
  const ws = new AgentWorkspace();
  let renders = 0;
  ws.open({ executeCommand: async () => true, print() {}, renderRequest() { renders++; } } as unknown as CommandContext, () => {});
  return { ws, renders: () => renders };
}
function messageColor(ws: AgentWorkspace, message: string) {
  const layer = renderAgentWorkspace(ws, 120, 42);
  for (const line of layer.lines) {
    const text = line.map((cell) => cell.char ?? ' ').join('');
    const index = text.indexOf(message);
    if (index !== -1) return line[index]?.fg;
  }
  throw new Error(`Missing editor message: ${message}`);
}
function delayedPort() {
  const jobs: { request: JudgmentRequest<Questions>; resolve: (result: JudgmentResult<Questions>) => void }[] = [];
  const actions: string[] = [];
  const port: JudgmentPort = { model: 'jev-1.13.0', recorder: { recordReadings() {}, recordAction(_id, action) { actions.push(action); } },
    ask: ((request: JudgmentRequest<Questions>) => new Promise<JudgmentResult<Questions>>((resolve) => jobs.push({ request, resolve }))) as JudgmentPort['ask'] };
  const finish = (index: number, probability: number) => jobs[index]!.resolve({ answers: { blocking: { type: 'noul', noul: probability } }, requestedModel: port.model, model: port.model,
    usage: { inputTokens: 1, outputTokens: 1 }, latencyMs: 1, requestId: `request-${index}`, decisionId: `decision-${index}` });
  return { port, jobs, finish, actions };
}

describe('workspace editor message reading', () => {
  test.each([
    ['Saved; nothing required.', 0.01, 'info'],
    ['Saved the note named Cannot wait.', 0.01, 'info'],
    ['Save failed: this record is read-only.', 0.99, 'warn'],
    ['There is no problem preventing this form from being saved.', 0.01, 'info'],
  ] as const)('uses typed meaning for %s', async (message, probability, tone) => {
    const fake = fakePort(() => noulAnswer(probability)); installJudgmentPort(fake.port);
    const { ws, renders } = workspace(); ws.localEditor = editor(message);
    expect(ws.editorMessageState.status).toBe('pending');
    expect(messageColor(ws, message)).toBe(WORKSPACE_PALETTE.muted);
    await flush();
    expect(messageColor(ws, message)).toBe(WORKSPACE_PALETTE[tone]);
    expect(fake.requests[0]?.context?.battery).toBe('agent.workspace.editor-message-blocking');
    expect(fake.requests[0]?.state).toEqual({ evidence: { message }, editor: { kind: 'note', mode: 'create' } });
    expect(renders()).toBe(1);
    for (let i = 0; i < 5; i++) renderAgentWorkspace(ws, 120, 42);
    ws.moveEditorField(0); ws.appendEditorText('private form value'); await flush();
    expect(fake.requests).toHaveLength(1);
    ws.close();
  });

  test.each([0.5, 0.57])('uncertainty at %s remains typed and neutral, with provenance and no human loop', async (probability) => {
    const fake = delayedPort(); installJudgmentPort(fake.port);
    const { ws } = workspace(); ws.localEditor = editor('Ready?'); fake.finish(0, probability); await flush();
    const state = ws.editorMessageState;
    expect(state.status).toBe('uncertain');
    if (state.status !== 'uncertain') throw new Error('Expected uncertain reading');
    expect(state.reading.result.decisionId).toBe('decision-0');
    expect(state.reading.readings.blocking.outcome).not.toBe('act');
    expect(messageColor(ws, 'Ready?')).toBe(WORKSPACE_PALETTE.muted);
    expect(fake.jobs).toHaveLength(1); ws.close();
  });

  test('new message and editor context revisions reject out-of-order completions', async () => {
    const fake = delayedPort(); installJudgmentPort(fake.port);
    const { ws } = workspace(); ws.localEditor = editor('First message');
    const first = fake.jobs[0]!;
    ws.localEditor = editor('Second message'); expect(first.request.signal?.aborted).toBe(true);
    fake.finish(1, 0.01); await flush(); fake.finish(0, 0.99); await flush();
    expect(messageColor(ws, 'Second message')).toBe(WORKSPACE_PALETTE.info);
    expect(fake.actions.some((action) => action.includes('stale'))).toBe(true);
    ws.localEditor = { ...editor('Second message'), recordId: 'different-record', mode: 'update' };
    expect(ws.editorMessageState.status).toBe('pending');
    expect(fake.jobs).toHaveLength(3);
    ws.close(); expect(fake.jobs[2]!.request.signal?.aborted).toBe(true);
    fake.finish(2, 0.99); await flush(); expect(ws.editorMessageState.status).toBe('empty');
  });

  test('reopening the workspace rejects readings from the previous composition context', async () => {
    const fake = delayedPort(); installJudgmentPort(fake.port);
    const { ws } = workspace(); ws.localEditor = editor('Same message');
    ws.open({ executeCommand: async () => true, print() {} } as unknown as CommandContext, () => {});
    ws.localEditor = editor('Same message');
    fake.finish(0, 0.99); await flush(); expect(ws.editorMessageState.status).toBe('pending');
    fake.finish(1, 0.01); await flush(); expect(messageColor(ws, 'Same message')).toBe(WORKSPACE_PALETTE.info); ws.close();
  });

  test('actual missing-field producer flows through reading to warn paint', async () => {
    const fake = fakePort(() => noulAnswer(0.99)); installJudgmentPort(fake.port);
    const { ws } = workspace(); ws.localEditor = editor('Ready to edit.');
    ws.submitEditorFieldOrForm();
    expect(ws.localEditor?.message).toBe('Name is required before saving.');
    await flush(); expect(messageColor(ws, 'Name is required before saving.')).toBe(WORKSPACE_PALETTE.warn);
    expect(fake.requests.at(-1)?.state).toEqual({ evidence: { message: 'Name is required before saving.' }, editor: { kind: 'note', mode: 'create' } }); ws.close();
  });

  test('shared transport owns outage recovery while presentation stays pending', async () => {
    const retryStarted = Promise.withResolvers<void>();
    const recovered = Promise.withResolvers<Response>();
    const rendered = Promise.withResolvers<void>();
    let calls = 0;
    const port = createSystemOnePort({
      endpoint: { kind: 'local', baseURL: 'http://127.0.0.1:9999', apiKey: 'fixture-only' },
      model: PINNED_MODEL, timeoutMs: 5_000,
      retry: { maxRetries: 1, backoffInitialMs: 0, backoffMaxMs: 0, backoffJitter: 0 },
      fetch: async () => {
        calls++;
        if (calls === 1) return Response.json({ error: 'unavailable' }, { status: 503 });
        retryStarted.resolve();
        return recovered.promise;
      },
    });
    installJudgmentPort(port);
    const ws = new AgentWorkspace();
    ws.open({ executeCommand: async () => true, print() {}, renderRequest() { rendered.resolve(); } } as unknown as CommandContext, () => {});
    ws.localEditor = editor('Saved; nothing required.');
    await retryStarted.promise;
    expect(ws.editorMessageState.status).toBe('pending');
    for (let i = 0; i < 5; i++) renderAgentWorkspace(ws, 120, 42);
    expect(calls).toBe(2);
    recovered.resolve(Response.json({ model: PINNED_MODEL, answers: { blocking: noulAnswer(0.01) }, usage: { input_tokens: 1, output_tokens: 1 } }));
    await rendered.promise;
    expect(ws.editorMessageState.status).toBe('read');
    expect(messageColor(ws, 'Saved; nothing required.')).toBe(WORKSPACE_PALETTE.info);
    expect(calls).toBe(2); ws.close();
  });

  test('missing shared port stays unresolved without a fabricated classification or local retry', async () => {
    installJudgmentPort(undefined);
    const { ws } = workspace(); ws.localEditor = editor('Cannot save.'); await flush();
    expect(ws.editorMessageState.status).toBe('unavailable');
    expect(messageColor(ws, 'Cannot save.')).toBe(WORKSPACE_PALETTE.muted); ws.close();
  });

  test('shared privacy boundary and declared secret containment prevent model transmission', async () => {
    const fake = fakePort(() => noulAnswer(0.99)); installJudgmentPort(fake.port);
    const { ws } = workspace();
    ws.localEditor = editor('Authorization: Bearer private-token'); await flush();
    expect(ws.editorMessageState.status).toBe('unavailable'); expect(fake.requests).toHaveLength(0);
    ws.localEditor = { ...editor('Invalid opaque-secret'), fields: [{ ...editor('').fields[0]!, redact: true, value: 'opaque-secret' }] };
    await flush(); expect(ws.editorMessageState.status).toBe('protected'); expect(fake.requests).toHaveLength(0); ws.close();
  });
});
