import { afterEach, describe, expect, test } from 'bun:test';
import { installProcessLifecycle, type ProcessLifecycleDeps } from '../../runtime/process-lifecycle.ts';
import { installUserErrorReading, flushErrorNotices } from '../helpers/user-error-reading.ts';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
const restores: Array<() => void> = [];
afterEach(() => { while (restores.length) restores.pop()!(); });
import type { BootstrapContext } from '../../runtime/bootstrap.ts';

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
    getInput: () => { throw new Error('not used'); },
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
  return { handle: handlers.unhandledRejectionHandler, restoreTerminal: handlers.restoreTerminal, messages, runtime };
}

describe('unhandledRejection labeling', () => {
  test('an unclassifiable rejection is called a GoodVibes bug, not a provider error', async () => {
    restores.push(installUserErrorReading());
    const { handle, messages } = makeHandler();
    handle(new ReferenceError("Cannot access 'render' before initialization"));
    await flushErrorNotices();
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatch(/GoodVibes bug/);
    expect(messages[0]).not.toMatch(/provider error/i);
    expect(messages[0]).toContain("Cannot access 'render' before initialization");
  });

  test('a classifiable rejection keeps its specific line', async () => {
    restores.push(installUserErrorReading());
    const { handle, messages } = makeHandler();
    restores.push(installUserErrorReading('network'));
    handle(new Error('fetch failed'));
    await flushErrorNotices();
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatch(/network error/i);
    expect(messages[0]).not.toMatch(/GoodVibes bug/);
  });

  test('a provider-shaped 5xx is never blamed on GoodVibes', async () => {
    restores.push(installUserErrorReading());
    // The classifier has no 5xx rule, so a provider outage classifies
    // generic; the provider/statusCode markers are what keep the caption
    // honest.
    const { handle, messages } = makeHandler();
    const outage = Object.assign(new Error('OpenAI Codex API error 503: Service Unavailable'), {
      provider: 'openai-subscriber',
      statusCode: 503,
    });
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
    const previous = installJudgmentPort({ model: 'jev-1.13.0', ask: () => pending });
    restores.push(() => installJudgmentPort(previous));
    const f = makeHandler(); f.handle(new Error('late failure')); await flushErrorNotices();
    if (boundary === 'terminal restore') f.restoreTerminal(); else f.runtime.sessionId = 'session-b';
    reject(new Error('reading failed too')); await flushErrorNotices();
    expect(f.messages).toEqual([]);
    f.restoreTerminal(); f.handle(new Error('after closing')); await flushErrorNotices();
    expect(f.messages).toEqual([]);
  });
}

test('a rejecting rejection reader has one neutral delivery and no unhandled recursion', async () => {
  let calls = 0;
  const previous = installJudgmentPort({ model: 'jev-1.13.0', async ask() { calls++; throw new Error('reader failed'); } });
  restores.push(() => installJudgmentPort(previous));
  const f = makeHandler(); f.handle(new Error('401 timeout'));
  await flushErrorNotices(); await flushErrorNotices();
  expect(calls).toBe(1); expect(f.messages).toEqual(['[Error] Error details unavailable. Original error: 401 timeout']);
  f.restoreTerminal();
});

test('an indefinitely pending rejection reader has a bounded neutral delivery', async () => {
  const previous = installJudgmentPort({ model: 'jev-1.13.0', ask: () => new Promise(() => {}) });
  restores.push(() => installJudgmentPort(previous));
  const f = makeHandler(5); f.handle(new Error('pending failure'));
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(f.messages).toEqual(['[Error] Error details unavailable. Original error: pending failure']); f.restoreTerminal();
});

test('cascading critical rejection supersedes pending individual readings', async () => {
  let reject!: (error: unknown) => void;
  const pending = new Promise<never>((_resolve, r) => { reject = r; });
  const previous = installJudgmentPort({ model: 'jev-1.13.0', ask: () => pending });
  restores.push(() => installJudgmentPort(previous));
  const f = makeHandler();
  for (let i = 1; i <= 4; i++) f.handle(new Error(`failure ${i}`));
  expect(f.messages).toHaveLength(1); expect(f.messages[0]).toContain('[Critical]');
  reject(new Error('reader cancelled')); await flushErrorNotices();
  expect(f.messages).toHaveLength(1); f.restoreTerminal();
});

test('process rejection preserves typed status and errno, while words alone follow the reader', async () => {
  restores.push(installUserErrorReading());
  for (const [reason, expected] of [
    [{ status: 401 }, 'Authentication failed'],
    [{ statusCode: 429, message: 'quota denied by typed API' }, 'Rate limit reached'],
    [{ code: 'ETIMEDOUT', message: 'transport' }, 'Network error'],
    [new Error('Documentation mentions 401, 429, quota and timeout'), 'Unexpected error'],
  ] as const) {
    const f = makeHandler(); f.handle(reason); await flushErrorNotices();
    expect(f.messages).toHaveLength(1); expect(f.messages[0]).toContain(expected); f.restoreTerminal();
  }
});
