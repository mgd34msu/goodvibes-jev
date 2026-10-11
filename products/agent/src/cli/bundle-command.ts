import { resolveConnectedHostBaseUrl } from '../config/connected-host-dial.ts';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { createShellPathService } from '@/runtime/index.ts';
import { listProviderRuntimeSnapshots } from '@goodvibes-jev/engine/sdk/platform/providers';
import type { RuntimeServices } from '../runtime/services.ts';
import { readConnectedHostOperatorToken } from '../runtime/connected-host-auth.ts';
import { getOnboardingCheckMarkerPath } from '../runtime/onboarding/index.ts';
import { CONFIG_SCHEMA } from '../config/index.ts';
import { SecretsManager } from '../config/secrets.ts';
import { withRuntimeServices, type CliCommandRuntime } from './management.ts';
import type { CliCommandOutput } from './types.ts';
import { getPackageVersion } from './help.ts';
import { classifyProviderSetup } from './provider-classification.ts';
import { buildCliServicePosture } from './service-posture.ts';
import { REDACTED_VALUE, isRedactedValue, prepareConfigRedaction, redactSerializedSecrets, retainCliConfig } from '@goodvibes-jev/engine/terminal-shell';
import { captureJudgmentPort, type JudgmentReadingOptions } from '@goodvibes-jev/engine/errors';
import { GOODVIBES_AGENT_SURFACE_ROOT } from '../config/surface.ts';
import { appendTemporalLabel } from './temporal-label.ts';

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
    cursor = Reflect.get(cursor, part);
  }
  return cursor;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readJsonFile(path: string): { readonly ok: true; readonly value: Record<string, unknown> } | { readonly ok: false; readonly error: string } {
  try {
    const value = JSON.parse(readFileSync(path, 'utf-8')) as unknown;
    if (!isRecord(value)) return { ok: false, error: 'Bundle file must contain a JSON object.' };
    return { ok: true, value };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
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
  const userStorePath = shellPaths.resolveUserPath(GOODVIBES_AGENT_SURFACE_ROOT, 'auth-users.json');
  const bootstrapCredentialPath = shellPaths.resolveUserPath(GOODVIBES_AGENT_SURFACE_ROOT, 'auth-bootstrap.txt');
  const operatorToken = readConnectedHostOperatorToken(runtime.homeDirectory, resolveConnectedHostBaseUrl(runtime.configManager));
  return {
    userStorePath,
    userStorePresent: existsSync(userStorePath),
    bootstrapCredentialPath,
    bootstrapCredentialPresent: existsSync(bootstrapCredentialPath),
    operatorTokenPath: operatorToken.path,
    operatorTokenPresent: operatorToken.present && Boolean(operatorToken.token),
  };
}

async function buildProviderReadiness(services: RuntimeServices) {
  const snapshots = await listProviderRuntimeSnapshots(services.providerRegistry, { modelFamilyEnrichment: 'none' });
  return snapshots.map((snapshot) => ({
    provider: snapshot.providerId,
    active: snapshot.active,
    configured: snapshot.runtime.auth?.configured ?? true,
    configuredVia: snapshot.runtime.auth?.mode ?? 'unknown',
    models: snapshot.modelCount,
    setup: classifyProviderSetup({
      providerId: snapshot.providerId,
      authMode: snapshot.runtime.auth?.mode,
      configured: snapshot.runtime.auth?.configured ?? true,
      modelCount: snapshot.modelCount,
    }),
  }));
}

export async function handleBundleCommand(runtime: CliCommandRuntime, options: JudgmentReadingOptions = {}): Promise<CliCommandOutput> {
  const [sub = 'inspect', ...rest] = runtime.cli.commandArgs;
  const shellPaths = createShellPathService({
    workingDirectory: runtime.workingDirectory,
    homeDirectory: runtime.homeDirectory,
  });

  if (sub === 'inspect') {
    const path = rest[0];
    if (!path) return { output: `Usage: ${runtime.cli.binary} bundle inspect <path>`, exitCode: 2 };
    const sourcePath = shellPaths.resolveWorkspacePath(path);
    const parsed = readJsonFile(sourcePath);
    if (!parsed.ok) return { output: `Invalid bundle JSON ${parsed.error}`, exitCode: 1 };
    const summary = inspectBundle(sourcePath, parsed.value);
    return {
      output: formatJsonOrText(runtime, summary, [
        'GoodVibes Agent support bundle',
        `  type: ${summary.type}`,
        `  version: ${summary.version}`,
        `  path: ${summary.path}`,
        `  capturedAt: ${summary.capturedAt === null ? 'n/a' : appendTemporalLabel(new Date(summary.capturedAt).toISOString(), summary.capturedAt)}`,
        `  configKeys: ${summary.configKeys}`,
        `  redactedConfigKeys: ${summary.redactedConfigPaths.length}`,
        `  diagnostics: ${summary.hasDiagnostics ? 'present' : 'missing'}`,
      ].join('\n')),
      exitCode: 0,
    };
  }

  if (sub === 'export') {
    const outputPath = rest[0] ?? 'goodvibes-agent-bundle.json';
    const secrets = new SecretsManager({
      projectRoot: runtime.workingDirectory,
      globalHome: runtime.homeDirectory,
      configManager: runtime.configManager,
    });
    const configManager = runtime.configManager;
    const retainedConfig = retainCliConfig(configManager);
    const rawConfig = retainedConfig.raw;
    const workingDirectory = runtime.workingDirectory;
    const homeDirectory = runtime.homeDirectory;
    const signal = options.signal;
    const callerCurrent = options.assertCurrent;
    const sourceCurrent = () => {
      signal?.throwIfAborted();
      if (options.signal !== signal || options.assertCurrent !== callerCurrent || runtime.configManager !== configManager
        || runtime.workingDirectory !== workingDirectory || runtime.homeDirectory !== homeDirectory) throw new Error('Support bundle input changed before export.');
      try { retainedConfig.assertCurrent(); }
      catch { throw new Error('Support bundle input changed before export.'); }
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
      const owner = captureJudgmentPort('agent.cli.bundle-export', { ...options, assertCurrent });
      const reading = { ...options, signal: owner.signal, assertCurrent: owner.assertCurrent };
      const providerReadiness = await buildProviderReadiness(services);
      assertCurrent();
      const redactedConfig = await prepareConfigRedaction(rawConfig, reading);
      const service = await buildCliServicePosture(runtime, { ...reading, logTailBytes: 8192 });
      const bundle = {
        version: 2,
        type: 'goodvibes-agent.support',
        capturedAt: Date.now(),
        package: {
          name: '@pellux/goodvibes-agent',
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
          providers: providerReadiness,
        },
        secrets: await secrets.inspect(),
        onboarding: {
          userMarker: existsSync(getOnboardingCheckMarkerPath(shellPaths, 'user')),
          projectMarker: existsSync(getOnboardingCheckMarkerPath(shellPaths, 'project')),
        },
      };
      const targetPath = shellPaths.resolveWorkspacePath(outputPath);
      const serialized = await redactSerializedSecrets(JSON.stringify(bundle, null, 2), redactedConfig.sensitiveValues, reading);
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
          hostIntegrationIssues: service.issues,
        }, `Bundle exported: ${targetPath}\n  redactedConfigKeys: ${redactedConfig.redactedPaths.length}\n  hostIntegrationIssues: ${service.issues.length}`),
        exitCode: 0,
      };
    }, { catalog: { contextWindowEnrichment: 'none' } });
  }

  if (sub === 'import') {
    const path = rest[0];
    if (!path) return { output: `Usage: ${runtime.cli.binary} bundle import <path>`, exitCode: 2 };
    const sourcePath = shellPaths.resolveWorkspacePath(path);
    const parsed = readJsonFile(sourcePath);
    if (!parsed.ok) return { output: `Invalid bundle JSON ${parsed.error}`, exitCode: 1 };
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
      runtime.configManager.setDynamic(setting.key, value);
      count++;
    }
    return {
      output: `Bundle imported: ${count} config value${count === 1 ? '' : 's'} applied.${skippedRedacted ? ` ${skippedRedacted} redacted value${skippedRedacted === 1 ? '' : 's'} skipped.` : ''}`,
      exitCode: 0,
    };
  }

  return { output: `Usage: ${runtime.cli.binary} bundle export [path]|inspect <path>|import <path>`, exitCode: 2 };
}
