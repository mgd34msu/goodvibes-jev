/**
 * config-ownership.ts, which runtime OWNS a config key, mirrored here for display.
 *
 * The web UI is inherently a REMOTE client: it may run on a different machine
 * from the daemon, so it already does the structurally right thing, every
 * config read/write goes THROUGH the daemon's control plane (config.get /
 * config.set), never by opening a settings file directly. What this module
 * adds is visibility: a user editing `surfaces.telegram.*` or
 * `controlPlane.*` from a browser on another machine needs to see, before they
 * touch it, that the value lands in the DAEMON's own config store and applies
 * to every client, not just this browser tab.
 *
 * Source of truth: the SDK's
 * `packages/sdk/src/platform/config/config-ownership.ts`
 * (`DAEMON_OWNED_CONFIG_PREFIXES` / `DAEMON_OWNED_CONFIG_KEYS` /
 * `DAEMON_OWNED_NON_SCHEMA_CONFIG_PATHS`). This module used to hand-copy those
 * three lists as a comment-enforced "keep in sync by hand" mirror, and it
 * drifted: it was missing the `conversationGate.` and `cluster.` prefixes, and
 * it never carried the non-schema path list at all, so credential paths like
 * `email.passwordRef` and `calendar.google.icsUrl`, which the SDK treats as
 * daemon-owned because the daemon is the only process that can resolve and use
 * them, read as NOT daemon-owned here.
 *
 * That drift never broke routing (routing happens server-side, in the
 * daemon's own daemon-config-route.ts, driven by the SDK's real lists, not
 * this file), it only made the "Daemon-owned" badge in this UI lie to the
 * operator about which settings the daemon owns.
 *
 * The fix is a build-time generator, not a better comment:
 * `scripts/generate-config-ownership.ts` imports the three lists from the
 * installed `@goodvibes-jev/engine/sdk/platform/config` at build time (a script
 * that runs under bun, never inside the Vite bundle, the same reason
 * scripts/generate-config-schema.ts snapshots CONFIG_SCHEMA that way instead
 * of importing it live) and snapshots them into
 * `src/lib/generated/config-ownership.ts`. This module re-exports that
 * snapshot and layers the same derived predicate the SDK exposes
 * (`isDaemonOwnedConfigKey`) on top of it, so the browser bundle never pulls
 * in SecretsManager / OAuth / google-auth. `bun run release:prepare` regenerates
 * the snapshot from the installed SDK at every version bump, as it does
 * CONFIG_SCHEMA.
 */
import {
  DAEMON_OWNED_CONFIG_KEYS,
  DAEMON_OWNED_CONFIG_PREFIXES,
  DAEMON_OWNED_NON_SCHEMA_CONFIG_PATHS,
} from './generated/config-ownership';

/**
 * MERGE NOTE (payments round): wo/payments-webui added `payments.` to the
 * prefixes and `daemon.timezone` to the keys by hand, in the hand-mirrored
 * lists this module carried at the time. Those lists are exactly what the
 * generator above replaced, so the hand-written copies are not carried
 * forward, the two entries now arrive from the SDK's own tables via
 * src/lib/generated/config-ownership.ts, which is where they belong and which
 * `bun run release:prepare` regenerates at every bump.
 *
 * Their reasoning, recorded here because a generated file has nowhere to put
 * it: the daemon is the process that holds the card and charges it, with
 * every surface closed and across restarts, so card material and budgets left
 * client-owned would live in whichever surface entered them while the daemon
 * charged against defaults. And `daemon.timezone` is the one `daemon.*` key
 * that is not a per-installation switch, the rest of that prefix answers
 * "does THIS machine run a daemon", while the timezone answers where the
 * daemon thinks it is, which is what rolls a daily budget over at midnight.
 *
 * config-ownership.test.ts asserts both are present in the generated
 * snapshot, so dropping the hand-written lists cannot silently drop them.
 */
export { DAEMON_OWNED_CONFIG_KEYS, DAEMON_OWNED_CONFIG_PREFIXES, DAEMON_OWNED_NON_SCHEMA_CONFIG_PATHS };

const DAEMON_KEY_SET = new Set<string>(DAEMON_OWNED_CONFIG_KEYS);
const DAEMON_NON_SCHEMA_PATH_SET = new Set<string>(DAEMON_OWNED_NON_SCHEMA_CONFIG_PATHS);

/**
 * True when the daemon is the single writer and reader-of-record for `key`,
 * i.e. a `config.set` on this key changes the daemon's own store, applies to
 * every client connected to it, and (per daemon-config-route.ts on the SDK
 * side) fails loudly rather than landing silently in a per-client file when
 * the daemon cannot be reached.
 *
 * Mirrors the SDK's own `isDaemonOwnedConfigKey` exactly: a key is
 * daemon-owned if it is one of the individual daemon-owned keys, one of the
 * non-scalar daemon-owned paths, or starts with one of the daemon-owned
 * prefixes.
 */
export function isDaemonOwnedConfigKey(key: string): boolean {
  if (DAEMON_KEY_SET.has(key)) return true;
  if (DAEMON_NON_SCHEMA_PATH_SET.has(key)) return true;
  return DAEMON_OWNED_CONFIG_PREFIXES.some((prefix) => key.startsWith(prefix));
}
