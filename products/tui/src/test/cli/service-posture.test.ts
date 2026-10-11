import { beforeEach, afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ConfigManager } from '@goodvibes-jev/engine/sdk/platform/config';
import type { ManagedServiceStatus } from '@goodvibes-jev/engine/sdk/platform/daemon';
import {
  buildCliServicePosture,
  createPlatformServiceManager,
  getServiceStateRoot,
  resolveGoodVibesDaemonExecutable,
} from '../../cli/service-posture.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import type { JudgmentPort } from '@goodvibes-jev/judgment';
import { choiceAnswer, fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';

function makeExecutable(path: string): void {
  writeFileSync(path, '#!/bin/sh\nexit 0\n', 'utf-8');
  chmodSync(path, 0o755);
}

function createManagedStatus(overrides: Partial<ManagedServiceStatus> = {}): ManagedServiceStatus {
  return {
    platform: 'systemd',
    serviceName: 'goodvibes',
    path: '/tmp/goodvibes.service',
    installed: true,
    autostart: true,
    running: false,
    commandPreview: '/tmp/goodvibes.service',
    suggestedCommands: [],
    lastAction: 'status',
    ...overrides,
  };
}

describe('CLI service posture', () => {
  let root = '';

  beforeEach(() => {
    root = makeProjectTempDir('goodvibes-service-posture');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test('log posture masks locally retained credentials without modifying the log or sending its values', async () => {
    const projectRoot = join(root, 'project'), homeRoot = join(root, 'home');
    mkdirSync(projectRoot, { recursive: true }); mkdirSync(homeRoot, { recursive: true });
    const config = new ConfigManager({ surfaceRoot: 'tui', workingDir: projectRoot, homeDir: homeRoot });
    const logPath = join(root, 'service.log');
    const original = 'daemon ready\npassword=private-log-value\n';
    writeFileSync(logPath, original); const before = statSync(logPath);
    const recorded = fakePort((_, question, state) => question.type === 'choice' ? choiceAnswer(question,
      state !== null && typeof state === 'object' && !Array.isArray(state) && state.field === 'password' ? 'secret' : 'other', 0.99)
      : noulAnswer(0.03));
    const previous = installJudgmentPort(recorded.port);
    try {
      const posture = await buildCliServicePosture({ configManager: config, workingDirectory: projectRoot, homeDirectory: homeRoot },
        { manager: { status: () => createManagedStatus({ platform: 'manual', logPath }) } });
      expect(posture.log.tail).toContain('daemon ready');
      expect(posture.log.tail).not.toContain('private-log-value');
      expect(JSON.stringify(recorded.requests)).not.toContain('private-log-value');
      expect(readFileSync(logPath, 'utf8')).toBe(original);
      expect(statSync(logPath).mtimeMs).toBe(before.mtimeMs);
    } finally { installJudgmentPort(previous); }
  });

  test('log posture rejects cancellation while a reader ignores its signal', async () => {
    const projectRoot = join(root, 'project'), homeRoot = join(root, 'home');
    mkdirSync(projectRoot, { recursive: true }); mkdirSync(homeRoot, { recursive: true });
    const config = new ConfigManager({ surfaceRoot: 'tui', workingDir: projectRoot, homeDir: homeRoot });
    const logPath = join(root, 'service.log'); writeFileSync(logPath, 'daemon ready');
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    const recorded = fakePort(() => noulAnswer(0.03));
    const port: JudgmentPort = { model: recorded.port.model, async ask(request) {
      entered.resolve(); await release.promise; return recorded.port.ask(request);
    } };
    const previous = installJudgmentPort(port), controller = new AbortController();
    try {
      const work = buildCliServicePosture({ configManager: config, workingDirectory: projectRoot, homeDirectory: homeRoot },
        { signal: controller.signal, manager: { status: () => createManagedStatus({ platform: 'manual', logPath }) } });
      await entered.promise; controller.abort();
      await expect(work).rejects.toThrow();
    } finally { release.resolve(); installJudgmentPort(previous); }
  });

  test('log posture rejects a file replaced while classification is pending', async () => {
    const projectRoot = join(root, 'project'), homeRoot = join(root, 'home');
    mkdirSync(projectRoot, { recursive: true }); mkdirSync(homeRoot, { recursive: true });
    const config = new ConfigManager({ surfaceRoot: 'tui', workingDir: projectRoot, homeDir: homeRoot });
    const logPath = join(root, 'service.log'); writeFileSync(logPath, 'daemon ready');
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    const recorded = fakePort(() => noulAnswer(0.03));
    const port: JudgmentPort = { model: recorded.port.model, async ask(request) {
      entered.resolve(); await release.promise; return recorded.port.ask(request);
    } };
    const previous = installJudgmentPort(port);
    try {
      const work = buildCliServicePosture({ configManager: config, workingDirectory: projectRoot, homeDirectory: homeRoot },
        { manager: { status: () => createManagedStatus({ platform: 'manual', logPath }) } });
      await entered.promise; rmSync(logPath); writeFileSync(logPath, 'changed daemon ready'); release.resolve();
      await expect(work).rejects.toThrow('Service log changed');
    } finally { release.resolve(); installJudgmentPort(previous); }
  });

  test('service manager failure text cannot publish an inline credential', async () => {
    const projectRoot = join(root, 'project'), homeRoot = join(root, 'home');
    mkdirSync(projectRoot, { recursive: true }); mkdirSync(homeRoot, { recursive: true });
    const config = new ConfigManager({ surfaceRoot: 'tui', workingDir: projectRoot, homeDir: homeRoot });
    const recorded = fakePort((_, question) => question.type === 'choice' ? choiceAnswer(question, 'secret', 0.99) : noulAnswer(0.97));
    const previous = installJudgmentPort(recorded.port);
    try {
      const posture = await buildCliServicePosture({ configManager: config, workingDirectory: projectRoot, homeDirectory: homeRoot },
        { manager: { status: () => createManagedStatus({ platform: 'manual', actionError: 'password=private-manager-value' }) } });
      expect(JSON.stringify(posture)).not.toContain('private-manager-value');
      expect(JSON.stringify(recorded.requests)).not.toContain('private-manager-value');
    } finally { installJudgmentPort(previous); }
  });

  test('resolves the daemon executable from package artifacts before PATH or source fallbacks', () => {
    const packageRoot = join(root, 'package');
    mkdirSync(join(packageRoot, 'dist'), { recursive: true });
    mkdirSync(join(packageRoot, 'bin'), { recursive: true });
    const artifact = join(packageRoot, 'dist', 'goodvibes-daemon-linux-x64');
    const wrapper = join(packageRoot, 'bin', 'goodvibes-daemon');
    makeExecutable(artifact);
    makeExecutable(wrapper);

    const resolved = resolveGoodVibesDaemonExecutable({
      packageRoot,
      env: { PATH: '' } as NodeJS.ProcessEnv,
      argv: [],
      execPath: join(root, 'missing-goodvibes'),
    });

    expect(resolved).toEqual({
      command: artifact,
      source: 'package',
      absolute: true,
    });
  });

  test('resolves a global PATH daemon wrapper as an absolute command when package artifacts are unavailable', () => {
    const binDir = join(root, 'global-bin');
    mkdirSync(binDir, { recursive: true });
    const daemon = join(binDir, 'goodvibes-daemon');
    makeExecutable(daemon);

    const resolved = resolveGoodVibesDaemonExecutable({
      packageRoot: join(root, 'empty-package'),
      env: { PATH: binDir } as NodeJS.ProcessEnv,
      argv: [],
      execPath: join(root, 'missing-goodvibes'),
    });

    expect(resolved).toEqual({
      command: daemon,
      source: 'path',
      absolute: true,
    });
  });

  test('prefers the vendored daemon binary behind a global npm bin wrapper', () => {
    const packageRoot = join(root, 'global-package');
    const binDir = join(packageRoot, 'bin');
    const vendorDir = join(packageRoot, 'vendor');
    const pathDir = join(root, 'global-bin');
    mkdirSync(binDir, { recursive: true });
    mkdirSync(vendorDir, { recursive: true });
    mkdirSync(pathDir, { recursive: true });
    const wrapper = join(binDir, 'goodvibes-daemon');
    const artifact = join(vendorDir, 'goodvibes-daemon-linux-x64');
    const globalWrapper = join(pathDir, 'goodvibes-daemon');
    makeExecutable(wrapper);
    makeExecutable(artifact);
    symlinkSync(wrapper, globalWrapper);

    const resolved = resolveGoodVibesDaemonExecutable({
      packageRoot: join(root, 'empty-package'),
      env: { PATH: pathDir } as NodeJS.ProcessEnv,
      argv: [],
      execPath: join(root, 'missing-goodvibes'),
    });

    expect(resolved).toEqual({
      command: artifact,
      source: 'path',
      absolute: true,
    });
  });

  test('service posture uses daemon-global state paths and does not synthesize project-local source commands', async () => {
    const projectRoot = join(root, 'project');
    const homeRoot = join(root, 'home');
    mkdirSync(projectRoot, { recursive: true });
    mkdirSync(homeRoot, { recursive: true });
    const config = new ConfigManager({
      surfaceRoot: 'tui',
      workingDir: projectRoot,
      homeDir: homeRoot,
    });
    config.setDynamic('service.enabled', true);
    config.setDynamic('service.autostart', true);
    config.setDynamic('service.restartOnFailure', true);
    config.setDynamic('service.platform', 'manual');

    const posture = await buildCliServicePosture({
      configManager: config,
      workingDirectory: projectRoot,
      homeDirectory: homeRoot,
    });

    expect(getServiceStateRoot({ configManager: config, workingDirectory: projectRoot, homeDirectory: homeRoot }))
      .toBe(join(homeRoot, '.goodvibes', 'daemon'));
    expect(posture.managed.path).toBe(join(homeRoot, '.goodvibes', 'daemon', 'service', 'manual-service.txt'));
    expect(posture.managed.pidPath).toBe(join(homeRoot, '.goodvibes', 'daemon', 'service', 'manual.pid'));
    expect(posture.managed.commandPreview).not.toContain(join(projectRoot, 'src', 'daemon', 'cli.ts'));
    expect(posture.managed.commandPreview).not.toContain('src/daemon/cli.ts');
  });

  test('installed systemd service reads shared GoodVibes home config from daemon mode', () => {
    const projectRoot = join(root, 'project');
    const homeRoot = join(root, 'home');
    mkdirSync(projectRoot, { recursive: true });
    mkdirSync(homeRoot, { recursive: true });
    const config = new ConfigManager({
      surfaceRoot: 'tui',
      workingDir: projectRoot,
      homeDir: homeRoot,
    });
    config.setDynamic('service.platform', 'systemd');
    config.setDynamic('service.serviceName', 'goodvibes-test');
    config.setDynamic('service.restartOnFailure', true);

    const savedHome = process.env.HOME;
    process.env.HOME = homeRoot;
    try {
      const manager = createPlatformServiceManager({
        configManager: config,
        workingDirectory: projectRoot,
        homeDirectory: homeRoot,
      });
      const installed = manager.install();

      expect(installed.contents).toContain(`WorkingDirectory=${join(homeRoot, '.goodvibes', 'daemon')}`);
      // The tree root and the daemon's own home are separate variables now: the
      // root stays the login home, and GOODVIBES_DAEMON_HOME names the daemon
      // state directory it used to be wrongly pointed away from.
      expect(installed.contents).toContain(`Environment=GOODVIBES_HOME=${homeRoot}`);
      expect(installed.contents).toContain(`Environment=GOODVIBES_DAEMON_HOME=${join(homeRoot, '.goodvibes', 'daemon')}`);
      expect(installed.contents).not.toContain(`Environment=GOODVIBES_DAEMON_HOME=${homeRoot}\n`);
    } finally {
      if (savedHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = savedHome;
      }
    }
  });

  test('posture reports the daemon enabled by default for a fresh config', async () => {
    const projectRoot = join(root, 'project');
    const homeRoot = join(root, 'home');
    mkdirSync(projectRoot, { recursive: true });
    mkdirSync(homeRoot, { recursive: true });
    const config = new ConfigManager({
      surfaceRoot: 'tui',
      workingDir: projectRoot,
      homeDir: homeRoot,
    });

    const posture = await buildCliServicePosture({
      configManager: config,
      workingDirectory: projectRoot,
      homeDirectory: homeRoot,
    });

    expect(posture.config.daemonEnabled).toBe(true);
  });

  test('posture honors a legacy on-disk danger.daemon=false through the removal migration', async () => {
    // The deprecated danger.daemon alias was removed from the schema (see
    // docs/decisions/2026-07-05-daemon-by-default.md). A user's existing
    // explicit off-switch on disk is preserved by the SDK's config migration
    // (ConfigManager.load -> migrateDangerDaemonAlias), which rewrites it onto
    // daemon.enabled=false BEFORE this posture read, it is no longer
    // reachable via ConfigManager.setDynamic('danger.daemon', ...) at runtime
    // because the key no longer exists in the schema.
    const projectRoot = join(root, 'project');
    const homeRoot = join(root, 'home');
    mkdirSync(projectRoot, { recursive: true });
    mkdirSync(homeRoot, { recursive: true });
    mkdirSync(join(homeRoot, '.goodvibes', 'tui'), { recursive: true });
    writeFileSync(
      join(homeRoot, '.goodvibes', 'tui', 'settings.json'),
      JSON.stringify({ danger: { daemon: false } }),
      'utf-8',
    );
    const config = new ConfigManager({
      surfaceRoot: 'tui',
      workingDir: projectRoot,
      homeDir: homeRoot,
    });

    const posture = await buildCliServicePosture({
      configManager: config,
      workingDirectory: projectRoot,
      homeDirectory: homeRoot,
    });

    expect(posture.config.daemonEnabled).toBe(false);
  });

  test('service posture reconciles systemd active state instead of trusting stale pid-file status', async () => {
    const projectRoot = join(root, 'project');
    const homeRoot = join(root, 'home');
    mkdirSync(projectRoot, { recursive: true });
    mkdirSync(homeRoot, { recursive: true });
    const config = new ConfigManager({
      surfaceRoot: 'tui',
      workingDir: projectRoot,
      homeDir: homeRoot,
    });
    config.setDynamic('service.enabled', true);
    config.setDynamic('service.autostart', true);
    config.setDynamic('service.restartOnFailure', true);
    config.setDynamic('service.platform', 'systemd');
    config.setDynamic('service.serviceName', 'goodvibes');

    const posture = await buildCliServicePosture(
      {
        configManager: config,
        workingDirectory: projectRoot,
        homeDirectory: homeRoot,
      },
      {
        manager: {
          status: () => createManagedStatus({ installed: true, autostart: true, running: false }),
        },
        runCommand: (command, args) => {
          expect(command).toBe('systemctl');
          expect(args).toEqual([
            '--user',
            'show',
            'goodvibes.service',
            '--property=LoadState,ActiveState,UnitFileState,MainPID',
            '--no-page',
          ]);
          return {
            status: 0,
            stdout: [
              'LoadState=loaded',
              'ActiveState=active',
              'UnitFileState=enabled',
              'MainPID=12345',
            ].join('\n'),
          };
        },
      },
    );

    expect(posture.managed.installed).toBe(true);
    expect(posture.managed.autostart).toBe(true);
    expect(posture.managed.running).toBe(true);
    expect(posture.managed.pid).toBe(12345);
    expect(posture.issues).not.toContain('Service mode is enabled but the managed service is not running.');
  });
});
