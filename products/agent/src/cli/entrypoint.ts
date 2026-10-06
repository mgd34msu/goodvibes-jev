import { readConnectedHostReadiness } from '../runtime/connected-host-readiness.ts';
import { canonicalizePairingHost, readAgentHostPairing } from '../runtime/connected-host-pairing-store.ts';
import { resolveConnectedHostBaseUrl } from '../config/connected-host-dial.ts';
import { extractNativeHeadlessOptions } from './native-headless-options.ts';
import { runNativeHeadlessCommand } from './native-headless-command.ts';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { AgentConfigManager, type ConfigManager } from '../config/index.ts';
import { ensureDaemonConfigMigrated } from '../config/ensure-daemon-config-migrated.ts';
import { ensureDaemonEnabledMigrated } from '../config/ensure-daemon-enabled-migrated.ts';
import { formatProviderModel, getModelIdFromProviderModel, getProviderIdFromModel } from '../config/provider-model.ts';
import { readOnboardingCheckMarkers } from '../runtime/onboarding/index.ts';
import { GlobalNetworkTransportInstaller } from '@/runtime/index.ts';
import { createShellPathService } from '@/runtime/index.ts';
import { configureActivityLogger, logger } from '@goodvibes-jev/engine/sdk/platform/utils';
import {
  applyRuntimeCommandEndpointFlagOverrides,
  applyRuntimeConfigOverrides,
  applyRuntimeConfigValue,
  applyRuntimeFeatureOverrides,
  applyRuntimeUrlOverride,
  buildCliStatusSnapshot,
  handleGoodVibesCliCommand,
  parseGoodVibesCli,
  renderCliStatus,
  renderCompletion,
  renderGoodVibesCommandHelp,
  renderGoodVibesHelp,
  renderGoodVibesVersion,
  renderOnboardingCliStatus,
} from './index.ts';
import { buildCliServicePosture } from './service-posture.ts';
import { inspectCliExternalRuntime } from './external-runtime.ts';
import { inspectConnectedHostMetrics } from './connected-host-metrics.ts';
import { GOODVIBES_AGENT_SURFACE_ROOT } from '../config/surface.ts';
import { writeExitingStdoutLine, writeFatalLine } from '../utils/fatal-boot-write.ts';
import { readCheckpointRegistrationSetting } from '../config/checkpoint-settings.ts';
import { backfillCheckpointEligibilityIfNeeded, migrateLegacyWorkspaceRegistryIfNeeded, resolveCheckpointEligibilitySync } from '../config/workspace-registration.ts';
import { resolveAgentRuntimeProfileHome, resolveSelectedAgentRuntimeProfileHome } from '../agent/runtime-profile.ts';

type ShellEntrypointOwnership = {
  readonly workingDirectory: string;
  readonly homeDirectory: string;
};

function readEnvRuntimeUrl(): { readonly source: string; readonly value: string } | null {
  const runtimeUrl = process.env['GOODVIBES_AGENT_RUNTIME_URL'];
  if (runtimeUrl !== undefined) return { source: 'GOODVIBES_AGENT_RUNTIME_URL', value: runtimeUrl };
  const legacyBaseUrl = process.env['GOODVIBES_AGENT_BASE_URL'];
  if (legacyBaseUrl !== undefined) return { source: 'GOODVIBES_AGENT_BASE_URL', value: legacyBaseUrl };
  return null;
}

export type ShellEntrypointRoots = {
  readonly defaultWorkingDirectory: string;
  readonly homeDirectory: string;
};

export type PreparedShellCliRuntime = {
  readonly cli: ReturnType<typeof parseGoodVibesCli>;
  readonly configManager: ConfigManager;
  readonly bootstrapWorkingDir: string;
  readonly bootstrapHomeDirectory: string;
};

export function resolveShellEntrypointOwnership(
  roots: ShellEntrypointRoots,
  workingDirOverride?: string,
  options: {
    readonly agentProfile?: string;
    readonly useSelectedProfile: boolean;
  } = { useSelectedProfile: true },
): ShellEntrypointOwnership {
  const selectedProfile = options.agentProfile
    ? resolveAgentRuntimeProfileHome(roots.homeDirectory, options.agentProfile)
    : options.useSelectedProfile
      ? resolveSelectedAgentRuntimeProfileHome(roots.homeDirectory)
      : null;
  const homeDirectory = selectedProfile?.homeDirectory ?? roots.homeDirectory;
  return {
    workingDirectory: workingDirOverride ?? roots.defaultWorkingDirectory,
    homeDirectory,
  };
}

