/**
 * agent-settings-policy.ts, what the Agent may set, and the very short list of
 * keys that need the user to say so first.
 *
 * ## What the previous guard was protecting
 *
 * `goodvibes_settings` was hard-denied for the whole Agent surface by commit
 * c0eca13c ("Block settings mutation tool in agent runtime", 2026-05-31). The
 * commit carried no body and no linked decision record; the only statement of
 * intent is the denial text it shipped:
 *
 *   "Secrets, tokens, passwords, daemon lifecycle settings, and service
 *    exposure settings require explicit user action outside the model tool
 *    surface."
 *
 * So the concern was narrow, credentials and host exposure, and the
 * implementation was total: it stripped every parameter from the schema and
 * refused every call, including reads of what it had refused. Nothing about a
 * bot username, a chat id, a theme or a model was ever the worry.
 *
 * The cost of the mismatch was real. The owner told the Agent his Telegram bot
 * username. Between this denial and the model treating a stated value as
 * trivia, nothing was written, and he spent hours believing his system was
 * configured when it was not. The Agent has things it needs to set.
 *
 * ## What replaced it
 *
 * The credential half of the original concern still holds, and still runs, in
 * the SDK tool itself, which refuses a raw secret in a credential-shaped key and
 * names the `goodvibes://` reference that would work instead. That protection is
 * value-shaped, not key-shaped, so it belongs there and is not duplicated here.
 *
 * The exposure half becomes {@link AGENT_CONFIRMATION_REQUIRED_CONFIG_KEYS}: a
 * short list of keys where an unattended write is itself the hazard. It is
 * modelled on this codebase's frozen catastrophic exec list, a small,
 * enumerated set of genuinely dangerous things, not a general policy, and it
 * covers exactly three classes:
 *
 *   1. approval gates the Agent would otherwise be granting itself,
 *   2. the exec sandbox that contains what the Agent runs,
 *   3. moving a loopback listener onto the network, or widening who it trusts.
 *
 * Everything else the Agent sets on request. This list must not grow into a
 * general "settings the model shouldn't touch" list; adding to it needs the same
 * deliberate justification as adding to the catastrophic exec list.
 *
 * ## Nothing fails silently
 *
 * A gated key is not refused, it is *deferred to the user*, loudly. The denial
 * names the key, states the hazard in plain language, and says exactly what
 * would let it proceed. Silence dressed as success is the whole reason this file
 * exists.
 */

import type { Tool } from '@goodvibes-jev/engine/sdk/platform/types';

/** Why an unattended write to a key is the hazard, in the user's language. */
export interface ConfirmationRequiredConfigKey {
  /** Exact config key, or a `prefix.` ending in a dot to cover a domain. */
  readonly match: string;
  /** Which of the three hazard classes this belongs to. */
  readonly hazard: 'approval-gate' | 'exec-containment' | 'host-exposure';
  /** Plain-language statement of what the write would do. */
  readonly because: string;
}

/**
 * The frozen list. Keep it short and keep every entry justifiable on its own.
 *
 * Deliberately NOT here, and why: `surfaces.*` (chat surfaces the user is
 * actively configuring, the whole point), `provider.*` and `display.*`
 * (ordinary preferences), and every credential-shaped key, whose protection is
 * the SDK tool's raw-secret refusal rather than a confirmation prompt.
 */
export const AGENT_CONFIRMATION_REQUIRED_CONFIG_KEYS: readonly ConfirmationRequiredConfigKey[] = Object.freeze([
  // 1. Approval gates. Writing these is the Agent widening its own permissions.
  {
    match: 'behavior.autoApprove',
    hazard: 'approval-gate',
    because: 'it auto-approves every future tool permission request, so nothing would ask you again',
  },
  {
    match: 'permissions.mode',
    hazard: 'approval-gate',
    because: 'it decides which tool classes run without asking you',
  },
  {
    match: 'permissions.tools.',
    hazard: 'approval-gate',
    because: 'it grants or revokes a tool class outright, which changes what runs unattended',
  },
  // 2. Exec containment. The sandbox is what bounds commands the Agent runs, and
  // its backing image and wrapper paths decide what "sandboxed" even means.
  {
    match: 'sandbox.',
    hazard: 'exec-containment',
    because: 'it controls the sandbox that contains commands run from here, including whether it is on, how escalations are judged, and which image and wrapper back it',
  },
  // 3. Host exposure. Moving a loopback listener onto the network, or trusting
  // remote callers, exposes this machine to everything that can route to it.
  {
    match: 'controlPlane.',
    hazard: 'host-exposure',
    because: 'it controls the network binding of the control plane and who may reach it',
  },
  {
    match: 'httpListener.',
    hazard: 'host-exposure',
    because: 'it controls the network binding of the inbound HTTP listener and who may reach it',
  },
  {
    match: 'web.host',
    hazard: 'host-exposure',
    because: 'it controls which interface the web surface binds to',
  },
  {
    match: 'web.hostMode',
    hazard: 'host-exposure',
    because: 'it controls which interface the web surface binds to',
  },
  {
    match: 'danger.httpListener',
    hazard: 'host-exposure',
    because: 'it opens an inbound webhook listener that accepts external events',
  },
  {
    match: 'fetch.trustedHosts',
    hazard: 'host-exposure',
    because: 'trusted hosts relax response sanitization, which is what keeps fetched pages from being read as instructions',
  },
  {
    match: 'fetch.blockedHosts',
    hazard: 'host-exposure',
    because: 'it is the list of hosts fetch refuses, so shortening it widens what can be reached',
  },
  {
    match: 'network.remoteFetch.allowPrivateHosts',
    hazard: 'host-exposure',
    because: 'it allows fetches to private, localhost, and cloud metadata addresses',
  },
]);

