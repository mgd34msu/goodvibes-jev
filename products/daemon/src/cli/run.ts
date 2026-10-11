/** CLI dispatch without import-time startup. Adapted from the upstream daemon/cli. */
import { homedir } from 'node:os';
import { writeSync } from 'node:fs';
import { runClusterCommand, resolveRuntimeEndpointBinding } from '@goodvibes-jev/engine/terminal-shell';
import { readOperatorTokenFile } from '@goodvibes-jev/engine/sdk/platform/workspace';
import { isDeclaredSecretBearingConfigKey } from '@goodvibes-jev/engine/sdk/platform/config';
import { createNetworkFetch } from '@goodvibes-jev/engine/sdk/platform/runtime/transport';
import { runConfigCommand } from '../daemon/config-command.js';
import { runPairCommand } from '../daemon/pair-command.js';
import { createDaemonCommandSocketFactory } from '../daemon/remote-transport.js';
import { runSessionsCommand } from '../daemon/sessions-command.js';
import { runStatusCommand, runUpdateCommand, type DaemonCommandResult } from '../daemon/status-command.js';
import { runWebuiCommand } from '../daemon/webui-command.js';
import { runProvisionWakeModelCommand } from '../daemon/provision-wake-model.js';
import { isDaemonServiceSubcommand, runDaemonServiceCli, resolveInstalledDaemonBinary } from '../daemon/service-commands.js';
import type { DaemonProcessOptions } from '../daemon/process-lifecycle.js';
import { VERSION } from '../version.js';
import { createDaemonCliConfiguration, resolveDaemonCliOwnership } from './configuration.js';
import { parseDaemonCli } from './parser.js';
import { renderGoodVibesDaemonHelp, renderDaemonCommandHelp, renderGoodVibesVersion, renderDaemonCliCatalog } from './help.js';
import { runCompletionCommand } from './completion.js';
import { isRawInterceptCommand } from './command-catalog.js';
import type { DaemonCliRuntime } from './serve.js';

export interface DaemonCliOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly cwd?: string;
  /** Required for serve until all built-in inbox prerequisites are available. */
  readonly runtime?: DaemonCliRuntime;
  /** Explicit installed executable that composes the same runtime; never guessed from Bun. */
  readonly serviceBinaryPath?: string;
  readonly process?: DaemonProcessOptions;
  readonly stdout?: (line: string) => void;
  readonly stderr?: (line: string) => void;
  /** Explicit local credential-bearing output; automatic startup otherwise requires a TTY. */
  readonly pairingOutput?: (line: string) => void;
}

const PARTIAL = 'Serving requires an explicit production inbox composition. Configured providers require trusted local account admission.';

