/**
 * terminal-focus-mode.ts tests, the ?1004h teardown safety net and
 * the approval-alert wiring that consumes the ported FocusTracker.
 *
 * TEARDOWN PROOF (named top-5 risk in the risk matrix): ?1004h MUST be disabled on
 * every exit path or the user's shell inherits focus-reporting escape
 * garbage. installFocusModeExitGuard registers a real `process.on('exit', ...)`
 * listener, Node/Bun fire 'exit' listeners synchronously for EVERY process
 * termination path this app can take, including the default uncaughtException
 * termination, without this file registering an explicit uncaughtException
 * handler of its own. These tests invoke the registered listener directly
 * (never process.exit() itself, which would kill the test runner) to prove
 * the write happens, then clean up the listener so it doesn't leak into other
 * test files' process-level state.
 */
import { describe, expect, test, afterEach } from 'bun:test';
import {
  FOCUS_DISABLE,
  FOCUS_ENABLE,
  installFocusModeExitGuard,
  wrapRequestPermissionWithApprovalAlert,
} from '../../shell/terminal-focus-mode.ts';
import { FocusTracker } from '@/runtime/index.ts';
import type { PermissionPromptRequest } from '@goodvibes-jev/engine/sdk/platform/permissions';

describe('FOCUS_ENABLE / FOCUS_DISABLE constants', () => {
  test('match the DECSET ?1004h sequences (product parity with goodvibes-tui)', () => {
    expect(FOCUS_ENABLE).toBe('\x1b[?1004h');
    expect(FOCUS_DISABLE).toBe('\x1b[?1004l');
  });
});

describe('installFocusModeExitGuard: ?1004h teardown proof', () => {
  const installedListeners: Array<() => void> = [];

  afterEach(() => {
    // Never let a test-installed 'exit' listener leak into other test files.
    for (const fn of installedListeners.splice(0)) {
      process.removeListener('exit', fn as never);
    }
  });

  function installAndCapture(
    stdout: Pick<NodeJS.WriteStream, 'write'>,
    isFocusModeEnabled: () => boolean = () => true,
  ): () => void {
    const before = new Set(process.listeners('exit'));
    installFocusModeExitGuard(stdout, isFocusModeEnabled);
    const after = process.listeners('exit');
    const installed = after.find((fn) => !before.has(fn)) as (() => void) | undefined;
    if (!installed) throw new Error('installFocusModeExitGuard did not register an exit listener');
    installedListeners.push(installed);
    return installed;
  }

  test('the registered exit listener writes FOCUS_DISABLE: proves every process.exit() path (normal exit) disables OS focus reporting', () => {
    const written: string[] = [];
    const stub = { write: (s: string) => { written.push(s); return true; } };
    const listener = installAndCapture(stub);

    // Simulate what Node/Bun do at process termination WITHOUT actually exiting
    // the test runner: invoke the registered 'exit' listener directly. Node
    // fires this exact listener synchronously for explicit process.exit()
    // calls (this app's normal /exit and double-Ctrl+C exitApp() path).
    listener();

    expect(written.join('')).toContain(FOCUS_DISABLE);
  });

  test('the same listener also covers the crash-path: Node fires \'exit\' listeners for the default uncaughtException termination too, with no separate handler needed', () => {
    // This test documents the crash-path coverage claim rather than actually
    // crashing the process: Node's documented 'exit' event contract fires for
    // ANY process termination reachable via process.exit() internally,
    // including the default uncaughtException handler's exit(1), so the same
    // listener that covers normal exit and SIGINT (via this app's existing
    // sigintHandler -> eventual exitApp() -> process.exit()) covers the
    // crash-path too, with no separate uncaughtException/SIGTERM handler
    // required in main.ts.
    const written: string[] = [];
    const stub = { write: (s: string) => { written.push(s); return true; } };
    const listener = installAndCapture(stub);
    listener(); // best-effort: same code path Node invokes pre-crash-exit
    expect(written.join('')).toContain(FOCUS_DISABLE);
  });

  test('a torn-down stdout (write throws) never propagates: the teardown itself must not crash exit handling', () => {
    const stub = { write: () => { throw new Error('EPIPE'); } };
    const listener = installAndCapture(stub);
    expect(() => listener()).not.toThrow();
  });

  test('writes NOTHING when ?1004h was never enabled (blocked/scriptable command, or the terminal-launch-error path before terminal mode is entered): a stray ?1004l on stdout is escape garbage that would corrupt e.g. `status --json`', () => {
    const written: string[] = [];
    const stub = { write: (s: string) => { written.push(s); return true; } };
    const listener = installAndCapture(stub, () => false); // focus mode never enabled this run
    listener();
    listener(); // calling twice still writes nothing
    expect(written.length).toBe(0);
  });

  test('once ?1004h WAS enabled, the guard still fires idempotently on repeated exit-listener invocations', () => {
    const written: string[] = [];
    const stub = { write: (s: string) => { written.push(s); return true; } };
    const listener = installAndCapture(stub, () => true);
    listener();
    listener();
    expect(written.filter((s) => s === FOCUS_DISABLE).length).toBe(2);
  });
});

