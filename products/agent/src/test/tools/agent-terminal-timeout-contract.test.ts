/**
 * `terminal` timeoutMs must not be a default route to destroying a running
 * application.
 *
 * The tool is documented as starting visible tracked background commands, and a
 * routine 120s `timeoutMs` silently SIGKILLed a running browser. The model
 * picked a poor value, but the contract made tearing down a user-facing
 * application the ordinary outcome of a normal parameter, and nothing was
 * logged or reported to say that had happened.
 *
 * Three things are pinned here: a long-lived class a timeout does not kill, an
 * explicit `killOnTimeout` opt-in that overrides the class either way, and a
 * process record that distinguishes "the timeout killed it" from "somebody
 * cancelled it".
 */
import { afterAll, afterEach, beforeEach, describe, test, expect } from 'bun:test';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { gateJudgmentRegistry } from '@goodvibes-jev/engine/sdk/platform/gate';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import type { Battery, YesNoItem } from '@goodvibes-jev/judgment';
import type { BackgroundProcess } from '@goodvibes-jev/engine/sdk/platform/tools';
import { ordinaryResearchOwner, cleanupResearchScreeningFixtures } from '../helpers/research-screening.ts';
import {
  resolveBackgroundProcessClass,
  resolveKillOnTimeout, clampTimeout, DEFAULT_BACKGROUND_TIMEOUT_MS, MAX_BACKGROUND_TIMEOUT_MS, processAgeMs, processStatus,
} from '@/tools/agent-harness-process-timeout-policy.ts';
import type { AgentHarnessBackgroundProcessArgs } from '@/tools/agent-harness-background-processes-types.ts';

const args = (extra: Record<string, unknown> = {}): AgentHarnessBackgroundProcessArgs =>
  extra as AgentHarnessBackgroundProcessArgs;

afterAll(cleanupResearchScreeningFixtures);
let previous: ReturnType<typeof installJudgmentPort>;
beforeEach(() => { previous = installJudgmentPort(undefined); });
afterEach(() => { installJudgmentPort(previous); });
const options = () => ({ sourceOwner: ordinaryResearchOwner() });
function reading(p: number) { const fake = fakePort(() => noulAnswer(p)); installJudgmentPort(fake.port); return fake; }

describe('terminal: process classification', () => {
  const longLived = [
    'brave --new-window https://example.com',
    'firefox',
    '/usr/bin/google-chrome --remote-debugging-port=9222',
    'chromium-browser about:blank',
    'code /home/u/project',
    'xdg-open report.pdf',
    'libreoffice report.odt', 'vlc movie.mp4', 'npm run dev', 'python -m http.server',
    'env firefox', 'flatpak run org.mozilla.firefox', 'sh -c "env firefox"',
  ];

  for (const command of longLived) {
    test(`classifies as long_lived: ${command}`, async () => {
      const fake = reading(0.99);
      expect(await resolveBackgroundProcessClass(args(), command, options())).toBe('long_lived');
      expect(fake.requests).toHaveLength(1);
      expect(fake.requests[0]?.context?.battery).toBe('agent.tools.long-lived-process');
      expect(fake.requests[0]?.state).toEqual({ command, platform: process.platform });
    });
  }

  const ordinary = [
    'bun test',
    'npm run build',
    'sleep 30',
    'tail -f /var/log/syslog',
    // A browser named only in an argument must not reclassify the command.
    'grep -r firefox /etc',
    'echo "open chrome"',
  ];

  for (const command of ordinary) {
    test(`classifies as command: ${command}`, async () => {
      reading(0.01);
      expect(await resolveBackgroundProcessClass(args(), command, options())).toBe('command');
    });
  }

  test('explicit enum and field overrides require neither an owner nor a judgment port', async () => {
    expect(await resolveBackgroundProcessClass(args({ processClass: 'command' }), 'firefox')).toBe('command');
    expect(await resolveBackgroundProcessClass(args({ processClass: 'long_lived' }), 'bun test')).toBe('long_lived');
    expect(await resolveBackgroundProcessClass(args({ fields: { processClass: 'long_lived' } }), 'bun test')).toBe('long_lived');
    expect(await resolveBackgroundProcessClass(args({ processClass: 'command', fields: { processClass: 'long_lived' } }), 'firefox')).toBe('command');
  });

  test('the reading, not program-name or argument heuristics, controls both directions', async () => {
    reading(0.01);
    expect(await resolveBackgroundProcessClass(args(), 'firefox', options())).toBe('command');
    reading(0.99);
    expect(await resolveBackgroundProcessClass(args(), 'unfamiliar-launcher', options())).toBe('long_lived');
  });

  test('invalid explicit classes still use the canonical reading', async () => {
    const fake = reading(0.99);
    expect(await resolveBackgroundProcessClass(args({ processClass: 'LONG_LIVED' }), 'npm run dev', options())).toBe('long_lived');
    expect(fake.requests).toHaveLength(1);
  });

  test('every canonical fixture exercises the registered battery with explicit scripted answers', async () => {
    const battery = gateJudgmentRegistry.get('agent.tools.long-lived-process') as Battery<{ long_lived: YesNoItem }>;
    expect(battery).toBeDefined();
    const fake = fakePort((_name, _question, state) => {
      const fixture = battery.fixtures.find(value => JSON.stringify(value.state) === JSON.stringify(state));
      if (!fixture) throw new Error('Unscripted process fixture');
      return noulAnswer(fixture.expect.long_lived === 'yes' ? 0.99 : 0.01);
    });
    const checks = await battery.checkFixtures(fake.port);
    expect(checks.every(check => check.correct)).toBe(true);
    expect(fake.requests).toHaveLength(battery.fixtures.length);
  });
});