/** Returns a command exit code; serving remains owned until shutdown completes. */
export async function runDaemonCli(argv: readonly string[], options: DaemonCliOptions = {}): Promise<number> {
  const stdout = options.stdout ?? ((line: string) => { writeSync(1, `${line}\n`); });
  const stderr = options.stderr ?? ((line: string) => { writeSync(2, `${line}\n`); });
  const result = (answer: DaemonCommandResult, write = answer.exitCode === 0 ? stdout : stderr): number => {
    for (const line of answer.lines) write(line);
    return answer.exitCode;
  };
  const refuse = (line: string): number => result({ exitCode: 2, lines: [line] });
  const env = options.env ?? process.env;
  try {
    const cli = parseDaemonCli(argv);
    if (cli.errors.length) return result({ exitCode: 2, lines: [...cli.errors, '', renderGoodVibesDaemonHelp()] });
    for (const warning of cli.warnings) stderr(`[goodvibes-daemon] warning: ${warning}`);
    if (cli.flags.help || cli.command === 'help') {
      const topic = cli.command === 'help' ? cli.commandArgs[0] : cli.rawCommand;
      if (cli.flags.json) {
        if (topic !== undefined) return refuse('Machine help requires: goodvibes-daemon --help --json');
        return result({ exitCode: 0, lines: [renderDaemonCliCatalog()] });
      }
      const page = topic === undefined ? renderGoodVibesDaemonHelp() : renderDaemonCommandHelp(topic);
      return page === null ? refuse(`Unknown command: ${topic}`) : result({ exitCode: 0, lines: [page, '', PARTIAL] });
    }
    if (cli.flags.version || cli.command === 'version') return result({ exitCode: 0, lines: [renderGoodVibesVersion()] });
    if (cli.command === 'completion') return result(runCompletionCommand(cli.commandArgs));
    if (isRawInterceptCommand(cli.command) && argv[0] !== cli.command) return refuse(`\`${cli.command}\` has to be the first argument: goodvibes-daemon ${cli.command} …`);
    if (cli.command === 'send') {
      const { prepareSendCommand, runPreparedSendCommand } = await import('../daemon/send/command.js');
      const prepared = prepareSendCommand(cli.commandArgs);
      if (prepared.kind === 'result') return result(prepared.result);
      const configuration = createDaemonCliConfiguration(cli.flags, env, options.cwd, { diagnosticMode: 'structural' });
      const withheld = configuration.config.getIngestionQuarantine()
        .filter((entry) => isDeclaredSecretBearingConfigKey(entry.key));
      if (withheld.length) return refuse(`Configured credentials were withheld: ${[...new Set(withheld.map((entry) => entry.key))].join(', ')}. Nothing was sent.`);
      const { readAllStdin } = await import('../daemon/send/stdin.js');
      return result(await runPreparedSendCommand(prepared.args, {
        configManager: configuration.config, readStdin: readAllStdin, stdinIsTty: process.stdin.isTTY === true,
        deliver: async (request) => {
          const { createSendStack } = await import('../daemon/send/composition.js');
          return createSendStack(configuration).deliver(request);
        },
      }));
    }
    if (cli.command === 'serve' && typeof options.runtime?.inboxFactory !== 'function') return refuse(PARTIAL);
    if (['install-service', 'start-service', 'restart-service', 'migrate-service'].includes(cli.command)) {
      if (typeof options.runtime?.inboxFactory !== 'function' || !options.serviceBinaryPath) return refuse(`${PARTIAL} Service activation requires an explicitly composed executable.`);
      if (resolveDaemonCliOwnership(cli.flags, env, options.cwd).isOverridden) return refuse('Service activation with overridden tree or daemon homes is not supported by this partial launcher. No service was changed.');
    }

    if (cli.command === 'provision-wake-model') {
      if (cli.commandArgs.some((arg) => arg === '--help' || arg === '-h')) return result({ exitCode: 0, lines: [renderDaemonCommandHelp(cli.command)!] });
      if (cli.commandArgs.some((arg) => arg !== '--strict')) return refuse('Usage: goodvibes-daemon provision-wake-model [--strict] [--help]');
      const { homeDirectory } = resolveDaemonCliOwnership(cli.flags, env, options.cwd);
      // Provisioning and service commands preserve their stdout receipt even when
      // a nonzero status carries a degraded/absent state.
      return result(await runProvisionWakeModelCommand(cli.commandArgs, { homeDirectory, env }), stdout);
    }
    if (cli.command === 'webui' && cli.commandArgs.includes('--json')) {
      // Machine discovery is an inspection: no migration, settings bootstrap,
      // network transport, runtime composition, token acquisition or listener.
      const configuration = createDaemonCliConfiguration(cli.flags, env, options.cwd, { readOnly: true, diagnosticMode: 'structural' });
      return result(runWebuiCommand(cli.commandArgs, { configManager: configuration.config, baseDirectory: configuration.workingDirectory }));
    }
    const configuration = createDaemonCliConfiguration(cli.flags, env, options.cwd,
      cli.command === 'serve' ? { diagnosticMode: 'structural' } : {});
    const { config, homeDirectory, daemonHomeDirectory, workingDirectory } = configuration;
    const remoteFlags = { host: cli.flags.host, port: cli.flags.port, token: cli.flags.token, json: cli.flags.json };
    const remote = { configManager: config, daemonHomeDir: daemonHomeDirectory, controlPlaneConfigDir: config.getControlPlaneConfigDir() };
    const httpRemote = { ...remote, fetchImpl: createNetworkFetch(globalThis.fetch, config),
      socketFactory: createDaemonCommandSocketFactory(remote) };
    switch (cli.command) {
      case 'config': return result(await runConfigCommand(cli.commandArgs, { configManager: config, json: cli.flags.json }));
      case 'status': return result(await runStatusCommand({ ...httpRemote, flags: remoteFlags }));
      case 'update': return result(await runUpdateCommand({ ...httpRemote, flags: { ...remoteFlags, check: cli.flags.check } }));
      case 'sessions': return result(await runSessionsCommand({ ...httpRemote, flags: { ...remoteFlags, all: cli.flags.all }, args: cli.commandArgs }));
      case 'pair': return result(await runPairCommand({ configManager: config, daemonHomeDir: daemonHomeDirectory,
        version: VERSION, readToken: readOperatorTokenFile, operatorToken: env.GOODVIBES_DAEMON_TOKEN,
        flags: { ...remoteFlags, yes: cli.flags.yes } }));
      case 'webui': return result(runWebuiCommand(cli.commandArgs, { configManager: config, baseDirectory: workingDirectory }));
      case 'cluster': {
        const answer = await runClusterCommand({ argv: cli.commandArgs, configManager: config, daemonHomeDir: daemonHomeDirectory, fetchImpl: httpRemote.fetchImpl });
        if (answer.rawOutput) stdout(answer.rawOutput);
        return result(answer);
      }
      case 'serve': {
        const { prepareDaemonCliServe, runConfiguredDaemonCli } = await import('./serve.js');
        const errors = prepareDaemonCliServe(config, cli.flags);
        if (errors.length) return result({ exitCode: 2, lines: errors });
        const processHandle = runConfiguredDaemonCli(configuration, options.runtime!, env, options.process, stderr, stdout, options.pairingOutput);
        return await processHandle.finished;
      }
      default: {
        if (!isDaemonServiceSubcommand(cli.command)) return refuse('This command has no migrated dispatcher.');
        const binding = resolveRuntimeEndpointBinding(config, 'controlPlane');
        return result(await runDaemonServiceCli({ subcommand: cli.command,
          binaryPath: options.serviceBinaryPath ?? resolveInstalledDaemonBinary({ moduleUrl: import.meta.url }),
          configManager: config, homeDir: homeDirectory, unitHomeDir: env.HOME ?? homedir(), workingDirectory,
          host: binding.host, port: binding.port, confirmMigration: cli.flags.yes, json: cli.flags.json,
          hostnameFlagProvided: cli.flags.hostname !== undefined, portFlagProvided: cli.flags.port !== undefined,
        }), stdout);
      }
    }
  } catch {
    // Do not render arbitrary config, transport, plugin or credential exceptions.
    stderr('Daemon command failed');
    return 1;
  }
}
