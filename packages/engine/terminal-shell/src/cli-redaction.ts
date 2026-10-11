/**
 * cli-redaction.ts, masking credential-bearing values out of anything a
 * front-end writes to a file a person might hand to someone else (a support
 * bundle, a diagnostic dump, a config snapshot).
 *
 * Filing a credential in the right store buys nothing if the diagnostic dump
 * then prints it. Which config paths hold credentials:
 *
 *  - a key of the platform's config schema is answered by the platform's own
 *    declaration (SECRET_BEARING_CONFIG_PATHS): code, the platform declares
 *    its keys, and the pre-commit credential-scope check keeps that list whole;
 *  - any other path (a provider's key, an env map under an MCP server, a
 *    header map, payment card fields) is read by Jev with the
 *    `config.credential-key` reading, from the path and never the value, and
 *    its value is kept in the clear only on a confident no.
 *
 * This replaced a trailing-word path pattern and a hand-kept copy of the
 * declared keys that had drifted from the platform's list.
 */
import {
  CONFIG_SCHEMA,
  configKeyDescription,
  captureStructuredCredentialReferenceConfigValue,
  isStructuredCredentialReferenceConfigKey,
  isDeclaredSecretBearingConfigKey,
  readCredentialKey,
} from '@goodvibes-jev/engine/sdk/platform/config';
import { mapLimit } from '@goodvibes-jev/judgment';
import { captureJudgmentPort, type JudgmentPortCapture, type JudgmentReadingOptions } from '@goodvibes-jev/engine/errors';
import { retainStrictJudgmentJson } from '@goodvibes-jev/engine/sdk/platform/gate';
import { redactSensitiveDataAsync, redactStructuredDataAsync } from '@goodvibes-jev/engine/sdk/platform/utils';

export const REDACTED_VALUE = '<redacted>';

/** The decision site the config path reading is logged under. */
export const CONFIG_PATH_CREDENTIAL_SITE = 'terminal-shell.redaction.config-path';

/** How many path readings run at once. */
const PATH_READING_CONCURRENCY = 8;

const SCHEMA_KEYS: ReadonlySet<string> = new Set(CONFIG_SCHEMA.map((setting) => setting.key));

/** Unknown config paths keep values private unless a current reading confidently excludes credentials. */
export async function isSensitiveConfigPath(path: string, options: JudgmentReadingOptions = {}): Promise<boolean> {
  const source = captureConfig(path, options);
  source.assertCurrent();
  if (SCHEMA_KEYS.has(path)) return isDeclaredSecretBearingConfigKey(path);
  const reading = await readCredentialKey({ key: path, description: configKeyDescription(path) }, CONFIG_PATH_CREDENTIAL_SITE,
    { ...options, assertCurrent: source.assertCurrent });
  source.assertCurrent();
  return !(reading.verdict === 'no' && reading.outcome === 'act');
}

function captureConfig(config: unknown, options: JudgmentReadingOptions) {
  // Raw values stay local. This structural capture does not authorize transmission.
  const retained = retainStrictJudgmentJson(config);
  const snapshot = retained.snapshot;
  const signal = options.signal, callerCurrent = options.assertCurrent;
  const sourceCurrent = () => {
    signal?.throwIfAborted();
    if (options.signal !== signal || options.assertCurrent !== callerCurrent) throw new Error('Config changed during redaction.');
    retained.assertCurrent();
  };
  const assertSource = () => {
    sourceCurrent();
    const result: unknown = callerCurrent?.();
    if (result !== undefined) {
      void Promise.resolve(result).catch(() => {});
      throw new Error('Config ownership must be synchronous.');
    }
    sourceCurrent();
  };
  let owner: JudgmentPortCapture | undefined;
  const assertCurrent = () => { if (owner) owner.assertCurrent(); else assertSource(); };
  const readingOptions = () => {
    assertSource();
    owner ??= captureJudgmentPort(CONFIG_PATH_CREDENTIAL_SITE, { ...options, assertCurrent: assertSource });
    owner.assertCurrent();
    return { ...options, signal: owner.signal, assertCurrent: owner.assertCurrent };
  };
  assertSource();
  return { snapshot, assertCurrent, readingOptions };
}

// Redaction rule for sensitive config paths:
// - Non-string values: redact if truthy (i.e. non-null, non-undefined, non-zero, non-false).
//   Rationale: zero and false are never meaningful secrets; null/undefined mean absent.
// - String values: redact non-empty strings that are not goodvibes:// secret refs.
//   Rationale: empty string means unset; secret refs are safe placeholders, not raw values.
function holdsValue(value: unknown): boolean {
  if (typeof value !== 'string') return value !== null && value !== undefined && Boolean(value);
  if (value.trim().length === 0) return false;
  return !value.startsWith('goodvibes://secrets/');
}

function structuredReferenceValue(path: string, value: unknown): boolean {
  try { captureStructuredCredentialReferenceConfigValue(path, value); return true; }
  catch { return false; }
}

/** Every path in the tree whose value would be masked if the path is sensitive, with that value. */
function valuePaths(value: unknown, path: string, out: Map<string, unknown>): void {
  if (isStructuredCredentialReferenceConfigKey(path)) {
    if (!structuredReferenceValue(path, value)) out.set(path, value);
    return;
  }
  if (path && holdsValue(value)) out.set(path, value);
  if (Array.isArray(value)) {
    value.forEach((item, index) => valuePaths(item, `${path}.${index}`, out));
  } else if (value && typeof value === 'object') {
    for (const [key, nested] of Object.entries(value)) valuePaths(nested, path ? `${path}.${key}` : key, out);
  }
}