describe('terminal: kill-on-timeout is opt-in for anything long-lived', () => {
  test('a long-lived process is not killed by a timeout by default', () => {
    expect(resolveKillOnTimeout(args(), 'long_lived')).toBe(false);
  });

  test('an ordinary command is still killed by its timeout', () => {
    expect(resolveKillOnTimeout(args(), 'command')).toBe(true);
  });

  test('killOnTimeout:true opts a long-lived process back in', () => {
    expect(resolveKillOnTimeout(args({ killOnTimeout: true }), 'long_lived')).toBe(true);
  });

  test('killOnTimeout:false spares an ordinary command', () => {
    expect(resolveKillOnTimeout(args({ killOnTimeout: false }), 'command')).toBe(false);
  });

  test('the string forms of the flag are honored', () => {
    expect(resolveKillOnTimeout(args({ killOnTimeout: 'true' }), 'long_lived')).toBe(true);
    expect(resolveKillOnTimeout(args({ killOnTimeout: 'false' }), 'command')).toBe(false);
  });

  test('the browser incident: a browser with a routine timeout survives', async () => {
    reading(0.99);
    const command = 'brave --new-window https://example.com';
    const processClass = await resolveBackgroundProcessClass(args({ timeoutMs: 120_000 }), command, options());
    expect(processClass).toBe('long_lived');
    expect(resolveKillOnTimeout(args({ timeoutMs: 120_000 }), processClass)).toBe(false);
  });
});


describe('terminal: deterministic timeout arithmetic and explicit flags', () => {
  test('only boolean and exact string kill overrides win', () => {
    for (const value of [true, 'true']) expect(resolveKillOnTimeout(args({ killOnTimeout: value }), 'long_lived')).toBe(true);
    for (const value of [false, 'false']) expect(resolveKillOnTimeout(args({ killOnTimeout: value }), 'command')).toBe(false);
    for (const value of ['TRUE', ' false ', 0, 1, '', null]) expect(resolveKillOnTimeout(args({ killOnTimeout: value }), 'command')).toBe(true);
    expect(resolveKillOnTimeout(args({ fields: { killOnTimeout: 'false' } }), 'command')).toBe(false);
    expect(resolveKillOnTimeout(args({ killOnTimeout: true, fields: { killOnTimeout: 'false' } }), 'command')).toBe(true);
  });
  test('clamps preserve default, truncation and one-second/eight-hour limits', () => {
    expect(clampTimeout(undefined, DEFAULT_BACKGROUND_TIMEOUT_MS)).toBe(30 * 60 * 1000);
    expect(clampTimeout('120000.9', 5000)).toBe(120000);
    expect(clampTimeout(-1, 5000)).toBe(1000);
    expect(clampTimeout(Number.MAX_SAFE_INTEGER, 5000)).toBe(MAX_BACKGROUND_TIMEOUT_MS);
    expect(clampTimeout(NaN, 5000)).toBe(5000);
  });
  test('OS exit status, timeout flag, and elapsed time remain mechanical', () => {
    const process = (extra: object) => ({ done: true, exitCode: null, startTime: 100, ...extra }) as BackgroundProcess;
    expect(processStatus(process({ done: false }))).toBe('running');
    expect(processStatus(process({ exitCode: 0, timedOut: true }))).toBe('succeeded');
    expect(processStatus(process({ timedOut: true }))).toBe('timed_out');
    expect(processStatus(process({}))).toBe('cancelled');
    expect(processStatus(process({ exitCode: 2 }))).toBe('failed');
    expect(processAgeMs(process({ completedAt: 250 }), 1000)).toBe(150);
    expect(processAgeMs(process({}), 200)).toBe(100);
    expect(processAgeMs(process({}), 50)).toBe(0);
  });
});
