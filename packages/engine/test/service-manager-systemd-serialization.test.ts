import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigManager } from '../sdk/src/platform/config/manager.js';
import { PlatformServiceManager, renderSystemdUnit, type ManagedServiceDefinition } from '../sdk/src/platform/daemon/service-manager.js';

const definition: ManagedServiceDefinition = {
  name: 'jev-serialization-test', description: 'Jev test daemon', workingDirectory: '/tmp/jev-home',
  command: '/usr/local/bin/goodvibes-daemon', args: ['--daemon-home', '/tmp/jev-home'],
  env: { GOODVIBES_HOME: '/tmp/jev-home' }, restartOnFailure: true,
};

function scratch<T>(run: (directory: string) => T): T {
  const directory = mkdtempSync(join(tmpdir(), 'jev-service-serialization-'));
  try { return run(directory); }
  finally { rmSync(directory, { recursive: true, force: true }); }
}

describe('systemd literal service serialization', () => {
  test('ordinary executable and option words retain their established spelling', () => {
    const unit = renderSystemdUnit(definition);
    expect(unit).toContain('ExecStart=/usr/local/bin/goodvibes-daemon --daemon-home /tmp/jev-home\n');
    expect(unit).toContain('Environment=GOODVIBES_HOME=/tmp/jev-home\n');
  });

  test('command, arguments and environment use their distinct literal expansion rules', () => {
    const home = '/tmp/home $HOME %n "quoted" \\path';
    const unit = renderSystemdUnit({ ...definition, description: 'Jev 100% literal %n',
      workingDirectory: home, command: '/tmp/compiled $HOME%n daemon',
      args: ['--daemon-home', home, '', ';', 'line\nnext\r\ttab', 'apostrophe\'s'],
      env: { GOODVIBES_HOME: home, SYNTHETIC: '$HOME %n "quoted" \\path\nnext', EMPTY: '' },
    });
    expect(unit).toContain('Description=Jev 100%% literal %%n\n');
    expect(unit).toContain('WorkingDirectory=/tmp/home $HOME %%n "quoted" \\path\n');
    expect(unit).toContain('ExecStart=:"/tmp/compiled $HOME%%n daemon" --daemon-home "/tmp/home $HOME %%n \\"quoted\\" \\\\path" "" ";" "line\\x0anext\\x0d\\x09tab" "apostrophe\'s"\n');
    expect(unit).toContain('Environment="GOODVIBES_HOME=/tmp/home $HOME %%n \\"quoted\\" \\\\path"\n');
    expect(unit).toContain('Environment="SYNTHETIC=$HOME %%n \\"quoted\\" \\\\path\\x0anext"\n');
    expect(unit).not.toContain('Environment=EMPTY=');
    expect(renderSystemdUnit({ ...definition, args: ['$HOME', '${HOME}', 'two $$'], env: { SYNTHETIC: '$HOME' } }))
      .toContain('ExecStart=/usr/local/bin/goodvibes-daemon "$$HOME" "$${HOME}" "two $$$$"\n');
  });

  test('a newline in an argument or environment stays data inside a single directive', () => {
    const injected = 'first\nExecStart=/bin/false\n[Install]\nWantedBy=evil.target';
    const unit = renderSystemdUnit({ ...definition, args: [injected], env: { SYNTHETIC: injected } });
    expect(unit.split('\n').filter(line => line.startsWith('ExecStart='))).toHaveLength(1);
    expect(unit.split('\n').filter(line => line.startsWith('[Install]'))).toHaveLength(1);
    expect(unit.split('\n').filter(line => line.startsWith('Environment='))).toHaveLength(1);
    expect(unit).toContain('first\\x0aExecStart=/bin/false');
    expect(unit).not.toContain('\nWantedBy=evil.target');
  });

  test.each(['WorkingDirectory', 'Description'] as const)('%s refuses raw values systemd cannot preserve', field => {
    for (const value of ['first\nExecStart=/bin/false', 'first\rnext', 'first\0next', 'first\tlast', 'leading ', ' leading', 'ending\\']) {
      const changed = field === 'WorkingDirectory' ? { workingDirectory: value } : { description: value };
      expect(() => renderSystemdUnit({ ...definition, ...changed })).toThrow(`systemd ${field}`);
    }
  });

  test.each(['', '+/bin/true', '-/bin/true', '@/bin/true', ':/bin/true', '!/bin/true', '|/bin/true', ';', '/bin/true\nExecStart=/bin/false'])('executable %s cannot become a systemd modifier or directive', command => {
    expect(() => renderSystemdUnit({ ...definition, command })).toThrow('literal executable');
  });

  test.each(['INVALID=KEY', '1INVALID', 'BAD KEY', 'BAD\nExecStart', ''])('invalid environment name %s is refused', key => {
    expect(() => renderSystemdUnit({ ...definition, env: { [key]: 'synthetic' } })).toThrow('environment variable name');
  });

  test('NUL cannot be encoded into an argument or environment', () => {
    expect(() => renderSystemdUnit({ ...definition, args: ['first\0next'] })).toThrow('NUL');
    expect(() => renderSystemdUnit({ ...definition, env: { SYNTHETIC: 'first\0next' } })).toThrow('NUL');
  });
});

