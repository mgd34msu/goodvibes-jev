/**
 * credential-env.ts, scrub credential-bearing environment variables out of the
 * environment handed to spawned tool processes.
 *
 * WHY. A shell command the model runs inherits this process's environment by
 * default. That environment routinely carries provider tokens and cloud
 * credentials (AWS_SECRET_ACCESS_KEY, GITHUB_TOKEN, OPENAI_API_KEY, ...) that the
 * command has no need for and could send elsewhere. This module removes the
 * variables Jev reads as credential-bearing (tools/batteries/credential-env.ts,
 * by name only) from the base environment before it is passed to a spawn, and
 * reports exactly which variable NAMES were withheld (never the value) so the
 * exec result can state the scrub honestly.
 *
 * NOT a permission decision and NOT the frozen catastrophic-command block. This
 * is an environment hygiene step on the spawn path. A credential a command
 * legitimately needs is re-added two ways, both explicit: the model supplies it
 * in the per-command `env`, or the operator adds the variable name to the
 * configured allowlist.
 */

import { judgmentPort } from '@goodvibes-jev/engine/errors';
import { credentialEnv } from '../batteries/credential-env.js';
import { mapWithConcurrency } from '../../utils/concurrency.js';

const CREDENTIAL_ENV_SITE = 'tools.exec.credential-env';

/** Variables read at once while scrubbing an environment. */
const CREDENTIAL_READ_CONCURRENCY = 16;

/**
 * Readings by variable name. A process's environment names are stable, so
 * each name is read once per process; a failed read is forgotten so the next
 * spawn asks again.
 */
const readings = new Map<string, Promise<boolean>>();

/**
 * Whether a variable is withheld from spawned commands: Jev reads, from the
 * NAME alone (never the value), whether it holds a secret or grants access
 * (`engine.tools.credential-env`). Only a no that acts keeps the variable;
 * a yes or a reading that does not act withholds it.
 */
export function readCredentialEnvName(name: string): Promise<boolean> {
  const key = name.toUpperCase();
  const known = readings.get(key);
  if (known !== undefined) return known;
  const reading = (async () => {
    const run = await credentialEnv.run(judgmentPort(CREDENTIAL_ENV_SITE), { name }, { site: CREDENTIAL_ENV_SITE });
    const { verdict, outcome } = run.readings.credential;
    const withheld = !(verdict === 'no' && outcome === 'act');
    run.recordAction(withheld ? 'withheld from spawned commands' : 'passed to spawned commands');
    return withheld;
  })();
  readings.set(key, reading);
  reading.catch(() => readings.delete(key));
  return reading;
}

/** Forgets remembered readings; for tests that swap the judgment port. */
export function forgetCredentialEnvReadings(): void {
  readings.clear();
}

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
