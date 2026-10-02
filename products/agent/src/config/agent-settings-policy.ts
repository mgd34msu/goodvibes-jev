/**
 * agent-settings-policy.ts, what the Agent's settings surfaces hide.
 *
 * ## The blanket host-owned lock is gone, deliberately
 *
 * This file used to export `isExternalHostOwnedSettingKey` and
 * `AGENT_EXTERNAL_HOST_SETTING_LOCK_REASON`, which made every `relay.*` key and
 * `danger.httpListener` read-only in the harness `settings` tool and the
 * settings modal. The stated reason was accurate when written: the Agent's copy
 * of those keys was an imported snapshot, so toggling `relay.enabled` here would
 * not start or stop the connected daemon's relay registration. It was the same
 * defect as the Telegram one, the Agent wrote its own settings file, the daemon
 * read a different one, and the setting did nothing.
 *
 * That rationale expired. Those keys are daemon-owned (the SDK's
 * config-ownership.ts) and writes route to the runtime that acts on them
 * (src/config/daemon-config-routing.ts), so a write reaches the daemon and takes
 * effect. The lock outlived its reason by months and, by the end, its only
 * effect was to stop the owner configuring the platform from the surface he
 * actually uses.
 *
 * The function and its empty lists were removed rather than kept as a dormant
 * switch. A retired guard whose scaffolding survives is one array edit away from
 * coming back, which is exactly how this one lasted as long as it did.
 * Reinstating a blanket block should require writing the code and arguing for
 * it. Hazardous keys are handled instead by the narrow, self-explaining
 * confirmation list in `src/tools/agent-settings-write-policy.ts`.
 *
 * ## What hiding is still for
 *
 * Hiding a key is a stronger act than gating it and is almost never right: a
 * hidden key cannot name itself, state a hazard, or be confirmed, it simply is
 * not there, and the surface silently disagrees with the schema. `danger.` was
 * listed here for that reason and has been removed; `danger.httpListener` is now
 * shown and gated at write time.
 *
 * What remains is internal plumbing with nothing for the owner to decide.
 */

const AGENT_HIDDEN_SETTING_PREFIXES: readonly string[] = [];

const AGENT_HIDDEN_SETTING_KEYS = new Set<string>([
  'ui.wrfcMessages',
]);

export function isAgentHiddenSettingKey(key: string): boolean {
  return AGENT_HIDDEN_SETTING_KEYS.has(key)
    || AGENT_HIDDEN_SETTING_PREFIXES.some((prefix) => key.startsWith(prefix));
}
