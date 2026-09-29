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
  isDeclaredSecretBearingConfigKey,
  readCredentialKey,
} from '@goodvibes-jev/engine/sdk/platform/config';
import { mapLimit } from '@goodvibes-jev/judgment';

export const REDACTED_VALUE = '<redacted>';

/** The decision site the config path reading is logged under. */
export const CONFIG_PATH_CREDENTIAL_SITE = 'terminal-shell.redaction.config-path';

/** How many path readings run at once. */
const PATH_READING_CONCURRENCY = 8;

const SCHEMA_KEYS: ReadonlySet<string> = new Set(CONFIG_SCHEMA.map((setting) => setting.key));

/** Readings are asked once per path for the life of the process. */
const pathReadings = new Map<string, Promise<boolean>>();

/** Whether a config path holds a credential: the declaration for schema keys, else the reading. */
export function isSensitiveConfigPath(path: string): Promise<boolean> {
  if (SCHEMA_KEYS.has(path)) return Promise.resolve(isDeclaredSecretBearingConfigKey(path));
  let reading = pathReadings.get(path);
  if (reading === undefined) {
    reading = readCredentialKey({ key: path, description: configKeyDescription(path) }, CONFIG_PATH_CREDENTIAL_SITE)
      .then((answer) => !(answer.verdict === 'no' && answer.outcome === 'act'));
    reading.catch(() => pathReadings.delete(path));
    pathReadings.set(path, reading);
  }
  return reading;
}

const SECRET_LIKE_TEXT_PATTERNS: readonly RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{16,}\b/g,
  /\bghp_[A-Za-z0-9_]{16,}\b/g,
  /\bgho_[A-Za-z0-9_]{16,}\b/g,
  /\bghu_[A-Za-z0-9_]{16,}\b/g,
  /\bghs_[A-Za-z0-9_]{16,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{24,}\b/g,
  /\b(?:xoxb|xapp|xoxp|xoxa)-[A-Za-z0-9-]{16,}\b/g,
  /\b[A-Za-z0-9._%+-]+:[A-Za-z0-9._%+-]{8,}@/g,
];

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

/** Every path in the tree whose value would be masked if the path is sensitive, with that value. */
function valuePaths(value: unknown, path: string, out: Map<string, unknown>): void {
  if (path && holdsValue(value)) out.set(path, value);
  if (Array.isArray(value)) {
    value.forEach((item, index) => valuePaths(item, `${path}.${index}`, out));
  } else if (value && typeof value === 'object') {
    for (const [key, nested] of Object.entries(value)) valuePaths(nested, path ? `${path}.${key}` : key, out);
  }
}

/** The sensitive paths of a config tree, asked once for the whole tree. */
async function sensitivePaths(config: unknown): Promise<ReadonlySet<string>> {
  const candidates = new Map<string, unknown>();
  valuePaths(config, '', candidates);
  const paths = [...candidates.keys()];
  const sensitive = await mapLimit(paths, PATH_READING_CONCURRENCY, (path) => isSensitiveConfigPath(path));
  return new Set(paths.filter((_path, index) => sensitive[index]));
}

function redactUnknown(value: unknown, path: string, sensitive: ReadonlySet<string>, redactedPaths: string[]): unknown {
  if (sensitive.has(path)) {
    redactedPaths.push(path);
    return REDACTED_VALUE;
  }
  if (Array.isArray(value)) {
    return value.map((item, index) => redactUnknown(item, `${path}.${index}`, sensitive, redactedPaths));
  }
  if (value && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value)) {
      result[key] = redactUnknown(nested, path ? `${path}.${key}` : key, sensitive, redactedPaths);
    }
    return result;
  }
  return value;
}

export function isRedactedValue(value: unknown): boolean {
  return value === REDACTED_VALUE;
}

export interface RedactedConfigResult<T> {
  readonly value: T;
  readonly redactedPaths: readonly string[];
}

export async function redactConfig<T>(config: T): Promise<RedactedConfigResult<T>> {
  const sensitive = await sensitivePaths(config);
  const redactedPaths: string[] = [];
  return {
    value: redactUnknown(config, '', sensitive, redactedPaths) as T,
    redactedPaths,
  };
}

export function redactText(input: string): string {
  // Assignment form: keyword=value, anchored so 'monkey=' and 'donkey=' do NOT match.
  // Matches: token=, access_token=, api_key=, api-key=, secret=, password= and colon form token: value
  let output = input
    .replace(
      /(?<![A-Za-z])(?:access_token|api[_-]?key|secret|password|token)\s*=\s*([^ \t\r\n"'`]+)/gi,
      (m, val) => m.slice(0, m.length - val.length) + REDACTED_VALUE,
    )
    .replace(
      /(?<![A-Za-z])(?:access_token|api[_-]?key|secret|password|token)\s*:\s*([^ \t\r\n"'`]+)/gi,
      (m, val) => m.slice(0, m.length - val.length) + REDACTED_VALUE,
    );
  for (const pattern of SECRET_LIKE_TEXT_PATTERNS) {
    output = output.replace(pattern, REDACTED_VALUE);
  }
  return output;
}

export async function collectSensitiveConfigValues(config: unknown): Promise<readonly string[]> {
  const candidates = new Map<string, unknown>();
  valuePaths(config, '', candidates);
  const sensitive = await sensitivePaths(config);
  // A sensitive container's strings are all masked with it; collect them too.
  const values: string[] = [];
  const collect = (value: unknown): void => {
    if (typeof value === 'string') values.push(value);
    else if (Array.isArray(value)) value.forEach(collect);
    else if (value && typeof value === 'object') Object.values(value).forEach(collect);
  };
  for (const [path, value] of candidates) if (sensitive.has(path)) collect(value);
  return [...new Set(values.filter((value) => holdsValue(value)))].sort((left, right) => right.length - left.length);
}

export function redactSerializedSecrets(serialized: string, secretValues: readonly string[]): string {
  let output = redactText(serialized);
  for (const secret of secretValues) {
    if (!secret) continue;
    const encoded = JSON.stringify(secret).slice(1, -1);
    output = output.split(encoded).join(REDACTED_VALUE);
    output = output.split(secret).join(REDACTED_VALUE);
  }
  return output;
}
