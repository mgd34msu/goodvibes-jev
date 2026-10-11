import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { createShellPathService } from '@/runtime/index.ts';
import { listProviderRuntimeSnapshots } from '@goodvibes-jev/engine/sdk/platform/providers';
import type { RuntimeServices } from '../runtime/services.ts';
import { withRuntimeServices } from './management-utils.ts';
import { getOnboardingCheckMarkerPath } from '../runtime/onboarding/index.ts';
import { CONFIG_SCHEMA } from '@goodvibes-jev/engine/sdk/platform/config';
import { SecretsManager } from '../config/secrets.ts';
import type { ConfigKey } from '@goodvibes-jev/engine/sdk/platform/config';
import type { CliCommandRuntime } from '@goodvibes-jev/engine/terminal-shell';
import type { CliCommandOutput } from '@goodvibes-jev/engine/terminal-shell';
import { getPackageVersion } from './help.ts';
import { classifyProviderSetup } from '../providers/provider-classification.ts';
import { buildCliServicePosture } from './service-posture.ts';
import { REDACTED_VALUE, collectSensitiveConfigValues, isRedactedValue, redactConfig, redactSerializedSecrets } from '@goodvibes-jev/engine/terminal-shell';
import { summarizeError } from '@goodvibes-jev/engine/sdk/platform/utils';
import { captureJudgmentPort, type JudgmentReadingOptions } from '@goodvibes-jev/engine/errors';
import { captureStrictJudgmentJson } from '@goodvibes-jev/engine/sdk/platform/gate';

interface BundleInspectSummary {
  readonly type: string;
  readonly version: string;
  readonly path: string;
  readonly capturedAt: number | null;
  readonly configKeys: number;
  readonly redactedConfigPaths: readonly string[];
  readonly hasDiagnostics: boolean;
}

function formatJsonOrText(runtime: CliCommandRuntime, value: unknown, text: string): string {
  return runtime.cli.flags.outputFormat === 'json' ? JSON.stringify(value, null, 2) : text;
}

function getNestedValue(source: unknown, key: string): unknown {
  let cursor = source;
  for (const part of key.split('.')) {
    if (cursor == null || typeof cursor !== 'object') return undefined;
    cursor = (cursor as Record<string, unknown>)[part];
  }
  return cursor;
}

function readJsonFile(path: string): { readonly ok: true; readonly value: Record<string, unknown> } | { readonly ok: false; readonly error: string } {
  try {
    return { ok: true, value: JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown> };
  } catch (error) {
    return { ok: false, error: summarizeError(error) };
  }
}

function inspectBundle(path: string, parsed: Record<string, unknown>): BundleInspectSummary {
  return {
    type: String(parsed['type'] ?? 'unknown'),
    version: String(parsed['version'] ?? 'unknown'),
    path,
    capturedAt: typeof parsed['capturedAt'] === 'number' ? parsed['capturedAt'] : null,
    configKeys: parsed['config'] && typeof parsed['config'] === 'object'
      ? CONFIG_SCHEMA.filter((setting) => getNestedValue(parsed['config'], setting.key) !== undefined).length
      : 0,
    redactedConfigPaths: Array.isArray((parsed['redaction'] as { redactedConfigPaths?: unknown } | undefined)?.redactedConfigPaths)
      ? (parsed['redaction'] as { redactedConfigPaths: string[] }).redactedConfigPaths
      : [],
    hasDiagnostics: Boolean(parsed['diagnostics'] && typeof parsed['diagnostics'] === 'object'),
  };
}

function readAuthPosture(runtime: CliCommandRuntime) {
  const shellPaths = createShellPathService({
    workingDirectory: runtime.workingDirectory,
    homeDirectory: runtime.homeDirectory,
  });
  const userStorePath = shellPaths.resolveUserPath('tui', 'auth-users.json');
  const bootstrapCredentialPath = shellPaths.resolveUserPath('tui', 'auth-bootstrap.txt');
  const operatorTokenPath = join(runtime.homeDirectory, '.goodvibes', 'daemon', 'operator-tokens.json');
  return {
    userStorePath,
    userStorePresent: existsSync(userStorePath),
    bootstrapCredentialPath,
    bootstrapCredentialPresent: existsSync(bootstrapCredentialPath),
    operatorTokenPath,
    operatorTokenPresent: existsSync(operatorTokenPath),
  };
}

async function buildProviderReadiness(services: RuntimeServices) {
  const snapshots = await listProviderRuntimeSnapshots(services.providerRegistry, { modelFamilyEnrichment: 'none' });
  return await Promise.all(snapshots.map(async (snapshot) => ({
    provider: snapshot.providerId,
    active: snapshot.active,
    configured: snapshot.runtime.auth?.configured ?? true,
    configuredVia: snapshot.runtime.auth?.mode ?? 'unknown',
    models: snapshot.modelCount,
    setup: await classifyProviderSetup(snapshot, { site: 'tui.support-bundle.setup' }),
  })));
}