const hasSystemdAnalyze = process.platform === 'linux'
  && spawnSync('systemd-analyze', ['--version'], { timeout: 5_000, encoding: 'utf8' }).status === 0;

test.skipIf(!hasSystemdAnalyze)('native systemd parser accepts literal paths, data and both restart versions without service activation', () => scratch(directory => {
  const command = join(directory, 'compiled ${HOME}%n daemon');
  symlinkSync('/bin/true', command);
  const home = join(directory, 'home $HOME%n "quoted" \\path');
  const selected: ManagedServiceDefinition = { ...definition, workingDirectory: home, command,
    args: ['--daemon-home', home, '', ';', 'first\nExecStart=/bin/false'],
    env: { GOODVIBES_HOME: `${home}\nnext`, SYNTHETIC: '$HOME%n' },
  };
  const path = join(directory, `${definition.name}.service`);
  for (const version of [null, 254]) {
    writeFileSync(path, renderSystemdUnit(selected, version));
    const parsed = spawnSync('systemd-analyze', ['verify', '--generators=no', '--man=no', path], {
      timeout: 10_000, encoding: 'utf8', env: { ...process.env, SYSTEMD_LOG_LEVEL: 'debug', SYSTEMD_LOG_TARGET: 'console' },
    });
    expect(parsed.error).toBeUndefined();
    expect(parsed.status).toBe(0);
    const output = parsed.stdout + parsed.stderr;
    expect(output).toContain(`WorkingDirectory: ${home}`);
    expect(output).toContain(`Environment: GOODVIBES_HOME=${home}\nnext`);
    expect(output).toContain('Environment: SYNTHETIC=$HOME%n');
    expect(output).not.toContain('is not executable');
    expect(output).not.toContain('Unknown key');
  }
}));

describe('installed service definition identity', () => {
  test.each(['systemd', 'launchd', 'windows', 'manual'] as const)('%s compares actual installed bytes without management actions', platform => scratch(directory => {
    const config = new ConfigManager({ configDir: join(directory, 'config') });
    config.set('service.platform', platform);
    config.set('service.serviceName', definition.name);
    const calls: string[] = [];
    const options = { workingDirectory: directory, homeDirectory: directory, definitionOverride: definition,
      featureFlags: { isEnabled: () => true },
      actionRunner: (command: string) => { calls.push(command); return { status: 0, stdout: 'systemd 254\n' }; },
    };
    const manager = new PlatformServiceManager(config, options);
    expect(manager.installedDefinitionMatches()).toBe(false);
    expect(calls).toEqual([]);
    const installed = manager.install();
    calls.length = 0;
    expect(manager.installedDefinitionMatches()).toBe(true);
    expect(calls).toEqual([]);
    const selected = new PlatformServiceManager(config, { ...options,
      definitionOverride: { ...definition, args: ['--daemon-home', '/tmp/alternate-home'], env: { GOODVIBES_HOME: '/tmp/alternate-home' } },
    });
    expect(selected.installedDefinitionMatches()).toBe(false);
    expect(calls).toEqual([]);
    writeFileSync(installed.path, 'unrelated installed definition\n');
    expect(manager.installedDefinitionMatches()).toBe(false);
    expect(calls).toEqual([]);
  }));

  test('systemd accepts only canonical restart variants and refuses altered arguments, environment or comments', () => scratch(directory => {
    const config = new ConfigManager({ configDir: join(directory, 'config') });
    config.set('service.platform', 'systemd');
    config.set('service.serviceName', definition.name);
    const manager = new PlatformServiceManager(config, { workingDirectory: directory, homeDirectory: directory,
      definitionOverride: definition, featureFlags: { isEnabled: () => true }, actionRunner: () => ({ status: 0 }),
    });
    const path = manager.install().path;
    for (const version of [null, 254]) {
      const unit = `${renderSystemdUnit(definition, version)}\n`;
      writeFileSync(path, unit);
      expect(manager.installedDefinitionMatches()).toBe(true);
      for (const changed of [unit.replace('RestartSec=2', 'RestartSec=3'), unit + '# unrelated writer\n',
        unit.replace('GOODVIBES_HOME=/tmp/jev-home', 'GOODVIBES_HOME=/tmp/other'),
        unit.replace('--daemon-home /tmp/jev-home', '--daemon-home /tmp/other')]) {
        writeFileSync(path, changed);
        expect(manager.installedDefinitionMatches()).toBe(false);
      }
    }
    rmSync(path);
    expect(manager.installedDefinitionMatches()).toBe(false);
  }));
});
