/**
 * ensure-daemon-enabled-migrated.ts, retiring a `daemon.enabled: false` that
 * was written when the key meant something else.
 *
 * ── What the key used to mean, and what it means now ───────────────────────
 *
 * Before the daemon became its own product, a surface that could not find a
 * daemon SOLVED that by being one: it embedded a daemon server in its own
 * process. `daemon.enabled: false` was how a user declined THAT, "do not run a
 * daemon inside this app". It was a reasonable thing to want, it was the
 * documented way to want it, and on a laptop that has not been touched since,
 * it is still sitting in settings.json.
 *
 * After the split there is no embedded daemon to decline. The key now answers a
 * different question, "does this surface adopt a session daemon of its own",
 * and answering it `false` disables host discovery entirely: `startHostServices`
 * returns `mode: 'disabled'` without probing anything, and the boot-time
 * autostart that would otherwise start an installed-but-stopped daemon
 * classifies that as `daemon-disabled` and declines to act. A preference about
 * process topology silently became a switch that cuts the machine off from the
 * platform, and it did exactly that: a laptop sat unreachable for weeks with a
 * stopped service and this flag, and a person had to be handed shell commands.
 *
 * Honoring that value silently is the failure. So it is reset, once, and said
 * out loud.
 *
 * ── Why this is a once-only marker and not a rule ──────────────────────────
 *
 * A user must be able to turn this off and have it STAY off. The settings file
 * carries no per-key provenance, no timestamp, no writer stamp, nothing that
 * distinguishes a value written two years ago from one written this morning
 * (the file-level `$goodvibes` reader floor records only when the whole file
 * was last rewritten by a migration, which says nothing about any one key). So
 * "predates the split" cannot be read off the file, and this pass does not
 * pretend to read it.
 *
 * What it does instead is bound the correction to exactly one occurrence. The
 * receipt is written on the FIRST run whether or not anything was reset, which
 * is the whole mechanism: after that run the pass never looks at the key again,
 * so a `false` the user writes tomorrow is theirs and is honored forever. The
 * one value this can override is one that was already on disk before this build
 * ever ran, which is precisely the population that predates the meaning
 * change.
 *
 * ── Boundaries ─────────────────────────────────────────────────────────────
 *
 * - Only an EXPLICIT `false` is touched. A file that never mentions the key is
 *   already at the default (`true`) and is not rewritten.
 * - Only `daemon.enabled` is written. Nothing else in the file is reordered,
 *   reformatted beyond re-serialisation, or dropped.
 * - A failure never blocks startup. The pass reports null and the machine
 *   behaves exactly as it did before, which is the pre-migration state, and
 *   safe.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeStoreJson } from '@/utils/store-file.ts';
import { logger, summarizeError } from '@goodvibes-jev/engine/sdk/platform/utils';
import { GOODVIBES_AGENT_SURFACE_ROOT } from './surface.ts';

/** Bumping this re-runs the correction for installs that only carry an older receipt. */
const RECEIPT_SCHEMA_VERSION = 1;

/** The settings key whose meaning changed, named once so every string agrees. */
const DAEMON_ENABLED_KEY = 'daemon.enabled';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Where the one-time receipt lives, this product's own surface root. */
export function daemonEnabledMigrationReceiptPath(homeDir: string): string {
  return join(homeDir, '.goodvibes', GOODVIBES_AGENT_SURFACE_ROOT, 'control-plane', 'daemon-enabled-split-migration-receipt.json');
}

/** The agent settings files this pass inspects, in the order it reports them. */
function settingsFilePaths(options: DaemonEnabledMigrationOptions): readonly { readonly scope: string; readonly path: string }[] {
  const files = [
    { scope: 'user', path: join(options.homeDir, '.goodvibes', GOODVIBES_AGENT_SURFACE_ROOT, 'settings.json') },
  ];
  if (options.workingDir) {
    const projectPath = join(options.workingDir, '.goodvibes', GOODVIBES_AGENT_SURFACE_ROOT, 'settings.json');
    // A project checkout that happens to BE the home tree would otherwise be
    // read, rewritten and reported twice.
    if (!files.some((file) => file.path === projectPath)) {
      files.push({ scope: 'project', path: projectPath });
    }
  }
  return files;
}

