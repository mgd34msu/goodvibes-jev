import { existsSync, readFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VERSION } from '../version.ts';
import {
  DAEMON_COMMANDS,
  GLOBAL_FLAGS,
  daemonCommandSpec,
  resolveDaemonCommand,
  type DaemonCommandFlagSpec,
} from './command-catalog.ts';

function readJsonVersion(path: string): string | null {
  try {
    if (!existsSync(path)) return null;
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as { name?: unknown; version?: unknown };
    // Only trust OUR package.json, a compiled single-file binary can resolve
    // this path to a different package.json (a bundled dependency's) that
    // reports a placeholder like "0.0.0". Fall through to the baked VERSION in
    // that case rather than rendering a stray version in `--version`/banners.
    if (parsed.name !== '@goodvibes-jev/daemon') return null;
    return typeof parsed.version === 'string' && parsed.version.length > 0 ? parsed.version : null;
  } catch {
    return null;
  }
}

export function getPackageVersion(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return readJsonVersion(join(here, '..', '..', 'package.json'))
    ?? VERSION;
}

export function renderGoodVibesVersion(binary = 'goodvibes-daemon'): string {
  return `${binary} ${getPackageVersion()}`;
}

/** Quote paths and hostnames without permitting terminal-control output. */
function displayValue(value: string): string {
  return JSON.stringify(value).replace(/[\u007f-\u009f\u2028-\u202e\u2066-\u2069]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

/** Accept only a bare, canonical URL authority with no other URL components. */
function displayHost(host: string): string {
  const authority = isIP(host) === 6 ? `[${host}]` : host;
  try {
    const parsed = new URL(`http://${authority}`);
    if (parsed.host !== authority.toLowerCase() || parsed.username || parsed.password
      || parsed.port || parsed.pathname !== '/' || parsed.search || parsed.hash) return '[withheld]';
    const name = parsed.hostname;
    const ip = isIP(name) || (name.startsWith('[') && name.endsWith(']') && isIP(name.slice(1, -1)));
    const labels = name.endsWith('.') ? name.slice(0, -1).split('.') : name.split('.');
    if (!ip && (name.length > 253 || labels.some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label)))) return '[withheld]';
    return displayValue(name);
  } catch { return '[withheld]'; }
}

/** Intended identity before token/graph acquisition; not evidence of a bound listener. */
export function renderDaemonStartupBanner(
  version: string,
  binding: { readonly homeDir: string; readonly daemonHomeDir: string; readonly host: string; readonly port: number },
  binary = 'goodvibes-daemon',
): string {
  return `${binary} ${version} starting: tree-home=${displayValue(binding.homeDir)} `
    + `daemon-home=${displayValue(binding.daemonHomeDir)} intended-host=${displayHost(binding.host)} intended-port=${binding.port}`;
}

/** Render only listener-owned binding fields, after host and boot settlement. */
export function renderDaemonBoundEndpoint(version: string, binding: { readonly host: string; readonly port: number }): string {
  return `goodvibes-daemon ${version} bound: host=${displayHost(binding.host)} port=${binding.port}`;
}

/**
 * What the host actually uses to keep the daemon running, named per platform.
 *
 * The help said "systemd user service" on every platform, including macOS,
 * where `install-service` writes a launchd agent and nothing named systemd
 * exists. Taking the platform as an argument keeps that testable without
 * stubbing `process`.
 */
export function serviceKindForPlatform(platform: NodeJS.Platform = process.platform): string {
  if (platform === 'darwin') return 'launchd user agent';
  if (platform === 'win32') return 'Scheduled Task';
  return 'systemd user service';
}

const COLUMN = 32;

function pad(left: string): string {
  return left.length >= COLUMN ? `${left}\n${' '.repeat(COLUMN)}` : left.padEnd(COLUMN);
}