describe('wrapRequestPermissionWithApprovalAlert', () => {
  function makeRequest(): PermissionPromptRequest {
    return {
      callId: 'call-1',
      tool: 'shell',
      args: {},
      category: 'shell' as PermissionPromptRequest['category'],
      analysis: {} as PermissionPromptRequest['analysis'],
    };
  }

  test('fires the notify callback when the terminal is unfocused-or-unknown (honest fallback: never observed = alert)', async () => {
    const focusTracker = new FocusTracker(); // isFocused() starts null, "unknown"
    const notified: Array<{ title: string; message: string; durationMs: number }> = [];
    const original = async (request: PermissionPromptRequest) => ({ approved: true, remember: false, request });
    const wrapped = wrapRequestPermissionWithApprovalAlert(original as never, {
      focusTracker,
      notify: (title, message, durationMs) => { notified.push({ title, message, durationMs }); },
    });

    const request = makeRequest();
    const result = await wrapped(request);

    expect(notified.length).toBe(1);
    expect(notified[0]!.message).toBe('A tool is waiting for approval');
    // Unknown tool metadata stays generic; no args or command strings leak.
    expect(notified[0]!.message).not.toContain('args');
    expect((result as { approved: boolean }).approved).toBe(true); // original handler's resolution is unchanged
  });

  test('fires when the terminal is known to be unfocused', async () => {
    const focusTracker = new FocusTracker();
    focusTracker.setFocused(false);
    const notified: unknown[] = [];
    const original = async () => ({ approved: false, remember: false });
    const wrapped = wrapRequestPermissionWithApprovalAlert(original as never, {
      focusTracker,
      notify: () => { notified.push(true); },
    });
    await wrapped(makeRequest());
    expect(notified.length).toBe(1);
  });

  test('does NOT fire when the terminal is known to be focused', async () => {
    const focusTracker = new FocusTracker();
    focusTracker.setFocused(true);
    const notified: unknown[] = [];
    const original = async () => ({ approved: false, remember: false });
    const wrapped = wrapRequestPermissionWithApprovalAlert(original as never, {
      focusTracker,
      notify: () => { notified.push(true); },
    });
    await wrapped(makeRequest());
    expect(notified.length).toBe(0);
  });

  test('a notify() that throws never breaks the wrapped permission promise', async () => {
    const focusTracker = new FocusTracker();
    const original = async () => ({ approved: true, remember: false });
    const wrapped = wrapRequestPermissionWithApprovalAlert(original as never, {
      focusTracker,
      notify: () => { throw new Error('desktop notify unavailable'); },
    });
    const result = await wrapped(makeRequest());
    expect((result as { approved: boolean }).approved).toBe(true);
  });
});