/** How the one-time receipt read. */
type ReceiptState =
  | { readonly kind: 'absent' }
  | { readonly kind: 'complete' }
  | { readonly kind: 'damaged'; readonly reason: string };

/**
 * Read the receipt by PARSING it, never by its mere existence, a zero-byte or
 * truncated file exists just as happily as a good one, and this receipt is the
 * only memory that the correction already ran.
 */
function readReceipt(path: string): ReceiptState {
  let raw: string;
  try {
    if (!existsSync(path)) return { kind: 'absent' };
    raw = readFileSync(path, 'utf-8');
  } catch (error) {
    return { kind: 'damaged', reason: `unreadable: ${summarizeError(error)}` };
  }
  if (raw.trim().length === 0) return { kind: 'damaged', reason: 'empty file (interrupted write)' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: 'damaged', reason: 'not parseable JSON (torn write)' };
  }
  if (!isRecord(parsed)) return { kind: 'damaged', reason: 'not a JSON object' };
  if (parsed.completed !== true) return { kind: 'damaged', reason: 'no completion flag' };
  if (typeof parsed.schemaVersion !== 'number' || !Number.isFinite(parsed.schemaVersion)) {
    return { kind: 'damaged', reason: 'no usable schema version' };
  }
  // A NEWER receipt is accepted: a later build already did at least this much,
  // and a downgrade must not re-run a one-time correction on every boot.
  if (parsed.schemaVersion < RECEIPT_SCHEMA_VERSION) {
    return { kind: 'damaged', reason: `older receipt schema (${parsed.schemaVersion} < ${RECEIPT_SCHEMA_VERSION})` };
  }
  return { kind: 'complete' };
}

/** One settings file whose explicit `false` was reset. */
export interface DaemonEnabledReset {
  readonly scope: string;
  readonly path: string;
}

export interface DaemonEnabledMigrationOptions {
  readonly homeDir: string;
  /** Project-scoped settings are inspected too when a working directory is given. */
  readonly workingDir?: string | undefined;
  /** Clock injection for deterministic receipts in tests. */
  readonly now?: () => Date;
}

/**
 * Read `daemon.enabled` out of a raw settings object.
 *
 * Both shapes are checked: the nested object the config writer produces, and a
 * flat dotted key, which hand-edited files do carry and which would otherwise
 * be silently skipped.
 */
function readExplicitFalse(parsed: Record<string, unknown>): 'nested' | 'flat' | null {
  const nested = parsed['daemon'];
  if (isRecord(nested) && nested['enabled'] === false) return 'nested';
  if (parsed[DAEMON_ENABLED_KEY] === false) return 'flat';
  return null;
}

/** Reset the key in place, preserving every other byte of meaning in the file. */
function resetToTrue(parsed: Record<string, unknown>, shape: 'nested' | 'flat'): Record<string, unknown> {
  if (shape === 'flat') return { ...parsed, [DAEMON_ENABLED_KEY]: true };
  const daemon = parsed['daemon'];
  const nested = isRecord(daemon) ? daemon : {};
  return { ...parsed, daemon: { ...nested, enabled: true } };
}

/**
 * Run the once-only correction, and return the one-line boot notice the FIRST
 * time a value actually changes, null otherwise, so a caller prints it once
 * without re-announcing on every launch.
 *
 * Safe to call on every startup: once the receipt is on disk the fast path is
 * one file read and one JSON parse.
 */
