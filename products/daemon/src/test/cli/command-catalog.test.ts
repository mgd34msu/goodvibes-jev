import { describe, expect, test } from 'bun:test';
import {
  allFlagArity,
  DAEMON_COMMANDS,
  DAEMON_COMMAND_ALIASES,
  GLOBAL_FLAGS,
  RAW_INTERCEPT_COMMANDS,
  REJECTED_TERMINAL_FLAGS,
  daemonCommandSpec,
  flagsForCommand,
  isRawInterceptCommand,
  resolveDaemonCommand,
} from '../../cli/command-catalog.ts';
import { findCatalogFlagArityConflicts } from '../../cli/parser.ts';

/**
 * The vocabulary is the point of the catalog. This list is written out by hand
 * rather than derived from the catalog, so a command silently added or dropped
 * fails here instead of quietly changing what the binary answers to.
 */
const EXPECTED_COMMANDS = [
  'serve',
  'install-service',
  'uninstall-service',
  'service-status',
  'migrate-service',
  'start-service',
  'stop-service',
  'restart-service',
  'status',
  'pair',
  'sessions',
  'config',
  'update',
  'send',
  'cluster',
  'webui',
  'provision-wake-model',
  'completion',
  'help',
  'version',
] as const;

describe('the daemon command vocabulary', () => {
  test('is exactly the daemon\'s real commands; no more, no fewer', () => {
    expect([...DAEMON_COMMANDS.map((spec) => spec.name)].sort())
      .toEqual([...EXPECTED_COMMANDS].sort());
  });

  test('carries none of the terminal app\'s command words', () => {
    // Every one of these resolved to a command in the table this binary
    // shipped with, and every one of them ended in "start a daemon".
    for (const word of ['tui', 'app', 'run', 'exec', 'doctor', 'onboarding', 'models',
      'providers', 'auth', 'secrets', 'tasks', 'surfaces', 'listener', 'control-plane',
      'support-bundle', 'remote', 'bridge', 'hooks', 'plugin', 'web']) {
      expect(resolveDaemonCommand(word)).toBeUndefined();
    }
  });

  test('resolves every name and alias, case-insensitively', () => {
    for (const spec of DAEMON_COMMANDS) {
      expect(resolveDaemonCommand(spec.name)).toBe(spec.name);
      expect(resolveDaemonCommand(spec.name.toUpperCase())).toBe(spec.name);
      for (const alias of spec.aliases) {
        expect(resolveDaemonCommand(alias)).toBe(spec.name);
      }
    }
  });

  test('no word names two commands', () => {
    const words = DAEMON_COMMANDS.flatMap((spec) => [spec.name, ...spec.aliases]);
    expect(new Set(words).size).toBe(words.length);
    expect(Object.keys(DAEMON_COMMAND_ALIASES).length).toBe(words.length);
  });

  test('every command carries a usage line, a summary and a help body', () => {
    for (const spec of DAEMON_COMMANDS) {
      expect(spec.summary.length).toBeGreaterThan(0);
      expect(spec.usage).toContain('goodvibes-daemon');
      expect(spec.detail.length).toBeGreaterThan(0);
    }
  });

  test('the raw-intercept list is exactly the passthrough commands', () => {
    expect([...RAW_INTERCEPT_COMMANDS].sort())
      .toEqual(['cluster', 'provision-wake-model', 'send', 'webui']);
    for (const command of RAW_INTERCEPT_COMMANDS) {
      expect(isRawInterceptCommand(command)).toBe(true);
      expect(daemonCommandSpec(command).passthrough).toBe(true);
    }
    expect(isRawInterceptCommand('status')).toBe(false);
  });
});

describe('the catalog\'s flag table', () => {
  test('no token means "boolean" under one command and "takes a value" under another', () => {
    // The engine reads arity from ONE table before it knows the command, so a
    // token whose arity depended on the command would make it skip the wrong
    // argument while hunting for the command word.
    expect(findCatalogFlagArityConflicts()).toEqual([]);
  });

  test('every flag token appears in the shared arity table', () => {
    for (const spec of DAEMON_COMMANDS) {
      for (const flag of flagsForCommand(spec.name)) {
        for (const token of flag.tokens) {
          expect(allFlagArity().has(token)).toBe(true);
        }
      }
    }
  });

  test('`--host` means the bind address for serve and the target for status', () => {
    // The same token, two meanings, kept apart by the command it appears under
    //, which is exactly why flags are per-command data rather than one list.
    const serveHost = daemonCommandSpec('serve').flags.find((flag) => flag.tokens.includes('--host'));
    const statusHost = daemonCommandSpec('status').flags.find((flag) => flag.tokens.includes('--host'));
    expect(serveHost?.field).toBe('hostname');
    expect(statusHost?.field).toBe('host');
  });

  test('every command accepts the global flags', () => {
    for (const spec of DAEMON_COMMANDS) {
      const tokens = flagsForCommand(spec.name).flatMap((flag) => flag.tokens);
      for (const global of GLOBAL_FLAGS.flatMap((flag) => flag.tokens)) {
        expect(tokens).toContain(global);
      }
    }
  });

  test('the terminal app\'s conversation flags are listed for refusal, not acceptance', () => {
    for (const token of Object.keys(REJECTED_TERMINAL_FLAGS)) {
      // A rejected flag must not also be an accepted one anywhere.
      expect(allFlagArity().has(token)).toBe(false);
    }
    for (const token of ['--resume', '--continue', '--fork', '--print', '--prompt',
      '-o', '--output', '--open', '--no-alt-screen', '--session', '--strict']) {
      expect(REJECTED_TERMINAL_FLAGS[token]?.reason).toBeTruthy();
    }
  });
});
