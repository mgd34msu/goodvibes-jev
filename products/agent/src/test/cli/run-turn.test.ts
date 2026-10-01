/**
 * run-turn.test.ts
 *
 * `goodvibes-agent run "..."` called the in-process orchestrator directly, so
 * it stayed local after conversation turns started being routed to the
 * connected daemon. On the installed build the hosted-sessions store stayed
 * empty and daemon-side sessions carried zero messages for run-mode turns,
 * the owner's ruling is that ALL LLM turns go through the daemon.
 *
 * These tests drive the real router against a fake daemon that speaks the real
 * event stream, and pin what run mode does with the result: the same output
 * shapes and the same exit codes it has always had, whichever process ran the
 * turn.
 */

import { describe, expect, test } from 'bun:test';
import { executeRunTurn, writeRunTurnResult, type RunTurnResult } from '../../cli/run-turn.ts';
import {
  createRemoteConversationRouter,
  type ConnectedHostResolution,
} from '../../runtime/client/remote-conversation.ts';
import type { HostedFrameConversation, HostedSessionFrame } from '../../runtime/client/hosted-frame-render.ts';
import type { RemoteConversationWiring } from '../../shell/remote-conversation-wiring.ts';
import type { BootstrapContext } from '../../runtime/bootstrap.ts';

const HOSTED_ID = 'hosted-run-mode-1';
const LIVE_HOST: ConnectedHostResolution = { baseUrl: 'http://127.0.0.1:3421', token: 'operator-token' };

/** One serialized envelope, exactly as the daemon's SSE stream sends it. */
function envelope(type: string, payload: Record<string, unknown>): string {
  const body = JSON.stringify({ type, ts: Date.now(), sessionId: HOSTED_ID, source: 'orchestrator', payload });
  return `event: turn\ndata: ${body}\n\n`;
}

/**
 * A fake connected host: its `/events` stream replays a scripted turn.
 *
 * Deliberately the real wire format, `event:`/`data:` frames carrying
 * serialized envelopes, so the SSE parsing and the frame mapping are both
 * genuinely exercised rather than stubbed past.
 */
function fakeDaemonFetch(frames: readonly string[]): typeof fetch {
  return (async () => new Response(
    new ReadableStream<Uint8Array>({
      start: (controller) => {
        const encoder = new TextEncoder();
        for (const frame of frames) controller.enqueue(encoder.encode(frame));
        controller.close();
      },
    }),
    { headers: { 'content-type': 'text/event-stream' } },
  )) as unknown as typeof fetch;
}

/** Records what the local mirror was told, so "with messages" can be asserted. */
function recordingConversation(): { conversation: HostedFrameConversation; assistant: string[]; user: string[] } {
  const assistant: string[] = [];
  const user: string[] = [];
  const conversation = {
    addUserMessage: (content: string) => { user.push(content); },
    addAssistantMessage: (content: string) => { assistant.push(content); },
    addToolResults: () => {},
    addSystemMessage: () => {},
    startStreamingBlock: () => {},
    updateStreamingBlock: () => {},
    finalizeStreamingBlock: () => {},
  };
  return { conversation: conversation as HostedFrameConversation, assistant, user };
}

interface RoutedHarness {
  readonly createRouting: (onFrame: (frame: HostedSessionFrame) => void) => RemoteConversationWiring;
  readonly calls: { methodId: string; input: Record<string, unknown> }[];
  readonly assistant: string[];
  readonly user: string[];
}

/** The real router and the real wiring contract, over a fake daemon. */
function routedHarness(input: {
  readonly frames: readonly string[];
  readonly connection?: ConnectedHostResolution;
  readonly notify?: (message: string) => void;
}): RoutedHarness {
  const calls: { methodId: string; input: Record<string, unknown> }[] = [];
  const { conversation, assistant, user } = recordingConversation();
  const createRouting = (onFrame: (frame: HostedSessionFrame) => void): RemoteConversationWiring => {
    const router = createRemoteConversationRouter({
      verbs: {
        probe: () => ({ available: true }),
        invoke: async <T,>(methodId: string, payload?: unknown): Promise<T> => {
          calls.push({ methodId, input: (payload ?? {}) as Record<string, unknown> });
          return { session: { id: HOSTED_ID } } as T;
        },
      },
      configManager: { get: (() => undefined) as never },
      resolveConnection: () => input.connection ?? LIVE_HOST,
      conversation,
      requestRender: () => {},
      workspaceRoot: '/home/someone/project',
      clientId: 'goodvibes-agent:test',
      fetchImpl: fakeDaemonFetch(input.frames),
      // The fake daemon's stream closes for good; without this the client would
      // spend its whole backoff schedule retrying a close that cannot recover.
      reconnect: { enabled: false },
      onFrame,
    });
    return {
      routeOrExplain: async (text: string, hasAttachments: boolean) => {
        const outcome = await router.submit(text, { hasAttachments });
        if (outcome.routed) {
          (conversation as unknown as { addUserMessage(c: string): void }).addUserMessage(text);
          return { hostedSessionId: outcome.hostedSessionId, completion: outcome.completion };
        }
        if (!outcome.chosen) input.notify?.(`[Turn] ${outcome.reason}`);
        return null;
      },
      cancelHostedTurn: () => {},
      hostedToolPreview: () => undefined,
      dispose: () => router.dispose(),
    };
  };
  return { createRouting, calls, assistant, user };
}

