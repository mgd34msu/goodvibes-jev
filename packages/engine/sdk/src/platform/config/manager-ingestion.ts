/**
 * manager-ingestion.ts, ConfigManager's side of the settings-ingestion rule.
 *
 * The rule itself, and the reasoning for skip-versus-refuse per key class, is
 * in settings-ingestion.ts. This is the two-function seam that connects it to a
 * manager: where a notice is recorded, and how a failed file becomes the
 * ConfigError the manager's callers already expect. Split out of manager.ts
 * because that file is at its line cap, and cohesive on its own terms, both
 * functions exist only to route a notice to the places an operator can see it.
 */

import { ConfigError } from '../types/errors.js';
import { summarizeError } from '../utils/error-display.js';
import { logger } from '../utils/logger.js';
import { readUnknownSettingForms } from './settings-unknown-forms.js';
import {
  SettingsIngestionRefusal,
  announceIngestionNotice,
  describeIngestionNotice,
  ingestSettingsFile,
  unreadableSettingsFileNotice,
  type SettingsIngestionNotice,
  type UnknownSettingKey,
} from './settings-ingestion.js';

export type { SettingsIngestionNotice };

/** Where a manager files an ingestion notice so an operator can find it. */
export interface IngestionNoticeSink {
  /** Kept for `ConfigManager.getIngestionQuarantine()`. */
  record(entry: SettingsIngestionNotice): void;
  /**
   * Announce-once startup receipt. The daemon serves these from /status, so a
   * skipped setting reaches a surface rather than dead-ending in a log file.
   */
  receipt(id: string, text: string): void;
  /** Keeps unknown keys until a judgment port can read them; see {@link UnknownSettingFormsQueue}. */
  unknown(file: string, keys: readonly UnknownSettingKey[]): void;
}

/**
 * Screen one parsed settings file before it is merged: refuse what must not be
 * silently dropped, skip what can be, and say either loudly.
 */
export function ingestManagerSettings(
  parsed: Record<string, unknown>,
  file: string,
  sink: IngestionNoticeSink,
  /** The manager's load-time migrations; run before the screen. See IngestSettingsOptions.migrate. */
  migrate?: ((raw: Record<string, unknown>) => Record<string, unknown>) | undefined,
): Record<string, unknown> {
  const result = ingestSettingsFile(parsed, file, { ...(migrate ? { migrate } : {}), onNotice: (entry) => { noticeTo(sink, entry); } });
  if (result.unknownKeys.length > 0) sink.unknown(file, result.unknownKeys);
  return result.config;
}

function noticeTo(sink: IngestionNoticeSink, entry: SettingsIngestionNotice): void {
  sink.record(entry);
  try {
    sink.receipt(`settings-ingestion:${entry.key}:${entry.action}`, describeIngestionNotice(entry));
  } catch {
    // A receipt store that cannot be written must never escalate a skipped
    // setting into a failed construction. It was already said on stderr and
    // in the activity log, which is where the guarantee actually lives.
  }
}

type PendingUnknownKeys = { readonly file: string; readonly keys: readonly UnknownSettingKey[] };

/**
 * Unknown settings keys waiting to be read for whether they are a newer form
 * of a known setting (settings-unknown-forms.ts). Config loads before a
 * composition's judgment port exists (the port is built from the judgment
 * settings), so keys are kept until {@link start}, which the composition calls
 * once its port is installed; keys from a later reload are read as they come.
 * The keys stay in their files whatever the reading says; a reading that
 * cannot be made is logged with the keys it was about.
 */
export class UnknownSettingFormsQueue {
  private pending: PendingUnknownKeys[] = [];
  private started = false;

  keep(file: string, keys: readonly UnknownSettingKey[], sink: IngestionNoticeSink): void {
    this.pending.push({ file, keys });
    if (this.started) void this.drain(sink);
  }

  start(sink: IngestionNoticeSink): Promise<void> {
    this.started = true;
    return this.drain(sink);
  }

  private async drain(sink: IngestionNoticeSink): Promise<void> {
    for (const { file, keys } of this.pending.splice(0)) {
      try {
        for (const entry of await readUnknownSettingForms(file, keys)) {
          announceIngestionNotice(entry);
          noticeTo(sink, entry);
        }
      } catch (error) {
        logger.warn('goodvibes settings: whether unknown keys are newer forms of known settings could not be read', {
          file,
          keys: keys.map((unknown) => unknown.key),
          error: summarizeError(error),
        });
      }
    }
  }
}

/**
 * Turn a settings-file failure into the ConfigError callers expect, having
 * first said what happened.
 *
 * A refusal announced itself already. Anything else reaching here is a file
 * that could not be parsed at all, also a refusal, because the reader cannot
 * know whether the unreadable bytes held a safety-gate key, and so cannot know
 * that carrying on without them is safe.
 */
export function toConfigLoadFailure(
  label: string,
  file: string,
  err: unknown,
  sink: IngestionNoticeSink,
): ConfigError {
  if (!(err instanceof SettingsIngestionRefusal)) {
    const entry = unreadableSettingsFileNotice(file, summarizeError(err));
    announceIngestionNotice(entry);
    sink.record(entry);
  }
  return new ConfigError(`${label} config load failed for ${file}: ${summarizeError(err)}`);
}
