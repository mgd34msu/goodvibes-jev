/**
 * remote-conversation-resume.test.ts, a new turn is not finished by the
 * previous turn's ending.
 *
 * This router opens a FRESH stream per turn. A stream that claims no position
 * is handed the daemon's catch-up replay, which is the tail of the previous
 * turn, that turn's `TURN_COMPLETED` included. The renderer for the turn now
 * running has never seen that frame, so it finishes on it, and every real frame
 * of the turn actually running is then dropped as post-terminal noise. The
 * person watches a turn produce nothing, and the turn was billed for.
 *
 * Two things stop it, and both are checked here: the stream states the position
 * it reached so the daemon replays nothing already delivered, and the turn
 * gate refuses a terminal frame for a turn this renderer never saw start.
 */
import { describe, expect, test } from 'bun:test';
import {
  createRemoteConversationRouter,
  type ConnectedHostResolution,
} from '../../runtime/client/remote-conversation.ts';
import type { HostedFrameConversation } from '../../runtime/client/hosted-frame-render.ts';

const HOSTED_ID = 'hosted-resume-1';
const LIVE_HOST: ConnectedHostResolution = { baseUrl: 'http://127.0.0.1:3421', token: 'operator-token' };

/** One SSE record, exactly as the daemon writes it onto the wire. */
interface Frame {
  readonly id: string;
  readonly type: string;
  readonly turnId?: string | undefined;
  readonly fields?: Record<string, unknown> | undefined;
}

function encodeFrame(frame: Frame): string {
  const payload = {
    type: frame.type,
    ...(frame.turnId ? { turnId: frame.turnId } : {}),
    ...(frame.fields ?? {}),
  };
  const record = { type: frame.type, sessionId: HOSTED_ID, payload };
  return `id: ${frame.id}\nevent: turn\ndata: ${JSON.stringify(record)}\n\n`;
}

/** What each conversation message looked like, for the assertions. */
interface Recorded {
  readonly assistant: string[];
  readonly streamed: string[];
}

function recordingConversation(into: Recorded): HostedFrameConversation {
  return {
    addAssistantMessage: (text: string) => { into.assistant.push(text); },
    addToolResults: () => {},
    addSystemMessage: () => {},
    startStreamingBlock: () => {},
    updateStreamingBlock: (text: string) => { into.streamed.push(text); },
    finalizeStreamingBlock: () => {},
  };
}

/**
 * A daemon that serves one scripted stream per open, and records the position
 * each open claimed.
 */
function scriptedDaemon(streams: readonly (readonly Frame[])[]): {
  fetchImpl: typeof fetch;
  positions: (string | null)[];
} {
  const positions: (string | null)[] = [];
  let opened = 0;
  const fetchImpl = (async (_url: string, init?: RequestInit) => {
    const headers = new Headers(init?.headers ?? {});
    positions.push(headers.get('Last-Event-ID'));
    const frames = streams[opened] ?? [];
    opened += 1;
    return new Response(new ReadableStream<Uint8Array>({
      start: (controller) => {
        const encoder = new TextEncoder();
        for (const frame of frames) controller.enqueue(encoder.encode(encodeFrame(frame)));
        controller.close();
      },
    }), { headers: { 'content-type': 'text/event-stream' } });
  }) as unknown as typeof fetch;
  return { fetchImpl, positions };
}

function router(fetchImpl: typeof fetch, conversation: HostedFrameConversation) {
  return createRemoteConversationRouter({
    verbs: {
      probe: () => ({ available: true }),
      invoke: async <T,>(methodId: string): Promise<T> => (
        (methodId === 'sessions.hosted.create' ? { session: { id: HOSTED_ID } } : {}) as T
      ),
    },
    configManager: { get: (() => undefined) as never },
    resolveConnection: () => LIVE_HOST,
    conversation,
    requestRender: () => {},
    workspaceRoot: '/home/someone/project',
    clientId: 'goodvibes-agent:test',
    fetchImpl,
    // A closed stream must become a termination now rather than after ten
    // reconnect attempts; the position and the gate are what is under test.
    reconnect: { enabled: false },
  });
}