/** Enough of a BootstrapContext for the routed path, which never reaches into it. */
function inertCtx(): BootstrapContext {
  return {
    runtime: { sessionId: 'run-session', model: 'claude-opus-5', provider: 'anthropic' },
  } as unknown as BootstrapContext;
}

function collector(): { lines: string[]; write: (line: string) => void } {
  const lines: string[] = [];
  return { lines, write: (line) => { lines.push(line); } };
}

describe('a headless run whose turn the daemon ran', () => {
  test('resolves with the hosted turn\'s final text and exits 0', async () => {
    const harness = routedHarness({
      frames: [
        envelope('STREAM_DELTA', { turnId: 't1', content: 'The answer', accumulated: 'The answer' }),
        envelope('STREAM_DELTA', { turnId: 't1', content: ' is 42.', accumulated: 'The answer is 42.' }),
        envelope('TURN_COMPLETED', { turnId: 't1', response: 'The answer is 42.', stopReason: 'completed' }),
      ],
    });
    const out = collector();
    const err = collector();

    const result = await executeRunTurn({
      ctx: inertCtx(),
      prompt: 'what is the answer',
      outputFormat: undefined,
      stdout: out.write,
      stderr: err.write,
      createRouting: harness.createRouting,
    });

    expect(result.routed).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.response).toBe('The answer is 42.');
    expect(result.stopReason).toBe('completed');
    expect(result.error).toBe('');
    // Nothing on stderr: routing succeeded, so there is nothing to report.
    expect(err.lines).toEqual([]);
  });

  test('registers the session daemon-side carrying the prompt, and mirrors the turn locally', async () => {
    const harness = routedHarness({
      frames: [
        envelope('STREAM_DELTA', { turnId: 't1', accumulated: 'Done.' }),
        envelope('TURN_COMPLETED', { turnId: 't1', response: 'Done.', stopReason: 'completed' }),
      ],
    });

    await executeRunTurn({
      ctx: inertCtx(),
      prompt: 'do the thing',
      outputFormat: undefined,
      stdout: () => {},
      stderr: () => {},
      createRouting: harness.createRouting,
    });

    // The daemon-side session receives the message, an empty hosted session is
    // exactly the symptom this work exists to remove. The prompt rides a steer
    // rather than `initialPrompt` so the turn cannot start before the event
    // stream this surface renders from is open.
    expect(harness.calls.map((call) => call.methodId))
      .toEqual(['sessions.hosted.create', 'sessions.steer']);
    expect(harness.calls[0]?.input.workspaceRoot).toBe('/home/someone/project');
    expect(harness.calls[1]?.input.body).toBe('do the thing');

    // And the local record is the mirror: the prompt, and what came back.
    expect(harness.user).toEqual(['do the thing']);
    expect(harness.assistant).toEqual(['Done.']);
  });

  test('a hosted turn the daemon reports failing takes the run\'s error shape and exit 1', async () => {
    const harness = routedHarness({
      frames: [
        envelope('STREAM_DELTA', { turnId: 't1', accumulated: 'partial work' }),
        envelope('TURN_ERROR', { turnId: 't1', error: 'provider_exhausted', stopReason: 'provider_exhausted' }),
      ],
    });
    const out = collector();

    const result = await executeRunTurn({
      ctx: inertCtx(),
      prompt: 'go',
      outputFormat: 'json',
      stdout: out.write,
      stderr: () => {},
      createRouting: harness.createRouting,
    });

    expect(result.exitCode).toBe(1);
    expect(result.error).toBe('provider_exhausted');
    expect(result.stopReason).toBe('provider_exhausted');

    writeRunTurnResult(result, { ctx: inertCtx(), outputFormat: 'json', stdout: out.write });
    const payload = JSON.parse(out.lines[out.lines.length - 1] as string) as Record<string, unknown>;
    expect(payload.ok).toBe(false);
    expect(payload.error).toBe('provider_exhausted');
    expect(payload.stopReason).toBe('provider_exhausted');
    // The shape is the one it has always been, no field says where it ran.
    expect(Object.keys(payload).sort()).toEqual(
      ['error', 'events', 'model', 'ok', 'provider', 'response', 'sessionId', 'stopReason'],
    );
  });

  test('a hosted turn cancelled on the daemon exits 130, the code run mode has always used', async () => {
    const harness = routedHarness({
      frames: [envelope('TURN_CANCEL', { turnId: 't1', reason: 'interrupted', stopReason: 'cancelled' })],
    });

    const result = await executeRunTurn({
      ctx: inertCtx(),
      prompt: 'go',
      outputFormat: undefined,
      stdout: () => {},
      stderr: () => {},
      createRouting: harness.createRouting,
    });

    expect(result.exitCode).toBe(130);
    expect(result.error).toBe('interrupted');
  });

  test('a stream that dies before the turn ends fails the run rather than hanging it', async () => {
    // No end frame: the fake daemon closes the connection mid-turn.
    const harness = routedHarness({
      frames: [envelope('STREAM_DELTA', { turnId: 't1', accumulated: 'half' })],
    });

    const result = await executeRunTurn({
      ctx: inertCtx(),
      prompt: 'go',
      outputFormat: undefined,
      stdout: () => {},
      stderr: () => {},
      createRouting: harness.createRouting,
    });

    expect(result.exitCode).toBe(1);
    // The partial text the daemon did produce is kept, not discarded.
    expect(result.response).toBe('half');
    expect(result.error).toContain('ended before this turn finished');
  });

  test('stream-json re-emits the hosted deltas and counts the frames', async () => {
    const harness = routedHarness({
      frames: [
        envelope('STREAM_DELTA', { turnId: 't1', content: 'a', accumulated: 'a' }),
        envelope('STREAM_DELTA', { turnId: 't1', content: 'b', accumulated: 'ab' }),
        envelope('TURN_COMPLETED', { turnId: 't1', response: 'ab', stopReason: 'completed' }),
      ],
    });
    const out = collector();

    const result = await executeRunTurn({
      ctx: inertCtx(),
      prompt: 'go',
      outputFormat: 'stream-json',
      stdout: out.write,
      stderr: () => {},
      createRouting: harness.createRouting,
    });

    const deltas = out.lines
      .map((line) => JSON.parse(line) as { type: string; content?: string; accumulated?: string })
      .filter((frame) => frame.type === 'STREAM_DELTA');
    expect(deltas.map((frame) => frame.content)).toEqual(['a', 'b']);
    expect(deltas.map((frame) => frame.accumulated)).toEqual(['a', 'ab']);
    expect(result.eventCount).toBe(3);
  });
});

