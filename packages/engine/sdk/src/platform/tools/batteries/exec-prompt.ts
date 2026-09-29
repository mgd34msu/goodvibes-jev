/**
 * `engine.tools.exec-prompt`: the two readings behind the exec tool's PTY
 * prompt-answer path (tools/exec/interactive.ts). Each site asks only its own
 * question (`only`):
 *
 * - `will_prompt` (state: the command): before a command runs, will it stop
 *   to ask for input at the terminal? A yes runs it under a PTY so the prompt
 *   can be answered. It replaces the fixed base-command set (ssh, scp, sftp,
 *   sudo, su, passwd), which missed prompting commands (gh auth login, npm
 *   init, git over ssh) and caught non-prompting ones (ssh -o BatchMode=yes,
 *   sudo -n). Asked only when the caller did not set `interactive` and the
 *   host has a PTY. Low stakes: a wrong yes merges stderr into stdout for one
 *   run; a wrong no leaves a prompt to wait out the timeout, reported as the
 *   pipe path always did.
 * - `awaiting_input` (state: the command, its unterminated last output line
 *   and recent output): after output has gone quiet with the process alive,
 *   is that line a question waiting for an answer? A yes surfaces it through
 *   the approval broker. It replaces the three tail regexes (ends with : or ?,
 *   a short [..] bracket, a (yes/no) choice) and the 500-character cutoff.
 *   Medium stakes: a wrong yes puts a non-question in front of the owner (a
 *   decline stops the run); a wrong no leaves a real prompt unanswered until
 *   the timeout.
 */
import { defineBattery, STAKES_BANDS, yesNo } from '@goodvibes-jev/judgment';

/** Most characters of the pending line and of the recent output one request carries. */
export const MAX_JUDGED_PROMPT_LINE_CHARS = 500;
export const MAX_JUDGED_RECENT_OUTPUT_CHARS = 1_500;

const tail = (text: string, max: number): string => (text.length <= max ? text : `[${text.length - max} earlier characters]${text.slice(-max)}`);

/** What `awaiting_input` sees: the command, the unterminated last line, and the output before it. */
export function pendingPromptView(command: string, line: string, recentOutput: string): { command: string; lastLine: string; recentOutput: string } {
  return {
    command,
    lastLine: tail(line, MAX_JUDGED_PROMPT_LINE_CHARS),
    recentOutput: tail(recentOutput, MAX_JUDGED_RECENT_OUTPUT_CHARS),
  };
}

const pending = (command: string, line: string, recent = '') => pendingPromptView(command, line, recent);

export const execPrompt = defineBattery({
  name: 'engine.tools.exec-prompt',
  version: 1,
  description: 'Whether a shell command will stop to ask for terminal input, and whether a quiet, unterminated output line is a question waiting for an answer.',
  accuracyFloor: 0.85,
  items: {
    will_prompt: yesNo(
      '`command` is a shell command an AI agent is about to run with no one watching the terminal. As written, will it most likely stop and wait for someone to type at the terminal: a password or passphrase, a host-key or fingerprint confirmation, a yes/no confirmation, a login or setup questionnaire? Commands whose flags turn prompts off (batch mode, non-interactive, -y, --yes, -n for sudo) or that only print output do not.',
      STAKES_BANDS.low.yesNo,
    ),
    awaiting_input: yesNo(
      '`command` is running, its output has stopped, and it is still alive. `lastLine` is the last line it printed, with no newline after it; `recentOutput` is what it printed before. Is `lastLine` a question or prompt waiting for someone to type an answer (a password, a yes/no confirmation, a choice, a value to enter)? Progress bars, status or log lines, partial output of a slow step, and a program simply thinking are not waiting for input.',
      STAKES_BANDS.medium.yesNo,
    ),
  },
  fixtures: [
    { name: 'ssh to a host', state: { command: 'ssh deploy@build-01.internal uptime' }, expect: { will_prompt: 'yes' } },
    { name: 'sudo install', state: { command: 'sudo apt-get install ripgrep' }, expect: { will_prompt: 'yes' } },
    { name: 'gh login', state: { command: 'gh auth login' }, expect: { will_prompt: 'yes' } },
    { name: 'npm init', state: { command: 'npm init' }, expect: { will_prompt: 'yes' } },
    { name: 'passwd', state: { command: 'passwd' }, expect: { will_prompt: 'yes' } },
    { name: 'ssh in batch mode', state: { command: 'ssh -o BatchMode=yes deploy@build-01.internal uptime' }, expect: { will_prompt: 'no' } },
    { name: 'sudo non-interactive', state: { command: 'sudo -n systemctl status nginx' }, expect: { will_prompt: 'no' } },
    { name: 'npm init with yes', state: { command: 'npm init -y' }, expect: { will_prompt: 'no' } },
    { name: 'git status', state: { command: 'git status --short' }, expect: { will_prompt: 'no' } },
    { name: 'run tests', state: { command: 'bun test test/cart.test.ts' }, expect: { will_prompt: 'no' } },
    { name: 'list files', state: { command: 'ls -la src' }, expect: { will_prompt: 'no' } },
    { name: 'sudo password', state: pending('sudo apt-get install ripgrep', '[sudo] password for dev:'), expect: { awaiting_input: 'yes' } },
    {
      name: 'ssh host key',
      state: pending(
        'ssh deploy@build-01.internal uptime',
        'Are you sure you want to continue connecting (yes/no/[fingerprint])?',
        "The authenticity of host 'build-01.internal (10.0.4.12)' can't be established.\nED25519 key fingerprint is SHA256:2x1kQv0mVfX4d7Lr9s8PzYb3aT6cN5eJ0uHwGiRkM1o.\n",
      ),
      expect: { awaiting_input: 'yes' },
    },
    { name: 'apt confirm', state: pending('sudo apt-get install ripgrep', 'Do you want to continue? [Y/n]', 'After this operation, 4,096 kB of additional disk space will be used.\n'), expect: { awaiting_input: 'yes' } },
    { name: 'git credential', state: pending('git push origin main', "Username for 'https://github.com':"), expect: { awaiting_input: 'yes' } },
    { name: 'npm init field', state: pending('npm init', 'package name: (shop-api)', 'This utility will walk you through creating a package.json file.\n'), expect: { awaiting_input: 'yes' } },
    { name: 'progress bar', state: pending('bun install', '[12/48] Resolving dependencies...'), expect: { awaiting_input: 'no' } },
    { name: 'download percentage', state: pending('curl -O https://example.org/big.iso', ' 42.1% of 3.2GiB at 11.4MiB/s ETA 02:51'), expect: { awaiting_input: 'no' } },
    { name: 'log line ending in a colon', state: pending('bun run build', 'Bundling entry points:', 'Cleaning dist...\n'), expect: { awaiting_input: 'no' } },
    { name: 'test runner mid-run', state: pending('bun test', 'test/cart.test.ts:', 'bun test v1.2.19\n'), expect: { awaiting_input: 'no' } },
  ],
});