export function ensureDaemonEnabledMigrated(options: DaemonEnabledMigrationOptions): string | null {
  const receiptPath = daemonEnabledMigrationReceiptPath(options.homeDir);
  const receipt = readReceipt(receiptPath);
  if (receipt.kind === 'complete') return null;
  if (receipt.kind === 'damaged') {
    // This correction is NOT safe to repeat: running it again could overwrite a
    // `false` the user set deliberately after the first pass, which is the one
    // outcome the once-only marker exists to prevent. So a receipt that cannot
    // be read counts as "already ran", loudly, rather than as "run it again".
    logger.warn(
      `[config] the ${DAEMON_ENABLED_KEY} migration receipt could not be read (${receipt.reason}); treating the migration as already done so a deliberate setting is never overwritten`,
      { receiptPath },
    );
    return null;
  }

  const resets: DaemonEnabledReset[] = [];
  const inspected: string[] = [];
  for (const file of settingsFilePaths(options)) {
    inspected.push(file.path);
    let parsed: Record<string, unknown>;
    try {
      if (!existsSync(file.path)) continue;
      const raw = readFileSync(file.path, 'utf-8');
      if (raw.trim().length === 0) continue;
      const candidate: unknown = JSON.parse(raw);
      if (!isRecord(candidate)) continue;
      parsed = candidate;
    } catch (error) {
      // An unreadable settings file is not this pass's problem to solve; the
      // config manager will report it honestly on load.
      logger.debug(`[config] could not inspect ${file.path} for the ${DAEMON_ENABLED_KEY} migration`, { error: summarizeError(error) });
      continue;
    }
    const shape = readExplicitFalse(parsed);
    if (!shape) continue;
    try {
      writeStoreJson(file.path, resetToTrue(parsed, shape));
      resets.push({ scope: file.scope, path: file.path });
    } catch (error) {
      logger.warn(`[config] could not reset ${DAEMON_ENABLED_KEY} in ${file.path}`, { error: summarizeError(error) });
    }
  }

  const migratedAt = (options.now?.() ?? new Date()).toISOString();
  const receiptBody = {
    schemaVersion: RECEIPT_SCHEMA_VERSION,
    completed: true as const,
    key: DAEMON_ENABLED_KEY,
    migratedAt,
    inspected,
    reset: resets,
    oldMeaning: `Before the daemon became its own product, ${DAEMON_ENABLED_KEY}: false meant "do not run a daemon inside this application's own process".`,
    newMeaning: `${DAEMON_ENABLED_KEY} now means "this surface adopts a session daemon of its own". False disables host discovery entirely, so the Agent will not look for, or start, a daemon on this machine.`,
    action: resets.length > 0
      ? `Reset ${DAEMON_ENABLED_KEY} to true once, because the stored false was written when the key carried the old meaning.`
      : `No stored ${DAEMON_ENABLED_KEY}: false was found. The receipt is written anyway so this correction never runs again and any future false is honored permanently.`,
    onceOnly: `This receipt makes the correction once-only. A ${DAEMON_ENABLED_KEY}: false set after this point is a deliberate choice and is never reset.`,
  };

  try {
    writeStoreJson(receiptPath, receiptBody);
  } catch (error) {
    // Without a receipt this would run again next boot. Say so plainly rather
    // than reporting a completed migration that did not record itself.
    logger.warn(`[config] the ${DAEMON_ENABLED_KEY} migration ran but its receipt could not be written; it may run again`, {
      receiptPath,
      error: summarizeError(error),
    });
  }

  if (resets.length === 0) return null;

  const where = resets.map((reset) => `${reset.scope} settings (${reset.path})`).join(' and ');
  const notice = `${DAEMON_ENABLED_KEY} was false in your ${where}. That setting used to mean "do not run a daemon inside this app"; it now means "do not look for a daemon at all", which leaves this machine unable to reach the platform. It has been set back to true once. Turning it off again is one settings change away, and a value you set from here on is kept. Migration record: ${receiptPath}`;
  logger.info(`[config] ${notice}`);
  return notice;
}
