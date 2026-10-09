import { execFileSync } from 'node:child_process';

export interface GoodVibesWebBinding {
  enabled?: boolean;
  hostMode?: string;
  configuredHost?: string;
  host?: string;
  port?: number;
  url?: string;
}

type RunDaemonCommand = (args: readonly string[]) => string;

function runDaemonCommand(args: readonly string[]): string {
  return execFileSync('goodvibes-daemon', [...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 2000,
    maxBuffer: 64 * 1024,
    // A help implementation that ignores SIGTERM must not hold Vite startup open.
    killSignal: 'SIGKILL',
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isWebBindingResult(value: Record<string, unknown>): boolean {
  return value.schema === 'goodvibes.daemon.webui-binding' && value.schemaVersion === 1
    && value.source === 'configuration' && value.endpoint === 'web';
}

/** A producer-written catalog is a capability fact, never an interpretation of help prose. */
export function daemonCatalogOffersWebuiStatus(output: string): boolean {
  try {
    const catalog: unknown = JSON.parse(output);
    if (!isRecord(catalog) || catalog.schema !== 'goodvibes.daemon.cli-catalog'
      || catalog.schemaVersion !== 1 || !Array.isArray(catalog.commands)) return false;
    const names = new Set<string>();
    let offered = false;
    for (const command of catalog.commands as unknown[]) {
      if (!isRecord(command) || typeof command.name !== 'string' || !command.name
        || names.has(command.name) || !Array.isArray(command.subcommands)
        || !(command.subcommands as unknown[]).every((name) => typeof name === 'string' && name.length > 0)) return false;
      names.add(command.name);
      if (!Array.isArray(command.machineQueries)) return false;
      const queries = new Set<string>();
      for (const query of command.machineQueries as unknown[]) {
        if (!isRecord(query) || !Array.isArray(query.args)
          || !(query.args as unknown[]).every((arg) => typeof arg === 'string')
          || !isRecord(query.result) || typeof query.result.schema !== 'string'
          || typeof query.result.schemaVersion !== 'number') return false;
        const identity = JSON.stringify(query.args);
        if (queries.has(identity)) return false;
        queries.add(identity);
        if (command.name === 'webui' && command.subcommands.includes('status')
          && query.args.length === 2 && query.args[0] === 'status' && query.args[1] === '--json'
          && isWebBindingResult(query.result)) offered = true;
      }
    }
    return offered;
  } catch {
    return false;
  }
}

/**
 * Old daemons can boot on unknown commands, so the only initial probe is the
 * side-effect-free --help path, with --help FIRST for legacy dispatchers. Only
 * the daemon's versioned catalog can authorize the status invocation. Legacy
 * prose (even a real-looking command list) stays unavailable; Vite has no
 * configured Jev owner here and must not acquire provider credentials to read it.
 */
export function readWebBindingFromDaemon(
  run: RunDaemonCommand = runDaemonCommand,
  signal?: AbortSignal,
): GoodVibesWebBinding | null {
  try {
    if (signal?.aborted) return null;
    const output = run(['--help', '--json']);
    if (signal?.aborted || !daemonCatalogOffersWebuiStatus(output)) return null;
    const binding: unknown = JSON.parse(run(['webui', 'status', '--json']));
    if (signal?.aborted || !isRecord(binding) || !isWebBindingResult(binding)
      || typeof binding.host !== 'string' || !binding.host.trim()
      || typeof binding.port !== 'number' || !Number.isInteger(binding.port)
      || binding.port < 1 || binding.port > 65535) return null;
    // Copy only validated fields; malformed optional values cannot reach Vite.
    return {
      host: binding.host,
      port: binding.port,
      ...(typeof binding.enabled === 'boolean' ? { enabled: binding.enabled } : {}),
      ...(typeof binding.hostMode === 'string' ? { hostMode: binding.hostMode } : {}),
      ...(typeof binding.configuredHost === 'string' ? { configuredHost: binding.configuredHost } : {}),
      ...(typeof binding.url === 'string' ? { url: binding.url } : {}),
    };
  } catch {
    // Missing, old, timed-out, killed and malformed binaries retain the caller's
    // terminal/settings fallback. No prose or version-string guess authorizes a retry.
    return null;
  }
}