/** The sensitive paths of a config tree, asked once for the whole tree. */
async function sensitivePaths(source: ReturnType<typeof captureConfig>, candidates: ReadonlyMap<string, unknown>): Promise<ReadonlySet<string>> {
  const paths = [...candidates.keys()];
  const sensitive = await mapLimit(paths, PATH_READING_CONCURRENCY, async (path) =>
    isStructuredCredentialReferenceConfigKey(path) ? true
      : isSensitiveConfigPath(path, SCHEMA_KEYS.has(path) ? { assertCurrent: source.assertCurrent } : source.readingOptions()));
  source.assertCurrent();
  return new Set(paths.filter((_path, index) => sensitive[index]));
}

function redactUnknown(value: unknown, path: string, sensitive: ReadonlySet<string>, redactedPaths: string[]): unknown {
  if (sensitive.has(path)) {
    redactedPaths.push(path);
    return REDACTED_VALUE;
  }
  if (isStructuredCredentialReferenceConfigKey(path)) return captureStructuredCredentialReferenceConfigValue(path, value);
  if (Array.isArray(value)) {
    return value.map((item, index) => redactUnknown(item, `${path}.${index}`, sensitive, redactedPaths));
  }
  if (value && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value)) {
      Object.defineProperty(result, key, { value: redactUnknown(nested, path ? `${path}.${key}` : key, sensitive, redactedPaths), enumerable: true });
    }
    return result;
  }
  return value;
}

export function isRedactedValue(value: unknown): boolean {
  return value === REDACTED_VALUE || value === '[REDACTED]' || value === '[REDACTED_PROFILE]' || value === '[REDACTED_TEXT]';
}

export interface RedactedConfigResult {
  readonly value: unknown;
  readonly redactedPaths: readonly string[];
  readonly assertCurrent: () => void;
}

export interface PreparedConfigRedaction extends RedactedConfigResult {
  /** Local masking inputs; never publish these values. */
  readonly sensitiveValues: readonly string[];
}

function sensitiveValues(candidates: ReadonlyMap<string, unknown>, sensitive: ReadonlySet<string>): readonly string[] {
  // A sensitive container's strings are all masked with it; collect them too.
  const values: string[] = [];
  const collect = (value: unknown): void => {
    if (typeof value === 'string') values.push(value);
    else if (Array.isArray(value)) value.forEach(collect);
    else if (value && typeof value === 'object') Object.values(value).forEach(collect);
  };
  for (const [path, value] of candidates) if (sensitive.has(path) && !isStructuredCredentialReferenceConfigKey(path)) collect(value);
  return [...new Set(values.filter((value) => holdsValue(value)))].sort((left, right) => right.length - left.length);
}

/** Classify one retained config once for its masked output and local secret sweeps. */
export async function prepareConfigRedaction(config: unknown, options: JudgmentReadingOptions = {}): Promise<PreparedConfigRedaction> {
  const source = captureConfig(config, options);
  const candidates = new Map<string, unknown>();
  valuePaths(source.snapshot, '', candidates);
  const sensitive = await sensitivePaths(source, candidates);
  source.assertCurrent();
  const redactedPaths: string[] = [];
  const value = redactUnknown(source.snapshot, '', sensitive, redactedPaths);
  const values = sensitiveValues(candidates, sensitive);
  source.assertCurrent();
  return { value, redactedPaths, sensitiveValues: values, assertCurrent: source.assertCurrent };
}

export async function redactConfig(config: unknown, options: JudgmentReadingOptions = {}): Promise<RedactedConfigResult> {
  const prepared = await prepareConfigRedaction(config, options);
  prepared.assertCurrent();
  return { value: prepared.value, redactedPaths: prepared.redactedPaths, assertCurrent: prepared.assertCurrent };
}

export function redactText(input: string, options: JudgmentReadingOptions = {}): Promise<string> {
  return redactSensitiveDataAsync(input, options);
}

export async function collectSensitiveConfigValues(config: unknown, options: JudgmentReadingOptions = {}): Promise<readonly string[]> {
  const prepared = await prepareConfigRedaction(config, options);
  prepared.assertCurrent();
  return prepared.sensitiveValues;
}

export async function redactSerializedSecrets(serialized: string, secretValues: readonly string[], options: JudgmentReadingOptions = {}): Promise<string> {
  let output = serialized;
  for (const secret of secretValues) {
    if (!secret) continue;
    const encoded = JSON.stringify(secret).slice(1, -1);
    output = output.split(encoded).join(REDACTED_VALUE);
    output = output.split(secret).join(REDACTED_VALUE);
  }
  let parsed: unknown;
  try { parsed = JSON.parse(output); }
  catch { return redactSensitiveDataAsync(output, { ...options, secretValues }); }
  const protectedValue = await redactStructuredDataAsync(parsed, { ...options, secretValues });
  const result = JSON.stringify(protectedValue, null, 2);
  if (result === undefined) throw new Error('Redacted bundle is not JSON.');
  return result;
}