describe('a second turn on a hosted conversation', () => {
  test('states the position the first turn\'s stream reached', async () => {
    const { fetchImpl, positions } = scriptedDaemon([
      [
        { id: 'evt-1', type: 'TURN_SUBMITTED', turnId: 'turn-1' },
        { id: 'evt-2', type: 'STREAM_DELTA', turnId: 'turn-1', fields: { accumulated: 'first' } },
        { id: 'evt-3', type: 'TURN_COMPLETED', turnId: 'turn-1', fields: { stopReason: 'completed' } },
      ],
      [
        { id: 'evt-4', type: 'TURN_SUBMITTED', turnId: 'turn-2' },
        { id: 'evt-5', type: 'TURN_COMPLETED', turnId: 'turn-2', fields: { stopReason: 'completed' } },
      ],
    ]);
    const seen: Recorded = { assistant: [], streamed: [] };
    const remote = router(fetchImpl, recordingConversation(seen));

    const first = await remote.submit('one');
    expect(first.routed).toBe(true);
    if (first.routed) await first.completion;
    const second = await remote.submit('two');
    expect(second.routed).toBe(true);
    if (second.routed) await second.completion;

    // Nothing to resume past on the first open; the second resumes exactly
    // where the first stopped, so the daemon replays it nothing it already has.
    expect(positions).toEqual([null, 'evt-3']);
    remote.dispose();
  });

  test('is not finished by a replayed TURN_COMPLETED from the turn before it', async () => {
    const { fetchImpl } = scriptedDaemon([
      [
        { id: 'evt-1', type: 'TURN_SUBMITTED', turnId: 'turn-1' },
        { id: 'evt-2', type: 'TURN_COMPLETED', turnId: 'turn-1', fields: { stopReason: 'completed' } },
      ],
      [
        // The replayed tail: a daemon that could not resolve the position, or
        // one that predates the resume, hands this to the new stream first.
        { id: 'evt-2', type: 'TURN_COMPLETED', turnId: 'turn-1', fields: { stopReason: 'completed' } },
        // The turn actually running.
        { id: 'evt-3', type: 'TURN_SUBMITTED', turnId: 'turn-2' },
        { id: 'evt-4', type: 'STREAM_DELTA', turnId: 'turn-2', fields: { accumulated: 'the real answer' } },
        { id: 'evt-5', type: 'TURN_COMPLETED', turnId: 'turn-2', fields: { stopReason: 'completed' } },
      ],
    ]);
    const seen: Recorded = { assistant: [], streamed: [] };
    const remote = router(fetchImpl, recordingConversation(seen));

    const first = await remote.submit('one');
    if (first.routed) await first.completion;
    seen.assistant.length = 0;
    seen.streamed.length = 0;
    const second = await remote.submit('two');
    expect(second.routed).toBe(true);
    const completion = second.routed ? await second.completion : null;

    // Without the gate the replayed frame ends the turn here: status
    // 'completed', an empty response, and every frame after it discarded.
    expect(completion?.status).toBe('completed');
    expect(completion?.response).toBe('the real answer');
    expect(seen.streamed).toContain('the real answer');
    expect(seen.assistant).toContain('the real answer');
    remote.dispose();
  });

  test('a frame carrying no turn id is never withheld', async () => {
    const { fetchImpl } = scriptedDaemon([
      [
        // No turnId anywhere: an older daemon, or a session-level frame. The
        // gate must be inert rather than silently eating the turn.
        { id: 'evt-1', type: 'STREAM_DELTA', fields: { accumulated: 'plain text' } },
        { id: 'evt-2', type: 'TURN_COMPLETED', fields: { stopReason: 'completed' } },
      ],
    ]);
    const seen: Recorded = { assistant: [], streamed: [] };
    const remote = router(fetchImpl, recordingConversation(seen));

    const outcome = await remote.submit('one');
    const completion = outcome.routed ? await outcome.completion : null;

    expect(completion?.status).toBe('completed');
    expect(completion?.response).toBe('plain text');
    remote.dispose();
  });
});
