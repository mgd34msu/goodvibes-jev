/**
 * config-command.ts, `goodvibes-daemon config list|get|set|unset`.
 *
 * A headless daemon's settings had no command at all: the only ways to change
 * one were to hand-edit a JSON file whose path and tier you had to already
 * know, or to attach a client. `webui enable` proved the pattern for a
 * settings-writing command that the installer and a person can both run, open
 * the same ConfigManager the daemon boots with, write through `set()`, print an
 * honest receipt, and this is that pattern generalised to every key.
 *
 * WHICH FILE A WRITE LANDS IN is not decided here. `ConfigManager.set()` routes
 * a daemon-owned key to the daemon's own settings store and a shared key to the
 * shared one; this command reports where it landed rather than choosing, so the
 * routing stays in one place and this command cannot disagree with the daemon.
 *
 * READS ARE REDACTED. Every value printed goes through the terminal shell's
 * cli-redaction
 * first, so a token, a password, an API key or a card number reads as
 * `<redacted>` and a `config list` pasted into a bug report carries no
 * credential. Writes are NOT redacted, `config set` stores the real value; it
 * is the OUTPUT that is cleaned. A `goodvibes://secrets/...` reference is left
 * visible on purpose: it is a pointer, not a secret, and hiding it would make
 * the indirection impossible to verify.
 */
import type { ConfigManager, ConfigSetting } from '@goodvibes-jev/engine/sdk/platform/config';
import { ConfigError } from '@goodvibes-jev/engine/sdk/platform/config';
import {
  REDACTED_VALUE,
  isSensitiveConfigPath,
  parseConfigValueText,
  redactConfig,
} from '@goodvibes-jev/engine/terminal-shell';
import { isKnownConfigKey } from '../config/config-key-guard.js';

export const CONFIG_SUBCOMMANDS = ['list', 'get', 'set', 'unset'] as const;
export type ConfigSubcommand = (typeof CONFIG_SUBCOMMANDS)[number];

export function isConfigSubcommand(value: string | undefined): value is ConfigSubcommand {
  return typeof value === 'string' && (CONFIG_SUBCOMMANDS as readonly string[]).includes(value);
}

export interface ConfigCommandResult {
  readonly exitCode: number;
  readonly lines: readonly string[];
}

export interface ConfigCommandDeps {
  /** The same manager the daemon boots with, so a write lands where the daemon reads. */
  readonly configManager: Pick<ConfigManager, 'get' | 'set' | 'getSchema' | 'getRaw' | 'reset' | 'getConfigPath'>;
  readonly json: boolean;
  readonly binary?: string | undefined;
}

function usage(binary: string): string[] {
  return [
    `  ${binary} config list [--json]`,
    `  ${binary} config get <key> [--json]`,
    `  ${binary} config set <key> <value>`,
    `  ${binary} config unset <key>`,
  ];
}

function refusal(message: string, deps: ConfigCommandDeps): ConfigCommandResult {
  const binary = deps.binary ?? 'goodvibes-daemon';
  return {
    exitCode: 2,
    lines: deps.json
      ? [JSON.stringify({ ok: false, error: message }, null, 2)]
      : [`config: ${message}`, ...usage(binary)],
  };
}

function failure(message: string, deps: ConfigCommandDeps): ConfigCommandResult {
  return {
    exitCode: 1,
    lines: deps.json ? [JSON.stringify({ ok: false, error: message }, null, 2)] : [`config: ${message}`],
  };
}

/**
 * The redacted, printable form of one value.
 *
 * The path decides, not the value: `isSensitiveConfigPath` answers for the key
 * name, so an empty password prints as empty (it IS unset) and a real one
 * prints as `<redacted>` whatever it happens to contain. A secrets reference is
 * a pointer and stays visible.
 */
