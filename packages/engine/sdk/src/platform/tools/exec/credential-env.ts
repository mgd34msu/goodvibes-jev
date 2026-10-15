/** Local environment hygiene. No network or judgment dependency on process spawning. */
import { mapWithConcurrency } from '../../utils/concurrency.js';

const CREDENTIAL_READ_CONCURRENCY = 16;
// Conventional credential variables. Explicit tool env and the configured
// allowlist retain their existing override semantics.
const CREDENTIAL_NAME = /(?:^|_)(?:TOKEN|SECRET|API_KEY|ACCESS_KEY(?:_ID)?|PRIVATE_KEY|PASSWORD|PASSPHRASE|CREDENTIALS|AUTH|AUTH_TOKEN|SK)$|^(?:PGPASSWORD|PGPASSFILE|NETRC|SSH_AUTH_SOCK|DATABASE_URL|OPENAI_KEY)$/i;

export async function readCredentialEnvName(name: string): Promise<boolean> {
  return CREDENTIAL_NAME.test(name);
}

/** Retained for callers; local name checks keep no remote reading cache. */
export function forgetCredentialEnvReadings(): void {}

/** Injectable scrub configuration (wired from `permissions.exec.*` config by the consumer). */
export interface CredentialEnvScrubConfig {
  /** Master switch. Default true, the scrub is on unless a consumer disables it. */
  readonly enabled?: boolean | undefined;
  /** Variable names always kept without a reading (case-insensitive). */
  readonly allowlist?: readonly string[] | undefined;
}

/** Resolved, non-optional scrub configuration. */
export interface ResolvedCredentialEnvScrub {
  readonly enabled: boolean;
  readonly allowlist: ReadonlySet<string>;
}

/** Resolve raw scrub config into the internal form. Enabled by default. */
export function resolveCredentialEnvScrub(config: CredentialEnvScrubConfig = {}): ResolvedCredentialEnvScrub {
  return {
    enabled: config.enabled !== false,
    allowlist: new Set((config.allowlist ?? []).map((name) => name.toUpperCase())),
  };
}

export interface CredentialEnvScrubResult {
  /** The environment with credential-bearing variables removed. */
  readonly env: Record<string, string>;
  /** Names withheld from `env`, sorted. NEVER includes values. */
  readonly withheld: string[];
}

/**
 * Remove credential-bearing variables from `env`. An allowlisted name is kept
 * without a reading; every other name is withheld unless
 * {@link readCredentialEnvName} clears it. When the scrub is disabled the env
 * passes through untouched with an empty withheld set and nothing is read.
 */
export async function scrubCredentialEnv(
  env: Record<string, string>,
  scrub: ResolvedCredentialEnvScrub,
): Promise<CredentialEnvScrubResult> {
  if (!scrub.enabled) return { env, withheld: [] };
  const entries = Object.entries(env);
  const withholds = await mapWithConcurrency(entries, CREDENTIAL_READ_CONCURRENCY, async ([name]) =>
    scrub.allowlist.has(name.toUpperCase()) ? false : readCredentialEnvName(name));
  const kept: Record<string, string> = {};
  const withheld: string[] = [];
  entries.forEach(([name, value], index) => {
    if (withholds[index]) withheld.push(name);
    else kept[name] = value;
  });
  withheld.sort();
  return { env: kept, withheld };
}
