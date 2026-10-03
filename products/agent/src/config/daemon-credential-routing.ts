/**
 * daemon-credential-routing.ts, where a secret-backed setting is written when
 * the runtime that USES it is not this one.
 *
 * ── The pair that must not split ───────────────────────────────────────────
 *
 * A secret-backed setting is two writes that only work together: the config key
 * gets a `goodvibes://secrets/...` REFERENCE, and the secret store gets the
 * VALUE it points at. Two processes writing one credential tier is the
 * second-writer hazard, and the failure is silent: the surface reports success
 * and the daemon resolves a reference to nothing.
 *
 * So a daemon-owned key goes over ONE verb, `credentials.set`, which does the
 * whole sequence in an order this side could not enforce from outside: derive
 * the store name from the config path, write the value at the scope the
 * ownership rules resolve, read it BACK and compare, and only then replace the
 * config value with its reference. A mismatch leaves the config exactly as it
 * was and fails the call. `credentials.delete` is the clearing half.
 *
 * With no reachable daemon the write REJECTS with the reason. It does not fall
 * back to a local write, because a local write is the exact failure this exists
 * to end.
 *
 * ── Why the client is installed rather than threaded ──────────────────────
 *
 * Five call sites write secret-backed settings, the settings modal, the
 * payment-card intake, the email setup command, the calendar OAuth editor and
 * the harness settings tool, and only two of them have a runtime graph in
 * scope to thread a client down from. The composition root installs it once
 * (see runtime/services.ts) and every writer routes through the same one, which
 * is the same registration idiom this repo already uses for the live
 * conversation registry.
 *
 * A process that installed nothing writes locally, and says so: that is a
 * one-shot CLI or a unit test with no composed runtime, never the shipped
 * interactive agent. {@link agentDaemonCredentialsInstalled} makes the
 * difference checkable rather than assumed.
 *
 * ── It is uninstalled with the graph that installed it ────────────────────
 *
 * Process-wide state that outlives its owner is how one composed runtime
 * changes the behaviour of code that has nothing to do with it. `dispose()`
 * clears this, and the shared test reset clears it before every test, so a file
 * that composed a runtime cannot silently route another file's writes at a
 * daemon that was never there. A test that wants the routing installs its own
 * client and says so.
 */
import { isDaemonOwnedConfigKey } from '@goodvibes-jev/engine/sdk/platform/config';
import type { DaemonCredentialsClient } from '@goodvibes-jev/engine/sdk/platform/runtime/client';

let installed: DaemonCredentialsClient | null = null;

/**
 * Install the client every secret-backed write routes daemon-owned keys
 * through. Called once by the composition root; a second call replaces it,
 * which is what a test that composes twice needs.
 */
export function installAgentDaemonCredentialsClient(client: DaemonCredentialsClient | null): void {
  installed = client;
}

/** The installed client, or null when this process composed no runtime. */
export function agentDaemonCredentialsClient(): DaemonCredentialsClient | null {
  return installed;
}

/** Whether daemon-owned credential writes will actually reach a daemon. */
export function agentDaemonCredentialsInstalled(): boolean {
  return installed !== null;
}

/** What happened to one secret-backed write, in words a caller can render. */
export interface CredentialRouteOutcome {
  /** `daemon` when the value went over `credentials.set`/`delete`. */
  readonly appliedBy: 'daemon' | 'local';
  /** Why it stayed local, when it did. Absent for a daemon write. */
  readonly localReason?: string;
}

/**
 * Route one secret-backed setting write.
 *
 * Returns `null` when this write is NOT the daemon's to make, the caller then
 * runs its own local path unchanged. Returns an outcome when the daemon took
 * it. Throws when the daemon owns the key and could not be reached, carrying
 * the refusal reason: a credential that configures nothing must not report
 * success.
 */
export async function routeDaemonOwnedCredentialWrite(
  configKey: string,
  rawValue: string,
): Promise<CredentialRouteOutcome | null> {
  if (!isDaemonOwnedConfigKey(configKey)) return null;
  const client = installed;
  if (!client) {
    return {
      appliedBy: 'local',
      localReason: 'no connected host is wired in this process, so the write stayed local',
    };
  }
  // An empty value CLEARS: the same meaning the local path gives it, so the
  // two never disagree about what erasing a field does.
  if (rawValue.trim().length === 0) {
    await client.clear(configKey);
    return { appliedBy: 'daemon' };
  }
  await client.set(configKey, rawValue);
  return { appliedBy: 'daemon' };
}

export { isDaemonOwnedConfigKey };
