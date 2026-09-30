import { describe, expect, test } from 'bun:test';
import { DAEMON_COMMANDS } from '../../cli/command-catalog.ts';
import {
  renderDaemonCommandHelp,
  renderGoodVibesDaemonHelp,
  serviceKindForPlatform,
} from '../../cli/help.ts';

describe('the top-level help lists exactly what the binary does', () => {
  const help = renderGoodVibesDaemonHelp('goodvibes-daemon', 'linux');

  test('names every command in the catalog', () => {
    for (const spec of DAEMON_COMMANDS) {
      if (spec.name === 'serve') continue; // documented as the bare invocation
      expect(help).toContain(spec.name);
    }
  });

  test('names no command the binary does not have', () => {
    // The help this replaced described a `service <command>` verb the binary
    // never dispatched, and said nothing about status, pair, sessions, config
    // or update, none of which existed.
    for (const word of ['doctor', 'onboarding', 'models', 'providers', 'support-bundle']) {
      expect(help).not.toContain(`  ${word} `);
    }
  });

  test('documents the flags that work, by name', () => {
    for (const token of ['--daemon-home', '--working-dir', '--cd', '--provider', '--model',
      '--hostname', '--port', '--config', '--enable', '--disable', '--help', '--version']) {
      expect(help).toContain(token);
    }
  });

  test('documents -y/--yes where it is relevant', () => {
    const migrate = renderDaemonCommandHelp('migrate-service', 'goodvibes-daemon', 'linux');
    expect(migrate).toContain('-y');
    expect(migrate).toContain('--yes');

    const pair = renderDaemonCommandHelp('pair', 'goodvibes-daemon', 'linux') ?? '';
    expect(pair).toContain('-y');
    expect(pair).toContain('--yes');
  });

  test('pair documents both forms and the mint-vs-reprint distinction', () => {
    const pair = renderDaemonCommandHelp('pair', 'goodvibes-daemon', 'linux') ?? '';
    expect(pair).toContain('LOCAL FORM');
    expect(pair).toContain('REMOTE FORM');
    expect(pair).toContain('MINT A NEW');
    expect(pair).toContain('reprinting');
    expect(pair).toContain('--host');
  });

  test('documents --json on the commands that take it', () => {
    for (const command of ['status', 'service-status', 'sessions', 'config', 'update']) {
      expect(renderDaemonCommandHelp(command, 'goodvibes-daemon', 'linux')).toContain('--json');
    }
  });

  test('documents every exit code the binary uses', () => {
    expect(help).toContain('Exit codes:');
    for (const code of ['  0', '  1', '  2', '  3', '  4']) {
      expect(help).toContain(code);
    }
    expect(help).toContain('installed, but not running');
    expect(help).toContain('not installed');
  });

  test('says systemd on Linux, launchd on macOS and a Scheduled Task on Windows', () => {
    // It said "systemd user service" on every platform, including macOS, where
    // install-service writes a launchd agent and no systemd exists at all.
    expect(serviceKindForPlatform('linux')).toBe('systemd user service');
    expect(serviceKindForPlatform('darwin')).toBe('launchd user agent');
    expect(serviceKindForPlatform('win32')).toBe('Scheduled Task');
    expect(renderGoodVibesDaemonHelp('goodvibes-daemon', 'linux')).toContain('systemd user service');
    expect(renderGoodVibesDaemonHelp('goodvibes-daemon', 'darwin')).toContain('launchd user agent');
    expect(renderGoodVibesDaemonHelp('goodvibes-daemon', 'darwin')).not.toContain('systemd user service');
  });

  test('never claims the daemon starts a conversation', () => {
    for (const word of ['--resume', '--continue', '--fork', '--print', '--prompt', 'TUI', 'embedded']) {
      expect(help).not.toContain(word);
    }
  });
});

describe('help <command>', () => {
  test('every command has its own page', () => {
    for (const spec of DAEMON_COMMANDS) {
      const page = renderDaemonCommandHelp(spec.name, 'goodvibes-daemon', 'linux');
      expect(page).not.toBeNull();
      expect(page).toContain('Usage:');
      expect(page).toContain(spec.detail[0] as string);
    }
  });

  test('an alias reaches the command\'s page', () => {
    expect(renderDaemonCommandHelp('qr', 'goodvibes-daemon', 'linux'))
      .toBe(renderDaemonCommandHelp('pair', 'goodvibes-daemon', 'linux'));
  });

  test('a word that names no command has no page, so the caller can refuse', () => {
    expect(renderDaemonCommandHelp('doctor')).toBeNull();
    expect(renderDaemonCommandHelp('install-servce')).toBeNull();
  });

  test('a command\'s own flags appear on its page', () => {
    const sessions = renderDaemonCommandHelp('sessions', 'goodvibes-daemon', 'linux') ?? '';
    expect(sessions).toContain('--all');
    expect(sessions).toContain('--host');
    expect(sessions).toContain('--token');
  });

  test('a service command\'s page names this host\'s service kind', () => {
    expect(renderDaemonCommandHelp('start-service', 'goodvibes-daemon', 'darwin'))
      .toContain('launchd user agent');
  });

  test('the binary name is substituted into the usage line', () => {
    expect(renderDaemonCommandHelp('status', 'gvd', 'linux')).toContain('Usage: gvd status');
  });
});
