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
import { describe, test, expect } from 'bun:test';
import {
  resolveBackgroundProcessClass,
  resolveKillOnTimeout,
} from '@/tools/agent-harness-process-timeout-policy.ts';
import type { AgentHarnessBackgroundProcessArgs } from '@/tools/agent-harness-background-processes-types.ts';

const args = (extra: Record<string, unknown> = {}): AgentHarnessBackgroundProcessArgs =>
  extra as AgentHarnessBackgroundProcessArgs;

describe('terminal: process classification', () => {
  const longLived = [
    'brave --new-window https://example.com',
    'firefox',
    '/usr/bin/google-chrome --remote-debugging-port=9222',
    'chromium-browser about:blank',
    'code /home/u/project',
    'xdg-open report.pdf',
  ];

  for (const command of longLived) {
    test(`classifies as long_lived: ${command}`, () => {
      expect(resolveBackgroundProcessClass(args(), command)).toBe('long_lived');
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
    test(`classifies as command: ${command}`, () => {
      expect(resolveBackgroundProcessClass(args(), command)).toBe('command');
    });
  }

  test('an explicit processClass overrides the inference in both directions', () => {
    expect(resolveBackgroundProcessClass(args({ processClass: 'command' }), 'firefox')).toBe('command');
    expect(resolveBackgroundProcessClass(args({ processClass: 'long_lived' }), 'bun test')).toBe('long_lived');
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

  test('the browser incident: a browser with a routine timeout survives', () => {
    const command = 'brave --new-window https://example.com';
    const processClass = resolveBackgroundProcessClass(args({ timeoutMs: 120_000 }), command);
    expect(processClass).toBe('long_lived');
    expect(resolveKillOnTimeout(args({ timeoutMs: 120_000 }), processClass)).toBe(false);
  });
});
