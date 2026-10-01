import { existsSync, readFileSync } from 'node:fs';
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

/**
 * Honest one-line startup identity for the daemon binary, emitted right as it
 * begins serving, including on a bare (no-arg) systemd launch. It states the
 * RESOLVED version (never a placeholder), the home/host/port it actually bound,
 * and points at the real service-setup command. This replaces the field
 * behavior where a bare launch showed a wrong "v0.0.0" banner and gave an
 * operator nothing to act on. `version` is passed in (never read from the live
 * build here) so callers/tests can pin a sentinel and never compare the live
 * VERSION.
 */
export function renderDaemonStartupBanner(
  version: string,
  binding: { readonly homeDir: string; readonly host: string; readonly port: number },
  binary = 'goodvibes-daemon',
): string {
  return (
    `${binary} ${version} starting: ` +
    `home=${binding.homeDir} host=${binding.host} port=${binding.port} ` +
    `(manage as a service: ${binary} install-service)`
  );
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
