/**
 * (c) A first turn through the built binary: typing a prompt and pressing
 * Enter reaches the model with that prompt, and the model's reply is drawn in
 * the transcript.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { startE2ENativeHost } from './native-host-fixture.ts';
import { inputAreaVisible, isolatedEnv, lastUserText, launchTui, makeHome, resolveBinary, screenText, startStubModel, type TuiSession } from './harness.ts';

const PROMPT = 'give this project a code review';
const REPLY = 'I will review the project code.';

const model = startStubModel((request) => (
  lastUserText(request).includes(PROMPT) ? { text: REPLY } : { text: 'E2E side request' }
));
let tui: TuiSession | null = null;
let host: Awaited<ReturnType<typeof startE2ENativeHost>> | null = null;
afterAll(async () => { try { await tui?.stop(); } finally { try { await host?.stop(); } finally { model.stop(); } } });

describe('first turn', () => {
  test('a code-review prompt reaches the model from the composer and CLI without native admission', async () => {
    const home = await makeHome(model);
    host = await startE2ENativeHost(home);
    tui = launchTui(home, { cols: 100, rows: 30, env: host.env });
    await tui.waitForScreen('the input area', inputAreaVisible, 45_000);

    tui.type(PROMPT);
    tui.key('Enter');

    const screen = await tui.waitForScreen('the scripted reply', (s) => screenText(s).includes(REPLY), 45_000);
    expect(model.requests.some((request) => lastUserText(request).includes(PROMPT))).toBe(true);
    expect(screenText(screen)).toContain(PROMPT);
    expect(tui.alive()).toBe(true);
    expect(host.judgments.accepted).not.toContain('native-route');
    expect(host.judgments.accepted).not.toContain('native-turn');
    expect(host.judgments.accepted).not.toContain('route');
    expect(host.judgments.accepted).not.toContain('turn');
    expect(host.daemon.services.contractRunner.list({ includeTerminal: true })).toHaveLength(0);
    expect(host.daemon.services.agentManager.list()).toHaveLength(0);
    await tui.stop();
    const child = Bun.spawn([resolveBinary(), '--prompt', PROMPT, '--output-format', 'json'], {
      cwd: home.workspace, env: isolatedEnv(home, host.env), stdout: 'pipe', stderr: 'pipe',
    });
    const timeout = setTimeout(() => child.kill('SIGKILL'), 45_000);
    try {
      const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      expect({ exitCode, stderr: exitCode ? stderr : '' }).toEqual({ exitCode: 0, stderr: '' });
      expect(JSON.parse(stdout)).toMatchObject({ ok: true, response: REPLY });
      expect(host.judgments.accepted).not.toContain('native-route');
      expect(host.judgments.accepted).not.toContain('native-turn');
    } finally { clearTimeout(timeout); if (child.exitCode === null) child.kill('SIGKILL'); await child.exited; }
  }, 100_000);
});