/** `-y, --yes` / `    --json` / `-m, --model <registryKey>` */
function renderFlagLine(flag: DaemonCommandFlagSpec): string {
  const shorts = flag.tokens.filter((token) => !token.startsWith('--'));
  const longs = flag.tokens.filter((token) => token.startsWith('--'));
  const value = flag.valueName ? ` <${flag.valueName}>` : '';
  const left = shorts.length > 0
    ? `  ${shorts.join(', ')}, ${longs.join(', ')}${value}`
    : `      ${longs.join(', ')}${value}`;
  return `${pad(left)}${flag.summary}`;
}

/**
 * The top-level help: what the binary is, what it does, what it accepts, and
 * what its exit codes mean. Generated from the catalog, so a command that
 * exists is listed and a command that is listed exists.
 */
export function renderGoodVibesDaemonHelp(
  binary = 'goodvibes-daemon',
  platform: NodeJS.Platform = process.platform,
): string {
  const commands = DAEMON_COMMANDS
    .filter((spec) => spec.name !== 'serve')
    .map((spec) => `${pad(`  ${spec.name}`)}${spec.summary}`);

  return [
    `Usage: ${binary} [COMMAND] [OPTIONS]`,
    '',
    'The GoodVibes daemon: the one long-running host for the control plane, the',
    'channels, cluster membership, scheduled work, the knowledge and memory stores,',
    'and the verb families every GoodVibes client calls.',
    '',
    `Run with no command it starts serving in the foreground. Run \`${binary}`,
    `install-service\` to have it come back after a reboot as a ${serviceKindForPlatform(platform)}.`,
    '',
    'Commands:',
    ...commands,
    '',
    `Run \`${binary} help <command>\` for a command's own arguments and flags.`,
    `Run \`${binary} --help --json\` for the versioned machine command catalog.`,
    '',
    'Global options (accepted by every command):',
    ...GLOBAL_FLAGS.map(renderFlagLine),
    '',
    'Serving options (a bare invocation, or `serve`):',
    ...daemonCommandSpec('serve').flags.map(renderFlagLine),
    '',
    'Exit codes:',
    `${pad('  0')}the command did what it says`,
    `${pad('  1')}it ran and failed: the reason is printed`,
    `${pad('  2')}the command line was wrong: an unknown command, an unknown flag,`,
    `${pad('   ')}a flag this command does not take, or a missing value`,
    `${pad('  3')}service-status only: installed, but not running`,
    `${pad('  4')}service-status only: not installed`,
  ].join('\n');
}

/** Side-effect-free machine discovery; command membership comes from the dispatch catalog. */
export function renderDaemonCliCatalog(): string {
  return JSON.stringify({
    schema: 'goodvibes.daemon.cli-catalog',
    schemaVersion: 1,
    commands: DAEMON_COMMANDS.map(({ name, subcommands, machineQueries = [] }) => ({ name, subcommands, machineQueries })),
  });
}

/**
 * `help <command>`, one command's usage, its own flags, and what it does.
 *
 * Returns null when the word names no command, so the caller can refuse with
 * the same "Unknown command" message the parser produces rather than printing
 * a help page for something that does not exist.
 */
export function renderDaemonCommandHelp(
  commandWord: string,
  binary = 'goodvibes-daemon',
  platform: NodeJS.Platform = process.platform,
): string | null {
  const command = resolveDaemonCommand(commandWord);
  if (command === undefined) return null;
  const spec = daemonCommandSpec(command);
  const usage = spec.usage.replace(/^goodvibes-daemon/, binary);

  const lines = [`Usage: ${usage}`, '', ...spec.detail];
  if (spec.flags.length > 0) {
    lines.push('', 'Options:', ...spec.flags.map(renderFlagLine));
  }
  if (spec.passthrough) {
    lines.push(
      '',
      `This command has its own flags; run \`${binary} ${spec.name}\` with none to see them.`,
    );
  }
  lines.push('', 'Global options:', ...GLOBAL_FLAGS.map(renderFlagLine));
  if (spec.name.endsWith('-service')) {
    lines.push('', `On this host that means a ${serviceKindForPlatform(platform)}.`);
  }
  return lines.join('\n');
}