export async function handleBundleCommand(runtime: CliCommandRuntime, options: JudgmentReadingOptions = {}): Promise<CliCommandOutput> {
  const [sub = 'inspect', ...rest] = runtime.cli.commandArgs;
  const shellPaths = createShellPathService({
    workingDirectory: runtime.workingDirectory,
    homeDirectory: runtime.homeDirectory,
  });

  if (sub === 'inspect') {
    const path = rest[0];
    if (!path) return { output: 'Usage: goodvibes support-bundle inspect <path>', exitCode: 2 };
    const sourcePath = shellPaths.resolveWorkspacePath(path);
    const parsed = readJsonFile(sourcePath);
    if (!parsed.ok) return { output: `Invalid bundle JSON: ${parsed.error}`, exitCode: 1 };
    const summary = inspectBundle(sourcePath, parsed.value);
    return {
      output: formatJsonOrText(runtime, summary, [
        'GoodVibes support bundle',
        `  type: ${summary.type}`,
        `  version: ${summary.version}`,
        `  path: ${summary.path}`,
        `  capturedAt: ${summary.capturedAt === null ? 'n/a' : new Date(summary.capturedAt).toISOString()}`,
        `  configKeys: ${summary.configKeys}`,
        `  redactedConfigKeys: ${summary.redactedConfigPaths.length}`,
        `  diagnostics: ${summary.hasDiagnostics ? 'present' : 'missing'}`,
      ].join('\n')),
      exitCode: 0,
    };
  }

  if (sub === 'export') {
    const outputPath = rest[0] ?? 'goodvibes-bundle.json';
    const secrets = new SecretsManager({
      projectRoot: runtime.workingDirectory,
      globalHome: runtime.homeDirectory,
      configManager: runtime.configManager,
    });
    const rawConfig = runtime.configManager.getRaw();
    const configManager = runtime.configManager;
    const workingDirectory = runtime.workingDirectory, homeDirectory = runtime.homeDirectory;
    const snapshot = captureStrictJudgmentJson(rawConfig);
    const signal = options.signal, callerCurrent = options.assertCurrent;
    const sourceCurrent = () => {
      signal?.throwIfAborted();
      if (options.signal !== signal || options.assertCurrent !== callerCurrent || runtime.configManager !== configManager
        || runtime.workingDirectory !== workingDirectory || runtime.homeDirectory !== homeDirectory
        || !isDeepStrictEqual(captureStrictJudgmentJson(configManager.getRaw()), snapshot)) throw new Error('Support bundle input changed before export.');
    };
    const assertCurrent = () => {
      sourceCurrent();
      const result: unknown = callerCurrent?.();
      if (result !== undefined) { void Promise.resolve(result).catch(() => {}); throw new Error('Support bundle ownership must be synchronous.'); }
      sourceCurrent();
    };
    assertCurrent();
    return await withRuntimeServices(runtime, async (services) => {
      assertCurrent();
      const owner = captureJudgmentPort('terminal-shell.support-bundle.export', { ...options, assertCurrent });
      owner.assertCurrent();
      const providers = await buildProviderReadiness(services);
      owner.assertCurrent();
      const reading = { ...options, signal: owner.signal, assertCurrent: owner.assertCurrent };
      const sensitiveValues = await collectSensitiveConfigValues(rawConfig, reading);
      const redactedConfig = await redactConfig(rawConfig, reading);
      const service = await buildCliServicePosture(runtime, { ...reading, logTailBytes: 8192 });
      const bundle = {
        version: 2,
        type: 'goodvibes.support',
        capturedAt: Date.now(),
        package: {
          name: '@goodvibes-jev/tui',
          version: getPackageVersion(),
        },
        roots: {
          workingDirectory: runtime.workingDirectory,
          homeDirectory: runtime.homeDirectory,
        },
        config: redactedConfig.value,
        redaction: {
          sentinel: REDACTED_VALUE,
          redactedConfigPaths: redactedConfig.redactedPaths,
        },
        diagnostics: {
          service,
          auth: readAuthPosture(runtime),
          providers,
        },
        secrets: await secrets.inspect(),
        onboarding: {
          userMarker: existsSync(getOnboardingCheckMarkerPath(shellPaths, 'user')),
          projectMarker: existsSync(getOnboardingCheckMarkerPath(shellPaths, 'project')),
        },
      };
      const targetPath = shellPaths.resolveWorkspacePath(outputPath);
      const serialized = await redactSerializedSecrets(JSON.stringify(bundle, null, 2), sensitiveValues, reading);
      redactedConfig.assertCurrent();
      owner.assertCurrent();
      mkdirSync(dirname(targetPath), { recursive: true });
      redactedConfig.assertCurrent();
      owner.assertCurrent();
      writeFileSync(targetPath, serialized + '\n', 'utf-8');
      return {
        output: formatJsonOrText(runtime, {
          path: targetPath,
          redactedConfigPaths: redactedConfig.redactedPaths,
          serviceIssues: service.issues,
        }, `Support bundle exported: ${targetPath}\n  redactedConfigKeys: ${redactedConfig.redactedPaths.length}\n  serviceIssues: ${service.issues.length}`),
        exitCode: 0,
      };
    });
  }

  if (sub === 'import') {
    const path = rest[0];
    if (!path) return { output: 'Usage: goodvibes support-bundle import <path>', exitCode: 2 };
    const sourcePath = shellPaths.resolveWorkspacePath(path);
    const parsed = readJsonFile(sourcePath);
    if (!parsed.ok) return { output: `Invalid bundle JSON: ${parsed.error}`, exitCode: 1 };
    const config = parsed.value['config'];
    if (!config || typeof config !== 'object') return { output: 'Bundle has no config object to import.', exitCode: 1 };
    let count = 0;
    let skippedRedacted = 0;
    for (const setting of CONFIG_SCHEMA) {
      const value = getNestedValue(config, setting.key);
      if (value === undefined) continue;
      if (isRedactedValue(value)) {
        skippedRedacted++;
        continue;
      }
      runtime.configManager.setDynamic(setting.key as ConfigKey, value as never);
      count++;
    }
    return {
      output: `Bundle imported: ${count} config value${count === 1 ? '' : 's'} applied.${skippedRedacted ? ` ${skippedRedacted} redacted value${skippedRedacted === 1 ? '' : 's'} skipped.` : ''}`,
      exitCode: 0,
    };
  }

  return { output: 'Usage: goodvibes support-bundle export [path]|inspect <path>|import <path>', exitCode: 2 };
}
