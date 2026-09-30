import { describe, expect, test } from 'bun:test';
import { DAEMON_COMMANDS } from '../../cli/command-catalog.ts';
import {
  COMPLETION_SHELLS,
  completionCommandWords,
  completionFlagsFor,
  renderCompletionScript,
  runCompletionCommand,
} from '../../cli/completion.ts';

describe('the completion scripts are generated from the catalog', () => {
  test.each([...COMPLETION_SHELLS])('the %s script offers every command', (shell) => {
    const script = renderCompletionScript(shell, 'goodvibes-daemon');
    for (const spec of DAEMON_COMMANDS) {
      expect(script).toContain(spec.name);
    }
  });

  test.each([...COMPLETION_SHELLS])('the %s script offers every alias', (shell) => {
    const script = renderCompletionScript(shell, 'goodvibes-daemon');
    // fish completes command names only; bash and zsh carry the aliases too.
    if (shell === 'fish') return;
    for (const alias of ['session', 'qr', 'qrcode', 'completions']) {
      expect(script).toContain(alias);
    }
  });

  test.each([...COMPLETION_SHELLS])('the %s script offers sub-words and flags', (shell) => {
    const script = renderCompletionScript(shell, 'goodvibes-daemon');
    for (const word of ['list', 'kill', 'get', 'set', 'unset', 'enable', 'disable']) {
      expect(script).toContain(word);
    }
    for (const flag of ['json', 'host', 'port', 'token', 'daemon-home']) {
      expect(script).toContain(flag);
    }
  });

  test('the bash script defines and registers a completion function for the binary', () => {
    const script = renderCompletionScript('bash', 'goodvibes-daemon');
    expect(script).toContain('_goodvibes_daemon_complete() {');
    expect(script).toContain('complete -F _goodvibes_daemon_complete goodvibes-daemon');
  });

  test('the zsh script carries the compdef line for the binary', () => {
    const script = renderCompletionScript('zsh', 'goodvibes-daemon');
    expect(script.startsWith('#compdef goodvibes-daemon')).toBe(true);
    expect(script).toContain('_describe -t commands');
  });

  test('the fish script guards command completion to the no-command position', () => {
    const script = renderCompletionScript('fish', 'goodvibes-daemon');
    expect(script).toContain('function __goodvibes_daemon_no_command');
    expect(script).toContain("complete -c goodvibes-daemon -n '__goodvibes_daemon_no_command'");
  });

  test('a renamed binary produces a script for that name', () => {
    const script = renderCompletionScript('bash', 'gvd');
    expect(script).toContain('complete -F _gvd_complete gvd');
  });

  test('the helpers agree with the catalog', () => {
    expect(completionCommandWords()).toContain('sessions');
    expect(completionCommandWords()).toContain('session');
    expect(completionFlagsFor('status')).toContain('--json');
    expect(completionFlagsFor('status')).toContain('--daemon-home');
    expect(completionFlagsFor('serve')).not.toContain('--json');
  });

  test('pair completes -y/--yes alongside its remote-target flags', () => {
    const flags = completionFlagsFor('pair');
    expect(flags).toContain('-y');
    expect(flags).toContain('--yes');
    expect(flags).toContain('--host');
    expect(flags).toContain('--port');
    expect(flags).toContain('--token');
    expect(flags).toContain('--json');
  });
});

describe('the completion command itself', () => {
  test.each([...COMPLETION_SHELLS])('emits the %s script and exits 0', (shell) => {
    const result = runCompletionCommand([shell], 'goodvibes-daemon');
    expect(result.exitCode).toBe(0);
    expect(result.lines.join('\n')).toBe(renderCompletionScript(shell, 'goodvibes-daemon'));
  });

  test('a missing shell is a usage refusal naming the ones that exist', () => {
    const result = runCompletionCommand([], 'goodvibes-daemon');
    expect(result.exitCode).toBe(2);
    expect(result.lines.join('\n')).toContain('bash|zsh|fish');
  });

  test('an unrecognized shell is refused rather than guessed at', () => {
    const result = runCompletionCommand(['powershell'], 'goodvibes-daemon');
    expect(result.exitCode).toBe(2);
    expect(result.lines.join('\n')).toContain("'powershell' is not a shell");
  });

  test('a second argument is refused', () => {
    const result = runCompletionCommand(['bash', 'zsh'], 'goodvibes-daemon');
    expect(result.exitCode).toBe(2);
    expect(result.lines.join('\n')).toContain('one argument too many');
  });
});