export async function renderConfigValue(key: string, value: unknown): Promise<string> {
  if (await isSensitiveConfigPath(key)) {
    if (value === null || value === undefined) return 'unset';
    if (typeof value === 'string') {
      if (value.trim().length === 0) return '""';
      if (value.startsWith('goodvibes://secrets/')) return value;
      return REDACTED_VALUE;
    }
    return value === false || value === 0 ? JSON.stringify(value) : REDACTED_VALUE;
  }
  if (value === undefined) return 'unset';
  if (value !== null && typeof value === 'object') {
    const redacted = await redactConfig({ [key]: value });
    return JSON.stringify(redacted.value[key]);
  }
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function schemaFor(deps: ConfigCommandDeps, key: string): ConfigSetting | undefined {
  return deps.configManager.getSchema().find((setting) => setting.key === key);
}

/** Diagnostics come from the schema, never an exception containing user values. */
function writeFailure(key: string, error: unknown, deps: ConfigCommandDeps): ConfigCommandResult {
  const setting = schemaFor(deps, key);
  if (error instanceof ConfigError && setting) {
    const hint = setting.validationHint ? ` (${setting.validationHint})` : '';
    const allowed = setting.enumValues ? ` Allowed: ${setting.enumValues.join(', ')}.` : '';
    return failure(`could not write ${key}: expected ${setting.type}${hint}.${allowed}`, deps);
  }
  return failure(`could not write ${key}.`, deps);
}

/** Finish classification before mutation; a refused reader must leave settings alone. */
async function prepareWrite(deps: ConfigCommandDeps, key: string, value: unknown): Promise<ConfigCommandResult | undefined> {
  try {
    if (deps.json) await redactConfig({ [key]: value });
    else await renderConfigValue(key, value);
    return undefined;
  } catch {
    return failure(`could not prepare safe output for ${key}; settings were not changed.`, deps);
  }
}

/** A transformed stored value must never turn a completed write into a rejection. */
async function writtenValue(deps: ConfigCommandDeps, key: string): Promise<unknown> {
  try {
    if (!isKnownConfigKey(key, deps.configManager.getSchema())) return REDACTED_VALUE;
    const stored = deps.configManager.get(key);
    if (!deps.json) return await renderConfigValue(key, stored);
    const redacted = await redactConfig({ [key]: stored });
    return redacted.value[key];
  } catch {
    return REDACTED_VALUE;
  }
}

function readValue(deps: ConfigCommandDeps, key: string): unknown {
  if (!isKnownConfigKey(key, deps.configManager.getSchema())) return undefined;
  try {
    return deps.configManager.get(key);
  } catch {
    return undefined;
  }
}

async function listResult(deps: ConfigCommandDeps): Promise<ConfigCommandResult> {
  const schema = deps.configManager.getSchema();
  const rows = schema.map((setting) => ({
    key: setting.key,
    value: readValue(deps, setting.key),
    type: setting.type,
  }));

  if (deps.json) {
    // The whole document goes through the recursive redactor as well as the
    // per-key render, so a secret nested inside an object-valued setting is
    // caught by its own path rather than only by its parent's name.
    const redacted = await redactConfig(
      Object.fromEntries(rows.map((row) => [row.key, row.value])) as Record<string, unknown>,
    );
    return {
      exitCode: 0,
      lines: [JSON.stringify({
        ok: true,
        data: {
          settingsFile: deps.configManager.getConfigPath(),
          redactedKeys: redacted.redactedPaths,
          settings: redacted.value,
        },
      }, null, 2)],
    };
  }

  const width = rows.reduce((max, row) => Math.max(max, row.key.length), 0);
  return {
    exitCode: 0,
    lines: [
      `${rows.length} settings (values that read like credentials are shown as ${REDACTED_VALUE}):`,
      '',
      ...await Promise.all(rows.map(async (row) => `  ${row.key.padEnd(width)}  ${await renderConfigValue(row.key, row.value)}`)),
      '',
      `settings file: ${deps.configManager.getConfigPath()}`,
      'a daemon-owned key is written to the daemon\'s own settings store instead; `config set` says which.',
    ],
  };
}

async function getResult(deps: ConfigCommandDeps, key: string): Promise<ConfigCommandResult> {
  const setting = schemaFor(deps, key);
  if (!setting) {
    return failure(`not a settings key. Run \`${deps.binary ?? 'goodvibes-daemon'} config list\` to see them.`, deps);
  }
  const value = readValue(deps, key);
  if (deps.json) {
    const redacted = await redactConfig({ [key]: value } as Record<string, unknown>);
    return {
      exitCode: 0,
      lines: [JSON.stringify({
        ok: true,
        data: {
          key,
          value: (redacted.value as Record<string, unknown>)[key],
          type: setting.type,
          redacted: redacted.redactedPaths.length > 0,
        },
      }, null, 2)],
    };
  }
  return { exitCode: 0, lines: [await renderConfigValue(key, value)] };
}

async function setResult(deps: ConfigCommandDeps, key: string, rawValue: string): Promise<ConfigCommandResult> {
  if (!isKnownConfigKey(key, deps.configManager.getSchema())) {
    return failure(`not a settings key. Run \`${deps.binary ?? 'goodvibes-daemon'} config list\` to see them.`, deps);
  }
  const value = parseConfigValueText(rawValue);
  const preparationFailure = await prepareWrite(deps, key, value);
  if (preparationFailure) return preparationFailure;
  try {
    deps.configManager.set(key, value as never);
  } catch (error) {
    return writeFailure(key, error, deps);
  }
  const printable = await writtenValue(deps, key);
  if (deps.json) {
    return {
      exitCode: 0,
      lines: [JSON.stringify({
        ok: true,
        data: { key, value: printable, written: true },
      }, null, 2)],
    };
  }
  return {
    exitCode: 0,
    lines: [
      `${key} = ${printable}`,
      '  written to disk. A running daemon picks most keys up live; the ones that only apply',
      '  when it binds a port need a restart:  goodvibes-daemon restart-service',
    ],
  };
}

async function unsetResult(deps: ConfigCommandDeps, key: string): Promise<ConfigCommandResult> {
  if (!isKnownConfigKey(key, deps.configManager.getSchema())) {
    return failure(`not a settings key. Run \`${deps.binary ?? 'goodvibes-daemon'} config list\` to see them.`, deps);
  }
  const preparationFailure = await prepareWrite(deps, key, schemaFor(deps, key)?.default);
  if (preparationFailure) return preparationFailure;
  try {
    deps.configManager.reset(key);
  } catch {
    return failure(`could not reset ${key}.`, deps);
  }
  const printable = await writtenValue(deps, key);
  if (deps.json) {
    return {
      exitCode: 0,
      lines: [JSON.stringify({
        ok: true,
        data: { key, value: printable, reset: true },
      }, null, 2)],
    };
  }
  return {
    exitCode: 0,
    lines: [`${key} = ${printable}  (back to its shipped default)`],
  };
}

/**
 * Run one config verb. Never throws for an ordinary refusal: a bad key, a value
 * the schema rejects and an unwritable settings file all come back as an exit
 * code and lines, because a caller is often a script reading both.
 */
export async function runConfigCommand(args: readonly string[], deps: ConfigCommandDeps): Promise<ConfigCommandResult> {
  const subcommand = args[0];
  if (subcommand === undefined) return refusal('name what to do with the settings.', deps);
  if (!isConfigSubcommand(subcommand)) {
    return refusal(`unknown config command; try ${CONFIG_SUBCOMMANDS.join(', ')}.`, deps);
  }

  if (subcommand === 'list') {
    if (args.length > 1) return refusal('one argument too many.', deps);
    return listResult(deps);
  }

  const key = args[1];
  if (key === undefined) return refusal(`${subcommand} needs a settings key.`, deps);

  if (subcommand === 'get') {
    if (args.length > 2) return refusal('one argument too many.', deps);
    return getResult(deps, key);
  }
  if (subcommand === 'unset') {
    if (args.length > 2) return refusal('one argument too many.', deps);
    return unsetResult(deps, key);
  }

  const rawValue = args[2];
  if (rawValue === undefined) return refusal('set needs a value: `config set <key> <value>`.', deps);
  if (args.length > 3) return refusal('one argument too many.', deps);
  return setResult(deps, key, rawValue);
}