export async function prepareShellCliRuntime(
  argv: readonly string[],
  roots: ShellEntrypointRoots,
  binary = 'goodvibes-agent',
): Promise<PreparedShellCliRuntime> {
  const native = extractNativeHeadlessOptions(argv);
  const parsed = parseGoodVibesCli(native.argv, binary);
  const nativeErrors = [...native.errors];
  if (native.mode !== 'submit' && parsed.command !== 'run') nativeErrors.push('Native intake recovery requires the run or exec command.');
  const cli = { ...parsed, errors: [...parsed.errors, ...nativeErrors] };

  if (cli.errors.length > 0) {
    writeFatalLine(cli.errors.join('\n'));
    writeFatalLine('');
    writeFatalLine(renderGoodVibesHelp(binary));
    process.exit(2);
  }

  if (cli.flags.help || cli.command === 'help') {
    const helpTopic = cli.command === 'help'
      ? cli.commandArgs[0]
      : cli.rawCommand ?? undefined;
    writeExitingStdoutLine(helpTopic ? renderGoodVibesCommandHelp(helpTopic, binary) : renderGoodVibesHelp(binary));
    process.exit(0);
  }

  if (cli.flags.version || cli.command === 'version') {
    writeExitingStdoutLine(renderGoodVibesVersion(binary));
    process.exit(0);
  }

  if (cli.command === 'completion') {
    writeExitingStdoutLine(renderCompletion(cli.commandArgs[0], binary));
    process.exit(0);
  }

  let ownership: ShellEntrypointOwnership;
  try {
    ownership = resolveShellEntrypointOwnership(
      roots,
      cli.flags.workingDir ?? (cli.command === 'tui' ? cli.commandArgs[0] : undefined),
      {
        agentProfile: cli.command === 'profiles' ? undefined : cli.flags.agentProfile,
        useSelectedProfile: cli.command !== 'profiles',
      },
    );
  } catch (error) {
    writeFatalLine(error instanceof Error ? error.message : String(error));
    process.exit(2);
  }
  const {
    workingDirectory: bootstrapWorkingDir,
    homeDirectory: bootstrapHomeDirectory,
  } = ownership;
  configureActivityLogger(join(bootstrapWorkingDir, '.goodvibes', 'logs'));
  // Daemon-owned settings (chat surfaces, control-plane binding, watchers,
  // device grants, retention) have one home: the daemon's own store. Move them
  // there BEFORE the config manager loads, so this process never resolves a
  // daemon-owned key from a stale surface copy. Idempotent; announces once.
  const daemonConfigNotice = ensureDaemonConfigMigrated(bootstrapHomeDirectory);
  if (daemonConfigNotice) (cli.command === 'run' ? console.error : console.log)(`[goodvibes] ${daemonConfigNotice}`);
  // A `daemon.enabled: false` left over from when the key meant "do not embed a
  // daemon in this process" now means "do not look for a daemon at all", which
  // is how a machine ends up unable to reach the platform with no way to say
  // so. Reset it ONCE, with a receipt, before the config manager reads it,
  // after this pass a false the user sets is theirs and is kept. Idempotent;
  // announces once.
  const daemonEnabledNotice = ensureDaemonEnabledMigrated({
    homeDir: bootstrapHomeDirectory,
    workingDir: bootstrapWorkingDir,
  });
  if (daemonEnabledNotice) (cli.command === 'run' ? console.error : console.log)(`[goodvibes] ${daemonEnabledNotice}`);
  const configManager = new AgentConfigManager({
    workingDir: bootstrapWorkingDir,
    homeDir: bootstrapHomeDirectory,
    surfaceRoot: GOODVIBES_AGENT_SURFACE_ROOT,
  });
  new GlobalNetworkTransportInstaller().install(configManager);

  const envRuntimeUrl = readEnvRuntimeUrl();
  const envRuntimeUrlErrors = envRuntimeUrl
    ? applyRuntimeUrlOverride(configManager, envRuntimeUrl.value, envRuntimeUrl.source)
    : [];
  if (envRuntimeUrlErrors.length > 0) {
    writeFatalLine(envRuntimeUrlErrors.join('\n'));
    process.exit(2);
  }

  const overrideErrors = applyRuntimeConfigOverrides(configManager, cli.flags.configOverrides);
  if (overrideErrors.length > 0) {
    writeFatalLine(overrideErrors.join('\n'));
    process.exit(2);
  }
  const featureOverrideErrors = applyRuntimeFeatureOverrides(configManager, {
    enableFeatures: cli.flags.enableFeatures,
    disableFeatures: cli.flags.disableFeatures,
  });
  if (featureOverrideErrors.length > 0) {
    writeFatalLine(featureOverrideErrors.join('\n'));
    process.exit(2);
  }

  if (cli.flags.provider !== undefined || cli.flags.model !== undefined) {
    const currentModel = configManager.get('provider.model');
    const provider = cli.flags.provider ?? getProviderIdFromModel(currentModel);
    const model = cli.flags.model ?? getModelIdFromProviderModel(currentModel);
    applyRuntimeConfigValue(configManager, 'provider.model', formatProviderModel(provider, model));
  }
  if (cli.flags.runtimeUrl !== undefined) {
    const runtimeUrlErrors = applyRuntimeUrlOverride(configManager, cli.flags.runtimeUrl);
    if (runtimeUrlErrors.length > 0) {
      writeFatalLine(runtimeUrlErrors.join('\n'));
      process.exit(2);
    }
  }
  const endpointOverrideErrors = applyRuntimeCommandEndpointFlagOverrides(configManager, cli.command, cli.flags);
  if (endpointOverrideErrors.length > 0) {
    writeFatalLine(endpointOverrideErrors.join('\n'));
    process.exit(2);
  }

  if (cli.command === 'run') {
    process.exit(await runNativeHeadlessCommand({ cli, configManager, workingDirectory: bootstrapWorkingDir, homeDirectory: bootstrapHomeDirectory }, native.mode));
  }

  if (cli.command === 'onboarding' && cli.commandArgs[0] === 'status') {
    const shellPaths = createShellPathService({ workingDirectory: bootstrapWorkingDir, homeDirectory: bootstrapHomeDirectory });
    const selectedHost = canonicalizePairingHost(resolveConnectedHostBaseUrl(configManager)) ?? '(invalid endpoint)';
    const nativeReadiness = await readConnectedHostReadiness({ configManager, homeDirectory: bootstrapHomeDirectory });
    const pairingStatus = readAgentHostPairing(bootstrapHomeDirectory, selectedHost).status;
    writeExitingStdoutLine(renderOnboardingCliStatus({ configManager, workingDirectory: bootstrapWorkingDir, homeDirectory: bootstrapHomeDirectory,
      onboardingMarkers: readOnboardingCheckMarkers(shellPaths), nativeReadiness, pairingStatus, selectedHost, outputFormat: cli.flags.outputFormat }));
    process.exit(0);
  }

  if (cli.command === 'status' || cli.command === 'doctor') {
    const shellPaths = createShellPathService({
      workingDirectory: bootstrapWorkingDir,
      homeDirectory: bootstrapHomeDirectory,
    });
    const userStorePath = shellPaths.resolveUserPath(GOODVIBES_AGENT_SURFACE_ROOT, 'auth-users.json');
    const bootstrapCredentialPath = shellPaths.resolveUserPath(GOODVIBES_AGENT_SURFACE_ROOT, 'auth-bootstrap.txt');
    const operatorTokenPath = join(bootstrapHomeDirectory, '.goodvibes', 'daemon', 'operator-tokens.json');
    const onboardingMarkers = readOnboardingCheckMarkers(shellPaths);
    const service = await buildCliServicePosture({
      configManager,
      workingDirectory: bootstrapWorkingDir,
      homeDirectory: bootstrapHomeDirectory,
    });
    const externalRuntime = await inspectCliExternalRuntime({
      configManager,
      homeDirectory: bootstrapHomeDirectory,
    });
    // Only probe host metrics when the host is actually reachable, otherwise
    // the unreachability is already reported in the connected-host block above,
    // and skipping the call avoids a second connect-timeout wait. When reachable,
    // the probe classifies token/scope/route state honestly (including the
    // read:telemetry scope-missing case) rather than rendering zeros.
    const connectedHostMetrics = externalRuntime.reachable
      ? await inspectConnectedHostMetrics({
        configManager,
        homeDirectory: bootstrapHomeDirectory,
      })
      : undefined;
    const effectiveOperatorTokenPath = externalRuntime.operatorToken.present
      ? externalRuntime.operatorToken.path
      : operatorTokenPath;
    const registrationMigration = migrateLegacyWorkspaceRegistryIfNeeded(shellPaths);
    if (registrationMigration) {
      logger.info('Migrated the local workspace registry into the shared registration store', { ...registrationMigration });
    }
    backfillCheckpointEligibilityIfNeeded(shellPaths);
    const checkpoints = {
      // Honest to the checkpoint boundary: a workspace is "registered" for
      // checkpoints only when it is checkpoint-ELIGIBLE (an explicit owner
      // opt-in), not merely present in the shared store as a TUI self-record.
      workspaceRegistered: resolveCheckpointEligibilitySync(shellPaths, bootstrapWorkingDir).status === 'covered',
      unregisteredWorkspaceMode: readCheckpointRegistrationSetting(configManager),
    };
    const statusOptions = {
      configManager,
      workingDirectory: bootstrapWorkingDir,
      homeDirectory: bootstrapHomeDirectory,
      onboardingMarkers,
      checkpoints,
      auth: {
        userStorePath,
        userStorePresent: existsSync(userStorePath),
        bootstrapCredentialPath,
        bootstrapCredentialPresent: existsSync(bootstrapCredentialPath),
        operatorTokenPath: effectiveOperatorTokenPath,
        operatorTokenPresent: externalRuntime.operatorToken.present,
      },
      service,
      externalRuntime,
      connectedHostMetrics,
      doctor: cli.command === 'doctor',
      outputFormat: cli.flags.outputFormat,
    };
    const snapshot = buildCliStatusSnapshot(statusOptions);
    writeExitingStdoutLine(renderCliStatus(statusOptions));
    process.exit(cli.command === 'doctor' && snapshot.findings.length > 0 ? 1 : 0);
  }

  const cliCommandResult = await handleGoodVibesCliCommand({
    cli,
    configManager,
    workingDirectory: bootstrapWorkingDir,
    homeDirectory: bootstrapHomeDirectory,
  });
  if (cliCommandResult.handled) {
    process.exit(cliCommandResult.exitCode);
  }

  return { cli, configManager, bootstrapWorkingDir, bootstrapHomeDirectory };
}