/**
 * The gated entry covering `key`, or null. Prefix entries end in `.` and match a
 * whole domain; every other entry is an exact key.
 */
export function findConfirmationRequiredConfigKey(key: string): ConfirmationRequiredConfigKey | null {
  const trimmed = key.trim();
  if (!trimmed) return null;
  for (const entry of AGENT_CONFIRMATION_REQUIRED_CONFIG_KEYS) {
    if (entry.match.endsWith('.') ? trimmed.startsWith(entry.match) : trimmed === entry.match) return entry;
  }
  return null;
}

/** Parameter carrying the user's own words when a gated key is being set. */
export const AGENT_SETTINGS_CONFIRMATION_PROPERTY = 'explicitUserRequest';

/** Loud, self-explaining denial. Never returned as, or alongside, a success. */
export function describeConfirmationRequiredDenial(entry: ConfirmationRequiredConfigKey, key: string): string {
  return [
    `${key} requires your confirmation because ${entry.because}.`,
    'It was NOT changed, and nothing else was written.',
    `To proceed, say so explicitly and the Agent will retry with ${AGENT_SETTINGS_CONFIRMATION_PROPERTY} set to your request`,
    `(hazard class: ${entry.hazard}).`,
    'Every other setting can be applied without this step.',
  ].join(' ');
}

export type SettingsToolArgs = {
  readonly mode?: unknown;
  readonly key?: unknown;
  readonly explicitUserRequest?: unknown;
  readonly [name: string]: unknown;
};

/**
 * Deny a gated write that has no explicit user request behind it. Returns null,
 * meaning "let it through", for every other key, and for reads and resets of
 * keys that are not gated.
 */
export function validateSettingsToolInvocationForAgentPolicy(args: SettingsToolArgs): string | null {
  const key = typeof args.key === 'string' ? args.key.trim() : '';
  if (!key) return null;
  const entry = findConfirmationRequiredConfigKey(key);
  if (!entry) return null;
  const request = args[AGENT_SETTINGS_CONFIRMATION_PROPERTY];
  if (typeof request === 'string' && request.trim().length > 0) return null;
  return describeConfirmationRequiredDenial(entry, key);
}

/** Description the Agent surface shows for `goodvibes_settings`. */
export const AGENT_SETTINGS_TOOL_DESCRIPTION = [
  'Read and change GoodVibes settings.',
  'When the user gives you a concrete configuration value, a bot username, a chat id, a host, a port, a model, a path, that is a request to apply it:',
  'set it, then tell them the key and the persistedTo store it landed in. A value you only repeat back in prose has not been set.',
  'Writes route to the runtime that owns the key, so daemon-owned settings (surfaces.*, control-plane binding, watchers, device pairing, provisioning, retention) land in the daemon config and take effect there,',
  'while Agent-owned settings stay in the Agent config. The value is re-read from that store afterwards, so a write that did not land is reported as a failure rather than as success.',
  'If you cannot tell which key a value belongs to, ask one short question instead of guessing, and never set anything the user did not ask for.',
  `A short list of keys that turn off approval gates, weaken the exec sandbox, or expose this host to the network needs the user to ask for it first; pass their request in ${AGENT_SETTINGS_CONFIRMATION_PROPERTY} and the refusal will tell you which key and why.`,
  'Raw secrets are refused: store the secret and set the key to a goodvibes:// reference.',
].join(' ');

/**
 * Let the Agent read and write settings, gating only
 * {@link AGENT_CONFIRMATION_REQUIRED_CONFIG_KEYS}.
 *
 * The tool's own parameters are left intact, the previous guard stripped them
 * all, which left the model unable to see that a settings write was even a thing
 * it could attempt. One property is ADDED, so there is a way to carry the user's
 * request for a gated key.
 */
export function wrapSettingsToolForAgentPolicy(tool: Tool): void {
  tool.definition.description = AGENT_SETTINGS_TOOL_DESCRIPTION;
  tool.definition.sideEffects = ['state'];

  const properties = tool.definition.parameters.properties;
  if (properties && typeof properties === 'object' && !Array.isArray(properties)) {
    (properties as Record<string, unknown>)[AGENT_SETTINGS_CONFIRMATION_PROPERTY] = {
      type: 'string',
      description:
        'The user\'s own words asking for this change. Required only for the short list of keys that turn off approval gates, weaken the exec sandbox, or expose this host to the network. Never invent it.',
    };
  }

  const originalExecute = tool.execute.bind(tool);
  tool.execute = async (args, options) => {
    const denial = validateSettingsToolInvocationForAgentPolicy(args as SettingsToolArgs);
    if (denial) return { success: false, error: denial };
    return originalExecute(args, options);
  };
}
