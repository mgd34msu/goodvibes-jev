import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ConfigManager } from '../config/index.ts';
import {
  applyRuntimeConfigOverrides,
  applyRuntimeConfigValue,
  applyRuntimeCommandEndpointFlagOverrides,
  applyRuntimeFeatureOverrides,
  applyRuntimeUrlOverride,
  handleGoodVibesCliCommand,
  parseCliFlags,
  parseGoodVibesCli,
  renderGoodVibesCommandHelp,
  renderGoodVibesHelp,
} from '../cli-flags.ts';
import { makeProjectTempDir } from './helpers/project-temp.ts';

async function captureGoodVibesCliCommand(args: readonly string[], configManager: ConfigManager, root: string) {
  const logs: string[] = [];
  const originalLog = console.log;
  try {
    console.log = (value?: unknown) => { logs.push(String(value)); };
    const result = await handleGoodVibesCliCommand({
      cli: parseGoodVibesCli(args),
      configManager,
      workingDirectory: root,
      homeDirectory: root,
    });
    return { result, output: logs.join('\n') };
  } finally {
    console.log = originalLog;
  }
}

describe('parseCliFlags', () => {
  test('parses --working-dir=<path>', () => {
    const flags = parseCliFlags(['--working-dir=/custom/workspace']);
    expect(flags.workingDir).toBe('/custom/workspace');
  });

  test('parses --agent-profile=<name>', () => {
    const flags = parseCliFlags(['--agent-profile=household']);
    expect(flags.agentProfile).toBe('household');
  });

  test('parses --runtime-url for connected-host connection overrides', () => {
    const flags = parseCliFlags(['--runtime-url=http://127.0.0.1:4521']);
    expect(flags.runtimeUrl).toBe('http://127.0.0.1:4521');

    const alias = parseCliFlags(['--runtime', '127.0.0.1:4522']);
    expect(alias.runtimeUrl).toBe('127.0.0.1:4522');
  });

  test('rejects copied daemon-home flags from the Agent CLI surface', () => {
    const parsed = parseGoodVibesCli(['--daemon-home=/home/daemon']);
    expect(parsed.errors).toEqual(['Unknown option: --daemon-home']);
    expect(parsed.command).toBe('tui');
  });

  // ---------------------------------------------------------------------------
  // Env var precedence (flags win, env is fallback)
  // ---------------------------------------------------------------------------
  // parseCliFlags itself does not read env vars, it only returns parsed flag
  // values. The shell entrypoint is responsible for setting env
  // vars from the returned flags. Agent exposes a working-directory override;
  // connected-host token locations stay derived from the Agent home.

  test('env GOODVIBES_WORKING_DIR is the fallback when flag absent', () => {
    const flags = parseCliFlags([]);
    expect(flags.workingDir).toBeUndefined();
  });

  test('flag overrides env for working-dir: flag present, env set', () => {
    const savedEnv = process.env['GOODVIBES_WORKING_DIR'];
    try {
      process.env['GOODVIBES_WORKING_DIR'] = '/from/env';
      const flags = parseCliFlags(['--working-dir=/from/flag']);
      expect(flags.workingDir).toBe('/from/flag');
    } finally {
      if (savedEnv === undefined) {
        delete process.env['GOODVIBES_WORKING_DIR'];
      } else {
        process.env['GOODVIBES_WORKING_DIR'] = savedEnv;
      }
    }
  });

  // ---------------------------------------------------------------------------
  // Help text contains precedence note
  // ---------------------------------------------------------------------------

  test('help text keeps advanced daemon diagnostics out of the primary product surface', () => {
    const flags = parseCliFlags(['--help']);
    const helpOutput = renderGoodVibesHelp('goodvibes');
    expect(flags.help).toBe(true);
    expect(helpOutput).toContain('--working-dir <dir>');
    expect(helpOutput).toContain('--output <format>');
    expect(helpOutput).toContain('status');
    expect(helpOutput).toContain('onboarding');
    expect(helpOutput).not.toContain('help service');
    expect(helpOutput).not.toContain('help surfaces');
    expect(helpOutput).not.toContain('--daemon-home <dir>');
    expect(helpOutput).not.toContain('control-plane status');
    expect(helpOutput).not.toContain('listener test');
    expect(helpOutput).not.toContain('remote|bridge');
  });

  test('command-specific help describes the selected command interface', () => {
    const parsed = parseGoodVibesCli(['providers', '--help']);
    const helpOutput = renderGoodVibesCommandHelp(parsed.rawCommand ?? parsed.command, 'goodvibes');

    expect(parsed.command).toBe('providers');
    expect(parsed.flags.help).toBe(true);
    expect(helpOutput).toContain('GoodVibes Agent providers');
    expect(helpOutput).toContain('providers inspect <provider>');
    expect(helpOutput).not.toContain('Usage: goodvibes [OPTIONS] [PROMPT]');
  });

  // ---------------------------------------------------------------------------
  // Other flags still parse correctly
  // ---------------------------------------------------------------------------

  test('parses --provider and --model alongside new flags', () => {
    const flags = parseCliFlags([
      '--provider', 'openai',
      '--model', 'gpt-4o',
      '--working-dir=/tmp/wd',
    ]);
    expect(flags.provider).toBe('openai');
    expect(flags.model).toBe('gpt-4o');
    expect(flags.workingDir).toBe('/tmp/wd');
  });

  test('infers provider from provider:model format in --model', () => {
    const flags = parseCliFlags(['--model', 'inception:mercury-2']);
    expect(flags.model).toBe('inception:mercury-2');
    expect(flags.provider).toBe('inception');
  });

  test('returns all undefined when no flags are provided', () => {
    const flags = parseCliFlags([]);
    expect(flags.provider).toBeUndefined();
    expect(flags.model).toBeUndefined();
    expect(flags.workingDir).toBeUndefined();
  });

  test('parses core command interface and prompt aliases', () => {
    const run = parseGoodVibesCli(['run', '--output', 'json', 'write tests']);
    expect(run.command).toBe('run');
    expect(run.flags.outputFormat).toBe('json');
    expect(run.flags.prompt).toBe('write tests');

    const onboarding = parseGoodVibesCli(['setup', 'status']);
    expect(onboarding.command).toBe('onboarding');
    expect(onboarding.commandArgs).toEqual(['status']);

    const ask = parseGoodVibesCli(['ask', 'What', 'is', 'GoodVibes', 'Agent?']);
    expect(ask.command).toBe('ask');
    expect(ask.commandArgs).toEqual(['What', 'is', 'GoodVibes', 'Agent?']);

    const search = parseGoodVibesCli(['search', 'release', 'checklist']);
    expect(search.command).toBe('search');
    expect(search.commandArgs).toEqual(['release', 'checklist']);
  });

  test('passes command-specific options through to command handlers', () => {
    const auth = parseGoodVibesCli(['auth', 'users', '--json']);
    expect(auth.errors).toEqual([]);
    expect(auth.command).toBe('auth');
    expect(auth.commandArgs).toEqual(['users']);
    expect(auth.flags.outputFormat).toBe('json');

    const subscription = parseGoodVibesCli(['subscription', 'login', 'openai', 'start', '--manual']);
    expect(subscription.errors).toEqual([]);
    expect(subscription.commandArgs).toEqual(['login', 'openai', 'start', '--manual']);
  });

  test('blocks copied auth user administration instead of creating a local connected-host user store', async () => {
    const root = makeProjectTempDir('goodvibes-agent-auth-block');
    try {
      const configManager = new ConfigManager({
        surfaceRoot: 'agent',
        workingDir: root,
        homeDir: root,
        configDir: join(root, '.goodvibes', 'agent'),
      });
      const result = await captureGoodVibesCliCommand([
        'auth',
        'add-user',
        'alice',
        '--password',
        'secret',
      ], configManager, root);

      expect(result.result.handled).toBe(true);
      expect(result.result.exitCode).toBe(2);
      expect(result.output).toContain('Unsupported: connected-host auth user/session administration is outside GoodVibes Agent.');
      expect(existsSync(join(root, '.goodvibes', 'agent', 'auth-users.json'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('does not expose copied lifecycle and transport words as Agent CLI commands', () => {
    for (const token of ['serve', 'daemon', 'server', 'web', 'service', 'services', 'surfaces', 'surface', 'listener', 'http-listener', 'webhook', 'control-plane', 'controlplane', 'cp', 'remote', 'bridge'] as const) {
      const parsed = parseGoodVibesCli([token]);
      expect(parsed.command).toBe('unknown');
      expect(parsed.rawCommand).toBe(token);
      expect(parsed.errors[0]?.startsWith(`Unsupported command: ${token}.`)).toBe(true);
      expect(parsed.positionals).toEqual([]);
      expect(parsed.commandArgs).toEqual([]);
    }

    expect(parseGoodVibesCli(['bundle']).command).toBe('bundle');
  });

  test('retired launcher aliases do not open the Agent TUI', () => {
    for (const token of ['app', 'launch', 'start', 'tui'] as const) {
      const parsed = parseGoodVibesCli([token]);
      expect(parsed.command).toBe('unknown');
      expect(parsed.rawCommand).toBe(token);
      expect(parsed.errors[0]?.startsWith(`Unsupported command: ${token}.`)).toBe(true);
      expect(parsed.commandArgs).toEqual([]);
      expect(parsed.positionals).toEqual([]);
    }
  });

  test('parses --cd, --no-alt-screen, completion, and port flags without exposing serve command', () => {
    const flags = parseGoodVibesCli([
      'serve',
      '--cd',
      '/workspace',
      '--no-alt-screen',
      '--hostname',
      '0.0.0.0',
      '--port',
      '3421',
    ]);

    expect(flags.command).toBe('unknown');
    expect(flags.rawCommand).toBe('serve');
    expect(flags.errors).toEqual(['Unsupported command: serve. GoodVibes Agent connects to an externally managed GoodVibes host and does not start server processes.']);
    expect(flags.positionals).toEqual([]);
    expect(flags.flags.workingDir).toBe('/workspace');
    expect(flags.flags.noAltScreen).toBe(true);
    expect(flags.flags.hostname).toBe('0.0.0.0');
    expect(flags.flags.port).toBe(3421);
  });

  test('parses optional resume values and keeps -c reserved for config overrides', () => {
    const resumeLatest = parseGoodVibesCli(['--resume']);
    expect(resumeLatest.errors).toEqual([]);
    expect(resumeLatest.flags.resume).toBe('latest');

    const resumeTarget = parseGoodVibesCli(['--resume', 'session-123']);
    expect(resumeTarget.errors).toEqual([]);
    expect(resumeTarget.flags.resume).toBe('session-123');

    const config = parseGoodVibesCli(['-c', 'behavior.autoApprove=true']);
    expect(config.errors).toEqual([]);
    expect(config.flags.configOverrides).toEqual(['behavior.autoApprove=true']);
    expect(config.flags.continueLast).toBe(false);
  });

  test('applies config overrides for the current process without persisting settings', () => {
    const root = makeProjectTempDir('goodvibes-cli-config');
    const configDir = join(root, '.goodvibes', 'tui');
    const configManager = new ConfigManager({ surfaceRoot: 'tui', configDir, workingDir: root });

    const errors = applyRuntimeConfigOverrides(configManager, [
      'controlPlane.port=4567',
      'behavior.autoApprove=true',
    ]);
    applyRuntimeConfigValue(configManager, 'provider.model', 'openai:gpt-5.2');
    // Feature overrides write the features' domain settings keys (dissolved
    // feature model). fetch-sanitization is always-available (constant), so
    // disabling it reports an honest error naming its real settings keys.
    const featureErrors = applyRuntimeFeatureOverrides(configManager, {
      enableFeatures: ['output-schema-fingerprint'],
      disableFeatures: ['exec-sandbox'],
    });

    expect(errors).toEqual([]);
    expect(featureErrors).toEqual([]);
    expect(configManager.get('controlPlane.port')).toBe(4567);
    expect(configManager.get('behavior.autoApprove')).toBe(true);
    expect(configManager.get('provider.model')).toBe('openai:gpt-5.2');
    expect(configManager.get('tools.outputSchemaFingerprints')).toBe(true);
    expect(configManager.get('sandbox.enabled')).toBe(false);
    expect(existsSync(join(configDir, 'settings.json'))).toBe(false);

    const reloaded = new ConfigManager({ surfaceRoot: 'tui', configDir, workingDir: root });
    expect(reloaded.get('controlPlane.port')).toBe(3421);
    expect(reloaded.get('behavior.autoApprove')).toBe(false);
    expect(reloaded.get('provider.model')).not.toBe('openai:gpt-5.2');
    // Runtime-only: the domain-key writes never persisted.
    expect(reloaded.get('tools.outputSchemaFingerprints')).toBe(false);
    expect(reloaded.get('sandbox.enabled')).toBe(true);
  });

  test('applies runtime URL overrides to connected-host connection without persisting settings', () => {
    const root = makeProjectTempDir('goodvibes-cli-runtime-url');
    const configDir = join(root, '.goodvibes', 'agent');
    const configManager = new ConfigManager({ surfaceRoot: 'agent', configDir, workingDir: root });

    const errors = applyRuntimeUrlOverride(configManager, 'runtime.example.test:4521');

    expect(errors).toEqual([]);
    expect(configManager.get('controlPlane.hostMode')).toBe('custom');
    expect(configManager.get('controlPlane.host')).toBe('runtime.example.test');
    expect(configManager.get('controlPlane.port')).toBe(4521);
    expect(existsSync(join(configDir, 'settings.json'))).toBe(false);

    const reloaded = new ConfigManager({ surfaceRoot: 'agent', configDir, workingDir: root });
    expect(reloaded.get('controlPlane.host')).toBe('127.0.0.1');
    expect(reloaded.get('controlPlane.port')).toBe(3421);
  });

  test('rejects invalid runtime URL overrides before changing config', () => {
    const root = makeProjectTempDir('goodvibes-cli-runtime-url-invalid');
    const configManager = new ConfigManager({
      surfaceRoot: 'agent',
      configDir: join(root, '.goodvibes', 'agent'),
      workingDir: root,
    });

    const unsupportedProtocol = applyRuntimeUrlOverride(configManager, 'https://runtime.example.test:4521');
    const pathScoped = applyRuntimeUrlOverride(configManager, 'http://runtime.example.test:4521/api');
    const badPort = applyRuntimeUrlOverride(configManager, 'http://runtime.example.test:99999');

    expect(unsupportedProtocol[0]).toContain('must use http://');
    expect(pathScoped[0]).toContain('connected GoodVibes API root');
    expect(badPort[0]).toContain('valid http://host:port URL');
    expect(configManager.get('controlPlane.host')).toBe('127.0.0.1');
    expect(configManager.get('controlPlane.port')).toBe(3421);
  });

  test('does not apply endpoint flags for removed lifecycle CLI words', () => {
    const root = makeProjectTempDir('goodvibes-cli-endpoint');
    const configDir = join(root, '.goodvibes', 'tui');
    const configManager = new ConfigManager({ surfaceRoot: 'tui', configDir, workingDir: root });
    const cli = parseGoodVibesCli(['web', '--hostname', '0.0.0.0', '--port', '4568']);

    const errors = applyRuntimeCommandEndpointFlagOverrides(configManager, cli.command, cli.flags);

    expect(errors).toEqual([]);
    expect(cli.command).toBe('unknown');
    expect(cli.rawCommand).toBe('web');
    expect(cli.errors).toEqual(['Unsupported command: web. GoodVibes Agent does not start web servers or expose browser routes.']);
    expect(cli.positionals).toEqual([]);
    expect(configManager.get('web.hostMode')).toBe('local');
    expect(configManager.get('web.host')).toBe('127.0.0.1');
    expect(configManager.get('web.port')).not.toBe(4568);
    expect(existsSync(join(configDir, 'settings.json'))).toBe(false);
  });

  test('bundle inspect resolves relative paths from the GoodVibes working directory', async () => {
    const root = makeProjectTempDir('goodvibes-cli-bundle');
    const configManager = new ConfigManager({
      surfaceRoot: 'tui',
      configDir: join(root, '.goodvibes', 'tui'),
      workingDir: root,
    });
    const bundlePath = join(root, 'support-bundle.json');
    writeFileSync(bundlePath, JSON.stringify({
      type: 'goodvibes.setup',
      version: 1,
      capturedAt: 0,
      config: { web: { enabled: true } },
    }), 'utf-8');
    const cli = parseGoodVibesCli(['bundle', 'inspect', 'support-bundle.json']);
    const logs: string[] = [];
    const originalLog = console.log;
    try {
      console.log = (value?: unknown) => { logs.push(String(value)); };
      const result = await handleGoodVibesCliCommand({
        cli,
        configManager,
        workingDirectory: root,
        homeDirectory: root,
      });
      expect(result).toEqual({ handled: true, exitCode: 0 });
    } finally {
      console.log = originalLog;
    }

    expect(logs.join('\n')).toContain(`path: ${bundlePath}`);
  });

  test('bundle export redacts secret config values and import skips redacted sentinels', async () => {
    const root = makeProjectTempDir('goodvibes-cli-bundle-redaction');
    const configManager = new ConfigManager({
      surfaceRoot: 'tui',
      configDir: join(root, '.goodvibes', 'tui'),
      workingDir: root,
    });
    configManager.setDynamic('surfaces.slack.signingSecret', 'slack-secret-value');
    configManager.setDynamic('surfaces.slack.botToken', 'xoxb-secret-value');
    configManager.setDynamic('surfaces.slack.defaultChannel', 'goodvibes-alerts');
    const logPath = join(root, '.goodvibes', 'tui', 'service', 'manual.log');
    mkdirSync(join(root, '.goodvibes', 'tui', 'service'), { recursive: true });
    writeFileSync(logPath, 'failed with slack-secret-value and xoxb-secret-value\n', 'utf-8');
    configManager.setDynamic('service.logPath', logPath);

    const exported = await captureGoodVibesCliCommand(['bundle', 'export', 'support-bundle.json'], configManager, root);
    expect(exported.result).toEqual({ handled: true, exitCode: 0 });
    const raw = readFileSync(join(root, 'support-bundle.json'), 'utf-8');
    expect(raw).not.toContain('slack-secret-value');
    expect(raw).not.toContain('xoxb-secret-value');
    expect(raw).toContain('<redacted>');
    const bundle = JSON.parse(raw) as {
      config: { surfaces: { slack: { signingSecret: string; botToken: string; defaultChannel: string } } };
      redaction: { redactedConfigPaths: string[] };
      diagnostics: { service: { issues: string[] } };
    };
    expect(bundle.config.surfaces.slack.signingSecret).toBe('<redacted>');
    expect(bundle.config.surfaces.slack.botToken).toBe('<redacted>');
    expect(bundle.config.surfaces.slack.defaultChannel).toBe('goodvibes-alerts');
    expect(bundle.redaction.redactedConfigPaths).toContain('surfaces.slack.signingSecret');
    expect(bundle.diagnostics.service.issues).toBeArray();

    const importRoot = makeProjectTempDir('goodvibes-cli-bundle-import');
    const importedConfig = new ConfigManager({
      surfaceRoot: 'tui',
      configDir: join(importRoot, '.goodvibes', 'tui'),
      workingDir: importRoot,
    });
    const imported = await captureGoodVibesCliCommand(['bundle', 'import', join(root, 'support-bundle.json')], importedConfig, importRoot);
    expect(imported.result).toEqual({ handled: true, exitCode: 0 });
    expect(imported.output).toContain('redacted values skipped');
    expect(importedConfig.get('surfaces.slack.signingSecret')).toBe('');
    expect(importedConfig.get('surfaces.slack.botToken')).toBe('');
    expect(importedConfig.get('surfaces.slack.defaultChannel')).toBe('goodvibes-alerts');
  });


  test('providers and models commands surface setup posture through CLI output', async () => {
    const root = makeProjectTempDir('goodvibes-cli-provider-posture');
    const configManager = new ConfigManager({
      surfaceRoot: 'tui',
      configDir: join(root, '.goodvibes', 'tui'),
      workingDir: root,
    });

    const providersText = await captureGoodVibesCliCommand(['providers', 'inspect', 'openai-subscriber'], configManager, root);
    expect(providersText.result).toEqual({ handled: true, exitCode: 0 });
    expect(providersText.output).toContain('setup: Subscription');

    const providersJson = await captureGoodVibesCliCommand(['providers', 'inspect', 'openai-subscriber', '--json'], configManager, root);
    expect(providersJson.result).toEqual({ handled: true, exitCode: 0 });
    expect((JSON.parse(providersJson.output) as { setup: { setupClass: string } }).setup.setupClass).toBe('subscription');

    const modelsText = await captureGoodVibesCliCommand(['models', 'current'], configManager, root);
    expect(modelsText.result).toEqual({ handled: true, exitCode: 0 });
    expect(modelsText.output).toContain('setup:');
    expect(modelsText.output).toContain('provider configured:');

    const modelsJson = await captureGoodVibesCliCommand(['models', 'current', '--json'], configManager, root);
    expect(modelsJson.result).toEqual({ handled: true, exitCode: 0 });
    expect((JSON.parse(modelsJson.output) as { setup: { setupClass: string } }).setup.setupClass).toBeString();
  });

  test('secrets test redacts resolved secret values in text and json output', async () => {
    const root = makeProjectTempDir('goodvibes-cli-secret-redaction');
    const configManager = new ConfigManager({
      surfaceRoot: 'tui',
      configDir: join(root, '.goodvibes', 'tui'),
      workingDir: root,
    });
    const secretValue = 'gv-sensitive-value-that-must-not-print';
    const previousSecretValue = process.env.GV_CLI_SECRET_REDACTION;
    process.env.GV_CLI_SECRET_REDACTION = secretValue;

    try {
      const text = await captureGoodVibesCliCommand(['secrets', 'test', 'goodvibes://secrets/env/GV_CLI_SECRET_REDACTION'], configManager, root);
      expect(text.result).toEqual({ handled: true, exitCode: 0 });
      expect(text.output).toContain('resolved <redacted>');
      expect(text.output).not.toContain(secretValue);

      const json = await captureGoodVibesCliCommand(['secrets', 'test', 'goodvibes://secrets/env/GV_CLI_SECRET_REDACTION', '--json'], configManager, root);
      expect(json.result).toEqual({ handled: true, exitCode: 0 });
      expect(json.output).not.toContain(secretValue);
      expect(JSON.parse(json.output)).toEqual({
        ref: 'env:GV_CLI_SECRET_REDACTION',
        resolved: true,
      });
    } finally {
      if (previousSecretValue === undefined) delete process.env.GV_CLI_SECRET_REDACTION;
      else process.env.GV_CLI_SECRET_REDACTION = previousSecretValue;
    }
  });

  test('rejects invalid runtime config overrides', () => {
    const root = makeProjectTempDir('goodvibes-cli-config-invalid');
    const configManager = new ConfigManager({
      surfaceRoot: 'tui',
      configDir: join(root, '.goodvibes', 'tui'),
      workingDir: root,
    });

    const errors = applyRuntimeConfigOverrides(configManager, [
      'controlPlane.port=99999',
      'not.real=true',
    ]);

    expect(errors).toHaveLength(2);
    expect(errors[0]).toContain('Invalid --config controlPlane.port=99999');
    expect(errors[1]).toContain('Unknown config key: not.real');
    expect(configManager.get('controlPlane.port')).toBe(3421);
  });
});