describe('a headless run the daemon could not take', () => {
  test('runs locally, states the reason on stderr, and leaves stdout to the contract', async () => {
    const notices: string[] = [];
    const harness = routedHarness({
      frames: [],
      connection: { reason: 'no operator token has been written yet.' },
      notify: (message) => notices.push(message),
    });
    const out = collector();

    // The local path is reached; a fake orchestrator + bus stands in for it.
    const listeners = new Map<string, ((event: { payload: unknown }) => void)[]>();
    const ctx = {
      runtime: { sessionId: 'run-session', model: 'm', provider: 'p' },
      runtimeBus: {
        on: (type: string, handler: (event: { payload: unknown }) => void) => {
          const existing = listeners.get(type) ?? [];
          existing.push(handler);
          listeners.set(type, existing);
          return () => {};
        },
      },
      orchestrator: {
        handleUserInput: async (): Promise<void> => {
          for (const handler of listeners.get('TURN_COMPLETED') ?? []) {
            handler({ payload: { type: 'TURN_COMPLETED', response: 'local answer', stopReason: 'completed' } });
          }
        },
      },
    } as unknown as BootstrapContext;

    const result = await executeRunTurn({
      ctx,
      prompt: 'go',
      outputFormat: undefined,
      stdout: out.write,
      stderr: () => {},
      createRouting: harness.createRouting,
    });

    expect(result.routed).toBe(false);
    expect(result.exitCode).toBe(0);
    expect(result.response).toBe('local answer');
    // Never silent about where the turn ran.
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain('no operator token has been written yet.');
    // …and the notice did NOT go to stdout, which is a parsing contract.
    expect(out.lines).toEqual([]);
  });
});

describe('the output shapes are the same wherever the turn ran', () => {
  const result: RunTurnResult = {
    exitCode: 0,
    response: 'hello',
    error: '',
    stopReason: 'completed',
    eventCount: 3,
    routed: true,
  };

  test('text output is the response alone', () => {
    const out = collector();
    writeRunTurnResult(result, { ctx: inertCtx(), outputFormat: undefined, stdout: out.write });
    expect(out.lines).toEqual(['hello']);
  });

  test('json output carries the session identity the run used', () => {
    const out = collector();
    writeRunTurnResult(result, { ctx: inertCtx(), outputFormat: 'json', stdout: out.write });
    const payload = JSON.parse(out.lines[0] as string) as Record<string, unknown>;
    expect(payload).toMatchObject({
      ok: true,
      response: 'hello',
      stopReason: 'completed',
      sessionId: 'run-session',
      model: 'claude-opus-5',
      provider: 'anthropic',
      events: 3,
    });
    expect(payload.error).toBeUndefined();
  });

  test('a failing run prints the error, not the response', () => {
    const out = collector();
    writeRunTurnResult(
      { ...result, exitCode: 1, response: '', error: 'it broke' },
      { ctx: inertCtx(), outputFormat: undefined, stdout: out.write },
    );
    expect(out.lines).toEqual(['it broke']);
  });
});
