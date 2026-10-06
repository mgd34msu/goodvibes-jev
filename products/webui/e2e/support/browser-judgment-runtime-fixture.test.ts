import { expect, test } from 'bun:test';
import { parseBrowserJudgmentRequest } from '@goodvibes-jev/engine/daemon-sdk';
import { readCommandRankResponse } from '../../src/lib/command-judgment';
import { readDaemonRefusalResponse } from '../../src/lib/daemon-refusal';
import { correlateRuntimeReading, loadBrowserJudgmentRuntimeCapture } from './browser-judgment-runtime-fixture';

test('actual browser validators accept runtime-composed evidence, including all 28 palette candidates', () => {
  const capture = loadBrowserJudgmentRuntimeCapture();
  for (const name of ['library', 'chat', 'held'] as const) {
    const wire = capture[name];
    if (wire.requestBody.battery !== 'webui.palette.command-rank') throw new Error('Wrong recorded battery');
    expect(wire.requestBody.input.candidates).toHaveLength(28);
    expect(wire.requestBody.input.candidates.filter(candidate => candidate.kind === 'chat')).toEqual([{ kind: 'chat', sessionId: capture.sessionId }]);
    const result = readCommandRankResponse(wire.requestBody, JSON.parse(wire.body));
    expect(result?.status).toBe(name === 'held' ? 'held' : 'settled');
    if (result?.status === 'settled') {
      expect(result.value.accepted).toHaveLength(1);
      expect(wire.requestBody.input.candidates[result.value.accepted[0]!.candidateIndex]).toEqual(name === 'chat'
        ? { kind: 'chat', sessionId: capture.sessionId } : { kind: 'builtin', commandId: 'nav.library' });
    }
  }
  const wire = capture.errorSettled;
  if (wire.requestBody.battery !== 'webui.errors.daemon-refusal') throw new Error('Wrong recorded battery');
  expect(readDaemonRefusalResponse(wire.requestBody, capture.close.status, JSON.parse(wire.body))).toEqual({
    method_unknown: true, session_not_found: false, session_closed: false, session_active: false, session_not_local: false,
  });
  const held = capture.errorHeld;
  if (held.requestBody.battery !== 'webui.errors.daemon-refusal') throw new Error('Wrong recorded battery');
  expect(readDaemonRefusalResponse(held.requestBody, capture.close.status, JSON.parse(held.body))).toBeUndefined();
});

test('replay changes only the correlation token and rejects changed source, query, or candidate order', () => {
  const capture = loadBrowserJudgmentRuntimeCapture();
  for (const wire of [capture.library, capture.chat, capture.held, capture.errorSettled, capture.errorHeld]) {
    const requestId = 'dab5625c-6217-4bf2-a661-f917da8be123';
    const replay = correlateRuntimeReading(wire, { ...wire.requestBody, requestId });
    expect(correlateRuntimeReading(wire, parseBrowserJudgmentRequest({ ...wire.requestBody, requestId }))).toBe(replay);
    expect(replay.replace(`"requestId":"${requestId}"`, `"requestId":"${wire.requestBody.requestId}"`)).toBe(wire.body);
    expect(JSON.parse(replay).evidence).toEqual(JSON.parse(wire.body).evidence);
    expect(JSON.parse(replay).readings).toEqual(JSON.parse(wire.body).readings);
  }
  const request = capture.library.requestBody;
  if (request.battery !== 'webui.palette.command-rank') throw new Error('Wrong recorded battery');
  expect(() => correlateRuntimeReading(capture.library, { ...request, input: { ...request.input, query: { kind: 'inline', text: 'different query' } } })).toThrow();
  expect(() => correlateRuntimeReading(capture.library, { ...request, input: { ...request.input, candidates: [...request.input.candidates].reverse() } })).toThrow();
  const refusal = capture.errorSettled.requestBody;
  if (refusal.battery !== 'webui.errors.daemon-refusal') throw new Error('Wrong recorded battery');
  expect(() => correlateRuntimeReading(capture.errorSettled, { ...refusal, input: { errorRef: 'unissued-reference' } })).toThrow();
});

test('recordings keep real companion identity and canonical close provenance without credentials', () => {
  const capture = loadBrowserJudgmentRuntimeCapture();
  expect(capture.source).toContain('synthetic System One');
  expect(JSON.stringify(capture)).not.toContain('Bearer ');
  expect(JSON.stringify(capture)).not.toContain('synthetic-browser-capture-key');
  expect(JSON.parse(capture.listBefore.body).sessions).toEqual([expect.objectContaining({ id: capture.sessionId, title: capture.title })]);
  expect(capture.close.path).toBe('/api/control-plane/methods/companion.chat.sessions.close/invoke');
  expect(capture.close.requestBody).toEqual({ body: { sessionId: capture.sessionId } });
  expect(capture.deleted.path).toBe(`/api/companion/chat/sessions/${capture.sessionId}`);
  expect(JSON.parse(capture.listAfter.body)).toMatchObject({ sessions: [] });
});
