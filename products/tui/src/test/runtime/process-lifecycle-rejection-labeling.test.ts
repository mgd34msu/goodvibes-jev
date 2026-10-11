import { afterEach, describe, expect, test } from 'bun:test';
import { isDeepStrictEqual } from 'node:util';
import { installProcessLifecycle, type ProcessLifecycleDeps } from '../../runtime/process-lifecycle.ts';
import { publicErrorTextAnswer, preparePublicErrorText, flushErrorNotices } from '../helpers/user-error-reading.ts';
import { failureReading, failureState, installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { userErrorEvidence, userErrorReading } from '@goodvibes-jev/engine/sdk/platform/routing';
import { choiceAnswer, fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import type { JudgmentPort } from '@goodvibes-jev/judgment';
import type { BootstrapContext } from '../../runtime/bootstrap.ts';
const restores: Array<() => void> = [];
afterEach(() => { while (restores.length) restores.pop()!(); });

async function installRejectionReading(reasons: readonly unknown[], options: {
  kind?: 'network'; pending?: Promise<never>; rejection?: Error;
} = {}) {
  const lines = reasons.flatMap((reason) => reason instanceof Error ? [reason.message] : []);
  const states = reasons.map((reason) => failureState(userErrorEvidence(reason).evidence));
  const questions = Object.fromEntries([
    ...Object.entries(failureReading.items).map(([name, item]) => [`failure__${name}`, item.question]),
    ...Object.entries(userErrorReading.items).map(([name, item]) => [`user__${name}`, item.question]),
  ]);
  const fake = fakePort((name, question, state) => {
    const publicText = publicErrorTextAnswer(lines, name, question, state);
    if (publicText !== undefined) return publicText;
    if (!states.some((expected) => isDeepStrictEqual(expected, state)) || !isDeepStrictEqual(questions[name], question)) {
      throw new Error('Unexpected rejection fixture reading');
    }
    if (question.type === 'choice') return choiceAnswer(question,
      name === 'failure__category' ? options.kind === 'network' ? 'network' : 'unknown' : 'none', 0.99);
    return noulAnswer(name === 'failure__transient_network' && options.kind === 'network' ? 0.99 : 0.01);
  });
  const requests: Array<readonly string[]> = [];
  const port: JudgmentPort = {
    model: fake.port.model,
    async ask(request) {
      if (request.context?.site === 'tui.unhandled-rejection') {
        if (!states.some((expected) => isDeepStrictEqual(expected, request.state)) || !isDeepStrictEqual(request.questions, questions)) {
          throw new Error('Unexpected rejection fixture request');
        }
        requests.push(Object.keys(request.questions));
        if (options.rejection) throw options.rejection;
        if (options.pending) return options.pending;
      }
      return fake.port.ask(request);
    },
  };
  const previous = installJudgmentPort(port);
  restores.push(() => installJudgmentPort(previous));
  await preparePublicErrorText(lines);
  return { requests };
}

/**
 * What an escaped promise rejection is CALLED. The generic formatter used to
 * caption every unclassifiable rejection "Provider error", which shipped a
 * startup UI crash ("Cannot access 'render' before initialization") dressed
 * as a model-backend failure. An unhandled rejection with no recognizable
 * provider signature is a GoodVibes bug and must say so; one that IS
 * classifiable (auth, network...) keeps its specific line.
 */

function makeHandler(timeoutMs?: number) {
  const messages: string[] = [];
  const runtime = { sessionId: 'session-a' };
  const ctx = {
    runtime,
    systemMessageRouter: { high: (m: string) => { messages.push(m); }, low: () => {} },
  } as unknown as BootstrapContext;
  const deps = {
    stdin: { setRawMode: () => {}, removeAllListeners: () => {} },
    stdout: { write: () => true, removeListener: () => {} },
    ctx,
    noAltScreen: false,
    ansi: { CLEAR_SCREEN: '', ALT_SCREEN_EXIT: '', PASTE_DISABLE: '', KEYBOARD_EXT_DISABLE: '', MOUSE_DISABLE: '', CURSOR_SHOW: '', FOCUS_DISABLE: '' },
    getInput: () => ({}),
    render: () => {},
    getTerminalOutputGuard: () => ({ dispose: () => {} }),
    getPromptContentWidth: () => 80,
    buildSessionContinuityHints: () => ({}),
    unsubs: [],
    errorNoticeTimeoutMs: timeoutMs,
    getRecoveryInterval: () => null,
    setRecoveryInterval: () => {},
    getStopSpokenOutputForExit: () => null,
  } as unknown as ProcessLifecycleDeps;
  const handlers = installProcessLifecycle(deps);
  restores.push(handlers.restoreTerminal);
  return { handle: handlers.unhandledRejectionHandler, restoreTerminal: handlers.restoreTerminal, messages, runtime };
}

describe('unhandledRejection labeling', () => {
  test('an unclassifiable rejection is called a GoodVibes bug, not a provider error', async () => {
    const reason = new ReferenceError("Cannot access 'render' before initialization");
    await installRejectionReading([reason]);
    const { handle, messages } = makeHandler();
    handle(reason);
    await flushErrorNotices();
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatch(/GoodVibes bug/);
    expect(messages[0]).not.toMatch(/provider error/i);
    expect(messages[0]).toContain("Cannot access 'render' before initialization");
  });

  test('a classifiable rejection keeps its specific line', async () => {
    const reason = new Error('fetch failed');
    await installRejectionReading([reason], { kind: 'network' });
    const { handle, messages } = makeHandler();
    handle(reason);
    await flushErrorNotices();
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatch(/network error/i);
    expect(messages[0]).not.toMatch(/GoodVibes bug/);
  });

  test('a provider-shaped 5xx is never blamed on GoodVibes', async () => {
    // The classifier has no 5xx rule, so a provider outage classifies
    // generic; the provider/statusCode markers are what keep the caption
    // honest.
    const { handle, messages } = makeHandler();
    const outage = Object.assign(new Error('OpenAI Codex API error 503: Service Unavailable'), {
      provider: 'openai-subscriber',
      statusCode: 503,
    });
    await installRejectionReading([outage]);
    handle(outage);
    await flushErrorNotices();
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatch(/Unexpected error/);
    expect(messages[0]).not.toMatch(/GoodVibes bug/);
    expect(messages[0]).toMatch(/\/model/);
  });
});

for (const boundary of ['terminal restore', 'session switch'] as const) {
  test(`delayed rejection cannot repaint after ${boundary}`, async () => {
    let reject!: (error: unknown) => void;
    const pending = new Promise<never>((_resolve, r) => { reject = r; });
    const reason = new Error('late failure');
    const reading = await installRejectionReading([reason], { pending });
    const f = makeHandler(); f.handle(reason); await flushErrorNotices();
    expect(reading.requests).toHaveLength(1);
    if (boundary === 'terminal restore') f.restoreTerminal(); else f.runtime.sessionId = 'session-b';
    reject(new Error('reading failed too')); await flushErrorNotices();
    expect(f.messages).toEqual([]);
    f.restoreTerminal(); f.handle(new Error('after closing')); await flushErrorNotices();
    expect(f.messages).toEqual([]);
  });
}

test('a rejecting rejection reader has one neutral delivery and no unhandled recursion', async () => {
  const reason = new Error('401 timeout');
  const reading = await installRejectionReading([reason], { rejection: new Error('reader failed') });
  const f = makeHandler(); f.handle(reason);
  await flushErrorNotices(); await flushErrorNotices();
  expect(reading.requests).toHaveLength(1); expect(f.messages).toEqual(['[Error] Error details unavailable. Original error: 401 timeout']);
  f.restoreTerminal();
});

test('an indefinitely pending rejection reader has a bounded neutral delivery', async () => {
  const reason = new Error('pending failure');
  const reading = await installRejectionReading([reason], { pending: new Promise<never>(() => {}) });
  const f = makeHandler(5); f.handle(reason);
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(reading.requests).toHaveLength(1);
  expect(f.messages).toEqual(['[Error] Error details unavailable. Original error: pending failure']); f.restoreTerminal();
});

test('cascading critical rejection supersedes pending individual readings', async () => {
  let reject!: (error: unknown) => void;
  const pending = new Promise<never>((_resolve, r) => { reject = r; });
  const reasons = [1, 2, 3, 4].map((i) => new Error(`failure ${i}`));
  const reading = await installRejectionReading(reasons, { pending });
  const f = makeHandler();
  for (const reason of reasons) f.handle(reason);
  expect(reading.requests).toHaveLength(3);
  expect(f.messages).toHaveLength(1); expect(f.messages[0]).toContain('[Critical]');
  reject(new Error('reader cancelled')); await flushErrorNotices();
  expect(f.messages).toHaveLength(1); f.restoreTerminal();
});

test('process rejection preserves typed status and errno, while words alone follow the reader', async () => {
  const cases = [
    [{ status: 401 }, 'Authentication failed'],
    [{ statusCode: 429, message: 'quota denied by typed API' }, 'Rate limit reached'],
    [{ code: 'ETIMEDOUT', message: 'transport' }, 'Network error'],
    [new Error('Documentation mentions 401, 429, quota and timeout'), 'Unexpected error'],
  ] as const;
  await installRejectionReading(cases.map(([reason]) => reason));
  for (const [reason, expected] of cases) {
    const f = makeHandler(); f.handle(reason); await flushErrorNotices();
    expect(f.messages).toHaveLength(1); expect(f.messages[0]).toContain(expected); f.restoreTerminal();
  }
});
